import sql from "mssql";
import { runQuery } from "../../core/utils/db.utils.js";
import { formatSheet, hexToRowver, omitKeys, upgradeSnapshot } from "./utils.js";

/* ═══════════════════════════════════════════════════════════════
   VINIDOC — Services (base VINIDOC, cf. sql/VINIDOC.tables.sql)

   Même approche que modules/declcav/audits/services.js : chaque écriture
   est UN batch SQL transactionnel. Les règles dépendant de l'état en base
   (fiche supprimée, ROWVER périmé, transition de statut interdite...) sont
   vérifiées DANS la transaction, sous verrou UPDLOCK/HOLDLOCK sur la ligne
   SHEETS/TEMPLATES, et lèvent des THROW 5017x traduits en clés du registre
   d'erreurs (core/utils/error.registry.js, famille 17xx).
═══════════════════════════════════════════════════════════════ */

const SQL_ERRORS = {
  50170: "VINIDOC_SHEET_NOT_FOUND",
  50171: "VINIDOC_CONCURRENT_UPDATE",
  50172: "VINIDOC_INVALID_STATUS_TRANSITION",
  50173: "VINIDOC_DEFAULT_TRANSLATION_REQUIRED",
  50174: "VINIDOC_TEMPLATE_NOT_FOUND",
  50175: "VINIDOC_UNKNOWN_TEMPLATE_TAG",
  50176: "VINIDOC_UNKNOWN_REFERENCE", // langue inconnue ou inactive
  547: "VINIDOC_UNKNOWN_REFERENCE", // violation de clé étrangère (langue, couleur...)
};

function toBusinessError(err, duplicateKey) {
  if ((err?.number === 2601 || err?.number === 2627) && duplicateKey) {
    return new Error(duplicateKey);
  }
  const key = SQL_ERRORS[err?.number];
  return key ? new Error(key) : err;
}

async function run({ duplicateKey = null, ...options }) {
  try {
    return await runQuery({ moduleUrl: import.meta.url, ...options });
  } catch (err) {
    throw toBusinessError(err, duplicateKey);
  }
}

const tx = (body) => `
  SET NOCOUNT ON;
  SET XACT_ABORT ON;
  BEGIN TRY
    BEGIN TRAN;
    ${body}
    COMMIT;
  END TRY
  BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    THROW;
  END CATCH;
`;

/** Verrouille une fiche active et contrôle son ROWVER. Expose @CURSTS, @LASTVER. */
const LOCK_SHEET = `
  DECLARE @CURSTS varchar(10), @ISDEL bit, @CURRV binary(8), @LASTVER int;
  SELECT @CURSTS = STATUS, @ISDEL = ISDEL, @CURRV = ROWVER, @LASTVER = LASTVER
  FROM dbo.SHEETS WITH (UPDLOCK, HOLDLOCK) WHERE SHTID = @SHTID;
  IF @ISDEL IS NULL OR @ISDEL = 1 THROW 50170, 'Fiche introuvable.', 1;
  IF @ROWVER IS NOT NULL AND @CURRV <> @ROWVER
    THROW 50171, 'La fiche a été modifiée par un autre utilisateur.', 1;
`;

/**
 * Statut d'une fiche après une modification de contenu, décidé SOUS VERROU
 * (à placer juste après LOCK_SHEET, avant toute écriture). Expose @NEWSTS.
 *   - valideur (marketing) sur une fiche SUBMITTED : elle reste SUBMITTED —
 *     c'est lui qui corrige, inutile de la lui resoumettre ; il valide ensuite ;
 *   - œnologie : la fiche repasse en DRAFT (à resoumettre) ;
 *   - sinon (marketing hors relecture) : transition interdite (50172).
 * Paramètres : @CANEDIT, @CANVALIDATE (cf. EDIT_RIGHTS_INPUTS).
 */
const RESOLVE_EDIT_STATUS = `
  DECLARE @NEWSTS varchar(10) =
    CASE
      WHEN @CANVALIDATE = 1 AND @CURSTS = 'SUBMITTED' THEN 'SUBMITTED'
      WHEN @CANEDIT = 1 THEN 'DRAFT'
    END;
  IF @NEWSTS IS NULL THROW 50172, 'Transition de statut non autorisée.', 1;
`;

const APPLY_EDIT_STATUS = `
  UPDATE dbo.SHEETS
  SET STATUS = @NEWSTS, MODUSR = @USR, MODDAT = SYSUTCDATETIME()
  WHERE SHTID = @SHTID;
`;

/** Droits de l'auteur d'une modification de contenu (cf. utils.getSheetEditRights). */
const EDIT_RIGHTS_INPUTS = (rights) => ({
  CANEDIT: { type: sql.Bit, value: !!rights?.CANEDIT },
  CANVALIDATE: { type: sql.Bit, value: !!rights?.CANVALIDATE },
});

const RETURN_STATE = `SELECT SHTID, STATUS, LASTVER, ROWVER FROM dbo.SHEETS WHERE SHTID = @SHTID;`;

const ATTACHMENTS = (() => {
  const db = process.env.DB_NAME_ATTACHMENTS || "APPATTACHMENTS";
  if (!/^\w+$/.test(db)) throw new Error("DB_CONFIGURATION_ERROR");
  return `[${db}].dbo.ATTACHMENTS`;
})();

const p = {
  int: (value) => ({ type: sql.Int, value: value ?? null }),
  tiny: (value) => ({ type: sql.TinyInt, value: value ?? null }),
  small: (value) => ({ type: sql.SmallInt, value: value ?? null }),
  dec: (value) => ({ type: sql.Decimal(4, 1), value: value ?? null }),
  bit: (value) => ({ type: sql.Bit, value: value == null ? null : !!value }),
  str: (len, value) => ({ type: sql.NVarChar(len), value: value ?? null }),
  vstr: (len, value) => ({ type: sql.VarChar(len), value: value ?? null }),
  json: (value) => ({ type: sql.NVarChar(sql.MAX), value: JSON.stringify(value ?? []) }),
  rowver: (hex) => ({ type: sql.VarBinary(8), value: hex ? hexToRowver(hex) : null }),
};

/* ═════════════════════════════ Référentiels ═════════════════════════════ */

export async function getLanguages({ activeOnly = true } = {}) {
  const result = await run({
    query: `
      SELECT LNGCOD, LNGNAM, ISDEFAULT, ACTIVE, SORTORD
      FROM dbo.LANGUAGES
      ${activeOnly ? "WHERE ACTIVE = 1" : ""}
      ORDER BY SORTORD, LNGCOD;
    `,
  });
  return result.recordset;
}

export async function getColors() {
  const result = await run({
    query: `
      SELECT c.COLCOD, c.SORTORD, t.LNGCOD, t.LABEL, t.BOUMIN, t.BOUMAX
      FROM dbo.COLORS c
      LEFT JOIN dbo.COLORTRANS t ON t.COLCOD = c.COLCOD
      ORDER BY c.SORTORD, t.LNGCOD;
    `,
  });
  const map = new Map();
  for (const r of result.recordset) {
    if (!map.has(r.COLCOD)) map.set(r.COLCOD, { COLCOD: r.COLCOD, LABELS: {} });
    if (r.LNGCOD) {
      map.get(r.COLCOD).LABELS[r.LNGCOD] = { LABEL: r.LABEL, BOUMIN: r.BOUMIN, BOUMAX: r.BOUMAX };
    }
  }
  return [...map.values()];
}

export async function getColorTrans(COLCOD, LNGCOD) {
  const result = await run({
    query: `SELECT LABEL, BOUMIN, BOUMAX FROM dbo.COLORTRANS WHERE COLCOD = @COLCOD AND LNGCOD = @LNGCOD;`,
    inputs: { COLCOD: p.vstr(10, COLCOD), LNGCOD: p.vstr(5, LNGCOD) },
  });
  return result.recordset[0] ?? {};
}

/* ═════════════════════════════ Fiches — lecture ═════════════════════════════ */

export async function listSheets({ SEARCH, STATUS, COLCOD, MILLESIME, GENERABLE, PAGE = 1, PAGESIZE = 50 }) {
  const where = ["s.ISDEL = 0"];
  if (SEARCH) where.push("(s.CODVRAC LIKE @SEARCH OR s.APPELL LIKE @SEARCH OR d.LIBELLE LIKE @SEARCH)");
  if (STATUS) where.push("s.STATUS = @STATUS");
  if (COLCOD) where.push("s.COLCOD = @COLCOD");
  if (MILLESIME) where.push("s.MILLESIME = @MILLESIME");
  if (GENERABLE === true) where.push("s.LASTVER > 0");
  if (GENERABLE === false) where.push("s.LASTVER = 0");

  // Échappement des jokers LIKE saisis par l'utilisateur (%, _, [).
  const like = SEARCH ? `%${SEARCH.replace(/[[%_]/g, "[$&]")}%` : null;

  const result = await run({
    query: `
      SELECT
        s.SHTID, s.CODVRAC, s.MILLESIME, s.APPELL, s.COLCOD, s.DESCVRAC,
        s.STATUS, s.LASTVER, s.MODUSR, s.MODDAT, s.SUBUSR, s.SUBDAT,
        d.LIBELLE,
        (SELECT STRING_AGG(t.LNGCOD, ',') WITHIN GROUP (ORDER BY t.LNGCOD)
           FROM dbo.SHEETTRANS t WHERE t.SHTID = s.SHTID) AS LANGUAGES,
        COUNT(*) OVER () AS TOTAL
      FROM dbo.SHEETS s
      LEFT JOIN dbo.LANGUAGES dl ON dl.ISDEFAULT = 1
      LEFT JOIN dbo.SHEETTRANS d ON d.SHTID = s.SHTID AND d.LNGCOD = dl.LNGCOD
      WHERE ${where.join(" AND ")}
      ORDER BY s.CODVRAC, s.MILLESIME DESC
      OFFSET @OFFSET ROWS FETCH NEXT @PAGESIZE ROWS ONLY;
    `,
    inputs: {
      SEARCH: p.str(400, like),
      STATUS: p.vstr(10, STATUS),
      COLCOD: p.vstr(10, COLCOD),
      MILLESIME: p.small(MILLESIME),
      OFFSET: p.int((PAGE - 1) * PAGESIZE),
      PAGESIZE: p.int(PAGESIZE),
    },
  });

  const rows = result.recordset;
  return {
    TOTAL: rows[0]?.TOTAL ?? 0,
    PAGE,
    PAGESIZE,
    ITEMS: rows.map((r) => ({
      ...omitKeys(r, ["TOTAL"]),
      LANGUAGES: r.LANGUAGES ? r.LANGUAGES.split(",") : [],
    })),
  };
}

/**
 * Fiches complètes (communs + traductions) : par identifiants (`SHTIDS`), ou
 * toutes les fiches soumettables (DRAFT / REJECTED) filtrées comme la liste.
 */
export async function getSheetsFull({ SHTIDS = null, SUBMITTABLE = false, SEARCH, COLCOD, MILLESIME } = {}) {
  if (SHTIDS && !SHTIDS.length) return [];
  const where = ["s.ISDEL = 0"];
  if (SHTIDS) where.push("s.SHTID IN (SELECT CAST(value AS int) FROM OPENJSON(@SHTIDS))");
  if (SUBMITTABLE) where.push("s.STATUS IN ('DRAFT', 'REJECTED')");
  if (SEARCH) where.push("(s.CODVRAC LIKE @SEARCH OR s.APPELL LIKE @SEARCH OR d.LIBELLE LIKE @SEARCH)");
  if (COLCOD) where.push("s.COLCOD = @COLCOD");
  if (MILLESIME) where.push("s.MILLESIME = @MILLESIME");
  const like = SEARCH ? `%${SEARCH.replace(/[[%_]/g, "[$&]")}%` : null;

  const result = await run({
    query: `
      SELECT s.* INTO #S
      FROM dbo.SHEETS s
      LEFT JOIN dbo.LANGUAGES dl ON dl.ISDEFAULT = 1
      LEFT JOIN dbo.SHEETTRANS d ON d.SHTID = s.SHTID AND d.LNGCOD = dl.LNGCOD
      WHERE ${where.join(" AND ")};

      SELECT * FROM #S ORDER BY CODVRAC, MILLESIME DESC;
      SELECT t.* FROM dbo.SHEETTRANS t INNER JOIN #S ON #S.SHTID = t.SHTID;
      DROP TABLE #S;
    `,
    inputs: {
      SHTIDS: p.json(SHTIDS),
      SEARCH: p.str(400, like),
      COLCOD: p.vstr(10, COLCOD),
      MILLESIME: p.small(MILLESIME),
    },
  });
  const [rows = [], trans = []] = result.recordsets;
  return rows.map((r) => formatSheet(r, trans.filter((t) => t.SHTID === r.SHTID)));
}

/** Fiche complète (communs + traductions), ou null. */
export async function getSheet(SHTID) {
  const result = await run({
    query: `
      SELECT * FROM dbo.SHEETS WHERE SHTID = @SHTID AND ISDEL = 0;
      SELECT * FROM dbo.SHEETTRANS WHERE SHTID = @SHTID;
    `,
    inputs: { SHTID: p.int(SHTID) },
  });
  const [[row] = [], trans = []] = result.recordsets;
  return formatSheet(row, trans);
}

export async function getSheetEvents(SHTID) {
  const result = await run({
    query: `
      SELECT EVTID, EVTTYP, FROMSTS, TOSTS, LNGCOD, VERNUM, EVTUSR, EVTDAT, COMMENT
      FROM dbo.SHEETEVTS WHERE SHTID = @SHTID
      ORDER BY EVTDAT DESC, EVTID DESC;
    `,
    inputs: { SHTID: p.int(SHTID) },
  });
  return result.recordset;
}

/** Versions validées (sans le contenu). */
export async function getSheetVersions(SHTID) {
  const result = await run({
    query: `
      SELECT VERNUM, SUBUSR, VALUSR, VALDAT, COMMENT
      FROM dbo.SHEETVERS WHERE SHTID = @SHTID ORDER BY VERNUM DESC;
    `,
    inputs: { SHTID: p.int(SHTID) },
  });
  return result.recordset;
}

/** Une version validée avec son contenu ; VERNUM absent = la dernière. */
export async function getSheetVersion(SHTID, VERNUM = null) {
  const result = await run({
    query: `
      SELECT TOP (1) v.VERNUM, v.SNAPSHOT, v.SUBUSR, v.VALUSR, v.VALDAT, v.COMMENT
      FROM dbo.SHEETVERS v
      INNER JOIN dbo.SHEETS s ON s.SHTID = v.SHTID AND s.ISDEL = 0
      WHERE v.SHTID = @SHTID AND (@VERNUM IS NULL OR v.VERNUM = @VERNUM)
      ORDER BY v.VERNUM DESC;
    `,
    inputs: { SHTID: p.int(SHTID), VERNUM: p.int(VERNUM) },
  });
  const row = result.recordset[0];
  if (!row) return null;
  return { ...row, SNAPSHOT: upgradeSnapshot(JSON.parse(row.SNAPSHOT)) };
}

/* ═════════════════════════════ Fiches — écriture ═════════════════════════════ */

const SHEET_INPUTS = (s) => ({
  CODVRAC: p.str(30, s.CODVRAC),
  MILLESIME: p.small(s.MILLESIME),
  APPELL: p.str(100, s.APPELL),
  COLCOD: p.vstr(10, s.COLCOD),
  DESCVRAC: p.str(100, s.DESCVRAC),
  INTARO: p.tiny(s.INTARO),
  INTBOU: p.tiny(s.INTBOU),
  ECHFRU: p.tiny(s.ECHFRU),
  TEMPMIN: p.dec(s.TEMPMIN),
  TEMPMAX: p.dec(s.TEMPMAX),
});

const TRANS_INPUTS = (t = {}) => ({
  LIBELLE: p.str(200, t.LIBELLE),
  TERROIR: p.str(4000, t.TERROIR),
  VINIF: p.str(4000, t.VINIF),
  DEGUST: p.str(4000, t.DEGUST),
  GARDE: p.str(100, t.GARDE),
  CEPAGES: p.str(1000, t.CEPAGES),
  ACCORDS: p.str(1000, t.ACCORDS),
  ACCEXPL: p.str(4000, t.ACCEXPL),
});

const UPSERT_TRANSLATION = `
  MERGE dbo.SHEETTRANS WITH (HOLDLOCK) AS t
  USING (SELECT @SHTID AS SHTID, @LNGCOD AS LNGCOD) AS s
  ON t.SHTID = s.SHTID AND t.LNGCOD = s.LNGCOD
  WHEN MATCHED THEN UPDATE SET
    LIBELLE = @LIBELLE, TERROIR = @TERROIR, VINIF = @VINIF, DEGUST = @DEGUST,
    GARDE = @GARDE, CEPAGES = @CEPAGES, ACCORDS = @ACCORDS, ACCEXPL = @ACCEXPL,
    MODUSR = @USR, MODDAT = SYSUTCDATETIME()
  WHEN NOT MATCHED THEN INSERT
    (SHTID, LNGCOD, LIBELLE, TERROIR, VINIF, DEGUST, GARDE, CEPAGES, ACCORDS, ACCEXPL, MODUSR)
    VALUES (@SHTID, @LNGCOD, @LIBELLE, @TERROIR, @VINIF, @DEGUST, @GARDE, @CEPAGES, @ACCORDS, @ACCEXPL, @USR);
`;

/**
 * Création : fiche + traduction initiale (langue par défaut,
 * optionnelle) + évènement CREATED.
 */
export async function createSheet({ sheet, translation, LNGCOD, USR }) {
  const result = await run({
    duplicateKey: "VINIDOC_SHEET_ALREADY_EXISTS",
    query: tx(`
      INSERT INTO dbo.SHEETS
        (CODVRAC, MILLESIME, APPELL, COLCOD, DESCVRAC, INTARO, INTBOU, ECHFRU, TEMPMIN, TEMPMAX, CREUSR, MODUSR)
      VALUES
        (@CODVRAC, @MILLESIME, @APPELL, @COLCOD, @DESCVRAC, @INTARO, @INTBOU, @ECHFRU, @TEMPMIN, @TEMPMAX, @USR, @USR);
      DECLARE @SHTID int = SCOPE_IDENTITY();

      IF @HASTRANS = 1
      BEGIN
        ${UPSERT_TRANSLATION}
      END;

      INSERT INTO dbo.SHEETEVTS (SHTID, EVTTYP, TOSTS, LNGCOD, EVTUSR)
      VALUES (@SHTID, 'CREATED', 'DRAFT', CASE WHEN @HASTRANS = 1 THEN @LNGCOD END, @USR);

      ${RETURN_STATE}
    `),
    inputs: {
      ...SHEET_INPUTS(sheet),
      ...TRANS_INPUTS(translation),
      HASTRANS: p.bit(!!translation),
      LNGCOD: p.vstr(5, LNGCOD),
      USR: p.str(254, USR),
    },
  });
  return result.recordset[0];
}

/** Mise à jour des champs communs → DRAFT (ou reste SUBMITTED si relecture marketing). */
export async function updateSheet({ SHTID, ROWVER, sheet, USR, RIGHTS }) {
  const result = await run({
    duplicateKey: "VINIDOC_SHEET_ALREADY_EXISTS",
    query: tx(`
      ${LOCK_SHEET}
      ${RESOLVE_EDIT_STATUS}

      UPDATE dbo.SHEETS SET
        CODVRAC = @CODVRAC, MILLESIME = @MILLESIME, APPELL = @APPELL, COLCOD = @COLCOD,
        DESCVRAC = @DESCVRAC, INTARO = @INTARO, INTBOU = @INTBOU, ECHFRU = @ECHFRU,
        TEMPMIN = @TEMPMIN, TEMPMAX = @TEMPMAX
      WHERE SHTID = @SHTID;
      ${APPLY_EDIT_STATUS}

      INSERT INTO dbo.SHEETEVTS (SHTID, EVTTYP, FROMSTS, TOSTS, EVTUSR)
      VALUES (@SHTID, 'UPDATED', @CURSTS, @NEWSTS, @USR);

      ${RETURN_STATE}
    `),
    inputs: {
      ...SHEET_INPUTS(sheet),
      SHTID: p.int(SHTID),
      ROWVER: p.rowver(ROWVER),
      USR: p.str(254, USR),
      ...EDIT_RIGHTS_INPUTS(RIGHTS),
    },
  });
  return result.recordset[0];
}

/** Création / remplacement d'une traduction → DRAFT (ou reste SUBMITTED si relecture marketing). */
export async function upsertTranslation({ SHTID, LNGCOD, ROWVER, translation, USR, RIGHTS }) {
  const result = await run({
    query: tx(`
      ${LOCK_SHEET}
      ${RESOLVE_EDIT_STATUS}
      IF NOT EXISTS (SELECT 1 FROM dbo.LANGUAGES WHERE LNGCOD = @LNGCOD AND ACTIVE = 1)
        THROW 50176, 'Langue inconnue ou inactive.', 1;

      ${UPSERT_TRANSLATION}
      ${APPLY_EDIT_STATUS}

      INSERT INTO dbo.SHEETEVTS (SHTID, EVTTYP, FROMSTS, TOSTS, LNGCOD, EVTUSR)
      VALUES (@SHTID, 'TRANSLATION_SAVED', @CURSTS, @NEWSTS, @LNGCOD, @USR);

      ${RETURN_STATE}
    `),
    inputs: {
      ...TRANS_INPUTS(translation),
      SHTID: p.int(SHTID),
      LNGCOD: p.vstr(5, LNGCOD),
      ROWVER: p.rowver(ROWVER),
      USR: p.str(254, USR),
      ...EDIT_RIGHTS_INPUTS(RIGHTS),
    },
  });
  return result.recordset[0];
}

/** Suppression d'une traduction (interdit pour la langue par défaut) → DRAFT (ou reste SUBMITTED si relecture marketing). */
export async function deleteTranslation({ SHTID, LNGCOD, ROWVER, USR, RIGHTS }) {
  const result = await run({
    query: tx(`
      ${LOCK_SHEET}
      ${RESOLVE_EDIT_STATUS}
      IF EXISTS (SELECT 1 FROM dbo.LANGUAGES WHERE LNGCOD = @LNGCOD AND ISDEFAULT = 1)
        THROW 50173, 'La traduction dans la langue par défaut ne peut pas être supprimée.', 1;

      DELETE FROM dbo.SHEETTRANS WHERE SHTID = @SHTID AND LNGCOD = @LNGCOD;
      IF @@ROWCOUNT = 0 THROW 50170, 'Traduction introuvable.', 1;
      ${APPLY_EDIT_STATUS}

      INSERT INTO dbo.SHEETEVTS (SHTID, EVTTYP, FROMSTS, TOSTS, LNGCOD, EVTUSR)
      VALUES (@SHTID, 'TRANSLATION_DELETED', @CURSTS, @NEWSTS, @LNGCOD, @USR);

      ${RETURN_STATE}
    `),
    inputs: {
      SHTID: p.int(SHTID),
      LNGCOD: p.vstr(5, LNGCOD),
      ROWVER: p.rowver(ROWVER),
      USR: p.str(254, USR),
      ...EDIT_RIGHTS_INPUTS(RIGHTS),
    },
  });
  return result.recordset[0];
}

/** Suppression logique (l'historique et les versions validées sont conservés). */
export async function deleteSheet({ SHTID, ROWVER, USR, COMMENT }) {
  await run({
    query: tx(`
      ${LOCK_SHEET}
      UPDATE dbo.SHEETS SET ISDEL = 1, MODUSR = @USR, MODDAT = SYSUTCDATETIME() WHERE SHTID = @SHTID;
      INSERT INTO dbo.SHEETEVTS (SHTID, EVTTYP, FROMSTS, EVTUSR, COMMENT)
      VALUES (@SHTID, 'DELETED', @CURSTS, @USR, @COMMENT);
    `),
    inputs: {
      SHTID: p.int(SHTID),
      ROWVER: p.rowver(ROWVER),
      USR: p.str(254, USR),
      COMMENT: p.str(1000, COMMENT),
    },
  });
  return { SHTID, DELETED: true };
}

/* ═════════════════════════════ Workflow ═════════════════════════════ */

const assertStatusIn = (statuses) => `
  IF @CURSTS NOT IN (${statuses.map((s) => `'${s}'`).join(", ")})
    THROW 50172, 'Transition de statut non autorisée.', 1;
`;

/** DRAFT | REJECTED → SUBMITTED (traduction par défaut obligatoire). */
export async function submitSheet({ SHTID, ROWVER, USR, COMMENT }) {
  const result = await run({
    query: tx(`
      ${LOCK_SHEET}
      ${assertStatusIn(["DRAFT", "REJECTED"])}
      IF NOT EXISTS (
        SELECT 1 FROM dbo.SHEETTRANS t
        INNER JOIN dbo.LANGUAGES l ON l.LNGCOD = t.LNGCOD AND l.ISDEFAULT = 1
        WHERE t.SHTID = @SHTID
      ) THROW 50173, 'La traduction dans la langue par défaut est obligatoire.', 1;

      UPDATE dbo.SHEETS
      SET STATUS = 'SUBMITTED', SUBUSR = @USR, SUBDAT = SYSUTCDATETIME()
      WHERE SHTID = @SHTID;

      INSERT INTO dbo.SHEETEVTS (SHTID, EVTTYP, FROMSTS, TOSTS, EVTUSR, COMMENT)
      VALUES (@SHTID, 'SUBMITTED', @CURSTS, 'SUBMITTED', @USR, @COMMENT);

      ${RETURN_STATE}
    `),
    inputs: {
      SHTID: p.int(SHTID),
      ROWVER: p.rowver(ROWVER),
      USR: p.str(254, USR),
      COMMENT: p.str(1000, COMMENT),
    },
  });
  return result.recordset[0];
}

/**
 * SUBMITTED → VALIDATED : fige `SNAPSHOT` dans une nouvelle version.
 * Le ROWVER passé est celui de la lecture ayant servi à construire
 * l'instantané : s'il a changé, le contenu figé ne serait plus celui
 * présenté au valideur → 409.
 */
export async function validateSheet({ SHTID, ROWVER, SNAPSHOT, USR, COMMENT }) {
  const result = await run({
    query: tx(`
      ${LOCK_SHEET}
      ${assertStatusIn(["SUBMITTED"])}

      DECLARE @VERNUM int = @LASTVER + 1;
      INSERT INTO dbo.SHEETVERS (SHTID, VERNUM, SNAPSHOT, SUBUSR, VALUSR, COMMENT)
      SELECT @SHTID, @VERNUM, @SNAPSHOT, SUBUSR, @USR, @COMMENT FROM dbo.SHEETS WHERE SHTID = @SHTID;

      UPDATE dbo.SHEETS SET STATUS = 'VALIDATED', LASTVER = @VERNUM WHERE SHTID = @SHTID;

      INSERT INTO dbo.SHEETEVTS (SHTID, EVTTYP, FROMSTS, TOSTS, VERNUM, EVTUSR, COMMENT)
      VALUES (@SHTID, 'VALIDATED', @CURSTS, 'VALIDATED', @VERNUM, @USR, @COMMENT);

      ${RETURN_STATE}
    `),
    inputs: {
      SHTID: p.int(SHTID),
      ROWVER: p.rowver(ROWVER),
      SNAPSHOT: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(SNAPSHOT) },
      USR: p.str(254, USR),
      COMMENT: p.str(1000, COMMENT),
    },
  });
  return result.recordset[0];
}

/** SUBMITTED → REJECTED (motif obligatoire). */
export async function rejectSheet({ SHTID, ROWVER, USR, COMMENT }) {
  const result = await run({
    query: tx(`
      ${LOCK_SHEET}
      ${assertStatusIn(["SUBMITTED"])}
      UPDATE dbo.SHEETS SET STATUS = 'REJECTED' WHERE SHTID = @SHTID;

      INSERT INTO dbo.SHEETEVTS (SHTID, EVTTYP, FROMSTS, TOSTS, EVTUSR, COMMENT)
      VALUES (@SHTID, 'REJECTED', @CURSTS, 'REJECTED', @USR, @COMMENT);

      ${RETURN_STATE}
    `),
    inputs: {
      SHTID: p.int(SHTID),
      ROWVER: p.rowver(ROWVER),
      USR: p.str(254, USR),
      COMMENT: p.str(1000, COMMENT),
    },
  });
  return result.recordset[0];
}

/* ═════════════════════════════ Modèles ═════════════════════════════ */

const TEMPLATE_COLUMNS = `
  t.TPLID, t.TPLKEY, t.TPLNAM, t.DESCR, t.LNGCOD, t.FILECODE, t.ACTIVE,
  t.CREUSR, t.CREDAT, t.MODUSR, t.MODDAT, t.ROWVER,
  a.ORIGINALNAME, a.RELATIVEPATH, a.SIZEBYTES
`;

export async function listTemplates({ ACTIVE, LNGCOD } = {}) {
  const where = ["t.ISDEL = 0"];
  if (ACTIVE !== undefined) where.push("t.ACTIVE = @ACTIVE");
  if (LNGCOD) where.push("(t.LNGCOD IS NULL OR t.LNGCOD = @LNGCOD)");

  const result = await run({
    query: `
      SELECT ${TEMPLATE_COLUMNS},
        (SELECT COUNT(*) FROM dbo.TEMPLATETAGS g WHERE g.TPLID = t.TPLID AND g.TAGTYP = 'TEXT') AS TEXTTAGS,
        (SELECT COUNT(*) FROM dbo.TEMPLATETAGS g WHERE g.TPLID = t.TPLID AND g.ISKNOWN = 0) AS UNKNOWNTAGS
      FROM dbo.TEMPLATES t
      LEFT JOIN ${ATTACHMENTS} a ON a.FILECODE = t.FILECODE
      WHERE ${where.join(" AND ")}
      ORDER BY t.TPLNAM;
    `,
    inputs: { ACTIVE: p.bit(ACTIVE), LNGCOD: p.vstr(5, LNGCOD) },
  });
  return result.recordset;
}

export async function getTemplate(TPLID) {
  const result = await run({
    query: `
      SELECT ${TEMPLATE_COLUMNS}
      FROM dbo.TEMPLATES t
      LEFT JOIN ${ATTACHMENTS} a ON a.FILECODE = t.FILECODE
      WHERE t.TPLID = @TPLID AND t.ISDEL = 0;

      SELECT TAGTYP, TAGNAM, MAXLEN, REQUIRED, ISKNOWN
      FROM dbo.TEMPLATETAGS WHERE TPLID = @TPLID
      ORDER BY TAGTYP DESC, TAGNAM;
    `,
    inputs: { TPLID: p.int(TPLID) },
  });
  const [[row] = [], tags = []] = result.recordsets;
  return row ? { ...row, TAGS: tags } : null;
}

const TAGS_JSON = (tags) =>
  p.json(
    tags.map((t) => ({
      TAGTYP: t.TAGTYP,
      TAGNAM: t.TAGNAM,
      ISKNOWN: t.ISKNOWN ? 1 : 0,
      MAXLEN: t.TAGTYP === "TEXT" ? (t.MAXLEN ?? null) : null,
    })),
  );

export async function createTemplate({ TPLKEY, TPLNAM, DESCR, LNGCOD, FILECODE, TAGS, USR }) {
  const result = await run({
    duplicateKey: "VINIDOC_TEMPLATE_NAME_EXISTS",
    query: tx(`
      INSERT INTO dbo.TEMPLATES (TPLKEY, TPLNAM, DESCR, LNGCOD, FILECODE, CREUSR, MODUSR)
      VALUES (@TPLKEY, @TPLNAM, @DESCR, @LNGCOD, @FILECODE, @USR, @USR);
      DECLARE @TPLID int = SCOPE_IDENTITY();

      INSERT INTO dbo.TEMPLATETAGS (TPLID, TAGTYP, TAGNAM, ISKNOWN, MAXLEN)
      SELECT @TPLID, j.TAGTYP, j.TAGNAM, j.ISKNOWN, j.MAXLEN
      FROM OPENJSON(@TAGS) WITH (TAGTYP varchar(10), TAGNAM varchar(100), ISKNOWN bit, MAXLEN int) j;

      SELECT @TPLID AS TPLID;
    `),
    inputs: {
      TPLKEY: { type: sql.Char(26), value: TPLKEY },
      TPLNAM: p.str(150, TPLNAM),
      DESCR: p.str(1000, DESCR),
      LNGCOD: p.vstr(5, LNGCOD),
      FILECODE: p.vstr(50, FILECODE),
      TAGS: TAGS_JSON(TAGS),
      USR: p.str(254, USR),
    },
  });
  return result.recordset[0];
}

const LOCK_TEMPLATE = `
  DECLARE @TISDEL bit, @TRV binary(8), @OLDFILE varchar(50);
  SELECT @TISDEL = ISDEL, @TRV = ROWVER, @OLDFILE = FILECODE
  FROM dbo.TEMPLATES WITH (UPDLOCK, HOLDLOCK) WHERE TPLID = @TPLID;
  IF @TISDEL IS NULL OR @TISDEL = 1 THROW 50174, 'Modèle introuvable.', 1;
  IF @ROWVER IS NOT NULL AND @TRV <> @ROWVER
    THROW 50171, 'Le modèle a été modifié par un autre utilisateur.', 1;
`;

export async function updateTemplate({ TPLID, ROWVER, TPLNAM, DESCR, LNGCOD, ACTIVE, USR }) {
  const result = await run({
    duplicateKey: "VINIDOC_TEMPLATE_NAME_EXISTS",
    query: tx(`
      ${LOCK_TEMPLATE}
      UPDATE dbo.TEMPLATES SET
        TPLNAM = @TPLNAM, DESCR = @DESCR, LNGCOD = @LNGCOD, ACTIVE = @ACTIVE,
        MODUSR = @USR, MODDAT = SYSUTCDATETIME()
      WHERE TPLID = @TPLID;
      SELECT TPLID, ROWVER FROM dbo.TEMPLATES WHERE TPLID = @TPLID;
    `),
    inputs: {
      TPLID: p.int(TPLID),
      ROWVER: p.rowver(ROWVER),
      TPLNAM: p.str(150, TPLNAM),
      DESCR: p.str(1000, DESCR),
      LNGCOD: p.vstr(5, LNGCOD),
      ACTIVE: p.bit(ACTIVE),
      USR: p.str(254, USR),
    },
  });
  return result.recordset[0];
}

/**
 * Remplacement du fichier : les réglages (MAXLEN/REQUIRED) des balises
 * toujours présentes sont conservés, les nouvelles balises sont ajoutées,
 * les disparues supprimées. Une longueur saisie dans la balise du nouveau
 * fichier ({{TAG-250}}) remplace la longueur enregistrée. L'ancien fichier n'est PAS supprimé : il reste
 * référencé par GENERATIONS.TPLFILECODE (traçabilité).
 */
export async function replaceTemplateFile({ TPLID, FILECODE, TAGS, USR }) {
  const result = await run({
    query: tx(`
      DECLARE @ROWVER binary(8) = NULL;
      ${LOCK_TEMPLATE}

      DECLARE @NEW TABLE (TAGTYP varchar(10), TAGNAM varchar(100), ISKNOWN bit, MAXLEN int);
      INSERT INTO @NEW SELECT j.TAGTYP, j.TAGNAM, j.ISKNOWN, j.MAXLEN
      FROM OPENJSON(@TAGS) WITH (TAGTYP varchar(10), TAGNAM varchar(100), ISKNOWN bit, MAXLEN int) j;

      SELECT g.TAGTYP, g.TAGNAM FROM dbo.TEMPLATETAGS g
      WHERE g.TPLID = @TPLID
        AND NOT EXISTS (SELECT 1 FROM @NEW n WHERE n.TAGTYP = g.TAGTYP AND n.TAGNAM = g.TAGNAM);

      SELECT n.TAGTYP, n.TAGNAM FROM @NEW n
      WHERE NOT EXISTS (SELECT 1 FROM dbo.TEMPLATETAGS g WHERE g.TPLID = @TPLID AND g.TAGTYP = n.TAGTYP AND g.TAGNAM = n.TAGNAM);

      -- Longueurs modifiées par le nouveau fichier (avant mise à jour)
      SELECT g.TAGTYP, g.TAGNAM, g.MAXLEN AS OLDMAXLEN, n.MAXLEN AS NEWMAXLEN
      FROM dbo.TEMPLATETAGS g INNER JOIN @NEW n ON n.TAGTYP = g.TAGTYP AND n.TAGNAM = g.TAGNAM
      WHERE g.TPLID = @TPLID AND n.MAXLEN IS NOT NULL
        AND (g.MAXLEN IS NULL OR g.MAXLEN <> n.MAXLEN);

      DELETE g FROM dbo.TEMPLATETAGS g
      WHERE g.TPLID = @TPLID
        AND NOT EXISTS (SELECT 1 FROM @NEW n WHERE n.TAGTYP = g.TAGTYP AND n.TAGNAM = g.TAGNAM);

      UPDATE g SET ISKNOWN = n.ISKNOWN, MAXLEN = COALESCE(n.MAXLEN, g.MAXLEN)
      FROM dbo.TEMPLATETAGS g INNER JOIN @NEW n ON n.TAGTYP = g.TAGTYP AND n.TAGNAM = g.TAGNAM
      WHERE g.TPLID = @TPLID;

      INSERT INTO dbo.TEMPLATETAGS (TPLID, TAGTYP, TAGNAM, ISKNOWN, MAXLEN)
      SELECT @TPLID, n.TAGTYP, n.TAGNAM, n.ISKNOWN, n.MAXLEN FROM @NEW n
      WHERE NOT EXISTS (SELECT 1 FROM dbo.TEMPLATETAGS g WHERE g.TPLID = @TPLID AND g.TAGTYP = n.TAGTYP AND g.TAGNAM = n.TAGNAM);

      UPDATE dbo.TEMPLATES SET FILECODE = @FILECODE, MODUSR = @USR, MODDAT = SYSUTCDATETIME()
      WHERE TPLID = @TPLID;

      SELECT @OLDFILE AS OLDFILECODE;
    `),
    inputs: {
      TPLID: p.int(TPLID),
      FILECODE: p.vstr(50, FILECODE),
      TAGS: TAGS_JSON(TAGS),
      USR: p.str(254, USR),
    },
  });
  const [removed = [], added = [], maxlen = [], [old] = []] = result.recordsets;
  return {
    REMOVED: removed,
    ADDED: added,
    MAXLEN: maxlen,
    OLDFILECODE: old?.OLDFILECODE ?? null,
  };
}

/** Réglage des longueurs max / caractère obligatoire des balises existantes. */
export async function setTemplateTags({ TPLID, TAGS, USR }) {
  await run({
    query: tx(`
      DECLARE @ROWVER binary(8) = NULL;
      ${LOCK_TEMPLATE}

      DECLARE @IN TABLE (TAGTYP varchar(10), TAGNAM varchar(100), MAXLEN int, REQUIRED bit);
      INSERT INTO @IN SELECT j.TAGTYP, j.TAGNAM, j.MAXLEN, j.REQUIRED
      FROM OPENJSON(@TAGS) WITH (TAGTYP varchar(10), TAGNAM varchar(100), MAXLEN int, REQUIRED bit) j;

      IF EXISTS (
        SELECT 1 FROM @IN i
        WHERE NOT EXISTS (SELECT 1 FROM dbo.TEMPLATETAGS g
                          WHERE g.TPLID = @TPLID AND g.TAGTYP = i.TAGTYP AND g.TAGNAM = i.TAGNAM)
      ) THROW 50175, 'Balise absente du modèle.', 1;

      UPDATE g SET MAXLEN = i.MAXLEN, REQUIRED = i.REQUIRED
      FROM dbo.TEMPLATETAGS g INNER JOIN @IN i ON i.TAGTYP = g.TAGTYP AND i.TAGNAM = g.TAGNAM
      WHERE g.TPLID = @TPLID;

      UPDATE dbo.TEMPLATES SET MODUSR = @USR, MODDAT = SYSUTCDATETIME() WHERE TPLID = @TPLID;
    `),
    inputs: {
      TPLID: p.int(TPLID),
      TAGS: p.json(TAGS),
      USR: p.str(254, USR),
    },
  });
}

export async function deleteTemplate({ TPLID, USR }) {
  await run({
    query: tx(`
      DECLARE @ROWVER binary(8) = NULL;
      ${LOCK_TEMPLATE}
      UPDATE dbo.TEMPLATES SET ISDEL = 1, ACTIVE = 0, MODUSR = @USR, MODDAT = SYSUTCDATETIME()
      WHERE TPLID = @TPLID;
    `),
    inputs: { TPLID: p.int(TPLID), USR: p.str(254, USR) },
  });
  return { TPLID, DELETED: true };
}

/**
 * Balises texte des modèles actifs utilisables dans la langue demandée
 * (une ligne par modèle × balise) — sert au contrôle multi-modèles et aux
 * longueurs max affichées pendant la saisie.
 */
export async function getTextTagLimits(LNGCOD = null) {
  const result = await run({
    query: `
      SELECT g.TAGTYP, g.TAGNAM, g.MAXLEN, g.REQUIRED, g.ISKNOWN, t.TPLID, t.TPLNAM, t.LNGCOD AS TPLLNG
      FROM dbo.TEMPLATETAGS g
      INNER JOIN dbo.TEMPLATES t ON t.TPLID = g.TPLID AND t.ACTIVE = 1 AND t.ISDEL = 0
      WHERE g.TAGTYP = 'TEXT'
        AND (@LNGCOD IS NULL OR t.LNGCOD IS NULL OR t.LNGCOD = @LNGCOD);
    `,
    inputs: { LNGCOD: p.vstr(5, LNGCOD) },
  });
  return result.recordset;
}

/* ═════════════════════════════ Générations ═════════════════════════════ */

/** VERNUM null = générée depuis la saisie en cours (fiche non validée). */
export async function insertGeneration({ SHTID, VERNUM, TPLID, TPLFILECODE, LNGCOD, FORMAT, HVE = false, BIO = false, FILECODE, USR }) {
  const result = await run({
    query: `
      INSERT INTO dbo.GENERATIONS (SHTID, VERNUM, TPLID, TPLFILECODE, LNGCOD, FORMAT, HVE, BIO, FILECODE, CREUSR)
      OUTPUT INSERTED.GENID, INSERTED.CREDAT
      VALUES (@SHTID, @VERNUM, @TPLID, @TPLFILECODE, @LNGCOD, @FORMAT, @HVE, @BIO, @FILECODE, @USR);
    `,
    inputs: {
      SHTID: p.int(SHTID),
      VERNUM: p.int(VERNUM),
      TPLID: p.int(TPLID),
      TPLFILECODE: p.vstr(50, TPLFILECODE),
      LNGCOD: p.vstr(5, LNGCOD),
      FORMAT: p.vstr(4, FORMAT),
      HVE: p.bit(HVE),
      BIO: p.bit(BIO),
      FILECODE: p.vstr(50, FILECODE),
      USR: p.str(254, USR),
    },
  });
  return result.recordset[0];
}

export async function listGenerations({ SHTID, TPLID, LIMIT = 100 }) {
  const result = await run({
    query: `
      SELECT TOP (@LIMIT)
        g.GENID, g.SHTID, s.CODVRAC, s.MILLESIME, g.VERNUM,
        CASE WHEN g.VERNUM IS NULL THEN 'CURRENT' ELSE 'VALIDATED' END AS SOURCE,
        g.TPLID, t.TPLNAM,
        g.LNGCOD, g.FORMAT, g.HVE, g.BIO, g.FILECODE, g.CREUSR, g.CREDAT,
        a.ORIGINALNAME, a.RELATIVEPATH, a.SIZEBYTES
      FROM dbo.GENERATIONS g
      INNER JOIN dbo.SHEETS s ON s.SHTID = g.SHTID
      INNER JOIN dbo.TEMPLATES t ON t.TPLID = g.TPLID
      LEFT JOIN ${ATTACHMENTS} a ON a.FILECODE = g.FILECODE AND a.DELETEDAT IS NULL
      WHERE (@SHTID IS NULL OR g.SHTID = @SHTID)
        AND (@TPLID IS NULL OR g.TPLID = @TPLID)
      ORDER BY g.CREDAT DESC, g.GENID DESC;
    `,
    inputs: { SHTID: p.int(SHTID), TPLID: p.int(TPLID), LIMIT: p.int(LIMIT) },
  });
  return result.recordset;
}
