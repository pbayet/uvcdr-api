import sql from "mssql";
import { runQuery } from "../../core/utils/db.utils.js";
import { SQL_NOW_PARIS, SQL_TODAY_PARIS, SQL_WORKDAY, EDITABLE_FIELDS } from "./utils.js";

/* ═══════════════════════════════════════════════════════════════
   DCKMNG — Services
   Tables (cf. sql/DCKMNG.tables.sql) :
     DCKLOADS, DCKLOADCHANGES, DCKSTATUSES
   Cross-base :
     USERSMANAGER.dbo.USERS  (nom de l'admin qui a créé / modifié)

   Les dates sont renvoyées en texte (heure de Paris, sans fuseau) pour
   éviter toute conversion UTC par le pilote mssql :
     LODDAT "AAAA-MM-JJ", LODHOU "HH:MM", *DAT "AAAA-MM-JJTHH:MM:SS".
═══════════════════════════════════════════════════════════════ */

const USER_NAME = (alias) =>
  `NULLIF(LTRIM(RTRIM(CONCAT(${alias}.FSTNAM, ' ', ${alias}.LSTNAM))), '')`;

const SELECT_LOADS = `
SELECT
  l.LODID,
  CONVERT(CHAR(10), l.LODDAT, 23)  AS LODDAT,
  CONVERT(CHAR(5),  l.LODHOU, 108) AS LODHOU,
  l.NOM, l.QUAI, l.QUAEFF, l.OPEDEB, l.OPEFIN,
  l.STSCOD, s.NAME AS STSNAME, s.LVL AS STSLVL,
  CONVERT(VARCHAR(19), l.DEBDAT, 126) AS DEBDAT,
  CONVERT(VARCHAR(19), l.FINDAT, 126) AS FINDAT,
  CONVERT(VARCHAR(19), l.CREDAT, 126) AS CREDAT,
  CONVERT(VARCHAR(19), l.UPDDAT, 126) AS UPDDAT,
  l.CREUSR, ${USER_NAME("u")} AS CRENAM
FROM dbo.DCKLOADS AS l
LEFT JOIN dbo.DCKSTATUSES AS s ON s.STSCOD = l.STSCOD
LEFT JOIN USERSMANAGER.dbo.USERS AS u ON u.USRID = l.CREUSR
`;

const ORDER_LOADS = "ORDER BY l.LODHOU, l.LODID";

/** Paramètres de traçabilité communs (source, utilisateur, IP). */
function traceInputs({ SOURCE, USRID, IPADDR }) {
  return {
    SOURCE: { type: sql.VarChar(10), value: SOURCE },
    USRID: { type: sql.Int, value: USRID ?? null },
    IPADDR: { type: sql.VarChar(45), value: IPADDR ?? null },
  };
}

/* -------------------------------------------------------------------------- */
/*                                 RÉFÉRENTIELS                               */
/* -------------------------------------------------------------------------- */

export async function getStatuses() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: "SELECT STSCOD, NAME, LVL, COLOR FROM dbo.DCKSTATUSES ORDER BY LVL",
  });
  return result.recordset;
}

/** Date du jour à Paris, vue par SQL Server (AAAA-MM-JJ). */
export async function getToday() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT CONVERT(CHAR(10), ${SQL_TODAY_PARIS}, 23) AS TODAY`,
  });
  return result.recordset[0].TODAY;
}

/* -------------------------------------------------------------------------- */
/*                                 CHARGEMENTS                                */
/* -------------------------------------------------------------------------- */

/**
 * Chargements (non supprimés) d'un jour — aujourd'hui si `LODDAT` est absent.
 * Renvoie { LODDAT, TODAY, rows }.
 */
export async function getLoads({ LODDAT } = {}) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      DECLARE @TODAY DATE = ${SQL_TODAY_PARIS};
      DECLARE @DAY DATE = ISNULL(TRY_CAST(@LODDAT AS DATE), @TODAY);

      SELECT CONVERT(CHAR(10), @DAY, 23) AS LODDAT, CONVERT(CHAR(10), @TODAY, 23) AS TODAY;

      ${SELECT_LOADS}
      WHERE l.LODDAT = @DAY AND l.DLTD = 0
      ${ORDER_LOADS};
    `,
    inputs: { LODDAT: { type: sql.VarChar(10), value: LODDAT ?? null } },
  });
  const [[head], rows] = result.recordsets;
  return { LODDAT: head.LODDAT, TODAY: head.TODAY, rows };
}

/** Un chargement (supprimé compris, cf. `includeDeleted`) ou null. */
export async function getLoad(LODID, { includeDeleted = false } = {}) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      ${SELECT_LOADS}
      WHERE l.LODID = @LODID ${includeDeleted ? "" : "AND l.DLTD = 0"};
      SELECT CASE WHEN l.LODDAT = ${SQL_TODAY_PARIS} THEN 1 ELSE 0 END AS ISTODAY
      FROM dbo.DCKLOADS AS l WHERE l.LODID = @LODID;
    `,
    inputs: { LODID: { type: sql.Int, value: LODID } },
  });
  const [rows, flags] = result.recordsets;
  if (!rows[0]) return null;
  return { ...rows[0], ISTODAY: !!flags[0]?.ISTODAY };
}

/** Création d'un chargement pour aujourd'hui (heure d'ajout = maintenant). */
export async function createLoad({ NOM, QUAI }, trace) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SET XACT_ABORT ON;
      BEGIN TRAN;

      DECLARE @NOW DATETIME2(0) = ${SQL_NOW_PARIS};
      DECLARE @ids TABLE (LODID INT);

      INSERT INTO dbo.DCKLOADS (LODDAT, LODHOU, NOM, QUAI, CREDAT, CREUSR)
      OUTPUT INSERTED.LODID INTO @ids
      VALUES (${SQL_WORKDAY("@NOW")}, CAST(@NOW AS TIME(0)), @NOM, @QUAI, @NOW, @USRID);

      DECLARE @LODID INT = (SELECT TOP 1 LODID FROM @ids);

      INSERT INTO dbo.DCKLOADCHANGES (LODID, ACTION, FIELD, OLDVAL, NEWVAL, SOURCE, USRID, IPADDR, CREDAT)
      VALUES (@LODID, 'CREATE', NULL, NULL, @NOM, @SOURCE, @USRID, @IPADDR, @NOW);

      COMMIT;

      SELECT @LODID AS LODID;
    `,
    inputs: {
      NOM: { type: sql.NVarChar(200), value: NOM },
      QUAI: { type: sql.NVarChar(10), value: QUAI ?? null },
      ...traceInputs(trace),
    },
  });
  return result.recordset[0].LODID;
}

/**
 * Mise à jour partielle d'un chargement : seuls les champs transmis (≠
 * undefined) et autorisés pour la source sont modifiés. Les horodatages de
 * prise en charge (DEBDAT) et de fin (FINDAT) suivent le statut calculé, et
 * chaque valeur réellement modifiée est historisée.
 *
 * `onlyToday` : refuse (renvoie "LOCKED") un chargement d'un autre jour.
 * Renvoie "UPDATED" | "NOT_FOUND" | "LOCKED".
 */
export async function updateLoad(LODID, fields, trace, { onlyToday = false } = {}) {
  const allowed = EDITABLE_FIELDS[trace.SOURCE] ?? [];
  const changes = allowed.filter((f) => fields[f] !== undefined);
  if (!changes.length) return "UPDATED";

  // Colonnes issues de la liste blanche EDITABLE_FIELDS : jamais du client.
  const setClause = changes.map((f) => `${f} = @${f}`).join(", ");
  const inputs = {
    LODID: { type: sql.Int, value: LODID },
    ...traceInputs(trace),
  };
  for (const f of changes) {
    inputs[f] = { type: sql.NVarChar(f === "NOM" ? 200 : 50), value: fields[f] };
  }

  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SET XACT_ABORT ON;

      DECLARE @NOW DATETIME2(0) = ${SQL_NOW_PARIS};

      IF NOT EXISTS (SELECT 1 FROM dbo.DCKLOADS WHERE LODID = @LODID AND DLTD = 0)
      BEGIN
        SELECT 'NOT_FOUND' AS RESULT;
        RETURN;
      END

      ${
        onlyToday
          ? `IF NOT EXISTS (SELECT 1 FROM dbo.DCKLOADS WHERE LODID = @LODID AND LODDAT = ${SQL_WORKDAY("@NOW")})
      BEGIN
        SELECT 'LOCKED' AS RESULT;
        RETURN;
      END`
          : ""
      }

      BEGIN TRAN;

      DECLARE @old TABLE (
        NOM NVARCHAR(200), QUAI NVARCHAR(10), QUAEFF NVARCHAR(10), OPEDEB NVARCHAR(50), OPEFIN NVARCHAR(50)
      );

      UPDATE dbo.DCKLOADS
      SET ${setClause},
          UPDDAT = @NOW,
          UPDUSR = @USRID
      OUTPUT DELETED.NOM, DELETED.QUAI, DELETED.QUAEFF, DELETED.OPEDEB, DELETED.OPEFIN INTO @old
      WHERE LODID = @LODID;

      -- Horodatages d'avancement, d'après le statut recalculé.
      UPDATE dbo.DCKLOADS
      SET DEBDAT = CASE WHEN STSCOD = 'ATTENTE' THEN NULL ELSE ISNULL(DEBDAT, @NOW) END,
          FINDAT = CASE WHEN STSCOD = 'TERMINE' THEN ISNULL(FINDAT, @NOW) ELSE NULL END
      WHERE LODID = @LODID;

      INSERT INTO dbo.DCKLOADCHANGES (LODID, ACTION, FIELD, OLDVAL, NEWVAL, SOURCE, USRID, IPADDR, CREDAT)
      SELECT @LODID, 'UPDATE', v.FIELD, v.OLDVAL, v.NEWVAL, @SOURCE, @USRID, @IPADDR, @NOW
      FROM @old AS o
      CROSS JOIN dbo.DCKLOADS AS l
      CROSS APPLY (VALUES
        ('NOM',    o.NOM,    l.NOM),
        ('QUAI',   o.QUAI,   l.QUAI),
        ('QUAEFF', o.QUAEFF, l.QUAEFF),
        ('OPEDEB', o.OPEDEB, l.OPEDEB),
        ('OPEFIN', o.OPEFIN, l.OPEFIN)
      ) AS v (FIELD, OLDVAL, NEWVAL)
      WHERE l.LODID = @LODID
        AND ISNULL(v.OLDVAL, N'') <> ISNULL(v.NEWVAL, N'');

      COMMIT;

      SELECT 'UPDATED' AS RESULT;
    `,
    inputs,
  });
  return result.recordset?.[0]?.RESULT ?? "UPDATED";
}

/** Suppression logique. Renvoie true si une ligne a été supprimée. */
export async function deleteLoad(LODID, trace) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SET XACT_ABORT ON;
      BEGIN TRAN;

      DECLARE @NOW DATETIME2(0) = ${SQL_NOW_PARIS};

      UPDATE dbo.DCKLOADS
      SET DLTD = 1, DLTDAT = @NOW, DLTUSR = @USRID
      WHERE LODID = @LODID AND DLTD = 0;

      DECLARE @n INT = @@ROWCOUNT;

      IF @n > 0
        INSERT INTO dbo.DCKLOADCHANGES (LODID, ACTION, SOURCE, USRID, IPADDR, CREDAT)
        VALUES (@LODID, 'DELETE', @SOURCE, @USRID, @IPADDR, @NOW);

      COMMIT;

      SELECT @n AS DELETED;
    `,
    inputs: {
      LODID: { type: sql.Int, value: LODID },
      ...traceInputs(trace),
    },
  });
  return result.recordset[0].DELETED > 0;
}

/** Historique d'un chargement (du plus récent au plus ancien). */
export async function getChanges(LODID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SELECT c.CHGID, c.LODID, c.ACTION, c.FIELD, c.OLDVAL, c.NEWVAL, c.SOURCE,
             c.USRID, ${USER_NAME("u")} AS USRNAM, c.IPADDR,
             CONVERT(VARCHAR(19), c.CREDAT, 126) AS CREDAT
      FROM dbo.DCKLOADCHANGES AS c
      LEFT JOIN USERSMANAGER.dbo.USERS AS u ON u.USRID = c.USRID
      WHERE c.LODID = @LODID
      ORDER BY c.CHGID DESC;
    `,
    inputs: { LODID: { type: sql.Int, value: LODID } },
  });
  return result.recordset;
}

/**
 * Jours ayant au moins un chargement (non supprimé), du plus ancien au plus
 * récent, en "AAAA-MM-JJ". Sert au calendrier de l'espace admin.
 */
export async function getLoadDays() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SELECT DISTINCT CONVERT(CHAR(10), LODDAT, 23) AS LODDAT
      FROM dbo.DCKLOADS
      WHERE DLTD = 0
      ORDER BY LODDAT;
    `,
  });
  return result.recordset.map((r) => r.LODDAT);
}

/* -------------------------------------------------------------------------- */
/*                                 STATISTIQUES                               */
/* -------------------------------------------------------------------------- */

/**
 * Statistiques sur [FROM, TO] (7 derniers jours par défaut).
 * Les durées moyennes n'utilisent que les chargements créés dans la
 * nouvelle application (les imports JSON n'ont pas d'horodatage d'avancement).
 */
export async function getStats({ FROM, TO }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      DECLARE @TODAY DATE = ${SQL_TODAY_PARIS};
      DECLARE @TO DATE = ISNULL(TRY_CAST(@PTO AS DATE), @TODAY);
      DECLARE @FROM DATE = ISNULL(TRY_CAST(@PFROM AS DATE), DATEADD(DAY, -6, @TO));

      -- 0. Plage effective
      SELECT CONVERT(CHAR(10), @FROM, 23) AS [FROM], CONVERT(CHAR(10), @TO, 23) AS [TO];

      -- 1. Totaux toutes périodes
      SELECT COUNT(*) AS TOTALALL,
             ISNULL(SUM(CASE WHEN STSCOD = 'TERMINE' THEN 1 ELSE 0 END), 0) AS TOTALDONE
      FROM dbo.DCKLOADS WHERE DLTD = 0;

      -- 2. Totaux et durées sur la plage
      SELECT COUNT(*) AS TOTAL,
             ISNULL(SUM(CASE WHEN STSCOD = 'TERMINE'  THEN 1 ELSE 0 END), 0) AS DONE,
             ISNULL(SUM(CASE WHEN STSCOD = 'EN_COURS' THEN 1 ELSE 0 END), 0) AS INPROGRESS,
             ISNULL(SUM(CASE WHEN STSCOD = 'ATTENTE'  THEN 1 ELSE 0 END), 0) AS WAITING,
             AVG(CASE WHEN DEBDAT IS NOT NULL AND LEGACYID IS NULL
                      THEN CAST(DATEDIFF(SECOND, CREDAT, DEBDAT) AS FLOAT) / 60 END) AS AVGWAITMIN,
             AVG(CASE WHEN FINDAT IS NOT NULL AND DEBDAT IS NOT NULL AND LEGACYID IS NULL
                      THEN CAST(DATEDIFF(SECOND, DEBDAT, FINDAT) AS FLOAT) / 60 END) AS AVGLOADMIN
      FROM dbo.DCKLOADS
      WHERE DLTD = 0 AND LODDAT BETWEEN @FROM AND @TO;

      -- 3. Par jour
      SELECT CONVERT(CHAR(10), LODDAT, 23) AS [DATE],
             COUNT(*) AS TOTAL,
             SUM(CASE WHEN STSCOD = 'TERMINE'  THEN 1 ELSE 0 END) AS DONE,
             SUM(CASE WHEN STSCOD = 'EN_COURS' THEN 1 ELSE 0 END) AS INPROGRESS,
             SUM(CASE WHEN STSCOD = 'ATTENTE'  THEN 1 ELSE 0 END) AS WAITING
      FROM dbo.DCKLOADS
      WHERE DLTD = 0 AND LODDAT BETWEEN @FROM AND @TO
      GROUP BY LODDAT;

      -- 4. Par quai prévu ("03" et "3" regroupés)
      SELECT q.QUAI, COUNT(*) AS TOTAL
      FROM dbo.DCKLOADS AS l
      CROSS APPLY (SELECT COALESCE(
        CAST(TRY_CAST(l.QUAI AS INT) AS NVARCHAR(10)),
        NULLIF(LTRIM(RTRIM(l.QUAI)), N''),
        N'—') AS QUAI) AS q
      WHERE l.DLTD = 0 AND l.LODDAT BETWEEN @FROM AND @TO
      GROUP BY q.QUAI
      ORDER BY TOTAL DESC, q.QUAI;

      -- 5. Par heure d'ajout
      SELECT DATEPART(HOUR, LODHOU) AS [HOUR], COUNT(*) AS TOTAL
      FROM dbo.DCKLOADS
      WHERE DLTD = 0 AND LODDAT BETWEEN @FROM AND @TO
      GROUP BY DATEPART(HOUR, LODHOU)
      ORDER BY [HOUR];

      -- 6. Par opérateur (début ou fin)
      SELECT o.OPERATOR, COUNT(DISTINCT l.LODID) AS TOTAL
      FROM dbo.DCKLOADS AS l
      CROSS APPLY (VALUES
        (UPPER(NULLIF(LTRIM(RTRIM(l.OPEDEB)), N''))),
        (UPPER(NULLIF(LTRIM(RTRIM(l.OPEFIN)), N'')))
      ) AS o (OPERATOR)
      WHERE l.DLTD = 0 AND l.LODDAT BETWEEN @FROM AND @TO AND o.OPERATOR IS NOT NULL
      GROUP BY o.OPERATOR
      ORDER BY TOTAL DESC, o.OPERATOR;
    `,
    inputs: {
      PFROM: { type: sql.VarChar(10), value: FROM ?? null },
      PTO: { type: sql.VarChar(10), value: TO ?? null },
    },
  });

  const [range, totalsAll, totals, byDay, byQuai, byHour, byOperator] = result.recordsets;
  return {
    range: range[0],
    totalsAll: totalsAll[0],
    totals: totals[0],
    byDay,
    byQuai,
    byHour,
    byOperator,
  };
}
