import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import * as services from "./services.js";
import { isManagerPermission } from "./utils.js";
import { logger } from "../../config/logger.config.js";

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
   - révocable un par un (DELETE /api/files/links/:lnkid), validité
     modifiable (PUT /api/files/links/:lnkid : prolonger, réactiver un lien
     expiré, rendre permanent) ;
   - mouvements consultables (GET /api/files/links/events).

   Qui peut créer quel lien, et vers quoi : c'est l'application du jeton
   (APPCODE) qui le décide, via un « fournisseur » (cf. PROVIDERS) :

     authorize(req, input) → {
       FILECODE? | ENTITYTYPE + ENTITYID + PARAMS?,   // cible
       FILENAME, LABEL?,                              // nom (URL), libellé (liste)
       POLICY: { ALLOWPERMANENT, MAXTTL, DEFAULTTTL } // en secondes ; MAXTTL null = sans limite
     }
     resolve(link, { method }) → { FILECODE, FILENAME?, onOpen? } | null
       appelé à CHAQUE ouverture : null = cible plus disponible ;
       onOpen({ disposition, opener }) : traçabilité propre à l'application
       (jamais appelé pour une requête HEAD) ; `opener` = { USRID, USRNAME }
       si le navigateur a envoyé un jeton UNIS valide (cf. identifyOpener),
       null sinon.
     canManage(req) → bool : voir, modifier et révoquer tous les liens de
       l'application, et voir l'IP / le navigateur des ouvertures.
     policy(req) → POLICY : validité qu'un utilisateur peut donner à un lien
       existant (PUT /api/files/links/:lnkid).

   Chaque mouvement (création, modification, désactivation, ouverture,
   téléchargement, refus) est journalisé dans FILELINKEVENTS.

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

/**
 * Clé de chiffrement des jetons (AES-256) : FILES_LINK_SECRET, à défaut
 * dérivée de JWT_SECRET. Une clé dédiée : un jeton chiffré ne sert à rien
 * d'autre. `null` si aucun secret n'est configuré.
 */
function tokenKey() {
  const secret = process.env.FILES_LINK_SECRET || process.env.JWT_SECRET;
  if (!secret) return null;
  return crypto.createHash("sha256").update(`files:link-token:v1:${secret}`).digest();
}

/**
 * Jeton chiffré pour la base (AES-256-GCM) : `v1.<iv>.<tag>.<chiffré>` en
 * base64url (≤ 100 caractères). `null` sans clé : le lien fonctionne, mais
 * ne pourra pas être recopié depuis la liste.
 */
export function encryptToken(token) {
  const key = tokenKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(String(token), "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/** Jeton en clair, ou `null` (absent, clé changée, valeur altérée). */
export function decryptToken(value) {
  const key = tokenKey();
  const [version, iv, tag, data] = String(value ?? "").split(".");
  if (!key || version !== "v1" || !iv || !tag || !data) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
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
  /** Validité qu'un utilisateur peut donner à un lien existant (modification). */
  policy(req) {
    return isManagerPermission(req?.payload?.permission)
      ? { ALLOWPERMANENT: true, MAXTTL: null, DEFAULTTTL: defaultTtl() }
      : { ALLOWPERMANENT: false, MAXTTL: defaultTtl(), DEFAULTTTL: defaultTtl() };
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
    policy: mod.policy ?? defaultProvider.policy,
  };
}

/** Validité lisible pour le journal : « permanent », « 7 jours », « 12 heures »… */
export function describeTtl(ttl) {
  if (ttl === null || ttl === undefined) return "permanent";
  const units = [
    [365 * DAY, "an", "ans"],
    [DAY, "jour", "jours"],
    [3600, "heure", "heures"],
    [60, "minute", "minutes"],
  ];
  for (const [size, one, many] of units) {
    if (ttl >= size && ttl % size === 0) {
      const n = ttl / size;
      return `${n} ${n > 1 ? many : one}`;
    }
  }
  return `${ttl} secondes`;
}

/** Origine d'une ouverture : IP (premier relais X-Forwarded-For) et navigateur. */
export function requestClient(req) {
  const peer = normalizeIp(req?.socket?.remoteAddress ?? req?.ip);
  // Les en-têtes de relais ne sont crus que s'ils viennent du proxy local /
  // interne (IIS, Apache…) : un client direct pourrait les falsifier.
  const viaProxy = !peer || isLoopbackIp(peer) || isPrivateIp(peer);
  const relayed = viaProxy ? forwardedIp(req?.headers ?? {}) : null;
  const ip = relayed ?? peer;
  if (viaProxy && !relayed && isLoopbackIp(ip)) logMissingClientIp(req);
  return {
    // Une IP de bouclage (::1, 127.0.0.1) est celle du proxy, pas du client.
    IP: ip && !isLoopbackIp(ip) ? ip : null,
    USERAGENT: req?.headers?.["user-agent"] ?? null,
  };
}

/** « ::ffff:10.1.2.3 » → « 10.1.2.3 » ; « 10.1.2.3:51234 » (IIS ARR) → « 10.1.2.3 » ; « [::1]:80 » → « ::1 ». */
export function normalizeIp(value) {
  let ip = String(value ?? "").trim().replace(/^"|"$/g, "");
  if (!ip || ip.toLowerCase() === "unknown") return null;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, "");
  ip = ip.replace(/^::ffff:(?=\d{1,3}(\.\d{1,3}){3}$)/i, "");
  return ip || null;
}

export const isLoopbackIp = (ip) => ip === "::1" || /^127\./.test(String(ip ?? ""));

export const isPrivateIp = (ip) =>
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(String(ip ?? "")) ||
  /^f[cd][0-9a-f]{2}:/i.test(String(ip ?? ""));

/**
 * IP du client transmise par le proxy : `X-Forwarded-For` (premier relais),
 * `Forwarded: for=…` (RFC 7239), `X-Real-IP`, `X-Client-IP`,
 * `CF-Connecting-IP`.
 */
function forwardedIp(headers) {
  const xff = String(headers["x-forwarded-for"] ?? "").split(",")[0];
  const rfc = /for=("?\[?[^;,"\]]+\]?(?::\d+)?"?)/i.exec(String(headers.forwarded ?? ""))?.[1];
  for (const candidate of [xff, rfc, headers["x-real-ip"], headers["x-client-ip"], headers["cf-connecting-ip"]]) {
    const ip = normalizeIp(candidate);
    if (ip) return ip;
  }
  return null;
}

let missingIpLogged = false;
/** Une seule alerte par process : le proxy ne transmet pas l'IP du client. */
function logMissingClientIp(req) {
  if (missingIpLogged) return;
  missingIpLogged = true;
  const relayHeaders = Object.keys(req?.headers ?? {}).filter((h) => /forward|real-ip|client-ip|arr/i.test(h));
  logger.warn(
    `[FILES][LINK] IP du client inconnue : la requête vient du proxy local sans X-Forwarded-For ` +
      `(en-têtes de relais reçus : ${relayHeaders.join(", ") || "aucun"}). ` +
      `Activer la transmission de l'IP sur le serveur web (IIS ARR : « Preserve client IP in X-Forwarded-For »).`,
  );
}

/** Préfixe des cookies de session des fronts UNIS (`uvcdr-apps-jwt-<APPCODE>`). */
export const SESSION_COOKIE_PREFIX = "uvcdr-apps-jwt-";

/** Cookies de la requête (en-tête `Cookie`, sans dépendance à cookie-parser). */
function parseCookies(header) {
  const cookies = [];
  for (const part of String(header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
    try {
      value = decodeURIComponent(value);
    } catch {
      /* valeur laissée telle quelle */
    }
    cookies.push({ name, value });
  }
  return cookies;
}

/**
 * Personne qui ouvre un lien direct, d'après les jetons UNIS qu'envoie son
 * navigateur (cookies `uvcdr-apps-jwt-*` posés par les fronts sur le même
 * domaine, ou en-tête Authorization si présent). Sert UNIQUEMENT à
 * l'attribution dans le journal : l'ouverture reste publique.
 *
 * - signature vérifiée (JWT_SECRET) : un cookie forgé n'identifie personne ;
 * - un jeton expiré est accepté (il prouve toujours qui est l'utilisateur),
 *   mais un jeton valide passe avant ; puis celui de l'application du lien,
 *   puis le plus récent ;
 * - caves (DCLING) : leur id n'est pas un USRID → USRID null, nom seul ;
 * - impersonation (`devToken === "true"`) : compte simulé, dev en clair.
 *
 * @returns {{ USRID: number|null, USRNAME: string|null } | null}
 */
export function identifyOpener(req, APPCODE) {
  const candidates = parseCookies(req?.headers?.cookie)
    .filter((c) => c.name.startsWith(SESSION_COOKIE_PREFIX) && c.value)
    .map((c) => c.value);
  const auth = String(req?.headers?.authorization ?? "");
  if (auth.startsWith("Bearer ")) candidates.unshift(auth.slice(7).trim());
  if (!candidates.length || !process.env.JWT_SECRET) return null;

  const now = Math.floor(Date.now() / 1000);
  const app = String(APPCODE ?? "").toUpperCase();
  const payloads = [];
  for (const token of new Set(candidates)) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
      if (payload?.data && payload.permissionLevel !== -1) payloads.push(payload);
    } catch {
      /* jeton invalide ou forgé : ignoré */
    }
  }
  if (!payloads.length) return null;

  const score = (p) =>
    (!p.exp || p.exp > now ? 4 : 0) + (String(p.application ?? "").toUpperCase() === app ? 2 : 0);
  payloads.sort((a, b) => score(b) - score(a) || (b.iat ?? 0) - (a.iat ?? 0));
  const { data, isCave, devToken, devEmail } = payloads[0];

  const id = Number(data.id);
  const USRID = !isCave && Number.isInteger(id) && id > 0 ? id : null;
  let name = `${data.FirstName ?? ""} ${data.LastName ?? ""}`.trim() || data.email || null;
  if (devToken === "true" && devEmail && name) name = `${name} (simulé par ${devEmail})`;
  if (!USRID && !name) return null;
  return { USRID, USRNAME: name ? name.slice(0, 200) : null };
}

/**
 * Mouvement pour le client. IP et navigateur des ouvertures : gestionnaires
 * seulement (`withClient`).
 */
/**
 * Mouvement tel que renvoyé par l'API : navigateur (`USERAGENT`) si
 * `withClient`, IP si `withIp` (administrateurs seulement).
 */
export function formatLinkEvent(row, { withClient = false, withIp = false } = {}) {
  let PARAMS = null;
  try {
    PARAMS = row.PARAMS ? JSON.parse(row.PARAMS) : null;
  } catch {
    PARAMS = null;
  }
  return {
    EVTID: row.EVTID,
    LNKID: row.LNKID,
    EVENT: row.EVENT,
    USRID: row.USRID ?? null,
    USRNAME: row.USRNAME ?? null,
    DETAIL: row.DETAIL ?? null,
    CREATEDAT: row.CREATEDAT,
    LINK: { PARAMS, FILENAME: row.FILENAME ?? null, CREATEDBY: row.CREATEDBY, CREATEDBYNAME: row.CREATEDBYNAME ?? null },
    ...(withClient ? { USERAGENT: row.USERAGENT ?? null } : {}),
    ...(withIp ? { IP: row.IP ?? null } : {}),
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

/**
 * Ligne FILELINKS pour le client (PARAMS désérialisé, booléens). `withPath` :
 * ajoute `PATH`, le chemin du lien à recopier ou ouvrir (auteur du lien et
 * gestionnaires seulement ; `null` pour un lien créé avant le stockage du
 * jeton chiffré, ou si la clé a changé). Le jeton chiffré n'est jamais
 * renvoyé.
 */
export function formatLink(row, { withPath = false } = {}) {
  if (!row) return null;
  const token = withPath ? decryptToken(row.TOKENENC) : null;
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
    ...(withPath ? { PATH: token ? linkPath(token, row.FILENAME, !!row.WITHNAME) : null } : {}),
  };
}
