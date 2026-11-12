/* ═══════════════════════════════════════════════════════════════════════════
   JOURNAL D'ACTIVITÉ — DEVEMAIL partout + performances de lecture
   Lecture : modules/usersmanager/services.js > getGeneralActivity,
             getActivityParams, getUserActivity
   Écriture : postActivityStats (USERSACTIVITY), postLoginStats (LOGINHISTORY)

   Prérequis : USERSACTIVITY_DEVEMAIL.alter.sql (colonne USERSACTIVITY.DEVEMAIL).

   1. LOGINHISTORY.DEVEMAIL : email du développeur quand la connexion à une
      application (POST /auth/app) se fait depuis un token d'impersonation
      (GET /auth/dev). NULL pour une connexion normale.
      NB : l'API n'insère cette colonne QUE si un DEVEMAIL est présent → les
      connexions normales continuent d'être tracées même si ce script n'a pas
      encore été joué ; seules les connexions "en tant que" échoueraient
      (erreur ignorée, cf. auth.middleware.js).
   2. Vues GLOBALACTIVITY / LATEST_ACTIVITY_DETAILS : exposent DEVEMAIL.
   3. Index : le journal est lu "les N plus récents" (ORDER BY date DESC,
      éventuellement borné par une période / un email). Sans index sur les
      dates, chaque ouverture du journal triait les deux tables en entier.

   Script rejouable.
═══════════════════════════════════════════════════════════════════════════ */

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

/* ── 1. USERSMANAGER.LOGINHISTORY ─────────────────────────────────────────── */
USE [USERSMANAGER];
GO

IF COL_LENGTH(N'dbo.LOGINHISTORY', N'DEVEMAIL') IS NULL
  ALTER TABLE [dbo].[LOGINHISTORY] ADD [DEVEMAIL] [nvarchar](320) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.LOGINHISTORY') AND name = N'IX_LOGINHISTORY_LOGIN_DATE')
  CREATE NONCLUSTERED INDEX [IX_LOGINHISTORY_LOGIN_DATE]
    ON [dbo].[LOGINHISTORY] ([LOGIN_DATE] DESC)
    INCLUDE ([EMAIL], [APPCOD], [SUCCESS], [DEVEMAIL]);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.LOGINHISTORY') AND name = N'IX_LOGINHISTORY_EMAIL_LOGIN_DATE')
  CREATE NONCLUSTERED INDEX [IX_LOGINHISTORY_EMAIL_LOGIN_DATE]
    ON [dbo].[LOGINHISTORY] ([EMAIL], [LOGIN_DATE] DESC)
    INCLUDE ([APPCOD], [SUCCESS], [DEVEMAIL]);
GO

/* ── 2. GENERALACTIVITY.USERSACTIVITY : index ─────────────────────────────── */
USE [GENERALACTIVITY];
GO

-- PARAMS (nvarchar(max)) volontairement exclu : la liste ne le lit plus, il
-- est chargé à la demande par ID (clé primaire clustered).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.USERSACTIVITY') AND name = N'IX_USERSACTIVITY_CREDAT')
  CREATE NONCLUSTERED INDEX [IX_USERSACTIVITY_CREDAT]
    ON [dbo].[USERSACTIVITY] ([CREDAT] DESC)
    INCLUDE ([USEREMAIL], [DEVEMAIL], [METHOD], [ROUTE], [COMMENT], [APPCOD], [IPADRESS], [DURATIONMS], [SUCCESS]);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.USERSACTIVITY') AND name = N'IX_USERSACTIVITY_USEREMAIL_CREDAT')
  CREATE NONCLUSTERED INDEX [IX_USERSACTIVITY_USEREMAIL_CREDAT]
    ON [dbo].[USERSACTIVITY] ([USEREMAIL], [CREDAT] DESC);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.USERSACTIVITY') AND name = N'IX_USERSACTIVITY_DEVEMAIL')
  CREATE NONCLUSTERED INDEX [IX_USERSACTIVITY_DEVEMAIL]
    ON [dbo].[USERSACTIVITY] ([DEVEMAIL], [CREDAT] DESC)
    WHERE [DEVEMAIL] IS NOT NULL;
GO

/* ── 3. Vues ──────────────────────────────────────────────────────────────── */
CREATE OR ALTER VIEW [dbo].[GLOBALACTIVITY] AS
SELECT
    ID AS LOG_ID,
    CREDAT AS EVENT_DATE,
    USEREMAIL AS EMAIL,
    DEVEMAIL,
    SUCCESS,
    METHOD,
    ROUTE,
    COMMENT,
    IPADRESS,
    DURATIONMS,
    PARAMS,
    APPCOD,
    'ACTIVITY' AS SOURCE
FROM [GENERALACTIVITY].[dbo].[USERSACTIVITY]

UNION ALL

SELECT
    LOGID AS LOG_ID,
    LOGIN_DATE AS EVENT_DATE,
    EMAIL,
    DEVEMAIL,
    SUCCESS,
    NULL AS METHOD,
    NULL AS ROUTE,
    NULL AS COMMENT,
    NULL AS IPADRESS,
    NULL AS DURATIONMS,
    NULL AS PARAMS,
    APPCOD,
    'LOGIN' AS SOURCE
FROM [USERSMANAGER].[dbo].[LOGINHISTORY];
GO

CREATE OR ALTER VIEW [dbo].[LATEST_ACTIVITY_DETAILS] AS
SELECT
    LOG_ID,
    EVENT_DATE,
    EMAIL,
    DEVEMAIL,
    SUCCESS,
    METHOD,
    ROUTE,
    COMMENT,
    IPADRESS,
    DURATIONMS,
    PARAMS,
    APPCOD,
    SOURCE
FROM (
    SELECT *,
           ROW_NUMBER() OVER (PARTITION BY EMAIL ORDER BY EVENT_DATE DESC) AS rn
    FROM [GENERALACTIVITY].[dbo].[GLOBALACTIVITY]
    WHERE EMAIL IS NOT NULL
) t
WHERE rn = 1;
GO
