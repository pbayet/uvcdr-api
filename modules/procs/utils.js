import { getImpersonation } from "../../core/middlewares/auth.middleware.js";

/* ─────────────────────────────────────────────
   Droits
───────────────────────────────────────────── */

/** Code de l'application (JWT `application`, USERSMANAGER.APPLICATIONS.APPCOD). */
export const APP_CODE = "PROCS";

/**
 * Profils "rédacteurs" : ajout, modification, publication, archivage des
 * procédures et gestion des catégories. PROCS_EDITOR_PERMS (liste PRMNAM
 * séparée par des virgules) si défini, sinon MODIFY_PERMS (DEV,
 * SUPERADMIN, ADMIN) — même convention que modules/faq/utils.js.
 */
export function isEditorPermission(permission) {
  const editors = (process.env.PROCS_EDITOR_PERMS || process.env.MODIFY_PERMS || "")
    .split(",")
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);

  return editors.includes(String(permission || "").toUpperCase());
}

/**
 * Contexte de l'utilisateur courant. Le jeton doit avoir été émis pour
 * l'application PROCS : la permission (donc le rôle de rédacteur) portée par
 * un jeton d'une autre application UNIS ne vaut pas ici.
 */
export function getUserContext(req) {
  const payload = req?.payload;
  const USRID = Number(payload?.data?.id);
  if (!USRID) throw new Error("INVALID_TOKEN");
  if (payload?.application !== APP_CODE) throw new Error("ACCESS_DENIED_WO_LOGOUT");

  let DEVEMAIL = null;
  try {
    DEVEMAIL = getImpersonation(payload)?.devEmail ?? null;
  } catch {
    DEVEMAIL = null;
  }

  return {
    USRID,
    ISEDITOR: isEditorPermission(payload?.permission),
    USRNAM:
      `${payload?.data?.FirstName ?? ""} ${payload?.data?.LastName ?? ""}`.trim() ||
      `Utilisateur #${USRID}`,
    DEVEMAIL,
  };
}

export function assertEditor(ctx) {
  if (!ctx.ISEDITOR) throw new Error("ACCESS_DENIED_WO_LOGOUT");
}

/** Erreur "ad hoc" avec statut HTTP (cf. error.middleware.js, branche err.status). */
export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/* ─────────────────────────────────────────────
   Formatage (cf. entities/procedures côté front)
───────────────────────────────────────────── */

const splitKeywords = (value) =>
  value ? String(value).split("|").filter(Boolean).sort((a, b) => a.localeCompare(b, "fr")) : [];

const toIsoDate = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // Colonne DATE : renvoyée à minuit UTC par mssql.
  return d.toISOString().slice(0, 10);
};

export function formatProcedure(row) {
  const reviewDate = toIsoDate(row.REVIEWDAT);
  return {
    PRCID: row.PRCID,
    REFCODE: row.REFCODE ?? null,
    TITLE: row.TITLE,
    SUMMARY: row.SUMMARY ?? null,
    OWNER: row.OWNER ?? null,
    STATUS: row.STATUS,
    REVIEWDAT: reviewDate,
    OVERDUE: !!reviewDate && reviewDate < new Date().toISOString().slice(0, 10),
    PUBDAT: row.PUBDAT ?? null,
    DLTD: !!row.DLTD,
    CREDAT: row.CREDAT,
    UPDDAT: row.UPDDAT ?? null,
    CREUSR: row.CREUSR,
    CREUSRNAM: row.CREUSRNAM ?? (row.CREUSR ? `Utilisateur #${row.CREUSR}` : ""),
    UPDUSR: row.UPDUSR ?? null,
    UPDUSRNAM: row.UPDUSRNAM ?? (row.UPDUSR ? `Utilisateur #${row.UPDUSR}` : ""),
    CAT: row.CATID
      ? {
          CATID: row.CATID,
          NAME: row.CATNAME,
          COLOR: row.CATCOLOR ?? null,
          ICON: row.CATICON ?? null,
          PARENT: row.CATPARENTID
            ? { CATID: row.CATPARENTID, NAME: row.CATPARENTNAME }
            : null,
          // false si la catégorie ou un de ses parents est désactivé (fiche
          // alors masquée aux lecteurs) ; INACTIVENAME : la catégorie en cause.
          ACTIVE: row.CATACTIVE === undefined ? true : !!row.CATACTIVE,
          INACTIVENAME: row.CATINACTIVENAME ?? null,
          // Chemin complet, de la catégorie racine à la catégorie elle-même.
          PATH: [
            row.CATGPID ? { CATID: row.CATGPID, NAME: row.CATGPNAME } : null,
            row.CATPARENTID ? { CATID: row.CATPARENTID, NAME: row.CATPARENTNAME } : null,
            { CATID: row.CATID, NAME: row.CATNAME },
          ].filter(Boolean),
        }
      : null,
    KEYWORDS: splitKeywords(row.KEYWORDS),
    VERSIONCOUNT: row.VERSIONCOUNT ?? 0,
    CURRENT: row.CURVERID
      ? {
          VERID: row.CURVERID,
          VERNUM: row.VERNUM,
          ORIGINALNAME: row.ORIGINALNAME,
          EXTENSION: row.EXTENSION,
          MIMETYPE: row.MIMETYPE,
          SIZEBYTES: row.SIZEBYTES != null ? Number(row.SIZEBYTES) : null,
          TEXTSTATUS: row.TEXTSTATUS,
          PAGES: row.PAGES ?? null,
          HASPREVIEW: !!row.HASPREVIEW,
          CREDAT: row.VERDAT,
          COMMENT: row.VERCOMMENT ?? null,
        }
      : null,
    ACKED: !!row.ACKED,
    MYLASTVIEW: row.MYLASTVIEW ?? null,
    // Recherche
    SCORE: row.SCORE ?? 0,
    SNIPPET: row.SNIPPET
      ? `${row.SNIPPETCUT ? "…" : ""}${String(row.SNIPPET).replace(/\s+/g, " ").trim()}…`
      : null,
    MATCHINCONTENT: !!row.MATCHINCONTENT,
  };
}

export function formatVersion(row) {
  return {
    VERID: row.VERID,
    PRCID: row.PRCID,
    VERNUM: row.VERNUM,
    COMMENT: row.COMMENT ?? null,
    ORIGINALNAME: row.ORIGINALNAME,
    EXTENSION: row.EXTENSION,
    MIMETYPE: row.MIMETYPE,
    SIZEBYTES: row.SIZEBYTES != null ? Number(row.SIZEBYTES) : null,
    CHECKSUM: row.CHECKSUM ?? null,
    TEXTSTATUS: row.TEXTSTATUS,
    PAGES: row.PAGES ?? null,
    HASFILE: !!row.FILECODE,
    HASPREVIEW: !!row.PREVIEWCODE,
    CREUSR: row.CREUSR,
    CREUSRNAM: row.CREUSRNAM ?? `Utilisateur #${row.CREUSR}`,
    CREDAT: row.CREDAT,
    ISCURRENT: !!row.ISCURRENT,
    ACKCOUNT: row.ACKCOUNT ?? 0,
  };
}

export function formatHistory(row) {
  let DETAILS = null;
  if (row.DETAILS) {
    try {
      DETAILS = JSON.parse(row.DETAILS);
    } catch {
      DETAILS = { raw: row.DETAILS };
    }
  }
  return {
    HISID: row.HISID,
    PRCID: row.PRCID,
    REFCODE: row.REFCODE ?? null,
    TITLE: row.TITLE,
    VERID: row.VERID ?? null,
    VERNUM: row.VERNUM ?? null,
    ACTION: row.ACTION,
    DETAILS,
    USRID: row.USRID,
    USRNAM: row.USRNAM ?? `Utilisateur #${row.USRID}`,
    DEVEMAIL: row.DEVEMAIL ?? null,
    CREDAT: row.CREDAT,
  };
}

export function formatReader(row) {
  return {
    USRID: row.USRID,
    USRNAM: row.USRNAM ?? `Utilisateur #${row.USRID}`,
    EMAIL: row.EMAIL ?? null,
    VIEWS: row.VIEWS ?? 0,
    DOWNLOADS: row.DOWNLOADS ?? 0,
    LASTVIEW: row.LASTVIEW ?? null,
    LASTVERNUM: row.LASTVERNUM ?? null,
    CURACKDAT: row.CURACKDAT ?? null,
    LASTACKVERNUM: row.LASTACKVERNUM ?? null,
    LASTACKDAT: row.LASTACKDAT ?? null,
  };
}

/** Profondeur maximale de l'arborescence des catégories. */
export const MAX_CATEGORY_DEPTH = 3;

/**
 * Contrôle le rangement de la catégorie CATID (null : nouvelle catégorie)
 * sous PARENTID, d'après les liens { CATID, PARENTID } de toutes les
 * catégories. Renvoie "NOT_FOUND" (parent inconnu), un message d'erreur,
 * ou null si le rangement est valide : pas de cycle (une catégorie ne peut
 * pas être rangée sous elle-même ni sous une de ses sous-catégories) et
 * MAX_CATEGORY_DEPTH niveaux au plus, en comptant les sous-catégories que
 * CATID emporte avec elle.
 */
export function checkCategoryPlacement(links, CATID, PARENTID) {
  if (!PARENTID) return null;
  const parentOf = new Map(links.map((l) => [l.CATID, l.PARENTID ?? null]));
  if (!parentOf.has(PARENTID)) return "NOT_FOUND";

  // Niveau du parent (1 = catégorie racine), en détectant un cycle.
  let level = 0;
  for (let id = PARENTID; id != null; id = parentOf.get(id) ?? null) {
    if (CATID && id === CATID) {
      return "Une catégorie ne peut pas être rangée dans elle-même ni dans une de ses sous-catégories.";
    }
    if (++level > MAX_CATEGORY_DEPTH) break;
  }

  // Nombre de niveaux sous CATID (0 : aucune sous-catégorie).
  const height = (id, depth = 0) => {
    if (depth > MAX_CATEGORY_DEPTH) return depth;
    const children = links.filter((l) => l.PARENTID === id);
    return children.length ? Math.max(...children.map((c) => height(c.CATID, depth + 1))) : depth;
  };
  const below = CATID ? height(CATID) : 0;

  if (level + 1 + below > MAX_CATEGORY_DEPTH) {
    return below
      ? `${MAX_CATEGORY_DEPTH} niveaux au plus : avec ses sous-catégories, cette catégorie ne peut pas être rangée ici.`
      : `${MAX_CATEGORY_DEPTH} niveaux au plus : la catégorie parente est déjà au dernier niveau.`;
  }
  return null;
}

/**
 * Raison pour laquelle une catégorie ne peut pas être supprimée (null :
 * supprimable), d'après son utilisation { PROCCOUNT, CHILDCOUNT }.
 */
export function categoryDeleteError({ PROCCOUNT = 0, CHILDCOUNT = 0 } = {}) {
  const reasons = [];
  if (CHILDCOUNT > 0) reasons.push(`${CHILDCOUNT} sous-catégorie${CHILDCOUNT > 1 ? "s" : ""}`);
  if (PROCCOUNT > 0) reasons.push(`${PROCCOUNT} procédure${PROCCOUNT > 1 ? "s" : ""} (corbeille comprise)`);
  if (!reasons.length) return null;
  return `elle contient encore ${reasons.join(" et ")}. Désactivez-la plutôt.`;
}

export function formatCategory(row) {
  return {
    CATID: row.CATID,
    PARENTID: row.PARENTID ?? null,
    NAME: row.NAME,
    DESCR: row.DESCR ?? null,
    COLOR: row.COLOR ?? null,
    ICON: row.ICON ?? null,
    SORTORD: row.SORTORD ?? 0,
    ACTIVE: !!row.ACTIVE,
    PROCCOUNT: row.PROCCOUNT ?? 0,
    CANDELETE: !!row.CANDELETE,
  };
}

/**
 * Différences entre la fiche avant/après modification, pour le journal :
 * { CHAMP: { from, to } } (champs réellement modifiés uniquement).
 */
export function diffFields(before, after, fields) {
  const changes = {};
  for (const f of fields) {
    if (after[f] === undefined) continue;
    let from = before[f] ?? null;
    let to = after[f] ?? null;
    if (f === "REVIEWDAT") {
      from = toIsoDate(from);
      to = toIsoDate(to);
    }
    if (Array.isArray(from) || Array.isArray(to)) {
      const a = [...(from ?? [])].sort().join("|");
      const b = [...(to ?? [])].sort().join("|");
      if (a !== b) changes[f] = { from: from ?? [], to: to ?? [] };
      continue;
    }
    if (String(from ?? "") !== String(to ?? "")) changes[f] = { from, to };
  }
  return changes;
}

/** Nom de fichier pour Content-Disposition (RFC 6266 / 5987). */
export function contentDisposition(disposition, filename) {
  const name = String(filename || "document").replace(/[\r\n"]/g, "");
  const ascii = name.normalize("NFKD").replace(/[^\x20-\x7e]/g, "_");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
