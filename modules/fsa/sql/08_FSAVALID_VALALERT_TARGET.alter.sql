/* =============================================================================
   FSAVALID — Destinataire d'une validation "en alerte"

   Complète 07_FSAVALID_VALALERT.alter.sql : une alerte est adressée à un
   public précis. Seuls ses destinataires, et les membres du service à
   l'origine de l'alerte (celui de la validation), la voient en alerte
   (badge sur la liste, filtre "En alerte", mise en avant sur la fiche) ;
   pour les autres, la validation et son commentaire s'affichent normalement.

     VALALERTTGT = 'ALL'  -> tout le monde (défaut, alertes existantes)
     VALALERTTGT = 'GES'  -> le gestionnaire du dossier (FSAENT.GESUSRID)
     VALALERTTGT = 'SERV' -> les membres du service VALALERTSRV
                              (FSAGES.SERVGES, via FSAGES_UTILISATEURS)
     VALALERTTGT = 'SELF' -> l'utilisateur qui a posé l'alerte (VALALERTUSR)

     VALALERTUSR : USRID de l'utilisateur qui a posé l'alerte (toujours
                   renseigné à la pose, utilisé pour 'SELF').

   Une alerte NULL (posée avant ce script) vaut 'ALL'.

   Positionnées :
     - à l'envoi de la validation  : POST  /fsa/validation
     - par bascule sur la carte    : PATCH /fsa/validation/alert

   Lecture : modules/fsa/services.js > alertForMeSql().

   Script rejouable.
   ============================================================================= */
SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

IF COL_LENGTH(N'dbo.FSAVALID', N'VALALERTTGT') IS NULL
    ALTER TABLE [dbo].[FSAVALID]
        ADD [VALALERTTGT] VARCHAR(10) NULL;
GO

IF COL_LENGTH(N'dbo.FSAVALID', N'VALALERTSRV') IS NULL
    ALTER TABLE [dbo].[FSAVALID]
        ADD [VALALERTSRV] VARCHAR(50) NULL;
GO

IF COL_LENGTH(N'dbo.FSAVALID', N'VALALERTUSR') IS NULL
    ALTER TABLE [dbo].[FSAVALID]
        ADD [VALALERTUSR] INT NULL;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.check_constraints
    WHERE name = N'CK_FSAVALID_VALALERTTGT'
)
    ALTER TABLE [dbo].[FSAVALID]
        ADD CONSTRAINT [CK_FSAVALID_VALALERTTGT]
        CHECK ([VALALERTTGT] IS NULL OR [VALALERTTGT] IN ('ALL', 'GES', 'SERV', 'SELF'));
GO
