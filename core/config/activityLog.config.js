/**
 * Liste des routes dont l'activité (succès ET échec) est journalisée en base
 * (table USERSACTIVITY, base "generalactivity" — cf. modules/usersmanager/
 * services.js::postActivityStats).
 *
 * Volontairement sélective : seules les requêtes qui modifient des données
 * (créations/modifications/suppressions métier) sont journalisées. Les
 * lectures (GET) sont exclues pour ne pas saturer la table avec du bruit —
 * elles restent tracées côté winston (logs/*.log) via logHandler.
 *
 * `route` reprend le chemin monté tel que défini dans les routes.js de
 * chaque module (cf. modules/index.js : /api/<nomDuModule>/...), avec la
 * même syntaxe `:param` qu'Express. Il est comparé au pathname de la requête
 * via generateRoutePattern() (core/utils/logs.utils.js) — la query string
 * n'entre pas en compte dans le matching.
 *
 * Pour activer la journalisation d'une nouvelle route : ajouter une entrée
 * ici, rien d'autre à modifier (log.middleware.js et error.middleware.js
 * consomment cette liste automatiquement).
 *
 * @typedef {object} ActivityLogRoute
 * @property {"GET"|"POST"|"PUT"|"PATCH"|"DELETE"} method
 * @property {string} route - chemin monté, ex: "/api/ticketing/categories/:catid"
 * @property {string} appcode - code applicatif stocké en base (colonne APPCOD)
 * @property {string} comment - libellé humain de l'action (colonne COMMENT)
 */

/** @type {ActivityLogRoute[]} */
export const ROUTES_TO_SAVE_IN_BASE = [
  // ── ticketing ────────────────────────────────────────────────────────
  {
    method: "POST",
    route: "/api/ticketing",
    appcode: "TCK",
    comment: "Création d'un ticket",
  },
  {
    method: "PUT",
    route: "/api/ticketing",
    appcode: "TCK",
    comment: "Modification d'un ticket",
  },
  {
    method: "DELETE",
    route: "/api/ticketing",
    appcode: "TCK",
    comment: "Suppression d'un ticket",
  },
  {
    method: "PUT",
    route: "/api/ticketing/closing",
    appcode: "TCK",
    comment: "Clôture d'un ticket",
  },
  {
    method: "POST",
    route: "/api/ticketing/categories",
    appcode: "TCK",
    comment: "Création d'une catégorie",
  },
  {
    method: "PUT",
    route: "/api/ticketing/categories/:catid",
    appcode: "TCK",
    comment: "Modification d'une catégorie",
  },
  {
    method: "POST",
    route: "/api/ticketing/categories/:catid/sc1",
    appcode: "TCK",
    comment: "Création d'une sous-catégorie 1",
  },
  {
    method: "PUT",
    route: "/api/ticketing/categories/:catid/sc1/:sc1id",
    appcode: "TCK",
    comment: "Modification d'une sous-catégorie 1",
  },
  {
    method: "POST",
    route: "/api/ticketing/categories/sc1/:sc1id/sc2",
    appcode: "TCK",
    comment: "Création d'une sous-catégorie 2",
  },
  {
    method: "PUT",
    route: "/api/ticketing/categories/sc1/:sc1id/sc2/:sc2id",
    appcode: "TCK",
    comment: "Modification d'une sous-catégorie 2",
  },
  {
    method: "POST",
    route: "/api/ticketing/categories/sc2/:sc2id/sc3",
    appcode: "TCK",
    comment: "Création d'une sous-catégorie 3",
  },
  {
    method: "PUT",
    route: "/api/ticketing/categories/sc2/:sc2id/sc3/:sc3id",
    appcode: "TCK",
    comment: "Modification d'une sous-catégorie 3",
  },
  {
    method: "POST",
    route: "/api/ticketing/services",
    appcode: "TCK",
    comment: "Création d'un service ticketing",
  },
  {
    method: "PUT",
    route: "/api/ticketing/services/:srvid",
    appcode: "TCK",
    comment: "Modification d'un service ticketing",
  },
  {
    method: "POST",
    route: "/api/ticketing/services/:srvid/members",
    appcode: "TCK",
    comment: "Ajout d'un membre à un service",
  },
  {
    method: "DELETE",
    route: "/api/ticketing/services/:srvid/members/:usrid",
    appcode: "TCK",
    comment: "Retrait d'un membre d'un service",
  },
  {
    method: "POST",
    route: "/api/ticketing/note",
    appcode: "TCK",
    comment: "Création d'une note",
  },
  {
    method: "PUT",
    route: "/api/ticketing/note",
    appcode: "TCK",
    comment: "Modification d'une note",
  },
  {
    method: "DELETE",
    route: "/api/ticketing/note",
    appcode: "TCK",
    comment: "Suppression d'une note",
  },

  // ── declcav ──────────────────────────────────────────────────────────
  {
    method: "POST",
    route: "/api/declcav",
    appcode: "DCLING",
    comment: "Déclaration de cave (MRV)",
  },
  {
    method: "DELETE",
    route: "/api/declcav",
    appcode: "DCLING",
    comment: "Suppression d'une déclaration",
  },
  {
    method: "POST",
    route: "/api/declcav/relaunch",
    appcode: "DCLING",
    comment: "Relance d'une déclaration",
  },
  {
    method: "POST",
    route: "/api/declcav/rectification",
    appcode: "DCLING",
    comment: "Rectification d'une déclaration",
  },
  {
    method: "POST",
    route: "/api/declcav/mrv/ingredients",
    appcode: "DCLING",
    comment: "Ajout d'ingrédients à une MRV",
  },
  {
    method: "PATCH",
    route: "/api/declcav/ingredient",
    appcode: "DCLING",
    comment: "Modification d'un ingrédient",
  },
  {
    method: "POST",
    route: "/api/declcav/cave",
    appcode: "DCLING",
    comment: "Création d'une cave",
  },
  {
    method: "DELETE",
    route: "/api/declcav/cave",
    appcode: "DCLING",
    comment: "Suppression d'une cave",
  },
  {
    method: "POST",
    route: "/api/declcav/responses",
    appcode: "DCLING",
    comment: "Réponse à un questionnaire",
  },
  {
    method: "POST",
    route: "/api/declcav/reset-password",
    appcode: "DCLING",
    comment: "Réinitialisation du mot de passe cave",
  },

  // ── usersmanager ─────────────────────────────────────────────────────
  {
    method: "POST",
    route: "/api/usersmanager",
    appcode: "USRMAN",
    comment: "Création/modification d'un utilisateur",
  },
  {
    method: "POST",
    route: "/api/usersmanager/application",
    appcode: "USRMAN",
    comment: "Création/modification d'une application",
  },
  {
    method: "POST",
    route: "/api/usersmanager/service",
    appcode: "USRMAN",
    comment: "Création/modification d'un service",
  },
  {
    method: "POST",
    route: "/api/usersmanager/position",
    appcode: "USRMAN",
    comment: "Création/modification d'un poste",
  },
  {
    method: "PATCH",
    route: "/api/usersmanager/service/position",
    appcode: "USRMAN",
    comment: "Affectation d'un poste à un service",
  },
  {
    method: "POST",
    route: "/api/usersmanager/group",
    appcode: "USRMAN",
    comment: "Création/modification d'un groupe",
  },
  {
    method: "POST",
    route: "/api/usersmanager/last-version-details/opened",
    appcode: "USRMAN",
    comment: "Marquage d'une notification de version comme lue",
  },
  {
    method: "POST",
    route: "/api/usersmanager/theme",
    appcode: "USRMAN",
    comment: "Modification d'une préférence de thème",
  },

  // ── files ────────────────────────────────────────────────────────────
  {
    method: "POST",
    route: "/api/files/upload",
    appcode: "FILES",
    comment: "Upload de pièce(s) jointe(s)",
  },
  {
    method: "DELETE",
    route: "/api/files/delete",
    appcode: "FILES",
    comment: "Suppression de pièce(s) jointe(s)",
  },
];
