import * as services from "./services.js";
import { formatLoad } from "./utils.js";
import { broadcastToAll } from "../../config/websocket/wsManager.js";
import { logger } from "../../config/logger.config.js";

/* ─────────────────────────────────────────────
   DCKMNG — Temps réel
   Deux canaux, alimentés par `publish(LODDAT)` après chaque modification :

   1. SSE (Server-Sent Events) pour l'espace cariste, NON authentifié : le
      WebSocket UNIS (/ws) exige un JWT, que les caristes n'ont pas. Les
      abonnés sont rangés par jour ; à chaque modification, la liste du jour
      est lue UNE fois en base puis poussée à tous les abonnés de ce jour
      (aucun rechargement côté client → pas de rafale de requêtes).

   2. WebSocket UNIS (@uvcdr/realtime) pour l'espace admin : évènement léger
      `dckmng.loads.changed` { LODDAT } (identifiants uniquement, comme les
      autres modules), le front invalide son cache et recharge.

   ⚠️ Registre en mémoire : suppose une seule instance de l'API (mode fork
   PM2), comme config/websocket/wsManager.js.
───────────────────────────────────────────── */

/** Nombre maximal de connexions SSE simultanées (toutes dates confondues). */
const MAX_LISTENERS = Number(process.env.DCKMNG_SSE_MAX_LISTENERS) || 200;
const KEEPALIVE_MS = 25_000;

/** Map<LODDAT, Set<Response>> */
const listeners = new Map();
let listenerCount = 0;

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

setInterval(() => {
  for (const set of listeners.values()) {
    for (const res of set) res.write(": keepalive\n\n");
  }
}, KEEPALIVE_MS).unref();

/**
 * Ouvre un flux SSE sur la liste des chargements d'un jour (aujourd'hui par
 * défaut) : envoie immédiatement la liste, puis à chaque modification.
 */
export async function subscribe(req, res, { LODDAT } = {}) {
  if (listenerCount >= MAX_LISTENERS) throw new Error("DCKMNG_TOO_MANY_LISTENERS");

  const initial = await services.getLoads({ LODDAT });
  const day = initial.LODDAT;

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Désactive la mise en tampon des proxys (nginx / IIS ARR) : sans cela les
  // évènements n'arrivent qu'en fin de réponse.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // Délai de reconnexion conseillé au navigateur (EventSource).
  res.write("retry: 5000\n\n");
  send(res, "loads", {
    LODDAT: day,
    TODAY: initial.TODAY,
    rows: initial.rows.map(formatLoad),
  });

  if (!listeners.has(day)) listeners.set(day, new Set());
  listeners.get(day).add(res);
  listenerCount++;

  req.on("close", () => {
    const set = listeners.get(day);
    if (set?.delete(res)) listenerCount--;
    if (set && set.size === 0) listeners.delete(day);
  });
}

/**
 * Diffuse la nouvelle liste d'un jour aux abonnés SSE et prévient les
 * clients admin (WebSocket). Best-effort : n'échoue jamais l'action
 * de l'utilisateur.
 */
export async function publish(LODDAT) {
  try {
    broadcastToAll({ type: "dckmng.loads.changed", payload: { LODDAT } });

    const set = listeners.get(LODDAT);
    if (!set?.size) return;

    const { rows, TODAY } = await services.getLoads({ LODDAT });
    const data = { LODDAT, TODAY, rows: rows.map(formatLoad) };
    for (const res of set) send(res, "loads", data);
  } catch (err) {
    logger.warn(`[DCKMNG] Diffusion temps réel impossible (${LODDAT}) : ${err.message}`);
  }
}
