/* ═══════════════════════════════════════════════════════════════
   VINIDOC — Nettoyage ponctuel des textes œnologiques déjà saisis

   Applique aux données existantes le nettoyage fait désormais à chaque
   enregistrement (utils.cleanText : retours à la ligne, espaces en trop,
   espaces insécables, caractères invisibles) :
     - SHEETS     : APPELL, DESCVRAC
     - SHEETTRANS : LIBELLE, TERROIR, VINIF, DEGUST, GARDE, CEPAGES, ACCORDS, ACCEXPL
     - SHEETVERS  : mêmes champs dans l'instantané JSON des versions validées
                    (c'est lui qui est injecté à la génération des fiches validées)

   Usage (depuis la racine de l'API, base VINIDOC de l'environnement courant) :
     node modules/vinidoc/scripts/clean-oenology-texts.js              simulation (rien n'est écrit)
     node modules/vinidoc/scripts/clean-oenology-texts.js --apply      écriture
     options : --sans-versions  ne pas toucher aux versions validées
               --exemples=N     nombre d'exemples avant/après affichés (défaut 10)

   Avec --apply : sauvegarde JSON des valeurs d'origine dans tmp/ AVANT
   écriture, puis une seule transaction (tout ou rien). Statuts, auteurs et
   dates de modification ne sont pas modifiés ; le ROWVER des fiches dont
   APPELL / DESCVRAC change est renouvelé : lancer le script quand personne
   n'édite de fiche (sinon « fiche modifiée par un autre utilisateur »).
═══════════════════════════════════════════════════════════════ */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
process.chdir(API_ROOT); // config/env.js lit ./config/env/<NODE_ENV>.env

await import("../../../config/env.js");
const require = createRequire(import.meta.url);
const sql = require("mssql");
const { getConnectionConfig } = await import("../../../config/db/vinidoc.db.config.js");
const { cleanText, CLEANED_SHEET_FIELDS, CLEANED_TRANSLATION_FIELDS } = await import(
  "../utils.js"
);

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const WITH_VERSIONS = !args.includes("--sans-versions");
const EXAMPLES = Number(args.find((a) => a.startsWith("--exemples="))?.split("=")[1] ?? 10);

/** Extraits avant → après centrés sur la première différence. */
function excerpt(before, after) {
  if (before == null || after == null) return `${JSON.stringify(before)} → ${JSON.stringify(after)}`;
  let i = 0;
  while (i < before.length && before[i] === after[i]) i++;
  const cut = (s) => {
    const from = Math.max(0, i - 25);
    const part = s.slice(from, from + 60);
    return `${from > 0 ? "…" : ""}${JSON.stringify(part)}${from + 60 < s.length ? "…" : ""}`;
  };
  return `${cut(before)} → ${cut(after)}`;
}

/** Champs modifiés par le nettoyage : [{ field, before, after }]. */
function diff(row, fields) {
  return fields
    .filter((f) => f in row)
    .map((f) => ({ field: f, before: row[f], after: cleanText(row[f]) }))
    .filter((d) => d.before !== d.after);
}

/** Nettoie un instantané JSON (forme brute, anciens formats conservés). */
function cleanSnapshot(snapshot) {
  const changes = [];
  const out = { ...snapshot };
  for (const d of diff(out, CLEANED_SHEET_FIELDS)) {
    if (d.after == null && d.field === "APPELL") continue; // obligatoire
    out[d.field] = d.after;
    changes.push(d);
  }
  if (out.TRANSLATIONS && typeof out.TRANSLATIONS === "object") {
    out.TRANSLATIONS = Object.fromEntries(
      Object.entries(out.TRANSLATIONS).map(([lng, t]) => {
        if (!t || typeof t !== "object") return [lng, t];
        const tr = { ...t };
        for (const d of diff(tr, CLEANED_TRANSLATION_FIELDS)) {
          tr[d.field] = d.after;
          changes.push({ ...d, field: `${lng}.${d.field}` });
        }
        return [lng, tr];
      }),
    );
  }
  return { out, changes };
}

const cfg = await getConnectionConfig();
console.log(
  `\nVINIDOC — nettoyage des textes œnologiques | NODE_ENV=${process.env.NODE_ENV} | base ${cfg.connection.database} @ ${cfg.connection.server}`,
);
console.log(APPLY ? "MODE ÉCRITURE (--apply)\n" : "SIMULATION — rien n'est écrit (ajouter --apply pour écrire)\n");

const pool = await new sql.ConnectionPool(cfg.connection).connect();

try {
  const [sheets, trans, versions] = await Promise.all([
    pool.request().query(`SELECT SHTID, CODVRAC, MILLESIME, ${CLEANED_SHEET_FIELDS.join(", ")} FROM dbo.SHEETS;`),
    pool.request().query(`SELECT SHTID, LNGCOD, ${CLEANED_TRANSLATION_FIELDS.join(", ")} FROM dbo.SHEETTRANS;`),
    WITH_VERSIONS
      ? pool.request().query(`SELECT SHTID, VERNUM, SNAPSHOT FROM dbo.SHEETVERS;`)
      : Promise.resolve({ recordset: [] }),
  ]);

  /* ── Calcul des modifications ── */
  const sheetUpdates = [];
  const examples = [];
  const perField = new Map();
  const count = (table, field) => {
    const k = `${table}.${field.replace(/^[a-z-]+\./, "")}`;
    perField.set(k, (perField.get(k) ?? 0) + 1);
  };

  for (const s of sheets.recordset) {
    // APPELL obligatoire : jamais vidée (texte uniquement fait de blancs).
    const changes = diff(s, CLEANED_SHEET_FIELDS).filter(
      (d) => !(d.field === "APPELL" && d.after == null),
    );
    if (!changes.length) continue;
    sheetUpdates.push({ SHTID: s.SHTID, changes });
    for (const d of changes) {
      count("SHEETS", d.field);
      examples.push(`SHEETS ${s.CODVRAC} ${s.MILLESIME ?? ""} ${d.field} : ${excerpt(d.before, d.after)}`);
    }
  }

  const transUpdates = [];
  for (const t of trans.recordset) {
    const changes = diff(t, CLEANED_TRANSLATION_FIELDS);
    if (!changes.length) continue;
    transUpdates.push({ SHTID: t.SHTID, LNGCOD: t.LNGCOD, changes });
    for (const d of changes) {
      count("SHEETTRANS", d.field);
      examples.push(`SHEETTRANS fiche ${t.SHTID} ${t.LNGCOD} ${d.field} : ${excerpt(d.before, d.after)}`);
    }
  }

  const versionUpdates = [];
  let invalidJson = 0;
  for (const v of versions.recordset) {
    let snapshot;
    try {
      snapshot = JSON.parse(v.SNAPSHOT);
    } catch {
      invalidJson++;
      continue;
    }
    const { out, changes } = cleanSnapshot(snapshot);
    if (!changes.length) continue;
    versionUpdates.push({ SHTID: v.SHTID, VERNUM: v.VERNUM, before: v.SNAPSHOT, after: JSON.stringify(out) });
    for (const d of changes) {
      count("SHEETVERS", d.field);
      examples.push(`SHEETVERS fiche ${v.SHTID} v${v.VERNUM} ${d.field} : ${excerpt(d.before, d.after)}`);
    }
  }

  /* ── Rapport ── */
  console.log(`Lignes lues : ${sheets.recordset.length} fiches, ${trans.recordset.length} traductions, ${WITH_VERSIONS ? `${versions.recordset.length} versions validées` : "versions validées ignorées (--sans-versions)"}`);
  console.log(`À nettoyer  : ${sheetUpdates.length} fiches, ${transUpdates.length} traductions, ${versionUpdates.length} versions validées`);
  if (invalidJson) console.log(`⚠ ${invalidJson} instantané(s) JSON illisible(s), ignoré(s)`);
  if (perField.size) {
    console.log("\nChamps modifiés :");
    for (const [k, n] of [...perField].sort()) console.log(`  ${k.padEnd(22)} ${n}`);
  }
  if (examples.length && EXAMPLES > 0) {
    console.log(`\nExemples (${Math.min(EXAMPLES, examples.length)} sur ${examples.length}) :`);
    for (const e of examples.slice(0, EXAMPLES)) console.log(`  ${e}`);
  }

  const total = sheetUpdates.length + transUpdates.length + versionUpdates.length;
  if (!total) {
    console.log("\nRien à nettoyer.");
  } else if (!APPLY) {
    console.log("\nSimulation terminée : relancer avec --apply pour écrire.");
  } else {
    /* ── Sauvegarde puis écriture transactionnelle ── */
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(API_ROOT, "tmp", `vinidoc-clean-texts-backup-${stamp}.json`);
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.writeFile(
      backupPath,
      JSON.stringify(
        {
          database: cfg.connection.database,
          date: new Date().toISOString(),
          SHEETS: sheetUpdates.map((u) => ({ SHTID: u.SHTID, before: Object.fromEntries(u.changes.map((d) => [d.field, d.before])) })),
          SHEETTRANS: transUpdates.map((u) => ({ SHTID: u.SHTID, LNGCOD: u.LNGCOD, before: Object.fromEntries(u.changes.map((d) => [d.field, d.before])) })),
          SHEETVERS: versionUpdates.map((u) => ({ SHTID: u.SHTID, VERNUM: u.VERNUM, SNAPSHOT: u.before })),
        },
        null,
        2,
      ),
    );
    console.log(`\nSauvegarde des valeurs d'origine : ${backupPath}`);

    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      for (const u of sheetUpdates) {
        const r = new sql.Request(tx).input("SHTID", sql.Int, u.SHTID);
        for (const d of u.changes) r.input(d.field, sql.NVarChar(100), d.after);
        await r.query(`UPDATE dbo.SHEETS SET ${u.changes.map((d) => `${d.field} = @${d.field}`).join(", ")} WHERE SHTID = @SHTID;`);
      }
      for (const u of transUpdates) {
        const r = new sql.Request(tx)
          .input("SHTID", sql.Int, u.SHTID)
          .input("LNGCOD", sql.VarChar(5), u.LNGCOD);
        for (const d of u.changes) r.input(d.field, sql.NVarChar(4000), d.after);
        await r.query(
          `UPDATE dbo.SHEETTRANS SET ${u.changes.map((d) => `${d.field} = @${d.field}`).join(", ")} WHERE SHTID = @SHTID AND LNGCOD = @LNGCOD;`,
        );
      }
      for (const u of versionUpdates) {
        await new sql.Request(tx)
          .input("SHTID", sql.Int, u.SHTID)
          .input("VERNUM", sql.Int, u.VERNUM)
          .input("SNAPSHOT", sql.NVarChar(sql.MAX), u.after)
          .query(`UPDATE dbo.SHEETVERS SET SNAPSHOT = @SNAPSHOT WHERE SHTID = @SHTID AND VERNUM = @VERNUM;`);
      }
      await tx.commit();
      console.log(`Écriture terminée : ${sheetUpdates.length} fiches, ${transUpdates.length} traductions, ${versionUpdates.length} versions validées.`);
    } catch (err) {
      await tx.rollback().catch(() => {});
      console.error("Échec : transaction annulée, aucune donnée modifiée.");
      throw err;
    }
  }
} finally {
  await pool.close();
}
