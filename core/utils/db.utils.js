// core/utils/db.utils.js
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../../config/logger.config.js";
import sql from "mssql";

import { getDatabases } from "../../config/db/index.js";

// Plus AUCUN PreparedStatement n'est mis en cache ici.
//
// Incident du 12/11/2026 ~14:52 ("TimeoutError: ResourceRequest timed out",
// generic-pool, sur toutes les routes FSA) : chaque PreparedStatement mis en
// cache retenait une connexion DÉDIÉE du pool mssql tant qu'il n'était pas
// unprepare() (node-mssql : PreparedStatement.prepare() → pool.acquire()), et
// les clés "populaires" ne la rendaient plus jamais (TTL désactivé). Avec
// 2 statements par clé et 11 clés rien que dans modules/fsa (dont 7 lancées
// en parallèle par getFsa), les 20 connexions du pool étaient toutes
// retenues : toute nouvelle requête attendait acquireTimeoutMillis puis
// échouait.
//
// Désormais, chaque requête emprunte une connexion et la rend au pool dès
// qu'elle est terminée (pool.request(), ou PreparedStatement éphémère
// prepare → execute → unprepare dans un finally). Le plan d'exécution reste
// réutilisé côté SQL Server : pool.request() avec des paramètres passe par
// sp_executesql, dont les plans sont mis en cache par le moteur.

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

/**
 * Exécute une requête via un PreparedStatement ÉPHÉMÈRE : prepare → execute →
 * unprepare, la connexion dédiée étant TOUJOURS rendue au pool (finally),
 * même si l'exécution échoue.
 */
async function executeEphemeralPreparedStatement(db, query, paramsDef, params) {
  const ps = new sql.PreparedStatement(db);
  for (const [name, type] of Object.entries(paramsDef)) {
    ps.input(name, type);
  }

  await ps.prepare(query);
  try {
    return await ps.execute(params);
  } finally {
    try {
      await ps.unprepare();
    } catch (err) {
      logger.error(
        `[DB] Erreur lors de l'unprepare d'un PreparedStatement éphémère : ${String(err?.message ?? err)}`,
      );
    }
  }
}

/**
 * Conservé pour compatibilité d'API. Ne met plus rien en cache et ne retient
 * plus aucune connexion : chaque `execute()` prépare, exécute puis libère son
 * propre PreparedStatement. `key`, `ttlSeconds` et `destroyImmediately` sont
 * ignorés.
 */
export async function getPreparedStatement(
  db,
  _key,
  query,
  paramsDef = {},
  _ttlSeconds = false,
  _destroyImmediately = false,
) {
  return {
    execute: (params = {}) =>
      executeEphemeralPreparedStatement(db, query, paramsDef, params),
    release: () => {},
  };
}

/** Conservé pour compatibilité (app.js) : il n'y a plus de cache à fermer. */
export async function closePreparedStatement(_key) {
  return false;
}

/** Conservé pour compatibilité (arrêt propre dans app.js) : no-op. */
export async function closeAllPreparedStatements() {}

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
 * Exécute TOUJOURS la requête en empruntant une connexion au pool puis en la
 * rendant dès la fin de la requête (cf. commentaire en tête de fichier sur
 * l'incident du 12/11/2026). Par défaut via `pool.request()` paramétré ; via
 * un PreparedStatement éphémère si `usePreparedStatement: true`.
 *
 * `key`, `ttl` et `destroyImmediately` sont encore acceptés pour ne pas
 * casser les appelants existants, mais n'ont plus d'effet : ils ne font plus
 * basculer vers un PreparedStatement mis en cache.
 *
 * @param {object} options
 * @param {string} options.moduleUrl - `import.meta.url` du fichier appelant
 * @param {string|null} [options.dbConnectionName] - force une connexion explicite
 * @param {string|null} [options.key] - obsolète, ignoré
 * @param {string} options.query - requête SQL
 * @param {Object<string,{type:*, value:*}>} [options.inputs] - paramètres nommés + type mssql
 * @param {boolean|number} [options.ttl] - obsolète, ignoré
 * @param {boolean} [options.destroyImmediately] - obsolète, ignoré
 * @param {boolean} [options.usePreparedStatement=false] - true = PreparedStatement éphémère (libéré après exécution)
 * @param {string|null} [options.errorIfEmpty] - si fourni, lève cette erreur si le recordset est vide
 * @returns {Promise<import("mssql").IResult<any>>}
 */
export async function runQuery({
  moduleUrl,
  dbConnectionName = null,
  query,
  inputs = {},
  usePreparedStatement = false,
  errorIfEmpty = null,
}) {
  const db = getDbConnexion(moduleUrl, dbConnectionName);

  const params = {};
  for (const [name, def] of Object.entries(inputs)) {
    params[name] = def.value === undefined ? null : def.value;
  }

  let result;

  if (usePreparedStatement === true) {
    const paramsDef = {};
    for (const [name, def] of Object.entries(inputs)) {
      paramsDef[name] = def.type;
    }
    result = await executeEphemeralPreparedStatement(
      db,
      query,
      paramsDef,
      params,
    );
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
