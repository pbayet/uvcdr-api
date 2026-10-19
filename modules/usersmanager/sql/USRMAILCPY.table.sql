/* ═══════════════════════════════════════════════════════════════════════════
   USERSMANAGER — Copies de mails entre utilisateurs (USRMAILCPY)
   Module API : modules/usersmanager + core/services/mail.service.js

   Une ligne (USRID, SRCUSRID) signifie : « l'utilisateur USRID reçoit aussi,
   en copie cachée, les mails envoyés à l'utilisateur SRCUSRID ».
   Exemple : une assistante (USRID) qui suit les mails de son responsable
   (SRCUSRID), ou un remplaçant pendant une absence.

   - Saisie : onglet « Copies mails » de la fiche utilisateur (users-manager),
     enregistrée par services.delsertUserMailCopies (DELETE puis INSERT).
   - Lecture : colonne JSON MAILCOPIES de sp_GetUsers_JSON.
   - Envoi : sendMail() (core/services/mail.service.js) ajoute en BCC les
     adresses des utilisateurs actifs abonnés aux destinataires to/cc/bcc.
     Un seul niveau : pas de propagation en chaîne (A ← B ← C ne donne pas
     A ← C).

   Script idempotent, à exécuter une fois par environnement sur la base
   USERSMANAGER avec un compte disposant des droits DDL.
═══════════════════════════════════════════════════════════════════════════ */

USE [USERSMANAGER];
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

/* ─── Table ─────────────────────────────────────────────────────────────── */
-- Types alignés sur USERS.USRID (int), comme USRHRC / USRGRP / PRMUSR :
-- imposé par les clés étrangères (même type que la colonne référencée).
IF OBJECT_ID(N'dbo.USRMAILCPY', N'U') IS NULL
BEGIN
  CREATE TABLE [dbo].[USRMAILCPY](
    [USRID]    [int] NOT NULL, -- destinataire de la copie
    [SRCUSRID] [int] NOT NULL, -- utilisateur dont les mails sont copiés
    [CREDAT]   [datetime] NOT NULL CONSTRAINT [DF_USRMAILCPY_CREDAT] DEFAULT (GETDATE()),
    CONSTRAINT [PK_USRMAILCPY] PRIMARY KEY CLUSTERED ([USRID] ASC, [SRCUSRID] ASC),
    CONSTRAINT [FK_USRMAILCPY_USRID] FOREIGN KEY ([USRID]) REFERENCES [dbo].[USERS] ([USRID]),
    CONSTRAINT [FK_USRMAILCPY_SRCUSRID] FOREIGN KEY ([SRCUSRID]) REFERENCES [dbo].[USERS] ([USRID]),
    CONSTRAINT [CK_USRMAILCPY_NOT_SELF] CHECK ([USRID] <> [SRCUSRID])
  ) ON [PRIMARY];
END
GO

-- Lookup à l'envoi : « qui suit les mails de SRCUSRID ? »
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'IX_USRMAILCPY_SRCUSRID' AND object_id = OBJECT_ID(N'dbo.USRMAILCPY')
)
  CREATE NONCLUSTERED INDEX [IX_USRMAILCPY_SRCUSRID]
    ON [dbo].[USRMAILCPY] ([SRCUSRID]) INCLUDE ([USRID]);
GO

/* ─── sp_GetUsers_JSON : ajout de la colonne MAILCOPIES ─────────────────── */
-- Identique à la version de USERSMANGER.tables.sql, avec en plus le bloc
-- « 5b. Copies mails » et la colonne MAILCOPIES dans le SELECT final.

    -- ============================================================
    -- sp_GetUsers_JSON
    -- Remplace la vue V_Users_JSON
    -- Optimisations :
    --   1. Tables temporaires indexées pour UserGroups et BestPermissions
    --      (évite la réévaluation des CTEs)
    --   2. USRID casté une seule fois dans #Base
    --   3. SELECT final avec LEFT JOINs simples — plus de sous-requêtes corrélées
    --   4. JSON pré-agrégé par USRID dans des tables temporaires dédiées
    --
    -- Usage :
    --   EXEC dbo.sp_GetUsers_JSON;                     -- tous les utilisateurs
    --   EXEC dbo.sp_GetUsers_JSON @USRID = 42;         -- un seul utilisateur
    -- ============================================================
    CREATE OR ALTER PROCEDURE [dbo].[sp_GetUsers_JSON] @USRID INT = NULL,
    -- NULL = tous les utilisateurs
    @EMAIL NVARCHAR(255) = NULL,
    -- NULL = tous les utilisateurs
    @POSCOD NVARCHAR(10) = NULL -- NULL = tous les utilisateurs
    AS BEGIN
SET
    NOCOUNT ON;

-- --------------------------------------------------------
-- 0. Base : cast USRID une seule fois
-- --------------------------------------------------------
DROP TABLE IF EXISTS #Base;
SELECT
    u.USRID,
    u.ADID,
    u.LSTNAM,
    u.FSTNAM,
    u.EMAIL,
    u.PHNNUM,
    CAST(u.ACTIVE AS BIT) AS USRACTV,
    CAST(u.ISEXT AS BIT) AS ISEXT,
    u.POSID,
    CAST(u.USRID AS VARCHAR(100)) AS USRID_STR INTO #Base
FROM
    dbo.USERS u
    LEFT JOIN dbo.POSITIONS p ON p.POSID = u.POSID
WHERE
    (
        @USRID IS NULL
        OR u.USRID = @USRID
    )
    AND (
        @EMAIL IS NULL
        OR u.EMAIL = @EMAIL
    )
    AND (
        @POSCOD IS NULL
        OR p.POSCOD = @POSCOD
    );

-- --------------------------------------------------------
-- 1. Image utilisateur (1 seul scan ATTACHMENTS)
-- --------------------------------------------------------
DROP TABLE IF EXISTS #UserImages;
SELECT
    b.USRID,
    (
        SELECT
            TOP 1 a.ID,
            a.FILECODE,
            a.APPCODE,
            a.ENTITYTYPE,
            a.ENTITYID,
            a.ORIGINALNAME,
            a.STOREDNAME,
            a.RELATIVEPATH,
            a.MIMETYPE,
            a.EXTENSION,
            a.COMPRESSED,
            a.ORIGINALSIZEBYTES,
            a.SIZEBYTES,
            a.STATUS,
            a.UPLOADEDBY,
            a.CREATEDAT,
            a.DELETEDAT
        FROM
            APPATTACHMENTS.dbo.ATTACHMENTS a
        WHERE
            a.ENTITYID = b.USRID_STR
            AND a.DELETEDAT IS NULL
        ORDER BY
            a.CREATEDAT DESC FOR JSON PATH,
            WITHOUT_ARRAY_WRAPPER
    ) AS USRIMG INTO #UserImages
FROM
    #Base b;
    -- --------------------------------------------------------
    -- 2. Service + Positions (1 seul scan V_PositionsServices)
    -- --------------------------------------------------------
    DROP TABLE IF EXISTS #UserServices;
;

WITH PS AS (
    SELECT
        DISTINCT b.USRID,
        ps.SRVID,
        ps.SRVCOD,
        ps.SRVNAM,
        ps.SRVDES,
        ps.POSID,
        ps.POSNAM,
        ps.POSDES,
        ps.POSCOD,
        ps.POSLVL
    FROM
        #Base b
        JOIN dbo.V_PositionsServices ps ON ps.POSID = b.POSID
)
SELECT
    USRID,
    (
        SELECT
            TOP 1 p.SRVID,
            p.SRVCOD,
            p.SRVNAM,
            p.SRVDES,
            (
                SELECT
                    p2.POSID,
                    p2.POSNAM,
                    p2.POSDES,
                    p2.POSCOD,
                    p2.POSLVL
                FROM
                    PS p2
                WHERE
                    p2.USRID = p.USRID
                    AND p2.SRVID = p.SRVID FOR JSON PATH
            ) AS POSITIONS
        FROM
            PS p
        WHERE
            p.USRID = PS.USRID FOR JSON PATH,
            WITHOUT_ARRAY_WRAPPER
    ) AS SERVICE INTO #UserServices
FROM
    PS
GROUP BY
    USRID;

-- --------------------------------------------------------
-- 3. Groupes (1 seul scan USRGRP + GROUPS)
-- --------------------------------------------------------
DROP TABLE IF EXISTS #UserGroups;
SELECT
    b.USRID,
    g.GRPID,
    g.GRPNAM,
    g.GRPDES,
    CAST(g.ACTIVE AS BIT) AS GRPACTV INTO #UserGroups
FROM
    #Base b
    LEFT JOIN dbo.USRGRP ug ON ug.USRID = b.USRID
    LEFT JOIN dbo.GROUPS g ON g.GRPID = ug.GRPID
    OR g.GRPBAS = 1
WHERE
    ug.GRPID IS NOT NULL
    OR g.GRPBAS = 1;

CREATE INDEX ix_ug_usrid ON #UserGroups(USRID);
-- Pré-agrégation JSON des groupes par utilisateur
DROP TABLE IF EXISTS #GroupsJSON;
SELECT
    USRID,
    (
        SELECT
            DISTINCT ug2.GRPID,
            ug2.GRPNAM,
            ug2.GRPDES,
            ug2.GRPACTV
        FROM
            #UserGroups ug2
        WHERE
            ug2.USRID = #UserGroups.USRID
            FOR JSON PATH
    ) AS GROUPS INTO #GroupsJSON
FROM
    #UserGroups
GROUP BY
    USRID;

-- --------------------------------------------------------
-- 4. Permissions — toutes sources, puis déduplication
-- --------------------------------------------------------
DROP TABLE IF EXISTS #AllPermissions;
-- 4a. Permissions directes
SELECT
    up.USRID,
    up.APPID,
    up.APPCOD,
    up.APPNAM,
    up.APPDES,
    up.APPLNK,
    up.IMGLNK,
    up.LOGLNK,
    up.DOCLNK,
    CAST(up.APPACTV AS BIT) AS APPACTV,
    up.PRMID,
    up.PRMNAM,
    up.PRMDES,
    up.PRMLVL,
    CAST(up.ISCRIT AS BIT) AS ISCRIT,
    CASE
        WHEN up.SRC = 'GROUP' THEN 1
        ELSE 0
    END AS BYGRP INTO #AllPermissions
FROM
    dbo.V_HighPermissions up
    JOIN #Base b ON b.USRID = up.USRID
WHERE
    up.APPID IS NOT NULL
    AND up.PRMID IS NOT NULL
UNION
ALL -- 4b. Permissions via groupes
SELECT
    ug.USRID,
    gp.APPID,
    gp.APPCOD,
    gp.APPNAM,
    gp.APPDES,
    gp.APPLNK,
    gp.IMGLNK,
    gp.LOGLNK,
    gp.DOCLNK,
    CAST(gp.APPACTV AS BIT) AS APPACTV,
    gp.PRMID,
    gp.PRMNAM,
    gp.PRMDES,
    gp.PRMLVL,
    CAST(gp.ISCRIT AS BIT) AS ISCRIT,
    1 AS BYGRP
FROM
    #UserGroups ug
    JOIN dbo.V_GroupsPermission gp ON gp.GRPID = ug.GRPID
WHERE
    gp.APPID IS NOT NULL
    AND gp.PRMID IS NOT NULL;

-- 4c. Déduplication : niveau le plus élevé, directe prioritaire
DROP TABLE IF EXISTS #BestPermissions;
SELECT
    USRID,
    APPID,
    APPCOD,
    APPNAM,
    APPDES,
    APPLNK,
    IMGLNK,
    LOGLNK,
    DOCLNK,
    APPACTV,
    PRMID,
    PRMNAM,
    PRMDES,
    PRMLVL,
    ISCRIT,
    BYGRP INTO #BestPermissions
FROM
    (
        SELECT
            *,
            ROW_NUMBER() OVER (
                PARTITION BY USRID,
                APPID,
                PRMID
                ORDER BY
                    PRMLVL DESC,
                    BYGRP ASC
            ) AS rn
        FROM
            #AllPermissions
    ) ranked
WHERE
    rn = 1;

CREATE INDEX ix_bp_usrid_appid ON #BestPermissions(USRID, APPID);
-- 4d. Pré-agrégation JSON des permissions par utilisateur
DROP TABLE IF EXISTS #PermissionsJSON;
SELECT
    bp.USRID,
    (
        SELECT
            bp2.APPID,
            bp2.APPCOD,
            bp2.APPNAM,
            bp2.APPDES,
            bp2.APPLNK,
            bp2.IMGLNK,
            bp2.LOGLNK,
            bp2.DOCLNK,
            bp2.APPACTV AS ACTIVE,
            (
                SELECT
                    bp3.PRMID,
                    bp3.PRMNAM,
                    bp3.PRMDES,
                    bp3.PRMLVL,
                    bp3.BYGRP AS BYGRP,
                    bp3.ISCRIT AS ISCRIT
                FROM
                    #BestPermissions bp3
                WHERE
                    bp3.USRID = bp2.USRID
                    AND bp3.APPID = bp2.APPID
                    AND bp3.PRMID = bp2.PRMID FOR JSON PATH,
                    WITHOUT_ARRAY_WRAPPER
            ) AS PERMISSION
        FROM
            #BestPermissions bp2
        WHERE
            bp2.USRID = bp.USRID FOR JSON PATH
    ) AS PERMISSIONS INTO #PermissionsJSON
FROM
    #BestPermissions bp
GROUP BY
    bp.USRID;

-- --------------------------------------------------------
-- 5. Subordonnés (1 seul scan V_UserSubordinates)
-- --------------------------------------------------------
DROP TABLE IF EXISTS #SubordinatesJSON;
SELECT
    b.USRID,
    (
        SELECT
            us.SUBID,
            us.SUBNAM,
            us.SUBLVL
        FROM
            dbo.V_UserSubordinates us
        WHERE
            us.MANID = b.USRID FOR JSON PATH
    ) AS SUBORDINATES INTO #SubordinatesJSON
FROM
    #Base b;
-- --------------------------------------------------------
-- 5b. Copies mails : utilisateurs dont b.USRID reçoit les mails (USRMAILCPY)
-- --------------------------------------------------------
DROP TABLE IF EXISTS #MailCopiesJSON;
SELECT
    b.USRID,
    (
        SELECT
            mc.SRCUSRID,
            CONCAT(su.LSTNAM, ' ', su.FSTNAM) AS SRCNAM,
            su.EMAIL AS SRCEMAIL
        FROM
            dbo.USRMAILCPY mc
            JOIN dbo.USERS su ON su.USRID = mc.SRCUSRID
        WHERE
            mc.USRID = b.USRID
        ORDER BY
            su.LSTNAM,
            su.FSTNAM FOR JSON PATH
    ) AS MAILCOPIES INTO #MailCopiesJSON
FROM
    #Base b;
    -- --------------------------------------------------------
    -- 6. SELECT final — jointures simples, zéro sous-requête corrélée
    -- --------------------------------------------------------
SELECT
    b.USRID,
    b.ADID,
    b.LSTNAM,
    b.FSTNAM,
    b.EMAIL,
    b.PHNNUM,
    b.USRACTV,
    b.ISEXT,
    ui.USRIMG,
    srv.SERVICE,
    sub.SUBORDINATES,
    perm.PERMISSIONS,
    grp.GROUPS,
    mc.MAILCOPIES
FROM
    #Base b
    LEFT JOIN #UserImages      ui   ON ui.USRID   = b.USRID
    LEFT JOIN #UserServices    srv  ON srv.USRID   = b.USRID
    LEFT JOIN #SubordinatesJSON sub ON sub.USRID   = b.USRID
    LEFT JOIN #PermissionsJSON  perm ON perm.USRID = b.USRID
    LEFT JOIN #GroupsJSON       grp ON grp.USRID   = b.USRID
    LEFT JOIN #MailCopiesJSON   mc  ON mc.USRID    = b.USRID
ORDER BY
    b.LSTNAM,
    b.FSTNAM;

END;
GO
