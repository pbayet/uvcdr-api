// loadtest/authenticate.js
// Obtient un JWT valide pour les scénarios authentifiés, soit directement
// (LOADTEST_AUTH_TOKEN), soit via un vrai POST /auth (identifiants LDAP
// réels) — jamais en fabriquant un token "à la main" : ça exercerait un
// chemin différent de la production et contournerait la vérification
// LDAP + permissions applicatives que le test de charge est censé couvrir.
import { config } from "./config.js";

export async function getAuthToken() {
  if (config.authToken) {
    return config.authToken;
  }

  if (!config.email || !config.password) {
    throw new Error(
      "Aucun token fourni (LOADTEST_AUTH_TOKEN) et aucun identifiant (LOADTEST_EMAIL / LOADTEST_PASSWORD) : " +
        "impossible d'authentifier les scénarios protégés. Voir README section 'Tests de charge'.",
    );
  }

  const res = await fetch(`${config.baseUrl}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: config.email, password: config.password, appcode: config.appcode }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Échec de l'authentification (${res.status}) : ${body}`);
  }

  const token = await res.json();
  if (typeof token !== "string" || !token) {
    throw new Error("Réponse /auth inattendue : token JWT introuvable dans la réponse.");
  }

  return token;
}
