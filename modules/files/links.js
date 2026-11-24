import crypto from "node:crypto";
import * as services from "./services.js";
import { isManagerPermission } from "./utils.js";

/* ─────────────────────────────────────────────
   FILES — Liens directs vers un fichier (toutes applications)

   Un lien direct ouvre un fichier sans connexion :
     GET /api/files/open/<jeton>[/<nom du fichier>]
   - jeton aléatoire (192 bits), seule son empreinte SHA-256 est stockée
     (table FILELINKS, cf. sql/FILELINKS.table.sql) ;
   - expiration au choix (`EXPIRESIN`) ou lien permanent (`PERMANENT`) ;
   - nom du fichier en fin d'URL ou non (`WITHNAME`) : purement indicatif
     (seul le jeton fait foi), il permet aux visionneuses et navigateurs de
     reconnaître le type (.pdf, .docx) ;
   - révocable un par un (DELETE /api/files/links/:lnkid).

   Qui peut créer quel lien, et vers quoi : c'est l'application du jeton
   (APPCODE) qui le décide, via un « fournisseur » (cf. PROVIDERS) :

     authorize(req, input) → {
       FILECODE? | ENTITYTYPE + ENTITYID + PARAMS?,   // cible
       FILENAME, LABEL?,                              // nom (URL), libellé (liste)
       POLICY: { ALLOWPERMANENT, MAXTTL, DEFAULTTTL } // en secondes ; MAXTTL null = sans limite
     }
     resolve(link, { method }) → { FILECODE, FILENAME?, onOpen? } | null
       appelé à CHAQUE ouverture : null = cible plus disponible ;
       onOpen({ disposition }) : traçabilité propre à l'application
       (jamais appelé pour une requête HEAD).
     canManage(req) → bool : voir et révoquer tous les liens de l'application.

   Sans fournisseur : lien vers un FILECODE de l'application du jeton,
   réservé aux gestionnaires (MODIFY_PERMS).
───────────────────────────────────────────── */

/** Fournisseurs par application (import à la demande, comme la FAQ). */
const PROVIDERS = {
  PROCS: () => import("../procs/fileLinks.js"),
};

const DAY = 86400;
/** Durée par défaut d'un lien temporaire : FILES_LINK_TTL_DAYS, défaut 7 jours. */
export function defaultTtl() {
  const days = Number(process.env.FILES_LINK_TTL_DAYS);
  return Math.round((Number.isFinite(days) && days > 0 ? days : 7) * DAY);
}
/** Durée minimale (1 minute) et maximale (10 ans : au-delà, lien permanent). */
export const MIN_TTL = 60;
export const MAX_TTL = 3650 * DAY;

const UNITS = { s: 1, m: 60, min: 60, h: 3600, d: DAY, j: DAY, w: 7 * DAY, sem: 7 * DAY, y: 365 * DAY, a: 365 * DAY };

/**
 * Durée en secondes : nombre (secondes) ou texte « 30m », « 12h », « 7d » /
 * « 7j », « 2w », « 1y » / « 1a ». `null` si illisible.
 */
export function parseDuration(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : null;
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*(s|m|min|h|d|j|w|sem|y|a)?\s*$/i.exec(String(value));
  if (!match) return null;
  const amount = Number(match[1].replace(",", "."));
  return Math.round(amount * UNITS[(match[2] ?? "s").toLowerCase()]);
}

/** Nouveau jeton et son empreinte (seule l'empreinte est stockée). */
export function newToken() {
  const token = crypto.randomBytes(24).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/** Jeton bien formé (32 caractères base64url) : évite une requête inutile. */
export function isTokenShape(token) {
  return /^[A-Za-z0-9_-]{32}$/.test(String(token ?? ""));
}

/** Chemin public du lien (à préfixer par l'URL de l'API). */
export function linkPath(token, filename, withName) {
  const suffix = withName && filename ? `/${encodeURIComponent(filename)}` : "";
  return `/files/open/${token}${suffix}`;
}

/** Auteur d'une action, d'après le jeton. */
export function currentUser(req) {
  const data = req?.payload?.data ?? {};
  const USRID = Number(data.id);
  const name = `${data.FirstName ?? ""} ${data.LastName ?? ""}`.trim() || data.CAVENOM || null;
  return { USRID: Number.isInteger(USRID) && USRID > 0 ? USRID : null, NAME: name };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Fournisseur générique : lien vers un FILECODE, gestionnaires seulement. */
const defaultProvider = {
  async authorize(req, input) {
    if (!isManagerPermission(req?.payload?.permission)) {
      throw httpError(403, "Seuls les gestionnaires peuvent créer un lien direct vers ce fichier.");
    }
    if (!input.FILECODE) throw httpError(400, "FILECODE requis.");
    const [attachment] = await services.getFiles({ FILECODE: input.FILECODE });
    if (!attachment || attachment.APPCODE !== req.payload.application) {
      throw httpError(404, "Fichier introuvable.");
    }
    return {
      FILECODE: attachment.FILECODE,
      FILENAME: attachment.ORIGINALNAME,
      POLICY: { ALLOWPERMANENT: true, MAXTTL: null, DEFAULTTTL: defaultTtl() },
    };
  },
  async resolve(link) {
    return link.FILECODE ? { FILECODE: link.FILECODE } : null;
  },
  canManage(req) {
    return isManagerPermission(req?.payload?.permission);
  },
};

/** Fournisseur de l'application `APPCODE` (générique à défaut). */
export async function getProvider(APPCODE) {
  const load = PROVIDERS[String(APPCODE ?? "").toUpperCase()];
  if (!load) return defaultProvider;
  const mod = await load();
  return {
    authorize: mod.authorize ?? defaultProvider.authorize,
    resolve: mod.resolve ?? defaultProvider.resolve,
    canManage: mod.canManage ?? defaultProvider.canManage,
  };
}

/**
 * Durée effective (secondes, `null` = permanent) d'après la demande et la
 * politique de l'application ; lève 400 / 403 si la demande n'est pas
 * permise.
 */
export function effectiveTtl({ PERMANENT, EXPIRESIN }, POLICY) {
  if (PERMANENT) {
    if (!POLICY.ALLOWPERMANENT) throw httpError(403, "Vous ne pouvez pas créer de lien permanent.");
    return null;
  }
  const ttl = EXPIRESIN ?? POLICY.DEFAULTTTL ?? defaultTtl();
  if (ttl < MIN_TTL || ttl > MAX_TTL) {
    throw httpError(400, "Durée invalide : entre 1 minute et 10 ans (au-delà, choisissez un lien permanent).");
  }
  if (POLICY.MAXTTL && ttl > POLICY.MAXTTL) {
    const days = Math.round((POLICY.MAXTTL / DAY) * 10) / 10;
    throw httpError(403, `Durée maximale autorisée pour vous : ${days} jour${days > 1 ? "s" : ""}.`);
  }
  return ttl;
}

/** Ligne FILELINKS pour le client (PARAMS désérialisé, booléens). */
export function formatLink(row) {
  if (!row) return null;
  let PARAMS = null;
  try {
    PARAMS = row.PARAMS ? JSON.parse(row.PARAMS) : null;
  } catch {
    PARAMS = null;
  }
  return {
    LNKID: row.LNKID,
    APPCODE: row.APPCODE,
    FILECODE: row.FILECODE ?? null,
    ENTITYTYPE: row.ENTITYTYPE ?? null,
    ENTITYID: row.ENTITYID ?? null,
    PARAMS,
    FILENAME: row.FILENAME ?? null,
    LABEL: row.LABEL ?? null,
    WITHNAME: !!row.WITHNAME,
    PERMANENT: row.EXPIRESAT == null,
    EXPIRESAT: row.EXPIRESAT ?? null,
    STATUS: row.STATUS,
    CREATEDBY: row.CREATEDBY,
    CREATEDBYNAME: row.CREATEDBYNAME ?? null,
    CREATEDAT: row.CREATEDAT,
    REVOKEDAT: row.REVOKEDAT ?? null,
    REVOKEDBYNAME: row.REVOKEDBYNAME ?? null,
    OPENCOUNT: row.OPENCOUNT ?? 0,
    LASTOPENEDAT: row.LASTOPENEDAT ?? null,
  };
}
