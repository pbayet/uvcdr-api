import express from "express";
import * as authMiddlewares from "../../core/middlewares/auth.middleware.js";
import * as controllers from "./controllers.js";

/* ─────────────────────────────────────────────
   DCKMNG — Dock Manager — monté sous /api/dckmng (cf. modules/index.js)
   Schéma : sql/DCKMNG.tables.sql — import de l'ancienne appli : scripts/import-json.mjs

   Espace CARISTE (public, sans connexion)
   GET    /public/loads                 chargements du jour
   PATCH  /public/loads/:LODID          QUAEFF?, OPEDEB?, OPEFIN?  (chargements du jour uniquement)
   GET    /public/events                flux SSE (text/event-stream) des chargements du jour

   Espace ADMIN (authVerifyMiddleware + jeton DCKMNG)
   GET    /statuses                     référentiel des statuts
   GET    /days                         jours ayant au moins un chargement (calendrier)
   GET    /loads           ?LODDAT      chargements d'un jour (aujourd'hui par défaut)
   POST   /loads                        NOM, QUAI?
   PUT    /loads/:LODID                 NOM?, QUAI?, QUAEFF?, OPEDEB?, OPEFIN?
   DELETE /loads/:LODID                 suppression logique
   GET    /loads/:LODID/changes         historique des modifications
   GET    /stats           ?FROM&TO     statistiques (7 derniers jours par défaut)
───────────────────────────────────────────── */

const router = express.Router();

/** Route qui renvoie le résultat du contrôleur (authentifiée ou non). */
function route(method, path, handler, { auth = true } = {}) {
  const middlewares = auth ? [authMiddlewares.authVerifyMiddleware] : [];
  router[method](path, ...middlewares, async (req, res, next) => {
    try {
      res.json(await handler(req));
    } catch (err) {
      next(err);
    }
  });
}

/* ── Espace cariste (public) ──────────────── */
route("get", "/public/loads", controllers.getPublicLoads, { auth: false });
route("patch", "/public/loads/:LODID", controllers.updatePublicLoad, {
  auth: false,
});
router.get("/public/events", async (req, res, next) => {
  try {
    await controllers.subscribePublicLoads(req, res);
  } catch (err) {
    if (res.headersSent) res.end();
    else next(err);
  }
});

/* ── Espace admin ─────────────────────────── */
route("get", "/statuses", controllers.getStatuses);
route("get", "/days", controllers.getLoadDays);
route("get", "/loads", controllers.getLoads);
route("post", "/loads", controllers.createLoad);
route("get", "/loads/:LODID/changes", controllers.getChanges);
route("put", "/loads/:LODID", controllers.updateLoad);
route("delete", "/loads/:LODID", controllers.deleteLoad);
route("get", "/stats", controllers.getStats);

export default router;
