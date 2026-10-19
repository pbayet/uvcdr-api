/**
 * wsManager.js
 *
 * Gestion du serveur WebSocket :
 * - Auth JWT via query param ?token=
 * - Registre des connexions indexé par USRID
 * - broadcast ciblé (broadcastToUsers) ou global (broadcastToAll)
 *
 * Le module ticketing (V1.1.0) n'utilise ici que broadcastToAll, avec des
 * payloads volontairement minimaux (IDs uniquement) plutôt que le contenu
 * complet du ticket : cf. décision produit "temps réel simplifié" — ça évite
 * à la fois le recalcul par destinataire (N+1 identifié dans l'audit 3.4) et
 * une fuite de données à des utilisateurs qui n'ont pas accès au ticket.
 * broadcastToUsers reste disponible pour un usage cible futur.
 */
import { WebSocketServer } from "ws";
import jwt from "jsonwebtoken";
import { logger } from "../logger.config.js";

/** Map<USRID, Set<WebSocket>> — une entrée par utilisateur connecté */
const clients = new Map();

export function initWebSocket(server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");

    let USRID;
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      USRID = parseInt(payload?.data?.id, 10);
      if (!USRID) throw new Error("USRID manquant dans le token");
    } catch {
      ws.close(1008, "Unauthorized");
      return;
    }

    if (!clients.has(USRID)) clients.set(USRID, new Set());
    clients.get(USRID).add(ws);

    ws.on("close", () => {
      const sockets = clients.get(USRID);
      if (!sockets) return;
      sockets.delete(ws);
      if (sockets.size === 0) clients.delete(USRID);
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "ping") _send(ws, { type: "pong" });
      } catch {
        // message non-JSON ignoré
      }
    });

    ws.on("error", (err) => {
      logger.warn(`[WS] Erreur socket USRID=${USRID} : ${err.message}`);
    });
  });
}

export function broadcastToUsers(userIds, message) {
  const raw = JSON.stringify(message);
  for (const uid of userIds) {
    clients.get(Number(uid))?.forEach((ws) => {
      if (ws.readyState === 1) ws.send(raw);
    });
  }
}

export function broadcastToAll(message) {
  const raw = JSON.stringify(message);
  clients.forEach((sockets) => {
    sockets.forEach((ws) => {
      if (ws.readyState === 1) ws.send(raw);
    });
  });
}

function _send(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
}
