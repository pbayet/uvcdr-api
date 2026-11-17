#!/usr/bin/env node
/**
 * DCKMNG — Génère le script SQL d'import des données de l'ancienne
 * application Dock Manager (fichiers JSON mensuels data/data-YYYY-MM.json).
 *
 * Utilisation :
 *   node modules/dckmng/scripts/import-json.mjs <dossier data> [fichier .sql]
 *
 * Exemple :
 *   node modules/dckmng/scripts/import-json.mjs "../../../FRONTs/REACT/UNIS (Union Numeric Interne Services)/dock-manager/data" modules/dckmng/sql/DCKMNG.seed.import-json.sql
 *
 * Le script produit est idempotent : une ligne déjà importée (même LEGACYID)
 * n'est pas réinsérée. Le statut n'est pas importé : il est recalculé par la
 * colonne calculée DCKLOADS.STSCOD (même règle que l'ancienne application).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [, , dataDirArg, outArg] = process.argv;
if (!dataDirArg) {
  console.error("Usage : node import-json.mjs <dossier data> [fichier .sql]");
  process.exit(1);
}

const dataDir = resolve(dataDirArg);
const files = readdirSync(dataDir)
  .filter((f) => /^data-\d{4}-\d{2}\.json$/.test(f))
  .sort();

/** Littéral SQL N'...' (NULL si vide), tronqué à `max` caractères. */
const str = (v, max) => {
  const s = String(v ?? "").trim();
  if (!s) return "NULL";
  return `N'${s.slice(0, max).replace(/'/g, "''")}'`;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_RE = /^\d{2}:\d{2}$/;

const rows = [];
for (const file of files) {
  const data = JSON.parse(readFileSync(join(dataDir, file), "utf8"));
  for (const r of Array.isArray(data) ? data : []) {
    if (!r?.id || !DATE_RE.test(r.date ?? "") || !String(r.nom ?? "").trim()) continue;
    const hour = HOUR_RE.test(r.heure ?? "") ? r.heure : "00:00";
    rows.push(
      `(${str(r.id, 50).replace(/^N/, "")}, '${r.date}', '${hour}:00', ${str(r.nom, 200)}, ${str(r.quai, 10)}, ` +
        `${str(r.quai2, 10)}, ${str(r.operateurDebut, 50)}, ${str(r.operateurFin, 50)})`,
    );
  }
}

const BATCH = 500; // une instruction VALUES est limitée à 1000 lignes
const batches = [];
for (let i = 0; i < rows.length; i += BATCH) {
  batches.push(`INSERT INTO @src (LEGACYID, LODDAT, LODHOU, NOM, QUAI, QUAEFF, OPEDEB, OPEFIN) VALUES
${rows.slice(i, i + BATCH).join(",\n")};`);
}

const sql = `/* ═══════════════════════════════════════════════════════════════
   DCKMNG — Import des données de l'ancienne application (JSON)
   Généré le ${new Date().toISOString()} par modules/dckmng/scripts/import-json.mjs
   Fichiers : ${files.join(", ") || "(aucun)"}
   Lignes   : ${rows.length}
   Idempotent : les lignes déjà importées (LEGACYID) sont ignorées.
═══════════════════════════════════════════════════════════════ */

USE [DCKMNG];
GO

SET NOCOUNT ON;

DECLARE @src TABLE (
    LEGACYID VARCHAR(50), LODDAT DATE, LODHOU TIME(0), NOM NVARCHAR(200),
    QUAI NVARCHAR(10), QUAEFF NVARCHAR(10), OPEDEB NVARCHAR(50), OPEFIN NVARCHAR(50)
);

${batches.join("\n\n")}

INSERT INTO dbo.DCKLOADS (LODDAT, LODHOU, NOM, QUAI, QUAEFF, OPEDEB, OPEFIN, CREDAT, LEGACYID)
SELECT s.LODDAT, s.LODHOU, s.NOM, s.QUAI, s.QUAEFF, s.OPEDEB, s.OPEFIN,
       DATEADD(SECOND, DATEDIFF(SECOND, CAST('00:00' AS TIME(0)), s.LODHOU), CAST(s.LODDAT AS DATETIME2(0))),
       s.LEGACYID
FROM @src AS s
WHERE NOT EXISTS (SELECT 1 FROM dbo.DCKLOADS AS l WHERE l.LEGACYID = s.LEGACYID);

PRINT CONCAT(@@ROWCOUNT, ' chargement(s) importé(s).');
GO
`;

if (outArg) {
  writeFileSync(resolve(outArg), sql);
  console.log(`✔ ${rows.length} ligne(s) → ${resolve(outArg)}`);
} else {
  process.stdout.write(sql);
}
