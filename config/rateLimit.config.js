import rateLimit from "express-rate-limit";
import { logger } from "./logger.config.js";

/**
 * express-rate-limit était présent dans les dépendances de V1.0.0 mais jamais
 * branché (cf. audit sécurité 1.5). Seul le login disposait d'une protection
 * anti-bruteforce maison. Ici on ajoute une double couche :
 * - un limiteur général sur toute l'API
 * - un limiteur plus strict sur l'authentification (en complément du
 *   anti-bruteforce en mémoire déjà présent dans auth.middleware.js)
 */

const isProduction = process.env.NODE_ENV === "production";

/**
 * Mode test de charge : permet à loadtest/ (une seule IP, beaucoup de
 * requêtes/seconde) de dépasser volontairement generalLimiter/authLimiter
 * pour mesurer la capacité réelle de l'API, sans désactiver la protection en
 * usage normal.
 *
 * Garde de sécurité : totalement inopérant si NODE_ENV=production, quelle
 * que soit la valeur de LOADTEST_MODE — impossible à activer par erreur sur
 * un environnement de production. À ne définir que dans l'environnement qui
 * lance l'API pendant une campagne de test de charge (jamais dans
 * config/env/production.env), jamais côté script loadtest/ lui-même.
 */
const loadTestModeEnabled =
  !isProduction && process.env.LOADTEST_MODE === "true";

if (loadTestModeEnabled) {
  logger.warn(
    "[RATE LIMIT] LOADTEST_MODE=true : generalLimiter et authLimiter sont désactivés sur cette instance. " +
      "À utiliser uniquement pour un test de charge contrôlé — ne jamais activer en production.",
  );
}

function skipWhenLoadTesting() {
  return loadTestModeEnabled;
}

function getCleanIp(req) {
  let ip = req.ip || req.socket.remoteAddress || "";

  // IPv6 entre crochets, ex: "[::1]:54321"
  if (ip.startsWith("[")) {
    return ip.substring(1, ip.indexOf("]"));
  }

  // IPv4 classique avec port, ex: "192.168.164.20:59801"
  // (une IPv4 n'a jamais plus d'un ":", contrairement à une IPv6)
  const parts = ip.split(":");
  if (parts.length === 2) {
    return parts[0];
  }

  return ip; // IPv6 sans crochets, déjà propre
}

export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  keyGenerator: (req) => getCleanIp(req),
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipWhenLoadTesting,
  message: {
    success: false,
    error: {
      code: 429,
      key: "TOO_MANY_REQUESTS",
      message: "Trop de requêtes, veuillez réessayer plus tard.",
    },
  },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => getCleanIp(req),
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipWhenLoadTesting,
  message: {
    success: false,
    error: {
      code: 429,
      key: "TOO_MANY_REQUESTS",
      message: "Trop de tentatives de connexion, veuillez réessayer plus tard.",
    },
  },
});
