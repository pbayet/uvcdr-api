import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";

/* ─────────────────────────────────────────────
   VINIDOC — Réception multipart
   Même stockage temporaire que modules/files (UPLOAD_TMP_PATH, purgé par
   startTmpPurgeCron) avec liste blanche d'extensions par usage :
     - modèle PowerPoint : champ "file", .pptx uniquement ;
     - photo de génération : champ "photo", image.
   Les fichiers ne passent PAS par /api/files/upload : ils sont reçus dans
   la même requête que l'action métier, ce qui permet de contrôler les
   droits avant tout enregistrement (même choix que declcav/audits).
───────────────────────────────────────────── */

const MB = 1024 * 1024;
export const TEMPLATE_MAX_SIZE = (Number(process.env.VINIDOC_TEMPLATE_MAX_MB) || 30) * MB;
export const PHOTO_MAX_SIZE = 15 * MB;

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
    cb(null, `${unique}-vinidoc${path.extname(file.originalname).toLowerCase()}`);
  },
});

function extensionFilter(allowed) {
  return (req, file, cb) => {
    const ext = path.extname(file.originalname || "").slice(1).toLowerCase();
    if (!allowed.includes(ext)) {
      const err = new Error(
        `Format de fichier non autorisé (.${ext || "?"}). Formats acceptés : ${allowed.join(", ")}.`,
      );
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  };
}

/** Enveloppe multer : erreurs multer → erreurs HTTP explicites. */
function wrap(middleware, maxSize) {
  return (req, res, next) =>
    middleware(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        const e = new Error(
          err.code === "LIMIT_FILE_SIZE"
            ? `Fichier trop volumineux (${maxSize / MB} Mo max).`
            : `Envoi de fichier invalide (${err.code}).`,
        );
        e.status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        return next(e);
      }
      next(err);
    });
}

export const templateFileUpload = wrap(
  multer({
    storage,
    fileFilter: extensionFilter(["pptx"]),
    limits: { fileSize: TEMPLATE_MAX_SIZE, files: 1 },
  }).single("file"),
  TEMPLATE_MAX_SIZE,
);

export const photoUpload = wrap(
  multer({
    storage,
    fileFilter: extensionFilter(["png", "jpg", "jpeg", "webp"]),
    limits: { fileSize: PHOTO_MAX_SIZE, files: 1 },
  }).single("photo"),
  PHOTO_MAX_SIZE,
);

/** Multipart sans fichier (le front envoie certains DELETE en multipart). */
export const fieldsOnly = multer().none();

/** Supprime les fichiers temporaires multer non consommés. */
export async function cleanupTmpFiles(req) {
  const files = [req?.file, ...(req?.files ?? [])].filter(Boolean);
  await Promise.all(files.map((f) => (f.path ? fs.unlink(f.path).catch(() => {}) : null)));
}
