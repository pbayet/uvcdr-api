/* =============================================================================
   FSAVALID — Validation "en alerte"

   Un valideur peut marquer sa pré-validation comme "Alerte" : son commentaire
   est important (cotation du produit...) et doit être lu et pris en compte.
   Côté front, une validation en alerte est remontée en tête de liste, mise en
   avant visuellement et signalée sur la fiche du dossier.

     VALALERT = 1 -> validation en alerte
     VALALERT = 0 -> validation normale (défaut)

   Positionnée :
     - à l'envoi de la validation  : POST  /fsa/validation        (VALALERT)
     - par bascule sur la carte    : PATCH /fsa/validation/alert  (VALIDID, VALALERT)

   Lecture : modules/fsa/services.js > FOLDER_VALIDATIONS_QUERY (VAL_VALALERT),
   lue directement dans FSAVALID (par VALIDID) pour ne pas devoir modifier
   vw_FsaValidations.

   Script rejouable.
   ============================================================================= */
SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

IF COL_LENGTH(N'dbo.FSAVALID', N'VALALERT') IS NULL
    ALTER TABLE [dbo].[FSAVALID]
        ADD [VALALERT] BIT NOT NULL
            CONSTRAINT [DF_FSAVALID_VALALERT] DEFAULT (0);
GO
