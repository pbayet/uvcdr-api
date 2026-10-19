import sql from "mssql";
import { runQuery } from "../../core/utils/db.utils.js";

/* ═══════════════════════════════════════════════════════════════
   TICKETS — Services
   Tables réelles utilisées :
     TICKETS, TICKETNOTES, TICKETTRACKING, TICKETCC, TICKETSERVICES,
     STATUSES, PRIORITIES, SERVICES,
     CATEGORIES, SUBCATEGORIES1/2/3,
     SERVICEASSIGNMENTS,
     USERSMANAGER.dbo.USERS  (cross-base)

   Vues utilisées :
     V_TCK_LASTTRK  → dernier tracking (= statut actuel) par ticket
     V_TCK_LASTNOTE → dernière note par ticket

   Le TCKCOD est généré par un trigger BD à l'INSERT → on ne le calcule pas.

   NB : par rapport à V1.0.0, chaque fonction utilise désormais le helper
   runQuery() (core/utils/db.utils.js) qui remplace le motif répété
   getDbConnexion → generateAutoKey → getPreparedStatement → execute
   (cf. audit dette technique 4.2). Le TTL des prepared statements est
   laissé à sa valeur par défaut (5 min) au lieu d'être détruit et recréé à
   chaque appel comme c'était le cas ici en V1.0.0.
═══════════════════════════════════════════════════════════════ */

const SELECT_TICKETS = `
WITH MyServices AS (
  SELECT DISTINCT sa.SRVID
  FROM   dbo.SERVICEASSIGNMENTS AS sa
  WHERE  sa.USRID = @USRID
),
MyProjects AS (
  -- Projets auxquels l'utilisateur est associé (PROJECTUSERS, cf.
  -- sql/PROJECTUSERS.table.sql) OU qu'il a lui-même créés (PROJECTS.CREUSR,
  -- cf. services.getUserProjects) : un utilisateur associé à un projet, ou
  -- qui en est le créateur, voit tous les tickets de ce projet
  -- (TICKETPROJECTS), au même titre qu'un membre du service du ticket
  -- (MyServices ci-dessus) — utile pour suivre l'avancée d'un projet
  -- (Calendrier, Kanban Projets) sans être assigné/dans le service concerné.
  SELECT DISTINCT pu.PRJID
  FROM   dbo.PROJECTUSERS AS pu
  WHERE  pu.USRID = @USRID
  UNION
  SELECT DISTINCT p.PRJID
  FROM   dbo.PROJECTS AS p
  WHERE  p.CREUSR = @USRID
)
SELECT
  -- ── Ticket ────────────────────────────────────────────────
  t.TCKID,
  t.TCKCOD,
  t.TITLE,
  t.DESCR,
  t.CREUSR,
  t.ASGUSR,
  t.CREDAT,
  t.UPDDAT,
  -- CLSDAT réel si renseigné (closeTicket), sinon calculé à la volée
  -- (sans écriture en base) lorsque le ticket est CNCL/CLSD depuis plus
  -- d'1 mois (date du dernier changement de statut, cf. V_TCK_LASTTRK /
  -- ltrk.CREDAT) : la CLSDAT attribuée est alors CREDAT + 1 mois, et non
  -- CREDAT lui-même.
  COALESCE(
    t.CLSDAT,
    CASE
      WHEN sts.CODE IN ('CNCL', 'CLSD')
       AND ltrk.CREDAT <= DATEADD(MONTH, -1, SYSUTCDATETIME())
      THEN DATEADD(MONTH, 1, ltrk.CREDAT)
    END
  ) AS CLSDAT,
  t.DLTD,
  t.MRGID,
  t.DATDEB,
  t.DATFIN,
  t.DATDEBREEL,
  t.DATFINREEL,
  t.TPSPREV,
  t.TPSREEL,

  -- ── Service ───────────────────────────────────────────────
  t.SRVID,
  srv.NAME        AS SRVNAM,

  -- ── Services co-attribués (TICKETSERVICES) ────────────────
  -- En plus du service principal ci-dessus : mêmes droits d'accès et
  -- d'action, cf. sql/TICKETSERVICES.table.sql et la CTE MyServices
  -- étendue plus haut (clauses MYSRV/UNSEEN/WHERE).
  tsv.TSVID       AS TSVID,
  tsv.SRVID       AS TSVSRVID,
  tsvsrv.NAME     AS TSVSRVNAM,

  -- ── Statut actuel (via dernier tracking) ──────────────────
  ltrk.STSID,
  sts.NAME        AS STSNAM,
  sts.CODE        AS STSCOD,
  sts.LVLVAL      AS STSLVL,

  -- ── Priorité ──────────────────────────────────────────────
  t.PRIID,
  pri.NAME        AS PRINAM,
  pri.CODE        AS PRICOD,
  pri.LVLVAL      AS PRILVL,

  -- ── Catégories ────────────────────────────────────────────
  t.CATID,
  cat.NAME        AS CATNAM,
  t.SC1ID,
  sc1.NAME        AS SC1NAM,
  t.SC2ID,
  sc2.NAME        AS SC2NAM,
  t.SC3ID,
  sc3.NAME        AS SC3NAM,

  -- ── Créateur ──────────────────────────────────────────────
  RTRIM(ucre.LSTNAM) + ' ' + RTRIM(ucre.FSTNAM) AS USRNAM,
  ucre.EMAIL      AS CREEMAIL,

  -- ── Assigné ───────────────────────────────────────────────
  RTRIM(uasg.LSTNAM) + ' ' + RTRIM(uasg.FSTNAM) AS ASGNAM,

  -- ── Destinataires en copie (CC) ───────────────────────────
  cc.TCCID        AS CCID,
  cc.USRID        AS CCUSRID,
  RTRIM(ucc.LSTNAM) + ' ' + RTRIM(ucc.FSTNAM) AS CCUSRNAM,
  ucc.EMAIL       AS CCEMAIL,

  -- Projets rattachés (TICKETPROJECTS)
  tpj.TPJID       AS TPJID,
  tpj.PRJID       AS TPJPRJID,
  prj.NAME        AS TPJPRJNAM,
  prj.COLOR       AS TPJPRJCOLOR,

  -- ── Flag : l'utilisateur est membre du service PRINCIPAL du ticket ──
  -- (SRVID uniquement, pas les services secondaires ci-dessus) — pilote,
  -- côté front, l'édition de la catégorisation (CATID/SC1-3) et du service
  -- principal lui-même : réservés au service principal (cf. commentaire
  -- d'en-tête "attribution multi-service"), un membre d'un service
  -- secondaire peut voir ces champs (MYSRV) mais pas les modifier
  -- (MYPRIMARYSRV), cf. controllers.updateTicket.
  CASE
    WHEN EXISTS (SELECT 1 FROM MyServices ms WHERE ms.SRVID = t.SRVID)
    THEN 1 ELSE 0
  END AS MYPRIMARYSRV,

  -- ── Flag : l'utilisateur est membre du service du ticket (principal OU
  -- secondaire, cf. TICKETSERVICES) ──
  CASE
    WHEN EXISTS (
      SELECT 1 FROM MyServices ms
      WHERE ms.SRVID = t.SRVID
         OR EXISTS (
           SELECT 1 FROM dbo.TICKETSERVICES AS tsx
           WHERE tsx.TCKID = t.TCKID AND tsx.SRVID = ms.SRVID
         )
    )
    THEN 1 ELSE 0
  END AS MYSRV,

  -- ── Flag : l'utilisateur est associé à au moins un projet du ticket ──
  CASE
    WHEN EXISTS (
      SELECT 1 FROM dbo.TICKETPROJECTS AS tpjflag
      WHERE tpjflag.TCKID = t.TCKID
        AND tpjflag.PRJID IN (SELECT PRJID FROM MyProjects)
    )
    THEN 1 ELSE 0
  END AS MYPRJ,

  -- ── Flag : modification(s) non vue(s) par l'utilisateur courant ──
  -- "Non vu" = un événement pertinent est survenu après la dernière
  -- consultation connue (tv.LASTSEENDAT), ou après la création du ticket
  -- si jamais consulté (COALESCE ... t.CREDAT) — cf. sql/TICKETVIEWS.table.sql.
  -- Chaque source est soumise à sa propre règle de visibilité, alignée sur
  -- ce que TicketFormModal.tsx affiche réellement à l'utilisateur :
  --   - Titre/description/planification : toujours, y compris pour un
  --     non-MYSRV — ces champs sont visibles par tous ceux qui accèdent au
  --     ticket (créateur, assigné, CC...), au même titre que Service.
  --   - Service : toujours, y compris pour un non-MYSRV puisque ça a un
  --     impact direct sur son ticket.
  --   - Rattachement/retrait de projet (TICKETPROJECTS) : toujours, même
  --     raison que le service.
  --   - Assignation et catégorisation/priorité (groupe CLASSIFICATION) :
  --     seulement si MYSRV — ces champs ne sont montrés qu'aux membres du
  --     service (canShowClassificationSection côté front).
  --   - Notes/tâches publiques : toujours ; privées (PUBLIC = 0) : jamais
  --     pour un tiers (implicite ici via USRID <> @USRID, l'auteur d'une
  --     note privée n'a de toute façon pas besoin d'être notifié de son
  --     propre ajout).
  CASE WHEN EXISTS (
    SELECT 1 FROM dbo.TICKETFIELDCHANGES AS fc
    WHERE fc.TCKID = t.TCKID
      AND fc.USRID <> @USRID
      AND fc.CREDAT > COALESCE(tv.LASTSEENDAT, t.CREDAT)
      AND (
        fc.FIELDGRP IN ('SERVICE', 'TITLE', 'DESCR', 'PLANNING')
        OR (
          fc.FIELDGRP IN ('CLASSIFICATION', 'ASSIGNEE')
          AND EXISTS (
      SELECT 1 FROM MyServices ms
      WHERE ms.SRVID = t.SRVID
         OR EXISTS (
           SELECT 1 FROM dbo.TICKETSERVICES AS tsx
           WHERE tsx.TCKID = t.TCKID AND tsx.SRVID = ms.SRVID
         )
    )
        )
      )
    UNION ALL
    SELECT 1 FROM APPATTACHMENTS.dbo.ATTACHMENTS AS atts
    WHERE atts.ENTITYTYPE = 'TCKCOD'
      AND atts.ENTITYID = t.TCKCOD
      AND atts.CREATEDAT > COALESCE(tv.LASTSEENDAT, t.CREDAT)
    UNION ALL
    SELECT 1 FROM dbo.TICKETTRACKING AS trkun
    WHERE trkun.TCKID = t.TCKID
      AND trkun.USRID <> @USRID
      AND trkun.CREDAT > COALESCE(tv.LASTSEENDAT, t.CREDAT)
    UNION ALL
    SELECT 1 FROM dbo.TICKETNOTES AS nun
    WHERE nun.TCKID = t.TCKID
      AND nun.USRID <> @USRID
      AND nun.[PUBLIC] = 1
      AND nun.CREDAT > COALESCE(tv.LASTSEENDAT, t.CREDAT)
    UNION ALL
    SELECT 1 FROM dbo.TICKETTODOS AS tdun
    WHERE tdun.TCKID = t.TCKID
      AND tdun.USRID <> @USRID
      AND tdun.[PUBLIC] = 1
      AND COALESCE(tdun.UPDDAT, tdun.CREDAT) > COALESCE(tv.LASTSEENDAT, t.CREDAT)
    UNION ALL
    SELECT 1 FROM dbo.TICKETPROJECTS AS tpjnew
    WHERE tpjnew.TCKID = t.TCKID
      AND tpjnew.CREDAT > COALESCE(tv.LASTSEENDAT, t.CREDAT)
  ) THEN 1 ELSE 0 END AS UNSEEN,

  -- ── Notes ─────────────────────────────────────────────────
  n.NTEID         AS NOTID,
  n.CMNT          AS NOTCMT,
  n.USRID         AS NOTUSRID,
  RTRIM(unot.LSTNAM) + ' ' + RTRIM(unot.FSTNAM) AS NOTUSRNAM,
  n.[PUBLIC]        AS NOTPUBLIC,
  n.CREDAT        AS NOTCREDAT,

   -- ── Attachments ──────────────────────────────────────────
  atts.ID AS ATTID,
  atts.FILECODE AS ATTFILECODE,
  atts.APPCODE AS ATTAPPCODE,
  atts.ENTITYTYPE AS ATTENTITYTYPE,
  atts.ENTITYID AS ATTENTITYID,
  atts.ORIGINALNAME AS ATTORIGINALNAME,
  atts.STOREDNAME AS ATTSTOREDNAME,
  atts.RELATIVEPATH AS ATTRELATIVEPATH,
  atts.MIMETYPE AS ATTMIMETYPE,
  atts.EXTENSION AS ATTEXTENSION,
  atts.COMPRESSED AS ATTCOMPRESSED,
  atts.ORIGINALSIZEBYTES AS ATTORIGINALSIZEBYTES,
  atts.SIZEBYTES AS ATTSIZEBYTES,
  atts.CHECKSUMSHA256 AS ATTCHECKSUMSHA256,
  atts.STATUS AS ATTSTATUS,
  atts.UPLOADEDBY AS ATTUPLOADEDBY,
  atts.CREATEDAT AS ATTCREATEDAT,
  atts.DELETEDAT AS ATTDELETEDAT,

   -- ── Notes attachments ────────────────────────────────────
  natts.ID AS NATTID,
  natts.FILECODE AS NATTFILECODE,
  natts.APPCODE AS NATTAPPCODE,
  natts.ENTITYTYPE AS NATTENTITYTYPE,
  natts.ENTITYID AS NATTENTITYID,
  natts.ORIGINALNAME AS NATTORIGINALNAME,
  natts.STOREDNAME AS NATTSTOREDNAME,
  natts.RELATIVEPATH AS NATTRELATIVEPATH,
  natts.MIMETYPE AS NATTMIMETYPE,
  natts.EXTENSION AS NATTEXTENSION,
  natts.COMPRESSED AS NATTCOMPRESSED,
  natts.ORIGINALSIZEBYTES AS NATTORIGINALSIZEBYTES,
  natts.SIZEBYTES AS NATTSIZEBYTES,
  natts.CHECKSUMSHA256 AS NATTCHECKSUMSHA256,
  natts.STATUS AS NATTSTATUS,
  natts.UPLOADEDBY AS NATTUPLOADEDBY,
  natts.CREATEDAT AS NATTCREATEDAT,
  natts.DELETEDAT AS NATTDELETEDAT,

  trk.TRKID AS ALLTRKID,
  trk.TCKID AS TRKTCKID,
  trk.CMNT AS TRKCMNT,
  trk.CREDAT AS ALLTRKDAT,

  -- ── Dernier tracking (historique statut) ──────────────────
  ltrk.TRKID,
  ltrk.CMNT       AS TRKCMT,
  ltrk.CREDAT     AS TRKDAT

FROM dbo.TICKETS AS t

-- Service
LEFT JOIN dbo.SERVICES          AS srv  ON srv.SRVID   = t.SRVID

-- Services co-attribués (many-to-many, cf. sql/TICKETSERVICES.table.sql)
LEFT JOIN dbo.TICKETSERVICES     AS tsv  ON tsv.TCKID   = t.TCKID
LEFT JOIN dbo.SERVICES           AS tsvsrv ON tsvsrv.SRVID = tsv.SRVID

-- Dernier tracking → statut actuel
LEFT JOIN dbo.TICKETTRACKING     AS trk ON trk.TCKID  = t.TCKID
LEFT JOIN dbo.V_TCK_LASTTRK     AS ltrk ON ltrk.TCKID  = t.TCKID
LEFT JOIN dbo.STATUSES          AS sts  ON sts.STSID   = ltrk.STSID

-- Priorité
LEFT JOIN dbo.PRIORITIES        AS pri  ON pri.PRIID   = t.PRIID

-- Catégories
LEFT JOIN dbo.CATEGORIES        AS cat  ON cat.CATID   = t.CATID
LEFT JOIN dbo.SUBCATEGORIES1    AS sc1  ON sc1.SC1ID   = t.SC1ID
LEFT JOIN dbo.SUBCATEGORIES2    AS sc2  ON sc2.SC2ID   = t.SC2ID
LEFT JOIN dbo.SUBCATEGORIES3    AS sc3  ON sc3.SC3ID   = t.SC3ID

-- Utilisateurs (cross-base)
LEFT JOIN USERSMANAGER.dbo.USERS AS ucre ON ucre.USRID = t.CREUSR
LEFT JOIN USERSMANAGER.dbo.USERS AS uasg ON uasg.USRID = t.ASGUSR

-- CC (destinataires en copie)
LEFT JOIN dbo.TICKETCC           AS cc  ON cc.TCKID  = t.TCKID
LEFT JOIN USERSMANAGER.dbo.USERS AS ucc ON ucc.USRID = cc.USRID

-- Projets rattachés (many-to-many)
LEFT JOIN dbo.TICKETPROJECTS      AS tpj ON tpj.TCKID = t.TCKID
LEFT JOIN dbo.PROJECTS            AS prj ON prj.PRJID = tpj.PRJID

-- Dernière consultation par l'utilisateur courant (cf. UNSEEN plus haut)
LEFT JOIN dbo.TICKETVIEWS        AS tv  ON tv.TCKID   = t.TCKID AND tv.USRID = @USRID

-- Notes
LEFT JOIN dbo.TICKETNOTES        AS n   ON n.TCKID     = t.TCKID
LEFT JOIN USERSMANAGER.dbo.USERS AS unot ON unot.USRID = n.USRID

-- Attachments
LEFT JOIN APPATTACHMENTS.dbo.ATTACHMENTS AS atts
  ON atts.APPCODE = 'TCK'
 AND atts.ENTITYID = t.TCKCOD
 AND atts.DELETEDAT IS NULL

-- Notes attachments
LEFT JOIN APPATTACHMENTS.dbo.ATTACHMENTS AS natts
  ON natts.APPCODE = 'TCK'
 AND natts.ENTITYID = CONVERT(varchar(50), n.NTEID)
 AND natts.DELETEDAT IS NULL

WHERE
  (
    (t.CREUSR = @USRID OR t.ASGUSR = @USRID)
    OR EXISTS (
      SELECT 1 FROM MyServices ms
      WHERE ms.SRVID = t.SRVID
         OR EXISTS (
           SELECT 1 FROM dbo.TICKETSERVICES AS tsx
           WHERE tsx.TCKID = t.TCKID AND tsx.SRVID = ms.SRVID
         )
    )
    OR EXISTS (
      SELECT 1 FROM dbo.TICKETPROJECTS AS tpjacc
      WHERE tpjacc.TCKID = t.TCKID
        AND tpjacc.PRJID IN (SELECT PRJID FROM MyProjects)
    )
    -- Destinataire en copie (TICKETCC) : reçoit les mêmes notifications
    -- mail que le demandeur (cf. mail.service) mais n'avait jusqu'ici
    -- aucun moyen de retrouver le ticket dans son tableau de bord — même
    -- règle d'accès que MyServices/MyProjects ci-dessus.
    OR EXISTS (
      SELECT 1 FROM dbo.TICKETCC AS ccacc
      WHERE ccacc.TCKID = t.TCKID
        AND ccacc.USRID = @USRID
    )
  )
`;

/* ───────────────────────────────────────────────────────────────
   GET — Liste de tous les tickets accessibles par l'utilisateur
─────────────────────────────────────────────────────────────── */
export async function getTickets(USRID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `${SELECT_TICKETS} ORDER BY t.UPDDAT DESC, t.TCKID DESC, n.CREDAT ASC`,
    inputs: {
      USRID: { type: sql.Int, value: USRID },
      CODE: { type: sql.NVarChar(30), value: null },
    },
  });
  return result.recordset;
}

/* ───────────────────────────────────────────────────────────────
   GET — Un ticket par TCKCOD
─────────────────────────────────────────────────────────────── */
export async function getTicket(USRID, CODE) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `${SELECT_TICKETS} AND t.TCKCOD = @CODE ORDER BY n.CREDAT ASC`,
    inputs: {
      USRID: { type: sql.Int, value: USRID },
      CODE: { type: sql.NVarChar(30), value: CODE },
    },
  });
  return result.recordset;
}

/* ───────────────────────────────────────────────────────────────
   POST — Créer un ticket
   Le TCKCOD est généré par le trigger BD → on ne le passe pas.
   Un premier tracking est inséré pour tracer le statut initial.
─────────────────────────────────────────────────────────────── */
export async function createTicket({
  TITLE,
  DESCR,
  SRVID,
  STSID,
  CATID,
  SC1ID,
  SC2ID,
  SC3ID,
  PRIID,
  ASGUSR,
  CREUSR,
  DATDEB,
  DATFIN,
  DATDEBREEL,
  DATFINREEL,
  TPSPREV,
  TPSREEL,
}) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    DECLARE @TCKID INT;
    DECLARE @RESOLVED_STSID INT = ISNULL(@STSID, (SELECT TOP 1 STSID FROM dbo.STATUSES WHERE ACTIVE = 1 ORDER BY LVLVAL ASC));

    INSERT INTO dbo.TICKETS (TITLE, DESCR, SRVID, CATID, SC1ID, SC2ID, SC3ID, PRIID, ASGUSR, CREUSR, STSID, DATDEB, DATFIN, DATDEBREEL, DATFINREEL, TPSPREV, TPSREEL)
    VALUES (@TITLE, @DESCR, @SRVID, @CATID, @SC1ID, @SC2ID, @SC3ID,
           @PRIID, @ASGUSR, @CREUSR, @RESOLVED_STSID, @DATDEB, @DATFIN, @DATDEBREEL, @DATFINREEL, @TPSPREV, @TPSREEL);

    SET @TCKID = SCOPE_IDENTITY();

    -- Premier tracking : statut initial
    INSERT INTO dbo.TICKETTRACKING (TCKID, STSID, USRID, CMNT)
    VALUES (@TCKID, @RESOLVED_STSID, @CREUSR, NULL);

    SELECT
      t.TCKCOD
    FROM dbo.TICKETS AS t
    WHERE t.TCKID = @TCKID;
    `,
    inputs: {
      TITLE: { type: sql.NVarChar(255), value: TITLE },
      DESCR: { type: sql.NVarChar(2000), value: DESCR ?? null },
      SRVID: { type: sql.Int, value: SRVID },
      STSID: { type: sql.Int, value: STSID ?? null },
      CATID: { type: sql.Int, value: CATID ?? null },
      SC1ID: { type: sql.Int, value: SC1ID ?? null },
      SC2ID: { type: sql.Int, value: SC2ID ?? null },
      SC3ID: { type: sql.Int, value: SC3ID ?? null },
      PRIID: { type: sql.Int, value: PRIID ?? null },
      ASGUSR: { type: sql.Int, value: ASGUSR ?? null },
      CREUSR: { type: sql.Int, value: CREUSR },
      DATDEB: { type: sql.DateTime2, value: DATDEB ?? null },
      DATFIN: { type: sql.DateTime2, value: DATFIN ?? null },
      DATDEBREEL: { type: sql.DateTime2, value: DATDEBREEL ?? null },
      DATFINREEL: { type: sql.DateTime2, value: DATFINREEL ?? null },
      TPSPREV: { type: sql.Int, value: TPSPREV ?? null },
      TPSREEL: { type: sql.Int, value: TPSREEL ?? null },
    },
  });

  return result.recordset[0]?.TCKCOD;
}

/* ───────────────────────────────────────────────────────────────
   PUT — Modifier un ticket
   - Met à jour les champs modifiables de TICKETS.
   - Si STSID est fourni et différent du statut actuel,
     insère une ligne dans TICKETTRACKING.
─────────────────────────────────────────────────────────────── */
export async function updateTicket({
  TCKID,
  TITLE,
  DESCR,
  CATID,
  SC1ID,
  SC2ID,
  SC3ID,
  PRIID,
  SRVID,
  ASGUSR,
  STSID,
  USRID,
  CMNT,
  DATDEB,
  DATFIN,
  DATDEBREEL,
  DATFINREEL,
  TPSPREV,
  TPSREEL,
}) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    -- Statut actuel = dernier tracking
    DECLARE @PREV_STSID INT = (
      SELECT STSID FROM dbo.V_TCK_LASTTRK WHERE TCKID = @TCKID
    );

    UPDATE dbo.TICKETS
    SET
      TITLE  = @TITLE,
      DESCR  = @DESCR,
      CATID  = @CATID,
      SC1ID  = @SC1ID,
      SC2ID  = @SC2ID,
      SC3ID  = @SC3ID,
      PRIID  = @PRIID,
      SRVID  = @SRVID,
      ASGUSR = @ASGUSR,
      STSID  = @STSID,
      CREUSR  = @USRID,
      DATDEB = @DATDEB,
      DATFIN = @DATFIN,
      DATDEBREEL = @DATDEBREEL,
      DATFINREEL = @DATFINREEL,
      TPSPREV = @TPSPREV,
      TPSREEL = @TPSREEL,
      UPDDAT = SYSUTCDATETIME()
    WHERE TCKID = @TCKID;

    -- Tracking uniquement si le statut a réellement changé
    IF @PREV_STSID <> @STSID OR @PREV_STSID IS NULL
    BEGIN
      INSERT INTO dbo.TICKETTRACKING (TCKID, STSID, USRID, CMNT)
      VALUES (@TCKID, @STSID, @USRID, @CMNT);
    END;

    SELECT @@ROWCOUNT AS AFFECTED;
    `,
    inputs: {
      TCKID: { type: sql.Int, value: TCKID },
      TITLE: { type: sql.NVarChar(255), value: TITLE },
      DESCR: { type: sql.NVarChar(2000), value: DESCR },
      CATID: { type: sql.Int, value: CATID ?? null },
      SC1ID: { type: sql.Int, value: SC1ID ?? null },
      SC2ID: { type: sql.Int, value: SC2ID ?? null },
      SC3ID: { type: sql.Int, value: SC3ID ?? null },
      PRIID: { type: sql.Int, value: PRIID ?? null },
      SRVID: { type: sql.Int, value: SRVID ?? null },
      ASGUSR: { type: sql.Int, value: ASGUSR ?? null },
      STSID: { type: sql.Int, value: STSID },
      USRID: { type: sql.Int, value: USRID },
      CMNT: { type: sql.NVarChar(4000), value: CMNT ?? null },
      DATDEB: { type: sql.DateTime2, value: DATDEB ?? null },
      DATFIN: { type: sql.DateTime2, value: DATFIN ?? null },
      DATDEBREEL: { type: sql.DateTime2, value: DATDEBREEL ?? null },
      DATFINREEL: { type: sql.DateTime2, value: DATFINREEL ?? null },
      TPSPREV: { type: sql.Int, value: TPSPREV ?? null },
      TPSREEL: { type: sql.Int, value: TPSREEL ?? null },
    },
  });

  return { AFFECTED: result.recordset[0]?.AFFECTED ?? 0 };
}

export async function deleteTicket(TCKID, DLTD, PERM) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: !PERM
      ? `
    UPDATE dbo.TICKETS
    SET
      DLTD = @DLTD,
      UPDDAT = SYSUTCDATETIME()
    WHERE TCKID = @TCKID;
    `
      : `
    BEGIN TRANSACTION;

    BEGIN TRY
        DELETE FROM [dbo].[TICKETNOTES] WHERE [TCKID] = @TCKID;
        DELETE FROM [dbo].[TICKETTRACKING] WHERE [TCKID] = @TCKID;
        DELETE FROM [dbo].[TICKETCC] WHERE [TCKID] = @TCKID;
        DELETE FROM [dbo].[TICKETPROJECTS] WHERE [TCKID] = @TCKID;
        DELETE FROM [dbo].[TICKETS] WHERE [TCKID] = @TCKID;
        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        ROLLBACK TRANSACTION;
        THROW;
    END CATCH
    `,
    inputs: {
      TCKID: { type: sql.Int, value: TCKID },
      DLTD: { type: sql.Bit, value: DLTD },
    },
  });

  return { AFFECTED: !PERM ? (result.rowsAffected?.[0] ?? 0) : 0 };
}

export async function closeTicket({ TCKID }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE dbo.TICKETS
    SET
      CLSDAT = SYSUTCDATETIME(),
      UPDDAT = SYSUTCDATETIME()
    WHERE TCKID = @TCKID;
    `,
    inputs: { TCKID: { type: sql.Int, value: TCKID } },
  });

  return { AFFECTED: result.rowsAffected?.[0] ?? 0 };
}

/* ─────────────────────────────────────────────
   VUES — Dernière consultation d'un ticket (puce "non vu", cf. flag UNSEEN
   dans SELECT_TICKETS et sql/TICKETVIEWS.table.sql)
───────────────────────────────────────────── */

/**
 * Marque un ticket comme consulté par l'utilisateur courant "maintenant".
 * ADDSEC permet d'ajouter X secondes à la date de consultation.
 * MERGE = "insère si absent, sinon met à jour".
 */
export async function markTicketSeen(USRID, TCKID, ADDSEC = 0) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
      MERGE dbo.TICKETVIEWS AS target
      USING (SELECT @TCKID AS TCKID, @USRID AS USRID) AS src
        ON target.TCKID = src.TCKID AND target.USRID = src.USRID

      WHEN MATCHED THEN
        UPDATE SET LASTSEENDAT = DATEADD(SECOND, @ADDSEC, SYSDATETIME())

      WHEN NOT MATCHED THEN
        INSERT (TCKID, USRID, LASTSEENDAT)
        VALUES (
          src.TCKID,
          src.USRID,
          DATEADD(SECOND, @ADDSEC, SYSDATETIME())
        );
    `,
    inputs: {
      TCKID: {
        type: sql.Int,
        value: TCKID,
      },
      USRID: {
        type: sql.Int,
        value: USRID,
      },
      ADDSEC: {
        type: sql.Int,
        value: ADDSEC,
      },
    },
  });
}

/**
 * Journalise les groupes de champs "cœur" du ticket qui viennent de changer
 * (cf. sql/TICKETFIELDCHANGES.table.sql — TITLE/DESCR/CLASSIFICATION/
 * PLANNING/SERVICE/ASSIGNEE ne sont pas suivis individuellement ailleurs,
 * contrairement au statut/notes/tâches qui ont déjà leur propre table
 * horodatée). Appelé depuis controllers.updateTicket, qui calcule déjà la
 * liste des groupes modifiés à partir de `baseTicket` (état avant
 * modification, déjà chargé pour la notification mail) — pas de SELECT
 * supplémentaire nécessaire ici.
 * `fieldGroups` vide → no-op (aucune requête émise).
 */
export async function logTicketFieldChanges(TCKID, USRID, fieldGroups) {
  const groups = [...new Set(fieldGroups ?? [])];
  if (!groups.length) return;

  const values = groups
    .map((_, idx) => `(@TCKID, @GRP${idx}, @USRID)`)
    .join(", ");

  const inputs = {
    TCKID: { type: sql.Int, value: TCKID },
    USRID: { type: sql.Int, value: USRID },
  };
  groups.forEach((grp, idx) => {
    inputs[`GRP${idx}`] = { type: sql.NVarChar(20), value: grp };
  });

  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    INSERT INTO dbo.TICKETFIELDCHANGES (TCKID, FIELDGRP, USRID)
    VALUES ${values};
    `,
    inputs,
  });
}

/* ─────────────────────────────────────────────
   CATEGORIES — Services
───────────────────────────────────────────── */

export async function getCategories() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT * FROM V_CAT_TREE ORDER BY CATNAM, SC1NAM, SC2NAM, SC3NAM;`,
  });
  return result.recordset;
}

export async function getCategoriesByUserServices(USRID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT * FROM dbo.fnCategoriesByUsrServices(@USRID) ORDER BY CATNAM, SC1NAM, SC2NAM, SC3NAM;`,
    inputs: { USRID: { type: sql.Int, value: USRID } },
  });
  return result.recordset;
}

export async function createCategory({ NAME, DESCR, USRID }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    INSERT INTO CATEGORIES (NAME, DESCR, USRID)
    VALUES (@NAME, @DESCR, @USRID);
    SELECT SCOPE_IDENTITY() AS CATID;
    `,
    inputs: {
      NAME: { type: sql.VarChar(100), value: NAME },
      DESCR: { type: sql.VarChar(1000), value: DESCR },
      USRID: { type: sql.Int, value: USRID },
    },
  });
  return { CATID: result.recordset[0]?.CATID };
}

export async function updateCategory({ CATID, NAME, DESCR, ACTIVE }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE CATEGORIES
    SET NAME = @NAME, DESCR = @DESCR, ACTIVE = @ACTIVE
    WHERE CATID = @CATID;
    SELECT @@ROWCOUNT AS AFFECTED;
    `,
    inputs: {
      CATID: { type: sql.Int, value: CATID },
      NAME: { type: sql.VarChar(100), value: NAME },
      DESCR: { type: sql.VarChar(1000), value: DESCR },
      ACTIVE: { type: sql.Bit, value: ACTIVE },
    },
  });
  return { AFFECTED: result.recordset[0]?.AFFECTED ?? 0 };
}

/* ── SC1 ─────────────────────────────────────────────────── */
export async function getSC1(CATID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT * FROM SUBCATEGORIES1 WHERE CATID = @CATID AND ACTIVE = 1 ORDER BY NAME;`,
    inputs: { CATID: { type: sql.Int, value: CATID } },
  });
  return result.recordset;
}

export async function createSC1({ CATID, NAME, DESCR }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    INSERT INTO SUBCATEGORIES1 (NAME, CATID, DESCR)
    VALUES (@NAME, @CATID, @DESCR);
    SELECT SCOPE_IDENTITY() AS SC1ID;
    `,
    inputs: {
      NAME: { type: sql.VarChar(100), value: NAME },
      CATID: { type: sql.Int, value: CATID },
      DESCR: { type: sql.VarChar(1000), value: DESCR },
    },
  });
  return { SC1ID: result.recordset[0]?.SC1ID };
}

export async function updateSC1({ SC1ID, NAME, DESCR, ACTIVE }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE SUBCATEGORIES1
    SET NAME = @NAME, DESCR = @DESCR, ACTIVE = @ACTIVE
    WHERE SC1ID = @SC1ID;
    SELECT @@ROWCOUNT AS AFFECTED;
    `,
    inputs: {
      SC1ID: { type: sql.Int, value: SC1ID },
      NAME: { type: sql.VarChar(100), value: NAME },
      DESCR: { type: sql.VarChar(1000), value: DESCR },
      ACTIVE: { type: sql.Bit, value: ACTIVE },
    },
  });
  return { AFFECTED: result.recordset[0]?.AFFECTED ?? 0 };
}

/* ── SC2 ─────────────────────────────────────────────────── */
export async function getSC2(SC1ID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT * FROM SUBCATEGORIES2 WHERE SC1ID = @SC1ID AND ACTIVE = 1 ORDER BY NAME;`,
    inputs: { SC1ID: { type: sql.Int, value: SC1ID } },
  });
  return result.recordset;
}

export async function createSC2({ SC1ID, NAME, DESCR }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    INSERT INTO SUBCATEGORIES2 (NAME, SC1ID, DESCR)
    VALUES (@NAME, @SC1ID, @DESCR);
    SELECT SCOPE_IDENTITY() AS SC2ID;
    `,
    inputs: {
      NAME: { type: sql.VarChar(100), value: NAME },
      SC1ID: { type: sql.Int, value: SC1ID },
      DESCR: { type: sql.VarChar(1000), value: DESCR },
    },
  });
  return { SC2ID: result.recordset[0]?.SC2ID };
}

export async function updateSC2({ SC2ID, NAME, DESCR, ACTIVE }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE SUBCATEGORIES2
    SET NAME = @NAME, DESCR = @DESCR, ACTIVE = @ACTIVE
    WHERE SC2ID = @SC2ID;
    SELECT @@ROWCOUNT AS AFFECTED;
    `,
    inputs: {
      SC2ID: { type: sql.Int, value: SC2ID },
      NAME: { type: sql.VarChar(100), value: NAME },
      DESCR: { type: sql.VarChar(1000), value: DESCR },
      ACTIVE: { type: sql.Bit, value: ACTIVE },
    },
  });
  return { AFFECTED: result.recordset[0]?.AFFECTED ?? 0 };
}

/* ── SC3 ─────────────────────────────────────────────────── */
export async function getSC3(SC2ID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT * FROM SUBCATEGORIES3 WHERE SC2ID = @SC2ID AND ACTIVE = 1 ORDER BY NAME;`,
    inputs: { SC2ID: { type: sql.Int, value: SC2ID } },
  });
  return result.recordset;
}

export async function createSC3({ SC2ID, NAME, DESCR }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    INSERT INTO SUBCATEGORIES3 (NAME, SC2ID, DESCR)
    VALUES (@NAME, @SC2ID, @DESCR);
    SELECT SCOPE_IDENTITY() AS SC3ID;
    `,
    inputs: {
      NAME: { type: sql.VarChar(100), value: NAME },
      SC2ID: { type: sql.Int, value: SC2ID },
      DESCR: { type: sql.VarChar(1000), value: DESCR },
    },
  });
  return { SC3ID: result.recordset[0]?.SC3ID };
}

export async function updateSC3({ SC3ID, NAME, DESCR, ACTIVE }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE SUBCATEGORIES3
    SET NAME = @NAME, DESCR = @DESCR, ACTIVE = @ACTIVE
    WHERE SC3ID = @SC3ID;
    SELECT @@ROWCOUNT AS AFFECTED;
    `,
    inputs: {
      SC3ID: { type: sql.Int, value: SC3ID },
      NAME: { type: sql.VarChar(100), value: NAME },
      DESCR: { type: sql.VarChar(1000), value: DESCR },
      ACTIVE: { type: sql.Bit, value: ACTIVE },
    },
  });
  return { AFFECTED: result.recordset[0]?.AFFECTED ?? 0 };
}

/* ─────────────────────────────────────────────
   SERVICES & ASSIGNMENTS — Services
───────────────────────────────────────────── */

export async function getServices() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SELECT
          s.SRVID,
          s.NAME,
          s.DESCR,
          s.ACTIVE,
          sa.ASGID,
          sa.USRID,
          sa.ACTIVE AS USRACTIVE,
          RTRIM(u.LSTNAM) + ' ' + RTRIM(u.FSTNAM) AS USRNAM
      FROM SERVICES AS s
      LEFT JOIN SERVICEASSIGNMENTS      AS sa ON sa.SRVID = s.SRVID AND sa.ACTIVE = 1
      LEFT JOIN USERSMANAGER.dbo.USERS  AS u  ON u.USRID  = sa.USRID
      WHERE s.ACTIVE = 1 AND sa.ASGID IS NOT NULL
      ORDER BY s.NAME, USRNAM;
    `,
  });
  return result.recordset;
}

/**
 * Variante "administration" de `getServices` : renvoie TOUS les services
 * (actifs et inactifs), sans jointure sur les membres — la gestion des
 * services (settings, ADMIN/SUPERADMIN/DEV, cf. requirePermission) doit
 * pouvoir retrouver et réactiver un service désactivé, ce que `getServices`
 * ne permet pas (filtré sur ACTIVE = 1, pour le formulaire de ticket).
 */
export async function getAllServices() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT
      s.SRVID,
      s.NAME,
      s.DESCR,
      s.ACTIVE,
      (SELECT COUNT(*) FROM SERVICEASSIGNMENTS sa WHERE sa.SRVID = s.SRVID) AS MEMBERCOUNT
    FROM SERVICES AS s
    ORDER BY s.NAME;
    `,
  });
  return result.recordset;
}

export async function getManager(USRID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT SRVID FROM SERVICEASSIGNMENTS WHERE USRID = @USRID`,
    inputs: { USRID: { type: sql.Int, value: USRID } },
  });
  return result.recordset[0]?.SRVID;
}

export async function createService({ NAME, DESCR }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    INSERT INTO SERVICES (NAME, DESCR)
    VALUES (@NAME, @DESCR);
    SELECT SCOPE_IDENTITY() AS SRVID;
    `,
    inputs: {
      NAME: { type: sql.NVarChar(255), value: NAME },
      DESCR: { type: sql.NVarChar(500), value: DESCR },
    },
  });
  return { SRVID: result.recordset[0]?.SRVID };
}

export async function updateService({ SRVID, NAME, DESCR, ACTIVE }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE SERVICES
    SET NAME = @NAME, DESCR = @DESCR, ACTIVE = @ACTIVE
    WHERE SRVID = @SRVID;
    SELECT @@ROWCOUNT AS AFFECTED;
    `,
    inputs: {
      SRVID: { type: sql.Int, value: SRVID },
      NAME: { type: sql.NVarChar(255), value: NAME },
      DESCR: { type: sql.NVarChar(500), value: DESCR },
      ACTIVE: { type: sql.Bit, value: ACTIVE },
    },
  });
  return { AFFECTED: result.recordset[0]?.AFFECTED ?? 0 };
}

export async function getServiceMembers(SRVID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT
      sa.ASGID,
      sa.USRID,
      sa.ACTIVE,
      RTRIM(u.LSTNAM) + ' ' + RTRIM(u.FSTNAM) AS USRNAM
    FROM SERVICEASSIGNMENTS AS sa
    LEFT JOIN USERSMANAGER.dbo.USERS AS u ON u.USRID = sa.USRID
    WHERE sa.SRVID = @SRVID
    ORDER BY USRNAM;
    `,
    inputs: { SRVID: { type: sql.Int, value: SRVID } },
  });
  return result.recordset;
}

/**
 * Emails des membres actifs d'un service (destinataires des notifications
 * ticketing "création de ticket" et "note du demandeur" — cf.
 * ticketing/controllers.js). Ne retourne que les utilisateurs actifs avec un
 * email renseigné : un membre inactif ou sans adresse ne doit ni faire
 * échouer la notification, ni recevoir de mail.
 */
export async function getServiceMemberEmails(SRVID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT DISTINCT
      u.USRID,
      u.EMAIL,
      RTRIM(u.LSTNAM) + ' ' + RTRIM(u.FSTNAM) AS USRNAM
    FROM SERVICEASSIGNMENTS AS sa
    INNER JOIN USERSMANAGER.dbo.USERS AS u ON u.USRID = sa.USRID
    WHERE sa.SRVID = @SRVID
      AND u.ACTIVE = 1
      AND u.EMAIL IS NOT NULL
      AND LTRIM(RTRIM(u.EMAIL)) <> '';
    `,
    inputs: { SRVID: { type: sql.Int, value: SRVID } },
  });
  return result.recordset;
}

/**
 * Variante multi-services de `getServiceMemberEmails` (mêmes filtres :
 * actif + email renseigné) — utilisée pour notifier TOUS les services
 * co-attribués à un ticket (principal + TICKETSERVICES) à sa création,
 * plutôt que le seul service principal (cf. controllers.notifyTicketCreated,
 * même motif que getProjectMemberEmails pour les projets).
 */
export async function getServiceMemberEmailsMulti(SRVIDS) {
  const jsonSrvids = JSON.stringify([
    ...new Set((SRVIDS ?? []).filter((id) => Number.isInteger(id))),
  ]);

  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT DISTINCT
      u.USRID,
      u.EMAIL,
      RTRIM(u.LSTNAM) + ' ' + RTRIM(u.FSTNAM) AS USRNAM
    FROM SERVICEASSIGNMENTS AS sa
    INNER JOIN USERSMANAGER.dbo.USERS AS u ON u.USRID = sa.USRID
    WHERE sa.SRVID IN (SELECT TRY_CAST([value] AS INT) FROM OPENJSON(@SRVIDS))
      AND u.ACTIVE = 1
      AND u.EMAIL IS NOT NULL
      AND LTRIM(RTRIM(u.EMAIL)) <> '';
    `,
    inputs: { SRVIDS: { type: sql.NVarChar(sql.MAX), value: jsonSrvids } },
  });
  return result.recordset;
}

/* ─────────────────────────────────────────────
   TICKETS — Services co-attribués (TICKETSERVICES)
   Un ticket garde un service PRINCIPAL sur TICKETS.SRVID (inchangé) ; cette
   table ajoute des services SUPPLÉMENTAIRES ayant les mêmes droits d'accès
   et d'action (cf. sql/TICKETSERVICES.table.sql, et la CTE MyServices
   étendue dans SELECT_TICKETS/SELECT_ALL_TICKET_LINKS/SELECT_TODOS). Même
   motif "delsert" que setTicketCc/setTicketProjects : le formulaire envoie
   systématiquement la liste complète des services supplémentaires
   souhaités, purge + réinsertion en une seule transaction.
───────────────────────────────────────────── */

/**
 * Services supplémentaires (hors principal) rattachés à un ticket.
 */
export async function getTicketServices(TCKID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT tsv.TSVID, tsv.SRVID, s.NAME
    FROM dbo.TICKETSERVICES AS tsv
    INNER JOIN dbo.SERVICES AS s ON s.SRVID = tsv.SRVID
    WHERE tsv.TCKID = @TCKID
    ORDER BY s.NAME;
    `,
    inputs: { TCKID: { type: sql.Int, value: TCKID } },
  });
  return result.recordset;
}

/**
 * Remplace intégralement les services supplémentaires rattachés à un
 * ticket ("delsert", même motif que setTicketProjects/setTicketCc).
 * `SRVIDS` peut inclure le service principal courant sans conséquence
 * (une ligne redondante ici n'a aucun effet : l'accès du service
 * principal vient déjà de TICKETS.SRVID) — pas besoin de le filtrer.
 */
export async function setTicketServices({ TCKID, SRVIDS, CREUSR }) {
  const jsonSrvids = JSON.stringify([
    ...new Set((SRVIDS ?? []).filter((id) => Number.isInteger(id))),
  ]);

  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    BEGIN TRAN;

    BEGIN TRY
      DELETE FROM dbo.TICKETSERVICES
      WHERE TCKID = @TCKID;

      IF @SRVIDS IS NOT NULL AND ISJSON(@SRVIDS) = 1
      BEGIN
        INSERT INTO dbo.TICKETSERVICES (TCKID, SRVID, CREUSR)
        SELECT @TCKID, TRY_CAST([value] AS INT), @CREUSR
        FROM OPENJSON(@SRVIDS)
        WHERE TRY_CAST([value] AS INT) IS NOT NULL;
      END;

      COMMIT TRAN;
    END TRY
    BEGIN CATCH
      IF @@TRANCOUNT > 0
        ROLLBACK TRAN;

      THROW;
    END CATCH;
    `,
    inputs: {
      TCKID: { type: sql.Int, value: TCKID },
      SRVIDS: { type: sql.NVarChar(sql.MAX), value: jsonSrvids },
      CREUSR: { type: sql.Int, value: CREUSR ?? null },
    },
  });

  return getTicketServices(TCKID);
}

/* ─────────────────────────────────────────────
   TICKETS — Destinataires en copie (CC)
   Le formulaire (CustomSelectMultiple) envoie systématiquement la liste
   complète des destinataires en copie souhaitée pour le ticket : un
   "delsert" (purge + réinsertion) est donc plus simple et plus sûr qu'un
   ajout/retrait unitaire — même pattern que delsertUserGroups/
   delsertUserPermissions (modules/usersmanager/services.js).
───────────────────────────────────────────── */

/**
 * Liste des destinataires en copie d'un ticket (USRID/USRNAM/EMAIL).
 */
export async function getTicketCc(TCKID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT
      cc.TCCID,
      cc.USRID,
      RTRIM(u.LSTNAM) + ' ' + RTRIM(u.FSTNAM) AS USRNAM,
      u.EMAIL
    FROM dbo.TICKETCC AS cc
    INNER JOIN USERSMANAGER.dbo.USERS AS u ON u.USRID = cc.USRID
    WHERE cc.TCKID = @TCKID
    ORDER BY USRNAM;
    `,
    inputs: { TCKID: { type: sql.Int, value: TCKID } },
  });
  return result.recordset;
}

/**
 * Emails des destinataires en copie d'un ticket (actifs, avec email
 * renseigné) — utilisé par les notifications mail (cf. ticketing/
 * controllers.js), même filtre que getServiceMemberEmails.
 */
export async function getTicketCcEmails(TCKID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT DISTINCT u.USRID, u.EMAIL
    FROM dbo.TICKETCC AS cc
    INNER JOIN USERSMANAGER.dbo.USERS AS u ON u.USRID = cc.USRID
    WHERE cc.TCKID = @TCKID
      AND u.ACTIVE = 1
      AND u.EMAIL IS NOT NULL
      AND LTRIM(RTRIM(u.EMAIL)) <> '';
    `,
    inputs: { TCKID: { type: sql.Int, value: TCKID } },
  });
  return result.recordset;
}

/**
 * Remplace la liste complète des destinataires en copie d'un ticket par
 * USRIDS (purge puis réinsertion dans une transaction). USRIDS = [] retire
 * tout le monde. USRIDS est sérialisé en JSON côté appelant (cf.
 * delsertUserGroups pour le même motif).
 */
export async function setTicketCc({ TCKID, USRIDS, CREUSR }) {
  const requestedUsrids = [
    ...new Set((USRIDS ?? []).filter((id) => Number.isInteger(id))),
  ];
  const jsonUsrids = JSON.stringify(requestedUsrids);

  // Utilisateurs nouvellement ajoutés en copie (comparé à la liste CC
  // actuelle, lue AVANT le delsert ci-dessous) : seuls ceux-ci déclenchent
  // l'auto-association de service (cf. autoAssignServicesFromNewCc) — un
  // simple ré-enregistrement de la même liste CC ne doit pas ré-ajouter un
  // service associé qu'un membre du service principal aurait retiré
  // volontairement entre-temps (cf. setTicketServices, autorisation
  // réservée à MYSRV/créateur).
  const existingUsrids = new Set(
    (await getTicketCc(TCKID)).map((row) => row.USRID),
  );
  const newlyAddedUsrids = requestedUsrids.filter(
    (id) => !existingUsrids.has(id),
  );

  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    BEGIN TRAN;

    BEGIN TRY
      DELETE FROM dbo.TICKETCC
      WHERE TCKID = @TCKID;

      IF @USRIDS IS NOT NULL AND ISJSON(@USRIDS) = 1
      BEGIN
        INSERT INTO dbo.TICKETCC (TCKID, USRID, CREUSR)
        SELECT @TCKID, TRY_CAST([value] AS INT), @CREUSR
        FROM OPENJSON(@USRIDS)
        WHERE TRY_CAST([value] AS INT) IS NOT NULL;
      END;

      COMMIT TRAN;
    END TRY
    BEGIN CATCH
      IF @@TRANCOUNT > 0
        ROLLBACK TRAN;

      THROW;
    END CATCH;
    `,
    inputs: {
      TCKID: { type: sql.Int, value: TCKID },
      USRIDS: { type: sql.NVarChar(sql.MAX), value: jsonUsrids },
      CREUSR: { type: sql.Int, value: CREUSR ?? null },
    },
  });

  // Auto-association des services des nouveaux CC (cf. fonction ci-dessous)
  // — après le delsert : TICKETCC doit déjà refléter la nouvelle liste
  // avant qu'on aille chercher les services de ces utilisateurs.
  if (newlyAddedUsrids.length) {
    await autoAssignServicesFromNewCc({
      TCKID,
      USRIDS: newlyAddedUsrids,
      CREUSR,
    });
  }

  return getTicketCc(TCKID);
}

/**
 * Auto-association des services "gérant les tickets" aux destinataires
 * venant d'être ajoutés en copie (cf. setTicketCc, newlyAddedUsrids) :
 * un utilisateur ajouté en copie qui est membre actif d'un service
 * (SERVICEASSIGNMENTS) voit ce service ajouté aux services associés du
 * ticket (TICKETSERVICES) — sauf s'il s'agit déjà du service PRINCIPAL du
 * ticket (TICKETS.SRVID), qui a déjà les mêmes droits d'accès sans avoir
 * besoin d'y figurer (cf. sql/TICKETSERVICES.table.sql). Un utilisateur
 * peut être membre de plusieurs services : chacun de ses services (hors
 * principal) est candidat à l'ajout.
 *
 * Fusionne avec les services déjà associés (union) plutôt que de faire un
 * delsert complet : l'ajout d'un CC ne doit jamais faire disparaître un
 * service associé existant, et un service associé retiré manuellement
 * entre-temps ne doit pas être réintroduit tant qu'aucun nouveau CC ne le
 * justifie (cf. commentaire de setTicketCc).
 */
async function autoAssignServicesFromNewCc({ TCKID, USRIDS, CREUSR }) {
  const jsonUsrids = JSON.stringify([...new Set(USRIDS)]);

  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT t.SRVID AS PRIMARYSRVID, sa.SRVID AS CCUSERSRVID
    FROM dbo.TICKETS AS t
    LEFT JOIN dbo.SERVICEASSIGNMENTS AS sa
      ON sa.USRID IN (SELECT TRY_CAST([value] AS INT) FROM OPENJSON(@USRIDS))
     AND sa.ACTIVE = 1
    WHERE t.TCKID = @TCKID;
    `,
    inputs: {
      TCKID: { type: sql.Int, value: TCKID },
      USRIDS: { type: sql.NVarChar(sql.MAX), value: jsonUsrids },
    },
  });

  const rows = result.recordset;
  if (!rows.length) return;

  const primarySrvid = rows[0].PRIMARYSRVID;
  const candidateSrvids = rows
    .map((row) => row.CCUSERSRVID)
    .filter((srvid) => srvid != null && srvid !== primarySrvid);

  if (!candidateSrvids.length) return;

  const currentSrvids = (await getTicketServices(TCKID)).map((s) => s.SRVID);
  const mergedSrvids = new Set([...currentSrvids, ...candidateSrvids]);

  // Rien de nouveau : on évite un delsert inutile sur TICKETSERVICES (qui
  // recréerait toutes les lignes, y compris celles déjà en place, avec un
  // nouveau TSVID/CREDAT/CREUSR — cf. commentaire de setTicketServices).
  if (mergedSrvids.size === currentSrvids.length) return;

  await setTicketServices({
    TCKID,
    SRVIDS: [...mergedSrvids],
    CREUSR,
  });
}

export async function addServiceMember({ SRVID, USRID, ACTIVE = true }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    IF EXISTS (SELECT 1 FROM SERVICEASSIGNMENTS WHERE SRVID = @SRVID AND USRID = @USRID)
      THROW 50002, 'Cet utilisateur est déjà membre de ce service.', 1;

    INSERT INTO SERVICEASSIGNMENTS (SRVID, USRID, ACTIVE)
    VALUES (@SRVID, @USRID, @ACTIVE);
    SELECT SCOPE_IDENTITY() AS ASGID;
    `,
    inputs: {
      SRVID: { type: sql.Int, value: SRVID },
      USRID: { type: sql.Int, value: USRID },
      ACTIVE: { type: sql.Bit, value: ACTIVE },
    },
  });
  return { ASGID: result.recordset[0]?.ASGID };
}

/**
 * Bascule le statut ACTIVE d'un membre déjà assigné à un service (sans le
 * retirer) — distinct de `removeServiceMember`, qui supprime la ligne
 * SERVICEASSIGNMENTS. Un membre inactif reste visible dans la gestion du
 * service mais n'est plus compté parmi les destinataires actifs (cf.
 * `getServices`, filtré sur `sa.ACTIVE = 1`, et `getServiceMemberEmails`).
 */
export async function updateServiceMember({ SRVID, USRID, ACTIVE }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE SERVICEASSIGNMENTS
    SET ACTIVE = @ACTIVE
    WHERE SRVID = @SRVID AND USRID = @USRID;
    SELECT @@ROWCOUNT AS AFFECTED;
    `,
    inputs: {
      SRVID: { type: sql.Int, value: SRVID },
      USRID: { type: sql.Int, value: USRID },
      ACTIVE: { type: sql.Bit, value: ACTIVE },
    },
  });
  return { AFFECTED: result.recordset[0]?.AFFECTED ?? 0 };
}

export async function removeServiceMember({ SRVID, USRID }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    DELETE FROM SERVICEASSIGNMENTS
    WHERE SRVID = @SRVID AND USRID = @USRID;
    SELECT @@ROWCOUNT AS AFFECTED;
    `,
    inputs: {
      SRVID: { type: sql.Int, value: SRVID },
      USRID: { type: sql.Int, value: USRID },
    },
  });
  return { AFFECTED: result.recordset[0]?.AFFECTED ?? 0 };
}

export async function getStatuses() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT STSID, NAME, CODE, LVLVAL, DESCR, ACTIVE FROM STATUSES WHERE ACTIVE = 1 ORDER BY NAME;`,
  });
  return result.recordset;
}

export async function getPriorities() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT PRIID, NAME, CODE, LVLVAL, ACTIVE FROM PRIORITIES WHERE ACTIVE = 1 ORDER BY NAME;`,
  });
  return result.recordset;
}

export async function getNote({ USRID, NTEID }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `${SELECT_TICKETS} AND n.NTEID = @NTEID ORDER BY n.CREDAT ASC`,
    inputs: {
      USRID: { type: sql.Int, value: USRID },
      NTEID: { type: sql.Int, value: NTEID },
      CODE: { type: sql.NVarChar, value: null },
    },
  });
  return result.recordset;
}

export async function createNote({ USRID, TCKID, CMNT, PUBLIC }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    INSERT INTO TICKETNOTES (TCKID, CMNT, USRID, [PUBLIC])
    VALUES (@TCKID, @CMNT, @USRID, @PUBLIC)
    SELECT SCOPE_IDENTITY() AS NTEID;
    `,
    inputs: {
      USRID: { type: sql.Int, value: USRID },
      TCKID: { type: sql.Int, value: TCKID },
      CMNT: { type: sql.NVarChar(2000), value: CMNT },
      PUBLIC: { type: sql.Bit, value: PUBLIC },
    },
  });
  return { NTEID: result.recordset[0]?.NTEID };
}

export async function updateNote({ USRID, NTEID, CMNT, PUBLIC }) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE TICKETNOTES
    SET [CMNT] = @CMNT, [USRID] = @USRID, [PUBLIC] = @PUBLIC, [CREDAT] = SYSUTCDATETIME()
    WHERE [NTEID] = @NTEID
    `,
    inputs: {
      USRID: { type: sql.Int, value: USRID },
      NTEID: { type: sql.Int, value: NTEID },
      CMNT: { type: sql.NVarChar(2000), value: CMNT },
      PUBLIC: { type: sql.Bit, value: PUBLIC },
    },
  });
}

export async function deleteNote({ NTEID }) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `DELETE FROM TICKETNOTES WHERE NTEID = @NTEID`,
    inputs: { NTEID: { type: sql.Int, value: NTEID } },
  });
}

/* ═══════════════════════════════════════════════════════════════
   TODOS — Services
   Table réelle utilisée : TICKETTODOS (cf. add_tickettodos.sql).

   Contrairement aux notes (imbriquées dans le ticket via SELECT_TICKETS),
   les todos sont exposées à plat par l'API — le front (`ticketTodo.service`)
   consomme une liste de todos indépendante de la liste des tickets. On
   restreint donc la lecture à un SELECT dédié, plus léger que SELECT_TICKETS
   (pas besoin des attachments/tracking/catégories ici), mais avec la même
   règle d'accès aux tickets (MyServices) que SELECT_TICKETS, + le filtre de
   visibilité propre aux todos (publique, ou privée et m'appartenant).
═══════════════════════════════════════════════════════════════ */

const SELECT_TODOS = `
WITH MyServices AS (
  SELECT DISTINCT sa.SRVID
  FROM   dbo.SERVICEASSIGNMENTS AS sa
  WHERE  sa.USRID = @USRID
),
MyProjects AS (
  SELECT DISTINCT pu.PRJID
  FROM   dbo.PROJECTUSERS AS pu
  WHERE  pu.USRID = @USRID
  UNION
  SELECT DISTINCT p.PRJID
  FROM   dbo.PROJECTS AS p
  WHERE  p.CREUSR = @USRID
)
SELECT
  d.TDOID,
  d.TCKID,
  t.TCKCOD,
  d.LABEL,
  d.[SECTION],
  d.DONE,
  d.[PUBLIC],
  d.USRID,
  RTRIM(u.LSTNAM) + ' ' + RTRIM(u.FSTNAM) AS USRNAM,
  d.CREDAT,
  d.UPDDAT
FROM dbo.TICKETTODOS AS d
INNER JOIN dbo.TICKETS AS t ON t.TCKID = d.TCKID
LEFT JOIN USERSMANAGER.dbo.USERS AS u ON u.USRID = d.USRID
WHERE
  (
    (t.CREUSR = @USRID OR t.ASGUSR = @USRID)
    OR EXISTS (
      SELECT 1 FROM MyServices ms
      WHERE ms.SRVID = t.SRVID
         OR EXISTS (
           SELECT 1 FROM dbo.TICKETSERVICES AS tsx
           WHERE tsx.TCKID = t.TCKID AND tsx.SRVID = ms.SRVID
         )
    )
    OR EXISTS (
      SELECT 1 FROM dbo.TICKETPROJECTS AS tpjacc
      WHERE tpjacc.TCKID = t.TCKID
        AND tpjacc.PRJID IN (SELECT PRJID FROM MyProjects)
    )
    -- Même règle d'accès que SELECT_TICKETS (cf. plus haut) : un
    -- destinataire en copie (TICKETCC) voit aussi les todos du ticket.
    OR EXISTS (
      SELECT 1 FROM dbo.TICKETCC AS ccacc
      WHERE ccacc.TCKID = t.TCKID
        AND ccacc.USRID = @USRID
    )
  )
  AND (d.[PUBLIC] = 1 OR d.USRID = @USRID)
`;

/* ───────────────────────────────────────────────────────────────
   GET — Toutes les todos visibles par l'utilisateur (tous tickets)
─────────────────────────────────────────────────────────────── */
export async function getTodos(USRID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `${SELECT_TODOS} ORDER BY d.CREDAT ASC`,
    inputs: { USRID: { type: sql.Int, value: USRID } },
  });
  return result.recordset;
}

/* ───────────────────────────────────────────────────────────────
   GET — Todos visibles d'un ticket donné
─────────────────────────────────────────────────────────────── */
export async function getTodosByTicket(USRID, TCKID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `${SELECT_TODOS} AND d.TCKID = @TCKID ORDER BY d.CREDAT ASC`,
    inputs: {
      USRID: { type: sql.Int, value: USRID },
      TCKID: { type: sql.Int, value: TCKID },
    },
  });
  return result.recordset;
}

/* ───────────────────────────────────────────────────────────────
   GET — Une todo par TDOID (relecture après create/update)
─────────────────────────────────────────────────────────────── */
export async function getTodo(USRID, TDOID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `${SELECT_TODOS} AND d.TDOID = @TDOID`,
    inputs: {
      USRID: { type: sql.Int, value: USRID },
      TDOID: { type: sql.Int, value: TDOID },
    },
  });
  return result.recordset[0] ?? null;
}

/* ───────────────────────────────────────────────────────────────
   POST — Créer une todo
─────────────────────────────────────────────────────────────── */
export async function createTodo({ USRID, TCKID, LABEL, PUBLIC, SECTION }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    INSERT INTO TICKETTODOS (TCKID, LABEL, [SECTION], [PUBLIC], USRID)
    VALUES (@TCKID, @LABEL, @SECTION, @PUBLIC, @USRID)
    SELECT SCOPE_IDENTITY() AS TDOID;
    `,
    inputs: {
      TCKID: { type: sql.Int, value: TCKID },
      LABEL: { type: sql.NVarChar(500), value: LABEL },
      SECTION: { type: sql.NVarChar(50), value: SECTION || null },
      PUBLIC: { type: sql.Bit, value: PUBLIC ?? true },
      USRID: { type: sql.Int, value: USRID },
    },
  });
  return { TDOID: result.recordset[0]?.TDOID };
}

/* ───────────────────────────────────────────────────────────────
   PUT — Mettre à jour une todo (patch partiel : LABEL / DONE / PUBLIC)
   COALESCE : seuls les champs transmis (non null) sont modifiés — le
   front n'envoie parfois qu'un seul champ (ex: bascule DONE seule).
─────────────────────────────────────────────────────────────── */
export async function updateTodo({ TDOID, LABEL, DONE, PUBLIC, SECTION }) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE TICKETTODOS
    SET
      LABEL    = COALESCE(@LABEL, LABEL),
      [SECTION] = COALESCE(@SECTION, [SECTION]),
      DONE     = COALESCE(@DONE, DONE),
      [PUBLIC] = COALESCE(@PUBLIC, [PUBLIC]),
      UPDDAT   = SYSUTCDATETIME()
    WHERE TDOID = @TDOID
    `,
    inputs: {
      TDOID: { type: sql.Int, value: TDOID },
      LABEL: { type: sql.NVarChar(500), value: LABEL ?? null },
      // "" explicite (retrait de la section, cf. validators.js) doit bien
      // passer à COALESCE (qui ne considère que SQL NULL comme "absent") —
      // seul `undefined` côté JS (champ non transmis) doit être mappé à
      // null pour laisser la section existante inchangée.
      SECTION: {
        type: sql.NVarChar(50),
        value: SECTION === undefined ? null : SECTION,
      },
      DONE: { type: sql.Bit, value: DONE ?? null },
      PUBLIC: { type: sql.Bit, value: PUBLIC ?? null },
    },
  });
}

/* ───────────────────────────────────────────────────────────────
   DELETE — Supprimer une todo
─────────────────────────────────────────────────────────────── */
export async function deleteTodo({ TDOID }) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `DELETE FROM TICKETTODOS WHERE TDOID = @TDOID`,
    inputs: { TDOID: { type: sql.Int, value: TDOID } },
  });
}

/* ═══════════════════════════════════════════════════════════════
   LIAISONS — Tickets liés ("lier")
   Relation symétrique, indépendante du statut (cf. sql/TICKETLINKS.table.sql
   — TCKIDA < TCKIDB toujours normalisé côté application). Ne modifie ni le
   statut, ni la colonne Kanban d'aucun des deux tickets.
═══════════════════════════════════════════════════════════════ */

const SELECT_LINKED_TICKETS = `
SELECT
  lk.LNKID,
  CASE WHEN lk.TCKIDA = @TCKID THEN lk.TCKIDB ELSE lk.TCKIDA END AS TCKID,
  t.TCKCOD,
  t.TITLE,
  ltrk.STSID,
  sts.NAME AS STSNAM,
  sts.CODE AS STSCOD,
  sts.LVLVAL AS STSLVL,
  srv.NAME AS SRVNAM
FROM dbo.TICKETLINKS AS lk
INNER JOIN dbo.TICKETS AS t
  ON t.TCKID = CASE WHEN lk.TCKIDA = @TCKID THEN lk.TCKIDB ELSE lk.TCKIDA END
LEFT JOIN dbo.V_TCK_LASTTRK AS ltrk ON ltrk.TCKID = t.TCKID
LEFT JOIN dbo.STATUSES AS sts ON sts.STSID = ltrk.STSID
LEFT JOIN dbo.SERVICES AS srv ON srv.SRVID = t.SRVID
WHERE lk.TCKIDA = @TCKID OR lk.TCKIDB = @TCKID
ORDER BY t.TCKID;
`;

/**
 * Tickets liés à TCKID (résolus : code, titre, statut, service — assez
 * pour les afficher/ouvrir depuis la fiche ticket sans requête supplémentaire).
 */
export async function getTicketLinks(TCKID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: SELECT_LINKED_TICKETS,
    inputs: { TCKID: { type: sql.Int, value: TCKID } },
  });
  return result.recordset;
}

/**
 * Mode "bulk" de getTicketLinks : toutes les liaisons (TCKIDA/TCKIDB brut,
 * pas de résolution TCKCOD/titre/statut — inutile ici) où AU MOINS un des
 * deux tickets est accessible à USRID, mêmes règles d'accès que
 * SELECT_TICKETS/getTickets (créateur, assigné, ou service de
 * l'utilisateur). Comme pour un ticket lié consulté individuellement
 * (cf. getTicketLinks), l'autre extrémité peut appartenir à un service que
 * l'utilisateur ne voit pas dans son Kanban.
 *
 * Utilisé par le Kanban (une seule requête pour tout le board, plutôt que
 * N requêtes getTicketLinks(TCKID) par carte visible) pour construire le
 * graphe de liaisons côté front et repérer/mettre en avant les tickets liés.
 */
const SELECT_ALL_TICKET_LINKS = `
WITH MyServices AS (
  SELECT DISTINCT sa.SRVID
  FROM   dbo.SERVICEASSIGNMENTS AS sa
  WHERE  sa.USRID = @USRID
),
MyProjects AS (
  SELECT DISTINCT pu.PRJID
  FROM   dbo.PROJECTUSERS AS pu
  WHERE  pu.USRID = @USRID
  UNION
  SELECT DISTINCT p.PRJID
  FROM   dbo.PROJECTS AS p
  WHERE  p.CREUSR = @USRID
)
SELECT
  lk.LNKID,
  lk.TCKIDA,
  lk.TCKIDB
FROM dbo.TICKETLINKS AS lk
INNER JOIN dbo.TICKETS AS ta ON ta.TCKID = lk.TCKIDA
INNER JOIN dbo.TICKETS AS tb ON tb.TCKID = lk.TCKIDB
WHERE
  (
    (ta.CREUSR = @USRID OR ta.ASGUSR = @USRID)
    OR EXISTS (
      SELECT 1 FROM MyServices ms
      WHERE ms.SRVID = ta.SRVID
         OR EXISTS (
           SELECT 1 FROM dbo.TICKETSERVICES AS tsx
           WHERE tsx.TCKID = ta.TCKID AND tsx.SRVID = ms.SRVID
         )
    )
    OR EXISTS (
      SELECT 1 FROM dbo.TICKETPROJECTS AS tpjacc
      WHERE tpjacc.TCKID = ta.TCKID
        AND tpjacc.PRJID IN (SELECT PRJID FROM MyProjects)
    )
    -- Même règle d'accès que SELECT_TICKETS (cf. plus haut).
    OR EXISTS (
      SELECT 1 FROM dbo.TICKETCC AS ccacca
      WHERE ccacca.TCKID = ta.TCKID
        AND ccacca.USRID = @USRID
    )
  )
  OR
  (
    (tb.CREUSR = @USRID OR tb.ASGUSR = @USRID)
    OR EXISTS (
      SELECT 1 FROM MyServices ms
      WHERE ms.SRVID = tb.SRVID
         OR EXISTS (
           SELECT 1 FROM dbo.TICKETSERVICES AS tsx
           WHERE tsx.TCKID = tb.TCKID AND tsx.SRVID = ms.SRVID
         )
    )
    OR EXISTS (
      SELECT 1 FROM dbo.TICKETPROJECTS AS tpjacc2
      WHERE tpjacc2.TCKID = tb.TCKID
        AND tpjacc2.PRJID IN (SELECT PRJID FROM MyProjects)
    )
    OR EXISTS (
      SELECT 1 FROM dbo.TICKETCC AS ccaccb
      WHERE ccaccb.TCKID = tb.TCKID
        AND ccaccb.USRID = @USRID
    )
  )
`;

export async function getAllTicketLinks(USRID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: SELECT_ALL_TICKET_LINKS,
    inputs: { USRID: { type: sql.Int, value: USRID } },
  });
  return result.recordset;
}

/**
 * Crée la liaison entre deux tickets (paire normalisée TCKIDA < TCKIDB pour
 * qu'une seule ligne existe jamais par paire, cf. UQ_TICKETLINKS_PAIR).
 */
export async function addTicketLink({ TCKID, LINKEDTCKID, CREUSR }) {
  const A = Math.min(TCKID, LINKEDTCKID);
  const B = Math.max(TCKID, LINKEDTCKID);

  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    IF EXISTS (SELECT 1 FROM dbo.TICKETLINKS WHERE TCKIDA = @A AND TCKIDB = @B)
      THROW 50004, 'Ces tickets sont déjà liés.', 1;

    INSERT INTO dbo.TICKETLINKS (TCKIDA, TCKIDB, CREUSR)
    VALUES (@A, @B, @CREUSR);
    SELECT SCOPE_IDENTITY() AS LNKID;
    `,
    inputs: {
      A: { type: sql.Int, value: A },
      B: { type: sql.Int, value: B },
      CREUSR: { type: sql.Int, value: CREUSR },
    },
  });
  return { LNKID: result.recordset[0]?.LNKID };
}

export async function removeTicketLink(LNKID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `DELETE FROM dbo.TICKETLINKS WHERE LNKID = @LNKID;`,
    inputs: { LNKID: { type: sql.Int, value: LNKID } },
  });
  return { AFFECTED: result.rowsAffected?.[0] ?? 0 };
}

/* ═══════════════════════════════════════════════════════════════
   FUSION — Tickets fusionnés ("fusionner")
   Contrairement à la liaison, la fusion PARTAGE le statut : tous les
   tickets d'un même TICKETS.MRGID (cf. sql/TICKETS.add-MRGID.sql) sont
   alignés sur un même statut et donc dans la même colonne Kanban. Un
   changement de statut sur l'un des membres est répercuté sur les autres —
   ici (au moment de la fusion) et dans updateTicket/controllers.js (pour
   tout changement de statut ultérieur sur un membre du groupe).
═══════════════════════════════════════════════════════════════ */

/**
 * TCKID/TCKCOD des tickets d'un groupe de fusion, éventuellement en
 * excluant un ticket (le membre à l'origine du changement de statut, pour
 * ne pas se répercuter sur soi-même — cf. updateTicket).
 */
export async function getMergeGroupTicketIds(MRGID, excludeTckId = null) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT TCKID, TCKCOD
    FROM dbo.TICKETS
    WHERE MRGID = @MRGID
      ${excludeTckId ? "AND TCKID <> @EXCLUDE" : ""};
    `,
    inputs: excludeTckId
      ? {
          MRGID: { type: sql.Int, value: MRGID },
          EXCLUDE: { type: sql.Int, value: excludeTckId },
        }
      : { MRGID: { type: sql.Int, value: MRGID } },
  });
  return result.recordset;
}

/**
 * Tickets fusionnés avec TCKID (résolus : code, titre, statut, service),
 * pour la section "Tickets fusionnés" de la fiche ticket. Retourne un
 * tableau vide si le ticket n'appartient à aucun groupe.
 */
export async function getMergedTickets(MRGID, excludeTckId = null) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT
      t.TCKID,
      t.TCKCOD,
      t.TITLE,
      ltrk.STSID,
      sts.NAME AS STSNAM,
      sts.CODE AS STSCOD,
      sts.LVLVAL AS STSLVL,
      srv.NAME AS SRVNAM
    FROM dbo.TICKETS AS t
    LEFT JOIN dbo.V_TCK_LASTTRK AS ltrk ON ltrk.TCKID = t.TCKID
    LEFT JOIN dbo.STATUSES AS sts ON sts.STSID = ltrk.STSID
    LEFT JOIN dbo.SERVICES AS srv ON srv.SRVID = t.SRVID
    WHERE t.MRGID = @MRGID
      ${excludeTckId ? "AND t.TCKID <> @EXCLUDE" : ""}
    ORDER BY t.TCKID;
    `,
    inputs: excludeTckId
      ? {
          MRGID: { type: sql.Int, value: MRGID },
          EXCLUDE: { type: sql.Int, value: excludeTckId },
        }
      : { MRGID: { type: sql.Int, value: MRGID } },
  });
  return result.recordset;
}

/**
 * Table CREUSR d'un ticket (propriétaire) — utilisé pour recharger un
 * ticket via getTicket() dans un contexte système (propagation de statut de
 * fusion) où l'utilisateur agissant n'a pas forcément lui-même accès au
 * ticket concerné : le créateur, lui, y a toujours accès (cf. clause
 * `t.CREUSR = @USRID` de SELECT_TICKETS), ce qui permet de réutiliser
 * getTicket() tel quel sans dupliquer/contourner sa logique d'accès.
 */
export async function getTicketOwnerUsrid(TCKID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT CREUSR FROM dbo.TICKETS WHERE TCKID = @TCKID;`,
    inputs: { TCKID: { type: sql.Int, value: TCKID } },
  });
  return result.recordset[0]?.CREUSR ?? null;
}

/**
 * Fusionne un ensemble de tickets (ALLTCKIDS, primaire inclus) dans un même
 * groupe (TARGETMRGID) et aligne leur statut sur TARGETSTSID (résolution du
 * statut à conserver : cf. controllers.mergeTickets — choix explicite de
 * l'utilisateur ou règle de priorité par défaut). Idempotent : un ticket
 * déjà au bon statut n'ajoute pas de nouvelle ligne TICKETTRACKING.
 * Transaction unique (tout ou rien), même motif que delsertUserGroups.
 */
export async function mergeTickets({
  ALLTCKIDS,
  TARGETMRGID,
  TARGETSTSID,
  USRID,
  NOTE,
}) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    BEGIN TRAN;

    BEGIN TRY
      UPDATE dbo.TICKETS
      SET MRGID = @TARGETMRGID
      WHERE TCKID IN (SELECT TRY_CAST([value] AS INT) FROM OPENJSON(@ALLTCKIDS));

      -- Historique de statut : uniquement pour les tickets qui n'étaient pas
      -- déjà au statut cible (évite un doublon inutile dans TICKETTRACKING).
      INSERT INTO dbo.TICKETTRACKING (TCKID, STSID, USRID, CMNT)
      SELECT t.TCKID, @TARGETSTSID, @USRID, @CMNT
      FROM dbo.TICKETS AS t
      LEFT JOIN dbo.V_TCK_LASTTRK AS ltrk ON ltrk.TCKID = t.TCKID
      WHERE t.TCKID IN (SELECT TRY_CAST([value] AS INT) FROM OPENJSON(@ALLTCKIDS))
        AND (ltrk.STSID IS NULL OR ltrk.STSID <> @TARGETSTSID);

      -- Colonne TICKETS.STSID (miroir), même principe que updateTicket.
      UPDATE dbo.TICKETS
      SET STSID = @TARGETSTSID, UPDDAT = SYSUTCDATETIME()
      WHERE TCKID IN (SELECT TRY_CAST([value] AS INT) FROM OPENJSON(@ALLTCKIDS));

      -- Trace de la fusion, visible par tous les intervenants de chaque ticket.
      INSERT INTO dbo.TICKETNOTES (TCKID, CMNT, USRID, [PUBLIC])
      SELECT t.TCKID, @NOTE, @USRID, 1
      FROM dbo.TICKETS AS t
      WHERE t.TCKID IN (SELECT TRY_CAST([value] AS INT) FROM OPENJSON(@ALLTCKIDS));

      COMMIT TRAN;
    END TRY
    BEGIN CATCH
      IF @@TRANCOUNT > 0
        ROLLBACK TRAN;

      THROW;
    END CATCH;
    `,
    inputs: {
      ALLTCKIDS: {
        type: sql.NVarChar(sql.MAX),
        value: JSON.stringify(ALLTCKIDS),
      },
      TARGETMRGID: { type: sql.Int, value: TARGETMRGID },
      TARGETSTSID: { type: sql.Int, value: TARGETSTSID },
      USRID: { type: sql.Int, value: USRID },
      CMNT: {
        type: sql.NVarChar(4000),
        value: null, // commentaire de suivi de statut (vide pour la fusion)
      },
      NOTE: { type: sql.NVarChar(2000), value: NOTE },
    },
  });
}

/**
 * Applique un statut à UN ticket (mise à jour TICKETS.STSID + insertion
 * TICKETTRACKING si le statut change réellement) — extrait du bloc
 * statut de updateTicket ci-dessus, réutilisé pour propager un changement
 * de statut aux autres tickets d'un groupe de fusion.
 */
export async function applyStatusToTicket({ TCKID, STSID, USRID, CMNT }) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    DECLARE @PREV_STSID INT = (
      SELECT STSID FROM dbo.V_TCK_LASTTRK WHERE TCKID = @TCKID
    );

    UPDATE dbo.TICKETS
    SET STSID = @STSID, UPDDAT = SYSUTCDATETIME()
    WHERE TCKID = @TCKID;

    IF @PREV_STSID <> @STSID OR @PREV_STSID IS NULL
    BEGIN
      INSERT INTO dbo.TICKETTRACKING (TCKID, STSID, USRID, CMNT)
      VALUES (@TCKID, @STSID, @USRID, @CMNT);
    END;
    `,
    inputs: {
      TCKID: { type: sql.Int, value: TCKID },
      STSID: { type: sql.Int, value: STSID },
      USRID: { type: sql.Int, value: USRID },
      CMNT: { type: sql.NVarChar(4000), value: CMNT ?? null },
    },
  });
}

/**
 * Retire UN ticket de son groupe de fusion (les autres membres restent
 * groupés). Si un seul ticket reste dans le groupe après ce retrait, le
 * groupe n'a plus de sens : ce dernier ticket est lui aussi démérgé.
 */
export async function unmergeTicket(TCKID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;

    DECLARE @GRPID INT = (SELECT MRGID FROM dbo.TICKETS WHERE TCKID = @TCKID);

    IF @GRPID IS NOT NULL
    BEGIN
      UPDATE dbo.TICKETS SET MRGID = NULL WHERE TCKID = @TCKID;

      DECLARE @REMAINING INT = (SELECT COUNT(*) FROM dbo.TICKETS WHERE MRGID = @GRPID);
      IF @REMAINING = 1
        UPDATE dbo.TICKETS SET MRGID = NULL WHERE MRGID = @GRPID;
    END;

    SELECT @GRPID AS MRGID;
    `,
    inputs: { TCKID: { type: sql.Int, value: TCKID } },
  });
  return { MRGID: result.recordset[0]?.MRGID ?? null };
}

/* ─────────────────────────────────────────────
   PROJECTS — Services
   Conteneur many-to-many (TICKETPROJECTS) permettant de rattacher des
   tickets à un ou plusieurs projets. cf. sql/PROJECTS.table.sql et
   sql/TICKETPROJECTS.table.sql pour le schéma.
───────────────────────────────────────────── */

export async function getProjects() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT
      p.PRJID, p.NAME, p.DESCR, p.COLOR, p.ACTIVE,
      (
        SELECT COUNT(*) FROM dbo.TICKETPROJECTS AS tpj
        WHERE tpj.PRJID = p.PRJID
      ) AS TCKCOUNT,

      -- Pièces jointes du projet (cahier des charges, etc.) : même mécanisme
      -- générique que pour les tickets/notes (cf. SELECT_TICKETS ci-dessus et
      -- modules/files), mais avec ENTITYTYPE = 'PROJECT' explicite dans le
      -- JOIN pour ne pas risquer de collision d'ENTITYID avec un TCKCOD ou un
      -- NTEID qui vaudrait la même valeur numérique (les jointures TICKET et
      -- NOTE ci-dessus ne filtrent pas sur ENTITYTYPE, faute d'une telle
      -- ambiguïté à l'époque : TCKCOD n'est pas numérique, mais PRJID/NTEID
      -- le sont tous les deux).
      patt.ID AS PATTID,
      patt.FILECODE AS PATTFILECODE,
      patt.APPCODE AS PATTAPPCODE,
      patt.ENTITYTYPE AS PATTENTITYTYPE,
      patt.ENTITYID AS PATTENTITYID,
      patt.ORIGINALNAME AS PATTORIGINALNAME,
      patt.STOREDNAME AS PATTSTOREDNAME,
      patt.RELATIVEPATH AS PATTRELATIVEPATH,
      patt.MIMETYPE AS PATTMIMETYPE,
      patt.EXTENSION AS PATTEXTENSION,
      patt.COMPRESSED AS PATTCOMPRESSED,
      patt.ORIGINALSIZEBYTES AS PATTORIGINALSIZEBYTES,
      patt.SIZEBYTES AS PATTSIZEBYTES,
      patt.CHECKSUMSHA256 AS PATTCHECKSUMSHA256,
      patt.STATUS AS PATTSTATUS,
      patt.UPLOADEDBY AS PATTUPLOADEDBY,
      patt.CREATEDAT AS PATTCREATEDAT,
      patt.DELETEDAT AS PATTDELETEDAT
    FROM dbo.PROJECTS AS p
    LEFT JOIN APPATTACHMENTS.dbo.ATTACHMENTS AS patt
      ON patt.APPCODE = 'TCK'
     AND patt.ENTITYTYPE = 'PROJECT'
     AND patt.ENTITYID = CONVERT(varchar(50), p.PRJID)
     AND patt.DELETEDAT IS NULL
    ORDER BY p.NAME;
    `,
  });
  return result.recordset;
}

export async function createProject({ NAME, DESCR, COLOR, CREUSR }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    INSERT INTO dbo.PROJECTS (NAME, DESCR, COLOR, CREUSR)
    VALUES (@NAME, @DESCR, @COLOR, @CREUSR);
    SELECT SCOPE_IDENTITY() AS PRJID;
    `,
    inputs: {
      NAME: { type: sql.NVarChar(150), value: NAME },
      DESCR: { type: sql.NVarChar(1000), value: DESCR ?? null },
      COLOR: { type: sql.NVarChar(20), value: COLOR ?? null },
      CREUSR: { type: sql.Int, value: CREUSR ?? null },
    },
  });
  return { PRJID: result.recordset[0]?.PRJID };
}

/**
 * Créateur (PROJECTS.CREUSR) d'un projet — sert de base à la vérification
 * d'autorisation faite par controllers.updateProject/deleteProject/
 * setProjectUsers : seul le créateur d'un projet peut le modifier, le
 * supprimer ou en gérer les utilisateurs associés (cf. getUserProjects/
 * ISOWNER, même règle côté front sur ProjectsBoard.tsx) — un utilisateur
 * seulement associé (PROJECTUSERS) reste en lecture seule.
 */
export async function getProjectOwner(PRJID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT CREUSR FROM dbo.PROJECTS WHERE PRJID = @PRJID;`,
    inputs: { PRJID: { type: sql.Int, value: PRJID } },
  });
  return result.recordset[0]?.CREUSR ?? null;
}

export async function updateProject({ PRJID, NAME, DESCR, COLOR, ACTIVE }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE dbo.PROJECTS
    SET
      NAME   = @NAME,
      DESCR  = @DESCR,
      COLOR  = @COLOR,
      ACTIVE = @ACTIVE,
      UPDDAT = SYSUTCDATETIME()
    WHERE PRJID = @PRJID;
    SELECT @@ROWCOUNT AS AFFECTED;
    `,
    inputs: {
      PRJID: { type: sql.Int, value: PRJID },
      NAME: { type: sql.NVarChar(150), value: NAME },
      DESCR: { type: sql.NVarChar(1000), value: DESCR ?? null },
      COLOR: { type: sql.NVarChar(20), value: COLOR ?? null },
      ACTIVE: { type: sql.Bit, value: ACTIVE },
    },
  });
  return { AFFECTED: result.recordset[0]?.AFFECTED ?? 0 };
}

/**
 * Supprime physiquement un projet. Refuse (erreur métier 409) si des
 * tickets y sont encore rattachés (TICKETPROJECTS) — un projet doit
 * d'abord être vidé de ses tickets (ou ceux-ci réaffectés) avant de
 * pouvoir être supprimé ; sinon, la désactivation (ACTIVE=0, cf.
 * updateProject) reste le mécanisme normal, cf. PROJECTS.table.sql. La
 * règle vit en base (THROW 50001) pour rester valide même en cas d'accès
 * direct SQL, sur le même motif que declcav.deleteCave — on la traduit
 * ici en erreur HTTP.
 *
 * Les associations d'utilisateurs (PROJECTUSERS) sont purgées avant la
 * suppression du projet (FK_PROJECTUSERS_PROJECTS a déjà un ON DELETE
 * CASCADE, mais on le fait explicitement pour rester lisible sans devoir
 * se référer au schéma).
 */
export async function deleteProject(PRJID) {
  try {
    await runQuery({
      moduleUrl: import.meta.url,
      query: `
      SET NOCOUNT ON;

      BEGIN TRY
          BEGIN TRAN;

          IF EXISTS (
              SELECT 1
              FROM dbo.TICKETPROJECTS
              WHERE PRJID = @PRJID
          )
          BEGIN
              THROW 50001, 'Suppression impossible : des tickets sont rattachés à ce projet.', 1;
          END

          DELETE FROM dbo.PROJECTUSERS
          WHERE PRJID = @PRJID;

          DELETE FROM dbo.PROJECTS
          WHERE PRJID = @PRJID;

          COMMIT;
      END TRY
      BEGIN CATCH
          IF @@TRANCOUNT > 0
              ROLLBACK;

          THROW;
      END CATCH;
      `,
      inputs: { PRJID: { type: sql.Int, value: PRJID } },
    });
  } catch (err) {
    if (
      err?.number === 50001 ||
      /rattachés à ce projet/.test(err?.message ?? "")
    ) {
      const businessErr = new Error(err.message);
      businessErr.status = 409;
      throw businessErr;
    }
    throw err;
  }
}

/**
 * Projets "à moi" pour un utilisateur donné : ceux qu'il a lui-même créés
 * (PROJECTS.CREUSR) et ceux auxquels il est associé (PROJECTUSERS, sens
 * inverse de getProjectUsers — par USRID plutôt que par PRJID). Sert de
 * périmètre de visibilité pour la page "Projets"/le filtre "Projet" du
 * Calendrier (cf. ProjectsBoard.tsx/CalendarBoard.tsx) — un membre d'un
 * service ne doit voir QUE ses propres projets, jamais ceux créés par
 * d'autres membres du même service tant qu'il n'y est pas lui-même
 * rattaché ; sert aussi à déterminer côté front si l'utilisateur doit voir
 * le lien "Calendrier des tickets" (cf. Nav.tsx) alors même qu'il n'est
 * membre d'aucun service — un utilisateur seulement créateur/associé à un
 * projet n'a sinon aucun moyen de savoir qu'il a accès aux tickets de ce
 * projet.
 */
export async function getUserProjects(USRID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT DISTINCT
      p.PRJID, p.NAME, p.DESCR, p.COLOR, p.ACTIVE,
      (
        SELECT COUNT(*) FROM dbo.TICKETPROJECTS AS tpj
        WHERE tpj.PRJID = p.PRJID
      ) AS TCKCOUNT,
      -- Distingue, parmi "mes projets" (créés OU associés), ceux dont
      -- l'utilisateur courant est lui-même le créateur (PROJECTS.CREUSR) —
      -- seuls ceux-là restent modifiables/supprimables/gérables côté front
      -- (cf. ProjectsBoard.tsx) : un utilisateur seulement associé
      -- (PROJECTUSERS) ne peut que consulter le projet et voir ses
      -- tickets, jamais le modifier.
      CASE WHEN p.CREUSR = @USRID THEN 1 ELSE 0 END AS ISOWNER,
      -- Services "liés" au projet : identifiants (SRVID) de tous les
      -- services dont au moins un membre actif (SERVICEASSIGNMENTS) est
      -- soit associé au projet (PROJECTUSERS), soit son créateur
      -- (PROJECTS.CREUSR) — le créateur n'est pas forcément lui-même dans
      -- PROJECTUSERS (il a accès de toute façon), mais son service compte
      -- bien comme "propriétaire" du projet : Bruno, associé au projet de
      -- Paul, doit pouvoir le proposer aussi bien pour un ticket vers son
      -- propre service que pour un ticket vers celui de Paul. Sert au
      -- sélecteur de projet du formulaire de ticket (cf. TicketFormModal,
      -- section "Projets" de TicketInformationSection.tsx) : quand
      -- l'utilisateur choisit un service destinataire, on ne lui propose
      -- que SES projets (créés ou associés) qui concernent effectivement
      -- ce service. Chaîne CSV (ex. "3,7,12"), vide si aucun service lié.
      STUFF((
        SELECT DISTINCT ',' + CAST(sa2.SRVID AS varchar(20))
        FROM (
          SELECT pu2.USRID FROM dbo.PROJECTUSERS AS pu2 WHERE pu2.PRJID = p.PRJID
          UNION
          SELECT p.CREUSR
        ) AS pmembers(USRID)
        INNER JOIN dbo.SERVICEASSIGNMENTS AS sa2
          ON sa2.USRID = pmembers.USRID AND sa2.ACTIVE = 1
        FOR XML PATH('')
      ), 1, 1, '') AS SRVIDS
    FROM dbo.PROJECTS AS p
    LEFT JOIN dbo.PROJECTUSERS AS pu
      ON pu.PRJID = p.PRJID AND pu.USRID = @USRID
    WHERE p.CREUSR = @USRID OR pu.USRID IS NOT NULL
    ORDER BY p.NAME;
    `,
    inputs: { USRID: { type: sql.Int, value: USRID } },
  });
  return result.recordset;
}

/**
 * Utilisateurs associés à un projet (PROJECTUSERS, cf.
 * sql/PROJECTUSERS.table.sql) : donne accès au projet (Kanban "Projets",
 * Calendrier, tickets rattachés via TICKETPROJECTS) sans être
 * créateur/assigné/dans le service des tickets concernés — cf. MyProjects
 * dans SELECT_TICKETS.
 */
export async function getProjectUsers(PRJID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT
      pu.PUSID,
      pu.USRID,
      RTRIM(u.LSTNAM) + ' ' + RTRIM(u.FSTNAM) AS USRNAM,
      u.EMAIL
    FROM dbo.PROJECTUSERS AS pu
    INNER JOIN USERSMANAGER.dbo.USERS AS u ON u.USRID = pu.USRID
    WHERE pu.PRJID = @PRJID
    ORDER BY USRNAM;
    `,
    inputs: { PRJID: { type: sql.Int, value: PRJID } },
  });
  return result.recordset;
}

/**
 * Remplace intégralement les utilisateurs associés à un projet ("delsert",
 * même motif que setTicketCc/setTicketProjects) : supprime toutes les
 * lignes existantes puis réinsère la liste fournie, dans une seule
 * transaction.
 */
export async function setProjectUsers({ PRJID, USRIDS, CREUSR }) {
  const jsonUsrids = JSON.stringify([
    ...new Set((USRIDS ?? []).filter((id) => Number.isInteger(id))),
  ]);

  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    BEGIN TRAN;

    BEGIN TRY
      DELETE FROM dbo.PROJECTUSERS
      WHERE PRJID = @PRJID;

      IF @USRIDS IS NOT NULL AND ISJSON(@USRIDS) = 1
      BEGIN
        INSERT INTO dbo.PROJECTUSERS (PRJID, USRID, CREUSR)
        SELECT @PRJID, TRY_CAST([value] AS INT), @CREUSR
        FROM OPENJSON(@USRIDS)
        WHERE TRY_CAST([value] AS INT) IS NOT NULL;
      END;

      COMMIT TRAN;
    END TRY
    BEGIN CATCH
      IF @@TRANCOUNT > 0
        ROLLBACK TRAN;

      THROW;
    END CATCH;
    `,
    inputs: {
      PRJID: { type: sql.Int, value: PRJID },
      USRIDS: { type: sql.NVarChar(sql.MAX), value: jsonUsrids },
      CREUSR: { type: sql.Int, value: CREUSR ?? null },
    },
  });

  return getProjectUsers(PRJID);
}

/**
 * Projets rattachés à un ticket (utilisé pour renvoyer l'état à jour après
 * `setTicketProjects` — la liste normale vient de SELECT_TICKETS, embarquée
 * directement dans le ticket via TICKETPROJECTS/PROJECTS, cf. plus haut).
 */
export async function getTicketProjects(TCKID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT tpj.TPJID, tpj.PRJID, p.NAME, p.COLOR
    FROM dbo.TICKETPROJECTS AS tpj
    INNER JOIN dbo.PROJECTS AS p ON p.PRJID = tpj.PRJID
    WHERE tpj.TCKID = @TCKID
    ORDER BY p.NAME;
    `,
    inputs: { TCKID: { type: sql.Int, value: TCKID } },
  });
  return result.recordset;
}

/**
 * Remplace intégralement les projets rattachés à un ticket ("delsert",
 * même motif que setTicketCc) : supprime toutes les lignes existantes puis
 * réinsère la liste fournie, dans une seule transaction.
 */
export async function setTicketProjects({ TCKID, PRJIDS, CREUSR }) {
  const jsonPrjids = JSON.stringify([
    ...new Set((PRJIDS ?? []).filter((id) => Number.isInteger(id))),
  ]);

  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    BEGIN TRAN;

    BEGIN TRY
      DELETE FROM dbo.TICKETPROJECTS
      WHERE TCKID = @TCKID;

      IF @PRJIDS IS NOT NULL AND ISJSON(@PRJIDS) = 1
      BEGIN
        INSERT INTO dbo.TICKETPROJECTS (TCKID, PRJID, CREUSR)
        SELECT @TCKID, TRY_CAST([value] AS INT), @CREUSR
        FROM OPENJSON(@PRJIDS)
        WHERE TRY_CAST([value] AS INT) IS NOT NULL;
      END;

      COMMIT TRAN;
    END TRY
    BEGIN CATCH
      IF @@TRANCOUNT > 0
        ROLLBACK TRAN;

      THROW;
    END CATCH;
    `,
    inputs: {
      TCKID: { type: sql.Int, value: TCKID },
      PRJIDS: { type: sql.NVarChar(sql.MAX), value: jsonPrjids },
      CREUSR: { type: sql.Int, value: CREUSR ?? null },
    },
  });

  return getTicketProjects(TCKID);
}

/**
 * Emails (actifs, avec email renseigné) des utilisateurs rattachés à l'un
 * des projets donnés (PROJECTUSERS) — utilisé par les notifications mail
 * ticketing pour les destinataires "rattaché à un projet" (cf.
 * ticketing/controllers.js, préférence MAILONPROJECT). Même filtre que
 * getServiceMemberEmails/getTicketCcEmails.
 */
export async function getProjectMemberEmails(PRJIDS) {
  const jsonPrjids = JSON.stringify([
    ...new Set((PRJIDS ?? []).filter((id) => Number.isInteger(id))),
  ]);

  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT DISTINCT u.USRID, u.EMAIL
    FROM dbo.PROJECTUSERS AS pu
    INNER JOIN USERSMANAGER.dbo.USERS AS u ON u.USRID = pu.USRID
    WHERE u.ACTIVE = 1
      AND u.EMAIL IS NOT NULL
      AND LTRIM(RTRIM(u.EMAIL)) <> ''
      AND @PRJIDS IS NOT NULL AND ISJSON(@PRJIDS) = 1
      AND pu.PRJID IN (
        SELECT TRY_CAST([value] AS INT) FROM OPENJSON(@PRJIDS)
      );
    `,
    inputs: {
      PRJIDS: { type: sql.NVarChar(sql.MAX), value: jsonPrjids },
    },
  });
  return result.recordset;
}

/* ─────────────────────────────────────────────
   USERSETTINGS — Préférences utilisateur (module ticketing)
   Une ligne par utilisateur (USRID unique), cf. sql/USERSETTINGS.table.sql.
   Remplace le stockage localStorage des préférences d'affichage du ticket
   (SHOWTASKSINFORM/AUTOSAVETICKET) et porte aussi les deux préférences de
   notification mail (MAILONCC/MAILONPROJECT — cf. controllers.js,
   getExtraMailRecipients).
───────────────────────────────────────────── */

const DEFAULT_USER_SETTINGS = {
  SHOWTASKSINFORM: false,
  AUTOSAVETICKET: true,
  MAILONCC: true,
  MAILONPROJECT: true,
};

const USER_SETTINGS_KEYS = Object.keys(DEFAULT_USER_SETTINGS);

/**
 * Préférences d'un utilisateur, toujours complètes (fusionnées avec
 * DEFAULT_USER_SETTINGS si la ligne n'existe pas encore, ou si une colonne
 * y est NULL — ne devrait pas arriver via upsertUserSettings, mais reste
 * défensif) : jamais null/undefined côté appelant.
 */
export async function getUserSettings(USRID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT SHOWTASKSINFORM, AUTOSAVETICKET, MAILONCC, MAILONPROJECT
    FROM dbo.USERSETTINGS
    WHERE USRID = @USRID;
    `,
    inputs: { USRID: { type: sql.Int, value: USRID } },
  });

  const row = result.recordset[0] ?? {};
  const settings = { ...DEFAULT_USER_SETTINGS };
  for (const key of USER_SETTINGS_KEYS) {
    if (row[key] !== null && row[key] !== undefined) {
      settings[key] = !!row[key];
    }
  }
  return settings;
}

/**
 * Crée ou met à jour (MERGE) la ligne USERSETTINGS d'un utilisateur. Seules
 * les colonnes présentes dans `patch` sont modifiées ; les autres gardent
 * leur valeur actuelle (ligne existante) ou leur défaut SQL (nouvelle
 * ligne) — même motif "patch partiel" que updateTicket au niveau contrôleur.
 */
export async function upsertUserSettings(USRID, patch = {}) {
  const providedKeys = USER_SETTINGS_KEYS.filter(
    (key) => patch[key] !== undefined,
  );

  const inputs = { USRID: { type: sql.Int, value: USRID } };
  for (const key of providedKeys) {
    inputs[key] = { type: sql.Bit, value: !!patch[key] };
  }

  const updateSet = providedKeys.map((key) => `[${key}] = @${key}`);
  const insertCols = ["USRID", ...USER_SETTINGS_KEYS, "CREUSR"];
  const insertVals = [
    "@USRID",
    ...USER_SETTINGS_KEYS.map((key) =>
      providedKeys.includes(key) ? `@${key}` : "DEFAULT",
    ),
    "@USRID",
  ];

  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    MERGE dbo.USERSETTINGS AS target
    USING (SELECT @USRID AS USRID) AS src
      ON target.USRID = src.USRID
    WHEN MATCHED THEN
      UPDATE SET ${updateSet.length ? updateSet.join(", ") + ", " : ""}UPDDAT = SYSUTCDATETIME()
    WHEN NOT MATCHED THEN
      INSERT (${insertCols.join(", ")})
      VALUES (${insertVals.join(", ")});
    `,
    inputs,
  });

  return getUserSettings(USRID);
}

/**
 * Préférences mail (MAILONCC/MAILONPROJECT) d'un lot d'utilisateurs, sous
 * forme de Map<string USRID, {MAILONCC, MAILONPROJECT}> — utilisateurs sans
 * ligne USERSETTINGS absents de la Map (l'appelant applique alors les
 * défauts, cf. controllers.js filterByMailPreference). Utilisé pour filtrer
 * les destinataires CC/projet d'une notification ticketing.
 */
export async function getUserMailPreferences(USRIDS) {
  const usrids = [
    ...new Set(
      (USRIDS ?? [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id)),
    ),
  ];
  if (!usrids.length) return new Map();

  const jsonUsrids = JSON.stringify(usrids);

  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT USRID, MAILONCC, MAILONPROJECT
    FROM dbo.USERSETTINGS
    WHERE @USRIDS IS NOT NULL AND ISJSON(@USRIDS) = 1
      AND USRID IN (SELECT TRY_CAST([value] AS INT) FROM OPENJSON(@USRIDS));
    `,
    inputs: { USRIDS: { type: sql.NVarChar(sql.MAX), value: jsonUsrids } },
  });

  const map = new Map();
  for (const row of result.recordset) {
    map.set(String(row.USRID), {
      MAILONCC: !!row.MAILONCC,
      MAILONPROJECT: !!row.MAILONPROJECT,
    });
  }
  return map;
}
