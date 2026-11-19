/* ═══════════════════════════════════════════════════════════════
   PROCS — Procédures UVCDR (procédures / modes opératoires)
   Base : PROCS — module API : modules/procs — front : UNIS/procedures

   Tables :
     PROCCATEGORIES   catégories (2 niveaux : catégorie > sous-catégorie)
     PROCEDURES       fiches (référence, titre, résumé, catégorie, statut,
                      version courante, date de prochaine révision)
     PROCKEYWORDS     mots-clés d'une fiche
     PROCVERSIONS     versions successives du document (Word / PDF) : le
                      fichier lui-même est dans APPATTACHMENTS.ATTACHMENTS
                      (APPCODE 'PROCS', ENTITYTYPE 'PROCVER', ENTITYID = VERID) ;
                      le texte extrait (CONTENTTEXT) sert à la recherche
                      plein texte
     PROCHISTORY      journal de traçabilité (qui / quoi / quand / détail)
     PROCCONSULTS     consultations (ouverture, téléchargement) par utilisateur
     PROCACKS         accusés de lecture (« J'ai lu et compris ») par version

   Statuts d'une fiche (PROCEDURES.STATUS) :
     DRAFT      brouillon — visible des rédacteurs uniquement
     PUBLISHED  publiée — visible de tous les utilisateurs de l'application
     ARCHIVED   archivée (obsolète) — visible des rédacteurs uniquement

   Script idempotent : relançable sans erreur (objets créés s'ils n'existent pas).
═══════════════════════════════════════════════════════════════ */

USE [master];
GO

IF DB_ID(N'PROCS') IS NULL
BEGIN
    CREATE DATABASE [PROCS];
END
GO

ALTER DATABASE [PROCS] SET RECOVERY SIMPLE;
GO

USE [PROCS];
GO

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

/* ───────────────────────────────────────────
   Catégories
─────────────────────────────────────────── */
IF OBJECT_ID(N'dbo.PROCCATEGORIES', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.PROCCATEGORIES (
        CATID     INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_PROCCATEGORIES PRIMARY KEY,
        PARENTID  INT NULL CONSTRAINT FK_PROCCATEGORIES_PARENT REFERENCES dbo.PROCCATEGORIES (CATID),
        NAME      NVARCHAR(100) NOT NULL,
        DESCR     NVARCHAR(500) NULL,
        COLOR     VARCHAR(20) NULL,
        ICON      VARCHAR(50) NULL,
        SORTORD   INT NOT NULL CONSTRAINT DF_PROCCATEGORIES_SORTORD DEFAULT (0),
        ACTIVE    BIT NOT NULL CONSTRAINT DF_PROCCATEGORIES_ACTIVE DEFAULT (1),
        CREUSR    INT NULL,
        CREDAT    DATETIME2(0) NOT NULL CONSTRAINT DF_PROCCATEGORIES_CREDAT DEFAULT (SYSDATETIME()),
        UPDUSR    INT NULL,
        UPDDAT    DATETIME2(0) NULL
    );
END
GO

/* ───────────────────────────────────────────
   Fiches procédures
─────────────────────────────────────────── */
IF OBJECT_ID(N'dbo.PROCEDURES', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.PROCEDURES (
        PRCID     INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_PROCEDURES PRIMARY KEY,
        REFCODE   NVARCHAR(50) NULL,
        TITLE     NVARCHAR(255) NOT NULL,
        SUMMARY   NVARCHAR(2000) NULL,
        CATID     INT NULL CONSTRAINT FK_PROCEDURES_CATEGORY REFERENCES dbo.PROCCATEGORIES (CATID),
        OWNER     NVARCHAR(150) NULL,   -- service / personne responsable
        STATUS    VARCHAR(20) NOT NULL CONSTRAINT DF_PROCEDURES_STATUS DEFAULT ('DRAFT')
                  CONSTRAINT CK_PROCEDURES_STATUS CHECK (STATUS IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
        CURVERID  INT NULL,             -- version courante (PROCVERSIONS.VERID)
        REVIEWDAT DATE NULL,            -- prochaine révision prévue
        PUBDAT    DATETIME2(0) NULL,    -- dernière publication
        DLTD      BIT NOT NULL CONSTRAINT DF_PROCEDURES_DLTD DEFAULT (0),
        CREUSR    INT NOT NULL,
        CREDAT    DATETIME2(0) NOT NULL CONSTRAINT DF_PROCEDURES_CREDAT DEFAULT (SYSDATETIME()),
        UPDUSR    INT NULL,
        UPDDAT    DATETIME2(0) NULL
    );
END
GO

-- Référence unique parmi les fiches non supprimées (si renseignée).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_PROCEDURES_REFCODE' AND object_id = OBJECT_ID(N'dbo.PROCEDURES'))
    CREATE UNIQUE NONCLUSTERED INDEX UX_PROCEDURES_REFCODE ON dbo.PROCEDURES (REFCODE)
        WHERE REFCODE IS NOT NULL AND DLTD = 0;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_PROCEDURES_CATID' AND object_id = OBJECT_ID(N'dbo.PROCEDURES'))
    CREATE NONCLUSTERED INDEX IX_PROCEDURES_CATID ON dbo.PROCEDURES (CATID, STATUS) WHERE DLTD = 0;
GO

/* ───────────────────────────────────────────
   Mots-clés
─────────────────────────────────────────── */
IF OBJECT_ID(N'dbo.PROCKEYWORDS', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.PROCKEYWORDS (
        PRCID   INT NOT NULL CONSTRAINT FK_PROCKEYWORDS_PROC REFERENCES dbo.PROCEDURES (PRCID) ON DELETE CASCADE,
        KEYWORD NVARCHAR(50) NOT NULL,
        CONSTRAINT PK_PROCKEYWORDS PRIMARY KEY (PRCID, KEYWORD)
    );
END
GO

/* ───────────────────────────────────────────
   Versions du document
─────────────────────────────────────────── */
IF OBJECT_ID(N'dbo.PROCVERSIONS', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.PROCVERSIONS (
        VERID        INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_PROCVERSIONS PRIMARY KEY,
        PRCID        INT NOT NULL CONSTRAINT FK_PROCVERSIONS_PROC REFERENCES dbo.PROCEDURES (PRCID),
        VERNUM       INT NOT NULL,
        COMMENT      NVARCHAR(1000) NULL,         -- motif de la modification
        FILECODE     VARCHAR(50) NULL,            -- APPATTACHMENTS.ATTACHMENTS.FILECODE (document d'origine)
        PREVIEWCODE  VARCHAR(50) NULL,            -- idem, aperçu PDF généré (documents Word)
        ORIGINALNAME NVARCHAR(255) NULL,
        EXTENSION    VARCHAR(20) NULL,
        MIMETYPE     VARCHAR(150) NULL,
        SIZEBYTES    BIGINT NULL,
        CHECKSUM     VARCHAR(64) NULL,            -- SHA-256 du document d'origine
        CONTENTTEXT  NVARCHAR(MAX) NULL,          -- texte extrait (recherche plein texte)
        TEXTSTATUS   VARCHAR(20) NOT NULL CONSTRAINT DF_PROCVERSIONS_TEXTSTATUS DEFAULT ('PENDING'),
                     -- PENDING | OK | EMPTY | UNSUPPORTED | ERROR
        PAGES        INT NULL,
        CREUSR       INT NOT NULL,
        CREDAT       DATETIME2(0) NOT NULL CONSTRAINT DF_PROCVERSIONS_CREDAT DEFAULT (SYSDATETIME()),
        CONSTRAINT UQ_PROCVERSIONS_NUM UNIQUE (PRCID, VERNUM)
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_PROCEDURES_CURVER')
    ALTER TABLE dbo.PROCEDURES
        ADD CONSTRAINT FK_PROCEDURES_CURVER FOREIGN KEY (CURVERID) REFERENCES dbo.PROCVERSIONS (VERID);
GO

/* ───────────────────────────────────────────
   Journal de traçabilité
   ACTION : CREATE, UPDATE, NEW_VERSION, RESTORE_VERSION, PUBLISH, UNPUBLISH,
            ARCHIVE, DELETE, REINDEX
   DETAILS : JSON (champs modifiés avant/après, version, commentaire…)
─────────────────────────────────────────── */
IF OBJECT_ID(N'dbo.PROCHISTORY', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.PROCHISTORY (
        HISID    INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_PROCHISTORY PRIMARY KEY,
        PRCID    INT NOT NULL CONSTRAINT FK_PROCHISTORY_PROC REFERENCES dbo.PROCEDURES (PRCID),
        VERID    INT NULL,
        ACTION   VARCHAR(30) NOT NULL,
        DETAILS  NVARCHAR(MAX) NULL,
        USRID    INT NOT NULL,
        USRNAM   NVARCHAR(150) NULL,     -- nom au moment de l'action (figé)
        DEVEMAIL NVARCHAR(255) NULL,     -- dev réellement aux commandes (simulation)
        CREDAT   DATETIME2(0) NOT NULL CONSTRAINT DF_PROCHISTORY_CREDAT DEFAULT (SYSDATETIME())
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_PROCHISTORY_PRCID' AND object_id = OBJECT_ID(N'dbo.PROCHISTORY'))
    CREATE NONCLUSTERED INDEX IX_PROCHISTORY_PRCID ON dbo.PROCHISTORY (PRCID, HISID DESC);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_PROCHISTORY_CREDAT' AND object_id = OBJECT_ID(N'dbo.PROCHISTORY'))
    CREATE NONCLUSTERED INDEX IX_PROCHISTORY_CREDAT ON dbo.PROCHISTORY (CREDAT DESC);
GO

/* ───────────────────────────────────────────
   Consultations (KIND : VIEW | DOWNLOAD)
─────────────────────────────────────────── */
IF OBJECT_ID(N'dbo.PROCCONSULTS', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.PROCCONSULTS (
        CSTID  BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_PROCCONSULTS PRIMARY KEY,
        PRCID  INT NOT NULL,
        VERID  INT NULL,
        USRID  INT NOT NULL,
        KIND   VARCHAR(10) NOT NULL,
        CREDAT DATETIME2(0) NOT NULL CONSTRAINT DF_PROCCONSULTS_CREDAT DEFAULT (SYSDATETIME())
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_PROCCONSULTS_PRCID' AND object_id = OBJECT_ID(N'dbo.PROCCONSULTS'))
    CREATE NONCLUSTERED INDEX IX_PROCCONSULTS_PRCID ON dbo.PROCCONSULTS (PRCID, CREDAT DESC) INCLUDE (USRID, VERID, KIND);
GO

/* ───────────────────────────────────────────
   Accusés de lecture
─────────────────────────────────────────── */
IF OBJECT_ID(N'dbo.PROCACKS', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.PROCACKS (
        PRCID  INT NOT NULL,
        VERID  INT NOT NULL,
        USRID  INT NOT NULL,
        ACKDAT DATETIME2(0) NOT NULL CONSTRAINT DF_PROCACKS_ACKDAT DEFAULT (SYSDATETIME()),
        CONSTRAINT PK_PROCACKS PRIMARY KEY (VERID, USRID)
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_PROCACKS_PRCID' AND object_id = OBJECT_ID(N'dbo.PROCACKS'))
    CREATE NONCLUSTERED INDEX IX_PROCACKS_PRCID ON dbo.PROCACKS (PRCID, USRID);
GO

/* ───────────────────────────────────────────
   Catégories de départ (à adapter)
─────────────────────────────────────────── */
IF NOT EXISTS (SELECT 1 FROM dbo.PROCCATEGORIES)
BEGIN
    INSERT INTO dbo.PROCCATEGORIES (NAME, DESCR, ICON, COLOR, SORTORD) VALUES
        (N'Qualité',              N'Procédures qualité, HACCP, traçabilité produit.', 'award',        '#2e7d32', 10),
        (N'Production',           N'Modes opératoires de production et de chai.',     'industry',     '#6a1b9a', 20),
        (N'Logistique',           N'Expéditions, réceptions, stocks, quais.',         'truck',        '#ef6c00', 30),
        (N'Informatique',         N'Outils, applications, sécurité informatique.',    'laptop-code',  '#1565c0', 40),
        (N'Ressources humaines',  N'Accueil, absences, formation.',                   'users',        '#ad1457', 50),
        (N'Sécurité',             N'Hygiène, sécurité et environnement.',             'helmet-safety','#c62828', 60),
        (N'Administratif',        N'Comptabilité, achats, administration.',           'file-invoice', '#455a64', 70);
END
GO

/* ───────────────────────────────────────────
   Déclaration de l'application dans USERSMANAGER (portail, permissions).
   Les permissions des utilisateurs se donnent ensuite dans users-manager :
     - DEV / SUPERADMIN / ADMIN → rédacteurs (ajout, modification, publication)
     - autres permissions       → lecture et recherche des procédures publiées
─────────────────────────────────────────── */
IF DB_ID(N'USERSMANAGER') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM USERSMANAGER.dbo.APPLICATIONS WHERE APPCOD = N'PROCS')
BEGIN
    INSERT INTO USERSMANAGER.dbo.APPLICATIONS
        (APPCOD, APPNAM, APPDES, LOGLNK, APPLNK, ACTIVE, CREDAT, UPDDAT, CREUSR, UPDUSR, DOCLNK, IMGLNK, MNTCE)
    VALUES
        (N'PROCS', N'Procédures UVCDR',
         N'Centralisation des procédures et modes opératoires de l''entreprise (Word / PDF) : classement par catégories, recherche plein texte, versions et traçabilité.',
         NULL, N'[DOMAIN]/procedures', 1, GETDATE(), GETDATE(), NULL, NULL, NULL, NULL, 0);
END
GO
