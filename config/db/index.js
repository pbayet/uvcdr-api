import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import sql from "mssql";

import { logger } from "../logger.config.js";
import { banner, colorize, formatLog } from "../../core/utils/logs.utils.js";

// Tag coloré commun à tous les logs d'initialisation DB : permet de les
// repérer d'un coup d'œil au milieu du reste des logs de démarrage (LDAP,
// chargement des routes, etc.), qui n'utilisent pas ce code couleur.
const DB_TAG = colorize("[DB]", "cyan");

sql.on("error", (err) => {
  logger.error(`[SQL GLOBAL ERROR] ${err.message}`);
});

// Pool réduit par rapport à V1.0.0 (max: 30 par module → max: 20 par pool
// physique), maintenant que les pools sont mutualisés par (host + base)
// plutôt que dupliqués par module (cf. audit perf 3.1).
//
// Remonté de 10 → 20 (mitigation, cf. incident "operation timed out for an
// unknown reason" / tarn PendingOperation sur /api/fsa) : chaque
// PreparedStatement mis en cache par core/utils/db.utils.js retient une
// connexion DÉDIÉE du pool tant qu'il n'est pas unprepare() — et les clés
// "populaires" ne libèrent plus jamais la leur (TTL désactivé). Avec
// POOL_SIZE (db.utils.js) réduit à 2, il faut désormais >10 clés simultanément
// populaires pour saturer le pool, contre 2-3 auparavant. Le vrai correctif
// (arrêter d'utiliser des PreparedStatement dédiés pour du caching) est
// proposé séparément — cette valeur n'est qu'un filet de sécurité.
sql.config = {
  options: { encrypt: false, requestTimeout: 15000 },
  pool: {
    max: 20,
    min: 1,
    idleTimeoutMillis: 30000,
    acquireTimeoutMillis: 10000,
  },
};

/** { [dbLabel]: pool } — vue logique par module (ex: "ticketing") */
const databases = {};

/** { [host|database|user]: pool } — pools physiques mutualisés */
const physicalPools = new Map();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_RETRIES = 20;
const RETRY_DELAY_MS = 5000;
const dbRetryCounters = {};

function poolKey(cfg) {
  return `${cfg.server}|${cfg.database}|${cfg.user}`;
}

async function getOrCreatePool(cfg, dbLabel) {
  const key = poolKey(cfg);

  if (physicalPools.has(key)) {
    logger.info(
      `${DB_TAG} ${colorize("↺", "cyan")} ${colorize(dbLabel, "bold")} — pool physique mutualisé réutilisé (${cfg.server} / ${cfg.database})`,
    );
    return physicalPools.get(key);
  }

  // ⚠️ Ne PAS faire `{ ...cfg, ...sql.config }` : le spread ne fait qu'une
  // copie superficielle, donc `options`/`pool` restent la MÊME référence
  // d'objet que `sql.config.options`/`sql.config.pool`, partagée par TOUS
  // les pools. Or mssql/tedious mute cet objet en place quand `server`
  // contient un nom d'instance ("HOST\INSTANCE") : il fait
  // `this.config.options.instanceName = <instance>` (cf.
  // node_modules/mssql/lib/base/connection-pool.js ~L75-78). Sans ce clone,
  // la première connexion à une instance nommée (ex: x3v12 → "BACKOFFICEX3\
  // X3V12") pollue définitivement l'objet global `sql.config.options`, et
  // TOUTES les autres bases (même à des hôtes sans instance nommée, ex:
  // VM-DEV) héritent ensuite de cet `instanceName` et échouent à se
  // connecter. Cloner `options`/`pool` isole chaque pool de ce
  // side-effect.
  const pool = new sql.ConnectionPool({
    ...cfg,
    options: { ...sql.config.options },
    pool: { ...sql.config.pool },
  });
  await pool.connect();
  physicalPools.set(key, pool);
  return pool;
}

async function validatePool(pool, dbLabel) {
  if (!pool || typeof pool.request !== "function") {
    throw new Error(
      `[${dbLabel}] L'objet pool ne semble pas être un pool mssql valide`,
    );
  }

  try {
    await pool.request().query("SELECT 1 AS [__healthcheck]");
  } catch (err) {
    throw new Error(
      `[${dbLabel}] Échec du healthcheck SQL (SELECT 1) | ${err.message}`,
    );
  }
}

async function attemptDbConnection(getConfigFn, dbLabel) {
  const attempt = (dbRetryCounters[dbLabel] || 0) + 1;
  dbRetryCounters[dbLabel] = attempt;

  logger.info(
    `${DB_TAG} ${colorize(dbLabel, "bold")} → tentative de connexion ${attempt}/${MAX_RETRIES}`,
  );

  try {
    const descriptor = getConfigFn();
    const pool = await getOrCreatePool(descriptor.connection, dbLabel);

    await validatePool(pool, dbLabel);

    databases[descriptor.dbName] = pool;

    logger.info(
      `${DB_TAG} ${colorize("✔", "green")} ${colorize(dbLabel, "bold")} connecté (tentative ${attempt}/${MAX_RETRIES})`,
    );
    return true;
  } catch (err) {
    logger.error(
      `${DB_TAG} ${colorize("⚠", "yellow")} ${colorize(dbLabel, "bold")} tentative ${attempt}/${MAX_RETRIES} échouée | ${err.message}`,
    );

    if (attempt >= MAX_RETRIES) {
      logger.error(
        `${DB_TAG} ${colorize("✖", "red")} ${colorize(dbLabel, "bold")} abandon après ${MAX_RETRIES} tentatives.`,
      );
      return false;
    }

    setTimeout(() => {
      void attemptDbConnection(getConfigFn, dbLabel);
    }, RETRY_DELAY_MS);

    return false;
  }
}

async function initSingleDatabase(file) {
  const dbLabel = file.replace(".db.config.js", "");
  const fileUrl = pathToFileURL(path.join(__dirname, file)).href;

  try {
    const mod = await import(fileUrl);
    const getConfigFn = mod.getConnectionConfig;

    if (typeof getConfigFn !== "function") {
      logger.warn(
        `${DB_TAG} ${colorize("⚠", "yellow")} ${file} n'exporte pas getConnectionConfig().`,
      );
      return;
    }

    await attemptDbConnection(getConfigFn, dbLabel);
  } catch (err) {
    logger.error(
      `${DB_TAG} ${colorize("✖", "red")} ${file} | Erreur inattendue lors du chargement | ${err.message}`,
    );
  }
}

/**
 * Charge dynamiquement toutes les connexions définies dans config/db/.
 * Une première tentative par base, en parallèle ; les retries suivants ne
 * bloquent pas le démarrage de l'API.
 */
export async function initDatabases() {
  // Bannière encadrée : isole visuellement tout le bloc d'initialisation DB
  // du reste des logs de démarrage (LDAP, chargement des routes...).
  logger.info(banner("DB INIT — Connexion aux bases de données"));

  const dbFiles = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith(".db.config.js"));

  await Promise.all(dbFiles.map((file) => initSingleDatabase(file)));

  const dbList = Object.keys(databases);
  const allConnected = dbList.length === dbFiles.length;

  const summaryColor =
    dbList.length === 0 ? "red" : allConnected ? "green" : "yellow";
  const summaryIcon = dbList.length === 0 ? "✖" : allConnected ? "✔" : "⚠";

  logger.info(
    dbList.length
      ? formatLog(`${DB_TAG} ${colorize(summaryIcon, summaryColor)}`, {
          "Bases Actives": dbList,
          Pools: `(${physicalPools.size} pool(s) physique(s) pour ${dbList.length} base(s) logique(s))`,
        })
      : `${DB_TAG} ${colorize(summaryIcon, summaryColor)} Aucune base connectée pour l'instant (retries programmés si configuré).`,
  );

  logger.info(banner("DB INIT terminé", summaryColor));

  return databases;
}

export function getDatabases() {
  return databases;
}

/**
 * Ferme tous les pools physiques (à utiliser lors d'un arrêt propre de l'API).
 */
export async function closeAllPools() {
  for (const pool of physicalPools.values()) {
    await pool.close().catch(() => {});
  }
  physicalPools.clear();
  for (const key of Object.keys(databases)) delete databases[key];
}
