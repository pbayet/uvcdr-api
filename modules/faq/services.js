import sql from "mssql";
import { runQuery } from "../../core/utils/db.utils.js";

/* ═══════════════════════════════════════════════════════════════
   FAQ — Services
   Tables (cf. sql/FAQ.tables.sql) :
     FAQPOSTS, FAQANSWERS, FAQANSWERLIKES, FAQCATEGORIES, FAQSTATUSES,
     FAQKEYWORDS, FAQMODERATORS, FAQTICKETS
   Cross-base :
     USERSMANAGER.dbo.USERS         (nom / email des auteurs)
     USERSMANAGER.dbo.APPLICATIONS  (application concernée, FAQPOSTS.APPID)

   Visibilité (cf. `visibilityInputs`) :
     - un modérateur voit tout, y compris les publications/réponses masquées
       (DLTD = 1) ;
     - un utilisateur voit les publications sans application, celles des
       applications auxquelles il a accès (APPCODS) et toujours les siennes.
═══════════════════════════════════════════════════════════════ */

const USER_NAME = (alias) =>
  `NULLIF(LTRIM(RTRIM(CONCAT(${alias}.FSTNAM, ' ', ${alias}.LSTNAM))), '')`;

const SELECT_POSTS = `
SELECT
  p.PSTID, p.TYPE, p.TITLE, p.BODY,
  p.CATID, c.NAME AS CATNAME,
  p.APPID, a.APPNAM, a.APPCOD,
  p.STSID, s.CODE AS STSCODE, s.NAME AS STSNAME, s.LVL AS STSLVL,
  p.CREUSR, ${USER_NAME("u")} AS USRNAM, u.EMAIL AS USREMAIL,
  p.CREDAT, p.UPDDAT, p.PINNED, p.VIEWS, p.DLTD,
  (SELECT COUNT(*) FROM dbo.FAQANSWERS an
     WHERE an.PSTID = p.PSTID AND an.DLTD = 0) AS ANSWERCOUNT,
  (SELECT COUNT(*) FROM dbo.FAQANSWERS an
     WHERE an.PSTID = p.PSTID AND an.DLTD = 0 AND an.VALIDATED = 1) AS VALIDATEDCOUNT,
  (SELECT COUNT(*) FROM dbo.FAQANSWERLIKES l
     INNER JOIN dbo.FAQANSWERS an ON an.ANSID = l.ANSID
     WHERE an.PSTID = p.PSTID AND an.DLTD = 0) AS LIKECOUNT,
  (SELECT MAX(an.CREDAT) FROM dbo.FAQANSWERS an
     WHERE an.PSTID = p.PSTID AND an.DLTD = 0) AS LASTANSDAT,
  (SELECT MIN(an.VALDAT) FROM dbo.FAQANSWERS an
     WHERE an.PSTID = p.PSTID AND an.DLTD = 0 AND an.VALIDATED = 1) AS FIRSTVALDAT,
  (SELECT STRING_AGG(k.KEYWORD, '|') FROM dbo.FAQKEYWORDS k
     WHERE k.PSTID = p.PSTID) AS KEYWORDS,
  ft.TCKID, ft.TCKCOD
FROM dbo.FAQPOSTS AS p
LEFT JOIN dbo.FAQCATEGORIES AS c ON c.CATID = p.CATID
LEFT JOIN dbo.FAQSTATUSES AS s ON s.STSID = p.STSID
LEFT JOIN USERSMANAGER.dbo.USERS AS u ON u.USRID = p.CREUSR
LEFT JOIN USERSMANAGER.dbo.APPLICATIONS AS a ON a.APPID = p.APPID
OUTER APPLY (
  SELECT TOP 1 t.TCKID, t.TCKCOD
  FROM dbo.FAQTICKETS AS t
  WHERE t.PSTID = p.PSTID AND t.ANSID IS NULL
) AS ft
`;

/** Clause de visibilité commune (cf. en-tête). */
const VISIBILITY = `
  (@ISMOD = 1 OR p.DLTD = 0)
  AND (
    @ISMOD = 1
    OR p.CREUSR = @USRID
    OR p.APPID IS NULL
    OR a.APPCOD IN (SELECT [value] FROM OPENJSON(@APPCODS))
  )
`;

function visibilityInputs({ USRID, ISMOD, APPCODS }) {
  return {
    USRID: { type: sql.Int, value: USRID },
    ISMOD: { type: sql.Bit, value: ISMOD ? 1 : 0 },
    APPCODS: {
      type: sql.NVarChar(sql.MAX),
      value: JSON.stringify(APPCODS ?? []),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                                PUBLICATIONS                                */
/* -------------------------------------------------------------------------- */

export async function getPosts(ctx, filters = {}) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    ${SELECT_POSTS}
    WHERE ${VISIBILITY}
      AND (@TYPE IS NULL OR p.TYPE = @TYPE)
      AND (@CATID IS NULL OR p.CATID = @CATID)
      AND (@APPID IS NULL OR p.APPID = @APPID)
      AND (@STSID IS NULL OR p.STSID = @STSID)
      AND (@PINNED IS NULL OR p.PINNED = @PINNED)
      AND (@MINE = 0 OR p.CREUSR = @USRID)
      AND (@DLTD IS NULL OR p.DLTD = @DLTD)
      AND (@UNANSWERED = 0 OR NOT EXISTS (
        SELECT 1 FROM dbo.FAQANSWERS an WHERE an.PSTID = p.PSTID AND an.DLTD = 0
      ))
      AND (
        @SEARCH IS NULL
        OR p.TITLE LIKE @SEARCH
        OR p.BODY LIKE @SEARCH
        OR EXISTS (SELECT 1 FROM dbo.FAQKEYWORDS k WHERE k.PSTID = p.PSTID AND k.KEYWORD LIKE @SEARCH)
      )
    ORDER BY p.PINNED DESC, COALESCE(
      (SELECT MAX(an.CREDAT) FROM dbo.FAQANSWERS an WHERE an.PSTID = p.PSTID AND an.DLTD = 0),
      p.UPDDAT, p.CREDAT
    ) DESC
    `,
    inputs: {
      ...visibilityInputs(ctx),
      TYPE: { type: sql.NVarChar(20), value: filters.TYPE ?? null },
      CATID: { type: sql.Int, value: filters.CATID ?? null },
      APPID: { type: sql.Int, value: filters.APPID ?? null },
      STSID: { type: sql.Int, value: filters.STSID ?? null },
      PINNED: { type: sql.Bit, value: filters.PINNED ?? null },
      MINE: { type: sql.Bit, value: filters.MINE ? 1 : 0 },
      DLTD: { type: sql.Bit, value: filters.DLTD ?? null },
      UNANSWERED: { type: sql.Bit, value: filters.UNANSWERED ? 1 : 0 },
      SEARCH: {
        type: sql.NVarChar(210),
        value: filters.SEARCH ? `%${escapeLike(filters.SEARCH)}%` : null,
      },
    },
  });

  return result.recordset;
}

/** Mots trop courants pour caractériser une question (sans accents). */
const STOPWORDS = new Set([
  "comment", "pourquoi", "quand", "quel", "quelle", "quels", "quelles",
  "est-ce", "faire", "peut", "peux", "puis", "pouvoir", "avoir", "etre",
  "dans", "pour", "avec", "sans", "sur", "sous", "vers", "chez", "entre",
  "mon", "mes", "mais", "donc", "alors", "aussi", "plus", "moins", "tres",
  "cette", "celui", "celle", "ceux", "leur", "leurs", "notre", "nos",
  "votre", "vos", "tout", "tous", "toute", "toutes", "deja", "encore",
  "faut", "doit", "dois", "veux", "voudrais", "souhaite", "possible",
  "existe", "ilya", "elle", "elles", "nous", "vous", "lors", "apres",
  "avant", "depuis", "comme", "autre", "autres", "meme", "chose",
]);

/**
 * Publications au titre proche (création d'une question : « une question
 * similaire existe peut-être déjà »). Recherche par mots significatifs
 * (≥ 4 lettres) du texte saisi, classées par nombre de mots trouvés.
 */
export async function getSimilarPosts(ctx, { SEARCH, TYPE, EXCLUDE }) {
  const words = [
    ...new Set(
      SEARCH.toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
    ),
  ].slice(0, 8);

  if (!words.length) return [];

  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    WITH W AS (SELECT [value] AS WORD FROM OPENJSON(@WORDS))
    SELECT TOP 5 x.* FROM (
      ${SELECT_POSTS}
      WHERE ${VISIBILITY}
        AND p.DLTD = 0
        AND (@TYPE IS NULL OR p.TYPE = @TYPE)
        AND (@EXCLUDE IS NULL OR p.PSTID <> @EXCLUDE)
    ) AS x
    CROSS APPLY (
      SELECT COUNT(*) AS SCORE FROM W
      WHERE x.TITLE COLLATE Latin1_General_CI_AI LIKE '%' + W.WORD + '%'
         OR x.KEYWORDS COLLATE Latin1_General_CI_AI LIKE '%' + W.WORD + '%'
    ) AS sc
    WHERE sc.SCORE > 0
    ORDER BY sc.SCORE DESC, x.VALIDATEDCOUNT DESC, x.CREDAT DESC
    `,
    inputs: {
      ...visibilityInputs(ctx),
      WORDS: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(words) },
      TYPE: { type: sql.NVarChar(20), value: TYPE ?? null },
      EXCLUDE: { type: sql.Int, value: EXCLUDE ?? null },
    },
  });

  return result.recordset;
}

export async function getPost(ctx, PSTID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `${SELECT_POSTS} WHERE p.PSTID = @PSTID AND ${VISIBILITY}`,
    inputs: {
      ...visibilityInputs(ctx),
      PSTID: { type: sql.Int, value: PSTID },
    },
  });

  return result.recordset[0] ?? null;
}

/** Lecture brute (sans contrôle de visibilité) — usage interne des contrôleurs. */
export async function getPostRaw(PSTID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `${SELECT_POSTS} WHERE p.PSTID = @PSTID`,
    inputs: { PSTID: { type: sql.Int, value: PSTID } },
  });

  return result.recordset[0] ?? null;
}

export async function createPost({ TYPE, TITLE, BODY, CATID, APPID, CREUSR }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;
    DECLARE @STSID INT = (
      SELECT TOP 1 STSID FROM dbo.FAQSTATUSES
      WHERE TYPE = @TYPE AND ACTIVE = 1
      ORDER BY LVL ASC, STSID ASC
    );

    INSERT INTO dbo.FAQPOSTS (TYPE, TITLE, BODY, CATID, APPID, STSID, CREUSR)
    VALUES (@TYPE, @TITLE, @BODY, @CATID, @APPID, @STSID, @CREUSR);

    SELECT CAST(SCOPE_IDENTITY() AS INT) AS PSTID;
    `,
    inputs: {
      TYPE: { type: sql.NVarChar(20), value: TYPE },
      TITLE: { type: sql.NVarChar(255), value: TITLE },
      BODY: { type: sql.NVarChar(4000), value: BODY },
      CATID: { type: sql.Int, value: CATID ?? null },
      APPID: { type: sql.Int, value: APPID ?? null },
      CREUSR: { type: sql.Int, value: CREUSR },
    },
  });

  return result.recordset[0]?.PSTID ?? null;
}

/**
 * Mise à jour partielle : seuls les champs présents (≠ undefined) sont
 * modifiés ; `null` remet à zéro CATID/APPID/STSID.
 */
export async function updatePost(PSTID, fields) {
  const columns = {
    TITLE: sql.NVarChar(255),
    BODY: sql.NVarChar(4000),
    CATID: sql.Int,
    APPID: sql.Int,
    STSID: sql.Int,
    PINNED: sql.Bit,
  };

  const sets = [];
  const inputs = { PSTID: { type: sql.Int, value: PSTID } };

  for (const [name, type] of Object.entries(columns)) {
    if (fields[name] === undefined) continue;
    sets.push(`${name} = @${name}`);
    inputs[name] = { type, value: fields[name] };
  }

  if (!sets.length) return;

  // Épingler / changer le statut n'est pas une « modification » du contenu.
  const touchesContent = ["TITLE", "BODY", "CATID", "APPID"].some(
    (name) => fields[name] !== undefined,
  );
  if (touchesContent) sets.push("UPDDAT = SYSUTCDATETIME()");

  await runQuery({
    moduleUrl: import.meta.url,
    query: `UPDATE dbo.FAQPOSTS SET ${sets.join(", ")} WHERE PSTID = @PSTID`,
    inputs,
  });
}

export async function setPostDeleted(PSTID, DLTD) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `UPDATE dbo.FAQPOSTS SET DLTD = @DLTD WHERE PSTID = @PSTID`,
    inputs: {
      PSTID: { type: sql.Int, value: PSTID },
      DLTD: { type: sql.Bit, value: DLTD ? 1 : 0 },
    },
  });
}

/** Suppression définitive d'une publication et de tout ce qui en dépend. */
export async function deletePostPermanently(PSTID) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET XACT_ABORT ON;
    BEGIN TRAN;
      DELETE l FROM dbo.FAQANSWERLIKES AS l
        INNER JOIN dbo.FAQANSWERS AS an ON an.ANSID = l.ANSID
        WHERE an.PSTID = @PSTID;
      DELETE FROM dbo.FAQTICKETS WHERE PSTID = @PSTID;
      DELETE FROM dbo.FAQKEYWORDS WHERE PSTID = @PSTID;
      DELETE FROM dbo.FAQANSWERS WHERE PSTID = @PSTID;
      DELETE FROM dbo.FAQPOSTS WHERE PSTID = @PSTID;
    COMMIT;
    `,
    inputs: { PSTID: { type: sql.Int, value: PSTID } },
  });
}

export async function incrementViews(PSTID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE dbo.FAQPOSTS SET VIEWS = VIEWS + 1
    OUTPUT inserted.PSTID, inserted.VIEWS
    WHERE PSTID = @PSTID AND DLTD = 0
    `,
    inputs: { PSTID: { type: sql.Int, value: PSTID } },
  });

  return result.recordset[0] ?? null;
}

/**
 * Change le type d'une publication : statut initial du nouveau type, et
 * retrait des bonnes réponses (notion propre aux questions).
 */
export async function convertPost(PSTID, TYPE) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET XACT_ABORT ON;
    BEGIN TRAN;
      UPDATE dbo.FAQPOSTS
         SET TYPE = @TYPE,
             STSID = (
               SELECT TOP 1 STSID FROM dbo.FAQSTATUSES
               WHERE TYPE = @TYPE AND ACTIVE = 1
               ORDER BY LVL ASC, STSID ASC
             ),
             UPDDAT = SYSUTCDATETIME()
       WHERE PSTID = @PSTID;

      UPDATE dbo.FAQANSWERS
         SET VALIDATED = 0, VALDBY = NULL, VALDAT = NULL
       WHERE PSTID = @PSTID AND VALIDATED = 1;
    COMMIT;
    `,
    inputs: {
      PSTID: { type: sql.Int, value: PSTID },
      TYPE: { type: sql.NVarChar(20), value: TYPE },
    },
  });
}

/** Remplace la liste complète des mots-clés d'une publication. */
export async function setKeywords(PSTID, KEYWORDS, CREUSR) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET XACT_ABORT ON;
    BEGIN TRAN;
      DELETE FROM dbo.FAQKEYWORDS
       WHERE PSTID = @PSTID
         AND KEYWORD NOT IN (SELECT [value] FROM OPENJSON(@KEYWORDS));

      INSERT INTO dbo.FAQKEYWORDS (PSTID, KEYWORD, CREUSR)
      SELECT DISTINCT @PSTID, j.[value], @CREUSR
        FROM OPENJSON(@KEYWORDS) AS j
       WHERE NOT EXISTS (
         SELECT 1 FROM dbo.FAQKEYWORDS k
          WHERE k.PSTID = @PSTID AND k.KEYWORD = j.[value]
       );
    COMMIT;
    `,
    inputs: {
      PSTID: { type: sql.Int, value: PSTID },
      KEYWORDS: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(KEYWORDS) },
      CREUSR: { type: sql.Int, value: CREUSR },
    },
  });
}

/**
 * Passe la publication au statut CODE si son statut actuel fait partie de
 * FROM_CODES (vide = n'importe lequel). Sans effet si le statut CODE
 * n'existe pas (référentiel personnalisé).
 */
export async function moveStatus(PSTID, CODE, FROM_CODES = []) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    DECLARE @TARGET INT = (
      SELECT s.STSID FROM dbo.FAQSTATUSES s
       INNER JOIN dbo.FAQPOSTS p ON p.TYPE = s.TYPE
       WHERE s.CODE = @CODE AND s.ACTIVE = 1 AND p.PSTID = @PSTID
    );

    UPDATE p SET p.STSID = @TARGET
      FROM dbo.FAQPOSTS AS p
      LEFT JOIN dbo.FAQSTATUSES AS s ON s.STSID = p.STSID
     WHERE p.PSTID = @PSTID
       AND @TARGET IS NOT NULL
       AND (p.STSID IS NULL OR p.STSID <> @TARGET)
       AND (
         NOT EXISTS (SELECT 1 FROM OPENJSON(@FROM_CODES))
         OR p.STSID IS NULL
         OR s.CODE IN (SELECT [value] FROM OPENJSON(@FROM_CODES))
       );
    `,
    inputs: {
      PSTID: { type: sql.Int, value: PSTID },
      CODE: { type: sql.NVarChar(20), value: CODE },
      FROM_CODES: {
        type: sql.NVarChar(sql.MAX),
        value: JSON.stringify(FROM_CODES),
      },
    },
  });
}

/* -------------------------------------------------------------------------- */
/*                                  RÉPONSES                                  */
/* -------------------------------------------------------------------------- */

const SELECT_ANSWERS = `
SELECT
  an.ANSID, an.PSTID, an.BODY,
  an.CREUSR, ${USER_NAME("u")} AS USRNAM, u.EMAIL AS USREMAIL,
  an.CREDAT, an.UPDDAT, an.VALIDATED,
  an.VALDBY, ${USER_NAME("v")} AS VALDBYNAM, an.VALDAT, an.DLTD,
  (SELECT COUNT(*) FROM dbo.FAQANSWERLIKES l WHERE l.ANSID = an.ANSID) AS LIKECOUNT,
  CASE WHEN EXISTS (
    SELECT 1 FROM dbo.FAQANSWERLIKES l WHERE l.ANSID = an.ANSID AND l.USRID = @USRID
  ) THEN 1 ELSE 0 END AS LIKED,
  ft.TCKID, ft.TCKCOD
FROM dbo.FAQANSWERS AS an
LEFT JOIN USERSMANAGER.dbo.USERS AS u ON u.USRID = an.CREUSR
LEFT JOIN USERSMANAGER.dbo.USERS AS v ON v.USRID = an.VALDBY
LEFT JOIN dbo.FAQTICKETS AS ft ON ft.ANSID = an.ANSID
`;

export async function getAnswers({ USRID, ISMOD }, PSTIDS, { onlyValidated = false } = {}) {
  if (!PSTIDS.length) return [];

  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    ${SELECT_ANSWERS}
    WHERE an.PSTID IN (SELECT CAST([value] AS INT) FROM OPENJSON(@PSTIDS))
      AND (@ISMOD = 1 OR an.DLTD = 0)
      AND (@ONLYVAL = 0 OR (an.VALIDATED = 1 AND an.DLTD = 0))
    ORDER BY an.VALIDATED DESC, an.CREDAT ASC
    `,
    inputs: {
      USRID: { type: sql.Int, value: USRID },
      ISMOD: { type: sql.Bit, value: ISMOD ? 1 : 0 },
      ONLYVAL: { type: sql.Bit, value: onlyValidated ? 1 : 0 },
      PSTIDS: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(PSTIDS) },
    },
  });

  return result.recordset;
}

export async function getAnswerRaw(ANSID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT an.*, p.TYPE AS PSTTYPE, p.CREUSR AS PSTCREUSR, p.DLTD AS PSTDLTD,
      p.TITLE AS PSTTITLE,
      (SELECT TOP 1 TCKID FROM dbo.FAQTICKETS t WHERE t.ANSID = an.ANSID) AS TCKID
    FROM dbo.FAQANSWERS AS an
    INNER JOIN dbo.FAQPOSTS AS p ON p.PSTID = an.PSTID
    WHERE an.ANSID = @ANSID
    `,
    inputs: { ANSID: { type: sql.Int, value: ANSID } },
  });

  return result.recordset[0] ?? null;
}

export async function createAnswer({ PSTID, BODY, CREUSR }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    INSERT INTO dbo.FAQANSWERS (PSTID, BODY, CREUSR)
    OUTPUT inserted.ANSID
    VALUES (@PSTID, @BODY, @CREUSR)
    `,
    inputs: {
      PSTID: { type: sql.Int, value: PSTID },
      BODY: { type: sql.NVarChar(4000), value: BODY },
      CREUSR: { type: sql.Int, value: CREUSR },
    },
  });

  return result.recordset[0]?.ANSID ?? null;
}

export async function updateAnswer(ANSID, BODY) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE dbo.FAQANSWERS
       SET BODY = @BODY, UPDDAT = SYSUTCDATETIME()
     WHERE ANSID = @ANSID
    `,
    inputs: {
      ANSID: { type: sql.Int, value: ANSID },
      BODY: { type: sql.NVarChar(4000), value: BODY },
    },
  });
}

export async function validateAnswer(ANSID, VALIDATED, VALDBY) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE dbo.FAQANSWERS
       SET VALIDATED = @VALIDATED,
           VALDBY = CASE WHEN @VALIDATED = 1 THEN @VALDBY ELSE NULL END,
           VALDAT = CASE WHEN @VALIDATED = 1 THEN SYSUTCDATETIME() ELSE NULL END
     WHERE ANSID = @ANSID
    `,
    inputs: {
      ANSID: { type: sql.Int, value: ANSID },
      VALIDATED: { type: sql.Bit, value: VALIDATED ? 1 : 0 },
      VALDBY: { type: sql.Int, value: VALDBY },
    },
  });
}

export async function countValidatedAnswers(PSTID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT COUNT(*) AS N FROM dbo.FAQANSWERS
     WHERE PSTID = @PSTID AND VALIDATED = 1 AND DLTD = 0
    `,
    inputs: { PSTID: { type: sql.Int, value: PSTID } },
  });

  return result.recordset[0]?.N ?? 0;
}

export async function setAnswerDeleted(ANSID, DLTD) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `UPDATE dbo.FAQANSWERS SET DLTD = @DLTD WHERE ANSID = @ANSID`,
    inputs: {
      ANSID: { type: sql.Int, value: ANSID },
      DLTD: { type: sql.Bit, value: DLTD ? 1 : 0 },
    },
  });
}

export async function deleteAnswerPermanently(ANSID) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET XACT_ABORT ON;
    BEGIN TRAN;
      DELETE FROM dbo.FAQANSWERLIKES WHERE ANSID = @ANSID;
      DELETE FROM dbo.FAQTICKETS WHERE ANSID = @ANSID;
      DELETE FROM dbo.FAQANSWERS WHERE ANSID = @ANSID;
    COMMIT;
    `,
    inputs: { ANSID: { type: sql.Int, value: ANSID } },
  });
}

export async function setAnswerLike(ANSID, USRID, LIKED) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: LIKED
      ? `
      INSERT INTO dbo.FAQANSWERLIKES (ANSID, USRID)
      SELECT @ANSID, @USRID
      WHERE NOT EXISTS (
        SELECT 1 FROM dbo.FAQANSWERLIKES WHERE ANSID = @ANSID AND USRID = @USRID
      )`
      : `DELETE FROM dbo.FAQANSWERLIKES WHERE ANSID = @ANSID AND USRID = @USRID`,
    inputs: {
      ANSID: { type: sql.Int, value: ANSID },
      USRID: { type: sql.Int, value: USRID },
    },
  });
}

export async function getAnswerLikers(ANSID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT l.USRID, COALESCE(${USER_NAME("u")}, CONCAT('Utilisateur #', l.USRID)) AS USRNAM, l.CREDAT
      FROM dbo.FAQANSWERLIKES AS l
      LEFT JOIN USERSMANAGER.dbo.USERS AS u ON u.USRID = l.USRID
     WHERE l.ANSID = @ANSID
     ORDER BY l.CREDAT DESC
    `,
    inputs: { ANSID: { type: sql.Int, value: ANSID } },
  });

  return result.recordset;
}

/* -------------------------------------------------------------------------- */
/*                                   TICKETS                                  */
/* -------------------------------------------------------------------------- */

export async function ticketExists(PSTID, ANSID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT TOP 1 FTKID FROM dbo.FAQTICKETS
     WHERE PSTID = @PSTID
       AND ((@ANSID IS NULL AND ANSID IS NULL) OR ANSID = @ANSID)
    `,
    inputs: {
      PSTID: { type: sql.Int, value: PSTID },
      ANSID: { type: sql.Int, value: ANSID ?? null },
    },
  });

  return result.recordset.length > 0;
}

export async function hasAnyTicket(PSTID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT TOP 1 FTKID FROM dbo.FAQTICKETS WHERE PSTID = @PSTID`,
    inputs: { PSTID: { type: sql.Int, value: PSTID } },
  });

  return result.recordset.length > 0;
}

/**
 * Réserve la ligne FAQTICKETS (verrou anti double-clic via l'index unique
 * UQ_FAQTICKETS_PSTID_ANSID), avant de créer le ticket. Renvoie FTKID, ou
 * null si une ligne existe déjà.
 */
export async function reserveTicket(PSTID, ANSID, CREUSR) {
  try {
    const result = await runQuery({
      moduleUrl: import.meta.url,
      query: `
      INSERT INTO dbo.FAQTICKETS (PSTID, ANSID, CREUSR)
      OUTPUT inserted.FTKID
      VALUES (@PSTID, @ANSID, @CREUSR)
      `,
      inputs: {
        PSTID: { type: sql.Int, value: PSTID },
        ANSID: { type: sql.Int, value: ANSID ?? null },
        CREUSR: { type: sql.Int, value: CREUSR },
      },
    });
    return result.recordset[0]?.FTKID ?? null;
  } catch (err) {
    // 2601 / 2627 : violation d'unicité → ticket déjà créé.
    if ([2601, 2627].includes(err?.number)) return null;
    throw err;
  }
}

export async function completeTicket(FTKID, TCKID, TCKCOD) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `UPDATE dbo.FAQTICKETS SET TCKID = @TCKID, TCKCOD = @TCKCOD WHERE FTKID = @FTKID`,
    inputs: {
      FTKID: { type: sql.Int, value: FTKID },
      TCKID: { type: sql.Int, value: TCKID },
      TCKCOD: { type: sql.NVarChar(50), value: TCKCOD },
    },
  });
}

export async function releaseTicket(FTKID) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `DELETE FROM dbo.FAQTICKETS WHERE FTKID = @FTKID AND TCKID IS NULL`,
    inputs: { FTKID: { type: sql.Int, value: FTKID } },
  });
}

/* -------------------------------------------------------------------------- */
/*                               RÉFÉRENTIELS                                 */
/* -------------------------------------------------------------------------- */

export async function getStatuses(TYPE) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT STSID, CODE, NAME, TYPE, LVL
      FROM dbo.FAQSTATUSES
     WHERE ACTIVE = 1 AND (@TYPE IS NULL OR TYPE = @TYPE)
     ORDER BY TYPE, LVL, STSID
    `,
    inputs: { TYPE: { type: sql.NVarChar(20), value: TYPE ?? null } },
  });

  return result.recordset;
}

export async function getStatus(STSID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT STSID, CODE, NAME, TYPE, LVL FROM dbo.FAQSTATUSES WHERE STSID = @STSID`,
    inputs: { STSID: { type: sql.Int, value: STSID } },
  });

  return result.recordset[0] ?? null;
}

export async function getCategories({ includeInactive = false } = {}) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT c.CATID, c.NAME, c.DESCR, c.ACTIVE,
      (SELECT COUNT(*) FROM dbo.FAQPOSTS p WHERE p.CATID = c.CATID AND p.DLTD = 0) AS POSTCOUNT
      FROM dbo.FAQCATEGORIES AS c
     WHERE @ALL = 1 OR c.ACTIVE = 1
     ORDER BY c.ACTIVE DESC, c.NAME
    `,
    inputs: { ALL: { type: sql.Bit, value: includeInactive ? 1 : 0 } },
  });

  return result.recordset;
}

export async function getCategory(CATID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT CATID, NAME, DESCR, ACTIVE FROM dbo.FAQCATEGORIES WHERE CATID = @CATID`,
    inputs: { CATID: { type: sql.Int, value: CATID } },
  });

  return result.recordset[0] ?? null;
}

export async function categoryNameTaken(NAME, EXCLUDE = null) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT TOP 1 CATID FROM dbo.FAQCATEGORIES
     WHERE ACTIVE = 1 AND NAME = @NAME AND (@EXCLUDE IS NULL OR CATID <> @EXCLUDE)
    `,
    inputs: {
      NAME: { type: sql.NVarChar(100), value: NAME },
      EXCLUDE: { type: sql.Int, value: EXCLUDE },
    },
  });

  return result.recordset.length > 0;
}

export async function createCategory({ NAME, DESCR, CREUSR }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    INSERT INTO dbo.FAQCATEGORIES (NAME, DESCR, CREUSR)
    OUTPUT inserted.CATID
    VALUES (@NAME, @DESCR, @CREUSR)
    `,
    inputs: {
      NAME: { type: sql.NVarChar(100), value: NAME },
      DESCR: { type: sql.NVarChar(500), value: DESCR ?? null },
      CREUSR: { type: sql.Int, value: CREUSR },
    },
  });

  return result.recordset[0]?.CATID ?? null;
}

export async function updateCategory(CATID, { NAME, DESCR, ACTIVE }) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE dbo.FAQCATEGORIES
       SET NAME = COALESCE(@NAME, NAME),
           DESCR = CASE WHEN @SETDESCR = 1 THEN @DESCR ELSE DESCR END,
           ACTIVE = COALESCE(@ACTIVE, ACTIVE),
           UPDDAT = SYSUTCDATETIME()
     WHERE CATID = @CATID
    `,
    inputs: {
      CATID: { type: sql.Int, value: CATID },
      NAME: { type: sql.NVarChar(100), value: NAME ?? null },
      SETDESCR: { type: sql.Bit, value: DESCR !== undefined ? 1 : 0 },
      DESCR: { type: sql.NVarChar(500), value: DESCR ?? null },
      ACTIVE: {
        type: sql.Bit,
        value: ACTIVE === undefined ? null : ACTIVE ? 1 : 0,
      },
    },
  });
}

/**
 * Applications proposées dans les sélecteurs (application concernée).
 * APPCODS null = toutes les applications actives (modérateurs).
 */
export async function getApplications(APPCODS = null) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT APPID, APPNAM, APPCOD, APPDES
      FROM USERSMANAGER.dbo.APPLICATIONS
     WHERE ACTIVE = 1
       AND APPCOD NOT IN ('HOME', 'BAS')
       AND (@ALL = 1 OR APPCOD IN (SELECT [value] FROM OPENJSON(@APPCODS)))
     ORDER BY APPNAM
    `,
    inputs: {
      ALL: { type: sql.Bit, value: APPCODS === null ? 1 : 0 },
      APPCODS: {
        type: sql.NVarChar(sql.MAX),
        value: JSON.stringify(APPCODS ?? []),
      },
    },
  });

  return result.recordset;
}

/* -------------------------------------------------------------------------- */
/*                                MODÉRATEURS                                 */
/* -------------------------------------------------------------------------- */

export async function getModerators() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT m.MODID, m.USRID,
      COALESCE(${USER_NAME("u")}, CONCAT('Utilisateur #', m.USRID)) AS USRNAM,
      u.EMAIL, m.ACTIVE, m.CREDAT
      FROM dbo.FAQMODERATORS AS m
      LEFT JOIN USERSMANAGER.dbo.USERS AS u ON u.USRID = m.USRID
     WHERE m.ACTIVE = 1
     ORDER BY USRNAM
    `,
  });

  return result.recordset;
}

export async function isModerator(USRID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT TOP 1 MODID FROM dbo.FAQMODERATORS WHERE USRID = @USRID AND ACTIVE = 1`,
    inputs: { USRID: { type: sql.Int, value: USRID } },
  });

  return result.recordset.length > 0;
}

export async function addModerator(USRID, CREUSR) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    IF EXISTS (SELECT 1 FROM dbo.FAQMODERATORS WHERE USRID = @USRID)
      UPDATE dbo.FAQMODERATORS SET ACTIVE = 1 WHERE USRID = @USRID;
    ELSE
      INSERT INTO dbo.FAQMODERATORS (USRID, CREUSR) VALUES (@USRID, @CREUSR);
    `,
    inputs: {
      USRID: { type: sql.Int, value: USRID },
      CREUSR: { type: sql.Int, value: CREUSR },
    },
  });
}

export async function removeModerator(USRID) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `UPDATE dbo.FAQMODERATORS SET ACTIVE = 0 WHERE USRID = @USRID`,
    inputs: { USRID: { type: sql.Int, value: USRID } },
  });
}

/** Emails des modérateurs actifs (notification des nouvelles publications). */
export async function getModeratorEmails() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT DISTINCT u.EMAIL
      FROM dbo.FAQMODERATORS AS m
      INNER JOIN USERSMANAGER.dbo.USERS AS u ON u.USRID = m.USRID
     WHERE m.ACTIVE = 1 AND u.EMAIL IS NOT NULL AND u.EMAIL <> ''
    `,
  });

  return result.recordset.map((r) => r.EMAIL);
}

/** Auteurs ayant déjà répondu à une publication (hors USRID). */
export async function getParticipantEmails(PSTID, EXCLUDE_USRID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT DISTINCT u.EMAIL
      FROM (
        SELECT CREUSR FROM dbo.FAQPOSTS WHERE PSTID = @PSTID
        UNION SELECT CREUSR FROM dbo.FAQANSWERS WHERE PSTID = @PSTID AND DLTD = 0
      ) AS x
      INNER JOIN USERSMANAGER.dbo.USERS AS u ON u.USRID = x.CREUSR
     WHERE x.CREUSR <> @EXCLUDE AND u.EMAIL IS NOT NULL AND u.EMAIL <> ''
    `,
    inputs: {
      PSTID: { type: sql.Int, value: PSTID },
      EXCLUDE: { type: sql.Int, value: EXCLUDE_USRID ?? 0 },
    },
  });

  return result.recordset.map((r) => r.EMAIL);
}

/* -------------------------------------------------------------------------- */
/*                                STATISTIQUES                                */
/* -------------------------------------------------------------------------- */

/**
 * Chiffres clés (page Statistiques), calculés sur les publications visibles
 * par l'utilisateur. Plusieurs jeux de résultats en une requête.
 */
export async function getStats(ctx) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;

    SELECT p.PSTID, p.TYPE, p.TITLE, p.CATID, p.APPID, p.STSID, p.CREUSR,
      p.CREDAT, p.VIEWS,
      CASE WHEN EXISTS (
        SELECT 1 FROM dbo.FAQANSWERS an WHERE an.PSTID = p.PSTID AND an.DLTD = 0
      ) THEN 1 ELSE 0 END AS HASANS,
      CASE WHEN EXISTS (
        SELECT 1 FROM dbo.FAQANSWERS an
         WHERE an.PSTID = p.PSTID AND an.DLTD = 0 AND an.VALIDATED = 1
      ) THEN 1 ELSE 0 END AS HASVAL,
      (SELECT MIN(an.CREDAT) FROM dbo.FAQANSWERS an
        WHERE an.PSTID = p.PSTID AND an.DLTD = 0 AND an.CREUSR <> p.CREUSR) AS FIRSTANS
      INTO #P
      FROM dbo.FAQPOSTS AS p
      LEFT JOIN USERSMANAGER.dbo.APPLICATIONS AS a ON a.APPID = p.APPID
     WHERE p.DLTD = 0 AND ${VISIBILITY};

    DECLARE @ANSWERS INT = (
      SELECT COUNT(*) FROM dbo.FAQANSWERS an
       INNER JOIN #P x ON x.PSTID = an.PSTID WHERE an.DLTD = 0);
    DECLARE @LIKES INT = (
      SELECT COUNT(*) FROM dbo.FAQANSWERLIKES l
       INNER JOIN dbo.FAQANSWERS an ON an.ANSID = l.ANSID
       INNER JOIN #P x ON x.PSTID = an.PSTID WHERE an.DLTD = 0);
    DECLARE @TICKETS INT = (
      SELECT COUNT(*) FROM dbo.FAQTICKETS t
       INNER JOIN #P x ON x.PSTID = t.PSTID WHERE t.TCKID IS NOT NULL);

    -- 1. Totaux
    SELECT
      ISNULL(SUM(CASE WHEN TYPE = 'QUESTION' THEN 1 ELSE 0 END), 0) AS QUESTIONS,
      ISNULL(SUM(CASE WHEN TYPE = 'SUGGESTION' THEN 1 ELSE 0 END), 0) AS SUGGESTIONS,
      ISNULL(SUM(CASE WHEN TYPE = 'QUESTION' AND HASVAL = 1 THEN 1 ELSE 0 END), 0) AS RESOLVED,
      ISNULL(SUM(CASE WHEN HASANS = 0 THEN 1 ELSE 0 END), 0) AS UNANSWERED,
      @ANSWERS AS ANSWERS,
      @LIKES AS LIKES,
      ISNULL(SUM(CAST(VIEWS AS BIGINT)), 0) AS VIEWS,
      @TICKETS AS TICKETS,
      AVG(CASE WHEN FIRSTANS IS NOT NULL
        THEN CAST(DATEDIFF(MINUTE, CREDAT, FIRSTANS) AS FLOAT) / 60.0 END) AS AVGFIRSTANSWERHOURS
    FROM #P;

    -- 2. Répartition par statut
    SELECT s.STSID, s.CODE, s.NAME, s.TYPE, s.LVL, COUNT(x.PSTID) AS N
      FROM dbo.FAQSTATUSES s
      LEFT JOIN #P x ON x.STSID = s.STSID
     WHERE s.ACTIVE = 1
     GROUP BY s.STSID, s.CODE, s.NAME, s.TYPE, s.LVL
     ORDER BY s.TYPE, s.LVL;

    -- 3. Catégories les plus actives
    SELECT TOP 8 c.CATID, c.NAME, COUNT(*) AS N
      FROM #P x INNER JOIN dbo.FAQCATEGORIES c ON c.CATID = x.CATID
     GROUP BY c.CATID, c.NAME
     ORDER BY N DESC;

    -- 4. Applications les plus citées
    SELECT TOP 8 a.APPID, a.APPNAM AS NAME, COUNT(*) AS N
      FROM #P x INNER JOIN USERSMANAGER.dbo.APPLICATIONS a ON a.APPID = x.APPID
     GROUP BY a.APPID, a.APPNAM
     ORDER BY N DESC;

    -- 5. Meilleurs contributeurs (réponses, bonnes réponses, likes reçus)
    SELECT TOP 8 an.CREUSR AS USRID,
      COALESCE(${USER_NAME("u")}, CONCAT('Utilisateur #', an.CREUSR)) AS USRNAM,
      COUNT(*) AS ANSWERS,
      SUM(CASE WHEN an.VALIDATED = 1 THEN 1 ELSE 0 END) AS VALIDATED,
      SUM(lc.N) AS LIKES
      FROM dbo.FAQANSWERS an
      INNER JOIN #P x ON x.PSTID = an.PSTID
      LEFT JOIN USERSMANAGER.dbo.USERS u ON u.USRID = an.CREUSR
      OUTER APPLY (
        SELECT COUNT(*) AS N FROM dbo.FAQANSWERLIKES l WHERE l.ANSID = an.ANSID
      ) AS lc
     WHERE an.DLTD = 0
     GROUP BY an.CREUSR, u.FSTNAM, u.LSTNAM
     ORDER BY VALIDATED DESC, ANSWERS DESC, LIKES DESC;

    -- 6. Activité des 12 derniers mois
    SELECT FORMAT(m.MONTHSTART, 'yyyy-MM') AS MONTH,
      (SELECT COUNT(*) FROM #P x WHERE x.TYPE = 'QUESTION'
         AND x.CREDAT >= m.MONTHSTART AND x.CREDAT < DATEADD(MONTH, 1, m.MONTHSTART)) AS QUESTIONS,
      (SELECT COUNT(*) FROM #P x WHERE x.TYPE = 'SUGGESTION'
         AND x.CREDAT >= m.MONTHSTART AND x.CREDAT < DATEADD(MONTH, 1, m.MONTHSTART)) AS SUGGESTIONS,
      (SELECT COUNT(*) FROM dbo.FAQANSWERS an INNER JOIN #P x ON x.PSTID = an.PSTID
        WHERE an.DLTD = 0 AND an.CREDAT >= m.MONTHSTART
          AND an.CREDAT < DATEADD(MONTH, 1, m.MONTHSTART)) AS ANSWERS
    FROM (
      SELECT DATEADD(MONTH, -n.N, DATEFROMPARTS(YEAR(SYSUTCDATETIME()), MONTH(SYSUTCDATETIME()), 1)) AS MONTHSTART
      FROM (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11)) AS n(N)
    ) AS m
    ORDER BY m.MONTHSTART;

    -- 7. Publications les plus consultées
    SELECT TOP 5 x.PSTID, x.TYPE, x.TITLE, x.VIEWS
      FROM #P x
     ORDER BY x.VIEWS DESC, x.CREDAT DESC;

    DROP TABLE #P;
    `,
    inputs: visibilityInputs(ctx),
  });

  return result.recordsets;
}

/* -------------------------------------------------------------------------- */
/*                              PIÈCES JOINTES                                */
/* -------------------------------------------------------------------------- */

/**
 * Pièces jointes FAQ (base "attachments", table ATTACHMENTS du module
 * files) : APPCODE "FAQ", ENTITYTYPE "FAQPST" (publication) ou "FAQANS"
 * (réponse), ENTITYID = PSTID / ANSID. L'envoi et la suppression passent
 * par les routes génériques /api/files (upload / delete).
 */
export const ATTACHMENT_TYPES = { POST: "FAQPST", ANSWER: "FAQANS" };

export async function getAttachments(ENTITYTYPE, ENTITYIDS) {
  if (!ENTITYIDS.length) return [];

  const result = await runQuery({
    moduleUrl: import.meta.url,
    dbConnectionName: "attachments",
    query: `
    SELECT ID, FILECODE, APPCODE, ENTITYTYPE, ENTITYID, ORIGINALNAME,
      STOREDNAME, RELATIVEPATH, MIMETYPE, EXTENSION, COMPRESSED,
      ORIGINALSIZEBYTES, SIZEBYTES, STATUS, UPLOADEDBY, CREATEDAT
      FROM ATTACHMENTS
     WHERE APPCODE = 'FAQ'
       AND ENTITYTYPE = @ENTITYTYPE
       AND ENTITYID IN (SELECT [value] FROM OPENJSON(@IDS))
       AND DELETEDAT IS NULL
     ORDER BY CREATEDAT ASC, ID ASC
    `,
    inputs: {
      ENTITYTYPE: { type: sql.VarChar(100), value: ENTITYTYPE },
      IDS: {
        type: sql.NVarChar(sql.MAX),
        value: JSON.stringify(ENTITYIDS.map(String)),
      },
    },
  });

  return result.recordset;
}

/** Retire (suppression logique) les pièces jointes d'entités supprimées. */
export async function deleteAttachments(ENTITYTYPE, ENTITYIDS) {
  if (!ENTITYIDS.length) return;

  await runQuery({
    moduleUrl: import.meta.url,
    dbConnectionName: "attachments",
    query: `
    UPDATE ATTACHMENTS SET DELETEDAT = SYSDATETIME()
     WHERE APPCODE = 'FAQ'
       AND ENTITYTYPE = @ENTITYTYPE
       AND ENTITYID IN (SELECT [value] FROM OPENJSON(@IDS))
       AND DELETEDAT IS NULL
    `,
    inputs: {
      ENTITYTYPE: { type: sql.VarChar(100), value: ENTITYTYPE },
      IDS: {
        type: sql.NVarChar(sql.MAX),
        value: JSON.stringify(ENTITYIDS.map(String)),
      },
    },
  });
}

export async function getAnswerIds(PSTID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT ANSID FROM dbo.FAQANSWERS WHERE PSTID = @PSTID`,
    inputs: { PSTID: { type: sql.Int, value: PSTID } },
  });

  return result.recordset.map((r) => r.ANSID);
}

/* -------------------------------------------------------------------------- */
/*                                   UTILS                                    */
/* -------------------------------------------------------------------------- */

/** Échappe les jokers LIKE ([, %, _) d'une saisie utilisateur. */
function escapeLike(value) {
  return String(value).replace(/[[%_]/g, (c) => `[${c}]`);
}
