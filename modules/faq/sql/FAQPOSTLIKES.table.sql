/* ═══════════════════════════════════════════════════════════════
   FAQ — "J'aime" sur les publications (FAQPOSTLIKES)

   Pendant de FAQANSWERLIKES pour les questions elles-mêmes : ouvert à
   tous, une ligne = une publication likée par un utilisateur (USRID).
   Le total des likes REÇUS PAR LES RÉPONSES reste FAQANSWERLIKES
   (cf. SELECT_POSTS.LIKECOUNT) ; celui-ci alimente POSTLIKECOUNT.

   Idempotent : peut être rejoué sans erreur.
═══════════════════════════════════════════════════════════════ */

USE [FAQ];
GO

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.FAQPOSTLIKES', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.FAQPOSTLIKES (
    PLKID  INT           IDENTITY (1, 1) NOT NULL,
    PSTID  INT           NOT NULL,
    USRID  INT           NOT NULL,
    CREDAT DATETIME2 (7) NOT NULL
      CONSTRAINT DF_FAQPOSTLIKES_CREDAT DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_FAQPOSTLIKES PRIMARY KEY CLUSTERED (PLKID ASC),
    CONSTRAINT UQ_FAQPOSTLIKES_PSTID_USRID UNIQUE NONCLUSTERED (PSTID ASC, USRID ASC),
    CONSTRAINT FK_FAQPOSTLIKES_FAQPOSTS FOREIGN KEY (PSTID)
      REFERENCES dbo.FAQPOSTS (PSTID)
  );

  CREATE NONCLUSTERED INDEX IX_FAQPOSTLIKES_USRID
    ON dbo.FAQPOSTLIKES (USRID ASC);
END;
GO
