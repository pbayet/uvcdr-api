/* ═══════════════════════════════════════════════════════════════
   FAQ — Épinglages personnels (FAQUSERPINS)

   Deux niveaux d'épinglage coexistent :
     - FAQPOSTS.PINNED   : épinglage GÉNÉRAL, réservé aux modérateurs,
                           visible par tout le monde ;
     - FAQUSERPINS       : épinglage PERSONNEL, ouvert à tous, propre au
                           compte de l'utilisateur (USRID).
   Une ligne = une publication épinglée par un utilisateur.

   Idempotent : peut être rejoué sans erreur.
═══════════════════════════════════════════════════════════════ */

USE [FAQ];
GO

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.FAQUSERPINS', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.FAQUSERPINS (
    UPNID  INT           IDENTITY (1, 1) NOT NULL,
    USRID  INT           NOT NULL,
    PSTID  INT           NOT NULL,
    CREDAT DATETIME2 (7) NOT NULL
      CONSTRAINT DF_FAQUSERPINS_CREDAT DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_FAQUSERPINS PRIMARY KEY CLUSTERED (UPNID ASC),
    CONSTRAINT UQ_FAQUSERPINS_USRID_PSTID UNIQUE NONCLUSTERED (USRID ASC, PSTID ASC),
    CONSTRAINT FK_FAQUSERPINS_FAQPOSTS FOREIGN KEY (PSTID)
      REFERENCES dbo.FAQPOSTS (PSTID)
  );

  CREATE NONCLUSTERED INDEX IX_FAQUSERPINS_PSTID
    ON dbo.FAQUSERPINS (PSTID ASC);
END;
GO
