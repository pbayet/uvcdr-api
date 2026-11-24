import fs from "node:fs/promises";
import path from "node:path";
import * as services from "./services.js";
import * as utils from "./utils.js";
import * as v from "./validators.js";
import * as extract from "./extract.js";
import * as requestUtils from "../../core/utils/request.utils.js";
import { StorageService } from "../../core/services/storage.service.js";
import { broadcastToAll } from "../../config/websocket/wsManager.js";
import { logger } from "../../config/logger.config.js";

/* ─────────────────────────────────────────────
   PROCS — Controllers (Procédures UVCDR)
   Responsabilité : valider les paramètres (zod), contrôler les droits,
   appeler le service, formater la réponse, tracer, notifier.

   Droits (cf. utils.getUserContext) :
     - tous les utilisateurs de l'application PROCS : recherche et lecture
       des procédures PUBLIÉES (version courante), accusé de lecture ;
     - rédacteurs (PRMNAM ∈ PROCS_EDITOR_PERMS, défaut MODIFY_PERMS =
       DEV, SUPERADMIN, ADMIN) : tout le reste (brouillons, archives,
       création, modification, versions, publication, suppression,
       catégories, journal de traçabilité, lecteurs).

   Traçabilité :
     - PROCHISTORY : chaque action d'un rédacteur (création, modification
       champ par champ, nouvelle version, publication…) ;
     - PROCCONSULTS : chaque ouverture / téléchargement d'un document ;
     - PROCACKS : accusés de lecture par version.
     Les requêtes mutantes sont aussi journalisées dans USERSACTIVITY (cf.
     core/config/activityLog.config.js).

   Fichiers : enregistrés comme les autres pièces jointes UNIS
   (StorageService → UPLOAD_PATH/PROCS/… + table ATTACHMENTS, APPCODE
   "PROCS", ENTITYTYPE "PROCVER" = document, "PROCPRV" = aperçu PDF).
   L'extraction du texte (recherche) et l'aperçu PDF sont faits en
   arrière-plan après la réponse (TEXTSTATUS = PENDING en attendant) ;
   l'évènement `procs.procedure.updated` prévient les clients à la fin.

   Temps réel : évènements légers `procs.*` (identifiants uniquement),
   routés vers l'application PROCS (cf. APPS_BY_EVENT_PREFIX).
───────────────────────────────────────────── */

const UPLOAD_PATH = process.env.UPLOAD_PATH;
const UPLOAD_TMP_PATH = process.env.UPLOAD_TMP_PATH || "tmp";

export const ENTITY_TYPES = { DOCUMENT: "PROCVER", PREVIEW: "PROCPRV" };

const PROCEDURE_FIELDS = ["REFCODE", "TITLE", "SUMMARY", "CATID", "OWNER", "REVIEWDAT", "KEYWORDS"];

const STATUS_ACTIONS = { PUBLISHED: "PUBLISH", ARCHIVED: "ARCHIVE", DRAFT: "UNPUBLISH" };

async function params(req, schema) {
  return schema.parse((await requestUtils.getRequestParams(req)).params);
}

function emit(type, payload) {
  try {
    broadcastToAll({ type, payload });
  } catch (err) {
    logger.warn(`[PROCS][WS] Diffusion "${type}" impossible : ${err.message}`);
  }
}

/** Journal de traçabilité — un incident ne bloque jamais l'action. */
async function trace(ctx, entry) {
  try {
    await services.addHistory({
      ...entry,
      USRID: ctx.USRID,
      USRNAM: ctx.USRNAM,
      DEVEMAIL: ctx.DEVEMAIL,
    });
  } catch (err) {
    logger.error(`[PROCS][HISTORY] ${entry.ACTION} #${entry.PRCID} non tracé : ${err.message}`);
  }
}

/** Résumé d'un texte de document pour le journal (le texte n'y est pas copié). */
function textSummary(text) {
  const n = String(text ?? "").trim().length;
  return n ? `${n.toLocaleString("fr-FR")} caractère${n > 1 ? "s" : ""}` : null;
}

async function loadProcedure(ctx, PRCID, opts) {
  const row = await services.getProcedure(ctx, PRCID, opts);
  if (!row) throw new Error("DATA_NOT_FOUND");
  return row;
}

async function buildProcedure(ctx, PRCID, opts) {
  const proc = utils.formatProcedure(await loadProcedure(ctx, PRCID, opts));
  const versions = (await services.getVersions(PRCID)).map(utils.formatVersion);
  // Lecteurs : liste des versions consultables, sans le suivi des lectures.
  if (!ctx.ISEDITOR) return { ...proc, VERSIONS: versions.map((ver) => ({ ...ver, ACKCOUNT: 0 })) };
  return { ...proc, VERSIONS: versions };
}

/* ─────────────────────────────────────────────
   Fichiers
───────────────────────────────────────────── */

/**
 * multer décode les noms de fichiers multipart en latin1 : on récupère
 * l'UTF-8 d'origine ("ProcÃ©dure.docx" → "Procédure.docx") quand c'est
 * possible.
 */
function decodeOriginalName(name) {
  const raw = String(name || "document");
  if (/[^\u0000-ÿ]/.test(raw)) return raw;
  const utf8 = Buffer.from(raw, "latin1").toString("utf8");
  return utf8.includes("�") ? raw : utf8;
}

/** Métadonnées du fichier reçu (avant enregistrement). */
function describeUpload(file) {
  if (!file?.path) throw utils.httpError(400, "Le document (Word ou PDF) est obligatoire.");
  const ORIGINALNAME = decodeOriginalName(file.originalname).slice(0, 255);
  const EXTENSION = path.extname(ORIGINALNAME).replace(".", "").toLowerCase();
  if (!extract.ALLOWED_EXTENSIONS.includes(EXTENSION)) {
    throw utils.httpError(
      400,
      `Format non accepté (.${EXTENSION || "?"}). Formats acceptés : ${extract.ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(", ")}.`,
    );
  }
  return {
    ORIGINALNAME,
    EXTENSION,
    MIMETYPE: file.mimetype || null,
    SIZEBYTES: file.size ?? null,
  };
}

/** Supprime le fichier temporaire multer s'il est encore là (échec). */
async function discardUpload(file) {
  if (file?.path) await fs.rm(file.path, { force: true }).catch(() => {});
}

function storage() {
  if (!UPLOAD_PATH) throw new Error("UPLOAD_PATH non configuré.");
  return new StorageService({ rootDir: UPLOAD_PATH });
}

/** Enregistre le document d'une version (UPLOAD_PATH + ATTACHMENTS). */
async function storeVersionFile(ctx, VERID, file, ORIGINALNAME) {
  const meta = await storage().saveUploadedFile({
    appCode: utils.APP_CODE,
    file: { ...file, originalname: ORIGINALNAME },
    entityType: ENTITY_TYPES.DOCUMENT,
    entityId: String(VERID),
    uploadedBy: ctx.USRNAM.slice(0, 100),
    ignoreIfExist: false,
  });
  await services.attachVersionFile(VERID, {
    FILECODE: meta.FILECODE,
    CHECKSUM: meta.CHECKSUMSHA256,
    SIZEBYTES: meta.SIZEBYTES,
  });
  return meta;
}

/** Chemin absolu d'un fichier déposé, borné à UPLOAD_PATH. */
function resolveStoredPath(relativePath) {
  const root = path.resolve(UPLOAD_PATH);
  const abs = path.resolve(root, relativePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error("ACCESS_DENIED_WO_LOGOUT");
  return abs;
}

/**
 * Extraction du texte + aperçu PDF d'une version, en arrière-plan. Ne lève
 * jamais : TEXTSTATUS reflète le résultat (OK / EMPTY / UNSUPPORTED / ERROR).
 * `MANUALTEXT` (texte saisi à la création) remplace le texte extrait ; le
 * document est tout de même analysé (nombre de pages, aperçu PDF).
 */
async function processVersionContent({ PRCID, VERID, RELATIVEPATH, EXTENSION, ORIGINALNAME, USRNAM, MANUALTEXT }) {
  try {
    const absPath = resolveStoredPath(RELATIVEPATH);

    const { status, text, pages } = await extract.extractDocumentText(absPath, EXTENSION);
    await services.setVersionText(
      VERID,
      MANUALTEXT
        ? { TEXTSTATUS: "OK", CONTENTTEXT: MANUALTEXT, PAGES: pages }
        : { TEXTSTATUS: status, CONTENTTEXT: text, PAGES: pages },
    );

    if (extract.needsPreview(EXTENSION)) {
      const preview = await extract.generatePdfPreview(absPath);
      if (preview) {
        try {
          // Copie dans le dossier temporaire des uploads (même volume que
          // UPLOAD_PATH, en général) : StorageService le déplace ensuite.
          await fs.mkdir(path.resolve(UPLOAD_TMP_PATH), { recursive: true });
          const tmpPdf = path.resolve(UPLOAD_TMP_PATH, `${Date.now()}-procs-preview-${VERID}.pdf`);
          await fs.copyFile(preview.pdfPath, tmpPdf);
          const stat = await fs.stat(tmpPdf);
          const meta = await storage().saveUploadedFile({
            appCode: utils.APP_CODE,
            file: {
              path: tmpPdf,
              originalname: `${path.parse(ORIGINALNAME).name}.pdf`,
              mimetype: "application/pdf",
              size: stat.size,
            },
            entityType: ENTITY_TYPES.PREVIEW,
            entityId: String(VERID),
            uploadedBy: (USRNAM || "").slice(0, 100),
            ignoreIfExist: false,
          });
          await services.setVersionPreview(VERID, meta.FILECODE);
        } finally {
          await fs.rm(preview.dir, { recursive: true, force: true }).catch(() => {});
        }
      }
    }
  } catch (err) {
    logger.error(`[PROCS][PROCESS] Version #${VERID} : ${err.message}`);
    await services
      .setVersionText(
        VERID,
        MANUALTEXT
          ? { TEXTSTATUS: "OK", CONTENTTEXT: MANUALTEXT, PAGES: null }
          : { TEXTSTATUS: "ERROR", CONTENTTEXT: null, PAGES: null },
      )
      .catch(() => {});
  } finally {
    emit("procs.procedure.updated", { PRCID, VERID });
  }
}

/* ─────────────────────────────────────────────
   Profil
───────────────────────────────────────────── */

export async function getMe(req) {
  const ctx = utils.getUserContext(req);
  return { EDITOR: ctx.ISEDITOR };
}

/* ─────────────────────────────────────────────
   Procédures
───────────────────────────────────────────── */

export async function getProcedures(req) {
  const ctx = utils.getUserContext(req);
  const filters = await params(req, v.procedureListQuerySchema);
  if (!ctx.ISEDITOR) {
    delete filters.STATUS;
    delete filters.OVERDUE;
    delete filters.DLTD;
  }
  const rows = await services.listProcedures(ctx, filters);
  return rows.map(utils.formatProcedure);
}

export async function getProcedure(req) {
  const ctx = utils.getUserContext(req);
  const { prcid } = await params(req, v.prcidParamSchema);
  return buildProcedure(ctx, prcid, { includeDeleted: true });
}

/** Texte extrait d'une version (version courante par défaut). */
export async function getProcedureText(req) {
  const ctx = utils.getUserContext(req);
  const { prcid, VERID } = await params(req, v.textQuerySchema);
  const proc = await loadProcedure(ctx, prcid, { includeDeleted: true });

  const target = VERID ?? proc.CURVERID;
  if (!target) throw new Error("DATA_NOT_FOUND");
  if (target !== proc.CURVERID) {
    utils.assertEditor(ctx);
    const version = await services.getVersion(target);
    if (!version || version.PRCID !== prcid) throw new Error("DATA_NOT_FOUND");
  }

  const row = await services.getVersionText(target);
  return { VERID: target, TEXTSTATUS: row?.TEXTSTATUS ?? "PENDING", TEXT: row?.CONTENTTEXT ?? "" };
}

export async function createProcedure(req) {
  const ctx = utils.getUserContext(req);
  try {
    utils.assertEditor(ctx);
    const data = await params(req, v.procedureCreateSchema);
    const file = describeUpload(req.file);

    if (!(await services.getCategory(data.CATID))) throw new Error("DATA_NOT_FOUND");

    // Référence générée d'après la catégorie racine (PROC-QUA-001), figée ensuite.
    const REFPREFIX = utils.refcodePrefix(await services.getRootCategoryName(data.CATID));
    const { PRCID, VERID, REFCODE } = await services.createProcedure({ ...data, REFPREFIX }, file, ctx.USRID);

    let stored;
    try {
      stored = await storeVersionFile(ctx, VERID, req.file, file.ORIGINALNAME);
    } catch (err) {
      await services.purgeProcedure(PRCID).catch(() => {});
      throw err;
    }

    await trace(ctx, {
      PRCID,
      VERID,
      ACTION: "CREATE",
      DETAILS: {
        REFCODE,
        TITLE: data.TITLE,
        VERNUM: 1,
        FILE: file.ORIGINALNAME,
        CHECKSUM: stored.CHECKSUMSHA256,
        COMMENT: data.COMMENT ?? null,
        ...(data.CONTENTTEXT ? { CONTENTTEXT: textSummary(data.CONTENTTEXT) } : {}),
      },
    });

    if (data.PUBLISH) {
      await services.setStatus(PRCID, "PUBLISHED", ctx.USRID);
      await trace(ctx, { PRCID, VERID, ACTION: "PUBLISH", DETAILS: { VERNUM: 1 } });
    }

    void processVersionContent({
      PRCID,
      VERID,
      RELATIVEPATH: stored.RELATIVEPATH,
      EXTENSION: file.EXTENSION,
      ORIGINALNAME: file.ORIGINALNAME,
      USRNAM: ctx.USRNAM,
      MANUALTEXT: data.CONTENTTEXT || null,
    });

    emit("procs.procedure.created", { PRCID });
    return buildProcedure(ctx, PRCID);
  } finally {
    await discardUpload(req.file);
  }
}

export async function updateProcedure(req) {
  const ctx = utils.getUserContext(req);
  utils.assertEditor(ctx);
  const { prcid } = await params(req, v.prcidParamSchema);
  const data = await params(req, v.procedureUpdateSchema);

  const before = await services.getProcedureRow(prcid);
  if (!before || before.DLTD) throw new Error("DATA_NOT_FOUND");

  if (data.CATID && !(await services.getCategory(data.CATID))) throw new Error("DATA_NOT_FOUND");

  const changes = utils.diffFields(
    { ...before, KEYWORDS: await services.getKeywords(prcid) },
    data,
    PROCEDURE_FIELDS,
  );

  // Texte de la version en vigueur saisi à la main (remplace le texte extrait).
  let textChanged = false;
  if (data.CONTENTTEXT !== undefined && before.CURVERID) {
    const current = (await services.getVersionText(before.CURVERID))?.CONTENTTEXT ?? "";
    if (current.replace(/\r\n/g, "\n").trim() !== data.CONTENTTEXT) {
      textChanged = true;
      changes.CONTENTTEXT = { from: textSummary(current), to: textSummary(data.CONTENTTEXT) };
    }
  }
  if (!Object.keys(changes).length) return buildProcedure(ctx, prcid);

  if (textChanged) await services.setVersionContentText(before.CURVERID, data.CONTENTTEXT);
  await services.updateProcedure(prcid, data, ctx.USRID);
  await trace(ctx, { PRCID: prcid, VERID: before.CURVERID, ACTION: "UPDATE", DETAILS: changes });

  emit("procs.procedure.updated", { PRCID: prcid });
  return buildProcedure(ctx, prcid);
}

export async function setProcedureStatus(req) {
  const ctx = utils.getUserContext(req);
  utils.assertEditor(ctx);
  const { prcid } = await params(req, v.prcidParamSchema);
  const { STATUS, COMMENT } = await params(req, v.procedureStatusSchema);

  const before = await services.getProcedureRow(prcid);
  if (!before || before.DLTD) throw new Error("DATA_NOT_FOUND");
  if (before.STATUS === STATUS) return buildProcedure(ctx, prcid);
  if (STATUS === "PUBLISHED" && !before.CURVERID) {
    throw utils.httpError(409, "Impossible de publier une procédure sans document.");
  }

  await services.setStatus(prcid, STATUS, ctx.USRID);
  await trace(ctx, {
    PRCID: prcid,
    VERID: before.CURVERID,
    ACTION: STATUS_ACTIONS[STATUS],
    DETAILS: { from: before.STATUS, to: STATUS, COMMENT: COMMENT ?? null },
  });

  emit("procs.procedure.updated", { PRCID: prcid });
  return buildProcedure(ctx, prcid);
}

/** Suppression logique (corbeille) ou restauration (DLTD = false). */
export async function deleteProcedure(req) {
  const ctx = utils.getUserContext(req);
  utils.assertEditor(ctx);
  const { prcid } = await params(req, v.prcidParamSchema);
  const { DLTD } = await params(req, v.procedureDeleteSchema);

  const before = await services.getProcedureRow(prcid);
  if (!before) throw new Error("DATA_NOT_FOUND");
  if (!!before.DLTD === DLTD) return { PRCID: prcid, DLTD };

  if (!DLTD && (await services.isRefcodeTaken(before.REFCODE, prcid))) {
    throw utils.httpError(
      409,
      `Restauration impossible : la référence « ${before.REFCODE} » a été réutilisée par une autre procédure.`,
    );
  }

  await services.setDeleted(prcid, DLTD, ctx.USRID);
  await trace(ctx, { PRCID: prcid, ACTION: DLTD ? "DELETE" : "RESTORE", DETAILS: { STATUS: before.STATUS } });

  emit(DLTD ? "procs.procedure.deleted" : "procs.procedure.updated", { PRCID: prcid });
  return { PRCID: prcid, DLTD };
}

/* ─────────────────────────────────────────────
   Versions
───────────────────────────────────────────── */

export async function addVersion(req) {
  const ctx = utils.getUserContext(req);
  try {
    utils.assertEditor(ctx);
    const { prcid } = await params(req, v.prcidParamSchema);
    const { COMMENT, PUBLISH } = await params(req, v.versionCreateSchema);
    const file = describeUpload(req.file);

    const before = await services.getProcedureRow(prcid);
    if (!before || before.DLTD) throw new Error("DATA_NOT_FOUND");

    const { VERID, VERNUM } = await services.createVersion(prcid, file, COMMENT, ctx.USRID);

    let stored;
    try {
      stored = await storeVersionFile(ctx, VERID, req.file, file.ORIGINALNAME);
    } catch (err) {
      await services.deleteVersion(VERID).catch(() => {});
      throw err;
    }

    await services.setCurrentVersion(prcid, VERID, ctx.USRID);
    await trace(ctx, {
      PRCID: prcid,
      VERID,
      ACTION: "NEW_VERSION",
      DETAILS: {
        VERNUM,
        PREVIOUSVERID: before.CURVERID ?? null,
        FILE: file.ORIGINALNAME,
        CHECKSUM: stored.CHECKSUMSHA256,
        COMMENT: COMMENT ?? null,
      },
    });

    if (PUBLISH && before.STATUS !== "PUBLISHED") {
      await services.setStatus(prcid, "PUBLISHED", ctx.USRID);
      await trace(ctx, {
        PRCID: prcid,
        VERID,
        ACTION: "PUBLISH",
        DETAILS: { from: before.STATUS, to: "PUBLISHED", VERNUM },
      });
    }

    void processVersionContent({
      PRCID: prcid,
      VERID,
      RELATIVEPATH: stored.RELATIVEPATH,
      EXTENSION: file.EXTENSION,
      ORIGINALNAME: file.ORIGINALNAME,
      USRNAM: ctx.USRNAM,
    });

    emit("procs.procedure.updated", { PRCID: prcid, VERID });
    return buildProcedure(ctx, prcid);
  } finally {
    await discardUpload(req.file);
  }
}

/** Revient à une version antérieure (elle redevient la version courante). */
export async function restoreVersion(req) {
  const ctx = utils.getUserContext(req);
  utils.assertEditor(ctx);
  const { verid } = await params(req, v.veridParamSchema);
  const { COMMENT } = await params(req, v.versionRestoreSchema);

  const version = await services.getVersion(verid);
  if (!version || !version.FILECODE) throw new Error("DATA_NOT_FOUND");
  const before = await services.getProcedureRow(version.PRCID);
  if (!before || before.DLTD) throw new Error("DATA_NOT_FOUND");
  if (before.CURVERID === verid) return buildProcedure(ctx, version.PRCID);

  await services.setCurrentVersion(version.PRCID, verid, ctx.USRID);
  await trace(ctx, {
    PRCID: version.PRCID,
    VERID: verid,
    ACTION: "RESTORE_VERSION",
    DETAILS: { VERNUM: version.VERNUM, PREVIOUSVERID: before.CURVERID, COMMENT: COMMENT ?? null },
  });

  emit("procs.procedure.updated", { PRCID: version.PRCID, VERID: verid });
  return buildProcedure(ctx, version.PRCID);
}

/** Relance l'extraction du texte / l'aperçu d'une version (ex: LibreOffice installé depuis). */
export async function reindexVersion(req) {
  const ctx = utils.getUserContext(req);
  utils.assertEditor(ctx);
  const { verid } = await params(req, v.veridParamSchema);

  const version = await services.getVersion(verid);
  if (!version?.FILECODE) throw new Error("DATA_NOT_FOUND");
  const att = await services.getAttachment(version.FILECODE);
  if (!att) throw new Error("DATA_NOT_FOUND");

  await services.setVersionText(verid, { TEXTSTATUS: "PENDING", CONTENTTEXT: null, PAGES: null });
  await trace(ctx, { PRCID: version.PRCID, VERID: verid, ACTION: "REINDEX", DETAILS: { VERNUM: version.VERNUM } });

  void processVersionContent({
    PRCID: version.PRCID,
    VERID: verid,
    RELATIVEPATH: att.RELATIVEPATH,
    EXTENSION: version.EXTENSION,
    ORIGINALNAME: version.ORIGINALNAME,
    USRNAM: ctx.USRNAM,
  });

  return { VERID: verid, TEXTSTATUS: "PENDING" };
}

/**
 * Envoie le document d'une version (ou son aperçu PDF) et trace la
 * consultation. Lecteurs : version courante d'une procédure publiée
 * uniquement. Réponse binaire : gérée hors du helper `route` de routes.js.
 */
export async function sendVersionFile(req, res) {
  const ctx = utils.getUserContext(req);
  const { verid } = await params(req, v.veridParamSchema);
  const { DISPOSITION, KIND } = await params(req, v.fileQuerySchema);

  const version = await services.getVersion(verid);
  if (!version) throw new Error("DATA_NOT_FOUND");
  // Visibilité contrôlée par loadProcedure (lecteurs : procédure publiée et
  // catégorie active) ; toutes les versions d'une procédure visible se consultent.
  await loadProcedure(ctx, version.PRCID, { includeDeleted: true });

  await streamVersionFile(res, { version, KIND, DISPOSITION, USRID: ctx.USRID });
}

/**
 * Envoie le fichier d'une version (document d'origine ou aperçu PDF) et trace
 * la consultation au nom de `USRID`. `DISPOSITION` absente : le PDF s'ouvre
 * dans le navigateur, les autres formats se téléchargent.
 */
async function streamVersionFile(res, { version, KIND, DISPOSITION, USRID }) {
  const code = KIND === "preview" ? version.PREVIEWCODE : version.FILECODE;
  if (!code) throw new Error("DATA_NOT_FOUND");
  const att = await services.getAttachment(code);
  if (!att) throw new Error("DATA_NOT_FOUND");

  const absPath = resolveStoredPath(att.RELATIVEPATH);
  await fs.access(absPath).catch(() => {
    throw new Error("DATA_NOT_FOUND");
  });

  const filename = utils.versionFileName(version, KIND);
  const mimetype = att.MIMETYPE || "application/octet-stream";
  const disposition = DISPOSITION ?? (mimetype === "application/pdf" ? "inline" : "attachment");

  services
    .addConsult({
      PRCID: version.PRCID,
      VERID: version.VERID,
      USRID,
      KIND: disposition === "attachment" ? "DOWNLOAD" : "VIEW",
    })
    .catch((err) => logger.warn(`[PROCS][CONSULT] non tracée : ${err.message}`));

  res.setHeader("Content-Type", mimetype);
  res.setHeader("Content-Disposition", utils.contentDisposition(disposition, filename));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  await new Promise((resolve, reject) =>
    res.sendFile(absPath, (err) => (err ? reject(err) : resolve())),
  );
}

/* ─────────────────────────────────────────────
   Lecture : accusé, lecteurs, journal
───────────────────────────────────────────── */

export async function acknowledgeProcedure(req) {
  const ctx = utils.getUserContext(req);
  const { prcid } = await params(req, v.prcidParamSchema);
  const proc = await loadProcedure(ctx, prcid);
  if (!proc.CURVERID) throw new Error("DATA_NOT_FOUND");

  await services.acknowledge(prcid, proc.CURVERID, ctx.USRID);
  emit("procs.procedure.acknowledged", { PRCID: prcid, USRID: ctx.USRID });
  return { PRCID: prcid, VERID: proc.CURVERID, ACKED: true };
}

export async function getProcedureReaders(req) {
  const ctx = utils.getUserContext(req);
  utils.assertEditor(ctx);
  const { prcid } = await params(req, v.prcidParamSchema);
  await loadProcedure(ctx, prcid, { includeDeleted: true });
  return (await services.getReaders(prcid)).map(utils.formatReader);
}

export async function getProcedureHistory(req) {
  const ctx = utils.getUserContext(req);
  utils.assertEditor(ctx);
  const { prcid } = await params(req, v.prcidParamSchema);
  return (await services.getHistory({ PRCID: prcid, LIMIT: 1000 })).map(utils.formatHistory);
}

/** Journal global (page Traçabilité). */
export async function getHistory(req) {
  const ctx = utils.getUserContext(req);
  utils.assertEditor(ctx);
  const filters = await params(req, v.historyQuerySchema);
  return (await services.getHistory(filters)).map(utils.formatHistory);
}

export async function getStats(req) {
  const ctx = utils.getUserContext(req);
  utils.assertEditor(ctx);
  return services.getStats();
}

/* ─────────────────────────────────────────────
   Catégories
───────────────────────────────────────────── */

export async function getCategories(req) {
  const ctx = utils.getUserContext(req);
  const { ALL } = await params(req, v.categoryListQuerySchema);
  const rows = await services.getCategories(ctx, { includeInactive: ctx.ISEDITOR && !!ALL });
  return rows.map(utils.formatCategory);
}

/** Arborescence : MAX_CATEGORY_DEPTH (3) niveaux au plus, sans cycle. */
async function assertValidParent(PARENTID, CATID = null) {
  if (!PARENTID) return;
  const error = utils.checkCategoryPlacement(await services.getCategoryLinks(), CATID, PARENTID);
  if (error === "NOT_FOUND") throw new Error("DATA_NOT_FOUND");
  if (error) throw utils.httpError(400, error);
}

export async function createCategory(req) {
  const ctx = utils.getUserContext(req);
  utils.assertEditor(ctx);
  const data = await params(req, v.categoryCreateSchema);
  await assertValidParent(data.PARENTID);

  const CATID = await services.createCategory(data, ctx.USRID);
  emit("procs.categories.updated", { CATID });
  return utils.formatCategory({ ...(await services.getCategory(CATID)), PROCCOUNT: 0 });
}

export async function updateCategory(req) {
  const ctx = utils.getUserContext(req);
  utils.assertEditor(ctx);
  const { catid } = await params(req, v.catidParamSchema);
  const data = await params(req, v.categoryUpdateSchema);

  if (!(await services.getCategory(catid))) throw new Error("DATA_NOT_FOUND");
  if (data.PARENTID !== undefined) await assertValidParent(data.PARENTID, catid);

  await services.updateCategory(catid, data, ctx.USRID);
  emit("procs.categories.updated", { CATID: catid });
  return utils.formatCategory(await services.getCategory(catid));
}

/**
 * Suppression définitive d'une catégorie inutilisée : ni procédure (même
 * à la corbeille), ni sous-catégorie. Sinon 409 — la désactiver à la place.
 */
export async function deleteCategory(req) {
  const ctx = utils.getUserContext(req);
  utils.assertEditor(ctx);
  const { catid } = await params(req, v.catidParamSchema);

  const category = await services.getCategory(catid);
  if (!category) throw new Error("DATA_NOT_FOUND");

  const error = utils.categoryDeleteError(await services.getCategoryUsage(catid));
  if (error) throw utils.httpError(409, `Impossible de supprimer « ${category.NAME} » : ${error}`);

  await services.deleteCategory(catid);
  emit("procs.categories.updated", { CATID: catid });
  return { CATID: catid };
}
