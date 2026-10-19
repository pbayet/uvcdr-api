import { ERROR_REGISTRY } from "../utils/error.registry.js";
import { logger } from "../../config/logger.config.js";
import { sanitizeUrl } from "../utils/logs.utils.js";
import { saveLogInBase } from "./log.middleware.js";

/**
 * Essaie de faire correspondre une rawKey (ex: "ACCOUNT_LOCKED_[120s]")
 * à une clé du registre avec placeholders nommés (ex: "ACCOUNT_LOCKED_[TIME]").
 */
function resolveRegistryKeyAndValues(rawKey) {
  if (!rawKey) return { key: null, values: {} };

  if (ERROR_REGISTRY[rawKey]) {
    return { key: rawKey, values: {} };
  }

  const registryKeys = Object.keys(ERROR_REGISTRY);

  for (const regKey of registryKeys) {
    const placeholderMatches = [...regKey.matchAll(/\[([A-Z0-9_]+)\]/gi)];
    if (placeholderMatches.length === 0) continue;

    const placeholderNames = placeholderMatches.map((m) => m[1]);
    const pattern =
      "^" + regKey.replace(/\[([A-Z0-9_]+)\]/gi, "\\[([^\\]]+)\\]") + "$";
    const regex = new RegExp(pattern, "i");

    const m = rawKey.match(regex);
    if (!m) continue;

    const values = {};
    placeholderNames.forEach((name, idx) => {
      values[name] = m[idx + 1];
    });

    return { key: regKey, values };
  }

  return { key: null, values: {} };
}

function replacePlaceholders(text, values = {}) {
  if (!text) return text;
  let out = text;
  for (const [k, v] of Object.entries(values)) {
    out = out.replaceAll(`[${k}]`, v);
  }
  return out;
}

export const errorHandler = (err, req, res, next) => {
  if (!res.locals) res.locals = {};
  res.locals.hasError = true;

  const lang = (req.headers["accept-language"] || "fr")
    .split(",")[0]
    .toLowerCase();
  const ip = req.ip || req.connection?.remoteAddress || "Unknown";
  const method = req.method;
  const sanitizedUrl = sanitizeUrl(req.originalUrl);
  const userEmail = req?.payload?.data?.email || "Unknown";

  // Erreurs de validation zod (remplace les `if (!x) throw new Error(...)`
  // dupliqués dans les contrôleurs — cf. audit dette technique 4.4).
  if (err?.name === "ZodError" || Array.isArray(err?.issues)) {
    const issues = (err.issues || []).map((i) => ({
      path: i.path?.join("."),
      message: i.message,
    }));

    logger.warn(
      `[VALIDATION] [${method}] ${sanitizedUrl} | USER: ${userEmail} | ${JSON.stringify(issues)}`,
    );

    saveLogInBase(
      req,
      sanitizedUrl,
      method || null,
      userEmail && userEmail !== "Unknown" ? userEmail : null,
      ip && ip !== "::1" ? ip : null,
      0,
      false,
      `ERRORCODE: 1106, message: ${JSON.stringify(issues)}`,
    );

    return res.status(400).json({
      success: false,
      error: {
        code: 1106,
        key: "MISSING_PARAMETERS",
        message: "Paramètres invalides ou manquants.",
        description: "La requête contient des champs invalides ou manquants.",
        issues,
      },
    });
  }

  const rawKey = err.message?.trim() || "";
  const { key: baseKey, values } = resolveRegistryKeyAndValues(rawKey);

  if (baseKey && ERROR_REGISTRY[baseKey]) {
    const registered = ERROR_REGISTRY[baseKey];
    const message = replacePlaceholders(
      registered.MESSAGE[lang] || registered.MESSAGE.en,
      values,
    );
    const description = replacePlaceholders(
      registered.DESCRIPTION[lang] || registered.DESCRIPTION.en,
      values,
    );

    logger.error(
      `[${method}] ${sanitizedUrl} | ${message} (${description}) | IP: ${ip} | USER: ${userEmail} | CODE: ${registered.CODE}`,
    );

    saveLogInBase(
      req,
      sanitizedUrl,
      method || null,
      userEmail && userEmail !== "Unknown" ? userEmail : null,
      ip && ip !== "::1" ? ip : null,
      0,
      false,
      `ERRORCODE: ${registered.CODE}, message: ${message}`,
    );

    return res.status(registered.HTTP_RESPONSE_CODE).json({
      success: false,
      error: {
        code: registered.CODE,
        key: rawKey.replaceAll("[", "").replaceAll("]", ""),
        message,
        description,
        values,
      },
    });
  }

  // Erreurs "ad hoc" avec un .status explicite (ex: err.status = 404 dans les
  // contrôleurs ticketing) : dans V1.0.0 ce cas retombait à tort en 500
  // (INTERNAL_ERROR) faute de correspondance dans le registre. On respecte
  // désormais le status/message porté par l'erreur elle-même.
  if (err.status) {
    logger.warn(
      `[${method}] ${sanitizedUrl} | ${err.message} | IP: ${ip} | USER: ${userEmail}`,
    );

    saveLogInBase(
      req,
      sanitizedUrl,
      method || null,
      userEmail && userEmail !== "Unknown" ? userEmail : null,
      ip && ip !== "::1" ? ip : null,
      0,
      false,
      `ERRORCODE: ${err.status}, message: ${err.message}`,
    );

    return res.status(err.status).json({
      success: false,
      error: {
        code: err.status,
        key: "REQUEST_ERROR",
        message: err.message,
        description: err.message,
      },
    });
  }

  // Fallback inconnu
  const fallback = ERROR_REGISTRY.INTERNAL_ERROR;
  const debugInfo = err.stack || err.message;

  logger.error(
    `[${method}] ${sanitizedUrl} | ${fallback.MESSAGE[lang] || fallback.MESSAGE.en} (${fallback.DESCRIPTION[lang] || fallback.DESCRIPTION.en}) | IP: ${ip} | USER: ${userEmail} | CODE: ${fallback.CODE}\nDetails: ${debugInfo}`,
  );

  saveLogInBase(
    req,
    sanitizedUrl,
    method || null,
    userEmail && userEmail !== "Unknown" ? userEmail : null,
    ip && ip !== "::1" ? ip : null,
    0,
    false,
    `ERRORCODE: ${fallback.CODE}, message: ${debugInfo}`,
  );

  return res.status(fallback.HTTP_RESPONSE_CODE).json({
    success: false,
    error: {
      code: fallback.CODE,
      key: "INTERNAL_ERROR",
      message: fallback.MESSAGE[lang] || fallback.MESSAGE.en,
      description: fallback.DESCRIPTION[lang] || fallback.DESCRIPTION.en,
      debug: process.env.NODE_ENV === "development" ? debugInfo : undefined,
    },
  });
};
