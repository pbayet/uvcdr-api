import { utcToParisIso } from "../../../core/utils/dates.utils.js";

/* ─────────────────────────────────────────────
   AUDITS — Droits d'accès + formatage
───────────────────────────────────────────── */

/**
 * Services autorisés à gérer les audits (déposer, modifier, valider,
 * supprimer). Configurable via AUDITS_MANAGER_SERVICES (liste séparée par
 * des virgules, comparée à payload.data.service.name — même valeur que
 * jwtPayload.$service côté front, cf. SERVICE_QUALITE dans
 * DecentViewRowClass.ts). Défaut : "QUALITE".
 */
function managerServices() {
  return (process.env.AUDITS_MANAGER_SERVICES || "QUALITE")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

/** Profils "gestionnaires" globaux (MODIFY_PERMS), même convention que files/utils.js. */
function isManagerPermission(permission) {
  return (process.env.MODIFY_PERMS || "")
    .split(",")
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean)
    .includes(String(permission || "").toUpperCase());
}

/** Token d'une cave (authentification mot de passe cave, appcode DCLING). */
export function isCaveToken(req) {
  return req?.payload?.application === "DCLING" && !!req?.payload?.isCave;
}

/** CAVEID de la cave connectée (null pour un utilisateur interne). */
export function getCaveId(req) {
  return isCaveToken(req) ? Number(req.payload.data?.id) || null : null;
}

/** Utilisateur interne du service Qualité (ou gestionnaire global). */
export function isAuditManager(req) {
  if (!req?.payload || isCaveToken(req)) return false;
  const service = String(req.payload.data?.service?.name || "").toUpperCase();
  return (
    managerServices().includes(service) ||
    isManagerPermission(req.payload.permission)
  );
}

export function assertAuditManager(req) {
  if (!isAuditManager(req)) throw new Error("ACCESS_DENIED_WO_LOGOUT");
}

/**
 * Une cave ne voit / n'agit que sur SES audits. Les utilisateurs internes
 * ont un accès en lecture à tous les audits (écriture : cf. assertAuditManager).
 */
export function assertCanAccessAudit(req, audit) {
  if (!audit || (audit.ISDEL && isCaveToken(req))) {
    const err = new Error("Audit introuvable.");
    err.status = 404;
    throw err;
  }
  if (isCaveToken(req) && Number(audit.CAVEID) !== getCaveId(req)) {
    throw new Error("ACCESS_DENIED_WO_LOGOUT");
  }
}

/** Nom affiché de l'auteur d'une action (tracé dans CREUSR/REVUSR/EVTUSR). */
export function getActorName(req) {
  const data = req?.payload?.data ?? {};
  if (data.LastName || data.FirstName) {
    return `${data.LastName ?? ""} ${data.FirstName ?? ""}`.trim();
  }
  if (data.CAVENOM) return data.CAVENOM;
  return data.email || "Inconnu";
}

/* ─────────────────────────── Formatage ─────────────────────────── */

function isoDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Ligne de V_AUDITS → résumé d'audit (liste). */
export function formatAuditSummary(row) {
  if (!row) return null;
  return {
    AUDID: row.AUDID,
    CAVEID: row.CAVEID,
    CAVENOM: row.CAVENOM ?? "",
    CODACCI: row.CODACCI ?? "",
    TITLE: row.TITLE,
    STATUS: row.STATUS,
    ISEXPIRED: !!row.ISEXPIRED,
    ISDEL: !!row.ISDEL,
    CREUSR: row.CREUSR,
    CREDAT: utcToParisIso(row.CREDAT),
    DELUSR: row.DELUSR ?? null,
    DELDAT: utcToParisIso(row.DELDAT),
    CURRENT: {
      VERID: row.VERID,
      VERNUM: row.VERNUM,
      DATEXP: isoDate(row.DATEXP),
      COMMENT: row.VERCOM ?? null,
      CREUSR: row.VERUSR,
      CREDAT: utcToParisIso(row.VERDAT),
    },
    LASTRETURN: row.RETID
      ? {
          RETID: row.RETID,
          RETNUM: row.RETNUM,
          STATUS: row.RETSTATUS,
          CREUSR: row.RETUSR,
          CREDAT: utcToParisIso(row.RETDAT),
        }
      : null,
  };
}

function formatDoc(row) {
  return {
    DOCID: row.DOCID,
    FILECODE: row.FILECODE,
    ORIGINALNAME: row.ORIGINALNAME ?? "",
    STOREDNAME: row.STOREDNAME ?? "",
    RELATIVEPATH: row.RELATIVEPATH ?? "",
    MIMETYPE: row.MIMETYPE ?? "",
    EXTENSION: row.EXTENSION ?? "",
    SIZEBYTES: Number(row.SIZEBYTES ?? 0),
    UPLOADEDBY: row.UPLOADEDBY ?? null,
    CREATEDAT: utcToParisIso(row.CREDAT),
  };
}

/**
 * Assemble l'historique complet d'un audit (versions → documents + retours
 * → documents, journal d'évènements), du plus récent au plus ancien.
 */
export function formatAuditDetail(summaryRow, { versions, returns, docs, events }) {
  const summary = formatAuditSummary(summaryRow);
  if (!summary) return null;

  const docsByVer = new Map();
  const docsByRet = new Map();
  for (const d of docs) {
    const map = d.VERID ? docsByVer : docsByRet;
    const key = d.VERID ?? d.RETID;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(formatDoc(d));
  }

  const returnsByVer = new Map();
  for (const r of returns) {
    if (!returnsByVer.has(r.VERID)) returnsByVer.set(r.VERID, []);
    returnsByVer.get(r.VERID).push({
      RETID: r.RETID,
      VERID: r.VERID,
      RETNUM: r.RETNUM,
      COMMENT: r.COMMENT ?? null,
      STATUS: r.STATUS,
      CREUSR: r.CREUSR,
      CREDAT: utcToParisIso(r.CREDAT),
      REVUSR: r.REVUSR ?? null,
      REVDAT: utcToParisIso(r.REVDAT),
      REVCOM: r.REVCOM ?? null,
      DOCS: docsByRet.get(r.RETID) ?? [],
    });
  }

  const VERSIONS = versions.map((v) => ({
    VERID: v.VERID,
    VERNUM: v.VERNUM,
    DATEXP: isoDate(v.DATEXP),
    COMMENT: v.COMMENT ?? null,
    CREUSR: v.CREUSR,
    CREDAT: utcToParisIso(v.CREDAT),
    DOCS: docsByVer.get(v.VERID) ?? [],
    RETURNS: returnsByVer.get(v.VERID) ?? [],
  }));

  const current = VERSIONS.find((v) => v.VERID === summary.CURRENT.VERID);

  return {
    ...summary,
    CURRENT: { ...summary.CURRENT, DOCS: current?.DOCS ?? [] },
    LASTRETURN: current?.RETURNS?.[0] ?? null,
    VERSIONS,
    EVENTS: events.map((e) => ({
      EVTID: e.EVTID,
      VERID: e.VERID ?? null,
      RETID: e.RETID ?? null,
      EVTTYP: e.EVTTYP,
      EVTUSR: e.EVTUSR,
      EVTDAT: utcToParisIso(e.EVTDAT),
      COMMENT: e.COMMENT ?? null,
    })),
  };
}
