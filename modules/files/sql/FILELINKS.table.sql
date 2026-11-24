/* ═══════════════════════════════════════════════════════════════
   FILES — Liens directs vers des fichiers (FILELINKS)
   Base : APPATTACHMENTS (DB_NAME_ATTACHMENTS) — module API : modules/files

   Un lien direct ouvre un fichier SANS connexion :
     GET /api/files/open/<jeton>[/<nom du fichier>]
   Le jeton (aléatoire, 192 bits) n'est jamais stocké : seule son empreinte
   SHA-256 (TOKENHASH) l'est. Un lien perdu ne peut donc pas être recopié
   depuis la liste : on en crée un nouveau (et on révoque l'ancien).

   Cible du lien :
     - FILECODE : un fichier précis (ATTACHMENTS.FILECODE) ;
     - ou ENTITYTYPE / ENTITYID / PARAMS : cible résolue à chaque ouverture
       par le module de l'application (APPCODE), ex. PROCS : version en
       vigueur d'une procédure (cf. modules/procs/fileLinks.js).

   Expiration : EXPIRESAT (NULL = lien permanent). Révocation : REVOKEDAT.
   Suivi : OPENCOUNT / LASTOPENEDAT (les requêtes HEAD ne comptent pas).

   Script idempotent : relançable sans erreur.
═══════════════════════════════════════════════════════════════ */

USE [APPATTACHMENTS];
GO

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.FILELINKS', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.FILELINKS (
        LNKID          INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_FILELINKS PRIMARY KEY,
        TOKENHASH      CHAR(64)       NOT NULL,
        APPCODE        VARCHAR(20)    NOT NULL,
        FILECODE       VARCHAR(50)    NULL,
        ENTITYTYPE     VARCHAR(100)   NULL,
        ENTITYID       VARCHAR(100)   NULL,
        PARAMS         NVARCHAR(400)  NULL,
        FILENAME       NVARCHAR(255)  NULL,
        LABEL          NVARCHAR(300)  NULL,
        WITHNAME       BIT            NOT NULL CONSTRAINT DF_FILELINKS_WITHNAME DEFAULT (1),
        EXPIRESAT      DATETIME2(0)   NULL,
        CREATEDBY      INT            NOT NULL,
        CREATEDBYNAME  NVARCHAR(200)  NULL,
        CREATEDAT      DATETIME2(0)   NOT NULL CONSTRAINT DF_FILELINKS_CREATEDAT DEFAULT (SYSDATETIME()),
        REVOKEDAT      DATETIME2(0)   NULL,
        REVOKEDBY      INT            NULL,
        REVOKEDBYNAME  NVARCHAR(200)  NULL,
        OPENCOUNT      INT            NOT NULL CONSTRAINT DF_FILELINKS_OPENCOUNT DEFAULT (0),
        LASTOPENEDAT   DATETIME2(0)   NULL,
        CONSTRAINT UQ_FILELINKS_TOKENHASH UNIQUE (TOKENHASH),
        CONSTRAINT CK_FILELINKS_TARGET CHECK (FILECODE IS NOT NULL OR (ENTITYTYPE IS NOT NULL AND ENTITYID IS NOT NULL))
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_FILELINKS_ENTITY' AND object_id = OBJECT_ID(N'dbo.FILELINKS'))
    CREATE INDEX IX_FILELINKS_ENTITY ON dbo.FILELINKS (APPCODE, ENTITYTYPE, ENTITYID) INCLUDE (REVOKEDAT, EXPIRESAT);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_FILELINKS_FILECODE' AND object_id = OBJECT_ID(N'dbo.FILELINKS'))
    CREATE INDEX IX_FILELINKS_FILECODE ON dbo.FILELINKS (FILECODE) WHERE FILECODE IS NOT NULL;
GO
