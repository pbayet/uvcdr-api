import { broadcastToAll } from "../../config/websocket/wsManager.js";
import { logger } from "../../config/logger.config.js";

/**
 * Temps réel du journal d'activité (client @uvcdr/realtime de users-manager,
 * écrans Activité et Statistiques) :
 *   - usersmanager.activity.created { SOURCES }  après chaque insertion dans
 *     USERSACTIVITY (postActivityStats → "ACTIVITY") ou LOGINHISTORY
 *     (postLoginStats → "LOGIN", ou "LOGINDEV" pour une connexion "en tant
 *     que" avec DEVEMAIL).
 *
 * Comme les autres évènements usersmanager.*, le payload ne contient aucune
 * donnée du journal (réservé aux DEV) : seulement les types de lignes
 * ajoutées. Chaque écran recharge ensuite avec ses propres droits.
 *
 * Le journal peut s'écrire à chaque requête : les insertions sont regroupées
 * et diffusées au plus une fois toutes les THROTTLE_MS (la première tout de
 * suite, les suivantes à la fin de la fenêtre).
 */
export const ACTIVITY_CREATED_EVENT = "usersmanager.activity.created";
export const THROTTLE_MS = 2000;

const pendingSources = new Set();
let timer = null;
let lastSentAt = 0;

function flush() {
  timer = null;
  if (pendingSources.size === 0) return;
  const SOURCES = [...pendingSources];
  pendingSources.clear();
  lastSentAt = Date.now();
  try {
    broadcastToAll({ type: ACTIVITY_CREATED_EVENT, payload: { SOURCES } });
  } catch (err) {
    logger.warn(`[WS] ${ACTIVITY_CREATED_EVENT} non diffusé : ${err.message}`);
  }
}

/**
 * Signale une ligne ajoutée au journal. Ne lève jamais (appelé depuis la
 * journalisation, en fire-and-forget).
 * @param {"ACTIVITY"|"LOGIN"|"LOGINDEV"} source
 */
export function notifyActivityLogged(source) {
  if (!source) return;
  pendingSources.add(source);
  if (timer) return;
  const wait = Math.max(0, lastSentAt + THROTTLE_MS - Date.now());
  if (wait === 0) flush();
  else timer = setTimeout(flush, wait);
}

/** Réinitialise l'état (tests uniquement). */
export function _resetActivityRealtime() {
  if (timer) clearTimeout(timer);
  timer = null;
  lastSentAt = 0;
  pendingSources.clear();
}
