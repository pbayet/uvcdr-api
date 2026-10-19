#!/usr/bin/env node
// loadtest/run.js
// Runner de tests de charge autocannon. Usage :
//   npm run load-test -- <scenario> [options env via LOADTEST_*]
//   node loadtest/run.js --list
//
// cf. README section "Tests de charge" pour la configuration complète
// (variables d'env, scénarios disponibles, avertissements écriture/rate-limit).
import autocannon from "autocannon";
import { mkdirSync, writeFileSync } from "node:fs";
import { config } from "./config.js";
import { scenarios, scenarioNames } from "./scenarios.js";
import { getAuthToken } from "./authenticate.js";

function printHelp() {
  console.log(`
Tests de charge — API UVCDR (autocannon)

Usage :
  node loadtest/run.js <scenario>
  npm run load-test -- <scenario>
  node loadtest/run.js --list

Scénarios disponibles :
${scenarioNames.map((name) => `  - ${name}${scenarios[name].warning ? "  ⚠️" : ""} : ${scenarios[name].description}`).join("\n")}

Variables d'environnement principales :
  LOADTEST_BASE_URL       URL de base de l'API (défaut: http://localhost:3001/api)
  LOADTEST_AUTH_TOKEN     Token JWT déjà valide (évite de repasser par /auth)
  LOADTEST_EMAIL / LOADTEST_PASSWORD / LOADTEST_APPCODE   Identifiants pour login auto
  LOADTEST_CONNECTIONS    Connexions simultanées (défaut: 10)
  LOADTEST_DURATION       Durée du run en secondes (défaut: 15)
`);
}

async function main() {
  const arg = process.argv[2];

  if (!arg || arg === "--help" || arg === "-h") {
    printHelp();
    process.exit(arg ? 0 : 1);
  }

  if (arg === "--list") {
    printHelp();
    process.exit(0);
  }

  const scenario = scenarios[arg];
  if (!scenario) {
    console.error(`Scénario inconnu : "${arg}". Scénarios disponibles : ${scenarioNames.join(", ")}`);
    process.exit(1);
  }

  if (scenario.warning) {
    console.warn(`⚠️  ${scenario.warning}\n`);
  }

  let authToken = null;
  if (scenario.requiresAuth) {
    console.log("Authentification en cours...");
    authToken = await getAuthToken();
    console.log("Token obtenu.\n");
  }

  const opts = { title: arg, ...scenario.build(authToken) };

  console.log(`Cible      : ${opts.url}`);
  console.log(`Connexions : ${opts.connections}`);
  console.log(`Durée      : ${opts.duration}s\n`);

  const instance = autocannon(opts, (err, result) => {
    if (err) {
      console.error("Erreur autocannon :", err);
      process.exit(1);
    }
    report(arg, result);
  });

  autocannon.track(instance, { renderProgressBar: true });

  process.once("SIGINT", () => instance.stop());
}

function report(scenarioName, result) {
  const errorRate = result.requests.total > 0 ? (result.errors + result.non2xx) / result.requests.total : 0;

  console.log("\n─── Résultat ───────────────────────────────────────");
  console.log(`Requêtes totales   : ${result.requests.total}`);
  console.log(`Req/sec (moyenne)  : ${result.requests.average}`);
  console.log(`Latence moyenne    : ${result.latency.average} ms`);
  console.log(`Latence p99        : ${result.latency.p99} ms`);
  console.log(`Débit moyen        : ${(result.throughput.average / 1024).toFixed(1)} KB/s`);
  console.log(`Erreurs / non-2xx  : ${result.errors} / ${result.non2xx} (${(errorRate * 100).toFixed(2)}%)`);
  console.log("─────────────────────────────────────────────────────\n");

  const warnings = [];
  if (result.latency.p99 > config.thresholds.p99LatencyMs) {
    warnings.push(
      `Latence p99 (${result.latency.p99}ms) au-delà du seuil indicatif (${config.thresholds.p99LatencyMs}ms).`,
    );
  }
  if (errorRate > config.thresholds.maxErrorRate) {
    warnings.push(
      `Taux d'erreur (${(errorRate * 100).toFixed(2)}%) au-delà du seuil indicatif (${(config.thresholds.maxErrorRate * 100).toFixed(2)}%).`,
    );
  }
  if (warnings.length) {
    console.warn("⚠️  Avertissements (seuils indicatifs, à ajuster selon l'environnement) :");
    warnings.forEach((w) => console.warn(`   - ${w}`));
    console.warn("");
  }

  mkdirSync("./loadtest/reports", { recursive: true });
  const reportPath = `./loadtest/reports/${scenarioName}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(reportPath, JSON.stringify(result, null, 2));
  console.log(`Rapport complet     : ${reportPath}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
