import sql from "mssql";
import { runQuery } from "../../core/utils/db.utils.js";

/* ═══════════════════════════════════════════════════════════════
   PROCS — Services (Procédures UVCDR)
   Tables (cf. sql/PROCS.tables.sql) :
     PROCCATEGORIES, PROCEDURES, PROCKEYWORDS, PROCVERSIONS,
     PROCHISTORY, PROCCONSULTS, PROCACKS
   Cross-base :
     USERSMANAGER.dbo.USERS             (noms des auteurs / lecteurs)
     APPATTACHMENTS (connexion "attachments") : fichiers déposés

   Visibilité (cf. `VISIBILITY`) :
     - rédacteur (ISEDITOR) : toutes les fiches (brouillons, archivées et,
       sur demande, supprimées) ;
     - lecteur : fiches publiées non supprimées ayant une version courante,
       dont la catégorie et ses parents sont actifs (CATEGORY_CHAIN_ACTIVE).

   Recherche : chaque terme (accents et casse ignorés, French_CI_AI) doit
   apparaître dans au moins un des champs : référence, titre, résumé,
   responsable, catégorie, mots-clés ou TEXTE DU DOCUMENT (version
   courante, PROCVERSIONS.CONTENTTEXT). Classement par pertinence (titre >
   référence > mots-clés > résumé > catégorie > contenu), extrait du texte
   autour de la première occurrence trouvée.
═══════════════════════════════════════════════════════════════ */

const USER_NAME = (alias) =>
  `NULLIF(LTRIM(RTRIM(CONCAT(${alias}.FSTNAM, ' ', ${alias}.LSTNAM))), '')`;

/** Longueur de l'extrait renvoyé autour d'une occurrence trouvée. */
const SNIPPET_BEFORE = 90;
const SNIPPET_LENGTH = 280;

const CI = "COLLATE French_CI_AI";

/* -------------------------------------------------------------------------- */
/*                                 RECHERCHE                                  */
/* -------------------------------------------------------------------------- */

/** Échappe les caractères spéciaux de LIKE ([ % _). */
function escapeLike(term) {
  return term.replace(/[[%_]/g, (c) => `[${c}]`);
}

/**
 * Découpe la saisie en termes (8 au plus, 2 caractères minimum, doublons
 * retirés). Les expressions entre guillemets restent groupées :
 * `"bon de livraison" palette` → ["bon de livraison", "palette"].
 */
export function parseSearchTerms(search) {
  const raw = String(search ?? "").trim();
  if (!raw) return [];

  const terms = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const t = (m[1] ?? m[2]).trim().slice(0, 100);
    if (t.length >= 2) terms.push(t);
  }

  const seen = new Set();
  return terms
    .filter((t) => {
      const k = t.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 8)
    .map((t) => ({ raw: t, like: `%${escapeLike(t)}%` }));
}

/** Un terme (alias `t`, OPENJSON) correspond-il au champ `expr` ? */
const MATCH = (expr) => `(${expr} ${CI} LIKE t.LIKEPAT ${CI})`;

const KEYWORD_MATCH = `EXISTS (
  SELECT 1 FROM dbo.PROCKEYWORDS AS kw
  WHERE kw.PRCID = p.PRCID AND ${MATCH("kw.KEYWORD")}
)`;

const TERMS_TABLE = `OPENJSON(@TERMS) WITH (RAWTERM NVARCHAR(100) '$.raw', LIKEPAT NVARCHAR(400) '$.like') AS t`;

/* -------------------------------------------------------------------------- */
/*                                 PROCÉDURES                                 */
/* -------------------------------------------------------------------------- */

/**
 * La catégorie de la fiche (alias c) et ses parents (pc, gpc) sont tous
 * actifs — vrai aussi pour une fiche sans catégorie.
 */
const CATEGORY_CHAIN_ACTIVE = `(ISNULL(c.ACTIVE, 1) = 1 AND ISNULL(pc.ACTIVE, 1) = 1 AND ISNULL(gpc.ACTIVE, 1) = 1)`;

const SELECT_PROCEDURE_COLUMNS = `
  p.PRCID, p.REFCODE, p.TITLE, p.SUMMARY, p.OWNER, p.STATUS, p.REVIEWDAT,
  p.PUBDAT, p.DLTD, p.CREDAT, p.UPDDAT, p.CREUSR, p.UPDUSR,
  ${USER_NAME("uc")} AS CREUSRNAM, ${USER_NAME("uu")} AS UPDUSRNAM,
  p.CATID, c.NAME AS CATNAME,
  -- Couleur et icône : celles de la catégorie, sinon héritées de ses parents.
  COALESCE(c.COLOR, pc.COLOR, gpc.COLOR) AS CATCOLOR, COALESCE(c.ICON, pc.ICON, gpc.ICON) AS CATICON,
  c.PARENTID AS CATPARENTID, pc.NAME AS CATPARENTNAME,
  pc.PARENTID AS CATGPID, gpc.NAME AS CATGPNAME,
  -- Catégorie désactivée (elle-même ou un de ses parents) : fiche masquée aux lecteurs.
  CASE WHEN ${CATEGORY_CHAIN_ACTIVE} THEN 1 ELSE 0 END AS CATACTIVE,
  CASE WHEN c.ACTIVE = 0 THEN c.NAME WHEN pc.ACTIVE = 0 THEN pc.NAME WHEN gpc.ACTIVE = 0 THEN gpc.NAME END AS CATINACTIVENAME,
  p.CURVERID, v.VERNUM, v.ORIGINALNAME, v.EXTENSION, v.MIMETYPE, v.SIZEBYTES,
  v.TEXTSTATUS, v.PAGES, v.CREDAT AS VERDAT, v.COMMENT AS VERCOMMENT,
  CASE WHEN v.PREVIEWCODE IS NOT NULL THEN 1 ELSE 0 END AS HASPREVIEW,
  (SELECT STRING_AGG(k.KEYWORD, '|') FROM dbo.PROCKEYWORDS AS k WHERE k.PRCID = p.PRCID) AS KEYWORDS,
  (SELECT COUNT(*) FROM dbo.PROCVERSIONS AS vv WHERE vv.PRCID = p.PRCID) AS VERSIONCOUNT,
  CASE WHEN EXISTS (
    SELECT 1 FROM dbo.PROCACKS AS a WHERE a.VERID = p.CURVERID AND a.USRID = @USRID
  ) THEN 1 ELSE 0 END AS ACKED,
  (SELECT MAX(cs.CREDAT) FROM dbo.PROCCONSULTS AS cs
     WHERE cs.PRCID = p.PRCID AND cs.USRID = @USRID) AS MYLASTVIEW
`;

const FROM_PROCEDURES = `
FROM dbo.PROCEDURES AS p
LEFT JOIN dbo.PROCVERSIONS AS v ON v.VERID = p.CURVERID
LEFT JOIN dbo.PROCCATEGORIES AS c ON c.CATID = p.CATID
LEFT JOIN dbo.PROCCATEGORIES AS pc ON pc.CATID = c.PARENTID
LEFT JOIN dbo.PROCCATEGORIES AS gpc ON gpc.CATID = pc.PARENTID
LEFT JOIN USERSMANAGER.dbo.USERS AS uc ON uc.USRID = p.CREUSR
LEFT JOIN USERSMANAGER.dbo.USERS AS uu ON uu.USRID = p.UPDUSR
`;

/** Clause de visibilité commune (cf. en-tête). */
const VISIBILITY = `
  (
    (@ISEDITOR = 1 AND p.DLTD = @DLTD)
    OR (@ISEDITOR = 0 AND p.DLTD = 0 AND p.STATUS = 'PUBLISHED' AND p.CURVERID IS NOT NULL
        AND ${CATEGORY_CHAIN_ACTIVE})
  )
`;

function ctxInputs({ USRID, ISEDITOR }, DLTD = false) {
  return {
    USRID: { type: sql.Int, value: USRID },
    ISEDITOR: { type: sql.Bit, value: ISEDITOR ? 1 : 0 },
    DLTD: { type: sql.Bit, value: DLTD ? 1 : 0 },
  };
}

/**
 * Liste / recherche des procédures.
 * @param {{USRID:number, ISEDITOR:boolean}} ctx
 * @param {{SEARCH?:string, CATID?:number, STATUS?:string, OVERDUE?:boolean, DLTD?:boolean}} filters
 */
export async function listProcedures(ctx, filters = {}) {
  const terms = parseSearchTerms(filters.SEARCH);
  const hasTerms = terms.length > 0;

  const query = `
  SELECT TOP 1000
    ${SELECT_PROCEDURE_COLUMNS},
    ${
      hasTerms
        ? `sc.SCORE, sn.SNIPPET, sn.SNIPPETCUT, sn.MATCHINCONTENT`
        : `CAST(0 AS INT) AS SCORE, CAST(NULL AS NVARCHAR(400)) AS SNIPPET,
           CAST(0 AS BIT) AS SNIPPETCUT, CAST(0 AS BIT) AS MATCHINCONTENT`
    }
  ${FROM_PROCEDURES}
  ${
    hasTerms
      ? `
  OUTER APPLY (
    -- SQL Server refuse SUM() sur une expression contenant une sous-requête
    -- (mots-clés) : le score de chaque terme est calculé à part (ts).
    SELECT SUM(ts.S) AS SCORE
    FROM ${TERMS_TABLE}
    CROSS APPLY (SELECT
        CASE WHEN ${MATCH("p.TITLE")} THEN 100 ELSE 0 END
      + CASE WHEN ${MATCH("ISNULL(p.REFCODE, N'')")} THEN 80 ELSE 0 END
      + CASE WHEN ${KEYWORD_MATCH} THEN 60 ELSE 0 END
      + CASE WHEN ${MATCH("ISNULL(p.SUMMARY, N'')")} THEN 30 ELSE 0 END
      + CASE WHEN ${MATCH("ISNULL(c.NAME, N'')")} OR ${MATCH("ISNULL(pc.NAME, N'')")} OR ${MATCH("ISNULL(gpc.NAME, N'')")} THEN 20 ELSE 0 END
      + CASE WHEN ${MATCH("ISNULL(p.OWNER, N'')")} THEN 15 ELSE 0 END
      + CASE WHEN ${MATCH("ISNULL(v.CONTENTTEXT, N'')")} THEN 10 ELSE 0 END
      AS S
    ) AS ts
  ) AS sc
  OUTER APPLY (
    SELECT TOP 1
      CASE WHEN pos.POS > ${SNIPPET_BEFORE} THEN 1 ELSE 0 END AS SNIPPETCUT,
      CAST(1 AS BIT) AS MATCHINCONTENT,
      SUBSTRING(
        v.CONTENTTEXT,
        CASE WHEN pos.POS > ${SNIPPET_BEFORE} THEN pos.POS - ${SNIPPET_BEFORE} ELSE 1 END,
        ${SNIPPET_LENGTH}
      ) AS SNIPPET
    FROM ${TERMS_TABLE}
    CROSS APPLY (
      SELECT CHARINDEX(t.RAWTERM ${CI}, v.CONTENTTEXT ${CI}) AS POS
    ) AS pos
    WHERE v.CONTENTTEXT IS NOT NULL AND pos.POS > 0
    ORDER BY pos.POS
  ) AS sn`
      : ""
  }
  WHERE ${VISIBILITY}
    -- Catégorie : la procédure y est rangée directement, ou (sauf @DIRECT)
    -- dans une sous-catégorie ou sous-sous-catégorie (3 niveaux au plus).
    AND (@CATID IS NULL OR p.CATID = @CATID
         OR (@DIRECT = 0 AND (c.PARENTID = @CATID OR pc.PARENTID = @CATID)))
    AND (@STATUS IS NULL OR p.STATUS = @STATUS)
    AND (@OVERDUE = 0 OR (p.REVIEWDAT IS NOT NULL AND p.REVIEWDAT < CAST(GETDATE() AS DATE)))
    ${
      hasTerms
        ? `AND NOT EXISTS (
      SELECT 1 FROM ${TERMS_TABLE}
      WHERE NOT (
           ${MATCH("p.TITLE")}
        OR ${MATCH("ISNULL(p.REFCODE, N'')")}
        OR ${MATCH("ISNULL(p.SUMMARY, N'')")}
        OR ${MATCH("ISNULL(p.OWNER, N'')")}
        OR ${MATCH("ISNULL(c.NAME, N'')")}
        OR ${MATCH("ISNULL(pc.NAME, N'')")}
        OR ${MATCH("ISNULL(gpc.NAME, N'')")}
        OR ${KEYWORD_MATCH}
        OR ${MATCH("ISNULL(v.CONTENTTEXT, N'')")}
      )
    )`
        : ""
    }
  ORDER BY ${hasTerms ? "SCORE DESC," : ""} p.TITLE ${CI} ASC
  `;

  const result = await runQuery({
    moduleUrl: import.meta.url,
    query,
    inputs: {
      ...ctxInputs(ctx, filters.DLTD),
      CATID: { type: sql.Int, value: filters.CATID ?? null },
      DIRECT: { type: sql.Bit, value: filters.DIRECT ? 1 : 0 },
      STATUS: { type: sql.VarChar(20), value: ctx.ISEDITOR ? (filters.STATUS ?? null) : null },
      OVERDUE: { type: sql.Bit, value: filters.OVERDUE ? 1 : 0 },
      TERMS: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(terms) },
    },
  });

  return result.recordset;
}

/** Une procédure visible par l'utilisateur (null sinon). */
export async function getProcedure(ctx, PRCID, { includeDeleted = false } = {}) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT ${SELECT_PROCEDURE_COLUMNS}
    ${FROM_PROCEDURES}
    WHERE p.PRCID = @PRCID
      AND (
        (@ISEDITOR = 1 AND (@INCLUDEDELETED = 1 OR p.DLTD = 0))
        OR (@ISEDITOR = 0 AND p.DLTD = 0 AND p.STATUS = 'PUBLISHED' AND p.CURVERID IS NOT NULL
            AND ${CATEGORY_CHAIN_ACTIVE})
      )
    `,
    inputs: {
      ...ctxInputs(ctx),
      PRCID: { type: sql.Int, value: PRCID },
      INCLUDEDELETED: { type: sql.Bit, value: includeDeleted ? 1 : 0 },
    },
  });

  return result.recordset[0] ?? null;
}

/** Ligne brute (sans contrôle de visibilité) — contrôles d'unicité / historique. */
export async function getProcedureRow(PRCID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT * FROM dbo.PROCEDURES WHERE PRCID = @PRCID`,
    inputs: { PRCID: { type: sql.Int, value: PRCID } },
  });
  return result.recordset[0] ?? null;
}

/** La référence est-elle déjà utilisée par une autre fiche non supprimée ? */
export async function isRefcodeTaken(REFCODE, EXCLUDEPRCID = null) {
  if (!REFCODE) return false;
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT TOP 1 PRCID FROM dbo.PROCEDURES
    WHERE REFCODE = @REFCODE AND DLTD = 0
      AND (@EXCLUDE IS NULL OR PRCID <> @EXCLUDE)
    `,
    inputs: {
      REFCODE: { type: sql.NVarChar(50), value: REFCODE },
      EXCLUDE: { type: sql.Int, value: EXCLUDEPRCID },
    },
  });
  return result.recordset.length > 0;
}

/**
 * Crée la fiche (brouillon) et sa première version (sans fichier : il est
 * rattaché ensuite par `attachVersionFile`). Renvoie { PRCID, VERID }.
 */
/** Nom de la catégorie racine d'une catégorie (arborescence sur 3 niveaux). */
export async function getRootCategoryName(CATID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT COALESCE(gpc.NAME, pc.NAME, c.NAME) AS ROOTNAME
    FROM dbo.PROCCATEGORIES AS c
    LEFT JOIN dbo.PROCCATEGORIES AS pc ON pc.CATID = c.PARENTID
    LEFT JOIN dbo.PROCCATEGORIES AS gpc ON gpc.CATID = pc.PARENTID
    WHERE c.CATID = @CATID
    `,
    inputs: { CATID: { type: sql.Int, value: CATID } },
  });
  return result.recordset[0]?.ROOTNAME ?? null;
}

/**
 * Crée la fiche et sa version 1. La référence est générée dans la même
 * transaction : préfixe (`REFPREFIX`, ex. « PROC-QUA- ») + numéro suivant
 * pour ce préfixe, fiches supprimées comprises (un numéro n'est jamais
 * réattribué). Le verrou UPDLOCK / HOLDLOCK sérialise les créations
 * simultanées.
 */
export async function createProcedure(data, file, USRID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;

    DECLARE @NUM INT = 1 + ISNULL((
      SELECT MAX(CAST(SUBSTRING(REFCODE, LEN(@REFPREFIX) + 1, 10) AS INT))
      FROM dbo.PROCEDURES WITH (UPDLOCK, HOLDLOCK)
      WHERE LEFT(REFCODE, LEN(@REFPREFIX)) = @REFPREFIX
        AND LEN(REFCODE) BETWEEN LEN(@REFPREFIX) + 1 AND LEN(@REFPREFIX) + 9
        AND SUBSTRING(REFCODE, LEN(@REFPREFIX) + 1, 10) NOT LIKE '%[^0-9]%'
    ), 0);
    DECLARE @REFCODE NVARCHAR(50) =
      @REFPREFIX + CASE WHEN @NUM < 1000 THEN RIGHT('00' + CAST(@NUM AS VARCHAR(10)), 3) ELSE CAST(@NUM AS VARCHAR(10)) END;

    INSERT INTO dbo.PROCEDURES (REFCODE, TITLE, SUMMARY, CATID, OWNER, REVIEWDAT, STATUS, CREUSR, CREDAT)
    VALUES (@REFCODE, @TITLE, @SUMMARY, @CATID, @OWNER, @REVIEWDAT, 'DRAFT', @USRID, SYSDATETIME());

    DECLARE @PRCID INT = SCOPE_IDENTITY();

    INSERT INTO dbo.PROCKEYWORDS (PRCID, KEYWORD)
    SELECT DISTINCT @PRCID, LEFT(LTRIM(RTRIM([value])), 50)
    FROM OPENJSON(@KEYWORDS)
    WHERE LTRIM(RTRIM([value])) <> N'';

    INSERT INTO dbo.PROCVERSIONS (PRCID, VERNUM, COMMENT, ORIGINALNAME, EXTENSION, MIMETYPE, SIZEBYTES, TEXTSTATUS, CREUSR, CREDAT)
    VALUES (@PRCID, 1, @COMMENT, @ORIGINALNAME, @EXTENSION, @MIMETYPE, @SIZEBYTES, 'PENDING', @USRID, SYSDATETIME());

    DECLARE @VERID INT = SCOPE_IDENTITY();

    UPDATE dbo.PROCEDURES SET CURVERID = @VERID WHERE PRCID = @PRCID;

    COMMIT TRANSACTION;

    SELECT @PRCID AS PRCID, @VERID AS VERID, @REFCODE AS REFCODE;
    `,
    inputs: {
      REFPREFIX: { type: sql.NVarChar(20), value: data.REFPREFIX },
      TITLE: { type: sql.NVarChar(255), value: data.TITLE },
      SUMMARY: { type: sql.NVarChar(2000), value: data.SUMMARY ?? null },
      CATID: { type: sql.Int, value: data.CATID ?? null },
      OWNER: { type: sql.NVarChar(150), value: data.OWNER ?? null },
      REVIEWDAT: { type: sql.Date, value: data.REVIEWDAT ?? null },
      KEYWORDS: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(data.KEYWORDS ?? []) },
      COMMENT: { type: sql.NVarChar(1000), value: data.COMMENT ?? null },
      ...fileInputs(file),
      USRID: { type: sql.Int, value: USRID },
    },
  });

  return result.recordset[0];
}

function fileInputs(file) {
  return {
    ORIGINALNAME: { type: sql.NVarChar(255), value: file.ORIGINALNAME },
    EXTENSION: { type: sql.VarChar(20), value: file.EXTENSION },
    MIMETYPE: { type: sql.VarChar(150), value: file.MIMETYPE ?? null },
    SIZEBYTES: { type: sql.BigInt, value: file.SIZEBYTES ?? null },
  };
}

/** Champs modifiables d'une fiche (seuls ceux fournis sont mis à jour). */
const UPDATABLE = {
  REFCODE: sql.NVarChar(50),
  TITLE: sql.NVarChar(255),
  SUMMARY: sql.NVarChar(2000),
  CATID: sql.Int,
  OWNER: sql.NVarChar(150),
  REVIEWDAT: sql.Date,
};

export async function updateProcedure(PRCID, data, USRID) {
  const fields = Object.keys(UPDATABLE).filter((k) => data[k] !== undefined);
  const inputs = {
    PRCID: { type: sql.Int, value: PRCID },
    USRID: { type: sql.Int, value: USRID },
  };
  for (const f of fields) inputs[f] = { type: UPDATABLE[f], value: data[f] };

  const setKeywords = Array.isArray(data.KEYWORDS);
  if (setKeywords) {
    inputs.KEYWORDS = { type: sql.NVarChar(sql.MAX), value: JSON.stringify(data.KEYWORDS) };
  }

  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;

    UPDATE dbo.PROCEDURES SET
      ${fields.map((f) => `${f} = @${f},`).join("\n      ")}
      UPDUSR = @USRID, UPDDAT = SYSDATETIME()
    WHERE PRCID = @PRCID;

    ${
      setKeywords
        ? `DELETE FROM dbo.PROCKEYWORDS WHERE PRCID = @PRCID;
    INSERT INTO dbo.PROCKEYWORDS (PRCID, KEYWORD)
    SELECT DISTINCT @PRCID, LEFT(LTRIM(RTRIM([value])), 50)
    FROM OPENJSON(@KEYWORDS)
    WHERE LTRIM(RTRIM([value])) <> N'';`
        : ""
    }

    COMMIT TRANSACTION;
    `,
    inputs,
  });
}

export async function getKeywords(PRCID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT KEYWORD FROM dbo.PROCKEYWORDS WHERE PRCID = @PRCID ORDER BY KEYWORD`,
    inputs: { PRCID: { type: sql.Int, value: PRCID } },
  });
  return result.recordset.map((r) => r.KEYWORD);
}

export async function setStatus(PRCID, STATUS, USRID) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE dbo.PROCEDURES SET
      STATUS = @STATUS,
      PUBDAT = CASE WHEN @STATUS = 'PUBLISHED' THEN SYSDATETIME() ELSE PUBDAT END,
      UPDUSR = @USRID, UPDDAT = SYSDATETIME()
    WHERE PRCID = @PRCID
    `,
    inputs: {
      PRCID: { type: sql.Int, value: PRCID },
      STATUS: { type: sql.VarChar(20), value: STATUS },
      USRID: { type: sql.Int, value: USRID },
    },
  });
}

export async function setDeleted(PRCID, DLTD, USRID) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE dbo.PROCEDURES SET DLTD = @DLTD, UPDUSR = @USRID, UPDDAT = SYSDATETIME()
    WHERE PRCID = @PRCID
    `,
    inputs: {
      PRCID: { type: sql.Int, value: PRCID },
      DLTD: { type: sql.Bit, value: DLTD ? 1 : 0 },
      USRID: { type: sql.Int, value: USRID },
    },
  });
}

/** Suppression physique (échec d'enregistrement du fichier à la création). */
export async function purgeProcedure(PRCID) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    UPDATE dbo.PROCEDURES SET CURVERID = NULL WHERE PRCID = @PRCID;
    DELETE FROM dbo.PROCHISTORY WHERE PRCID = @PRCID;
    DELETE FROM dbo.PROCVERSIONS WHERE PRCID = @PRCID;
    DELETE FROM dbo.PROCKEYWORDS WHERE PRCID = @PRCID;
    DELETE FROM dbo.PROCEDURES WHERE PRCID = @PRCID;
    COMMIT TRANSACTION;
    `,
    inputs: { PRCID: { type: sql.Int, value: PRCID } },
  });
}

/* -------------------------------------------------------------------------- */
/*                                  VERSIONS                                  */
/* -------------------------------------------------------------------------- */

const SELECT_VERSION_COLUMNS = `
  v.VERID, v.PRCID, v.VERNUM, v.COMMENT, v.FILECODE, v.PREVIEWCODE,
  v.ORIGINALNAME, v.EXTENSION, v.MIMETYPE, v.SIZEBYTES, v.CHECKSUM,
  v.TEXTSTATUS, v.PAGES, v.CREUSR, v.CREDAT,
  ${USER_NAME("u")} AS CREUSRNAM,
  CASE WHEN p.CURVERID = v.VERID THEN 1 ELSE 0 END AS ISCURRENT,
  (SELECT COUNT(*) FROM dbo.PROCACKS AS a WHERE a.VERID = v.VERID) AS ACKCOUNT
`;

export async function getVersions(PRCID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT ${SELECT_VERSION_COLUMNS}
    FROM dbo.PROCVERSIONS AS v
    INNER JOIN dbo.PROCEDURES AS p ON p.PRCID = v.PRCID
    LEFT JOIN USERSMANAGER.dbo.USERS AS u ON u.USRID = v.CREUSR
    WHERE v.PRCID = @PRCID
    ORDER BY v.VERNUM DESC
    `,
    inputs: { PRCID: { type: sql.Int, value: PRCID } },
  });
  return result.recordset;
}

export async function getVersion(VERID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT ${SELECT_VERSION_COLUMNS}
    FROM dbo.PROCVERSIONS AS v
    INNER JOIN dbo.PROCEDURES AS p ON p.PRCID = v.PRCID
    LEFT JOIN USERSMANAGER.dbo.USERS AS u ON u.USRID = v.CREUSR
    WHERE v.VERID = @VERID
    `,
    inputs: { VERID: { type: sql.Int, value: VERID } },
  });
  return result.recordset[0] ?? null;
}

export async function getVersionText(VERID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT CONTENTTEXT, TEXTSTATUS FROM dbo.PROCVERSIONS WHERE VERID = @VERID`,
    inputs: { VERID: { type: sql.Int, value: VERID } },
  });
  return result.recordset[0] ?? null;
}

/** Nouvelle version (numéro suivant), fichier rattaché ensuite. */
export async function createVersion(PRCID, file, COMMENT, USRID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;

    DECLARE @VERNUM INT = (
      SELECT ISNULL(MAX(VERNUM), 0) + 1 FROM dbo.PROCVERSIONS WITH (UPDLOCK, HOLDLOCK)
      WHERE PRCID = @PRCID
    );

    INSERT INTO dbo.PROCVERSIONS (PRCID, VERNUM, COMMENT, ORIGINALNAME, EXTENSION, MIMETYPE, SIZEBYTES, TEXTSTATUS, CREUSR, CREDAT)
    VALUES (@PRCID, @VERNUM, @COMMENT, @ORIGINALNAME, @EXTENSION, @MIMETYPE, @SIZEBYTES, 'PENDING', @USRID, SYSDATETIME());

    SELECT SCOPE_IDENTITY() AS VERID, @VERNUM AS VERNUM;

    COMMIT TRANSACTION;
    `,
    inputs: {
      PRCID: { type: sql.Int, value: PRCID },
      COMMENT: { type: sql.NVarChar(1000), value: COMMENT ?? null },
      ...fileInputs(file),
      USRID: { type: sql.Int, value: USRID },
    },
  });
  return { VERID: Number(result.recordset[0].VERID), VERNUM: result.recordset[0].VERNUM };
}

/** Supprime une version sans fichier (échec d'enregistrement). */
export async function deleteVersion(VERID) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `DELETE FROM dbo.PROCVERSIONS WHERE VERID = @VERID AND FILECODE IS NULL`,
    inputs: { VERID: { type: sql.Int, value: VERID } },
  });
}

export async function attachVersionFile(VERID, { FILECODE, CHECKSUM, SIZEBYTES }) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE dbo.PROCVERSIONS
    SET FILECODE = @FILECODE, CHECKSUM = @CHECKSUM, SIZEBYTES = ISNULL(@SIZEBYTES, SIZEBYTES)
    WHERE VERID = @VERID
    `,
    inputs: {
      VERID: { type: sql.Int, value: VERID },
      FILECODE: { type: sql.VarChar(50), value: FILECODE },
      CHECKSUM: { type: sql.VarChar(64), value: CHECKSUM ?? null },
      SIZEBYTES: { type: sql.BigInt, value: SIZEBYTES ?? null },
    },
  });
}

export async function setVersionText(VERID, { TEXTSTATUS, CONTENTTEXT, PAGES }) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE dbo.PROCVERSIONS
    SET TEXTSTATUS = @TEXTSTATUS, CONTENTTEXT = @CONTENTTEXT, PAGES = @PAGES
    WHERE VERID = @VERID
    `,
    inputs: {
      VERID: { type: sql.Int, value: VERID },
      TEXTSTATUS: { type: sql.VarChar(20), value: TEXTSTATUS },
      CONTENTTEXT: { type: sql.NVarChar(sql.MAX), value: CONTENTTEXT ?? null },
      PAGES: { type: sql.Int, value: PAGES ?? null },
    },
  });
}

/** Texte saisi à la main pour une version (le nombre de pages est conservé). */
export async function setVersionContentText(VERID, CONTENTTEXT) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE dbo.PROCVERSIONS
    SET TEXTSTATUS = @TEXTSTATUS, CONTENTTEXT = @CONTENTTEXT
    WHERE VERID = @VERID
    `,
    inputs: {
      VERID: { type: sql.Int, value: VERID },
      TEXTSTATUS: { type: sql.VarChar(20), value: CONTENTTEXT ? "OK" : "EMPTY" },
      CONTENTTEXT: { type: sql.NVarChar(sql.MAX), value: CONTENTTEXT || null },
    },
  });
}

export async function setVersionPreview(VERID, PREVIEWCODE) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `UPDATE dbo.PROCVERSIONS SET PREVIEWCODE = @PREVIEWCODE WHERE VERID = @VERID`,
    inputs: {
      VERID: { type: sql.Int, value: VERID },
      PREVIEWCODE: { type: sql.VarChar(50), value: PREVIEWCODE },
    },
  });
}

/** Rend `VERID` courante (nouvelle version ou retour à une version antérieure). */
export async function setCurrentVersion(PRCID, VERID, USRID) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE dbo.PROCEDURES SET CURVERID = @VERID, UPDUSR = @USRID, UPDDAT = SYSDATETIME()
    WHERE PRCID = @PRCID
    `,
    inputs: {
      PRCID: { type: sql.Int, value: PRCID },
      VERID: { type: sql.Int, value: VERID },
      USRID: { type: sql.Int, value: USRID },
    },
  });
}

/* -------------------------------------------------------------------------- */
/*                                 HISTORIQUE                                 */
/* -------------------------------------------------------------------------- */

export async function addHistory({ PRCID, VERID = null, ACTION, DETAILS = null, USRID, USRNAM, DEVEMAIL = null }) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    INSERT INTO dbo.PROCHISTORY (PRCID, VERID, ACTION, DETAILS, USRID, USRNAM, DEVEMAIL, CREDAT)
    VALUES (@PRCID, @VERID, @ACTION, @DETAILS, @USRID, @USRNAM, @DEVEMAIL, SYSDATETIME())
    `,
    inputs: {
      PRCID: { type: sql.Int, value: PRCID },
      VERID: { type: sql.Int, value: VERID },
      ACTION: { type: sql.VarChar(30), value: ACTION },
      DETAILS: {
        type: sql.NVarChar(sql.MAX),
        value: DETAILS == null ? null : JSON.stringify(DETAILS),
      },
      USRID: { type: sql.Int, value: USRID },
      USRNAM: { type: sql.NVarChar(150), value: (USRNAM || "").slice(0, 150) || null },
      DEVEMAIL: { type: sql.NVarChar(255), value: DEVEMAIL },
    },
  });
}

export async function getHistory({ PRCID, USRID, ACTION, FROM, TO, LIMIT = 500 }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT TOP (@LIMIT)
      h.HISID, h.PRCID, h.VERID, h.ACTION, h.DETAILS, h.USRID,
      ISNULL(h.USRNAM, ${USER_NAME("u")}) AS USRNAM, h.DEVEMAIL, h.CREDAT,
      p.REFCODE, p.TITLE, v.VERNUM
    FROM dbo.PROCHISTORY AS h
    INNER JOIN dbo.PROCEDURES AS p ON p.PRCID = h.PRCID
    LEFT JOIN dbo.PROCVERSIONS AS v ON v.VERID = h.VERID
    LEFT JOIN USERSMANAGER.dbo.USERS AS u ON u.USRID = h.USRID
    WHERE (@PRCID IS NULL OR h.PRCID = @PRCID)
      AND (@USRID IS NULL OR h.USRID = @USRID)
      AND (@ACTION IS NULL OR h.ACTION = @ACTION)
      AND (@FROM IS NULL OR h.CREDAT >= @FROM)
      AND (@TO IS NULL OR h.CREDAT < DATEADD(DAY, 1, @TO))
    ORDER BY h.HISID DESC
    `,
    inputs: {
      LIMIT: { type: sql.Int, value: LIMIT },
      PRCID: { type: sql.Int, value: PRCID ?? null },
      USRID: { type: sql.Int, value: USRID ?? null },
      ACTION: { type: sql.VarChar(30), value: ACTION ?? null },
      FROM: { type: sql.Date, value: FROM ?? null },
      TO: { type: sql.Date, value: TO ?? null },
    },
  });
  return result.recordset;
}

/* -------------------------------------------------------------------------- */
/*                         CONSULTATIONS & ACCUSÉS                            */
/* -------------------------------------------------------------------------- */

/** Fenêtre pendant laquelle une même consultation n'est pas re-comptée. */
const CONSULT_DEDUP_MINUTES = 10;

export async function addConsult({ PRCID, VERID, USRID, KIND }) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    IF NOT EXISTS (
      SELECT 1 FROM dbo.PROCCONSULTS
      WHERE PRCID = @PRCID AND USRID = @USRID AND KIND = @KIND
        AND ISNULL(VERID, 0) = ISNULL(@VERID, 0)
        AND CREDAT > DATEADD(MINUTE, -${CONSULT_DEDUP_MINUTES}, SYSDATETIME())
    )
      INSERT INTO dbo.PROCCONSULTS (PRCID, VERID, USRID, KIND, CREDAT)
      VALUES (@PRCID, @VERID, @USRID, @KIND, SYSDATETIME());
    `,
    inputs: {
      PRCID: { type: sql.Int, value: PRCID },
      VERID: { type: sql.Int, value: VERID ?? null },
      USRID: { type: sql.Int, value: USRID },
      KIND: { type: sql.VarChar(10), value: KIND },
    },
  });
}

/**
 * Lecteurs d'une procédure : un ligne par utilisateur ayant consulté la
 * fiche ou accusé lecture (nombre de consultations, téléchargements,
 * dernière consultation, version consultée, accusé de lecture de la version
 * courante).
 */
export async function getReaders(PRCID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    WITH usr AS (
      SELECT USRID FROM dbo.PROCCONSULTS WHERE PRCID = @PRCID
      UNION
      SELECT USRID FROM dbo.PROCACKS WHERE PRCID = @PRCID
    )
    SELECT
      usr.USRID, ${USER_NAME("u")} AS USRNAM, u.EMAIL,
      st.VIEWS, st.DOWNLOADS, st.LASTVIEW, lv.VERNUM AS LASTVERNUM,
      ack.ACKDAT AS CURACKDAT, lack.VERNUM AS LASTACKVERNUM, lack.ACKDAT AS LASTACKDAT
    FROM usr
    LEFT JOIN USERSMANAGER.dbo.USERS AS u ON u.USRID = usr.USRID
    OUTER APPLY (
      SELECT
        SUM(CASE WHEN c.KIND = 'VIEW' THEN 1 ELSE 0 END) AS VIEWS,
        SUM(CASE WHEN c.KIND = 'DOWNLOAD' THEN 1 ELSE 0 END) AS DOWNLOADS,
        MAX(c.CREDAT) AS LASTVIEW
      FROM dbo.PROCCONSULTS AS c WHERE c.PRCID = @PRCID AND c.USRID = usr.USRID
    ) AS st
    OUTER APPLY (
      SELECT TOP 1 v.VERNUM FROM dbo.PROCCONSULTS AS c
      INNER JOIN dbo.PROCVERSIONS AS v ON v.VERID = c.VERID
      WHERE c.PRCID = @PRCID AND c.USRID = usr.USRID ORDER BY c.CREDAT DESC
    ) AS lv
    OUTER APPLY (
      SELECT a.ACKDAT FROM dbo.PROCACKS AS a
      INNER JOIN dbo.PROCEDURES AS p ON p.PRCID = a.PRCID AND p.CURVERID = a.VERID
      WHERE a.PRCID = @PRCID AND a.USRID = usr.USRID
    ) AS ack
    OUTER APPLY (
      SELECT TOP 1 v.VERNUM, a.ACKDAT FROM dbo.PROCACKS AS a
      INNER JOIN dbo.PROCVERSIONS AS v ON v.VERID = a.VERID
      WHERE a.PRCID = @PRCID AND a.USRID = usr.USRID ORDER BY v.VERNUM DESC
    ) AS lack
    ORDER BY st.LASTVIEW DESC
    `,
    inputs: { PRCID: { type: sql.Int, value: PRCID } },
  });
  return result.recordset;
}

export async function acknowledge(PRCID, VERID, USRID) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    IF NOT EXISTS (SELECT 1 FROM dbo.PROCACKS WHERE VERID = @VERID AND USRID = @USRID)
      INSERT INTO dbo.PROCACKS (PRCID, VERID, USRID, ACKDAT)
      VALUES (@PRCID, @VERID, @USRID, SYSDATETIME());
    `,
    inputs: {
      PRCID: { type: sql.Int, value: PRCID },
      VERID: { type: sql.Int, value: VERID },
      USRID: { type: sql.Int, value: USRID },
    },
  });
}

/* -------------------------------------------------------------------------- */
/*                                 CATÉGORIES                                 */
/* -------------------------------------------------------------------------- */

export async function getCategories(ctx, { includeInactive = false } = {}) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT
      c.CATID, c.PARENTID, c.NAME, c.DESCR, c.COLOR, c.ICON, c.SORTORD, c.ACTIVE,
      c.CREDAT, c.UPDDAT,
      (SELECT COUNT(*) FROM dbo.PROCEDURES AS p
        WHERE p.CATID = c.CATID AND p.DLTD = 0
          AND (@ISEDITOR = 1 OR (p.STATUS = 'PUBLISHED' AND p.CURVERID IS NOT NULL))) AS PROCCOUNT,
      -- Supprimable : aucune procédure (corbeille comprise) ni sous-catégorie.
      CASE WHEN NOT EXISTS (SELECT 1 FROM dbo.PROCEDURES AS p WHERE p.CATID = c.CATID)
            AND NOT EXISTS (SELECT 1 FROM dbo.PROCCATEGORIES AS sc WHERE sc.PARENTID = c.CATID)
        THEN 1 ELSE 0 END AS CANDELETE
    FROM dbo.PROCCATEGORIES AS c
    LEFT JOIN dbo.PROCCATEGORIES AS pc ON pc.CATID = c.PARENTID
    LEFT JOIN dbo.PROCCATEGORIES AS gpc ON gpc.CATID = pc.PARENTID
    -- Sans @INCLUDEINACTIVE : catégories actives dont les parents le sont aussi
    -- (une sous-catégorie d'une catégorie désactivée est masquée avec elle).
    WHERE (@INCLUDEINACTIVE = 1 OR ${CATEGORY_CHAIN_ACTIVE})
    ORDER BY c.SORTORD, c.NAME
    `,
    inputs: {
      ISEDITOR: { type: sql.Bit, value: ctx.ISEDITOR ? 1 : 0 },
      INCLUDEINACTIVE: { type: sql.Bit, value: includeInactive ? 1 : 0 },
    },
  });
  return result.recordset;
}

export async function getCategory(CATID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT * FROM dbo.PROCCATEGORIES WHERE CATID = @CATID`,
    inputs: { CATID: { type: sql.Int, value: CATID } },
  });
  return result.recordset[0] ?? null;
}

/** Liens parent / enfant de toutes les catégories (contrôle de l'arborescence). */
export async function getCategoryLinks() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT CATID, PARENTID FROM dbo.PROCCATEGORIES`,
  });
  return result.recordset;
}

export async function createCategory(data, USRID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    INSERT INTO dbo.PROCCATEGORIES (PARENTID, NAME, DESCR, COLOR, ICON, SORTORD, ACTIVE, CREUSR, CREDAT)
    OUTPUT INSERTED.CATID
    VALUES (@PARENTID, @NAME, @DESCR, @COLOR, @ICON,
      ISNULL(@SORTORD, (SELECT ISNULL(MAX(SORTORD), 0) + 10 FROM dbo.PROCCATEGORIES)),
      1, @USRID, SYSDATETIME())
    `,
    inputs: {
      PARENTID: { type: sql.Int, value: data.PARENTID ?? null },
      NAME: { type: sql.NVarChar(100), value: data.NAME },
      DESCR: { type: sql.NVarChar(500), value: data.DESCR ?? null },
      COLOR: { type: sql.VarChar(20), value: data.COLOR ?? null },
      ICON: { type: sql.VarChar(50), value: data.ICON ?? null },
      SORTORD: { type: sql.Int, value: data.SORTORD ?? null },
      USRID: { type: sql.Int, value: USRID },
    },
  });
  return result.recordset[0].CATID;
}

/**
 * Utilisation d'une catégorie : procédures rattachées (corbeille comprise,
 * la clé étrangère les compte aussi) et sous-catégories (actives ou non).
 */
export async function getCategoryUsage(CATID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT
      (SELECT COUNT(*) FROM dbo.PROCEDURES WHERE CATID = @CATID) AS PROCCOUNT,
      (SELECT COUNT(*) FROM dbo.PROCCATEGORIES WHERE PARENTID = @CATID) AS CHILDCOUNT
    `,
    inputs: { CATID: { type: sql.Int, value: CATID } },
  });
  return result.recordset[0];
}

/** Suppression définitive (à n'appeler que sur une catégorie inutilisée). */
export async function deleteCategory(CATID) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `DELETE FROM dbo.PROCCATEGORIES WHERE CATID = @CATID`,
    inputs: { CATID: { type: sql.Int, value: CATID } },
  });
}

const CATEGORY_FIELDS = {
  PARENTID: sql.Int,
  NAME: sql.NVarChar(100),
  DESCR: sql.NVarChar(500),
  COLOR: sql.VarChar(20),
  ICON: sql.VarChar(50),
  SORTORD: sql.Int,
  ACTIVE: sql.Bit,
};

export async function updateCategory(CATID, data, USRID) {
  const fields = Object.keys(CATEGORY_FIELDS).filter((k) => data[k] !== undefined);
  const inputs = {
    CATID: { type: sql.Int, value: CATID },
    USRID: { type: sql.Int, value: USRID },
  };
  for (const f of fields) inputs[f] = { type: CATEGORY_FIELDS[f], value: data[f] };

  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE dbo.PROCCATEGORIES SET
      ${fields.map((f) => `${f} = @${f},`).join("\n      ")}
      UPDUSR = @USRID, UPDDAT = SYSDATETIME()
    WHERE CATID = @CATID
    `,
    inputs,
  });
}

/* -------------------------------------------------------------------------- */
/*                                STATISTIQUES                                */
/* -------------------------------------------------------------------------- */

export async function getStats() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT
      (SELECT COUNT(*) FROM dbo.PROCEDURES WHERE DLTD = 0 AND STATUS = 'PUBLISHED') AS PUBLISHED,
      (SELECT COUNT(*) FROM dbo.PROCEDURES WHERE DLTD = 0 AND STATUS = 'DRAFT') AS DRAFT,
      (SELECT COUNT(*) FROM dbo.PROCEDURES WHERE DLTD = 0 AND STATUS = 'ARCHIVED') AS ARCHIVED,
      (SELECT COUNT(*) FROM dbo.PROCEDURES WHERE DLTD = 0 AND STATUS = 'PUBLISHED'
         AND REVIEWDAT IS NOT NULL AND REVIEWDAT < CAST(GETDATE() AS DATE)) AS OVERDUE,
      (SELECT COUNT(*) FROM dbo.PROCVERSIONS AS v
         INNER JOIN dbo.PROCEDURES AS p ON p.CURVERID = v.VERID AND p.DLTD = 0
         WHERE v.TEXTSTATUS IN ('EMPTY', 'ERROR', 'UNSUPPORTED')) AS NOTINDEXED,
      (SELECT COUNT(*) FROM dbo.PROCCONSULTS
         WHERE CREDAT > DATEADD(DAY, -30, SYSDATETIME())) AS CONSULTS30D
    `,
  });
  return result.recordset[0];
}

/* -------------------------------------------------------------------------- */
/*                               PIÈCES JOINTES                               */
/* -------------------------------------------------------------------------- */

/** Métadonnées d'un fichier déposé (base "attachments"). */
export async function getAttachment(FILECODE) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    dbConnectionName: "attachments",
    query: `
    SELECT FILECODE, ORIGINALNAME, RELATIVEPATH, MIMETYPE, EXTENSION, SIZEBYTES, CHECKSUMSHA256
    FROM ATTACHMENTS
    WHERE FILECODE = @FILECODE AND APPCODE = 'PROCS' AND DELETEDAT IS NULL
    `,
    inputs: { FILECODE: { type: sql.VarChar(50), value: FILECODE } },
  });
  return result.recordset[0] ?? null;
}
