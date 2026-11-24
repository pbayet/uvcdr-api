import crypto from "node:crypto";
import * as utils from "./utils.js";

/* ─────────────────────────────────────────────
   PROCS — Liens directs signés vers un document
   Le fichier d'une procédure est normalement servi avec le jeton dans
   l'en-tête (GET /versions/:verid/file). Pour qu'un lien collé dans un
   navigateur, un mail ou Teams ouvre le fichier sans passer par
   l'application, l'API signe (HMAC-SHA256) un lien temporaire :

     /procs/files/<charge utile>.<signature>

   Charge utile (base64url) : PRCID.VERNUM.KIND.USRID.EXPIRATION
     - VERNUM 0 = version en vigueur au moment de l'ouverture ;
     - KIND 0 = document d'origine, 1 = aperçu PDF ;
     - USRID = auteur du lien (les consultations lui sont rattachées) ;
     - EXPIRATION en secondes depuis l'epoch.

   Clé : PROCS_LINK_SECRET, à défaut dérivée de JWT_SECRET. Changer la clé
   invalide tous les liens déjà distribués.
───────────────────────────────────────────── */

const DEFAULT_TTL_DAYS = 7;

/** Durée de validité d'un lien (jours) : PROCS_LINK_TTL_DAYS, défaut 7. */
export function linkTtlDays() {
  const days = Number(process.env.PROCS_LINK_TTL_DAYS);
  return Number.isFinite(days) && days > 0 ? days : DEFAULT_TTL_DAYS;
}

function signingKey() {
  const secret = process.env.PROCS_LINK_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error("PROCS_LINK_SECRET / JWT_SECRET non configuré.");
  // Clé dédiée : un lien de fichier ne peut pas servir à forger autre chose.
  return crypto.createHmac("sha256", secret).update("procs:file-link:v1").digest();
}

function sign(payload) {
  return crypto.createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

/**
 * Signe un lien vers le document d'une procédure.
 * @returns {{ TOKEN: string, EXPIRES: Date }}
 */
export function signFileLink({ PRCID, VERNUM, KIND, USRID }, now = Date.now()) {
  const exp = Math.floor(now / 1000) + Math.round(linkTtlDays() * 86400);
  const payload = Buffer.from(
    [PRCID, VERNUM || 0, KIND === "preview" ? 1 : 0, USRID, exp].join("."),
  ).toString("base64url");
  return { TOKEN: `${payload}.${sign(payload)}`, EXPIRES: new Date(exp * 1000) };
}

const INVALID = "Lien invalide : copiez-le à nouveau depuis l'application Procédures.";

/**
 * Vérifie un lien signé. Lève une erreur HTTP 404 (lien altéré) ou 410
 * (lien expiré).
 * @returns {{ PRCID: number, VERNUM: number|null, KIND: "original"|"preview", USRID: number }}
 */
export function verifyFileLink(token, now = Date.now()) {
  const [payload, signature, extra] = String(token ?? "").split(".");
  if (!payload || !signature || extra !== undefined) throw utils.httpError(404, INVALID);

  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw utils.httpError(404, INVALID);
  }

  const parts = Buffer.from(payload, "base64url").toString("utf8").split(".").map(Number);
  const [PRCID, VERNUM, KIND, USRID, exp] = parts;
  if (parts.length !== 5 || !parts.every(Number.isInteger) || PRCID <= 0 || USRID <= 0) {
    throw utils.httpError(404, INVALID);
  }
  if (exp * 1000 <= now) {
    throw utils.httpError(
      410,
      "Ce lien a expiré : ouvrez la procédure dans l'application Procédures ou demandez un nouveau lien.",
    );
  }
  return { PRCID, VERNUM: VERNUM || null, KIND: KIND === 1 ? "preview" : "original", USRID };
}
