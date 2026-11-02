/* =============================================================================
   ARCHIVAGE DES DOSSIERS REPRIS DE L'ANCIENNE APPLICATION
   -----------------------------------------------------------------------------
   Ajoute un statut 'ARC' dans FSAENTSTA pour chaque dossier repris
   (FSAENT.APPVRS = 'REPRISE-APP_FSA') dont le statut brut courant n'est pas
   déjà 'ARC'. vw_FsaCurrentStatusRaw prend le statut le plus récent : le
   dossier passe donc en Archivé et sort du circuit de validation
   (vw_FsaServicesMustValidate exclut les ARC).

   Date du statut ARC : dernière validation ou dernier statut connu (le plus
   récent des deux), pour garder un historique cohérent.

   Rejouable : ne touche pas aux dossiers déjà archivés.
   ============================================================================= */
USE [FSA];
GO

SET XACT_ABORT ON;

DECLARE @DRY_RUN BIT = 1;   -- ⚠ passer à 0 pour appliquer

-- Avant
SELECT cs.CODETA, cs.DESETA, COUNT(*) AS NB_AVANT
FROM dbo.FSAENT e
JOIN dbo.vw_FsaCurrentStatus cs ON cs.NUMDOS = e.NUMDOS
WHERE e.APPVRS = N'REPRISE-APP_FSA'
GROUP BY cs.CODETA, cs.DESETA;

BEGIN TRANSACTION;

INSERT INTO dbo.FSAENTSTA (NUMDOS, CODETA, CREDAT)
SELECT
    e.NUMDOS,
    'ARC',
    CASE WHEN lastval.D > raw.STATUS_CREDAT THEN lastval.D ELSE raw.STATUS_CREDAT END
FROM dbo.FSAENT e
JOIN dbo.vw_FsaCurrentStatusRaw raw ON raw.NUMDOS = e.NUMDOS
OUTER APPLY (
    SELECT MAX(v.CREDAT) AS D FROM dbo.FSAVALID v WHERE v.NUMDOS = e.NUMDOS
) lastval
WHERE e.APPVRS = N'REPRISE-APP_FSA'
  AND raw.CODETA <> 'ARC';

PRINT CONCAT(N'Dossiers repris archivés : ', @@ROWCOUNT);

-- Après
SELECT cs.CODETA, cs.DESETA, COUNT(*) AS NB_APRES
FROM dbo.FSAENT e
JOIN dbo.vw_FsaCurrentStatus cs ON cs.NUMDOS = e.NUMDOS
WHERE e.APPVRS = N'REPRISE-APP_FSA'
GROUP BY cs.CODETA, cs.DESETA;

IF @DRY_RUN = 1
BEGIN
    ROLLBACK TRANSACTION;
    PRINT N'🧪 DRY RUN : rien n''a été modifié (passer @DRY_RUN à 0).';
END
ELSE
BEGIN
    COMMIT TRANSACTION;
    PRINT N'✅ Archivage validé (COMMIT).';
END
