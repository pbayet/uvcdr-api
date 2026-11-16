/* ═══════════════════════════════════════════════════════════════
   FAQ — Modifications signalées et accusés de lecture

   FAQPOSTCHANGES : journal des modifications à signaler aux utilisateurs
   (point rouge sur la carte, mise en évidence dans le détail) :
     - ANSWER_NEW  : nouvelle réponse (ANSID) ;
     - ANSWER_EDIT : réponse modifiée (ANSID) ;
     - POST_EDIT   : publication modifiée par un modérateur (FIELDS : liste
                     des champs modifiés, séparés par des virgules, ex.
                     "TITLE,BODY,STSID") ;
     - ANSWER_VALIDATED   : réponse retenue comme bonne réponse (ANSID ;
                            FIELDS "BODY" si reformulée par le modérateur) ;
     - ANSWER_UNVALIDATED : bonne réponse retirée (ANSID).
   USRID = auteur de la modification : elle ne lui est jamais signalée.

   FAQPOSTREADS : accusé de lecture d'un utilisateur sur une publication.
   LASTCHGID = dernière modification lue ; les modifications de CHGID
   supérieur (faites par d'autres) sont « non lues ».

   FAQPOSTCHANGEREADS : date de lecture de chaque modification par un
   utilisateur — une nouveauté reste mise en évidence dans le détail encore
   une heure après sa lecture.

   Idempotent : peut être rejoué sans erreur.
═══════════════════════════════════════════════════════════════ */

USE [FAQ];
GO

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.FAQPOSTCHANGES', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.FAQPOSTCHANGES (
    CHGID  INT            IDENTITY (1, 1) NOT NULL,
    PSTID  INT            NOT NULL,
    KIND   NVARCHAR (20)  NOT NULL,
    ANSID  INT            NULL,
    FIELDS NVARCHAR (200) NULL,
    USRID  INT            NOT NULL,
    CREDAT DATETIME2 (7)  NOT NULL
      CONSTRAINT DF_FAQPOSTCHANGES_CREDAT DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_FAQPOSTCHANGES PRIMARY KEY CLUSTERED (CHGID ASC),
    CONSTRAINT CK_FAQPOSTCHANGES_KIND
      CHECK (KIND IN (N'ANSWER_NEW', N'ANSWER_EDIT', N'POST_EDIT',
        N'ANSWER_VALIDATED', N'ANSWER_UNVALIDATED')),
    CONSTRAINT FK_FAQPOSTCHANGES_FAQPOSTS FOREIGN KEY (PSTID)
      REFERENCES dbo.FAQPOSTS (PSTID)
  );

  CREATE NONCLUSTERED INDEX IX_FAQPOSTCHANGES_PSTID
    ON dbo.FAQPOSTCHANGES (PSTID ASC, CHGID DESC)
    INCLUDE (USRID, CREDAT);
END;
GO

-- Mise à jour d'une table déjà créée : types ANSWER_VALIDATED /
-- ANSWER_UNVALIDATED ajoutés à la contrainte.
IF EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = N'CK_FAQPOSTCHANGES_KIND'
    AND parent_object_id = OBJECT_ID(N'dbo.FAQPOSTCHANGES')
    AND definition NOT LIKE N'%ANSWER_UNVALIDATED%'
)
BEGIN
  ALTER TABLE dbo.FAQPOSTCHANGES DROP CONSTRAINT CK_FAQPOSTCHANGES_KIND;
  ALTER TABLE dbo.FAQPOSTCHANGES ADD CONSTRAINT CK_FAQPOSTCHANGES_KIND
    CHECK (KIND IN (N'ANSWER_NEW', N'ANSWER_EDIT', N'POST_EDIT',
      N'ANSWER_VALIDATED', N'ANSWER_UNVALIDATED'));
END;
GO

IF OBJECT_ID(N'dbo.FAQPOSTREADS', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.FAQPOSTREADS (
    USRID     INT           NOT NULL,
    PSTID     INT           NOT NULL,
    LASTCHGID INT           NOT NULL,
    READDAT   DATETIME2 (7) NOT NULL
      CONSTRAINT DF_FAQPOSTREADS_READDAT DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_FAQPOSTREADS PRIMARY KEY CLUSTERED (USRID ASC, PSTID ASC),
    CONSTRAINT FK_FAQPOSTREADS_FAQPOSTS FOREIGN KEY (PSTID)
      REFERENCES dbo.FAQPOSTS (PSTID)
  );
END;
GO

IF OBJECT_ID(N'dbo.FAQPOSTCHANGEREADS', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.FAQPOSTCHANGEREADS (
    USRID   INT           NOT NULL,
    CHGID   INT           NOT NULL,
    READDAT DATETIME2 (7) NOT NULL
      CONSTRAINT DF_FAQPOSTCHANGEREADS_READDAT DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_FAQPOSTCHANGEREADS PRIMARY KEY CLUSTERED (USRID ASC, CHGID ASC),
    CONSTRAINT FK_FAQPOSTCHANGEREADS_FAQPOSTCHANGES FOREIGN KEY (CHGID)
      REFERENCES dbo.FAQPOSTCHANGES (CHGID)
  );
END;
GO
