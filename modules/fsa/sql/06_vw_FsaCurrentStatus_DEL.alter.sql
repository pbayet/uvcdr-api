/* ═══════════════════════════════════════════════════════════════
   vw_FsaCurrentStatus — prise en compte des suppressions de validation

   Supprimer une validation insère une ligne FSAVALID VALTYPCOD = 'DEL'
   (cf. controllers.deleteValidation). L'ancienne version de la vue
   excluait ces lignes (WHERE VALTYPCOD <> 'DEL') AVANT de chercher le
   dernier événement par dossier/service : un REF supprimé restait donc
   le dernier avis du service et le dossier restait "Refusé".

   Correctif : les DEL participent au classement (LatestStatus). Un DEL
   en dernière position n'est compté ni comme VAL (DONE_COUNT) ni comme
   REF (Refusals) : l'avis du service repart de zéro.
═══════════════════════════════════════════════════════════════ */
ALTER VIEW dbo.vw_FsaCurrentStatus
AS
WITH Required AS (
  SELECT
    DISTINCT NUMDOS,
    SERVGES
  FROM
    dbo.vw_FsaServicesMustValidate
),
-- Inclut les DEL : une suppression doit pouvoir être le dernier événement
RequiredValidations AS (
  SELECT
    DISTINCT v.VALIDID,
    v.NUMDOS,
    g.SERVGES,
    v.VALTYPCOD,
    v.CREDAT
  FROM
    dbo.FSAVALID AS v
    INNER JOIN dbo.FSAGES AS g ON g.NUMGES = v.NUMGES
    INNER JOIN Required AS r ON r.NUMDOS = v.NUMDOS
    AND r.SERVGES = g.SERVGES
),
-- Dernier événement (VAL, REF ou DEL) par dossier/service
LatestStatus AS (
  SELECT
    NUMDOS,
    SERVGES,
    VALTYPCOD,
    CREDAT,
    ROW_NUMBER() OVER (
      PARTITION BY NUMDOS, SERVGES
      ORDER BY CREDAT DESC, VALIDID DESC
    ) AS RN
  FROM
    RequiredValidations
),
Completion AS (
  SELECT
    r.NUMDOS,
    COUNT(DISTINCT r.SERVGES) AS REQUIRED_COUNT,
    COUNT(DISTINCT CASE WHEN ls.VALTYPCOD = 'VAL' AND ls.RN = 1 THEN ls.SERVGES END) AS DONE_COUNT,
    MAX(CASE WHEN ls.VALTYPCOD = 'VAL' AND ls.RN = 1 THEN ls.CREDAT END) AS COMPLETEDAT
  FROM
    Required AS r
    LEFT OUTER JOIN LatestStatus AS ls ON ls.NUMDOS = r.NUMDOS
    AND ls.SERVGES = r.SERVGES
  GROUP BY
    r.NUMDOS
),
-- Un dossier n'est "refusé" que si au moins un service est ENCORE en refus
-- (dernier événement = REF, ni remplacé ni supprimé)
Refusals AS (
  SELECT
    NUMDOS,
    MIN(CREDAT) AS FIRSTREFDAT
  FROM
    LatestStatus
  WHERE
    RN = 1
    AND VALTYPCOD = 'REF'
  GROUP BY
    NUMDOS
),
Computed AS (
  SELECT
    raw.NUMDOS,
    raw.STATUS_CREDAT,
    raw.EAVDAT,
    CASE
      WHEN ref.FIRSTREFDAT IS NOT NULL
      AND DATEADD(DAY, COALESCE(s.ARCDELAY, 90), ref.FIRSTREFDAT) < SYSUTCDATETIME() THEN 'ARC'
      WHEN ref.FIRSTREFDAT IS NOT NULL THEN 'REF'
      WHEN comp.REQUIRED_COUNT > 0
      AND comp.DONE_COUNT >= comp.REQUIRED_COUNT
      AND DATEADD(
        DAY,
        COALESCE(s.ARCDELAY, 90),
        comp.COMPLETEDAT
      ) < SYSUTCDATETIME() THEN 'ARC'
      WHEN comp.REQUIRED_COUNT > 0
      AND comp.DONE_COUNT >= comp.REQUIRED_COUNT THEN 'VAL'
      ELSE raw.CODETA
    END AS CODETA,
    CASE
      WHEN ref.FIRSTREFDAT IS NOT NULL THEN 'Refusé'
      WHEN comp.REQUIRED_COUNT > 0
      AND comp.DONE_COUNT >= comp.REQUIRED_COUNT THEN 'Validé'
      ELSE NULL
    END AS DESETA_FALLBACK
  FROM
    dbo.vw_FsaCurrentStatusRaw AS raw
    LEFT OUTER JOIN Completion AS comp ON comp.NUMDOS = raw.NUMDOS
    LEFT OUTER JOIN Refusals AS ref ON ref.NUMDOS = raw.NUMDOS
    LEFT OUTER JOIN dbo.FSASETTINGS AS s ON s.SETID = 1
)
SELECT
  c.NUMDOS,
  fs.STAID,
  c.CODETA,
  CASE
    WHEN c.CODETA = 'ARC' THEN COALESCE(c.DESETA_FALLBACK, fs.DESETA)
    ELSE COALESCE(fs.DESETA, c.DESETA_FALLBACK)
  END AS DESETA,
  c.STATUS_CREDAT,
  c.EAVDAT
FROM
  Computed AS c
  LEFT OUTER JOIN dbo.FSASTA AS fs ON fs.CODETA = c.CODETA
GO
