/* =============================================================================
   FSALIENS — Liens externes rattachés à un dossier FSA
   (documents hébergés ailleurs : Google Drive, SharePoint, OneDrive...)

   Complète les pièces jointes (fichiers, vw_FolderFiles) : un dossier peut
   porter à la fois des fichiers ET des liens. Pour la règle "pièce jointe
   obligatoire" (cf. front, FsaFolder.havePJ), un lien compte comme une PJ.

   Écriture : modules/fsa/services.js > delsertLiens (delete + insert de
   toute la liste du dossier, dans une transaction), appelée par PATCH /fsa
   avec le paramètre FSALIENS_STRINGIFY.
   Lecture  : modules/fsa/services.js > getFsa (FOLDER_LIENS_QUERY) et le
   compteur ENT_PJ_COUNT de la liste (fichiers + liens).

   Script rejouable : ne fait rien si la table existe déjà.
   NUMDOS reprend le type exact de FSAENT.NUMDOS (VARCHAR ou NVARCHAR selon
   la base) pour que la clé étrangère puisse être créée.
   ============================================================================= */
SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.FSALIENS', N'U') IS NULL
BEGIN
    DECLARE @NUMDOS_TYPE sysname = (
        SELECT TYPE_NAME(c.user_type_id) + '(' + CAST(
                   c.max_length / CASE WHEN TYPE_NAME(c.user_type_id) LIKE 'n%' THEN 2 ELSE 1 END
               AS varchar(10)) + ')'
        FROM sys.columns c
        WHERE c.object_id = OBJECT_ID(N'dbo.FSAENT') AND c.name = N'NUMDOS'
    );

    DECLARE @SQL nvarchar(max) = N'
    CREATE TABLE [dbo].[FSALIENS](
        [LIENID]  [int] IDENTITY(1,1) NOT NULL,
        [NUMDOS]  ' + @NUMDOS_TYPE + N' NOT NULL,
        [LIENURL] [nvarchar](2000) NOT NULL,
        [LIENNOM] [nvarchar](255) NULL,
        [CREUSR]  [nvarchar](50) NULL,
        [CREDAT]  [datetime2](3) NOT NULL CONSTRAINT [DF_FSALIENS_CREDAT] DEFAULT (SYSDATETIME()),
        CONSTRAINT [PK_FSALIENS] PRIMARY KEY CLUSTERED ([LIENID] ASC),
        CONSTRAINT [FK_FSALIENS_FSAENT_NUMDOS] FOREIGN KEY ([NUMDOS])
            REFERENCES [dbo].[FSAENT] ([NUMDOS])
    );';

    EXEC sp_executesql @SQL;

    CREATE NONCLUSTERED INDEX [IX_FSALIENS_NUMDOS]
        ON [dbo].[FSALIENS] ([NUMDOS]);

    EXEC sys.sp_addextendedproperty
        @name = N'MS_Description',
        @value = N'Liens externes (Drive, SharePoint...) du dossier, en complément des pièces jointes',
        @level0type = N'SCHEMA', @level0name = N'dbo',
        @level1type = N'TABLE',  @level1name = N'FSALIENS';
END
GO
