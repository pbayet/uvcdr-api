import path from "node:path";
import fs from "node:fs/promises";
import { scheduleDailyTask } from "../../../core/utils/scheduler.utils.js";
import { logger } from "../../../config/logger.config.js";
import * as filesServices from "../services.js";

/**
 * Fix audit 2.1 : dans V1.0.0, ce cron existait et tournait déjà (planifié
 * via scheduleDailyTask), mais son callback était un stub vide
 * (`() => console.log("test")`) — 159 Mo de fichiers jamais purgés.
 * Ici le callback purge réellement tmp/ au-delà d'une rétention configurable.
 */
export async function purgeOldTmpFiles() {
  const tmpDir = path.resolve(process.env.UPLOAD_TMP_PATH || "tmp");
  const retentionDays = Number(process.env.TMP_RETENTION_DAYS) || 7;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  let entries;
  try {
    entries = await fs.readdir(tmpDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return; // rien à purger
    logger.error(`[TMP PURGE] Impossible de lire ${tmpDir} : ${err.message}`);
    return;
  }

  let removed = 0;
  let freedBytes = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const filePath = path.join(tmpDir, entry.name);

    try {
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs < cutoff) {
        freedBytes += stat.size;
        await fs.unlink(filePath);
        removed++;
      }
    } catch (err) {
      logger.warn(`[TMP PURGE] Échec suppression ${filePath} : ${err.message}`);
    }
  }

  if (removed > 0) {
    logger.info(
      `[TMP PURGE] ${removed} fichier(s) supprimé(s) (> ${retentionDays}j) — ${(freedBytes / 1024 / 1024).toFixed(1)} Mo libérés.`,
    );
  }
}

export function startTmpPurgeCron() {
  // Tous les jours à 3h05 (heures creuses), jours ouvrés — conserve le même
  // ordonnanceur maison que V1.0.0 (pas de dépendance cron externe).
  return scheduleDailyTask(purgeOldTmpFiles, 3, 5);
}

/**
 * Purge des pièces jointes supprimées logiquement (DELETEDAT) depuis plus de
 * ATTACHMENTS_RETENTION_MONTHS mois (3 par défaut) :
 *   1. suppression du fichier physique sous UPLOAD_PATH ;
 *   2. passage de la ligne ATTACHMENTS en STATUS = 'PURGED'.
 * La ligne n'est jamais supprimée : les signatures (ATTACHMENTSIGNATURES,
 * FK sans CASCADE) et la trace d'audit doivent lui survivre.
 *
 * Idempotent et tolérant : un fichier déjà absent (ENOENT) est tout de même
 * marqué PURGED ; toute autre erreur laisse la ligne intacte pour être
 * retentée au prochain passage.
 *
 * ATTACHMENTS_PURGE_DRY_RUN=true : journalise ce qui serait purgé sans rien
 * supprimer (utile pour un premier passage en production).
 */
export async function purgeDeletedAttachments({
  rootDir = process.env.UPLOAD_PATH,
  retentionMonths = Number(process.env.ATTACHMENTS_RETENTION_MONTHS) || 3,
  dryRun = process.env.ATTACHMENTS_PURGE_DRY_RUN === "true",
  batchSize = 500,
} = {}) {
  if (!rootDir) {
    logger.error("[FILES PURGE] UPLOAD_PATH non défini — purge annulée.");
    return { purged: 0, missing: 0, failed: 0, freedBytes: 0 };
  }

  const root = path.resolve(rootDir);
  const stats = { purged: 0, missing: 0, failed: 0, freedBytes: 0 };
  let afterId = 0;

  for (;;) {
    const rows = await filesServices.getAttachmentsToPurge({
      retentionMonths,
      afterId,
      batchSize,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      await purgeOneAttachment(row, root, dryRun, stats);
    }

    afterId = rows[rows.length - 1].ID;
    if (rows.length < batchSize) break;
  }

  const total = stats.purged + stats.missing + stats.failed;
  if (total > 0) {
    logger.info(
      `[FILES PURGE]${dryRun ? " [DRY-RUN]" : ""} DELETEDAT > ${retentionMonths} mois : ` +
        `${stats.purged} fichier(s) supprimé(s), ${stats.missing} déjà absent(s), ${stats.failed} échec(s) — ` +
        `${(stats.freedBytes / 1024 / 1024).toFixed(1)} Mo libérés.`,
    );
  }

  return stats;
}

async function purgeOneAttachment(row, root, dryRun, stats) {
  const absolutePath = path.resolve(root, row.RELATIVEPATH || "");

  // Défense en profondeur : RELATIVEPATH vient de la base, on refuse tout
  // chemin qui sortirait du répertoire de stockage (path traversal).
  if (!row.RELATIVEPATH || !absolutePath.startsWith(root + path.sep)) {
    logger.warn(
      `[FILES PURGE] Chemin invalide ignoré pour ${row.FILECODE} : ${row.RELATIVEPATH}`,
    );
    stats.failed++;
    return;
  }

  if (dryRun) {
    logger.info(`[FILES PURGE] [DRY-RUN] ${row.FILECODE} → ${absolutePath}`);
    stats.purged++;
    return;
  }

  try {
    await fs.unlink(absolutePath);
    stats.purged++;
    stats.freedBytes += Number(row.SIZEBYTES) || 0;
  } catch (err) {
    if (err.code !== "ENOENT") {
      logger.warn(
        `[FILES PURGE] Échec suppression ${row.FILECODE} (${absolutePath}) : ${err.message}`,
      );
      stats.failed++;
      return;
    }
    stats.missing++;
  }

  try {
    await filesServices.markPurgedAttachment(row.ID);
  } catch (err) {
    // Fichier supprimé mais ligne non marquée : sera retraitée (ENOENT) au prochain passage.
    logger.error(
      `[FILES PURGE] Échec mise à jour STATUS pour ${row.FILECODE} : ${err.message}`,
    );
  }
}

export function startDeletedAttachmentsPurgeCron() {
  // Tous les jours ouvrés à 3h20, décalé de la purge tmp/ (3h05).
  return scheduleDailyTask(() => purgeDeletedAttachments(), 3, 20);
}
