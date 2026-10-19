/**
 * Charge les variables d'environnement AVANT tout le reste.
 *
 * Doit être le premier import de app.js (littéralement la première ligne).
 * Raison : en ESM, les imports statiques d'un fichier sont intégralement
 * résolus et exécutés — récursivement, module par module — avant que le
 * corps du fichier importeur ne s'exécute. Or plusieurs modules (ex:
 * core/utils/jwt.utils.js) lisent process.env dès leur chargement, pas
 * dans une fonction. Appeler dotenv.config() dans l'IIFE de app.js (comme
 * en V1.0.0) arrive donc TROP TARD : ces modules sont déjà chargés (et,
 * pour jwt.utils.js, ont déjà levé JWT_CONFIGURATION_ERROR) avant que
 * l'IIFE ne démarre. En isolant le chargement ici et en l'important en
 * premier, ce fichier s'exécute avant tous les autres imports de app.js.
 */
import dotenv from "dotenv";

// `quiet: true` (option introduite en dotenv 17, cf. mise à jour dépendances)
// supprime le message "injected env (N) from ..." affiché sur stdout à
// chaque démarrage : sans cela, dotenv écrit sur la console AVANT même que
// winston ne soit configuré, contournant la règle du projet "pas de sortie
// console en production" (cf. config/logger.config.js).
dotenv.config({ quiet: true });
// `override: true` : par défaut dotenv ne réécrit JAMAIS une clé déjà
// présente dans process.env (cf. node_modules/dotenv/lib/main.js). Sans ce
// flag, ce second appel — censé surcharger la config racine avec les valeurs
// propres à l'environnement (config/env/development.env, production.env...)
// — n'a aucun effet sur les clés déjà définies dans le .env racine.
dotenv.config({
  path: `./config/env/${process.env.NODE_ENV}.env`,
  quiet: true,
  override: true,
});
