/* =============================================================================
   FSALIENS — Liens des pré-validations (à exécuter APRÈS 03_FSALIENS.table.sql)

   Ajoute la colonne NUMGES : un lien peut maintenant être rattaché
     - au dossier lui-même            -> NUMGES IS NULL (onglet "Pièces jointes")
     - à la pré-validation d'un service -> NUMGES = gestionnaire qui valide
   Même clé que les fichiers de validation (ENTITYID = NUMDOS/NUMGES, cf.
   vw_ValidationFiles), pour qu'une nouvelle validation du même gestionnaire
   retrouve / remplace ses liens.

   Lecture  : modules/fsa/services.js > getFsa (FOLDER_LIENS_QUERY pour le
   dossier, VALIDATION_LIENS_QUERY pour les validations).
   Écriture : modules/fsa/services.js > delsertLiens(NUMDOS, liens, CREUSR, NUMGES).

   Script rejouable. NUMGES reprend le type exact de FSAVALID.NUMGES.
   ============================================================================= */
SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

IF COL_LENGTH(N'dbo.FSALIENS', N'NUMGES') IS NULL
BEGIN
    DECLARE @NUMGES_TYPE sysname = (
        SELECT TYPE_NAME(c.user_type_id) + '(' + CAST(
                   c.max_length / CASE WHEN TYPE_NAME(c.user_type_id) LIKE 'n%' THEN 2 ELSE 1 END
               AS varchar(10)) + ')'
        FROM sys.columns c
        WHERE c.object_id = OBJECT_ID(N'dbo.FSAVALID') AND c.name = N'NUMGES'
    );

    DECLARE @SQL nvarchar(max) =
        N'ALTER TABLE [dbo].[FSALIENS] ADD [NUMGES] ' + @NUMGES_TYPE + N' NULL;';

    EXEC sp_executesql @SQL;
END
GO

IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_FSALIENS_NUMDOS' AND object_id = OBJECT_ID(N'dbo.FSALIENS'))
    DROP INDEX [IX_FSALIENS_NUMDOS] ON [dbo].[FSALIENS];
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_FSALIENS_NUMDOS_NUMGES' AND object_id = OBJECT_ID(N'dbo.FSALIENS'))
    CREATE NONCLUSTERED INDEX [IX_FSALIENS_NUMDOS_NUMGES]
        ON [dbo].[FSALIENS] ([NUMDOS], [NUMGES]);
GO
