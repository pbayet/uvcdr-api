/* ═══════════════════════════════════════════════════════════════════════════
   GENERALACTIVITY — USERSACTIVITY : colonne DEVEMAIL
   Écriture : modules/usersmanager/services.js > postActivityStats

   Quand un développeur (PRMLVL 1) se connecte "en tant que" un autre
   utilisateur (GET /auth/dev, loginDevMiddleware), USEREMAIL contient
   l'email du compte simulé et DEVEMAIL celui du développeur réellement aux
   commandes. Hors impersonation, DEVEMAIL vaut NULL.

   ⚠️ À exécuter AVANT de déployer l'API qui insère DEVEMAIL (sinon chaque
   INSERT échoue — l'erreur est seulement loguée, l'activité n'est plus
   journalisée).

   Script rejouable.
═══════════════════════════════════════════════════════════════════════════ */

USE [GENERALACTIVITY];
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

IF COL_LENGTH(N'dbo.USERSACTIVITY', N'DEVEMAIL') IS NULL
  ALTER TABLE [dbo].[USERSACTIVITY] ADD [DEVEMAIL] [nvarchar](320) NULL;
GO

/* Exemple : actions faites par un dev sous l'identité d'un autre compte
SELECT USEREMAIL, DEVEMAIL, METHOD, ROUTE, COMMENT, APPCOD, SUCCESS, *
FROM [dbo].[USERSACTIVITY]
WHERE DEVEMAIL IS NOT NULL;
*/
