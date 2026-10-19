import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";

/* ─────────────────────────────────────────────
   AUDITS — Réception multipart des documents
   Même stockage temporaire que modules/files/routes.js (UPLOAD_TMP_PATH,
   purgé par startTmpPurgeCron), mais avec une liste blanche d'extensions :
   ces documents sont échangés avec des tiers (caves) et téléchargés par la
   Qualité, on n'accepte que des formats bureautiques/images attendus.
   Les fichiers ne sont PAS envoyés via /api/files/upload : ils sont
   rattachés dans la même requête que l'action métier (création, version,
   retour), ce qui permet de contrôler les droits (cave propriétaire /
   service Qualité) avant tout enregistrement — /files/upload n'applique
   aucun contrôle de ce type sur ENTITYTYPE/ENTITYID.
───────────────────────────────────────────── */

export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 Mo / fichier
export const MAX_FILES = 10;

export const ALLOWED_EXTENSIONS = [
  "pdf", "doc", "docx", "xls", "xlsx", "odt", "ods", "csv", "txt",
  "png", "jpg", "jpeg", "zip",
];

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
    cb(null, `${unique}-audit${path.extname(file.originalname).toLowerCase()}`);
  },
});

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || "").slice(1).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    const err = new Error(
      `Format de fichier non autorisé (.${ext || "?"}). Formats acceptés : ${ALLOWED_EXTENSIONS.join(", ")}.`,
    );
    err.status = 400;
    return cb(err);
  }
  cb(null, true);
}

const multerInstance = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
});

/**
 * Middleware `files[]` (0..MAX_FILES) ; traduit les erreurs multer en
 * erreurs HTTP explicites (sinon remontées en 500 par errorHandler).
 */
export function auditFilesUpload(req, res, next) {
  multerInstance.array("files", MAX_FILES)(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const e = new Error(
        err.code === "LIMIT_FILE_SIZE"
          ? `Fichier trop volumineux (${MAX_FILE_SIZE / 1024 / 1024} Mo max).`
          : err.code === "LIMIT_FILE_COUNT"
            ? `${MAX_FILES} fichiers maximum par envoi.`
            : `Envoi de fichiers invalide (${err.code}).`,
      );
      e.status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return next(e);
    }
    next(err);
  });
}

/** Supprime les fichiers temporaires multer non consommés (erreur, rejet). */
export async function cleanupTmpFiles(files = []) {
  await Promise.all(
    (files || []).map((f) =>
      f?.path ? fs.unlink(f.path).catch(() => {}) : Promise.resolve(),
    ),
  );
}

/** Multipart sans fichier (champs texte seuls), ex. DELETE avec motif. */
export const auditFieldsOnly = multer().none();
