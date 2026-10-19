/* ═══════════════════════════════════════════════════════════════════════════
   USERSMANAGER — Thème d'affichage par utilisateur (USRTHEME)
   Module API : modules/usersmanager (routes /theme et /themes)

   Une ligne = la préférence de thème d'un utilisateur :
     - APPID renseigné : thème de cette application pour cet utilisateur
       (onglet « Thème » d'une application, users-manager) ;
     - APPID NULL      : thème par défaut de l'utilisateur, appliqué à toutes
       les applications sans thème spécifique (page « Paramètres »).

   Valeurs de THEME : 'light' | 'dark' | 'system' ('system' = suit le thème
   du système d'exploitation, résolu côté navigateur).

   Résolution (services.getUserTheme) : thème de l'application, sinon thème
   par défaut de l'utilisateur, sinon 'light'. Pas de ligne = pas de choix :
   repasser une application sur « Par défaut » supprime sa ligne.

   Chaque utilisateur ne lit/écrit que ses propres lignes (USRID du JWT).

   Script idempotent, à exécuter une fois par environnement sur la base
   USERSMANAGER avec un compte disposant des droits DDL.
═══════════════════════════════════════════════════════════════════════════ */

USE [USERSMANAGER];
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

/* ─── Table ─────────────────────────────────────────────────────────────── */
-- Clé technique (THMID) : APPID est NULL pour le thème par défaut et ne peut
-- donc pas faire partie d'une clé primaire. L'unicité est garantie par les
-- deux index filtrés ci-dessous.
IF OBJECT_ID(N'dbo.USRTHEME', N'U') IS NULL
BEGIN
  CREATE TABLE [dbo].[USRTHEME](
    [THMID]  [int] IDENTITY(1,1) NOT NULL,
    [USRID]  [int] NOT NULL,
    [APPID]  [int] NULL, -- NULL = thème par défaut de l'utilisateur
    [THEME]  [nvarchar](10) NOT NULL,
    [CREDAT] [datetime] NOT NULL CONSTRAINT [DF_USRTHEME_CREDAT] DEFAULT (GETDATE()),
    [UPDDAT] [datetime] NOT NULL CONSTRAINT [DF_USRTHEME_UPDDAT] DEFAULT (GETDATE()),
    CONSTRAINT [PK_USRTHEME] PRIMARY KEY CLUSTERED ([THMID] ASC),
    CONSTRAINT [FK_USRTHEME_USRID] FOREIGN KEY ([USRID]) REFERENCES [dbo].[USERS] ([USRID]),
    CONSTRAINT [FK_USRTHEME_APPID] FOREIGN KEY ([APPID]) REFERENCES [dbo].[APPLICATIONS] ([APPID]),
    CONSTRAINT [CK_USRTHEME_THEME] CHECK ([THEME] IN (N'light', N'dark', N'system'))
  ) ON [PRIMARY];
END
GO

-- Un seul thème par (utilisateur, application)…
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'UX_USRTHEME_USRID_APPID' AND object_id = OBJECT_ID(N'dbo.USRTHEME')
)
  CREATE UNIQUE NONCLUSTERED INDEX [UX_USRTHEME_USRID_APPID]
    ON [dbo].[USRTHEME] ([USRID], [APPID]) INCLUDE ([THEME])
    WHERE [APPID] IS NOT NULL;
GO

-- … et un seul thème par défaut par utilisateur.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'UX_USRTHEME_USRID_DEFAULT' AND object_id = OBJECT_ID(N'dbo.USRTHEME')
)
  CREATE UNIQUE NONCLUSTERED INDEX [UX_USRTHEME_USRID_DEFAULT]
    ON [dbo].[USRTHEME] ([USRID]) INCLUDE ([THEME])
    WHERE [APPID] IS NULL;
GO
