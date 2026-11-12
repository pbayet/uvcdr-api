/* =============================================================================
   FSAVENTES — Tarifs révisés (dossier en attente de validation)

   Pendant la validation (état EAV), le gestionnaire ou le demandeur du dossier
   peut saisir un tarif révisé pour chaque année, sans écraser le prix
   d'origine (PRIANN / PRIANN1 / PRIANN2), avec un motif optionnel.

     Année N   -> PRIREV  / REVNOT
     Année N+1 -> PRIREV1 / REVNOT1
     Année N+2 -> PRIREV2 / REVNOT2

   Lecture  : modules/fsa/services.js > FOLDER_HEADER_QUERY (VEN_PRIREV...).
   Écriture : modules/fsa/services.js > patchPrixRevise (PATCH /fsa/prix-revise).
   NB : upsertVente ne touche pas ces colonnes (la saisie du formulaire de
   vente ne doit pas effacer une révision) ; la duplication ne les recopie pas.

   Script rejouable.
   ============================================================================= */
SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

IF COL_LENGTH(N'dbo.FSAVENTES', N'PRIREV') IS NULL
    ALTER TABLE [dbo].[FSAVENTES] ADD [PRIREV] DECIMAL(18, 6) NULL;
GO
IF COL_LENGTH(N'dbo.FSAVENTES', N'PRIREV1') IS NULL
    ALTER TABLE [dbo].[FSAVENTES] ADD [PRIREV1] DECIMAL(18, 6) NULL;
GO
IF COL_LENGTH(N'dbo.FSAVENTES', N'PRIREV2') IS NULL
    ALTER TABLE [dbo].[FSAVENTES] ADD [PRIREV2] DECIMAL(18, 6) NULL;
GO
IF COL_LENGTH(N'dbo.FSAVENTES', N'REVNOT') IS NULL
    ALTER TABLE [dbo].[FSAVENTES] ADD [REVNOT] NVARCHAR(250) NULL;
GO
IF COL_LENGTH(N'dbo.FSAVENTES', N'REVNOT1') IS NULL
    ALTER TABLE [dbo].[FSAVENTES] ADD [REVNOT1] NVARCHAR(250) NULL;
GO
IF COL_LENGTH(N'dbo.FSAVENTES', N'REVNOT2') IS NULL
    ALTER TABLE [dbo].[FSAVENTES] ADD [REVNOT2] NVARCHAR(250) NULL;
GO
