/* ═══════════════════════════════════════════════════════════════
   DCKMNG — Dock Manager (gestion des quais de chargement)
   Base : DCKMNG — module API : modules/dckmng

   Tables :
     DCKSTATUSES     référentiel des statuts (libellés, ordre, couleur)
     DCKLOADS        chargements du jour (une ligne = un camion / chargement)
     DCKLOADCHANGES  historique des modifications (admin connecté ou cariste
                     anonyme : adresse IP conservée)

   Le statut d'un chargement n'est jamais saisi : il est calculé par SQL
   Server (colonne calculée persistée DCKLOADS.STSCOD), avec la même règle
   que l'ancienne application JSON :
     - QUAEFF + OPEDEB + OPEFIN renseignés  → TERMINE
     - QUAEFF renseigné                      → EN_COURS (pris en charge)
     - sinon                                 → ATTENTE (attente de chargement)

   Script idempotent : relançable sans erreur (objets créés s'ils n'existent pas).
═══════════════════════════════════════════════════════════════ */

USE [master];
GO

IF DB_ID(N'DCKMNG') IS NULL
BEGIN
    CREATE DATABASE [DCKMNG];
END
GO

ALTER DATABASE [DCKMNG] SET RECOVERY SIMPLE;
GO

USE [DCKMNG];
GO

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

/* ───────────────────────────────────────────
   Accès du compte applicatif de l'API (DB_USER de config/env/*.env).
   Adapter le nom du login si besoin.
─────────────────────────────────────────── */
IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'UVCDR_User')
   AND NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'UVCDR_User')
BEGIN
    CREATE USER [UVCDR_User] FOR LOGIN [UVCDR_User];
    ALTER ROLE [db_datareader] ADD MEMBER [UVCDR_User];
    ALTER ROLE [db_datawriter] ADD MEMBER [UVCDR_User];
END
GO

/* ───────────────────────────────────────────
   DCKSTATUSES — référentiel des statuts
─────────────────────────────────────────── */
IF OBJECT_ID(N'dbo.DCKSTATUSES', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.DCKSTATUSES (
        STSCOD  VARCHAR(10)   NOT NULL,
        NAME    NVARCHAR(50)  NOT NULL,
        LVL     TINYINT       NOT NULL,      -- ordre d'affichage / d'avancement
        COLOR   VARCHAR(20)   NOT NULL,      -- jeton de couleur côté front (warning, info, success…)
        CONSTRAINT PK_DCKSTATUSES PRIMARY KEY CLUSTERED (STSCOD)
    );
END
GO

MERGE dbo.DCKSTATUSES AS t
USING (VALUES
    ('ATTENTE',  N'ATTENTE DE CHARGEMENT', 1, 'warning'),
    ('EN_COURS', N'PRIS EN CHARGE',        2, 'info'),
    ('TERMINE',  N'TERMINÉ',               3, 'success')
) AS s (STSCOD, NAME, LVL, COLOR)
ON t.STSCOD = s.STSCOD
WHEN MATCHED THEN UPDATE SET NAME = s.NAME, LVL = s.LVL, COLOR = s.COLOR
WHEN NOT MATCHED THEN INSERT (STSCOD, NAME, LVL, COLOR) VALUES (s.STSCOD, s.NAME, s.LVL, s.COLOR);
GO

/* ───────────────────────────────────────────
   DCKLOADS — chargements
─────────────────────────────────────────── */
IF OBJECT_ID(N'dbo.DCKLOADS', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.DCKLOADS (
        LODID     INT IDENTITY(1,1) NOT NULL,
        LODDAT    DATE              NOT NULL,   -- jour du chargement (heure de Paris)
        LODHOU    TIME(0)           NOT NULL,   -- heure d'ajout par l'admin
        NOM       NVARCHAR(200)     NOT NULL,   -- nom du chargement / transporteur / client
        QUAI      NVARCHAR(10)      NULL,       -- N° de quai prévu (saisi par l'admin)

        -- Saisie cariste (espace non connecté)
        QUAEFF    NVARCHAR(10)      NULL,       -- N° de quai effectif
        OPEDEB    NVARCHAR(50)      NULL,       -- opérateur début
        OPEFIN    NVARCHAR(50)      NULL,       -- opérateur fin

        -- Statut calculé (cf. en-tête)
        STSCOD AS (CAST(
            CASE
                WHEN NULLIF(LTRIM(RTRIM(QUAEFF)), N'') IS NOT NULL
                 AND NULLIF(LTRIM(RTRIM(OPEDEB)), N'') IS NOT NULL
                 AND NULLIF(LTRIM(RTRIM(OPEFIN)), N'') IS NOT NULL THEN 'TERMINE'
                WHEN NULLIF(LTRIM(RTRIM(QUAEFF)), N'') IS NOT NULL THEN 'EN_COURS'
                ELSE 'ATTENTE'
            END AS VARCHAR(10))) PERSISTED NOT NULL,

        -- Horodatages d'avancement (alimentés par l'API, servent aux statistiques de durée)
        DEBDAT    DATETIME2(0)      NULL,       -- passage en EN_COURS
        FINDAT    DATETIME2(0)      NULL,       -- passage en TERMINE

        -- Traçabilité
        CREDAT    DATETIME2(0)      NOT NULL CONSTRAINT DF_DCKLOADS_CREDAT DEFAULT (SYSDATETIME()),
        CREUSR    INT               NULL,       -- USERSMANAGER.dbo.USERS.USRID
        UPDDAT    DATETIME2(0)      NULL,
        UPDUSR    INT               NULL,       -- NULL si modifié par un cariste
        DLTD      BIT               NOT NULL CONSTRAINT DF_DCKLOADS_DLTD DEFAULT (0),
        DLTDAT    DATETIME2(0)      NULL,
        DLTUSR    INT               NULL,

        -- Identifiant d'origine (import des fichiers JSON de l'ancienne application)
        LEGACYID  VARCHAR(50)       NULL,

        CONSTRAINT PK_DCKLOADS PRIMARY KEY CLUSTERED (LODID)
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_DCKLOADS_LODDAT' AND object_id = OBJECT_ID(N'dbo.DCKLOADS'))
    CREATE NONCLUSTERED INDEX IX_DCKLOADS_LODDAT
        ON dbo.DCKLOADS (LODDAT, DLTD)
        INCLUDE (LODHOU, NOM, QUAI, QUAEFF, OPEDEB, OPEFIN, STSCOD, DEBDAT, FINDAT, CREDAT);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_DCKLOADS_LEGACYID' AND object_id = OBJECT_ID(N'dbo.DCKLOADS'))
    CREATE UNIQUE NONCLUSTERED INDEX UX_DCKLOADS_LEGACYID
        ON dbo.DCKLOADS (LEGACYID)
        WHERE LEGACYID IS NOT NULL;
GO

/* ───────────────────────────────────────────
   DCKLOADCHANGES — historique des modifications
─────────────────────────────────────────── */
IF OBJECT_ID(N'dbo.DCKLOADCHANGES', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.DCKLOADCHANGES (
        CHGID   INT IDENTITY(1,1) NOT NULL,
        LODID   INT               NOT NULL,
        ACTION  VARCHAR(10)       NOT NULL,   -- CREATE | UPDATE | DELETE
        FIELD   VARCHAR(10)       NULL,       -- NOM | QUAI | QUAEFF | OPEDEB | OPEFIN (UPDATE)
        OLDVAL  NVARCHAR(200)     NULL,
        NEWVAL  NVARCHAR(200)     NULL,
        SOURCE  VARCHAR(10)       NOT NULL,   -- ADMIN | CARISTE
        USRID   INT               NULL,       -- NULL pour un cariste (non connecté)
        IPADDR  VARCHAR(45)       NULL,
        CREDAT  DATETIME2(0)      NOT NULL CONSTRAINT DF_DCKLOADCHANGES_CREDAT DEFAULT (SYSDATETIME()),
        CONSTRAINT PK_DCKLOADCHANGES PRIMARY KEY CLUSTERED (CHGID),
        CONSTRAINT FK_DCKLOADCHANGES_LOAD FOREIGN KEY (LODID) REFERENCES dbo.DCKLOADS (LODID),
        CONSTRAINT CK_DCKLOADCHANGES_ACTION CHECK (ACTION IN ('CREATE', 'UPDATE', 'DELETE')),
        CONSTRAINT CK_DCKLOADCHANGES_SOURCE CHECK (SOURCE IN ('ADMIN', 'CARISTE'))
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_DCKLOADCHANGES_LODID' AND object_id = OBJECT_ID(N'dbo.DCKLOADCHANGES'))
    CREATE NONCLUSTERED INDEX IX_DCKLOADCHANGES_LODID ON dbo.DCKLOADCHANGES (LODID, CHGID);
GO

/* ───────────────────────────────────────────
   Déclaration de l'application dans USERSMANAGER (portail, permissions).
   APPLNK / LOGLNK à adapter ; les permissions des utilisateurs se donnent
   ensuite dans users-manager.
─────────────────────────────────────────── */
IF DB_ID(N'USERSMANAGER') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM USERSMANAGER.dbo.APPLICATIONS WHERE APPCOD = N'DCKMNG')
BEGIN
    INSERT INTO USERSMANAGER.dbo.APPLICATIONS
        (APPCOD, APPNAM, APPDES, LOGLNK, APPLNK, ACTIVE, CREDAT, UPDDAT, CREUSR, UPDUSR, DOCLNK, IMGLNK, MNTCE)
    VALUES
        (N'DCKMNG', N'Dock Manager',
         N'Gestion des quais de chargement : planification des chargements (admin) et saisie des caristes.',
         NULL, N'[DOMAIN]/dckmng', 1, GETDATE(), GETDATE(), NULL, NULL, NULL, NULL, 0);
END
GO
