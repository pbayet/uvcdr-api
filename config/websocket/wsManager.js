/**
 * wsManager.js
 *
 * Gestion du serveur WebSocket (client : paquet front @uvcdr/realtime) :
 * - Auth JWT via query param ?token=
 * - Registre des connexions indexé par utilisateur (les caves à part)
 * - broadcast ciblé (broadcastToUsers), par application (broadcastToApps)
 *   ou global (broadcastToAll)
 *
 * Le module ticketing (V1.1.0) n'utilise ici que broadcastToAll, avec des
 * payloads volontairement minimaux (IDs uniquement) plutôt que le contenu
 * complet du ticket : cf. décision produit "temps réel simplifié" — ça évite
 * à la fois le recalcul par destinataire (N+1 identifié dans l'audit 3.4) et
 * une fuite de données à des utilisateurs qui n'ont pas accès au ticket.
 *
 * Routage par application : depuis @uvcdr/realtime, toutes les applications
 * UNIS ouvrent une connexion (y compris declaration-ingredients pour les caves
 * et users-manager). Chaque jeton est propre à une application (champ
 * `application` du JWT, cookie <prefix>-<appcode> côté front), ce qui permet de
 * n'envoyer un évènement qu'aux connexions de l'application concernée,
 * d'après le préfixe de son type (cf. APPS_BY_EVENT_PREFIX).
 *
 * Caves (declaration-ingredients) : leur `data.id` est l'ID de la cave, pas un
 * USRID. Elles sont rangées sous une clé distincte et ne reçoivent que les
 * évènements explicitement routés vers DCLING : jamais ceux des applications
 * internes (tickets, FAQ, fiches…).
 */
import { WebSocketServer } from "ws";
import jwt from "jsonwebtoken";
import { logger } from "../logger.config.js";

/**
 * Préfixe du type d'évènement → codes des applications qui l'écoutent
 * (VITE_APP_CODE des fronts). Un préfixe absent est diffusé à toutes les
 * applications internes. À compléter quand une application écoute un nouveau
 * domaine d'évènements.
 */
export const APPS_BY_EVENT_PREFIX = Object.freeze({
  faq: ["FAQ"],
  ticket: ["TCK"],
  project: ["TCK"],
  vinidoc: ["VINDOC"],
  fsa: ["FSA"],
  declcav: ["DCLING"],
  usersmanager: ["USRMAN"],
});

/** Map<clé utilisateur, Set<WebSocket>> — cf. clientKey */
const clients = new Map();

/** Métadonnées de chaque connexion : { key, USRID, isCave, app } */
const meta = new WeakMap();

/** Clé du registre : les caves ne doivent jamais partager celle d'un USRID. */
const clientKey = (id, isCave) => (isCave ? `cave:${id}` : String(id));

/**
 * Applications destinataires d'un type d'évènement (`faq.post.updated` → FAQ),
 * ou null si le préfixe n'est pas routé.
 */
export function appsForEvent(type) {
  const prefix = String(type ?? "").split(".")[0];
  return APPS_BY_EVENT_PREFIX[prefix] ?? null;
}

/**
 * Lit et vérifie le jeton de la requête de connexion.
 * Renvoie { USRID, isCave, app } ou lève une erreur.
 */
export function authenticate(reqUrl) {
  const url = new URL(reqUrl, "http://localhost");
  const token = url.searchParams.get("token");
  const payload = jwt.verify(token, process.env.JWT_SECRET);

  // Même règle que verifyJWT : un jeton sans permission n'ouvre rien.
  if (payload?.permissionLevel === -1) throw new Error("ACCESS_DENIED");

  const USRID = parseInt(payload?.data?.id, 10);
  if (!USRID) throw new Error("USRID manquant dans le token");

  return {
    USRID,
    isCave: !!payload.isCave,
    app: String(payload.application || "").toUpperCase(),
  };
}

export function initWebSocket(server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    let identity;
    try {
      identity = authenticate(req.url);
    } catch {
      ws.close(1008, "Unauthorized");
      return;
    }

    const key = clientKey(identity.USRID, identity.isCave);
    register(ws, { key, ...identity });

    ws.on("close", () => unregister(ws));

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "ping") _send(ws, { type: "pong" });
      } catch {
        // message non-JSON ignoré
      }
    });

    ws.on("error", (err) => {
      logger.warn(
        `[WS] Erreur socket ${identity.isCave ? "cave" : "USRID"}=${identity.USRID} app=${identity.app || "?"} : ${err.message}`,
      );
    });
  });

  return wss;
}

/** Ajoute une connexion au registre (exporté pour les tests). */
export function register(ws, info) {
  meta.set(ws, info);
  if (!clients.has(info.key)) clients.set(info.key, new Set());
  clients.get(info.key).add(ws);
}

/** Retire une connexion du registre (exporté pour les tests). */
export function unregister(ws) {
  const info = meta.get(ws);
  if (!info) return;
  const sockets = clients.get(info.key);
  if (!sockets) return;
  sockets.delete(ws);
  if (sockets.size === 0) clients.delete(info.key);
}

/** Vide le registre (tests uniquement). */
export function _resetClients() {
  clients.clear();
}

/**
 * La connexion doit-elle recevoir ce message ?
 * - `apps` : applications visées (null = toutes les applications internes) ;
 * - une cave ne reçoit que ce qui vise explicitement DCLING ;
 * - une connexion sans application connue (ancien jeton) reçoit tout ce qui
 *   n'est pas réservé aux caves, comme avant le routage.
 */
function accepts(info, apps) {
  if (!info) return false;
  if (info.isCave) return !!apps?.includes("DCLING");
  if (!apps || !info.app) return true;
  return apps.includes(info.app);
}

function _broadcast(message, filter) {
  const raw = JSON.stringify(message);
  clients.forEach((sockets) => {
    sockets.forEach((ws) => {
      if (ws.readyState === 1 && filter(meta.get(ws))) ws.send(raw);
    });
  });
}

/**
 * Envoie un message aux utilisateurs internes (USRID) donnés, dans toutes
 * leurs applications ouvertes concernées par le type du message.
 */
export function broadcastToUsers(userIds, message) {
  const apps = appsForEvent(message?.type);
  const raw = JSON.stringify(message);
  for (const uid of userIds) {
    clients.get(clientKey(Number(uid), false))?.forEach((ws) => {
      if (ws.readyState === 1 && accepts(meta.get(ws), apps)) ws.send(raw);
    });
  }
}

/** Envoie un message à toutes les connexions des applications données. */
export function broadcastToApps(appCodes, message) {
  const apps = [].concat(appCodes).map((a) => String(a).toUpperCase());
  _broadcast(message, (info) => accepts(info, apps));
}

/**
 * Diffuse un message à toutes les connexions internes de l'application
 * concernée par son type (cf. APPS_BY_EVENT_PREFIX) ; à toutes les
 * applications internes si le préfixe n'est pas routé. Jamais aux caves, même
 * pour un évènement `declcav.*` : elles ne doivent pas voir l'activité des
 * autres caves (cf. broadcastToCaves).
 */
export function broadcastToAll(message) {
  const apps = appsForEvent(message?.type);
  _broadcast(message, (info) => !info?.isCave && accepts(info, apps));
}

/**
 * Envoie un message aux caves données (ID de cave, `data.id` de leur jeton),
 * pour qu'une cave voie en direct ce qui la concerne (son dossier, ses audits).
 */
export function broadcastToCaves(caveIds, message) {
  const raw = JSON.stringify(message);
  for (const id of [].concat(caveIds)) {
    if (id == null || id === "") continue;
    clients.get(clientKey(Number(id), true))?.forEach((ws) => {
      if (ws.readyState === 1) ws.send(raw);
    });
  }
}

function _send(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
}
