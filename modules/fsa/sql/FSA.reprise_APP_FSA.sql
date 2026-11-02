/* =============================================================================
   REPRISE DE DONNÉES FSA
   Source : [VM-BI\BISQL2022].[APP_FSA].[dbo].[FSA_SuiviDossier]  (table unique)
   Cible  : [FSA] (modèle normalisé FSAENT / FSAENTSTA / FSACLIENTS /
            FSAPRODUITS / FSAVENTES / FSAVALID)

   À exécuter dans SSMS, connecté au serveur qui héberge la base FSA, en mode
   "batch" (les GO séparent les étapes). Le script est rejouable : les dossiers
   déjà présents dans FSAENT (même NUMDOS) sont ignorés.

   Étapes :
     0. Serveur lié vers VM-BI\BISQL2022 (à créer une seule fois)
     1. Paramètres + tables de correspondance (À VÉRIFIER / COMPLÉTER)
     2. Copie de la source dans une table de travail locale (hors transaction,
        pour éviter une transaction distribuée MSDTC)
     3. Contrôles préalables (bloquants) + rapport des troncatures
     4. Chargement transactionnel (DRY RUN = rollback final)
     5. Contrôles post-reprise
     6. (commenté) Annulation de la reprise

   Repère des lignes reprises : FSAENT.APPVRS = 'REPRISE-APP_FSA'
   ============================================================================= */
USE [FSA];


GO
SET NOEXEC OFF;


GO
/* =============================================================================
   0. SERVEUR LIÉ (une seule fois — à exécuter par un sysadmin)
   -----------------------------------------------------------------------------
   L'authentification Windows propagée (@useself = 'TRUE') échoue avec
   l'erreur 18452 "domaine non approuvé" : le compte de service SQL ne peut pas
   relayer l'identité Windows vers VM-BI (double saut sans délégation Kerberos).
   -> Le serveur lié se connecte avec un login SQL en lecture sur APP_FSA.

   Côté VM-BI\BISQL2022 (par un sysadmin de VM-BI), si le login n'existe pas :
       CREATE LOGIN [reprise_fsa] WITH PASSWORD = N'<mot_de_passe>', CHECK_POLICY = ON;
       USE [APP_FSA];
       CREATE USER [reprise_fsa] FOR LOGIN [reprise_fsa];
       ALTER ROLE [db_datareader] ADD MEMBER [reprise_fsa];
   (l'instance VM-BI doit accepter l'authentification mixte SQL + Windows)
   ============================================================================= */
IF NOT EXISTS (SELECT 1
               FROM   sys.servers
               WHERE  name = N'VM-BI\BISQL2022')
    EXECUTE master.dbo.sp_addlinkedserver @server = N'VM-BI\BISQL2022', @srvproduct = N'SQL Server';

-- Remplace le mappage existant (Windows propagé) par le login SQL, pour tous les logins locaux
IF EXISTS (SELECT 1
           FROM   sys.linked_logins AS ll
                  INNER JOIN
                  sys.servers AS s
                  ON s.server_id = ll.server_id
           WHERE  s.name = N'VM-BI\BISQL2022'
                  AND ll.local_principal_id = 0)
    EXECUTE master.dbo.sp_droplinkedsrvlogin @rmtsrvname = N'VM-BI\BISQL2022', @locallogin = NULL;

EXECUTE master.dbo.sp_addlinkedsrvlogin @rmtsrvname = N'VM-BI\BISQL2022', @useself = N'FALSE', @locallogin = NULL, @rmtuser = N'PowerBi', -- ⚠ login SQL de lecture sur VM-BI
@rmtpassword = N'Uvcdr@03062019'; -- ⚠ à renseigner (ne pas commiter)


GO
-- Test de connectivité : arrête le script si la source est inaccessible
BEGIN TRY
    EXECUTE master.dbo.sp_testlinkedserver N'VM-BI\BISQL2022';
    EXECUTE (N'SELECT COUNT(*) AS NB_LIGNES_SOURCE
            FROM [VM-BI\BISQL2022].[APP_FSA].[dbo].[FSA_SuiviDossier];');
END TRY
BEGIN CATCH
    PRINT CONCAT(N'⛔ Source inaccessible : ', ERROR_MESSAGE());
    RAISERROR (N'Serveur lié VM-BI\BISQL2022 inaccessible : reprise non exécutée.', 16, 1);
    SET NOEXEC ON;
END CATCH


GO
/* =============================================================================
   1. PARAMÈTRES ET CORRESPONDANCES  —  À VÉRIFIER AVANT EXÉCUTION
   ============================================================================= */
IF OBJECT_ID('tempdb..#PARAM') IS NOT NULL
    DROP TABLE #PARAM;

CREATE TABLE #PARAM (
    DRY_RUN        BIT            NOT NULL, -- 1 = tout exécuter puis ROLLBACK
    CONVERT_TO_UTC BIT            NOT NULL, -- les dates de l'ancienne base sont en heure locale, la nouvelle en UTC
    VALTYP_PARTIEL VARCHAR (15)   COLLATE DATABASE_DEFAULT NOT NULL, -- code FSAVALTYP pour "Validation Partielle"
    REPRISE_USR    NVARCHAR (250) NOT NULL, -- utilisateur technique de reprise
    APPVRS         NVARCHAR (50)  NOT NULL -- marqueur des dossiers repris
);

INSERT  INTO #PARAM
VALUES (0, 1, 'VAL', N'REPRISE APP_FSA', N'REPRISE-APP_FSA'); -- ⚠ passer à 0 pour la reprise réelle

-- "Validation Partielle" reprise comme une validation (note préfixée)
/* Correspondance service valideur de l'ancienne table -> NUMGES de FSAGES (VALGES = 1). */
IF OBJECT_ID('tempdb..#MAP_VALIDEUR') IS NOT NULL
    DROP TABLE #MAP_VALIDEUR;

CREATE TABLE #MAP_VALIDEUR (
    SRV    VARCHAR (10) COLLATE DATABASE_DEFAULT NOT NULL PRIMARY KEY, -- service de l'ancienne table
    NUMGES VARCHAR (15) COLLATE DATABASE_DEFAULT NOT NULL -- gestionnaire FSAGES cible
);

INSERT  INTO #MAP_VALIDEUR (
    SRV,
    NUMGES
)
VALUES                     ('DDO', 'DOP'), -- Directeur des opérations / DEVELOPPEMENT   (ValidDDO_*,  ValidDDO_User)
                           ('CG', 'DAF'), -- Directeur adm. financier / FINANCIER       (ValidCG_*,   ValidDAF_User)
                           ('OENO', 'OENO'), -- Œnologue / OENOLOGIE                       (ValidOENO_*, ValidOENO_User)
                           ('DG', 'DG'), -- Directeur général / DIRECTION              (ValidDG_*,   ValidDG_User)
                           ('MARK', 'DMA'); -- Directeur marketing / MARKETING            (ValidMARK_*, ValidMARK_User)

/* Correspondance EtatDossier -> statut brut FSAENTSTA.
   Seuls BRO / EAV / ARC sont écrits : VAL et REF sont calculés par
   vw_FsaCurrentStatus à partir des validations reprises.
   Toute valeur source absente de cette table bloque la reprise (étape 3). */
IF OBJECT_ID('tempdb..#MAP_ETAT') IS NOT NULL
    DROP TABLE #MAP_ETAT;

CREATE TABLE #MAP_ETAT (
    ETAT   NVARCHAR (100) COLLATE French_CI_AI NOT NULL PRIMARY KEY,
    CODETA VARCHAR (15)   NOT NULL CHECK (CODETA IN ('BRO', 'EAV', 'ARC'))
);

INSERT  INTO #MAP_ETAT (
    ETAT,
    CODETA
)
VALUES                 (N'Brouillon', 'BRO'),
                       (N'En cours', 'EAV'),
                       (N'En attente', 'EAV'),
                       (N'En attente de validation', 'EAV'),
                       (N'En attente validation', 'EAV'),
                       (N'Validation Partielle', 'EAV'),
                       (N'Validé', 'EAV'),
                       (N'Refusé', 'EAV'),
                       (N'Refus', 'EAV'),
                       (N'Archivé', 'ARC');


GO
/* =============================================================================
   2. COPIE DE LA SOURCE DANS UNE TABLE DE TRAVAIL LOCALE
   -----------------------------------------------------------------------------
   Conserve l'intégralité des données d'origine (y compris les textes qui
   seront tronqués dans le nouveau modèle) pour traçabilité.
   ============================================================================= */
IF OBJECT_ID('dbo.REPRISE_FSA_SuiviDossier') IS NOT NULL
    DROP TABLE dbo.REPRISE_FSA_SuiviDossier;

SELECT CAST (ID AS INT) AS ID,
       CAST (NumDossier AS NVARCHAR (MAX)) AS NumDossier,
       CAST (TypProjet AS NVARCHAR (MAX)) AS TypProjet,
       CAST (TypGeoDemande AS NVARCHAR (MAX)) AS TypGeoDemande,
       CAST (DemNomDemand AS NVARCHAR (MAX)) AS DemNomDemand,
       CAST (DemDcCodGest AS NVARCHAR (MAX)) AS DemDcCodGest,
       CAST (DemDcGestionnaire AS NVARCHAR (MAX)) AS DemDcGestionnaire,
       CAST (ClientExist AS NVARCHAR (MAX)) AS ClientExist,
       CAST (ClientCode AS NVARCHAR (MAX)) AS ClientCode,
       CAST (ClientRaisSoc AS NVARCHAR (MAX)) AS ClientRaisSoc,
       CAST (ClientPays AS NVARCHAR (MAX)) AS ClientPays,
       CAST (ClientActivite AS NVARCHAR (MAX)) AS ClientActivite,
       CAST (ClientNomContact AS NVARCHAR (MAX)) AS ClientNomContact,
       CAST (ClientMailContact AS NVARCHAR (MAX)) AS ClientMailContact,
       CAST (ClientTelContact AS NVARCHAR (MAX)) AS ClientTelContact,
       CAST (ClientNotes AS NVARCHAR (MAX)) AS ClientNotes,
       CAST (ProdMarque AS NVARCHAR (MAX)) AS ProdMarque,
       CAST (ProdAppelation AS NVARCHAR (MAX)) AS ProdAppelation,
       CAST (ProdNomDomaine AS NVARCHAR (MAX)) AS ProdNomDomaine,
       CAST (ProdFormat AS NVARCHAR (MAX)) AS ProdFormat,
       CAST (ProdCouleur AS NVARCHAR (MAX)) AS ProdCouleur,
       CAST (ProdTypo AS NVARCHAR (MAX)) AS ProdTypo,
       CAST (ProdCondit AS NVARCHAR (MAX)) AS ProdCondit,
       CAST (ProdTypBout AS NVARCHAR (MAX)) AS ProdTypBout,
       CAST (ProdCoulBout AS NVARCHAR (MAX)) AS ProdCoulBout,
       CAST (ProdDetDemand AS NVARCHAR (MAX)) AS ProdDetDemand,
       CAST (ProdCepage AS NVARCHAR (MAX)) AS ProdCepage,
       CAST (ProdQualiteVin AS NVARCHAR (MAX)) AS ProdQualiteVin,
       CAST (ProdNomBout AS NVARCHAR (MAX)) AS ProdNomBout,
       CAST (ProdBagBout AS NVARCHAR (MAX)) AS ProdBagBout,
       CAST (ProdQualPapier AS NVARCHAR (MAX)) AS ProdQualPapier,
       CAST (CalDateDemande AS DATETIME2 (3)) AS CalDateDemande,
       CAST (NegDateMAD AS DATETIME2 (3)) AS NegDateMAD,
       CAST (NegVolAnN AS DECIMAL (18, 6)) AS NegVolAnN,
       CAST (NegVolAnN1 AS DECIMAL (18, 6)) AS NegVolAnN1,
       CAST (NegVolAnN2 AS DECIMAL (18, 6)) AS NegVolAnN2,
       CAST (NegPUAnN AS DECIMAL (18, 6)) AS NegPUAnN,
       CAST (NegPUAnN1 AS DECIMAL (18, 6)) AS NegPUAnN1,
       CAST (NegPUAnN2 AS DECIMAL (18, 6)) AS NegPUAnN2,
       CAST (NegPVC AS DECIMAL (18, 6)) AS NegPVC,
       CAST (NegNotes AS NVARCHAR (MAX)) AS NegNotes,
       CAST (OneShot AS NVARCHAR (MAX)) AS OneShot,
       CAST (CreePar AS NVARCHAR (MAX)) AS CreePar,
       CAST (CreeLe AS DATETIME2 (3)) AS CreeLe,
       CAST (EtatDossier AS NVARCHAR (MAX)) AS EtatDossier,
       CAST (NomDossier AS NVARCHAR (MAX)) AS NomDossier,
       CAST (DossierNotes AS NVARCHAR (MAX)) AS DossierNotes,
       -- Validations (5 services)
       CAST (ValidDDO AS NVARCHAR (MAX)) AS ValidDDO,
       CAST (ValidCG AS NVARCHAR (MAX)) AS ValidCG,
       CAST (ValidOENO AS NVARCHAR (MAX)) AS ValidOENO,
       CAST (ValidDG AS NVARCHAR (MAX)) AS ValidDG,
       CAST (ValidMARK AS NVARCHAR (MAX)) AS ValidMARK,
       CAST (ValidDDO_DAT AS DATETIME2 (3)) AS ValidDDO_DAT,
       CAST (ValidCG_DAT AS DATETIME2 (3)) AS ValidCG_DAT,
       CAST (ValidOENO_DAT AS DATETIME2 (3)) AS ValidOENO_DAT,
       CAST (ValidDG_DAT AS DATETIME2 (3)) AS ValidDG_DAT,
       CAST (ValidMARK_DAT AS DATETIME2 (3)) AS ValidMARK_DAT,
       CAST (ValidDDO_NOTE_RF AS NVARCHAR (MAX)) AS ValidDDO_NOTE_RF,
       CAST (ValidCG_NOTE_RF AS NVARCHAR (MAX)) AS ValidCG_NOTE_RF,
       CAST (ValidOENO_NOTE_RF AS NVARCHAR (MAX)) AS ValidOENO_NOTE_RF,
       CAST (ValidDG_NOTE_RF AS NVARCHAR (MAX)) AS ValidDG_NOTE_RF,
       CAST (ValidMARK_NOTE_RF AS NVARCHAR (MAX)) AS ValidMARK_NOTE_RF,
       CAST (ValidDDO_NOTE_VP AS NVARCHAR (MAX)) AS ValidDDO_NOTE_VP,
       CAST (ValidCG_NOTE_VP AS NVARCHAR (MAX)) AS ValidCG_NOTE_VP,
       CAST (ValidOENO_NOTE_VP AS NVARCHAR (MAX)) AS ValidOENO_NOTE_VP,
       CAST (ValidDG_NOTE_VP AS NVARCHAR (MAX)) AS ValidDG_NOTE_VP,
       CAST (ValidMARK_NOTE_VP AS NVARCHAR (MAX)) AS ValidMARK_NOTE_VP,
       CAST (ValidDDO_NOTE_VOK AS NVARCHAR (MAX)) AS ValidDDO_NOTE_VOK,
       CAST (ValidCG_NOTE_VOK AS NVARCHAR (MAX)) AS ValidCG_NOTE_VOK,
       CAST (ValidOENO_NOTE_VOK AS NVARCHAR (MAX)) AS ValidOENO_NOTE_VOK,
       CAST (ValidDG_NOTE_VOK AS NVARCHAR (MAX)) AS ValidDG_NOTE_VOK,
       CAST (ValidMARK_NOTE_VOK AS NVARCHAR (MAX)) AS ValidMARK_NOTE_VOK,
       CAST (ValidOENO_User AS NVARCHAR (MAX)) AS ValidOENO_User,
       CAST (ValidDDO_User AS NVARCHAR (MAX)) AS ValidDDO_User,
       CAST (ValidMARK_User AS NVARCHAR (MAX)) AS ValidMARK_User,
       CAST (ValidDAF_User AS NVARCHAR (MAX)) AS ValidDAF_User,
       CAST (ValidDG_User AS NVARCHAR (MAX)) AS ValidDG_User
INTO   dbo.REPRISE_FSA_SuiviDossier
FROM   [VM-BI\BISQL2022].[APP_FSA].[dbo].[FSA_SuiviDossier];

-- Nettoyage : '' / espaces / 'NULL' littéral -> NULL sur toutes les colonnes texte
DECLARE @sql AS NVARCHAR (MAX);

SELECT @sql = N'UPDATE dbo.REPRISE_FSA_SuiviDossier SET ' + STRING_AGG(CAST (QUOTENAME(c.name) + N' = NULLIF(NULLIF(LTRIM(RTRIM(' + QUOTENAME(c.name) + N')), N''''), N''NULL'')' AS NVARCHAR (MAX)), N', ')
FROM   sys.columns AS c
WHERE  c.object_id = OBJECT_ID('dbo.REPRISE_FSA_SuiviDossier')
       AND TYPE_NAME(c.user_type_id) = 'nvarchar';

EXECUTE sp_executesql @sql;

-- Heure locale (Paris) -> UTC
IF (SELECT CONVERT_TO_UTC
    FROM   #PARAM) = 1
    BEGIN
        SELECT @sql = N'UPDATE dbo.REPRISE_FSA_SuiviDossier SET ' + STRING_AGG(CAST (QUOTENAME(c.name) + N' = CAST(' + QUOTENAME(c.name) + N' AT TIME ZONE ''Romance Standard Time'' AT TIME ZONE ''UTC'' AS DATETIME2(3))' AS NVARCHAR (MAX)), N', ')
        FROM   sys.columns AS c
        WHERE  c.object_id = OBJECT_ID('dbo.REPRISE_FSA_SuiviDossier')
               AND TYPE_NAME(c.user_type_id) = 'datetime2';
        EXECUTE sp_executesql @sql;
    END

-- Colonnes de résolution calculées une fois pour toutes
ALTER TABLE dbo.REPRISE_FSA_SuiviDossier
    ADD RN_DOUBLON INT          NULL, -- 1 = ligne retenue pour un NumDossier
        X_TYPDOS   VARCHAR (15) NULL,
        X_NUMGES   VARCHAR (15) NULL,
        X_CLIPAY   VARCHAR (15) NULL,
        X_CODETA   VARCHAR (15) NULL;


GO
IF OBJECT_ID('dbo.REPRISE_FSA_SuiviDossier') IS NULL
   OR COL_LENGTH('dbo.REPRISE_FSA_SuiviDossier', 'X_CODETA') IS NULL
    BEGIN
        RAISERROR (N'Copie de la source en échec : reprise non exécutée.', 16, 1);
        SET NOEXEC ON;
    END


GO
UPDATE s
SET    RN_DOUBLON = d.RN
FROM   dbo.REPRISE_FSA_SuiviDossier AS s
       INNER JOIN
       (SELECT ID,
               ROW_NUMBER() OVER (PARTITION BY NumDossier ORDER BY CreeLe DESC, ID DESC) AS RN
        FROM   dbo.REPRISE_FSA_SuiviDossier
        WHERE  NumDossier IS NOT NULL) AS d
       ON d.ID = s.ID;

-- Type de dossier : libellé FSATYP.TYDOSN (ex. "Offre"), sinon préfixe du NumDossier (ex. "OFF")
UPDATE s
SET    X_TYPDOS = COALESCE (tn.TYPDOS, tp.TYPDOS)
FROM   dbo.REPRISE_FSA_SuiviDossier AS s
       LEFT OUTER JOIN
       dbo.FSATYP AS tn
       ON tn.TYDOSN COLLATE French_CI_AI = s.TypProjet COLLATE French_CI_AI
       LEFT OUTER JOIN
       dbo.FSATYP AS tp
       ON tp.TYPDOS COLLATE French_CI_AI = LEFT(s.NumDossier, NULLIF (CHARINDEX('/', s.NumDossier), 0) - 1) COLLATE French_CI_AI;

-- Gestionnaire demandeur : DemDcCodGest, sinon 2e segment du NumDossier (OFF/DMA/...)
-- (NULLIF : certains NumDossier ont un segment vide, ex. "COD//25040717/00590")
UPDATE s
SET    X_NUMGES = LEFT(COALESCE (s.DemDcCodGest, NULLIF (PARSENAME(REPLACE(LEFT(s.NumDossier, 50), '/', '.'), 3), '')), 15)
FROM   dbo.REPRISE_FSA_SuiviDossier AS s;

-- Pays : code ou libellé FSAPAYS, insensible casse / accents / tirets
UPDATE s
SET    X_CLIPAY = p.CLIPAY
FROM   dbo.REPRISE_FSA_SuiviDossier AS s
       CROSS APPLY (SELECT TOP (1) fp.CLIPAY
                    FROM   dbo.FSAPAYS AS fp
                    WHERE  fp.CLIPAY COLLATE French_CI_AI = s.ClientPays COLLATE French_CI_AI
                           OR REPLACE(fp.CLIPAYN, '-', ' ') COLLATE French_CI_AI = REPLACE(s.ClientPays, '-', ' ') COLLATE French_CI_AI) AS p;

-- Statut brut
UPDATE s
SET    X_CODETA = m.CODETA
FROM   dbo.REPRISE_FSA_SuiviDossier AS s
       INNER JOIN
       #MAP_ETAT AS m
       ON m.ETAT = s.EtatDossier COLLATE French_CI_AI;


GO
/* =============================================================================
   3. CONTRÔLES PRÉALABLES
   ============================================================================= */
IF OBJECT_ID('tempdb..#ERREURS') IS NOT NULL
    DROP TABLE #ERREURS;

CREATE TABLE #ERREURS (
    CONTROLE NVARCHAR (200),
    VALEUR   NVARCHAR (400),
    NB       INT           
);

-- Bloquants
INSERT INTO #ERREURS
SELECT   N'EtatDossier non mappé (compléter #MAP_ETAT)',
         ISNULL(EtatDossier, N'<NULL>'),
         COUNT(*)
FROM     dbo.REPRISE_FSA_SuiviDossier
WHERE    X_CODETA IS NULL
         AND RN_DOUBLON = 1
GROUP BY EtatDossier;

INSERT INTO #ERREURS
SELECT   N'Type de dossier introuvable dans FSATYP',
         CONCAT(TypProjet, N' / ', NumDossier),
         COUNT(*)
FROM     dbo.REPRISE_FSA_SuiviDossier
WHERE    X_TYPDOS IS NULL
         AND RN_DOUBLON = 1
GROUP BY TypProjet, NumDossier;

INSERT INTO #ERREURS
SELECT N'Gestionnaire demandeur non déterminé',
       NumDossier,
       1
FROM   dbo.REPRISE_FSA_SuiviDossier
WHERE  X_NUMGES IS NULL
       AND RN_DOUBLON = 1;

INSERT INTO #ERREURS
SELECT N'NUMGES valideur absent de FSAGES (corriger #MAP_VALIDEUR)',
       CONCAT(m.SRV, N' -> ', m.NUMGES),
       0
FROM   #MAP_VALIDEUR AS m
WHERE  NOT EXISTS (SELECT 1
                   FROM   dbo.FSAGES AS g
                   WHERE  g.NUMGES = m.NUMGES);

INSERT INTO #ERREURS
SELECT N'Code manquant dans FSAVALTYP',
       v.CODE,
       0
FROM   (SELECT 'VAL'
        UNION
        SELECT 'REF'
        UNION
        SELECT VALTYP_PARTIEL
        FROM   #PARAM) AS v(CODE)
WHERE  NOT EXISTS (SELECT 1
                   FROM   dbo.FSAVALTYP AS t
                   WHERE  t.VALTYPCOD = v.CODE);

INSERT INTO #ERREURS
SELECT N'Code manquant dans FSASTA',
       v.CODE,
       0
FROM   (VALUES ('BRO'), ('EAV'), ('ARC')) AS v(CODE)
WHERE  NOT EXISTS (SELECT 1
                   FROM   dbo.FSASTA AS s
                   WHERE  s.CODETA = v.CODE);

INSERT INTO #ERREURS
SELECT   N'Statut de validation inconnu',
         CONCAT(v.SRV, N' = ', v.ETAT),
         COUNT(*)
FROM     dbo.REPRISE_FSA_SuiviDossier AS s
         CROSS APPLY (VALUES ('DDO', s.ValidDDO), ('CG', s.ValidCG), ('OENO', s.ValidOENO), ('DG', s.ValidDG), ('MARK', s.ValidMARK)) AS v(SRV, ETAT)
WHERE    s.RN_DOUBLON = 1
         AND v.ETAT IS NOT NULL
         AND v.ETAT COLLATE French_CI_AI NOT IN (N'Validé', N'Refus', N'Validation Partielle', N'Non')
GROUP BY v.SRV, v.ETAT;

-- Informatifs (non bloquants)
SELECT   N'Doublons NumDossier (seule la ligne la plus récente est reprise)' AS INFO,
         NumDossier,
         COUNT(*) AS NB
FROM     dbo.REPRISE_FSA_SuiviDossier
WHERE    NumDossier IS NOT NULL
GROUP BY NumDossier
HAVING   COUNT(*) > 1;

SELECT N'Lignes sans NumDossier (ignorées)' AS INFO,
       ID
FROM   dbo.REPRISE_FSA_SuiviDossier
WHERE  NumDossier IS NULL;

SELECT   N'Pays client non reconnu (CLIPAY laissé à NULL)' AS INFO,
         ClientPays,
         COUNT(*) AS NB
FROM     dbo.REPRISE_FSA_SuiviDossier
WHERE    ClientPays IS NOT NULL
         AND X_CLIPAY IS NULL
         AND RN_DOUBLON = 1
GROUP BY ClientPays;

SELECT N'Dossiers déjà présents dans FSAENT (ignorés)' AS INFO,
       s.NumDossier
FROM   dbo.REPRISE_FSA_SuiviDossier AS s
       INNER JOIN
       dbo.FSAENT AS e
       ON e.NUMDOS = s.NumDossier
WHERE  s.RN_DOUBLON = 1;

-- Textes qui seront tronqués (le texte complet reste dans REPRISE_FSA_SuiviDossier)
SELECT   s.ID,
         s.NumDossier,
         t.COLONNE,
         t.LONGUEUR,
         t.MAX_CIBLE
FROM     dbo.REPRISE_FSA_SuiviDossier AS s
         CROSS APPLY (VALUES (N'NomDossier -> NOMDOS', LEN(s.NomDossier), 80), (N'DossierNotes -> NOTDOS', LEN(s.DossierNotes), 250), (N'ClientRaisSoc -> BPCNAM', LEN(s.ClientRaisSoc), 50), (N'ClientNotes -> CLINOT', LEN(s.ClientNotes), 250), (N'ClientTelContact -> CLITEL', LEN(s.ClientTelContact), 50), (N'ProdMarque -> DESMAR', LEN(s.ProdMarque), 50), (N'ProdAppelation -> DESAPP', LEN(s.ProdAppelation), 50), (N'ProdDetDemand + bouteille -> ITMNOT', LEN(s.ProdDetDemand), 250), (N'NegNotes -> VENNOT', LEN(s.NegNotes), 250)) AS t(COLONNE, LONGUEUR, MAX_CIBLE)
WHERE    s.RN_DOUBLON = 1
         AND t.LONGUEUR > t.MAX_CIBLE
ORDER BY s.ID, t.COLONNE;

IF EXISTS (SELECT 1
           FROM   #ERREURS)
    BEGIN
        SELECT N'⛔ REPRISE BLOQUÉE' AS STATUT,
               *
        FROM   #ERREURS;
        RAISERROR (N'Contrôles préalables en échec : reprise non exécutée.', 16, 1);
        SET NOEXEC ON; -- les batchs suivants ne seront pas exécutés
    END
ELSE
    SELECT N'✅ Contrôles préalables OK' AS STATUT;


GO
/* =============================================================================
   4. CHARGEMENT
   ============================================================================= */
SET XACT_ABORT ON;

SET NOCOUNT ON;

DECLARE @DRY_RUN AS BIT, @VALTYP_PARTIEL AS VARCHAR (15), @USR AS NVARCHAR (250), @APPVRS AS NVARCHAR (50);

SELECT @DRY_RUN = DRY_RUN,
       @VALTYP_PARTIEL = VALTYP_PARTIEL,
       @USR = REPRISE_USR,
       @APPVRS = APPVRS
FROM   #PARAM;

-- Dossiers à reprendre
IF OBJECT_ID('tempdb..#SRC') IS NOT NULL
    DROP TABLE #SRC;

SELECT s.*
INTO   #SRC
FROM   dbo.REPRISE_FSA_SuiviDossier AS s
WHERE  s.RN_DOUBLON = 1
       AND NOT EXISTS (SELECT 1
                       FROM   dbo.FSAENT AS e
                       WHERE  e.NUMDOS = s.NumDossier);

BEGIN TRY
    BEGIN TRANSACTION;
    /* 4.1 Gestionnaires demandeurs absents de FSAGES (FK FSAENT.NUMGES)
           créés non valideurs ; libellé = dernier DemDcGestionnaire connu */
    INSERT INTO dbo.FSAGES (
        NUMGES,
        NOMGES,
        VALGES,
        CREGES,
        SERVGES,
        CREUSR,
        CREDAT,
        MODUSR,
        MODDAT
    )
    SELECT g.X_NUMGES,
           LEFT(COALESCE (g.DemDcGestionnaire, g.X_NUMGES), 50),
           0,
           1,
           LEFT(COALESCE (g.DemDcGestionnaire, g.X_NUMGES), 50),
           @USR,
           SYSUTCDATETIME(),
           @USR,
           SYSUTCDATETIME()
    FROM   (SELECT X_NUMGES,
                   DemDcGestionnaire,
                   ROW_NUMBER() OVER (PARTITION BY X_NUMGES ORDER BY CreeLe DESC, ID DESC) AS RN
            FROM   #SRC) AS g
    WHERE  g.RN = 1
           AND NOT EXISTS (SELECT 1
                           FROM   dbo.FSAGES AS f
                           WHERE  f.NUMGES = g.X_NUMGES);
    PRINT CONCAT(N'FSAGES (demandeurs créés) : ', @@ROWCOUNT);
    /* 4.2 FSAENT */
    INSERT INTO dbo.FSAENT (
        NUMDOS,
        NOMDOS,
        TYPDOS,
        NUMGES,
        NUMDEM,
        NOTDOS,
        CREUSR,
        CREDAT,
        MODUSR,
        MODDAT,
        DELETED,
        GESUSRID,
        NUMDOSBAS,
        INNO,
        APPVRS
    )
    SELECT LEFT(s.NumDossier, 50),
           LEFT(COALESCE (s.NomDossier, s.NumDossier), 80),
           s.X_TYPDOS,
           s.X_NUMGES,
           s.X_NUMGES, -- NUMDEM = code du service demandeur (POSCOD)
           LEFT(s.DossierNotes, 250),
           COALESCE (LEFT(s.CreePar, 250), LEFT(s.DemNomDemand, 250), @USR),
           COALESCE (s.CreeLe, s.CalDateDemande, SYSUTCDATETIME()),
           COALESCE (LEFT(s.CreePar, 250), LEFT(s.DemNomDemand, 250), @USR),
           COALESCE (s.CreeLe, s.CalDateDemande, SYSUTCDATETIME()),
           0,
           NULL,
           NULL,
           0,
           @APPVRS
    FROM   #SRC AS s;
    PRINT CONCAT(N'FSAENT : ', @@ROWCOUNT);
    /* 4.3 FSAENTSTA : historique BRO -> EAV -> ARC
           (même horodatage BRO/EAV : l'ordre d'insertion départage via ENTSTAID)
           Tous les dossiers repris sont archivés, quel que soit leur état d'origine. */
    INSERT INTO dbo.FSAENTSTA (
        NUMDOS,
        CODETA,
        CREDAT
    )
    SELECT   LEFT(s.NumDossier, 50),
             x.CODETA,
             x.CREDAT
    FROM     #SRC AS s
             CROSS APPLY (SELECT COALESCE (s.CreeLe, s.CalDateDemande, SYSUTCDATETIME()) AS D_CRE,
                                 (SELECT MAX(d)
                                  FROM   (VALUES (s.ValidDDO_DAT), (s.ValidCG_DAT), (s.ValidOENO_DAT), (s.ValidDG_DAT), (s.ValidMARK_DAT)) AS v(d)) AS D_LASTVAL) AS d
             CROSS APPLY (VALUES (1, 'BRO', d.D_CRE), (2, 'EAV', d.D_CRE), (3, 'ARC', CASE WHEN d.D_LASTVAL > d.D_CRE THEN d.D_LASTVAL ELSE d.D_CRE END)) AS x(ORD, CODETA, CREDAT)
    WHERE    (x.ORD = 1)
             OR (x.ORD = 2
                 AND s.X_CODETA IN ('EAV', 'ARC'))
             OR (x.ORD = 3)
    ORDER BY s.ID, x.ORD;
    PRINT CONCAT(N'FSAENTSTA : ', @@ROWCOUNT);
    /* 4.4 FSACLIENTS (si au moins une info client) */
    INSERT INTO dbo.FSACLIENTS (
        NUMDOS,
        CLIEXI,
        BPCNUM,
        BPCNAM,
        CLIPAY,
        CLIACT,
        NOMACT,
        CLICCON,
        CLINAM,
        CLIMAIL,
        CLITEL,
        CLINOT
    )
    SELECT LEFT(s.NumDossier, 50),
           CASE WHEN s.ClientExist COLLATE French_CI_AI = N'CLIENT EXISTANT' THEN 1 ELSE 0 END,
           LEFT(s.ClientCode, 255),
           LEFT(s.ClientRaisSoc, 50),
           s.X_CLIPAY,
           NULL, -- pas de code activité dans l'ancienne base
           LEFT(s.ClientActivite, 200),
           NULL,
           LEFT(s.ClientNomContact, 250),
           LEFT(s.ClientMailContact, 250),
           LEFT(s.ClientTelContact, 50),
           LEFT(s.ClientNotes, 250)
    FROM   #SRC AS s
    WHERE  COALESCE (s.ClientExist, s.ClientCode, s.ClientRaisSoc, s.ClientPays, s.ClientActivite, s.ClientNomContact, s.ClientMailContact, s.ClientTelContact, s.ClientNotes) IS NOT NULL;
    PRINT CONCAT(N'FSACLIENTS : ', @@ROWCOUNT);
    /* 4.5 FSAPRODUITS (libellés uniquement : l'ancienne base ne stockait pas les codes)
           Les infos bouteille sans colonne dédiée sont ajoutées dans ITMNOT. */
    INSERT INTO dbo.FSAPRODUITS (
        NUMDOS,
        DESFMT,
        DESMAR,
        DESGAM,
        DESAPP,
        DESCEP,
        DESCOU,
        DESQUA,
        DESTYP,
        ITMCON,
        CHADOM,
        ITMNOT,
        MEDAIL
    )
    SELECT LEFT(s.NumDossier, 50),
           LEFT(s.ProdFormat, 50),
           LEFT(s.ProdMarque, 50),
           LEFT(s.ProdQualPapier, 50), -- "Milieu de Gamme", "Haut de Gamme"...
           LEFT(s.ProdAppelation, 50),
           LEFT(s.ProdCepage, 50),
           LEFT(s.ProdCouleur, 50),
           LEFT(s.ProdQualiteVin, 50),
           LEFT(s.ProdTypo, 50),
           TRY_CONVERT (DECIMAL (18, 6), s.ProdCondit),
           LEFT(s.ProdNomDomaine, 255),
           LEFT(CONCAT_WS(CHAR(13) + CHAR(10), s.ProdDetDemand, CASE WHEN COALESCE (s.ProdNomBout, s.ProdTypBout, s.ProdCoulBout, s.ProdBagBout) IS NOT NULL THEN N'Bouteille : ' + CONCAT_WS(N' / ', s.ProdNomBout, s.ProdTypBout, s.ProdCoulBout, s.ProdBagBout) END), 250),
           0
    FROM   #SRC AS s
    WHERE  COALESCE (s.ProdMarque, s.ProdAppelation, s.ProdNomDomaine, s.ProdFormat, s.ProdCouleur, s.ProdTypo, s.ProdCondit, s.ProdTypBout, s.ProdCoulBout, s.ProdDetDemand, s.ProdCepage, s.ProdQualiteVin, s.ProdNomBout, s.ProdBagBout, s.ProdQualPapier) IS NOT NULL;
    PRINT CONCAT(N'FSAPRODUITS : ', @@ROWCOUNT);
    /* 4.6 FSAVENTES (volumes en cols, comme la saisie d'origine) */
    INSERT INTO dbo.FSAVENTES (
        NUMDOS,
        DATMAD,
        ONESHO,
        VOLANN,
        VOLANN1,
        VOLANN2,
        PRIANN,
        PRIANN1,
        PRIANN2,
        PVC,
        VENNOT,
        FRANCO,
        FDC,
        AFA,
        AFANOT,
        VOLTIR
    )
    SELECT LEFT(s.NumDossier, 50),
           s.NegDateMAD,
           CASE WHEN s.OneShot COLLATE French_CI_AI = N'Oui' THEN 1 ELSE 0 END,
           s.NegVolAnN,
           s.NegVolAnN1,
           s.NegVolAnN2,
           s.NegPUAnN,
           s.NegPUAnN1,
           s.NegPUAnN2,
           s.NegPVC,
           LEFT(s.NegNotes, 250),
           0,
           0,
           0,
           NULL,
           NULL
    FROM   #SRC AS s
    WHERE  s.NegDateMAD IS NOT NULL
           OR s.NegNotes IS NOT NULL
           OR s.OneShot IS NOT NULL
           OR COALESCE (s.NegVolAnN, 0) + COALESCE (s.NegVolAnN1, 0) + COALESCE (s.NegVolAnN2, 0) + COALESCE (s.NegPUAnN, 0) + COALESCE (s.NegPUAnN1, 0) + COALESCE (s.NegPUAnN2, 0) + COALESCE (s.NegPVC, 0) <> 0;
    PRINT CONCAT(N'FSAVENTES : ', @@ROWCOUNT);
    /* 4.7 FSAVALID : une ligne par service ayant statué ("Non" = pas encore statué) */
    INSERT INTO dbo.FSAVALID (
        NUMDOS,
        NUMGES,
        VALTYPCOD,
        VALNOT,
        CREDAT,
        CREUSR
    )
    SELECT LEFT(s.NumDossier, 50),
           m.NUMGES,
           t.VALTYPCOD,
           LEFT(CASE t.VALTYPCOD WHEN 'REF' THEN COALESCE (v.NOTE_RF, v.NOTE_VP, v.NOTE_VOK) ELSE CASE WHEN t.PARTIEL = 1 THEN N'[Validation partielle] ' + COALESCE (v.NOTE_VP, v.NOTE_VOK, N'') ELSE COALESCE (v.NOTE_VOK, v.NOTE_VP) END END, 4000),
           COALESCE (v.DAT, s.CreeLe, SYSUTCDATETIME()),
           COALESCE (LEFT(v.USR, 250), @USR)
    FROM   #SRC AS s
           CROSS APPLY (VALUES ('DDO', s.ValidDDO, s.ValidDDO_DAT, s.ValidDDO_NOTE_RF, s.ValidDDO_NOTE_VP, s.ValidDDO_NOTE_VOK, s.ValidDDO_User), ('CG', s.ValidCG, s.ValidCG_DAT, s.ValidCG_NOTE_RF, s.ValidCG_NOTE_VP, s.ValidCG_NOTE_VOK, s.ValidDAF_User), ('OENO', s.ValidOENO, s.ValidOENO_DAT, s.ValidOENO_NOTE_RF, s.ValidOENO_NOTE_VP, s.ValidOENO_NOTE_VOK, s.ValidOENO_User), ('DG', s.ValidDG, s.ValidDG_DAT, s.ValidDG_NOTE_RF, s.ValidDG_NOTE_VP, s.ValidDG_NOTE_VOK, s.ValidDG_User), ('MARK', s.ValidMARK, s.ValidMARK_DAT, s.ValidMARK_NOTE_RF, s.ValidMARK_NOTE_VP, s.ValidMARK_NOTE_VOK, s.ValidMARK_User)) AS v(SRV, ETAT, DAT, NOTE_RF, NOTE_VP, NOTE_VOK, USR)
           CROSS APPLY (SELECT CASE WHEN v.ETAT COLLATE French_CI_AI = N'Validé' THEN 'VAL' WHEN v.ETAT COLLATE French_CI_AI = N'Refus' THEN 'REF' WHEN v.ETAT COLLATE French_CI_AI = N'Validation Partielle' THEN @VALTYP_PARTIEL END AS VALTYPCOD,
                               CASE WHEN v.ETAT COLLATE French_CI_AI = N'Validation Partielle' THEN 1 ELSE 0 END AS PARTIEL) AS t
           INNER JOIN
           #MAP_VALIDEUR AS m
           ON m.SRV = v.SRV
    WHERE  t.VALTYPCOD IS NOT NULL;
    PRINT CONCAT(N'FSAVALID : ', @@ROWCOUNT);
    IF @DRY_RUN = 1
        BEGIN
            ROLLBACK;
            PRINT N'🧪 DRY RUN : toutes les insertions ont été annulées (passer #PARAM.DRY_RUN à 0).';
        END
    ELSE
        BEGIN
            COMMIT TRANSACTION;
            PRINT N'✅ Reprise validée (COMMIT).';
        END
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0
        ROLLBACK;
    PRINT CONCAT(N'❌ Erreur ligne ', ERROR_LINE(), N' : ', ERROR_MESSAGE());
    THROW;
END CATCH


GO
/* =============================================================================
   5. CONTRÔLES POST-REPRISE
   ============================================================================= */
SELECT (SELECT COUNT(DISTINCT NumDossier)
        FROM   dbo.REPRISE_FSA_SuiviDossier) AS NB_DOSSIERS_SOURCE,
       (SELECT COUNT(*)
        FROM   dbo.FSAENT
        WHERE  APPVRS = N'REPRISE-APP_FSA') AS NB_FSAENT,
       (SELECT COUNT(*)
        FROM   dbo.FSAENTSTA AS es
               INNER JOIN
               dbo.FSAENT AS e
               ON e.NUMDOS = es.NUMDOS
        WHERE  e.APPVRS = N'REPRISE-APP_FSA') AS NB_FSAENTSTA,
       (SELECT COUNT(*)
        FROM   dbo.FSACLIENTS AS c
               INNER JOIN
               dbo.FSAENT AS e
               ON e.NUMDOS = c.NUMDOS
        WHERE  e.APPVRS = N'REPRISE-APP_FSA') AS NB_FSACLIENTS,
       (SELECT COUNT(*)
        FROM   dbo.FSAPRODUITS AS p
               INNER JOIN
               dbo.FSAENT AS e
               ON e.NUMDOS = p.NUMDOS
        WHERE  e.APPVRS = N'REPRISE-APP_FSA') AS NB_FSAPRODUITS,
       (SELECT COUNT(*)
        FROM   dbo.FSAVENTES AS v
               INNER JOIN
               dbo.FSAENT AS e
               ON e.NUMDOS = v.NUMDOS
        WHERE  e.APPVRS = N'REPRISE-APP_FSA') AS NB_FSAVENTES,
       (SELECT COUNT(*)
        FROM   dbo.FSAVALID AS va
               INNER JOIN
               dbo.FSAENT AS e
               ON e.NUMDOS = va.NUMDOS
        WHERE  e.APPVRS = N'REPRISE-APP_FSA') AS NB_FSAVALID;

-- Statut ancien vs statut calculé par la nouvelle vue
SELECT   s.EtatDossier AS ETAT_ANCIEN,
         cs.CODETA AS CODETA_NOUVEAU,
         cs.DESETA,
         COUNT(*) AS NB
FROM     dbo.REPRISE_FSA_SuiviDossier AS s
         INNER JOIN
         dbo.FSAENT AS e
         ON e.NUMDOS = s.NumDossier
            AND e.APPVRS = N'REPRISE-APP_FSA'
         LEFT OUTER JOIN
         dbo.vw_FsaCurrentStatus AS cs
         ON cs.NUMDOS = e.NUMDOS
WHERE    s.RN_DOUBLON = 1
GROUP BY s.EtatDossier, cs.CODETA, cs.DESETA
ORDER BY s.EtatDossier, cs.CODETA;


GO
SET NOEXEC OFF;


/* =============================================================================
   6. ANNULATION DE LA REPRISE (à décommenter si besoin)
   -----------------------------------------------------------------------------
   Supprime uniquement les dossiers marqués APPVRS = 'REPRISE-APP_FSA'.
   Les gestionnaires FSAGES créés en 4.1 (CREUSR = 'REPRISE APP_FSA') sont
   conservés ; les supprimer à part s'ils ne sont plus référencés.
   ============================================================================= */
/*
BEGIN TRANSACTION;
    DECLARE @DOS TABLE (NUMDOS VARCHAR(50) PRIMARY KEY);
    INSERT INTO @DOS SELECT NUMDOS FROM dbo.FSAENT WHERE APPVRS = N'REPRISE-APP_FSA';

    DELETE FROM dbo.FSAVALID         WHERE NUMDOS IN (SELECT NUMDOS FROM @DOS);
    DELETE FROM dbo.FSAVALCNDRESULT  WHERE NUMDOS IN (SELECT NUMDOS FROM @DOS);
    DELETE FROM dbo.FSAVENTES        WHERE NUMDOS IN (SELECT NUMDOS FROM @DOS);
    DELETE FROM dbo.FSAPRODUITS      WHERE NUMDOS IN (SELECT NUMDOS FROM @DOS);
    DELETE FROM dbo.FSACLIENTS       WHERE NUMDOS IN (SELECT NUMDOS FROM @DOS);
    DELETE FROM dbo.FSANOMENCLATURES WHERE NUMDOS IN (SELECT NUMDOS FROM @DOS);
    DELETE FROM dbo.FSAPJ            WHERE NUMDOS IN (SELECT NUMDOS FROM @DOS);
    DELETE FROM dbo.FSAENTSTA        WHERE NUMDOS IN (SELECT NUMDOS FROM @DOS);
    DELETE FROM dbo.FSAENT           WHERE NUMDOS IN (SELECT NUMDOS FROM @DOS);
COMMIT TRANSACTION;
*/