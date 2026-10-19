import fs from "fs/promises";
import path from "path";
import express from "express";
import multer from "multer";
import * as authMiddlewares from "../../core/middlewares/auth.middleware.js";
import * as controllers from "./controllers.js";
import {
  startTmpPurgeCron,
  startDeletedAttachmentsPurgeCron,
} from "./config/module.config.js";

const tmpDir = process.env.UPLOAD_TMP_PATH || "tmp";
await fs.mkdir(path.resolve(tmpDir), { recursive: true });

startTmpPurgeCron();
startDeletedAttachmentsPurgeCron();

const router = express.Router();

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const dir = process.env.UPLOAD_TMP_PATH || "tmp";
      await fs.mkdir(dir, { recursive: true });
      cb(null, dir);
    } catch (e) {
      cb(e, "");
    }
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}-${file.originalname}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB / fichier
    files: 10,
  },
});

router.post(
  "/upload",
  authMiddlewares.authVerifyMiddleware,
  upload.array("files", 10),
  async (req, res, next) => {
    try {
      res.status(201).json(await controllers.uploadFiles(req));
    } catch (err) {
      next(err);
    }
  },
);

// Le front (cf. `apiRequest`/`fileDeletings` dans api.tsx, ticketing) envoie
// ce DELETE en `multipart/form-data` (`isMultipart: true`), avec `metas` en
// simple champ texte (JSON stringifié) — pas de fichier binaire. Sans
// middleware de parsing multipart ici, `express.json()`/`express.urlencoded()`
// (montés globalement dans app.js, mais qui ignorent le multipart) laissent
// `req.body` vide ; `getRequestParams` retombe alors sur une lecture brute du
// flux et tente un `JSON.parse` sur le corps multipart (boundaries compris),
// ce qui échoue systématiquement — `metas` n'est donc jamais récupéré, et
// `deleteFilesSchema.parse` (qui l'exige, non optionnel) rejette la requête
// à chaque appel. `upload.none()` (déjà configuré plus haut pour `/upload`)
// parse le multipart sans exiger de fichier et peuple `req.body.metas`
// normalement.
router.delete(
  "/delete",
  authMiddlewares.authVerifyMiddleware,
  upload.none(),
  async (req, res, next) => {
    try {
      res.json(await controllers.deleteFiles(req));
    } catch (err) {
      next(err);
    }
  },
);

// --------------------------------------------------------------------------
//   SIGNATURE NUMÉRIQUE DES PJ (cf. modules/files/sql/ATTACHMENTSIGNATURES.
//   table.sql, core/services/attachmentSigning.service.js)
// --------------------------------------------------------------------------
router.post(
  "/:filecode/sign",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.status(201).json(await controllers.signFileAttachment(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/:filecode/signatures",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getFileSignatures(req));
    } catch (err) {
      next(err);
    }
  },
);

// Routes fixes ("/signatures/...") déclarées après "/:filecode/..." mais
// sans ambiguïté pour Express : le préfixe diffère ("/signatures/:sigid/verify"
// vs "/:filecode/sign"/"/:filecode/signatures"), pas de collision de pattern.
router.get(
  "/signatures/:sigid/verify",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.verifyFileSignature(req));
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  "/signatures/:sigid",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.revokeFileSignature(req));
    } catch (err) {
      next(err);
    }
  },
);

export default router;
