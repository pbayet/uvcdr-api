/* =============================================================================
   TEST — services.getFsas(USRID, type, filters)
   Reproduction exacte de buildFolderListQuery() + getTypeFilter() +
   folderListInputs(), pour exécution dans SSMS.

   Retourne 2 jeux de résultats :
     1. la page de dossiers (rows)
     2. TOTAL (après filtres) / TOTAL_ALL (onglet entier)

   NOUVEAU — statut des dossiers repris de l'ancienne application
   (FSAENT.APPVRS = 'REPRISE-APP_FSA', statut courant 'ARC') : calculé à partir
   des 5 validations de REPRISE_FSA_SuiviDossier (ValidDDO, ValidCG,
   ValidOENO, ValidDG, ValidMARK — 'Non' équivaut à NULL) :
     - au moins 1 'Refus' ou 'Validation Partielle' -> REF / Refusé
     - les 5 'Validé'                                -> VAL / Validé
     - sinon                                         -> ARC / Archivé (inchangé)
   Le filtre d'onglet (@TYPE) reste sur le statut courant : ces dossiers
   restent dans l'onglet Archives, seuls le statut affiché, le filtre
   "Statut" (F_CODETA) et ENT_IS_REF changent.
   ============================================================================= */
USE [FSA];
GO

SET NOCOUNT ON;

/* ----------------------------- Paramètres ---------------------------------- */
DECLARE @TYPE       VARCHAR(10) = 'default';  -- default | archive | delete | all
DECLARE @USRID_VAL  INT         = NULL;       -- USRID de l'utilisateur connecté

-- Filtres (NULL = filtre désactivé). Listes = tableaux JSON.
DECLARE @SEARCH_RAW    NVARCHAR(200) = NULL;  -- texte libre, ex. N'dupont'
DECLARE @STATUS_VAL    NVARCHAR(MAX) = NULL;  -- ex. N'["BRO","EAV"]'
DECLARE @CLIENTS_VAL   NVARCHAR(MAX) = NULL;  -- ex. N'["C00123"]'
DECLARE @DEMS_VAL      NVARCHAR(MAX) = NULL;  -- ex. N'["DMA"]'
DECLARE @MYVAL_VAL     NVARCHAR(MAX) = NULL;  -- ex. N'["NONE","ONLY_ME"]'
DECLARE @MYSERVGES_VAL VARCHAR(50)   = NULL;  -- SERVGES de l'utilisateur

-- Pagination (page 1-indexée ; @LIMIT NULL = tout renvoyer)
DECLARE @PAGE  INT = NULL;
DECLARE @LIMIT INT = NULL;

/* ------------------- Dérivés (getTypeFilter / folderListInputs) ------------ */
DECLARE @CODETA_VAL VARCHAR(15), @INVERT_CODETA_VAL BIT, @DELETED_VAL BIT;
SELECT @CODETA_VAL        = CASE @TYPE WHEN 'archive' THEN 'ARC' WHEN 'delete' THEN NULL WHEN 'all' THEN NULL ELSE 'ARC' END,
       @INVERT_CODETA_VAL = CASE @TYPE WHEN 'archive' THEN 0 WHEN 'delete' THEN 0 WHEN 'all' THEN 0 ELSE 1 END,
       @DELETED_VAL       = CASE @TYPE WHEN 'archive' THEN 0 WHEN 'delete' THEN 1 WHEN 'all' THEN NULL ELSE 0 END;

-- Échappement [ % _ comme dans l'API (recherche littérale)
DECLARE @SEARCH_VAL NVARCHAR(210) = CASE WHEN NULLIF(@SEARCH_RAW, N'') IS NULL THEN NULL
    ELSE N'%' + REPLACE(REPLACE(REPLACE(@SEARCH_RAW, N'[', N'[[]'), N'%', N'[%]'), N'_', N'[_]') + N'%' END;

DECLARE @LIMIT_VAL  INT = @LIMIT;
DECLARE @OFFSET_VAL INT = CASE WHEN @LIMIT IS NOT NULL
    THEN (CASE WHEN ISNULL(@PAGE, 1) < 1 THEN 1 ELSE ISNULL(@PAGE, 1) END - 1) * @LIMIT END;

/* ------------------------------ Nettoyage ---------------------------------- */
DROP TABLE IF EXISTS #MSV;
DROP TABLE IF EXISTS #VS;
DROP TABLE IF EXISTS #FOLDERS;
DROP TABLE IF EXISTS #LEGACY;

/* ------------------------------ Requête ------------------------------------ */
-- Statut des dossiers repris, d'après les 5 validations de l'ancienne appli.
-- Seuls les dossiers tranchés (VAL / REF) sont gardés : les autres restent ARC.
SELECT NUMDOS, CODETA, DESETA
INTO #LEGACY
FROM (
    SELECT
        CAST(s.NumDossier AS VARCHAR(50)) AS NUMDOS,
        CASE
            WHEN k.NB_REF > 0 THEN 'REF'
            WHEN k.NB_VAL = 5 THEN 'VAL'
        END AS CODETA,
        CASE
            WHEN k.NB_REF > 0 THEN N'Refusé'
            WHEN k.NB_VAL = 5 THEN N'Validé'
        END AS DESETA
    FROM dbo.REPRISE_FSA_SuiviDossier s
    CROSS APPLY (
        SELECT
            SUM(CASE WHEN v.ETAT COLLATE French_CI_AI = N'Validé' THEN 1 ELSE 0 END) AS NB_VAL,
            SUM(CASE WHEN v.ETAT COLLATE French_CI_AI IN (N'Refus', N'Validation Partielle') THEN 1 ELSE 0 END) AS NB_REF
        FROM (VALUES (s.ValidDDO), (s.ValidCG), (s.ValidOENO), (s.ValidDG), (s.ValidMARK)) AS v(ETAT)
    ) k
    WHERE s.RN_DOUBLON = 1
) x
WHERE CODETA IS NOT NULL;

CREATE CLUSTERED INDEX IX_LEGACY ON #LEGACY (NUMDOS);

SELECT DISTINCT NUMDOS, SERVGES
INTO #MSV
FROM dbo.vw_FsaServicesMustValidate;

SELECT DISTINCT NUMDOS, GES_SERVGES AS SERVGES
INTO #VS
FROM dbo.vw_FsaValidations;

CREATE CLUSTERED INDEX IX_MSV ON #MSV (NUMDOS);
CREATE CLUSTERED INDEX IX_VS ON #VS (NUMDOS);

SELECT
    e.NUMDOS      AS ENT_NUMDOS,
    e.NOMDOS      AS ENT_NOMDOS,
    e.NOTDOS      AS ENT_NOTDOS,
    COALESCE(lg.CODETA, cs.CODETA) AS ENT_CODETA,
    COALESCE(lg.DESETA, cs.DESETA) AS ENT_DESETA,
    e.DELETED     AS ENT_DELETED,
    e.CREDAT      AS ENT_CREDAT,
    cs.EAVDAT     AS ENT_EAVDAT,
    CAST(CASE WHEN e.APPVRS = 'REPRISE-APP_FSA' THEN 1 ELSE 0 END AS BIT) AS ENT_IS_LEGACY,

    COALESCE(NULLIF(CONCAT(uges.LSTNAM, ' ', uges.FSTNAM), ' '), e.CREUSR) AS ENT_GES_GESNAM,
    ges.NOMGES    AS ENT_GES_NOMGES,

    e.NUMDEM      AS ENT_DEM_NUMDEM,
    CASE
        WHEN e.APPVRS = 'REPRISE-APP_FSA' THEN e.CREUSR
        ELSE CONCAT(udem.LSTNAM, ' ', udem.FSTNAM)
    END           AS ENT_DEM_GESNAM,
    dem.NOMGES    AS ENT_DEM_NOMGES,

    c.BPCNUM      AS CLI_BPCNUM,
    c.BPCNAM      AS CLI_BPCNAM,
    c.CLINAM      AS CLI_CLINAM,
    c.CLIACT      AS CLI_CLIACT,
    c.NOMACT      AS CLI_NOMACT,
    c.CLICCON     AS REQ_CLI_CLICCON,
    c.CLIPAY      AS REQ_CLI_CLIPAY,

    myval.VALTYPCOD              AS ENT_MY_VALIDATION_CODE,
    ISNULL(valserv.SERVICES, '') AS ENT_VALIDATED_SERVICES,

    COALESCE(cs.EAVDAT, e.CREDAT) AS F_SORTDAT,
    CASE
        WHEN cs.CODETA <> 'ARC' THEN cs.CODETA
        WHEN lg.CODETA IS NOT NULL THEN lg.CODETA
        WHEN e.APPVRS = 'REPRISE-APP_FSA' THEN 'ARC'
        WHEN EXISTS (
            SELECT 1 FROM dbo.FSAVALID r
            WHERE r.NUMDOS = e.NUMDOS AND r.VALTYPCOD = 'REF'
        ) THEN 'REF'
        ELSE 'VAL'
    END AS F_CODETA,
    CAST(CASE WHEN lg.CODETA = 'REF' THEN 1 ELSE 0 END AS BIT) AS F_LEGACY_REF,
    CAST(ISNULL(msv.MY_REQ, 0) AS BIT) AS F_MY_REQUIRED,
    CASE WHEN myval.VALTYPCOD IN ('VAL', 'REF') THEN myval.VALTYPCOD ELSE 'NONE' END AS F_MY_CODE,
    CAST(CASE
        WHEN msv.MY_REQ = 1
         AND ISNULL(myval.VALTYPCOD, 'NONE') NOT IN ('VAL', 'REF')
         AND msv.DONE_COUNT = msv.REQ_COUNT - 1
        THEN 1 ELSE 0
    END AS BIT) AS F_ONLY_ME

INTO #FOLDERS
FROM dbo.FSAENT e
INNER JOIN dbo.vw_FsaCurrentStatus cs ON cs.NUMDOS = e.NUMDOS
LEFT JOIN dbo.FSAGES ges ON ges.NUMGES = e.NUMGES
LEFT JOIN USERSMANAGER.dbo.USERS uges ON uges.USRID = e.GESUSRID
LEFT JOIN dbo.FSAGES dem ON dem.NUMGES = e.NUMDEM
LEFT JOIN dbo.FSACLIENTS c ON c.NUMDOS = e.NUMDOS
LEFT JOIN #LEGACY lg
       ON lg.NUMDOS = e.NUMDOS
      AND e.APPVRS = 'REPRISE-APP_FSA'
      AND cs.CODETA = 'ARC'
OUTER APPLY (
    SELECT TOP 1 u.LSTNAM, u.FSTNAM
    FROM USERSMANAGER.dbo.POSITIONS p
    INNER JOIN USERSMANAGER.dbo.USERS u ON u.POSID = p.POSID
    WHERE p.POSCOD = e.NUMDEM
    ORDER BY u.USRID
) udem
OUTER APPLY (
    SELECT TOP 1 v.VALTYPCOD
    FROM dbo.FSAVALID v
    INNER JOIN dbo.FSAGES g2 ON g2.NUMGES = v.NUMGES
    INNER JOIN dbo.FSAGES_UTILISATEURS gu ON gu.GESID = g2.GESID
    WHERE v.NUMDOS = e.NUMDOS AND gu.USRID = @USRID_VAL
    ORDER BY v.CREDAT DESC, v.VALIDID DESC
) myval
OUTER APPLY (
    SELECT STRING_AGG(vs.SERVGES, ',') AS SERVICES
    FROM #VS vs
    WHERE vs.NUMDOS = e.NUMDOS
) valserv
OUTER APPLY (
    SELECT
        COUNT(*) AS REQ_COUNT,
        COUNT(vs.SERVGES) AS DONE_COUNT,
        MAX(CASE WHEN m.SERVGES = @MYSERVGES_VAL THEN 1 ELSE 0 END) AS MY_REQ
    FROM #MSV m
    LEFT JOIN #VS vs ON vs.NUMDOS = m.NUMDOS AND vs.SERVGES = m.SERVGES
    WHERE m.NUMDOS = e.NUMDOS
) msv
WHERE (@DELETED_VAL IS NULL OR e.DELETED = @DELETED_VAL)
  AND (
        @CODETA_VAL IS NULL
        OR (@INVERT_CODETA_VAL = 1 AND cs.CODETA <> @CODETA_VAL)
        OR (@INVERT_CODETA_VAL = 0 AND cs.CODETA = @CODETA_VAL)
      );

-- 1. Page demandée, complétée des colonnes d'affichage
SELECT
    f.ENT_NUMDOS, f.ENT_NOMDOS, f.ENT_NOTDOS, f.ENT_CODETA, f.ENT_DESETA,
    f.ENT_DELETED, f.ENT_CREDAT, f.ENT_EAVDAT, f.ENT_IS_LEGACY,
    f.ENT_GES_GESNAM, f.ENT_GES_NOMGES,
    f.ENT_DEM_NUMDEM, f.ENT_DEM_GESNAM, f.ENT_DEM_NOMGES,
    f.CLI_BPCNUM, f.CLI_BPCNAM, f.CLI_CLINAM, f.CLI_CLIACT, f.CLI_NOMACT,

    f.REQ_CLI_CLICCON,
    f.REQ_CLI_CLIPAY,
    pr.TCLCOD     AS REQ_PRO_TCLCOD,
    pr.ITMFMT     AS REQ_PRO_ITMFMT,
    pr.ITMAPP     AS REQ_PRO_ITMAPP,
    pr.ITMCEP     AS REQ_PRO_ITMCEP,
    pr.ITMCOU     AS REQ_PRO_ITMCOU,
    pr.ITMGAM     AS REQ_PRO_ITMGAM,
    pr.ITMMAR     AS REQ_PRO_ITMMAR,
    pr.ITMQUA     AS REQ_PRO_ITMQUA,
    pr.ITMTYP     AS REQ_PRO_ITMTYP,
    ve.DATMAD     AS REQ_VEN_DATMAD,
    ve.VOLANN     AS REQ_VEN_VOLANN,
    ve.PRIANN     AS REQ_VEN_PRIANN,
    ISNULL(nom.NOM_COUNT, 0)     AS REQ_NOM_COUNT,

    f.ENT_MY_VALIDATION_CODE,
    ISNULL(pj.PJ_COUNT, 0)       AS ENT_PJ_COUNT,
    f.ENT_VALIDATED_SERVICES,
    CAST(CASE WHEN refval.NUMDOS IS NOT NULL OR f.F_LEGACY_REF = 1 THEN 1 ELSE 0 END AS BIT) AS ENT_IS_REF

FROM (
    SELECT f.*
    FROM #FOLDERS f
    WHERE
        (@SEARCH_VAL IS NULL OR
            f.ENT_NUMDOS      COLLATE Latin1_General_CI_AI LIKE @SEARCH_VAL OR
            f.ENT_NOMDOS      COLLATE Latin1_General_CI_AI LIKE @SEARCH_VAL OR
            f.ENT_NOTDOS      COLLATE Latin1_General_CI_AI LIKE @SEARCH_VAL OR
            f.ENT_GES_GESNAM  COLLATE Latin1_General_CI_AI LIKE @SEARCH_VAL OR
            f.ENT_DEM_GESNAM  COLLATE Latin1_General_CI_AI LIKE @SEARCH_VAL OR
            f.CLI_BPCNUM      COLLATE Latin1_General_CI_AI LIKE @SEARCH_VAL OR
            f.CLI_BPCNAM      COLLATE Latin1_General_CI_AI LIKE @SEARCH_VAL OR
            f.CLI_CLINAM      COLLATE Latin1_General_CI_AI LIKE @SEARCH_VAL OR
            f.CLI_CLIACT      COLLATE Latin1_General_CI_AI LIKE @SEARCH_VAL OR
            f.ENT_DESETA      COLLATE Latin1_General_CI_AI LIKE @SEARCH_VAL)
    AND (@STATUS_VAL IS NULL OR f.F_CODETA IN (SELECT value FROM OPENJSON(@STATUS_VAL)))
    AND (@CLIENTS_VAL IS NULL OR f.CLI_BPCNUM IN (SELECT value FROM OPENJSON(@CLIENTS_VAL)))
    AND (@DEMS_VAL IS NULL OR f.ENT_DEM_NUMDEM IN (SELECT value FROM OPENJSON(@DEMS_VAL)))
    AND (@MYVAL_VAL IS NULL OR (
            f.F_MY_REQUIRED = 1 AND (
                f.F_MY_CODE IN (SELECT value FROM OPENJSON(@MYVAL_VAL))
                OR (f.F_ONLY_ME = 1 AND EXISTS (
                    SELECT 1 FROM OPENJSON(@MYVAL_VAL) WHERE value = 'ONLY_ME'))
            )))
    ORDER BY f.F_SORTDAT DESC, f.ENT_NUMDOS DESC
    OFFSET ISNULL(@OFFSET_VAL, 0) ROWS
    FETCH NEXT ISNULL(@LIMIT_VAL, 2147483647) ROWS ONLY
) f
LEFT JOIN dbo.FSAPRODUITS pr ON pr.NUMDOS = f.ENT_NUMDOS
LEFT JOIN dbo.FSAVENTES ve ON ve.NUMDOS = f.ENT_NUMDOS
OUTER APPLY (
    SELECT COUNT(*) AS NOM_COUNT
    FROM dbo.FSANOMENCLATURES n
    WHERE n.NUMDOS = f.ENT_NUMDOS AND NULLIF(n.ITMCAT, '') IS NOT NULL
) nom
OUTER APPLY (
    SELECT
        (SELECT COUNT(*) FROM dbo.vw_FolderFiles ff WHERE ff.NUMDOS = f.ENT_NUMDOS)
      + (SELECT COUNT(*) FROM dbo.FSALIENS li WHERE li.NUMDOS = f.ENT_NUMDOS AND li.NUMGES IS NULL)
        AS PJ_COUNT
) pj
OUTER APPLY (
    SELECT TOP 1 v4.NUMDOS
    FROM dbo.FSAVALID v4
    WHERE v4.NUMDOS = f.ENT_NUMDOS AND v4.VALTYPCOD = 'REF'
) refval
ORDER BY f.F_SORTDAT DESC, f.ENT_NUMDOS DESC;

-- 2. Compteurs : après filtres / onglet entier
SELECT
    (SELECT COUNT(*) FROM #FOLDERS f
     WHERE
        (@SEARCH_VAL IS NULL OR
            f.ENT_NUMDOS      COLLATE Latin1_General_CI_AI LIKE @SEARCH_VAL OR
            f.ENT_NOMDOS      COLLATE Latin1_General_CI_AI LIKE @SEARCH_VAL OR
            f.ENT_NOTDOS      COLLATE Latin1_General_CI_AI LIKE @SEARCH_VAL OR
            f.ENT_GES_GESNAM  COLLATE Latin1_General_CI_AI LIKE @SEARCH_VAL OR
            f.ENT_DEM_GESNAM  COLLATE Latin1_General_CI_AI LIKE @SEARCH_VAL OR
            f.CLI_BPCNUM      COLLATE Latin1_General_CI_AI LIKE @SEARCH_VAL OR
            f.CLI_BPCNAM      COLLATE Latin1_General_CI_AI LIKE @SEARCH_VAL OR
            f.CLI_CLINAM      COLLATE Latin1_General_CI_AI LIKE @SEARCH_VAL OR
            f.CLI_CLIACT      COLLATE Latin1_General_CI_AI LIKE @SEARCH_VAL OR
            f.ENT_DESETA      COLLATE Latin1_General_CI_AI LIKE @SEARCH_VAL)
    AND (@STATUS_VAL IS NULL OR f.F_CODETA IN (SELECT value FROM OPENJSON(@STATUS_VAL)))
    AND (@CLIENTS_VAL IS NULL OR f.CLI_BPCNUM IN (SELECT value FROM OPENJSON(@CLIENTS_VAL)))
    AND (@DEMS_VAL IS NULL OR f.ENT_DEM_NUMDEM IN (SELECT value FROM OPENJSON(@DEMS_VAL)))
    AND (@MYVAL_VAL IS NULL OR (
            f.F_MY_REQUIRED = 1 AND (
                f.F_MY_CODE IN (SELECT value FROM OPENJSON(@MYVAL_VAL))
                OR (f.F_ONLY_ME = 1 AND EXISTS (
                    SELECT 1 FROM OPENJSON(@MYVAL_VAL) WHERE value = 'ONLY_ME'))
            )))
    ) AS TOTAL,
    (SELECT COUNT(*) FROM #FOLDERS) AS TOTAL_ALL;

DROP TABLE IF EXISTS #MSV;
DROP TABLE IF EXISTS #VS;
DROP TABLE IF EXISTS #FOLDERS;
DROP TABLE IF EXISTS #LEGACY;
