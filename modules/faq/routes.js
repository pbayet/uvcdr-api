import express from "express";
import * as authMiddlewares from "../../core/middlewares/auth.middleware.js";
import * as controllers from "./controllers.js";

/* ─────────────────────────────────────────────
   FAQ — Routes (/api/faq)
   Toutes authentifiées ; les droits fins (modérateur, gestionnaire,
   auteur) sont contrôlés dans controllers.js.
   ⚠️ Les chemins statiques (/posts/similar…) doivent rester déclarés
   avant les chemins paramétrés (/posts/:pstid).
───────────────────────────────────────────── */

const router = express.Router();

/** Enregistre une route authentifiée qui renvoie le résultat du contrôleur. */
function route(method, path, handler) {
  router[method](
    path,
    authMiddlewares.authVerifyMiddleware,
    async (req, res, next) => {
      try {
        res.json(await handler(req));
      } catch (err) {
        next(err);
      }
    },
  );
}

/* ── Référentiels ─────────────────────────── */
route("get", "/statuses", controllers.getStatuses);
route("get", "/categories", controllers.getCategories);
route("get", "/categories/all", controllers.getAllCategories);
route("post", "/categories", controllers.createCategory);
route("put", "/categories/:catid", controllers.updateCategory);
route("get", "/applications", controllers.getApplications);

/* ── Modérateurs ──────────────────────────── */
route("get", "/moderators/me", controllers.getMyModeratorStatus);
route("get", "/moderators", controllers.getModerators);
route("post", "/moderators", controllers.addModerator);
route("delete", "/moderators/:usrid", controllers.removeModerator);

/* ── Base de connaissance & statistiques ─── */
route("get", "/knowledge-base", controllers.getKnowledgeBase);
route("get", "/stats", controllers.getStats);

/* ── Publications ─────────────────────────── */
route("get", "/posts", controllers.getPosts);
route("get", "/posts/similar", controllers.getSimilarPosts);
route("post", "/posts", controllers.createPost);
route("get", "/posts/:pstid", controllers.getPost);
route("put", "/posts/:pstid", controllers.updatePost);
route("delete", "/posts/:pstid", controllers.deletePost);
route("post", "/posts/:pstid/views", controllers.registerView);
route("put", "/posts/:pstid/type", controllers.convertPost);
route("put", "/posts/:pstid/keywords", controllers.setKeywords);
route("put", "/posts/:pstid/pin", controllers.setUserPin);
route("put", "/posts/:pstid/like", controllers.likePost);
route("get", "/posts/:pstid/likes", controllers.getPostLikers);
route("post", "/posts/:pstid/ticket", controllers.createTicket);

/* ── Réponses ─────────────────────────────── */
route("post", "/answers", controllers.createAnswer);
route("put", "/answers/:ansid", controllers.updateAnswer);
route("delete", "/answers/:ansid", controllers.deleteAnswer);
route("put", "/answers/:ansid/validate", controllers.validateAnswer);
route("put", "/answers/:ansid/like", controllers.likeAnswer);
route("get", "/answers/:ansid/likes", controllers.getAnswerLikers);

export default router;
