// core/utils/db.utils.js
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../../config/logger.config.js";
import sql from "mssql";

import { getDatabases } from "../../config/db/index.js";

/**
 * Suivi des fréquences d'utilisation
 * - Map<key, { count, lastUsed, history: number[] }>
 */
const usageStats = new Map();

const USAGE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
const POPULARITY_THRESHOLD = 5;
const INACTIVITY_LIMIT_MS = 10 * 60 * 1000; // 10 minutes sans appel => non populaire

const psCache = new Map();
const ttlTimers = new Map();
// Nombre max de PreparedStatements simultanés par clé. Chacun retient une
// connexion DÉDIÉE du pool mssql tant qu'il n'est pas unprepare() (cf.
// node-mssql, PreparedStatement.prepare() → pool.acquire()) — et les clés
// "populaires" (cf. isPopular()) ne libèrent plus jamais la leur.
//
// Correctif structurel (incident tarn "operation timed out for an unknown
// reason" sur /api/fsa) : runQuery() n'utilise plus de PreparedStatement par
// défaut — voir `wantsPreparedStatement` plus bas. Ce mécanisme de cache par
// PreparedStatement n'est donc plus emprunté que par les appelants qui le
// demandent explicitement (via `usePreparedStatement: true`, ou en passant
// `key`/`ttl`/`destroyImmediately`). POOL_SIZE=2 (réduit de 5, mitigation
// temporaire précédente) reste un filet de sécurité pour ces cas restants.
const POOL_SIZE = 2;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min par défaut si ttlSeconds = true

// Délai max d'attente d'un slot libre dans le pool interne de
// PreparedStatement (cf. audit perf — la boucle de poll attendait
// auparavant indéfiniment). Aligné sur acquireTimeoutMillis du pool mssql
// (config/db/index.js) : passé ce délai, on échoue explicitement (DB_POOL_ERROR)
// plutôt que de faire attendre la requête sans limite en cas de pic de charge.
const STATEMENT_ACQUIRE_TIMEOUT_MS = 10000;

/**
 * Génère une clé stable de type "ticketing.getTickets"
 * @param {Error} error - new Error() créé dans la fonction appelante
 */
export function generateAutoKey(error, supplement = null) {
  try {
    const stack = error?.stack?.split("\n") || [];

    // Trouve la première ligne hors de ce fichier utilitaire
    const line = stack.find(
      (l) => l.includes(".js:") && !/db\.utils\.js/.test(l),
    );
    if (!line) return `unknown.${Date.now()}`;

    const pathMatch = line.match(/\((.*?):\d+:\d+\)/);
    const filePath = pathMatch ? pathMatch[1] : "";
    const dirName = filePath
      ? path.basename(path.dirname(filePath))
      : "unknown";

    const funcMatch = line.match(/at\s+(?:[\w$.<>]*\.)?([\w$<>]+)/);
    let funcName = funcMatch ? funcMatch[1] : "anonymous";

    if (
      funcName === "Module" ||
      funcName === "Object" ||
      funcName === "anonymous"
    ) {
      funcName = "unknown";
    }

    return supplement
      ? `${supplement}.${dirName}.${funcName}`
      : `${dirName}.${funcName}`;
  } catch {
    return `unknown.${Date.now()}`;
  }
}

function cleanupUsageStats() {
  const now = Date.now();

  for (const [key, stat] of usageStats.entries()) {
    stat.history = stat.history.filter((t) => now - t < USAGE_WINDOW_MS);

    const inactive = now - (stat.lastUsed || 0) > INACTIVITY_LIMIT_MS;

    const wasPopular = stat.popular;
    stat.popular = stat.history.length >= POPULARITY_THRESHOLD && !inactive;

    if (
      wasPopular &&
      !stat.popular &&
      psCache.has(key) &&
      !ttlTimers.has(key)
    ) {
      logger.warn(`[CACHE] Requête ${key} n'est plus populaire — TTL réactivé`);
      ttlTimers.set(
        key,
        setTimeout(() => closePreparedStatement(key), DEFAULT_TTL_MS),
      );
    }

    if (inactive && stat.history.length === 0 && !psCache.has(key)) {
      usageStats.delete(key);
    }
  }
}

function registerUsage(key) {
  const now = Date.now();
  let stat = usageStats.get(key);
  if (!stat) {
    stat = { history: [], lastUsed: now, popular: false };
    usageStats.set(key, stat);
  }
  stat.history.push(now);
  stat.lastUsed = now;
}

function isPopular(key) {
  const stat = usageStats.get(key);
  if (!stat) return false;

  const now = Date.now();
  stat.history = stat.history.filter((t) => now - t < USAGE_WINDOW_MS);

  return stat.history.length >= POPULARITY_THRESHOLD;
}

/**
 * Récupère un PreparedStatement existant ou le crée si nécessaire.
 * Supporte un pool interne de plusieurs statements pour gérer la concurrence,
 * et un TTL automatique pour libérer les statements après inactivité.
 */
export async function getPreparedStatement(
  db,
  key,
  query,
  paramsDef = {},
  ttlSeconds = false,
  destroyImmediately = false,
) {
  if (destroyImmediately) {
    await closePreparedStatement(key);
    psCache.delete(key);
    ttlTimers.delete(key);
    logger.warn(`[CACHE] Recréation forcée du statement pour la clé "${key}"`);
  }

  if (!psCache.has(key)) {
    psCache.set(key, { pool: [], busy: new Set() });
  }
  const entry = psCache.get(key);

  const popular = isPopular(key);

  if (!destroyImmediately) {
    if (ttlSeconds && !popular) {
      const ttlMs =
        typeof ttlSeconds === "number" ? ttlSeconds * 1000 : DEFAULT_TTL_MS;
      if (ttlTimers.has(key)) clearTimeout(ttlTimers.get(key));
      ttlTimers.set(
        key,
        setTimeout(() => closePreparedStatement(key), ttlMs),
      );
    } else if (popular && ttlTimers.has(key)) {
      clearTimeout(ttlTimers.get(key));
      ttlTimers.delete(key);
      logger.warn(`[CACHE] Requête ${key} devenue populaire — TTL désactivé`);
    }
  }

  let ps = entry.pool.find((p) => !entry.busy.has(p));

  if ((!ps && entry.pool.length < POOL_SIZE) || destroyImmediately) {
    ps = new sql.PreparedStatement(db);
    for (const [name, type] of Object.entries(paramsDef)) {
      ps.input(name, type);
    }

    await ps.prepare(query);

    if (destroyImmediately) {
      entry.pool = [ps];
    } else if (!entry.pool.includes(ps)) {
      entry.pool.push(ps);
    }
  }

  const acquireStartedAt = Date.now();

  while (!ps || entry.busy.has(ps)) {
    if (Date.now() - acquireStartedAt > STATEMENT_ACQUIRE_TIMEOUT_MS) {
      logger.error(
        `[CACHE] Délai d'attente dépassé (${STATEMENT_ACQUIRE_TIMEOUT_MS}ms) pour obtenir un PreparedStatement libre sur la clé "${key}" (pool saturé à ${entry.pool.length}/${POOL_SIZE}).`,
      );
      throw new Error("DB_POOL_ERROR");
    }
    await new Promise((r) => setTimeout(r, 5));
    ps = entry.pool.find((p) => !entry.busy.has(p));
  }

  entry.busy.add(ps);

  const execute = async (params) => {
    try {
      registerUsage(key);
      return await ps.execute(params);
    } catch (err) {
      if (err.message.includes("Can't acquire connection")) {
        await ps.unprepare().catch(() => {});
        entry.pool.splice(entry.pool.indexOf(ps), 1);
      }
      throw err;
    } finally {
      entry.busy.delete(ps);
    }
  };

  const release = () => entry.busy.delete(ps);

  return { execute, release };
}

export async function closePreparedStatement(key) {
  const entry = psCache.get(key);
  if (!entry) return false;

  while (entry.busy.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  try {
    for (const ps of entry.pool) {
      try {
        await ps.unprepare();
      } catch (err) {
        logger.error(
          `[CACHE] Erreur lors de l'unprepare de "${key}" : ${String(err?.message ?? err)}`,
        );
      }
    }
  } finally {
    psCache.delete(key);
    if (ttlTimers.has(key)) {
      clearTimeout(ttlTimers.get(key));
      ttlTimers.delete(key);
    }
    logger.warn(`[CACHE] PreparedStatement ${key} libéré.`);
  }
  return true;
}

export async function closeAllPreparedStatements() {
  for (const [key] of psCache.entries()) {
    await closePreparedStatement(key);
  }
  psCache.clear();
}

/**
 * Récupère dynamiquement la connexion BDD correspondant au module appelant.
 * Déduit le nom du module depuis le dossier parent du fichier appelant
 * (ex: modules/ticketing/services.js → "ticketing"), sauf si un nom explicite
 * est fourni.
 */
export function getDbConnexion(moduleUrl, dbConnectionName = null) {
  const databases = getDatabases();

  let moduleName;

  if (dbConnectionName) {
    moduleName = dbConnectionName;
  } else {
    const __filename = fileURLToPath(moduleUrl);
    const __dirname = path.dirname(__filename);
    moduleName = path.basename(__dirname);
  }

  const db = databases[moduleName];

  if (!db) {
    throw new Error("DB_NOT_FOUND");
  }

  return db;
}

/**
 * Helper haut niveau qui remplace le motif répété ~127 fois dans l'ancienne
 * base de code (cf. audit — dette technique 4.2) :
 *   getDbConnexion → generateAutoKey → getPreparedStatement → execute → check vide
 *
 * Par défaut, exécute la requête via un `pool.request()` mssql classique :
 * la connexion est acquise puis rendue au pool à chaque appel, sans jamais
 * en retenir une de façon permanente (cf. incident tarn "operation timed
 * out for an unknown reason" sur /api/fsa — causé par des PreparedStatement
 * mis en cache qui ne rendaient plus jamais leur connexion dédiée une fois
 * "populaires").
 *
 * Le cache par PreparedStatement (plus rapide sur des requêtes rejouées très
 * fréquemment, au prix d'une connexion dédiée tant qu'il n'est pas fermé)
 * reste disponible en opt-in — explicitement via `usePreparedStatement: true`,
 * ou implicitement dès que `key`, `ttl` ou `destroyImmediately` est fourni
 * (signe qu'un appelant existant en dépend déjà). Ne l'activer que pour des
 * requêtes dont le volume d'appels justifie réellement le gain, et dont le
 * nombre de clés simultanées reste maîtrisé (cf. POOL_SIZE plus haut).
 *
 * @param {object} options
 * @param {string} options.moduleUrl - `import.meta.url` du fichier appelant
 * @param {string|null} [options.dbConnectionName] - force une connexion explicite
 * @param {string|null} [options.key] - clé de cache explicite (sinon auto-générée) ; sa présence active le mode PreparedStatement
 * @param {string} options.query - requête SQL
 * @param {Object<string,{type:*, value:*}>} [options.inputs] - paramètres nommés + type mssql
 * @param {boolean|number} [options.ttl=true] - TTL du prepared statement (secondes ou true = 5min) ; ignoré hors mode PreparedStatement
 * @param {boolean} [options.destroyImmediately=false] - force la recréation du prepared statement ; ignoré hors mode PreparedStatement
 * @param {boolean|null} [options.usePreparedStatement=null] - force explicitement le mode (true = PreparedStatement mis en cache, false = requête simple). Par défaut (null), auto-détecté depuis `key`/`ttl`/`destroyImmediately`.
 * @param {string|null} [options.errorIfEmpty] - si fourni, lève cette erreur si le recordset est vide
 * @returns {Promise<import("mssql").IResult<any>>}
 */
export async function runQuery({
  moduleUrl,
  dbConnectionName = null,
  key = null,
  query,
  inputs = {},
  ttl = true,
  destroyImmediately = false,
  usePreparedStatement = null,
  errorIfEmpty = null,
}) {
  const db = getDbConnexion(moduleUrl, dbConnectionName);

  // Auto-détection : un appelant qui fournit explicitement `key`, `ttl` ou
  // `destroyImmediately` compte déjà sur le comportement de cache du
  // PreparedStatement — on préserve ce comportement sans rien lui demander
  // de changer. Tous les autres appels (l'immense majorité) passent par un
  // `pool.request()` simple, qui ne retient jamais de connexion.
  const wantsPreparedStatement =
    usePreparedStatement ??
    (key !== null || ttl !== true || destroyImmediately !== false);

  const params = {};
  for (const [name, def] of Object.entries(inputs)) {
    params[name] = def.value === undefined ? null : def.value;
  }

  let result;

  if (wantsPreparedStatement) {
    const autoKey = key || generateAutoKey(new Error());
    const paramsDef = {};
    for (const [name, def] of Object.entries(inputs)) {
      paramsDef[name] = def.type;
    }

    const ps = await getPreparedStatement(
      db,
      autoKey,
      query,
      paramsDef,
      ttl,
      destroyImmediately,
    );
    result = await ps.execute(params);
  } else {
    const request = db.request();
    for (const [name, def] of Object.entries(inputs)) {
      request.input(name, def.type, params[name]);
    }
    result = await request.query(query);
  }

  if (errorIfEmpty && !result?.recordset?.length) {
    throw new Error(errorIfEmpty);
  }

  return result;
}

// Lance un nettoyage périodique des stats d'usage
setInterval(cleanupUsageStats, INACTIVITY_LIMIT_MS).unref();
