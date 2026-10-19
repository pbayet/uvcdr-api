import { utcToParisIso } from "../../core/utils/dates.utils.js";

/* ═══════════════════════════════════════════════════════════════
   TICKETS — Utils / Formatage
   Transforme le recordset à plat (1 ligne par note) en un tableau
   d'objets ticket avec leurs notes imbriquées.
═══════════════════════════════════════════════════════════════ */

export function formatTickets(rows) {
  if (!rows?.length) return [];

  const ticketMap = new Map();

  for (const row of rows) {
    if (!row.TCKID) continue;

    if (!ticketMap.has(row.TCKID)) {
      ticketMap.set(row.TCKID, {
        TCKID: row.TCKID,
        TCKCOD: row.TCKCOD ?? "",
        TITLE: row.TITLE ?? "",
        DESCR: row.DESCR ?? null,

        SRV: row.SRVID ? { SRVID: row.SRVID, NAME: row.SRVNAM ?? "" } : null,

        STS: row.STSID
          ? {
              STSID: row.STSID,
              NAME: row.STSNAM ?? "",
              CODE: row.STSCOD ?? "",
              LVLVAL: row.STSLVL ?? 0,
            }
          : null,

        PRI: row.PRIID
          ? {
              PRIID: row.PRIID,
              NAME: row.PRINAM ?? "",
              CODE: row.PRICOD ?? "",
              LVLVAL: row.PRILVL ?? 0,
            }
          : null,

        CAT: {
          CATID: row.CATID ?? null,
          CATNAM: row.CATNAM ?? "",
          SC1ID: row.SC1ID ?? null,
          SC1NAM: row.SC1NAM ?? "",
          SC2ID: row.SC2ID ?? null,
          SC2NAM: row.SC2NAM ?? "",
          SC3ID: row.SC3ID ?? null,
          SC3NAM: row.SC3NAM ?? "",
        },

        CREUSR: row.CREUSR ?? null,
        USRNAM: row.USRNAM ?? "",
        CREEMAIL: row.CREEMAIL ?? null,
        ASGUSR: row.ASGUSR ?? null,
        ASGNAM: row.ASGNAM ?? "",

        CREDAT: utcToParisIso(row.CREDAT ?? null),
        UPDDAT: utcToParisIso(row.UPDDAT ?? null),
        CLSDAT: utcToParisIso(row.CLSDAT ?? null),

        // Planification prévisionnelle (cf. sql/TICKETS.add-DATDEB-DATFIN.sql) —
        // distincte des dates d'audit ci-dessus : saisie libre par l'utilisateur,
        // pas posée automatiquement par le serveur.
        DATDEB: utcToParisIso(row.DATDEB ?? null),
        DATFIN: utcToParisIso(row.DATFIN ?? null),

        // Dates réelles (cf. sql/TICKETS.add-DATDEBREEL-DATFINREEL.sql) —
        // même principe que DATDEB/DATFIN, mais pour le déroulé réel du
        // ticket plutôt que sa planification prévisionnelle.
        DATDEBREEL: utcToParisIso(row.DATDEBREEL ?? null),
        DATFINREEL: utcToParisIso(row.DATFINREEL ?? null),

        // Temps passé, en minutes (cf. sql/TICKETS.add-TPSPREV-TPSREEL.sql) —
        // représentation alternative aux dates ci-dessus, pas des dates :
        // pas de conversion de fuseau horaire à faire ici.
        TPSPREV: row.TPSPREV ?? null,
        TPSREEL: row.TPSREEL ?? null,

        MYSRV: !!row.MYSRV,
        // Membre du service PRINCIPAL uniquement (cf. modules/ticketing/
        // services.js SELECT_TICKETS) — un membre d'un service secondaire
        // a MYSRV=true mais MYPRIMARYSRV=false : il voit la catégorisation
        // et le service principal, mais ne peut pas les modifier (cf.
        // TicketInformationSection.tsx).
        MYPRIMARYSRV: !!row.MYPRIMARYSRV,
        MYPRJ: !!row.MYPRJ,
        UNSEEN: !!row.UNSEEN,
        DLTD: Boolean(row.DLTD),
        MRGID: row.MRGID ?? null,

        PJS: [],
        NOTES: [],
        TRACKCOMMENTS: [],
        CC: [],
        PROJECTS: [],
        // Services co-attribués (TICKETSERVICES), en plus du service
        // principal (SRV ci-dessus) — mêmes droits d'accès/action (cf.
        // modules/ticketing/services.js, SELECT_TICKETS / MyServices).
        SERVICES: [],
      });
    }

    const ticket = ticketMap.get(row.TCKID);

    if (row.ATTID && !ticket.PJS.some((p) => p.ID === row.ATTID)) {
      ticket.PJS.push({
        ID: row.ATTID,
        FILECODE: row?.ATTFILECODE ?? "",
        APPCODE: row?.ATTAPPCODE ?? "",
        ENTITYTYPE: row?.ATTENTITYTYPE ?? "",
        ENTITYID: row?.ATTENTITYID ?? "",
        ORIGINALNAME: row?.ATTORIGINALNAME ?? "",
        STOREDNAME: row?.ATTSTOREDNAME ?? "",
        RELATIVEPATH: row?.ATTRELATIVEPATH ?? "",
        MIMETYPE: row?.ATTMIMETYPE ?? "",
        EXTENSION: row?.ATTEXTENSION ?? "",
        COMPRESSED:
          row?.ATTCOMPRESSED == null ? false : Boolean(row.ATTCOMPRESSED),
        ORIGINALSIZEBYTES: Number(row?.ATTORIGINALSIZEBYTES ?? 0) || 0,
        SIZEBYTES: Number(row?.ATTSIZEBYTES ?? 0) || 0,
        CHECKSUMSHA256: row?.ATTCHECKSUMSHA256 ?? "",
        STATUS: row?.ATTSTATUS ?? "",
        UPLOADEDBY: row?.ATTUPLOADEDBY ?? "",
        CREATEDAT: row?.ATTCREATEDAT
          ? utcToParisIso(new Date(row.ATTCREATEDAT))
          : null,
        DELETEDAT: row?.ATTDELETEDAT
          ? utcToParisIso(new Date(row.ATTDELETEDAT))
          : null,
      });
    }

    if (row.CCID && !ticket.CC.some((c) => c.CCID === row.CCID)) {
      ticket.CC.push({
        CCID: row.CCID,
        USRID: row.CCUSRID ?? null,
        USRNAM: row.CCUSRNAM ?? "",
        EMAIL: row.CCEMAIL ?? null,
      });
    }

    if (row.TPJID && !ticket.PROJECTS.some((p) => p.TPJID === row.TPJID)) {
      ticket.PROJECTS.push({
        TPJID: row.TPJID,
        PRJID: row.TPJPRJID ?? null,
        NAME: row.TPJPRJNAM ?? "",
        COLOR: row.TPJPRJCOLOR ?? null,
      });
    }

    if (row.TSVID && !ticket.SERVICES.some((s) => s.TSVID === row.TSVID)) {
      ticket.SERVICES.push({
        TSVID: row.TSVID,
        SRVID: row.TSVSRVID ?? null,
        NAME: row.TSVSRVNAM ?? "",
      });
    }

    if (row.NOTID && !ticket.NOTES.some((n) => n.NOTID === row.NOTID)) {
      const note = {
        NOTID: row.NOTID,
        CMNT: row.NOTCMT ?? "",
        USRID: row.NOTUSRID ?? null,
        USRNAM: row.NOTUSRNAM ?? "",
        PUBLIC: row.NOTPUBLIC ?? true,
        PJS: [],
        CREDAT: utcToParisIso(row.NOTCREDAT ?? null),
      };

      // Fix V1.1.0 : V1.0.0 lisait `row.NNATTID` (typo) au lieu de `row.NATTID`,
      // ce qui laissait toujours l'ID de la pièce jointe de note à `undefined`.
      if (row.NATTID && !note.PJS.some((n) => n.ID === row.NATTID)) {
        note.PJS.push({
          ID: row.NATTID,
          FILECODE: row?.NATTFILECODE ?? "",
          APPCODE: row?.NATTAPPCODE ?? "",
          ENTITYTYPE: row?.NATTENTITYTYPE ?? "",
          ENTITYID: row?.NATTENTITYID ?? "",
          ORIGINALNAME: row?.NATTORIGINALNAME ?? "",
          STOREDNAME: row?.NATTSTOREDNAME ?? "",
          RELATIVEPATH: row?.NATTRELATIVEPATH ?? "",
          MIMETYPE: row?.NATTMIMETYPE ?? "",
          EXTENSION: row?.NATTEXTENSION ?? "",
          COMPRESSED:
            row?.NATTCOMPRESSED == null ? false : Boolean(row.NATTCOMPRESSED),
          ORIGINALSIZEBYTES: Number(row?.NATTORIGINALSIZEBYTES ?? 0) || 0,
          SIZEBYTES: Number(row?.NATTSIZEBYTES ?? 0) || 0,
          CHECKSUMSHA256: row?.NATTCHECKSUMSHA256 ?? "",
          STATUS: row?.NATTSTATUS ?? "",
          UPLOADEDBY: row?.NATTUPLOADEDBY ?? "",
          CREATEDAT: row?.NATTCREATEDAT
            ? utcToParisIso(new Date(row.NATTCREATEDAT))
            : null,
          DELETEDAT: row?.NATTDELETEDAT
            ? utcToParisIso(new Date(row.NATTDELETEDAT))
            : null,
        });
      }

      ticket.NOTES.push(note);
    }

    if (
      row.TRKCMNT &&
      row.ALLTRKID &&
      !ticket.TRACKCOMMENTS.some((t) => t.TRKID === row.ALLTRKID)
    ) {
      const track = {
        TRKID: row.ALLTRKID,
        CMNT: row.TRKCMNT,
        CREDAT: utcToParisIso(new Date(row.ALLTRKDAT) ?? null),
      };

      ticket.TRACKCOMMENTS.push(track);
    }
  }

  for (const ticket of ticketMap.values()) {
    ticket.NOTES.sort((a, b) => new Date(a.CREDAT) - new Date(b.CREDAT));
  }

  return [...ticketMap.values()];
}

/**
 * Formate un recordset en ticket unique. Lève une erreur 404 si vide.
 */
export function formatTicket(rows) {
  const list = formatTickets(rows);
  if (!list.length) {
    const err = new Error("Ticket introuvable ou accès refusé.");
    err.status = 404;
    throw err;
  }
  return list[0];
}

/* ═══════════════════════════════════════════════════════════════
   SERVICES — Utils / Formatage
   Transforme le recordset à plat (1 ligne par membre) en un tableau
   de services avec leurs membres imbriqués (MEMBERS), pour coller à
   la classe front TicketService (SRVID, NAME, DESCR, ACTIVE, MEMBERS).
═══════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════
   TODOS — Utils / Formatage
   Un flat SELECT (une ligne = une todo) → pas d'imbrication à faire,
   juste caster/défaulter les champs pour coller à la classe front
   TicketTodo (TDOID, TCKID, LABEL, DONE, PUBLIC, USRID, USRNAM,
   CREDAT, UPDDAT).
═══════════════════════════════════════════════════════════════ */

export function formatTodos(rows) {
  if (!rows?.length) return [];

  return rows.map((row) => ({
    TDOID: row.TDOID,
    TCKID: row.TCKID,
    LABEL: row.LABEL ?? "",
    SECTION: row.SECTION ?? "",
    DONE: Boolean(row.DONE),
    PUBLIC: row.PUBLIC ?? true,
    USRID: row.USRID ?? null,
    USRNAM: row.USRNAM ?? "",
    CREDAT: utcToParisIso(row.CREDAT ?? null),
    UPDDAT: utcToParisIso(row.UPDDAT ?? null),
  }));
}

/**
 * Formate une seule todo. Lève une erreur 404 si absente/inaccessible.
 */
export function formatTodo(row) {
  if (!row) {
    const err = new Error("Tâche introuvable ou accès refusé.");
    err.status = 404;
    throw err;
  }
  return formatTodos([row])[0];
}

export function formatServices(rows) {
  if (!rows?.length) return [];

  const serviceMap = new Map();

  for (const row of rows) {
    if (!row.SRVID) continue;

    if (!serviceMap.has(row.SRVID)) {
      serviceMap.set(row.SRVID, {
        SRVID: row.SRVID,
        NAME: row.NAME ?? "",
        DESCR: row.DESCR ?? "",
        ACTIVE: Boolean(row.ACTIVE),
        MEMBERS: [],
      });
    }

    const service = serviceMap.get(row.SRVID);

    if (row.ASGID && !service.MEMBERS.some((m) => m.ASGID === row.ASGID)) {
      service.MEMBERS.push({
        ASGID: row.ASGID,
        USRID: row.USRID ?? null,
        USRNAM: row.USRNAM ?? "",
      });
    }
  }

  return [...serviceMap.values()];
}

/* ─────────────────────────────────────────────
   PROJECTS — Formatage
   Même principe que formatTickets/formatServices : le recordset est à
   plat (1 ligne par pièce jointe, cf. getProjects), on regroupe donc par
   PRJID et on imbrique les pièces jointes dans PJS.
───────────────────────────────────────────── */
export function formatProjects(rows) {
  if (!rows?.length) return [];

  const projectMap = new Map();

  for (const row of rows) {
    if (!row.PRJID) continue;

    if (!projectMap.has(row.PRJID)) {
      projectMap.set(row.PRJID, {
        PRJID: row.PRJID,
        NAME: row.NAME ?? "",
        DESCR: row.DESCR ?? null,
        COLOR: row.COLOR ?? null,
        ACTIVE: Boolean(row.ACTIVE),
        TCKCOUNT: row.TCKCOUNT ?? 0,
        PJS: [],
      });
    }

    const project = projectMap.get(row.PRJID);

    if (row.PATTID && !project.PJS.some((p) => p.ID === row.PATTID)) {
      project.PJS.push({
        ID: row.PATTID,
        FILECODE: row?.PATTFILECODE ?? "",
        APPCODE: row?.PATTAPPCODE ?? "",
        ENTITYTYPE: row?.PATTENTITYTYPE ?? "",
        ENTITYID: row?.PATTENTITYID ?? "",
        ORIGINALNAME: row?.PATTORIGINALNAME ?? "",
        STOREDNAME: row?.PATTSTOREDNAME ?? "",
        RELATIVEPATH: row?.PATTRELATIVEPATH ?? "",
        MIMETYPE: row?.PATTMIMETYPE ?? "",
        EXTENSION: row?.PATTEXTENSION ?? "",
        COMPRESSED:
          row?.PATTCOMPRESSED == null ? false : Boolean(row.PATTCOMPRESSED),
        ORIGINALSIZEBYTES: Number(row?.PATTORIGINALSIZEBYTES ?? 0) || 0,
        SIZEBYTES: Number(row?.PATTSIZEBYTES ?? 0) || 0,
        CHECKSUMSHA256: row?.PATTCHECKSUMSHA256 ?? "",
        STATUS: row?.PATTSTATUS ?? "",
        UPLOADEDBY: row?.PATTUPLOADEDBY ?? "",
        CREATEDAT: row?.PATTCREATEDAT
          ? utcToParisIso(new Date(row.PATTCREATEDAT))
          : null,
        DELETEDAT: row?.PATTDELETEDAT
          ? utcToParisIso(new Date(row.PATTDELETEDAT))
          : null,
      });
    }
  }

  return [...projectMap.values()];
}
