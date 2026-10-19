// loadtest/scenarios.js
// Chaque scénario retourne des options autocannon (cf. https://github.com/mcollina/autocannon#api).
// `authToken` est injecté par run.js une fois obtenu (cf. authenticate.js).
import { config } from "./config.js";

export const scenarios = {
  /**
   * Vérifie que l'API répond sous charge, sans dépendance DB/LDAP
   * (GET /api/test est un simple healthcheck). Bon scénario "de référence"
   * pour mesurer le plancher de latence de la stack Express/Node seule.
   */
  smoke: {
    description: "GET /api/test — healthcheck public, aucune authentification requise.",
    requiresAuth: false,
    build: () => ({
      url: `${config.baseUrl}/test`,
      connections: config.connections,
      duration: config.duration,
      pipelining: config.pipelining,
    }),
  },

  /**
   * Lecture authentifiée représentative (liste des tickets d'un utilisateur).
   * Exerce : authVerifyMiddleware (JWT + vérif permission, avec cache 5 min),
   * runQuery/PreparedStatement pooling, formatage ticketing/utils.js.
   */
  "tickets-read": {
    description: "GET /api/ticketing — liste des tickets (lecture authentifiée).",
    requiresAuth: true,
    build: (authToken) => ({
      url: `${config.baseUrl}/ticketing`,
      connections: config.connections,
      duration: config.duration,
      pipelining: config.pipelining,
      headers: { Authorization: `Bearer ${authToken}` },
    }),
  },

  /**
   * Lecture des référentiels (catégories/services/statuts/priorités) —
   * généralement en cache applicatif ou peu volumineux, bon comparatif face
   * à "tickets-read" pour isoler le coût du formatage ticketing (notes/PJ
   * imbriquées) du reste du pipeline.
   */
  "referentials-read": {
    description: "GET /api/ticketing/statuses — lecture d'un petit référentiel.",
    requiresAuth: true,
    build: (authToken) => ({
      url: `${config.baseUrl}/ticketing/statuses`,
      connections: config.connections,
      duration: config.duration,
      pipelining: config.pipelining,
      headers: { Authorization: `Bearer ${authToken}` },
    }),
  },

  /**
   * Écriture authentifiée (création de ticket). ⚠️ Crée réellement des
   * lignes en base à chaque requête — cf. avertissement README. Prévoir un
   * SRVID de test dédié pour pouvoir nettoyer/reconnaître les tickets créés.
   */
  "tickets-write": {
    description: "POST /api/ticketing — création de ticket (écriture authentifiée).",
    requiresAuth: true,
    build: (authToken) => ({
      url: `${config.baseUrl}/ticketing`,
      method: "POST",
      connections: config.connections,
      duration: config.duration,
      pipelining: 1, // les écritures ne doivent pas être pipelinées
      headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
      setupClient: (client) => {
        client.on("response", () => {});
      },
      body: JSON.stringify({
        TITLE: `[LOADTEST] Ticket généré ${Date.now()}`,
        DESCR: "Ticket créé par le script de test de charge — supprimable sans risque.",
        SRVID: Number(process.env.LOADTEST_SRVID) || 1,
      }),
    }),
  },

  /**
   * Login (LDAP + anti-bruteforce + JWT). Volontairement à très faible
   * concurrence par défaut : authLimiter autorise 20 requêtes/15min sur
   * /api/auth, et l'anti-bruteforce maison bloque un compte après 5 échecs.
   * À ne lancer qu'avec un compte de test dédié et une charge minime.
   */
  "auth-login": {
    description: "POST /api/auth — login LDAP (⚠️ rate-limité, faible concurrence recommandée).",
    requiresAuth: false,
    warning:
      "authLimiter = 20 req/15min sur /api/auth. Ce scénario peut verrouiller le compte de test " +
      "(anti-bruteforce, 5 tentatives/10min) si les identifiants sont incorrects ou si la concurrence est trop élevée.",
    build: () => ({
      url: `${config.baseUrl}/auth`,
      method: "POST",
      connections: Math.min(config.connections, 2),
      duration: Math.min(config.duration, 10),
      pipelining: 1,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: config.email, password: config.password, appcode: config.appcode }),
    }),
  },
};

export const scenarioNames = Object.keys(scenarios);
