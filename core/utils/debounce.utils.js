import { logger } from "../../config/logger.config.js";

/**
 * Regroupement "debounce" d'événements par clé, avec traitement différé après
 * une période de silence (delayMs), plafonné par une latence maximale depuis
 * le premier événement du lot (maxWaitMs) pour garantir un traitement même si
 * les événements s'enchaînent sans interruption.
 *
 * Cas d'usage (cf. besoin métier ticketing) : notifications mail sur des
 * actions rapprochées dans le temps — plusieurs changements de statut d'un
 * même ticket en quelques secondes, ou plusieurs notes ajoutées coup sur
 * coup — pour lesquelles on veut un seul email récapitulatif après
 * stabilisation plutôt qu'un email par événement.
 *
 * Volontairement en mémoire (comme le cache de PreparedStatements de
 * core/utils/db.utils.js) : un redémarrage du process perd les lots en
 * attente, ce qui est acceptable ici (au pire, un email de moins est
 * envoyé) — pas besoin d'une file persistante pour ce besoin.
 *
 * @param {string} key - identifiant du lot (ex: `ticket-status:42`)
 * @param {*} item - élément ajouté au lot, transmis tel quel à `onFlush`
 * @param {object} options
 * @param {number} [options.delayMs=120000] - silence requis avant traitement (défaut 2 min)
 * @param {number} [options.maxWaitMs=900000] - latence max depuis le 1er événement (défaut 15 min)
 * @param {(items: any[]) => (Promise<void>|void)} options.onFlush - appelé une seule fois,
 *   avec tous les éléments accumulés, quand le lot est prêt. Fixé par le 1er
 *   appel pour une clé donnée ; les appels suivants sur la même clé n'ont pas
 *   besoin de le refournir (ignoré s'ils le font).
 */
const buckets = new Map();

export function debounceCollect(key, item, { delayMs = 120000, maxWaitMs = 900000, onFlush } = {}) {
  let bucket = buckets.get(key);

  if (!bucket) {
    if (typeof onFlush !== "function") {
      throw new Error("debounceCollect: onFlush est obligatoire à la création du lot.");
    }
    bucket = { items: [], timer: null, firstAt: Date.now(), onFlush };
    buckets.set(key, bucket);
  }

  bucket.items.push(item);

  if (bucket.timer) clearTimeout(bucket.timer);

  const elapsed = Date.now() - bucket.firstAt;
  const wait = Math.min(delayMs, Math.max(0, maxWaitMs - elapsed));

  bucket.timer = setTimeout(() => flush(key), wait);
}

async function flush(key) {
  const bucket = buckets.get(key);
  if (!bucket) return;

  buckets.delete(key);
  if (bucket.timer) clearTimeout(bucket.timer);

  try {
    await bucket.onFlush(bucket.items);
  } catch (err) {
    logger.error(`[debounce] Erreur lors du traitement du lot "${key}" : ${err.message}`);
  }
}

/**
 * Force le traitement immédiat de tous les lots en attente (arrêt propre du
 * serveur, tests). Sans effet si aucun lot n'est en attente.
 */
export async function flushAllDebounced() {
  await Promise.all([...buckets.keys()].map((key) => flush(key)));
}
