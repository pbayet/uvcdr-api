import path from "node:path";
import fs from "node:fs/promises";
import sql from "mssql";

import { logger } from "../../config/logger.config.js";
import { runQuery } from "../utils/db.utils.js";
import { scheduleDailyTask } from "../utils/scheduler.utils.js";
import { getLogsRetentionDays } from "../config/logsRetention.config.js";

/**
 * Purge automatique des logs au-delà de la rétention (cf.
 * core/config/logsRetention.config.js : 1 an en PROD, 2 mois en DEV) :
 *   - GENERALACTIVITY.dbo.USERSACTIVITY (CREDAT) ;
 *   - USERSMANAGER.dbo.LOGINHISTORY (LOGIN_DATE) ;
 *   - fichiers du dossier logs/ de l'API (date de dernière modification).
 *
 * Les suppressions SQL se font par lots (DELETE TOP (n)) pour ne pas
 * verrouiller les tables ni dépasser le timeout de requête lors du premier
 * passage, qui peut porter sur un gros volume. Les colonnes de date sont
 * indexées (modules/usersmanager/sql/GLOBALACTIVITY_DEVEMAIL_PERF.sql).
 *
 * LOGS_PURGE_DRY_RUN=true : compte/journalise ce qui serait supprimé sans
 * rien supprimer (utile pour un premier passage en production).
 */

const DB_TARGETS = [
  { label: "USERSACTIVITY", dbConnectionName: "generalactivity", table: "[dbo].[USERSACTIVITY]", dateColumn: "CREDAT" },
  { label: "LOGINHISTORY", dbConnectionName: "usersmanager", table: "[dbo].[LOGINHISTORY]", dateColumn: "LOGIN_DATE" },
];

const DEFAULT_BATCH_SIZE = 5000;
// Garde-fou contre une boucle infinie (ex: insertions massives antidatées).
const MAX_BATCHES = 10000;

async function purgeTable(target, retentionDays, dryRun, batchSize) {
  const { dbConnectionName, table, dateColumn } = target;
  const where = `${dateColumn} < DATEADD(DAY, -@DAYS, GETDATE())`;
  const inputs = { DAYS: { type: sql.Int, value: retentionDays } };

  if (dryRun) {
    const result = await runQuery({
      dbConnectionName,
      query: `SELECT COUNT_BIG(*) AS CNT FROM ${table} WHERE ${where}`,
      inputs,
    });
    return Number(result.recordset?.[0]?.CNT) || 0;
  }

  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const result = await runQuery({
      dbConnectionName,
      query: `DELETE TOP (@BATCH) FROM ${table} WHERE ${where}`,
      inputs: { ...inputs, BATCH: { type: sql.Int, value: batchSize } },
    });
    const deleted = result.rowsAffected?.[0] ?? 0;
    total += deleted;
    if (deleted < batchSize) break;
  }
  return total;
}

export async function purgeDbLogs({
  retentionDays = getLogsRetentionDays(),
  dryRun = process.env.LOGS_PURGE_DRY_RUN === "true",
  batchSize = DEFAULT_BATCH_SIZE,
} = {}) {
  const stats = {};

  // Une table en erreur (base indisponible...) n'empêche pas la purge des autres.
  for (const target of DB_TARGETS) {
    try {
      stats[target.label] = await purgeTable(target, retentionDays, dryRun, batchSize);
      if (stats[target.label] > 0) {
        logger.info(
          `[LOGS PURGE]${dryRun ? " [DRY-RUN]" : ""} ${target.label} : ${stats[target.label]} ligne(s) ${dryRun ? "à supprimer" : "supprimée(s)"} (> ${retentionDays}j).`,
        );
      }
    } catch (err) {
      stats[target.label] = null;
      logger.error(`[LOGS PURGE] Échec purge ${target.label} : ${err.message}`);
    }
  }

  return stats;
}

export async function purgeLogFiles({
  logDir = path.resolve("logs"),
  retentionDays = getLogsRetentionDays(),
  dryRun = process.env.LOGS_PURGE_DRY_RUN === "true",
} = {}) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const stats = { removed: 0, failed: 0, freedBytes: 0 };

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code !== "ENOENT") {
        logger.error(`[LOGS PURGE] Impossible de lire ${dir} : ${err.message}`);
      }
      return;
    }

    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(filePath);
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs >= cutoff) continue;

        if (!dryRun) await fs.unlink(filePath);
        stats.removed++;
        stats.freedBytes += stat.size;
      } catch (err) {
        stats.failed++;
        logger.warn(`[LOGS PURGE] Échec suppression ${filePath} : ${err.message}`);
      }
    }
  }

  await walk(logDir);

  if (stats.removed > 0) {
    logger.info(
      `[LOGS PURGE]${dryRun ? " [DRY-RUN]" : ""} logs/ : ${stats.removed} fichier(s) ${dryRun ? "à supprimer" : "supprimé(s)"} (> ${retentionDays}j) — ${(stats.freedBytes / 1024 / 1024).toFixed(1)} Mo.`,
    );
  }

  return stats;
}

export async function purgeOldLogs(options = {}) {
  const db = await purgeDbLogs(options);
  const files = await purgeLogFiles(options);
  return { db, files };
}

export function startLogsPurgeCron() {
  // Aucun accès disque/BDD réel pendant la suite de tests.
  if (process.env.NODE_ENV === "test") return () => {};

  // Premier passage au démarrage (sans bloquer le boot), puis tous les jours
  // ouvrés à 3h35 — décalé des purges tmp/ (3h05) et pièces jointes (3h20).
  purgeOldLogs().catch((err) =>
    logger.error(`[LOGS PURGE] Erreur au démarrage : ${err.message}`),
  );
  return scheduleDailyTask(() => purgeOldLogs(), 3, 35);
}
