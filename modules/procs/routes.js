import fs from "fs/promises";
import path from "path";
import express from "express";
import multer from "multer";
import * as authMiddlewares from "../../core/middlewares/auth.middleware.js";
import * as controllers from "./controllers.js";

/* ─────────────────────────────────────────────
   PROCS — Routes (/api/procs) — Procédures UVCDR
   Toutes authentifiées (jeton de l'application PROCS) ; les droits fins
   (lecteur / rédacteur) sont contrôlés dans controllers.js.
   ⚠️ Les chemins statiques (/procedures/history…) doivent rester déclarés
   avant les chemins paramétrés (/procedures/:prcid).
───────────────────────────────────────────── */

const router = express.Router();

/** Taille maximale d'un document de procédure (Mo). */
const MAX_FILE_MB = Number(process.env.PROCS_MAX_FILE_MB) || 50;

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      try {
        const dir = process.env.UPLOAD_TMP_PATH || "tmp";
        await fs.mkdir(path.resolve(dir), { recursive: true });
        cb(null, dir);
      } catch (e) {
        cb(e, "");
      }
    },
    filename: (req, file, cb) => {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${unique}-procs${path.extname(file.originalname || "").toLowerCase()}`);
    },
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
});

/** Champ multipart "file" (un seul document) ; erreurs multer → 400/413. */
function singleFile(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      err.status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      err.message =
        err.code === "LIMIT_FILE_SIZE"
          ? `Document trop volumineux (${MAX_FILE_MB} Mo maximum).`
          : `Envoi du document impossible (${err.code}).`;
    }
    next(err);
  });
}

/** Enregistre une route authentifiée qui renvoie le résultat du contrôleur. */
function route(method, path, ...handlers) {
  const handler = handlers.pop();
  router[method](
    path,
    authMiddlewares.authVerifyMiddleware,
    ...handlers,
    async (req, res, next) => {
      try {
        const status = method === "post" ? 201 : 200;
        res.status(status).json(await handler(req));
      } catch (err) {
        next(err);
      }
    },
  );
}

/* ── Profil ───────────────────────────────── */
route("get", "/me", controllers.getMe);

/* ── Catégories ───────────────────────────── */
route("get", "/categories", controllers.getCategories);
route("post", "/categories", controllers.createCategory);
route("put", "/categories/:catid", controllers.updateCategory);

/* ── Journal & statistiques (rédacteurs) ─── */
route("get", "/history", controllers.getHistory);
route("get", "/stats", controllers.getStats);

/* ── Procédures ───────────────────────────── */
route("get", "/procedures", controllers.getProcedures);
route("post", "/procedures", singleFile, controllers.createProcedure);
route("get", "/procedures/:prcid", controllers.getProcedure);
route("put", "/procedures/:prcid", controllers.updateProcedure);
route("delete", "/procedures/:prcid", controllers.deleteProcedure);
route("put", "/procedures/:prcid/status", controllers.setProcedureStatus);
route("get", "/procedures/:prcid/text", controllers.getProcedureText);
route("get", "/procedures/:prcid/history", controllers.getProcedureHistory);
route("get", "/procedures/:prcid/readers", controllers.getProcedureReaders);
route("put", "/procedures/:prcid/acknowledge", controllers.acknowledgeProcedure);
route("post", "/procedures/:prcid/versions", singleFile, controllers.addVersion);

/* ── Versions ─────────────────────────────── */
route("put", "/versions/:verid/restore", controllers.restoreVersion);
route("put", "/versions/:verid/reindex", controllers.reindexVersion);

// Document (ou aperçu PDF) : réponse binaire, consultation tracée.
router.get(
  "/versions/:verid/file",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      await controllers.sendVersionFile(req, res);
    } catch (err) {
      if (res.headersSent) return res.end();
      next(err);
    }
  },
);

export default router;
