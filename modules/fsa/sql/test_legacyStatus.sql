/* =============================================================================
   TEST — Statut des dossiers repris de l'ancienne application
   (FSAENT.APPVRS = 'REPRISE-APP_FSA'), calculé à partir des 5 validations de
   REPRISE_FSA_SuiviDossier au lieu de 'ARC' / 'Archivé'.

   Valeurs possibles de ValidDDO / ValidCG / ValidOENO / ValidDG / ValidMARK :
     'Non' (≈ NULL), 'Validé', 'Refus', 'Validation Partielle'

   Règle :
     - au moins 1 'Refus' ou 'Validation Partielle' -> REF / Refusé
     - les 5 'Validé'                                -> VAL / Validé
     - sinon                                         -> ARC / Archivé (inchangé)

   Jointure : FSAENT.NUMDOS = REPRISE_FSA_SuiviDossier.NumDossier, ligne
   retenue par la reprise uniquement (RN_DOUBLON = 1).
   ============================================================================= */
USE [FSA];
GO

SET NOCOUNT ON;

DROP TABLE IF EXISTS #LEGACY_STATUS;

SELECT
    e.NUMDOS,
    e.NOMDOS,
    cs.CODETA AS OLD_CODETA,
    cs.DESETA AS OLD_DESETA,
    s.ValidDDO, s.ValidCG, s.ValidOENO, s.ValidDG, s.ValidMARK,
    k.NB_VAL,
    k.NB_REF,
    CASE
        WHEN k.NB_REF > 0 THEN 'REF'
        WHEN k.NB_VAL = 5 THEN 'VAL'
        ELSE cs.CODETA
    END AS NEW_CODETA,
    CASE
        WHEN k.NB_REF > 0 THEN N'Refusé'
        WHEN k.NB_VAL = 5 THEN N'Validé'
        ELSE cs.DESETA
    END AS NEW_DESETA
INTO #LEGACY_STATUS
FROM dbo.FSAENT e
INNER JOIN dbo.vw_FsaCurrentStatus cs ON cs.NUMDOS = e.NUMDOS
INNER JOIN dbo.REPRISE_FSA_SuiviDossier s
        ON s.NumDossier = e.NUMDOS AND s.RN_DOUBLON = 1
CROSS APPLY (
    SELECT
        SUM(CASE WHEN v.ETAT COLLATE French_CI_AI = N'Validé' THEN 1 ELSE 0 END) AS NB_VAL,
        SUM(CASE WHEN v.ETAT COLLATE French_CI_AI IN (N'Refus', N'Validation Partielle') THEN 1 ELSE 0 END) AS NB_REF
    FROM (VALUES (s.ValidDDO), (s.ValidCG), (s.ValidOENO), (s.ValidDG), (s.ValidMARK)) AS v(ETAT)
) k
WHERE e.APPVRS = 'REPRISE-APP_FSA';

-- 1. Répartition ancien statut -> nouveau statut
SELECT OLD_CODETA, OLD_DESETA, NEW_CODETA, NEW_DESETA, COUNT(*) AS NB
FROM #LEGACY_STATUS
GROUP BY OLD_CODETA, OLD_DESETA, NEW_CODETA, NEW_DESETA
ORDER BY OLD_CODETA, NEW_CODETA;

-- 2. Détail par dossier
SELECT *
FROM #LEGACY_STATUS
ORDER BY NEW_CODETA, NUMDOS;

-- 3. Dossiers repris sans ligne correspondante dans REPRISE_FSA_SuiviDossier
SELECT e.NUMDOS, e.NOMDOS
FROM dbo.FSAENT e
WHERE e.APPVRS = 'REPRISE-APP_FSA'
  AND NOT EXISTS (
        SELECT 1 FROM dbo.REPRISE_FSA_SuiviDossier s
        WHERE s.NumDossier = e.NUMDOS AND s.RN_DOUBLON = 1);

DROP TABLE IF EXISTS #LEGACY_STATUS;
