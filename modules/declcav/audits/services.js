import sql from "mssql";
import { runQuery } from "../../../core/utils/db.utils.js";

/* ═══════════════════════════════════════════════════════════════
   AUDITS — Services (base DECLCAV)
   Tables : AUDITS, AUDITVERS, AUDITRETS, AUDITDOCS, AUDITEVTS
   Vue    : V_AUDITS (état courant dérivé)
   Cf. modules/declcav/sql/AUDITS.table.sql pour le modèle "insert-only".

   `dbConnectionName: "declcav"` est explicite : ce sous-dossier ne
   correspond à aucune connexion (getDbConnexion déduit sinon le nom de
   connexion du dossier parent, soit "audits").

   Chaque écriture est un batch transactionnel unique. Les règles métier
   dépendant de l'état en base (audit supprimé, version obsolète, retour
   déjà revu...) sont vérifiées DANS la transaction, sous verrou
   (UPDLOCK/HOLDLOCK sur la ligne AUDITS), pour rester justes en cas
   d'actions concurrentes — elles lèvent des THROW 5011x traduits en 404/
   409 par toBusinessError().
═══════════════════════════════════════════════════════════════ */

const DB = "declcav";

const BUSINESS_ERRORS = {
  50110: 404, // audit introuvable
  50111: 409, // audit supprimé
  50112: 400, // document reconduit n'appartenant pas à la version courante
  50113: 409, // version obsolète (la Qualité a publié une nouvelle version)
  50114: 409, // retour déjà en attente ou audit déjà validé
  50115: 409, // retour non révisable (déjà revu / pas le dernier)
  50116: 400, // aucun document
};

function toBusinessError(err) {
  const status = BUSINESS_ERRORS[err?.number];
  if (!status) return err;
  const e = new Error(err.message);
  e.status = status;
  return e;
}

async function run(options) {
  try {
    return await runQuery({ moduleUrl: import.meta.url, dbConnectionName: DB, ...options });
  } catch (err) {
    throw toBusinessError(err);
  }
}

/** Bloc SQL commun : verrouille l'audit et vérifie qu'il est actif. */
const LOCK_ACTIVE_AUDIT = `
  DECLARE @ISDEL bit;
  SELECT @ISDEL = ISDEL FROM AUDITS WITH (UPDLOCK, HOLDLOCK) WHERE AUDID = @AUDID;
  IF @ISDEL IS NULL THROW 50110, 'Audit introuvable.', 1;
  IF @ISDEL = 1 THROW 50111, 'Cet audit a été supprimé.', 1;
`;

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

const nvarchar = (len, value) => ({ type: sql.NVarChar(len), value: value ?? null });
/** "YYYY-MM-DD" → Date UTC minuit (mssql useUTC) pour une colonne `date`. */
const date = (iso) => ({ type: sql.Date, value: iso ? new Date(`${iso}T00:00:00Z`) : null });
const json = (value) => ({ type: sql.NVarChar(sql.MAX), value: JSON.stringify(value ?? []) });

/* ─────────────────────────────── Lecture ─────────────────────────────── */

export async function listAudits({ CAVEID = null, INCLUDE_DELETED = false } = {}) {
  const where = [];
  if (CAVEID) where.push("CAVEID = @CAVEID");
  if (!INCLUDE_DELETED) where.push("ISDEL = 0");

  const result = await run({
    query: `
      SELECT * FROM V_AUDITS
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY CAVENOM, DATEXP DESC, AUDID DESC
    `,
    inputs: { CAVEID: { type: sql.Int, value: CAVEID } },
  });
  return result.recordset;
}

export async function getAudit(AUDID) {
  const result = await run({
    query: `SELECT * FROM V_AUDITS WHERE AUDID = @AUDID`,
    inputs: { AUDID: { type: sql.Int, value: AUDID } },
  });
  return result.recordset[0] ?? null;
}

/** Historique complet : 4 jeux de résultats en un aller-retour. */
export async function getAuditHistory(AUDID) {
  const result = await run({
    query: `
      SELECT * FROM AUDITVERS WHERE AUDID = @AUDID ORDER BY VERNUM DESC;

      SELECT R.* FROM AUDITRETS R
      INNER JOIN AUDITVERS V ON V.VERID = R.VERID
      WHERE V.AUDID = @AUDID
      ORDER BY V.VERNUM DESC, R.RETNUM DESC;

      SELECT D.DOCID, D.VERID, D.RETID, D.FILECODE, D.CREDAT,
             A.ORIGINALNAME, A.STOREDNAME, A.RELATIVEPATH, A.MIMETYPE,
             A.EXTENSION, A.SIZEBYTES, A.UPLOADEDBY
      FROM AUDITDOCS D
      LEFT JOIN APPATTACHMENTS.dbo.ATTACHMENTS A ON A.FILECODE = D.FILECODE
      WHERE D.AUDID = @AUDID
        AND A.DELETEDAT IS NULL
      ORDER BY D.DOCID;

      SELECT * FROM AUDITEVTS WHERE AUDID = @AUDID ORDER BY EVTDAT DESC, EVTID DESC;
    `,
    inputs: { AUDID: { type: sql.Int, value: AUDID } },
  });

  const [versions = [], returns = [], docs = [], events = []] = result.recordsets;
  return { versions, returns, docs, events };
}

/* ─────────────────────────────── Écriture ─────────────────────────────── */

/** Création : AUDITS + version 1 + documents + évènement CREATED. */
export async function createAudit({ CAVEID, TITLE, DATEXP, COMMENT, FILECODES, USR }) {
  const result = await run({
    query: tx(`
      IF NOT EXISTS (SELECT 1 FROM OPENJSON(@FILECODES))
        THROW 50116, 'Au moins un document est requis.', 1;

      INSERT INTO AUDITS (CAVEID, TITLE, CREUSR) VALUES (@CAVEID, @TITLE, @USR);
      DECLARE @AUDID int = SCOPE_IDENTITY();

      INSERT INTO AUDITVERS (AUDID, VERNUM, DATEXP, COMMENT, CREUSR)
      VALUES (@AUDID, 1, @DATEXP, @COMMENT, @USR);
      DECLARE @VERID int = SCOPE_IDENTITY();

      INSERT INTO AUDITDOCS (AUDID, VERID, FILECODE)
      SELECT DISTINCT @AUDID, @VERID, [value] FROM OPENJSON(@FILECODES);

      INSERT INTO AUDITEVTS (AUDID, VERID, EVTTYP, EVTUSR, COMMENT)
      VALUES (@AUDID, @VERID, 'CREATED', @USR, @COMMENT);

      SELECT @AUDID AS AUDID, @VERID AS VERID;
    `),
    inputs: {
      CAVEID: { type: sql.Int, value: CAVEID },
      TITLE: nvarchar(150, TITLE),
      DATEXP: date(DATEXP),
      COMMENT: nvarchar(1000, COMMENT),
      FILECODES: json(FILECODES),
      USR: nvarchar(100, USR),
    },
  });
  return result.recordset[0];
}

/**
 * Nouvelle version (modification par la Qualité) : ne touche JAMAIS la
 * version précédente. Les documents reconduits (KEEP_FILECODES) doivent
 * appartenir à la version courante ; ils sont re-rattachés à la nouvelle.
 */
export async function createVersion({ AUDID, DATEXP, COMMENT, KEEP_FILECODES, NEW_FILECODES, USR }) {
  const result = await run({
    query: tx(`
      ${LOCK_ACTIVE_AUDIT}

      DECLARE @CURVERID int, @CURVERNUM int;
      SELECT TOP 1 @CURVERID = VERID, @CURVERNUM = VERNUM
      FROM AUDITVERS WHERE AUDID = @AUDID ORDER BY VERNUM DESC;

      IF EXISTS (
        SELECT 1 FROM OPENJSON(@KEEP) K
        WHERE NOT EXISTS (
          SELECT 1 FROM AUDITDOCS D WHERE D.VERID = @CURVERID AND D.FILECODE = K.[value]
        )
      )
        THROW 50112, 'Un document reconduit n''appartient pas à la version courante de l''audit.', 1;

      IF NOT EXISTS (SELECT 1 FROM OPENJSON(@KEEP)) AND NOT EXISTS (SELECT 1 FROM OPENJSON(@NEW))
        THROW 50116, 'Au moins un document est requis.', 1;

      INSERT INTO AUDITVERS (AUDID, VERNUM, DATEXP, COMMENT, CREUSR)
      VALUES (@AUDID, @CURVERNUM + 1, @DATEXP, @COMMENT, @USR);
      DECLARE @VERID int = SCOPE_IDENTITY();

      INSERT INTO AUDITDOCS (AUDID, VERID, FILECODE)
      SELECT @AUDID, @VERID, F.FILECODE FROM (
        SELECT [value] AS FILECODE FROM OPENJSON(@KEEP)
        UNION
        SELECT [value] FROM OPENJSON(@NEW)
      ) F;

      INSERT INTO AUDITEVTS (AUDID, VERID, EVTTYP, EVTUSR, COMMENT)
      VALUES (@AUDID, @VERID, 'VERSIONED', @USR, @COMMENT);

      SELECT @VERID AS VERID, @CURVERNUM + 1 AS VERNUM;
    `),
    inputs: {
      AUDID: { type: sql.Int, value: AUDID },
      DATEXP: date(DATEXP),
      COMMENT: nvarchar(1000, COMMENT),
      KEEP: json(KEEP_FILECODES),
      NEW: json(NEW_FILECODES),
      USR: nvarchar(100, USR),
    },
  });
  return result.recordset[0];
}

/**
 * Retour de la cave sur la version VERID. Refusé si VERID n'est plus la
 * version courante (la cave doit repartir des nouveaux documents), si un
 * retour est déjà en attente de revue, ou si l'audit est déjà validé.
 */
export async function createReturn({ AUDID, VERID, COMMENT, FILECODES, USR }) {
  const result = await run({
    query: tx(`
      ${LOCK_ACTIVE_AUDIT}

      DECLARE @CURVERID int;
      SELECT TOP 1 @CURVERID = VERID FROM AUDITVERS WHERE AUDID = @AUDID ORDER BY VERNUM DESC;
      IF @CURVERID <> @VERID
        THROW 50113, 'Les documents de cet audit ont été mis à jour par le service Qualité entre-temps. Téléchargez la nouvelle version avant de redéposer.', 1;

      DECLARE @LASTSTATUS varchar(20), @LASTNUM int;
      SELECT TOP 1 @LASTSTATUS = STATUS, @LASTNUM = RETNUM
      FROM AUDITRETS WHERE VERID = @VERID ORDER BY RETNUM DESC;
      IF @LASTSTATUS IN ('SUBMITTED', 'VALID')
        THROW 50114, 'Un retour est déjà en attente de revue ou validé pour cet audit.', 1;

      IF NOT EXISTS (SELECT 1 FROM OPENJSON(@FILECODES))
        THROW 50116, 'Au moins un document est requis.', 1;

      INSERT INTO AUDITRETS (VERID, RETNUM, COMMENT, CREUSR)
      VALUES (@VERID, ISNULL(@LASTNUM, 0) + 1, @COMMENT, @USR);
      DECLARE @RETID int = SCOPE_IDENTITY();

      INSERT INTO AUDITDOCS (AUDID, RETID, FILECODE)
      SELECT DISTINCT @AUDID, @RETID, [value] FROM OPENJSON(@FILECODES);

      INSERT INTO AUDITEVTS (AUDID, VERID, RETID, EVTTYP, EVTUSR, COMMENT)
      VALUES (@AUDID, @VERID, @RETID, 'SUBMITTED', @USR, @COMMENT);

      SELECT @RETID AS RETID;
    `),
    inputs: {
      AUDID: { type: sql.Int, value: AUDID },
      VERID: { type: sql.Int, value: VERID },
      COMMENT: nvarchar(1000, COMMENT),
      FILECODES: json(FILECODES),
      USR: nvarchar(100, USR),
    },
  });
  return result.recordset[0];
}

/** Validation / refus du DERNIER retour de la version courante (une seule fois). */
export async function reviewReturn({ AUDID, RETID, DECISION, COMMENT, USR }) {
  await run({
    query: tx(`
      ${LOCK_ACTIVE_AUDIT}

      DECLARE @CURVERID int;
      SELECT TOP 1 @CURVERID = VERID FROM AUDITVERS WHERE AUDID = @AUDID ORDER BY VERNUM DESC;

      DECLARE @LASTRETID int;
      SELECT TOP 1 @LASTRETID = RETID FROM AUDITRETS WHERE VERID = @CURVERID ORDER BY RETNUM DESC;

      IF @LASTRETID IS NULL OR @LASTRETID <> @RETID
        THROW 50115, 'Seul le dernier retour de la version courante peut être revu.', 1;

      -- Contrôle AVANT l'UPDATE (et non via @@ROWCOUNT, que le trigger
      -- TR_AUDITRETS_IMMUTABLE rendrait peu fiable) ; l'unicité est garantie
      -- par le verrou pris sur la ligne AUDITS (LOCK_ACTIVE_AUDIT).
      IF NOT EXISTS (SELECT 1 FROM AUDITRETS WHERE RETID = @RETID AND STATUS = 'SUBMITTED')
        THROW 50115, 'Ce retour a déjà été revu.', 1;

      UPDATE AUDITRETS
      SET STATUS = @DECISION, REVUSR = @USR, REVDAT = SYSUTCDATETIME(), REVCOM = @COMMENT
      WHERE RETID = @RETID;

      INSERT INTO AUDITEVTS (AUDID, VERID, RETID, EVTTYP, EVTUSR, COMMENT)
      VALUES (@AUDID, @CURVERID, @RETID,
              CASE WHEN @DECISION = 'VALID' THEN 'VALIDATED' ELSE 'REJECTED' END,
              @USR, @COMMENT);
    `),
    inputs: {
      AUDID: { type: sql.Int, value: AUDID },
      RETID: { type: sql.Int, value: RETID },
      DECISION: { type: sql.VarChar(20), value: DECISION },
      COMMENT: nvarchar(1000, COMMENT),
      USR: nvarchar(100, USR),
    },
  });
}

/** Suppression LOGIQUE (l'historique reste intégralement consultable). */
export async function deleteAudit({ AUDID, COMMENT, USR }) {
  await run({
    query: tx(`
      ${LOCK_ACTIVE_AUDIT}

      UPDATE AUDITS
      SET ISDEL = 1, DELUSR = @USR, DELDAT = SYSUTCDATETIME(), DELCOM = @COMMENT
      WHERE AUDID = @AUDID;

      INSERT INTO AUDITEVTS (AUDID, EVTTYP, EVTUSR, COMMENT)
      VALUES (@AUDID, 'DELETED', @USR, @COMMENT);
    `),
    inputs: {
      AUDID: { type: sql.Int, value: AUDID },
      COMMENT: nvarchar(1000, COMMENT),
      USR: nvarchar(100, USR),
    },
  });
}
