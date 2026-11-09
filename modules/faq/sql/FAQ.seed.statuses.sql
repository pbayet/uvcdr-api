/* ═══════════════════════════════════════════════════════════════
   FAQ — Référentiel des statuts (FAQSTATUSES)
   Idempotent : peut être rejoué sans créer de doublon (MERGE sur CODE).

   Le statut initial d'une publication est celui de plus petit LVL de son
   type. Les codes suivants pilotent des transitions automatiques côté API
   (cf. modules/faq/controllers.js) :
     OPEN → ANSWERED     première réponse d'un tiers à une question
     → RESOLVED          bonne réponse retenue par un modérateur
     RESOLVED → ANSWERED plus aucune bonne réponse
     NEW / UNDER_REVIEW → PLANNED      suggestion transformée en ticket
   Les libellés (NAME) et niveaux (LVL) peuvent être modifiés librement.
═══════════════════════════════════════════════════════════════ */

USE [FAQ];
GO

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

MERGE dbo.FAQSTATUSES AS target
USING (VALUES
  -- Questions
  (N'OPEN',        N'Ouverte',       N'QUESTION',   0),
  (N'ANSWERED',    N'Répondue',      N'QUESTION',   1),
  (N'RESOLVED',    N'Résolue',       N'QUESTION',   2),
  (N'CLOSED',      N'Clôturée',      N'QUESTION',   3),
  -- Suggestions
  (N'NEW',         N'Nouvelle',      N'SUGGESTION', 0),
  (N'UNDER_REVIEW',N'En étude',      N'SUGGESTION', 1),
  (N'PLANNED',     N'Planifiée',     N'SUGGESTION', 2),
  (N'IN_PROGRESS', N'En cours',      N'SUGGESTION', 3),
  (N'DONE',        N'Réalisée',      N'SUGGESTION', 4),
  (N'REJECTED',    N'Rejetée',       N'SUGGESTION', 5)
) AS source (CODE, NAME, TYPE, LVL)
ON target.CODE = source.CODE
WHEN NOT MATCHED BY TARGET THEN
  INSERT (CODE, NAME, TYPE, LVL, ACTIVE)
  VALUES (source.CODE, source.NAME, source.TYPE, source.LVL, 1);
GO

-- Catégories de départ (facultatif — à adapter / compléter dans
-- l'application, Paramètres › Catégories).
INSERT INTO dbo.FAQCATEGORIES (NAME, DESCR)
SELECT v.NAME, v.DESCR
FROM (VALUES
  (N'Utilisation',     N'Comment utiliser une fonctionnalité.'),
  (N'Accès & comptes', N'Connexion, droits, mots de passe.'),
  (N'Anomalie',        N'Comportement inattendu ou erreur.'),
  (N'Évolution',       N'Idée d''amélioration d''une application.')
) AS v (NAME, DESCR)
WHERE NOT EXISTS (SELECT 1 FROM dbo.FAQCATEGORIES);
GO

-- Publications existantes sans statut : statut initial de leur type.
UPDATE p
   SET p.STSID = (
     SELECT TOP 1 s.STSID FROM dbo.FAQSTATUSES s
      WHERE s.TYPE = p.TYPE AND s.ACTIVE = 1
      ORDER BY s.LVL, s.STSID)
  FROM dbo.FAQPOSTS AS p
 WHERE p.STSID IS NULL;
GO
