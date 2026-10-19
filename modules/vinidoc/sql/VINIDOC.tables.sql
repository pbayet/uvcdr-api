/* ═══════════════════════════════════════════════════════════════════════════
   VINIDOC — Schéma de la base (SQL Server)
   Module API : modules/vinidoc (cf. modules/vinidoc/README.md)

   Script idempotent sur la création de la base et des tables (IF NOT EXISTS),
   à exécuter une fois par environnement avec un compte disposant des droits
   DDL, puis donner au compte applicatif (DB_USER) les droits
   SELECT/INSERT/UPDATE/DELETE sur le schéma dbo.

   Modèle
   ──────
   Référentiels   LANGUAGES, COLORS, COLORTRANS
   Fiches         SHEETS            1 fiche = 1 code vrac + 1 millésime
                  SHEETTRANS        textes traduisibles, 1 ligne par langue
                                    (dont les cépages, en texte libre)
   Validation     SHEETVERS         versions VALIDÉES (instantané JSON complet,
                                    insert-only) — la génération utilise
                                    TOUJOURS la dernière version validée
                  SHEETEVTS         journal des actions (insert-only)
   Modèles PPTX   TEMPLATES         métadonnées ; fichier dans
                                    APPATTACHMENTS.dbo.ATTACHMENTS (FILECODE)
                  TEMPLATETAGS      balises détectées + longueur max par balise
   Traçabilité    GENERATIONS       qui a généré quoi, depuis quelle version

   Workflow (validation par fiche entière, toutes langues confondues)
   ────────
     DRAFT ──submit──▶ SUBMITTED ──validate──▶ VALIDATED
       ▲                   │
       │                   └──reject──▶ REJECTED ──submit──▶ SUBMITTED
       └── toute modification (champ commun ou traduction)
           repasse la fiche en DRAFT, quel que soit son statut.
   Une fiche repassée en DRAFT après validation reste générable : la
   génération s'appuie sur SHEETVERS (dernière version validée), jamais sur
   les données en cours d'édition.
═══════════════════════════════════════════════════════════════════════════ */

IF DB_ID(N'VINIDOC') IS NULL
  CREATE DATABASE [VINIDOC] COLLATE French_CI_AS;
GO

USE [VINIDOC];
GO

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

/* ─────────────────────────────── Référentiels ─────────────────────────────── */

IF OBJECT_ID(N'dbo.LANGUAGES', N'U') IS NULL
CREATE TABLE dbo.LANGUAGES (
  LNGCOD    varchar(5)    NOT NULL CONSTRAINT PK_LANGUAGES PRIMARY KEY,  -- ISO 639-1 (fr, en, de...)
  LNGNAM    nvarchar(50)  NOT NULL,
  ISDEFAULT bit           NOT NULL CONSTRAINT DF_LANGUAGES_ISDEFAULT DEFAULT (0),
  ACTIVE    bit           NOT NULL CONSTRAINT DF_LANGUAGES_ACTIVE DEFAULT (1),
  SORTORD   smallint      NOT NULL CONSTRAINT DF_LANGUAGES_SORTORD DEFAULT (0),
  CONSTRAINT CK_LANGUAGES_LNGCOD CHECK (LNGCOD = LOWER(LNGCOD))
);
GO

-- Une seule langue par défaut (langue de référence obligatoire d'une fiche).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_LANGUAGES_DEFAULT')
  CREATE UNIQUE INDEX UX_LANGUAGES_DEFAULT ON dbo.LANGUAGES (ISDEFAULT) WHERE ISDEFAULT = 1;
GO

IF OBJECT_ID(N'dbo.COLORS', N'U') IS NULL
CREATE TABLE dbo.COLORS (
  COLCOD    varchar(10)   NOT NULL CONSTRAINT PK_COLORS PRIMARY KEY,     -- ROUGE, ROSE, BLANC
  SORTORD   smallint      NOT NULL CONSTRAINT DF_COLORS_SORTORD DEFAULT (0)
);
GO

IF OBJECT_ID(N'dbo.COLORTRANS', N'U') IS NULL
CREATE TABLE dbo.COLORTRANS (
  COLCOD    varchar(10)   NOT NULL CONSTRAINT FK_COLORTRANS_COLORS REFERENCES dbo.COLORS (COLCOD),
  LNGCOD    varchar(5)    NOT NULL CONSTRAINT FK_COLORTRANS_LANGUAGES REFERENCES dbo.LANGUAGES (LNGCOD),
  LABEL     nvarchar(50)  NOT NULL,   -- "Rouge", "Red"...
  BOUMIN    nvarchar(50)  NULL,       -- échelle bouche, valeur 1 : "Léger" / "Sec"
  BOUMAX    nvarchar(50)  NULL,       -- échelle bouche, valeur 5 : "Puissant" / "Doux" / "Moelleux"
  CONSTRAINT PK_COLORTRANS PRIMARY KEY (COLCOD, LNGCOD)
);
GO

/* ─────────────────────────────── Fiches ─────────────────────────────── */

IF OBJECT_ID(N'dbo.SHEETS', N'U') IS NULL
CREATE TABLE dbo.SHEETS (
  SHTID     int IDENTITY(1,1) NOT NULL CONSTRAINT PK_SHEETS PRIMARY KEY,
  CODVRAC   nvarchar(30)  NOT NULL,                 -- ex. VHL09393
  MILLESIME smallint      NULL,                     -- NULL = non millésimé
  APPELL    nvarchar(100) NOT NULL,                 -- ex. CDR
  COLCOD    varchar(10)   NOT NULL CONSTRAINT FK_SHEETS_COLORS REFERENCES dbo.COLORS (COLCOD),
  DESCVRAC  nvarchar(100) NULL,                     -- ex. STANDARD
  INTARO    tinyint       NULL,                     -- intensité aromatique 1 (peu intense) → 5 (très intense)
  INTBOU    tinyint       NULL,                     -- intensité bouche 1 → 5 (sens selon COLCOD)
  ECHFRU    tinyint       NULL,                     -- échelle fruit 1 (floral) → 5 (très fruité)
  TEMPMIN   decimal(4,1)  NULL,                     -- température de dégustation (°C)
  TEMPMAX   decimal(4,1)  NULL,
  STATUS    varchar(10)   NOT NULL CONSTRAINT DF_SHEETS_STATUS DEFAULT ('DRAFT'),
  LASTVER   int           NOT NULL CONSTRAINT DF_SHEETS_LASTVER DEFAULT (0),  -- n° de la dernière version validée (0 = jamais)
  ISDEL     bit           NOT NULL CONSTRAINT DF_SHEETS_ISDEL DEFAULT (0),
  CREUSR    nvarchar(254) NOT NULL,
  CREDAT    datetime2(0)  NOT NULL CONSTRAINT DF_SHEETS_CREDAT DEFAULT (SYSUTCDATETIME()),
  MODUSR    nvarchar(254) NOT NULL,
  MODDAT    datetime2(0)  NOT NULL CONSTRAINT DF_SHEETS_MODDAT DEFAULT (SYSUTCDATETIME()),
  SUBUSR    nvarchar(254) NULL,                     -- dernier soumissionnaire (destinataire du retour marketing)
  SUBDAT    datetime2(0)  NULL,
  ROWVER    rowversion    NOT NULL,                 -- verrouillage optimiste (cf. README)
  CONSTRAINT CK_SHEETS_STATUS    CHECK (STATUS IN ('DRAFT', 'SUBMITTED', 'VALIDATED', 'REJECTED')),
  CONSTRAINT CK_SHEETS_MILLESIME CHECK (MILLESIME IS NULL OR MILLESIME BETWEEN 1900 AND 2200),
  CONSTRAINT CK_SHEETS_INTARO    CHECK (INTARO IS NULL OR INTARO BETWEEN 1 AND 5),
  CONSTRAINT CK_SHEETS_INTBOU    CHECK (INTBOU IS NULL OR INTBOU BETWEEN 1 AND 5),
  CONSTRAINT CK_SHEETS_ECHFRU    CHECK (ECHFRU IS NULL OR ECHFRU BETWEEN 1 AND 5),
  CONSTRAINT CK_SHEETS_TEMP      CHECK (TEMPMIN IS NULL OR TEMPMAX IS NULL OR TEMPMIN <= TEMPMAX)
);
GO

-- Unicité code vrac + millésime parmi les fiches non supprimées. Un index
-- unique filtré traite NULL comme une valeur : une seule fiche "non
-- millésimée" par code vrac.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_SHEETS_VRAC_MILL')
  CREATE UNIQUE INDEX UX_SHEETS_VRAC_MILL ON dbo.SHEETS (CODVRAC, MILLESIME) WHERE ISDEL = 0;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_SHEETS_STATUS')
  CREATE INDEX IX_SHEETS_STATUS ON dbo.SHEETS (STATUS, ISDEL) INCLUDE (CODVRAC, MILLESIME, MODDAT);
GO

IF OBJECT_ID(N'dbo.SHEETTRANS', N'U') IS NULL
CREATE TABLE dbo.SHEETTRANS (
  SHTID     int            NOT NULL CONSTRAINT FK_SHEETTRANS_SHEETS REFERENCES dbo.SHEETS (SHTID),
  LNGCOD    varchar(5)     NOT NULL CONSTRAINT FK_SHEETTRANS_LANGUAGES REFERENCES dbo.LANGUAGES (LNGCOD),
  LIBELLE   nvarchar(200)  NULL,   -- intitulé commercial affiché (optionnel)
  TERROIR   nvarchar(4000) NULL,   -- terroir et sol
  VINIF     nvarchar(4000) NULL,   -- vendanges et vinification
  DEGUST    nvarchar(4000) NULL,   -- dégustation (œil, nez, bouche)
  GARDE     nvarchar(100)  NULL,   -- potentiel de garde ("2 ans", "2 years")
  CEPAGES   nvarchar(1000) NULL,   -- cépages en texte libre ("Grenache 60 %, Syrah 40 %")
  ACCORDS   nvarchar(1000) NULL,   -- accords mets et vins
  ACCEXPL   nvarchar(4000) NULL,   -- explication des accords
  MODUSR    nvarchar(254)  NOT NULL,
  MODDAT    datetime2(0)   NOT NULL CONSTRAINT DF_SHEETTRANS_MODDAT DEFAULT (SYSUTCDATETIME()),
  CONSTRAINT PK_SHEETTRANS PRIMARY KEY (SHTID, LNGCOD)
);
GO

/* Migration (bases créées avant l'ajout de SHEETTRANS.CEPAGES) ──────────────
   1. ajout de la colonne ;
   2. reprise des cépages de l'ancienne table SHEETGRAPES, mis en forme comme
      formatGrapes() (utils.js) dans chaque langue déjà saisie : "Grenache 60 %, Syrah".
      Ne touche ni au statut des fiches ni aux versions validées (SHEETVERS,
      dont les anciens instantanés sont complétés à la lecture par l'API).
   3. suppression de SHEETGRAPES : à faire manuellement après vérification. */
IF COL_LENGTH(N'dbo.SHEETTRANS', N'CEPAGES') IS NULL
  ALTER TABLE dbo.SHEETTRANS ADD CEPAGES nvarchar(1000) NULL;
GO

IF OBJECT_ID(N'dbo.SHEETGRAPES', N'U') IS NOT NULL
  EXEC (N'
    UPDATE t SET t.CEPAGES = g.TXT
    FROM dbo.SHEETTRANS t
    CROSS APPLY (
      SELECT STRING_AGG(
               CASE WHEN x.PCT IS NULL THEN x.CEPAGE
                    ELSE CONCAT(x.CEPAGE, N'' '', FORMAT(x.PCT, N''0.##'', t.LNGCOD), N'' %'') END,
               N'', '') WITHIN GROUP (ORDER BY x.SORTORD) AS TXT
      FROM dbo.SHEETGRAPES x WHERE x.SHTID = t.SHTID
    ) g
    WHERE t.CEPAGES IS NULL AND g.TXT IS NOT NULL;');
GO

-- IF OBJECT_ID(N'dbo.SHEETGRAPES', N'U') IS NOT NULL DROP TABLE dbo.SHEETGRAPES;

/* ─────────────────────────────── Validation ─────────────────────────────── */

IF OBJECT_ID(N'dbo.SHEETVERS', N'U') IS NULL
CREATE TABLE dbo.SHEETVERS (
  SHTID     int            NOT NULL CONSTRAINT FK_SHEETVERS_SHEETS REFERENCES dbo.SHEETS (SHTID),
  VERNUM    int            NOT NULL,
  SNAPSHOT  nvarchar(max)  NOT NULL,   -- fiche complète (communs + cépages + toutes les traductions)
  SUBUSR    nvarchar(254)  NULL,
  VALUSR    nvarchar(254)  NOT NULL,
  VALDAT    datetime2(0)   NOT NULL CONSTRAINT DF_SHEETVERS_VALDAT DEFAULT (SYSUTCDATETIME()),
  COMMENT   nvarchar(1000) NULL,
  CONSTRAINT PK_SHEETVERS PRIMARY KEY (SHTID, VERNUM),
  CONSTRAINT CK_SHEETVERS_JSON CHECK (ISJSON(SNAPSHOT) = 1)
);
GO

IF OBJECT_ID(N'dbo.SHEETEVTS', N'U') IS NULL
CREATE TABLE dbo.SHEETEVTS (
  EVTID     int IDENTITY(1,1) NOT NULL CONSTRAINT PK_SHEETEVTS PRIMARY KEY,
  SHTID     int            NOT NULL CONSTRAINT FK_SHEETEVTS_SHEETS REFERENCES dbo.SHEETS (SHTID),
  EVTTYP    varchar(20)    NOT NULL,
  FROMSTS   varchar(10)    NULL,
  TOSTS     varchar(10)    NULL,
  LNGCOD    varchar(5)     NULL,   -- langue concernée (évènements de traduction)
  VERNUM    int            NULL,   -- version produite (VALIDATED)
  EVTUSR    nvarchar(254)  NOT NULL,
  EVTDAT    datetime2(0)   NOT NULL CONSTRAINT DF_SHEETEVTS_EVTDAT DEFAULT (SYSUTCDATETIME()),
  COMMENT   nvarchar(1000) NULL,
  CONSTRAINT CK_SHEETEVTS_EVTTYP CHECK (EVTTYP IN (
    'CREATED', 'UPDATED', 'TRANSLATION_SAVED', 'TRANSLATION_DELETED',
    'SUBMITTED', 'VALIDATED', 'REJECTED', 'DELETED'
  ))
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_SHEETEVTS_SHTID')
  CREATE INDEX IX_SHEETEVTS_SHTID ON dbo.SHEETEVTS (SHTID, EVTDAT DESC);
GO

/* ─────────────────────────────── Modèles PPTX ─────────────────────────────── */

IF OBJECT_ID(N'dbo.TEMPLATES', N'U') IS NULL
CREATE TABLE dbo.TEMPLATES (
  TPLID     int IDENTITY(1,1) NOT NULL CONSTRAINT PK_TEMPLATES PRIMARY KEY,
  -- Clé stable (ULID) utilisée comme ATTACHMENTS.ENTITYID : le fichier est
  -- enregistré AVANT l'insertion SQL (cf. controllers.createTemplate), donc
  -- avant que TPLID n'existe.
  TPLKEY    char(26)       NOT NULL CONSTRAINT UQ_TEMPLATES_TPLKEY UNIQUE,
  TPLNAM    nvarchar(150)  NOT NULL,
  DESCR     nvarchar(1000) NULL,
  LNGCOD    varchar(5)     NULL CONSTRAINT FK_TEMPLATES_LANGUAGES REFERENCES dbo.LANGUAGES (LNGCOD), -- NULL = utilisable dans toutes les langues
  FILECODE  varchar(50)    NOT NULL,   -- fichier .pptx courant (APPATTACHMENTS)
  ACTIVE    bit            NOT NULL CONSTRAINT DF_TEMPLATES_ACTIVE DEFAULT (1),
  ISDEL     bit            NOT NULL CONSTRAINT DF_TEMPLATES_ISDEL DEFAULT (0),
  CREUSR    nvarchar(254)  NOT NULL,
  CREDAT    datetime2(0)   NOT NULL CONSTRAINT DF_TEMPLATES_CREDAT DEFAULT (SYSUTCDATETIME()),
  MODUSR    nvarchar(254)  NOT NULL,
  MODDAT    datetime2(0)   NOT NULL CONSTRAINT DF_TEMPLATES_MODDAT DEFAULT (SYSUTCDATETIME()),
  ROWVER    rowversion     NOT NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_TEMPLATES_TPLNAM')
  CREATE UNIQUE INDEX UX_TEMPLATES_TPLNAM ON dbo.TEMPLATES (TPLNAM) WHERE ISDEL = 0;
GO

IF OBJECT_ID(N'dbo.TEMPLATETAGS', N'U') IS NULL
CREATE TABLE dbo.TEMPLATETAGS (
  TPLID     int           NOT NULL CONSTRAINT FK_TEMPLATETAGS_TEMPLATES REFERENCES dbo.TEMPLATES (TPLID),
  TAGTYP    varchar(10)   NOT NULL,   -- TEXT ({{TAG}}), IMAGE (forme "img:TAG"), BADGE (forme "badge:TAG")
  TAGNAM    varchar(100)  NOT NULL,
  MAXLEN    int           NULL,       -- nb max de caractères (TEXT uniquement) ; NULL = illimité
  REQUIRED  bit           NOT NULL CONSTRAINT DF_TEMPLATETAGS_REQUIRED DEFAULT (0),
  ISKNOWN   bit           NOT NULL CONSTRAINT DF_TEMPLATETAGS_ISKNOWN DEFAULT (1),  -- présent dans le catalogue des balises
  CONSTRAINT PK_TEMPLATETAGS PRIMARY KEY (TPLID, TAGTYP, TAGNAM),
  CONSTRAINT CK_TEMPLATETAGS_TAGTYP CHECK (TAGTYP IN ('TEXT', 'IMAGE', 'BADGE')),
  CONSTRAINT CK_TEMPLATETAGS_MAXLEN CHECK (MAXLEN IS NULL OR (MAXLEN > 0 AND TAGTYP = 'TEXT'))
);
GO

/* ─────────────────────────────── Générations ─────────────────────────────── */

IF OBJECT_ID(N'dbo.GENERATIONS', N'U') IS NULL
CREATE TABLE dbo.GENERATIONS (
  GENID       int IDENTITY(1,1) NOT NULL CONSTRAINT PK_GENERATIONS PRIMARY KEY,
  SHTID       int           NOT NULL CONSTRAINT FK_GENERATIONS_SHEETS REFERENCES dbo.SHEETS (SHTID),
  VERNUM      int           NULL,       -- version validée utilisée ; NULL = saisie en cours (fiche non validée)
  TPLID       int           NOT NULL CONSTRAINT FK_GENERATIONS_TEMPLATES REFERENCES dbo.TEMPLATES (TPLID),
  TPLFILECODE varchar(50)   NOT NULL,   -- fichier modèle effectivement utilisé
  LNGCOD      varchar(5)    NOT NULL CONSTRAINT FK_GENERATIONS_LANGUAGES REFERENCES dbo.LANGUAGES (LNGCOD),
  FORMAT      varchar(4)    NOT NULL,
  HVE         bit           NOT NULL CONSTRAINT DF_GENERATIONS_HVE DEFAULT (0),  -- logo HVE affiché (forme "badge:HVE")
  BIO         bit           NOT NULL CONSTRAINT DF_GENERATIONS_BIO DEFAULT (0),  -- logo BIO affiché (forme "badge:BIO")
  FILECODE    varchar(50)   NOT NULL,   -- fichier produit (APPATTACHMENTS)
  CREUSR      nvarchar(254) NOT NULL,
  CREDAT      datetime2(0)  NOT NULL CONSTRAINT DF_GENERATIONS_CREDAT DEFAULT (SYSUTCDATETIME()),
  CONSTRAINT CK_GENERATIONS_FORMAT CHECK (FORMAT IN ('pptx', 'pdf')),
  CONSTRAINT FK_GENERATIONS_SHEETVERS FOREIGN KEY (SHTID, VERNUM) REFERENCES dbo.SHEETVERS (SHTID, VERNUM)
);
GO

/* Migration (bases créées avant les options de logos HVE / BIO) ─────────────
   1. options de génération tracées dans GENERATIONS (les générations
      antérieures sont considérées sans logo) ;
   2. les logos ne sont plus des images "img:HVE" / "img:BIO" mais des blocs
      conditionnels "badge:HVE" / "badge:BIO" : les anciennes balises des
      modèles déjà déposés sont signalées comme inconnues, pour inviter à
      renommer la forme dans le .pptx puis à redéposer le modèle. */
IF COL_LENGTH(N'dbo.GENERATIONS', N'HVE') IS NULL
  ALTER TABLE dbo.GENERATIONS ADD HVE bit NOT NULL CONSTRAINT DF_GENERATIONS_HVE DEFAULT (0);
GO

IF COL_LENGTH(N'dbo.GENERATIONS', N'BIO') IS NULL
  ALTER TABLE dbo.GENERATIONS ADD BIO bit NOT NULL CONSTRAINT DF_GENERATIONS_BIO DEFAULT (0);
GO

UPDATE dbo.TEMPLATETAGS
SET ISKNOWN = 0
WHERE TAGTYP = 'IMAGE' AND TAGNAM IN ('HVE', 'BIO') AND ISKNOWN = 1;
GO

/* Migration (bases créées avant la génération des fiches non validées) ──────
   Une fiche non validée par le marketing peut être générée à partir de la
   saisie en cours : GENERATIONS.VERNUM devient NULL dans ce cas. La clé
   étrangère composite (SHTID, VERNUM) → SHEETVERS n'est pas vérifiée quand
   VERNUM est NULL ; elle doit être supprimée le temps de l'ALTER COLUMN. */
IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'dbo.GENERATIONS') AND name = N'VERNUM' AND is_nullable = 0
)
BEGIN
  IF OBJECT_ID(N'dbo.FK_GENERATIONS_SHEETVERS', N'F') IS NOT NULL
    ALTER TABLE dbo.GENERATIONS DROP CONSTRAINT FK_GENERATIONS_SHEETVERS;
  ALTER TABLE dbo.GENERATIONS ALTER COLUMN VERNUM int NULL;
  ALTER TABLE dbo.GENERATIONS WITH CHECK
    ADD CONSTRAINT FK_GENERATIONS_SHEETVERS FOREIGN KEY (SHTID, VERNUM) REFERENCES dbo.SHEETVERS (SHTID, VERNUM);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_GENERATIONS_SHTID')
  CREATE INDEX IX_GENERATIONS_SHTID ON dbo.GENERATIONS (SHTID, CREDAT DESC);
GO

/* ─────────────────────────────── Données de référence ─────────────────────────────── */

MERGE dbo.LANGUAGES AS t
USING (VALUES
  ('fr', N'Français', 1, 1, 1),
  ('en', N'English',  0, 1, 2),
  ('de', N'Deutsch',  0, 1, 3),
  ('es', N'Español',  0, 1, 4),
  ('it', N'Italiano', 0, 1, 5),
  ('nl', N'Nederlands', 0, 1, 6)
) AS s (LNGCOD, LNGNAM, ISDEFAULT, ACTIVE, SORTORD)
ON t.LNGCOD = s.LNGCOD
WHEN NOT MATCHED THEN
  INSERT (LNGCOD, LNGNAM, ISDEFAULT, ACTIVE, SORTORD)
  VALUES (s.LNGCOD, s.LNGNAM, s.ISDEFAULT, s.ACTIVE, s.SORTORD);
GO

MERGE dbo.COLORS AS t
USING (VALUES ('ROUGE', 1), ('ROSE', 2), ('BLANC', 3)) AS s (COLCOD, SORTORD)
ON t.COLCOD = s.COLCOD
WHEN NOT MATCHED THEN INSERT (COLCOD, SORTORD) VALUES (s.COLCOD, s.SORTORD);
GO

-- Échelle bouche (cahier des charges) : rouge 1 = léger / 5 = puissant ;
-- rosé 1 = sec / 5 = doux ; blanc 1 = sec / 5 = moelleux.
MERGE dbo.COLORTRANS AS t
USING (VALUES
  ('ROUGE', 'fr', N'Rouge',  N'Léger',  N'Puissant'),
  ('ROSE',  'fr', N'Rosé',   N'Sec',    N'Doux'),
  ('BLANC', 'fr', N'Blanc',  N'Sec',    N'Moelleux'),
  ('ROUGE', 'en', N'Red',    N'Light',  N'Powerful'),
  ('ROSE',  'en', N'Rosé',   N'Dry',    N'Sweet'),
  ('BLANC', 'en', N'White',  N'Dry',    N'Sweet'),
  ('ROUGE', 'de', N'Rot',    N'Leicht', N'Kräftig'),
  ('ROSE',  'de', N'Rosé',   N'Trocken', N'Süß'),
  ('BLANC', 'de', N'Weiß',   N'Trocken', N'Lieblich'),
  ('ROUGE', 'es', N'Tinto',  N'Ligero', N'Potente'),
  ('ROSE',  'es', N'Rosado', N'Seco',   N'Dulce'),
  ('BLANC', 'es', N'Blanco', N'Seco',   N'Dulce'),
  ('ROUGE', 'it', N'Rosso',  N'Leggero', N'Potente'),
  ('ROSE',  'it', N'Rosato', N'Secco',  N'Dolce'),
  ('BLANC', 'it', N'Bianco', N'Secco',  N'Amabile'),
  ('ROUGE', 'nl', N'Rood',   N'Licht',  N'Krachtig'),
  ('ROSE',  'nl', N'Rosé',   N'Droog',  N'Zoet'),
  ('BLANC', 'nl', N'Wit',    N'Droog',  N'Zoet')
) AS s (COLCOD, LNGCOD, LABEL, BOUMIN, BOUMAX)
ON t.COLCOD = s.COLCOD AND t.LNGCOD = s.LNGCOD
WHEN NOT MATCHED THEN
  INSERT (COLCOD, LNGCOD, LABEL, BOUMIN, BOUMAX)
  VALUES (s.COLCOD, s.LNGCOD, s.LABEL, s.BOUMIN, s.BOUMAX);
GO

/* ─────────────────────────────── Exemple (optionnel) ───────────────────────────────
   Fiche VHL09393 du cahier des charges, à décommenter pour un jeu de test.

DECLARE @ID int;
INSERT INTO dbo.SHEETS (CODVRAC, MILLESIME, APPELL, COLCOD, DESCVRAC, INTARO, INTBOU, ECHFRU, TEMPMIN, TEMPMAX, CREUSR, MODUSR)
VALUES (N'VHL09393', 2025, N'CDR', 'BLANC', N'STANDARD', 3, 1, 3, 8, 10, N'init', N'init');
SET @ID = SCOPE_IDENTITY();
INSERT INTO dbo.SHEETTRANS (SHTID, LNGCOD, TERROIR, VINIF, DEGUST, GARDE, ACCORDS, ACCEXPL, MODUSR)
VALUES (@ID, 'fr',
  N'Climat Méditerranéen lumineux et ponctué par des épisodes de mistral. Périodes estivales et hivernales sèches avec de fortes chaleurs en été. Précipitations concentrées à l''automne et au printemps.
Deux types de sol se distinguent en Côtes du Rhône méridionales : Le sol argilo-calcaire fait de roche sédimentaire et de galets. Et les sols caillouteux sur sous-sol de sable.',
  N'La qualité de nos vins réside dans l''attention portée à chaque étape. Les raisins blancs sont cueillis à des températures fraiches pour préserver leur potentiel, ils sont doucement pressés afin de conserver fraicheur et complexité des arômes et d''éviter l''oxydation. La fermentation s''effectue à l''aide de levures sélectionnées sous maitrise minutieuse de la température. Une partie des lies fines est conservée pour apporter de rondeur et de finesse. L''élevage est réalisée en cuve inox.',
  N'Sous sa robe jaune pâle brillante, ce Prestige Blanc dévoile des nuances aromatiques de fruits jaunes généreux réhaussés de notes florales. La dégustation présente une belle fraicheur légèrement veloutée et accompagnée de touches acidulées.',
  N'2 ans',
  N'Viande blanche, dorade à la plancha, salade paysanne',
  N'Il faut des plats plutôt légers mais pas acides, il faut consolider le gras du vin sans l''alourdir, vous pouvez même avoir des plats épicés sans aspects mentholés (pas de coriandre, pas de clou de girofle).',
  N'init');
INSERT INTO dbo.SHEETEVTS (SHTID, EVTTYP, TOSTS, EVTUSR) VALUES (@ID, 'CREATED', 'DRAFT', N'init');
──────────────────────────────────────────────────────────────────────────────────── */
