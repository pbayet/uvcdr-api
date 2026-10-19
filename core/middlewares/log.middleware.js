import { logger } from "../../config/logger.config.js";
import { sanitizeUrl, generateRoutePattern } from "../utils/logs.utils.js";
import { getRequestAuthorization, decodeJWT } from "../utils/jwt.utils.js";
import { postActivityStats } from "../../modules/usersmanager/services.js";
import * as requestUtils from "../utils/request.utils.js";
import { ROUTES_TO_SAVE_IN_BASE } from "../config/activityLog.config.js";

// Patterns compilés une seule fois au chargement du module plutôt qu'à
// chaque requête (ROUTES_TO_SAVE_IN_BASE ne change pas à l'exécution) —
// évite de recompiler ~40 RegExp sur chaque appel de saveLogInBase.
const COMPILED_ROUTES_TO_SAVE_IN_BASE = ROUTES_TO_SAVE_IN_BASE.map((route) => ({
  ...route,
  pattern: generateRoutePattern(route.route),
}));

/**
 * Journalise en base (table USERSACTIVITY) l'activité des routes listées
 * dans core/config/activityLog.config.js, en succès comme en échec.
 *
 * Appelée en fire-and-forget (jamais awaited par logHandler/errorHandler,
 * pour ne jamais retarder la réponse HTTP déjà envoyée) : ne rejette donc
 * jamais — toute erreur (DB indisponible, requête invalide...) est
 * uniquement loguée via winston, cf. audit — une ReferenceError sur
 * ROUTES_TO_SAVE_IN_BASE non défini finissait auparavant en "unhandled
 * rejection" en boucle sans jamais remonter d'information exploitable.
 */
export const saveLogInBase = async (
  req,
  sanitizedUrl,
  methodPost,
  userEmailPost,
  ipPost,
  durationPost,
  successPost,
  errorDetails,
) => {
  try {
    // La query string ne fait pas partie du matching de route (seul le
    // pathname est comparé aux patterns de activityLog.config.js).
    const pathOnly = (sanitizedUrl || "").split("?")[0];

    const routeInfo = COMPILED_ROUTES_TO_SAVE_IN_BASE.find(
      (route) => route.method === methodPost && route.pattern.test(pathOnly),
    );

    if (!routeInfo) return;

    let params = null;

    if (!routeInfo.route.startsWith("/api/files")) {
      params = (await requestUtils.getRequestParams(req)).params;
    }

    params =
      params && Object.keys(params || {}).length > 0
        ? !successPost
          ? `${JSON.stringify(params)}\n\n${errorDetails}`
          : JSON.stringify(params)
        : !successPost
          ? errorDetails
          : null;

    await postActivityStats(
      methodPost,
      routeInfo.route || null,
      routeInfo.comment || null,
      routeInfo.appcode || null,
      userEmailPost,
      ipPost,
      durationPost,
      params,
      successPost,
    );
  } catch (err) {
    logger.error(
      `[ACTIVITY_LOG] Échec de l'enregistrement en base pour [${methodPost}] ${sanitizedUrl} : ${err?.stack || err?.message || err}`,
    );
  }
};

export const getAuthorizationPayload = (req, res, next) => {
  try {
    const token = getRequestAuthorization(req);
    req.payload = decodeJWT(token);
  } catch {
    req.payload = null;
  }
  next();
};

export const PerfMonitoring = (req, res, next) => {
  const start = process.hrtime.bigint();
  const method = req.method;
  const sanitizedUrl = sanitizeUrl(req.originalUrl || "Unknown");

  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
    if (ms > 200) {
      logger.warn(
        `[SLOW] ${method} ${sanitizedUrl} - ${ms.toFixed(2)}ms (attendu < 200ms)`,
      );
    }
  });
  next();
};

/**
 * Log START/COMPLETE de chaque requête HTTP.
 */
export const logHandler = (req, res, next) => {
  const startTime = Date.now();

  const ip = req.ip || req.connection?.remoteAddress || "Unknown";
  const method = req.method;
  const sanitizedUrl = sanitizeUrl(req.originalUrl || "Unknown");
  const userEmail = req?.payload?.data?.email || "Unknown";

  logger.info(
    `[START] [${method}] ${sanitizedUrl} | IP: ${ip} | USER: ${userEmail}`,
  );

  res.on("finish", () => {
    const duration = Date.now() - startTime;

    if (!res.locals?.hasError) {
      saveLogInBase(
        req,
        sanitizedUrl,
        method || null,
        userEmail && userEmail !== "Unknown" ? userEmail : null,
        ip && ip !== "::1" ? ip : null,
        duration || null,
        true,
      );

      logger.info(
        `[COMPLETE] [${method}] ${sanitizedUrl} | IP: ${ip} | USER: ${userEmail} | TIME: ${duration}ms`,
      );
    }
  });

  next();
};
