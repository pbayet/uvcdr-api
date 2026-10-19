// ============================================================================
// Simple In-Memory Cache Utility
// ============================================================================
const cache = new Map();

// Cf. audit perf — ce cache n'avait ni limite de taille, ni purge active :
// une clé jamais relue après expiration restait en mémoire indéfiniment
// (l'expiration n'était vérifiée qu'à la prochaine lecture de cette même
// clé). MAX_CACHE_ENTRIES borne la mémoire consommée (éviction de l'entrée
// la plus ancienne en cas de dépassement), et le balayage périodique purge
// les entrées expirées même si elles ne sont plus jamais relues.
const MAX_CACHE_ENTRIES = 500;
const CACHE_SWEEP_INTERVAL_MS = 60 * 1000;

function evictExpiredCacheEntries() {
  const now = Date.now();
  for (const [key, { expiry }] of cache.entries()) {
    if (now >= expiry) cache.delete(key);
  }
}

function enforceMaxCacheSize() {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

setInterval(evictExpiredCacheEntries, CACHE_SWEEP_INTERVAL_MS).unref();

/**
 * Récupère tous les paramètres d'une requête Express (body, query, params,
 * fichiers), peu importe la méthode HTTP.
 *
 * @param {object} req
 * @param {object} [schema] - Mapping { nomParam: type }, types supportés :
 *   "string", "number", "boolean", "array", "json".
 */
export async function getRequestParams(req, schema = {}) {
  if (!req) {
    return { method: "", url: "", ip: "unknown", headers: {}, params: {} };
  }

  try {
    const method = req.method?.toUpperCase() || "GET";
    const query = req.query || {};
    const pathParams = req.params || {};
    let body = {};

    try {
      if (req.body && Object.keys(req.body).length > 0) {
        body = req.body;
      } else if (method !== "GET" && req.readable) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString();
        body = raw ? JSON.parse(raw) : {};
      }
    } catch {
      body = {};
    }

    let params = { ...pathParams, ...query, ...body };

    if (req.files) {
      params.files = req.files;
    } else if (req.file) {
      params.file = req.file;
    }

    for (const key in params) {
      if (params[key] === undefined) delete params[key];
    }

    params = applySchema(params, schema);

    return {
      method,
      url: req.originalUrl || req.url,
      ip: req.ip || req.headers["x-forwarded-for"] || "unknown",
      headers: req.headers || {},
      params,
    };
  } catch {
    return {};
  }
}

function applySchema(params, schema) {
  const result = { ...params };
  for (const [key, type] of Object.entries(schema)) {
    if (key in result) {
      result[key] = castValue(result[key], type);
    }
  }
  return result;
}

function castValue(value, type) {
  if (value === undefined || value === null) return value;

  switch (type) {
    case "string":
      return String(value);

    case "number": {
      const n = Number(value);
      return Number.isNaN(n) ? undefined : n;
    }

    case "boolean":
      return castBoolean(value);

    case "array":
      if (Array.isArray(value)) return value;
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [value];
      } catch {
        return [value];
      }

    case "json":
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }

    default:
      return value;
  }
}

function castBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return ["true", "1", "yes", "on"].includes(v);
  }
  return Boolean(value);
}

/**
 * Récupère ou met en cache un résultat (get-or-set avec TTL).
 * Utilisé pour éviter de recalculer/re-requêter des référentiels peu changeants
 * à chaque appel (cf. audit perf 3.3).
 */
export async function getCachedResult(key, fetcher, ttlMs = 300000) {
  const now = Date.now();

  if (cache.has(key)) {
    const { value, expiry } = cache.get(key);
    if (now < expiry) return value;
    cache.delete(key);
  }

  const value = await fetcher();

  // Réinsertion en fin de Map (ordre d'insertion) : enforceMaxCacheSize()
  // évince en priorité les entrées les plus anciennes en cas de dépassement.
  cache.delete(key);
  cache.set(key, { value, expiry: now + ttlMs });
  enforceMaxCacheSize();

  return value;
}

export function clearCache() {
  cache.clear();
}

export function invalidateCache(key) {
  cache.delete(key);
}
