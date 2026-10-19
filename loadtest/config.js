// loadtest/config.js
// Configuration centralisée des tests de charge (autocannon). Toutes les
// valeurs sont pilotables par variable d'env pour ne jamais committer de
// cible/credentials en dur — cf. README section "Tests de charge".
export const config = {
  // URL de base de l'API à charger. Ne JAMAIS pointer sur un environnement
  // de production sans accord préalable (les tests de charge génèrent une
  // charge réelle : DB, CPU, réseau).
  baseUrl: process.env.LOADTEST_BASE_URL || "http://localhost:3001/api",

  // Un token déjà valide peut être fourni directement (évite de repasser par
  // /auth, donc par le rate-limit + anti-bruteforce du login à chaque run).
  authToken: process.env.LOADTEST_AUTH_TOKEN || null,

  // Sinon, identifiants LDAP réels utilisés pour obtenir un token via
  // POST /auth avant de lancer le scénario (cf. loadtest/authenticate.js).
  email: process.env.LOADTEST_EMAIL || null,
  password: process.env.LOADTEST_PASSWORD || null,
  appcode: process.env.LOADTEST_APPCODE || "TICKETING",

  // Paramètres autocannon par défaut (surchargables par scénario).
  connections: Number(process.env.LOADTEST_CONNECTIONS) || 10,
  duration: Number(process.env.LOADTEST_DURATION) || 15, // secondes
  pipelining: Number(process.env.LOADTEST_PIPELINING) || 1,

  // Seuils de non-régression indicatifs (cf. audit perf — le pipeline de
  // logs marque une requête "SLOW" au-delà de 200ms, PerfMonitoring). Utilisés
  // uniquement pour afficher un avertissement en fin de run, jamais pour
  // faire échouer le process — à ajuster selon l'environnement testé.
  thresholds: {
    p99LatencyMs: Number(process.env.LOADTEST_P99_THRESHOLD_MS) || 500,
    maxErrorRate: Number(process.env.LOADTEST_MAX_ERROR_RATE) || 0.01, // 1%
  },
};
