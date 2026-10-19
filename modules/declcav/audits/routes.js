import express from "express";
import * as authMiddlewares from "../../../core/middlewares/auth.middleware.js";
import * as controllers from "./controllers.js";
import { auditFieldsOnly, auditFilesUpload, cleanupTmpFiles } from "./upload.js";

/* ─────────────────────────────────────────────
   AUDITS — monté sous /api/declcav/audits (cf. ../routes.js)

   GET    /                          liste (état courant) — ?CAVEID, ?INCLUDE_DELETED
   GET    /:AUDID                    détail + historique complet
   POST   /                  [mp]    création (Qualité)        CAVEID, TITLE, DATEXP, COMMENT?, files[]
   POST   /:AUDID/versions   [mp]    nouvelle version (Qualité) DATEXP, COMMENT?, KEEP_FILECODES, files[]
   POST   /:AUDID/returns    [mp]    retour cave               VERID, COMMENT?, files[]
   POST   /:AUDID/returns/:RETID/review  validation/refus (Qualité) DECISION, COMMENT?
   DELETE /:AUDID                    suppression logique (Qualité) COMMENT
   [mp] = multipart/form-data
───────────────────────────────────────────── */

const router = express.Router();

router.use(authMiddlewares.authVerifyMiddleware);

/** Adapte un contrôleur async ; `status` = code HTTP de succès. */
const handle =
  (fn, status = 200) =>
  async (req, res, next) => {
    try {
      res.status(status).json(await fn(req));
    } catch (err) {
      next(err);
    } finally {
      // Fichiers temporaires multer non déplacés (rejet, erreur) : supprimés
      // tout de suite plutôt que d'attendre la purge quotidienne de tmp/.
      if (req.files?.length) await cleanupTmpFiles(req.files);
    }
  };

router.get("/", handle(controllers.getAudits));
router.get("/:AUDID", handle(controllers.getAudit));

router.post("/", auditFilesUpload, handle(controllers.createAudit, 201));
router.post("/:AUDID/versions", auditFilesUpload, handle(controllers.createVersion, 201));
router.post("/:AUDID/returns", auditFilesUpload, handle(controllers.createReturn, 201));
router.post("/:AUDID/returns/:RETID/review", handle(controllers.reviewReturn));

// Le front envoie les DELETE en multipart (cf. files/delete), d'où auditFieldsOnly.
router.delete("/:AUDID", auditFieldsOnly, handle(controllers.deleteAudit));

export default router;
