/* =============================================================================
   TEST — Liste des dossiers (services.buildFolderListQuery) avec les dossiers
   repris de l'ancienne application (FSAENT.APPVRS = 'REPRISE-APP_FSA').

   Partie A : diagnostic — où passent les dossiers repris avec la requête actuelle
   Partie B : requête révisée, paramétrée comme dans l'API (getTypeFilter / getMyFsas)

   Changements de la partie B par rapport à la requête actuelle :
     1. ENT_IS_LEGACY : indique un dossier repris de l'ancienne application.
     2. Noms gestionnaire / demandeur : les dossiers repris n'ont ni GESUSRID ni
        titulaire historique du poste -> repli sur FSAENT.CREUSR (créateur
        d'origine, ex. "James FUSELIER") au lieu d'une chaîne vide ' ' ou du
        titulaire ACTUEL du poste.
     3. Demandeur résolu par OUTER APPLY TOP (1) : le LEFT JOIN POSITIONS ->
        USERS dupliquait la ligne dossier si plusieurs utilisateurs partagent
        le même poste.
     4. ENT_VALIDATED_SERVICES : GES_SERVGES est déjà dans vw_FsaValidations,
        la jointure supplémentaire sur FSAGES est retirée (même résultat).
   ============================================================================= */
USE [FSA];
GO

/* =============================================================================
   A. DIAGNOSTIC
   ============================================================================= */

-- Dossiers repris par statut calculé et par onglet de l'API
SELECT
    cs.CODETA,
    cs.DESETA,
    e.DELETED,
    COUNT(*) AS NB,
    CASE
        WHEN e.DELETED = 1        THEN 'delete'
        WHEN cs.CODETA = 'ARC'    THEN 'archive'
        ELSE 'default'
    END AS ONGLET_API
FROM dbo.FSAENT e
LEFT JOIN dbo.vw_FsaCurrentStatus cs ON cs.NUMDOS = e.NUMDOS
WHERE e.APPVRS = N'REPRISE-APP_FSA'
GROUP BY cs.CODETA, cs.DESETA, e.DELETED
ORDER BY ONGLET_API, cs.CODETA;

-- Dossiers repris absents de vw_FsaCurrentStatus (donc exclus par l'INNER JOIN)
SELECT e.NUMDOS, e.NOMDOS, e.CREDAT
FROM dbo.FSAENT e
WHERE e.APPVRS = N'REPRISE-APP_FSA'
  AND NOT EXISTS (SELECT 1 FROM dbo.vw_FsaCurrentStatus cs WHERE cs.NUMDOS = e.NUMDOS);

-- Dossiers dupliqués par la jointure demandeur actuelle (POSITIONS -> USERS)
SELECT e.NUMDOS, e.NUMDEM, COUNT(*) AS NB_LIGNES
FROM dbo.FSAENT e
LEFT JOIN USERSMANAGER.dbo.POSITIONS posdem ON posdem.POSCOD = e.NUMDEM
LEFT JOIN USERSMANAGER.dbo.USERS udem ON udem.POSID = posdem.POSID
GROUP BY e.NUMDOS, e.NUMDEM
HAVING COUNT(*) > 1;
GO

/* =============================================================================
   B. REQUÊTE RÉVISÉE
   -----------------------------------------------------------------------------
   @MODE reproduit getTypeFilter() :
     'default' -> non archivés, non supprimés
     'archive' -> archivés, non supprimés   (la plupart des dossiers repris)
     'delete'  -> supprimés
     'all'     -> tout
   @NUMGES renseigné -> reproduit getMyFsas() (valideur : dossiers à valider,
   sinon : dossiers dont il est gestionnaire).
   ============================================================================= */
DECLARE @MODE       VARCHAR(10) = 'all';
DECLARE @USRID_VAL  INT         = NULL;   -- getFsas : USRID de l'utilisateur connecté
DECLARE @NUMGES_VAL VARCHAR(15) = NULL;   -- getMyFsas : ex. 'DMA'

DECLARE @CODETA_VAL VARCHAR(15), @INVERT_CODETA_VAL BIT, @DELETED_VAL BIT;
SELECT @CODETA_VAL        = CASE @MODE WHEN 'archive' THEN 'ARC' WHEN 'default' THEN 'ARC' END,
       @INVERT_CODETA_VAL = CASE @MODE WHEN 'default' THEN 1 ELSE 0 END,
       @DELETED_VAL       = CASE @MODE WHEN 'archive' THEN 0 WHEN 'default' THEN 0 WHEN 'delete' THEN 1 END;

DECLARE @GES_VALGES BIT = (SELECT VALGES FROM dbo.FSAGES WHERE NUMGES = @NUMGES_VAL);

SELECT
    e.NUMDOS      AS ENT_NUMDOS,
    e.NOMDOS      AS ENT_NOMDOS,
    e.NOTDOS      AS ENT_NOTDOS,
    cs.CODETA     AS ENT_CODETA,
    cs.DESETA     AS ENT_DESETA,
    e.DELETED     AS ENT_DELETED,
    e.CREDAT      AS ENT_CREDAT,
    cs.EAVDAT     AS ENT_EAVDAT,
    CAST(CASE WHEN e.APPVRS = N'REPRISE-APP_FSA' THEN 1 ELSE 0 END AS BIT) AS ENT_IS_LEGACY,

    COALESCE(NULLIF(CONCAT(uges.LSTNAM, ' ', uges.FSTNAM), ' '), e.CREUSR) AS ENT_GES_GESNAM,
    ges.NOMGES    AS ENT_GES_NOMGES,

    e.NUMDEM      AS ENT_DEM_NUMDEM,
    CASE
        WHEN e.APPVRS = N'REPRISE-APP_FSA' THEN e.CREUSR
        ELSE CONCAT(udem.LSTNAM, ' ', udem.FSTNAM)
    END           AS ENT_DEM_GESNAM,
    dem.NOMGES    AS ENT_DEM_NOMGES,

    c.BPCNUM      AS CLI_BPCNUM,
    c.BPCNAM      AS CLI_BPCNAM,
    c.CLINAM      AS CLI_CLINAM,
    c.CLIACT      AS CLI_CLIACT,
    c.NOMACT      AS CLI_NOMACT,

    myval.VALTYPCOD              AS ENT_MY_VALIDATION_CODE,
    ISNULL(pj.PJ_COUNT, 0)       AS ENT_PJ_COUNT,
    ISNULL(valserv.SERVICES, '') AS ENT_VALIDATED_SERVICES,
    CAST(CASE WHEN refval.NUMDOS IS NOT NULL THEN 1 ELSE 0 END AS BIT) AS ENT_IS_REF

FROM dbo.FSAENT e
INNER JOIN dbo.vw_FsaCurrentStatus cs ON cs.NUMDOS = e.NUMDOS
LEFT JOIN dbo.FSAGES ges ON ges.NUMGES = e.NUMGES
LEFT JOIN USERSMANAGER.dbo.USERS uges ON uges.USRID = e.GESUSRID
LEFT JOIN dbo.FSAGES dem ON dem.NUMGES = e.NUMDEM
LEFT JOIN dbo.FSACLIENTS c ON c.NUMDOS = e.NUMDOS
OUTER APPLY (
    SELECT TOP (1) u.LSTNAM, u.FSTNAM
    FROM USERSMANAGER.dbo.POSITIONS p
    INNER JOIN USERSMANAGER.dbo.USERS u ON u.POSID = p.POSID
    WHERE p.POSCOD = e.NUMDEM
    ORDER BY u.USRID
) udem
OUTER APPLY (
    SELECT TOP (1) v.VALTYPCOD
    FROM dbo.FSAVALID v
    INNER JOIN dbo.FSAGES g2 ON g2.NUMGES = v.NUMGES
    INNER JOIN dbo.FSAGES_UTILISATEURS gu ON gu.GESID = g2.GESID
    WHERE v.NUMDOS = e.NUMDOS AND gu.USRID = @USRID_VAL
    ORDER BY v.CREDAT DESC, v.VALIDID DESC
) myval
OUTER APPLY (
    SELECT COUNT(*) AS PJ_COUNT FROM dbo.vw_FolderFiles f WHERE f.NUMDOS = e.NUMDOS
) pj
OUTER APPLY (
    SELECT STRING_AGG(v3.GES_SERVGES, ',') AS SERVICES
    FROM dbo.vw_FsaValidations v3
    WHERE v3.NUMDOS = e.NUMDOS
) valserv
OUTER APPLY (
    SELECT TOP (1) v4.NUMDOS
    FROM dbo.FSAVALID v4
    WHERE v4.NUMDOS = e.NUMDOS AND v4.VALTYPCOD = 'REF'
) refval
WHERE (@DELETED_VAL IS NULL OR e.DELETED = @DELETED_VAL)
  AND (
        @CODETA_VAL IS NULL
        OR (@INVERT_CODETA_VAL = 1 AND cs.CODETA <> @CODETA_VAL)
        OR (@INVERT_CODETA_VAL = 0 AND cs.CODETA = @CODETA_VAL)
      )
  -- extraWhere de getMyFsas
  AND (
        @NUMGES_VAL IS NULL
        OR (@GES_VALGES = 1 AND EXISTS (
                SELECT 1 FROM dbo.vw_FsaServicesMustValidate mv
                WHERE mv.NUMDOS = e.NUMDOS AND mv.NUMGES = @NUMGES_VAL))
        OR (ISNULL(@GES_VALGES, 0) = 0 AND e.NUMGES = @NUMGES_VAL)
      )
ORDER BY e.CREDAT DESC;
