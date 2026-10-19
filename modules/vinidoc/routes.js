import express from "express";
import * as authMiddlewares from "../../core/middlewares/auth.middleware.js";
import * as controllers from "./controllers.js";
import { templateFileUpload, photoUpload, fieldsOnly, cleanupTmpFiles } from "./upload.js";

/* ─────────────────────────────────────────────
   VINIDOC — monté sous /api/vinidoc (cf. modules/index.js)
   Documentation complète : modules/vinidoc/README.md

   Référentiels
   GET    /me                                   droits + langues + couleurs
   GET    /merge-fields            ?LNGCOD      catalogue des balises + longueurs max

   Fiches œnologiques
   GET    /sheets                  ?SEARCH&STATUS&COLCOD&MILLESIME&GENERABLE&PAGE&PAGESIZE
   POST   /sheets                               création (œnologie)
   GET    /sheets/:SHTID                        détail + historique + versions
   PUT    /sheets/:SHTID                        champs communs + cépages     → DRAFT
   DELETE /sheets/:SHTID                        suppression logique
   PUT    /sheets/:SHTID/translations/:LNGCOD   texte d'une langue           → DRAFT
   DELETE /sheets/:SHTID/translations/:LNGCOD   (sauf langue par défaut)     → DRAFT
   POST   /sheets/:SHTID/submit                 DRAFT|REJECTED → SUBMITTED
   POST   /sheets/submit-all                    soumission en masse (filtres de la liste) ; fiches en anomalie écartées
   POST   /sheets/:SHTID/validate               SUBMITTED → VALIDATED (marketing)
   POST   /sheets/:SHTID/reject                 SUBMITTED → REJECTED  (marketing)
   GET    /sheets/:SHTID/versions               versions validées
   GET    /sheets/:SHTID/versions/:VERNUM       contenu d'une version validée
   POST   /sheets/:SHTID/check                  contrôle longueurs / balises obligatoires

   Modèles PowerPoint
   GET    /templates               ?ACTIVE&LNGCOD
   POST   /templates       [mp]    file + TPLNAM, DESCR?, LNGCOD?
   POST   /templates/inspect [mp]  analyse d'un .pptx sans enregistrement
   GET    /templates/:TPLID
   PUT    /templates/:TPLID                     métadonnées (TPLNAM, DESCR, LNGCOD, ACTIVE, ROWVER)
   PUT    /templates/:TPLID/file   [mp]         remplacement du .pptx
   PUT    /templates/:TPLID/tags                longueurs max / obligatoire
   DELETE /templates/:TPLID

   Génération
   POST   /generate        [mp]    SHTID, TPLID, LNGCOD, FORMAT?, photo?
   GET    /generations             ?SHTID&TPLID&LIMIT
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
      // Fichiers temporaires multer non déplacés (rejet, erreur, photo de
      // génération) : supprimés immédiatement plutôt qu'à la purge de tmp/.
      await cleanupTmpFiles(req);
    }
  };

/* Référentiels */
router.get("/me", handle(controllers.getMe));
router.get("/merge-fields", handle(controllers.getMergeFields));

/* Fiches */
router.get("/sheets", handle(controllers.listSheets));
router.post("/sheets", handle(controllers.createSheet, 201));
router.get("/sheets/:SHTID", handle(controllers.getSheet));
router.put("/sheets/:SHTID", handle(controllers.updateSheet));
router.delete("/sheets/:SHTID", fieldsOnly, handle(controllers.deleteSheet));

router.put("/sheets/:SHTID/translations/:LNGCOD", handle(controllers.saveTranslation));
router.delete("/sheets/:SHTID/translations/:LNGCOD", fieldsOnly, handle(controllers.deleteTranslation));

router.post("/sheets/submit-all", handle(controllers.submitSheets));
router.post("/sheets/:SHTID/submit", handle(controllers.submitSheet));
router.post("/sheets/:SHTID/validate", handle(controllers.validateSheet));
router.post("/sheets/:SHTID/reject", handle(controllers.rejectSheet));

router.get("/sheets/:SHTID/versions", handle(controllers.getSheetVersions));
router.get("/sheets/:SHTID/versions/:VERNUM", handle(controllers.getSheetVersion));
router.post("/sheets/:SHTID/check", handle(controllers.checkSheet));

/* Modèles */
router.get("/templates", handle(controllers.listTemplates));
router.post("/templates", templateFileUpload, handle(controllers.createTemplate, 201));
router.post("/templates/inspect", templateFileUpload, handle(controllers.inspectTemplate));
router.get("/templates/:TPLID", handle(controllers.getTemplate));
router.put("/templates/:TPLID", handle(controllers.updateTemplate));
router.put("/templates/:TPLID/file", templateFileUpload, handle(controllers.replaceTemplateFile));
router.put("/templates/:TPLID/tags", handle(controllers.setTemplateTags));
router.delete("/templates/:TPLID", fieldsOnly, handle(controllers.deleteTemplate));

/* Génération */
router.post("/generate", photoUpload, handle(controllers.generate, 201));
router.get("/generations", handle(controllers.listGenerations));

export default router;
