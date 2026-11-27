/* ═══════════════════════════════════════════════════════════════════════════
   USERSMANAGER — Modes opératoires par version d'application
   Module API : modules/usersmanager (GET /versions, POST /last-version,
   GET /home/applications)

   APPVERSIONDOCS : modes opératoires d'une version (APPSVERSIONS.VID), un
   lien (URL externe, [DOMAIN]/..., ou fichier uploadé via /files/upload).
   Plusieurs modes opératoires par version, affichés dans l'ordre ORDNUM.

   APPVERSIONDOCPRMS : statuts (PERMISSIONS.PRMID) autorisés à voir un mode
   opératoire. Aucune ligne = visible par tous.

   Résolution (controllers.getAppVersions) : une version affiche ses propres
   modes opératoires visibles par l'utilisateur ; sinon ceux de la version
   antérieure la plus proche (RELEASEDTE, VID) qui en a ; sinon l'ancien
   lien de documentation de l'application (APPLICATIONS.DOCLNK, conservé
   en base comme repli, plus éditable dans users-manager).

   Suppression d'une version : ses modes opératoires et leurs statuts sont
   supprimés en cascade (les fichiers uploadés sont supprimés par le front).

   Script idempotent, à exécuter une fois par environnement AVANT de
   déployer l'API.
═══════════════════════════════════════════════════════════════════════════ */

USE [USERSMANAGER];
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.APPVERSIONDOCS', N'U') IS NULL
BEGIN
  CREATE TABLE [dbo].[APPVERSIONDOCS](
    [DID]    [int] IDENTITY(1,1) NOT NULL,
    [VID]    [int] NOT NULL,
    [DOCNAM] [nvarchar](200) NOT NULL,
    [DOCLNK] [nvarchar](500) NOT NULL,
    [ORDNUM] [int] NOT NULL CONSTRAINT [DF_APPVERSIONDOCS_ORDNUM] DEFAULT (0),
    [CREDAT] [datetime2](3) NOT NULL CONSTRAINT [DF_APPVERSIONDOCS_CREDAT] DEFAULT (SYSDATETIME()),
    [CREUSR] [nvarchar](50) NULL,
    CONSTRAINT [PK_APPVERSIONDOCS] PRIMARY KEY CLUSTERED ([DID] ASC),
    CONSTRAINT [FK_APPVERSIONDOCS_APPSVERSIONS] FOREIGN KEY ([VID])
      REFERENCES [dbo].[APPSVERSIONS] ([VID]) ON DELETE CASCADE
  );

  CREATE NONCLUSTERED INDEX [IX_APPVERSIONDOCS_VID]
    ON [dbo].[APPVERSIONDOCS] ([VID] ASC, [ORDNUM] ASC);
END;
GO

IF OBJECT_ID(N'dbo.APPVERSIONDOCPRMS', N'U') IS NULL
BEGIN
  CREATE TABLE [dbo].[APPVERSIONDOCPRMS](
    [DID]   [int] NOT NULL,
    [PRMID] [int] NOT NULL,
    CONSTRAINT [PK_APPVERSIONDOCPRMS] PRIMARY KEY CLUSTERED ([DID] ASC, [PRMID] ASC),
    CONSTRAINT [FK_APPVERSIONDOCPRMS_APPVERSIONDOCS] FOREIGN KEY ([DID])
      REFERENCES [dbo].[APPVERSIONDOCS] ([DID]) ON DELETE CASCADE,
    CONSTRAINT [FK_APPVERSIONDOCPRMS_PERMISSIONS] FOREIGN KEY ([PRMID])
      REFERENCES [dbo].[PERMISSIONS] ([PRMID]) ON DELETE CASCADE
  );
END;
GO

/* Exemple : modes opératoires d'une application et statuts autorisés
SELECT V.APPCOD, V.VNUM, D.DID, D.DOCNAM, D.DOCLNK, D.ORDNUM, P.PRMNAM
FROM dbo.APPVERSIONDOCS D
INNER JOIN dbo.APPSVERSIONS V ON V.VID = D.VID
LEFT JOIN dbo.APPVERSIONDOCPRMS DP ON DP.DID = D.DID
LEFT JOIN dbo.PERMISSIONS P ON P.PRMID = DP.PRMID
WHERE V.APPCOD = N'USRMAN'
ORDER BY V.RELEASEDTE DESC, V.VID DESC, D.ORDNUM, D.DID;
*/
