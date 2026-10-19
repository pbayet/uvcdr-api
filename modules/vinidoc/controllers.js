import fsp from "node:fs/promises";
import path from "node:path";
import { ulid } from "ulid";

import * as services from "./services.js";
import * as utils from "./utils.js";
import * as v from "./validators.js";
import * as notify from "./notifications.js";
import { OoxmlTemplate } from "./engine/ooxml-engine.js";
import { convertPptxToPdf } from "./engine/pdf-converter.js";
import * as fileServices from "../files/services.js";
import { StorageService } from "../../core/services/storage.service.js";
import * as requestUtils from "../../core/utils/request.utils.js";
import { broadcastToAll } from "../../config/websocket/wsManager.js";
import { logger } from "../../config/logger.config.js";
import { ERROR_REGISTRY } from "../../core/utils/error.registry.js";

/* ═══════════════════════════════════════════════════════════════
   VINIDOC — Controllers
   Responsabilité : droits, validation zod, orchestration services /
   moteur de génération / fichiers, notifications.

   Droits (cf. utils.js — services configurables par variables d'env) :
     lecture, contrôle, génération : tout utilisateur VINIDOC
     saisie, traduction, soumission : œnologie (VINIDOC_EDITOR_SERVICES)
     validation / refus              : marketing (VINIDOC_VALIDATOR_SERVICES)
     correction pendant la relecture : marketing, fiche SUBMITTED (reste SUBMITTED)
     modèles PowerPoint              : VINIDOC_TEMPLATE_SERVICES
     + profils MODIFY_PERMS partout.

   Génération : TOUJOURS à partir de la dernière version validée
   (SHEETVERS), jamais des données en cours de saisie — c'est ce qui
   garantit que seul un contenu validé par le marketing est diffusé.
═══════════════════════════════════════════════════════════════ */

const APP_CODE = process.env.DB_APP_CODE_VINIDOC || "VINDOC";
const UPLOAD_ROOT = process.env.UPLOAD_PATH || "uploads";
const TMP_ROOT = process.env.UPLOAD_TMP_PATH || "tmp";
const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const ENTITY_TEMPLATE = "TEMPLATE"; // ATTACHMENTS.ENTITYID = TEMPLATES.TPLKEY
const ENTITY_GENERATION = "GENERATION"; // ATTACHMENTS.ENTITYID = SHTID

const storage = () => new StorageService({ rootDir: UPLOAD_ROOT });

/** Corps + query (les paramètres de chemin sont lus à part, via req.params). */
const input = async (req) =>
  (await requestUtils.getRequestParams(req)).params ?? {};

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

const fileUrl = (relativePath) =>
  relativePath
    ? `${process.env.API_BASE_UPLOAD_URL ?? ""}/${String(relativePath).replace(/\\/g, "/")}`
    : null;

async function discardFile(FILECODE) {
  if (!FILECODE) return;
  await fileServices
    .deleteFileByCode(FILECODE)
    .catch((e) =>
      logger.error(
        `[VINIDOC] Compensation fichier ${FILECODE} impossible : ${e.message}`,
      ),
    );
}

function emitSheet(type, state) {
  broadcastToAll({
    type,
    payload: {
      SHTID: state?.SHTID,
      STATUS: state?.STATUS,
      LASTVER: state?.LASTVER,
    },
  });
}

/** Retour standard d'une écriture sur fiche (état + nouveau ROWVER). */
const sheetState = (row) => ({
  SHTID: row.SHTID,
  STATUS: row.STATUS,
  LASTVER: row.LASTVER,
  ROWVER: utils.rowverToHex(row.ROWVER),
});

async function getLanguages() {
  return requestUtils.getCachedResult(
    "vinidoc.languages",
    () => services.getLanguages(),
    5 * 60 * 1000,
  );
}

async function getDefaultLanguage() {
  const lng = (await getLanguages()).find((l) => l.ISDEFAULT)?.LNGCOD;
  if (!lng) throw new Error("VINIDOC_DEFAULT_LANGUAGE_MISSING");
  return lng;
}

async function getSheetOrThrow(SHTID) {
  const sheet = await services.getSheet(SHTID);
  if (!sheet) throw new Error("VINIDOC_SHEET_NOT_FOUND");
  return sheet;
}

/* ═════════════════════════════ Référentiels ═════════════════════════════ */

/** Droits de l'utilisateur + référentiels : de quoi initialiser le front. */
export async function getMe(req) {
  utils.assertVinidocApp(req);
  const [LANGUAGES, COLORS] = await Promise.all([
    getLanguages(),
    services.getColors(),
  ]);
  return {
    RIGHTS: utils.getRights(req),
    DEFAULT_LNGCOD: LANGUAGES.find((l) => l.ISDEFAULT)?.LNGCOD ?? null,
    LANGUAGES,
    COLORS,
  };
}

/**
 * Catalogue des balises de fusion. Pour chaque balise texte : longueur max
 * la plus stricte parmi les modèles actifs (MAXLEN) et le détail par modèle
 * (LIMITS) — à utiliser comme maxLength / compteur dans les formulaires.
 */
export async function getMergeFields(req) {
  utils.assertVinidocApp(req);
  const { LNGCOD } = v.mergeFieldsQuery.parse(await input(req));
  const rows = await services.getTextTagLimits(LNGCOD ?? null);

  const TEXT = utils.TEXT_FIELDS.map((f) => {
    const LIMITS = rows
      .filter((r) => r.TAGNAM === f.TAG)
      .map((r) => ({
        TPLID: r.TPLID,
        TPLNAM: r.TPLNAM,
        MAXLEN: r.MAXLEN,
        REQUIRED: !!r.REQUIRED,
      }));
    const maxima = LIMITS.map((l) => l.MAXLEN).filter((m) => m != null);
    const { FIELD, ...field } = f;
    return {
      ...field,
      SHEETFIELD: FIELD ?? null,
      MAXLEN: maxima.length ? Math.min(...maxima) : null,
      LIMITS,
    };
  });

  return { TEXT, BADGES: utils.BADGE_PATTERNS, IMAGES: utils.IMAGE_FIELDS };
}

/* ═════════════════════════════ Fiches — lecture ═════════════════════════════ */

/** Message lisible d'une erreur métier (clé du registre) ou technique. */
const errorMessage = (err) =>
  ERROR_REGISTRY[err?.message]?.MESSAGE?.fr ?? err?.message ?? "Erreur inconnue.";

/** Libellé court d'une balise texte (« Dégustation (œil, nez…) » → « Dégustation »). */
const tagLabel = (TAGNAM) =>
  utils.TEXT_FIELDS.find((f) => f.TAG === TAGNAM)?.LABEL.split(" (")[0] ?? TAGNAM;

/**
 * Anomalies de saisie de chaque fiche (données en cours) : traduction de la
 * langue par défaut absente, textes trop longs ou balises obligatoires vides
 * au regard des modèles actifs de chaque langue saisie. Mêmes règles que
 * POST /sheets/:SHTID/check, sur plusieurs fiches à la fois.
 * @returns {Promise<Map<number, string[]>>} SHTID → messages
 */
async function sheetsIssues(sheets) {
  if (!sheets.length) return new Map();
  const [defaultLng, tagRows, colors] = await Promise.all([
    getDefaultLanguage(),
    services.getTextTagLimits(null),
    services.getColors(),
  ]);
  const templates = groupTagsByTemplate(tagRows).map((t) => ({
    ...t,
    TPLLNG: t.TAGS[0]?.TPLLNG ?? null,
  }));

  const out = new Map();
  for (const sheet of sheets) {
    const issues = [];
    if (!sheet.TRANSLATIONS[defaultLng]) {
      issues.push(`[${defaultLng.toUpperCase()}] Traduction de la langue par défaut absente.`);
    }
    for (const lng of Object.keys(sheet.TRANSLATIONS)) {
      const color = colors.find((c) => c.COLCOD === sheet.COLCOD)?.LABELS[lng] ?? {};
      const { text } = utils.buildMergeData(sheet, lng, color);
      // Une anomalie par balise : limite la plus stricte, modèles concernés.
      const byTag = new Map();
      for (const tpl of templates.filter((t) => !t.TPLLNG || t.TPLLNG === lng)) {
        for (const e of utils.checkAgainstTemplate(text, tpl.TAGS).ERRORS) {
          const key = `${e.ISSUE}|${e.TAGNAM}`;
          const cur = byTag.get(key) ?? { ...e, TEMPLATES: [] };
          if (e.MAXLEN != null && (cur.MAXLEN == null || e.MAXLEN < cur.MAXLEN)) cur.MAXLEN = e.MAXLEN;
          cur.TEMPLATES.push(tpl.TPLNAM);
          byTag.set(key, cur);
        }
      }
      for (const e of byTag.values()) {
        const where = `[${lng.toUpperCase()}] ${tagLabel(e.TAGNAM)}`;
        const tpls = `modèle${e.TEMPLATES.length > 1 ? "s" : ""} ${e.TEMPLATES.join(", ")}`;
        issues.push(
          e.ISSUE === "TOO_LONG"
            ? `${where} : texte trop long (${e.LENGTH} caractères, ${e.MAXLEN} max — ${tpls}).`
            : `${where} : obligatoire (${tpls}).`,
        );
      }
    }
    out.set(sheet.SHTID, issues);
  }
  return out;
}

/** Liste paginée ; chaque fiche porte ses anomalies de saisie (ISSUES). */
export async function listSheets(req) {
  utils.assertVinidocApp(req);
  const list = await services.listSheets(v.sheetListQuery.parse(await input(req)));
  const sheets = await services.getSheetsFull({ SHTIDS: list.ITEMS.map((i) => i.SHTID) });
  const issues = await sheetsIssues(sheets);
  return {
    ...list,
    ITEMS: list.ITEMS.map((i) => ({ ...i, ISSUES: issues.get(i.SHTID) ?? [] })),
  };
}

export async function getSheet(req) {
  utils.assertVinidocApp(req);
  const { SHTID } = v.sheetIdParam.parse(req.params);
  const [sheet, EVENTS, VERSIONS] = await Promise.all([
    getSheetOrThrow(SHTID),
    services.getSheetEvents(SHTID),
    services.getSheetVersions(SHTID),
  ]);
  return { ...sheet, EVENTS, VERSIONS };
}

export async function getSheetVersions(req) {
  utils.assertVinidocApp(req);
  const { SHTID } = v.sheetIdParam.parse(req.params);
  await getSheetOrThrow(SHTID);
  return services.getSheetVersions(SHTID);
}

export async function getSheetVersion(req) {
  utils.assertVinidocApp(req);
  const { SHTID, VERNUM } = v.sheetVersionParam.parse(req.params);
  const version = await services.getSheetVersion(SHTID, VERNUM);
  if (!version) throw new Error("VINIDOC_VERSION_NOT_FOUND");
  return version;
}

/* ═════════════════════════════ Fiches — saisie ═════════════════════════════ */

export async function createSheet(req) {
  utils.assertVinidocApp(req);
  utils.assertCanEditSheets(req);
  const { TRANSLATION, ...sheet } = v.sheetCreateSchema.parse(await input(req));

  const state = await services.createSheet({
    sheet,
    translation: TRANSLATION,
    LNGCOD: await getDefaultLanguage(),
    USR: utils.getActor(req),
  });

  emitSheet("vinidoc.sheet.created", state);
  return sheetState(state);
}

export async function updateSheet(req) {
  utils.assertVinidocApp(req);
  const RIGHTS = utils.getSheetEditRights(req);
  const { SHTID } = v.sheetIdParam.parse(req.params);
  const { ROWVER, ...sheet } = v.sheetUpdateSchema.parse(await input(req));

  const state = await services.updateSheet({
    SHTID,
    ROWVER,
    sheet,
    USR: utils.getActor(req),
    RIGHTS,
  });
  emitSheet("vinidoc.sheet.updated", state);
  return sheetState(state);
}

export async function saveTranslation(req) {
  utils.assertVinidocApp(req);
  const RIGHTS = utils.getSheetEditRights(req);
  const { SHTID, LNGCOD } = v.sheetLngParam.parse(req.params);
  const { ROWVER, ...translation } = v.translationUpsertSchema.parse(
    await input(req),
  );

  const state = await services.upsertTranslation({
    SHTID,
    LNGCOD,
    ROWVER,
    translation,
    USR: utils.getActor(req),
    RIGHTS,
  });
  emitSheet("vinidoc.sheet.updated", state);
  return sheetState(state);
}

export async function deleteTranslation(req) {
  utils.assertVinidocApp(req);
  const RIGHTS = utils.getSheetEditRights(req);
  const { SHTID, LNGCOD } = v.sheetLngParam.parse(req.params);
  const { ROWVER } = v.rowverOnlySchema.parse(await input(req));

  const state = await services.deleteTranslation({
    SHTID,
    LNGCOD,
    ROWVER,
    USR: utils.getActor(req),
    RIGHTS,
  });
  emitSheet("vinidoc.sheet.updated", state);
  return sheetState(state);
}

export async function deleteSheet(req) {
  utils.assertVinidocApp(req);
  utils.assertCanEditSheets(req);
  const { SHTID } = v.sheetIdParam.parse(req.params);
  const { ROWVER, COMMENT } = v.workflowCommentSchema.parse(await input(req));

  const result = await services.deleteSheet({
    SHTID,
    ROWVER,
    COMMENT,
    USR: utils.getActor(req),
  });
  broadcastToAll({ type: "vinidoc.sheet.deleted", payload: { SHTID } });
  return result;
}

/* ═════════════════════════════ Workflow de validation ═════════════════════════════ */

export async function submitSheet(req) {
  utils.assertVinidocApp(req);
  utils.assertCanEditSheets(req);
  const { SHTID } = v.sheetIdParam.parse(req.params);
  const { ROWVER, COMMENT } = v.workflowCommentSchema.parse(await input(req));

  const state = await services.submitSheet({
    SHTID,
    ROWVER,
    COMMENT,
    USR: utils.getActor(req),
  });
  emitSheet("vinidoc.sheet.submitted", state);

  const sheet = await services.getSheet(SHTID);
  if (sheet) void notify.notifySubmitted(sheet, utils.getActorDisplayName(req));
  return sheetState(state);
}

/**
 * Soumission en masse au marketing de toutes les fiches soumettables
 * (DRAFT / REJECTED) correspondant aux filtres de la liste. Une fiche
 * présentant des anomalies de saisie (cf. sheetsIssues) n'est pas soumise :
 * elle est renvoyée dans ERRORS avec le détail. Une seule notification mail
 * récapitule les fiches soumises.
 */
export async function submitSheets(req) {
  utils.assertVinidocApp(req);
  utils.assertCanEditSheets(req);
  const { COMMENT, ...filters } = v.submitSheetsSchema.parse(await input(req));
  const USR = utils.getActor(req);

  const sheets = await services.getSheetsFull({ ...filters, SUBMITTABLE: true });
  const issues = await sheetsIssues(sheets);
  const label = (s) => ({ SHTID: s.SHTID, CODVRAC: s.CODVRAC, MILLESIME: s.MILLESIME });

  const SUBMITTED = [];
  const ERRORS = [];
  for (const sheet of sheets) {
    const sheetIssues = issues.get(sheet.SHTID) ?? [];
    if (sheetIssues.length) {
      ERRORS.push({ ...label(sheet), MESSAGES: sheetIssues });
      continue;
    }
    try {
      const state = await services.submitSheet({ SHTID: sheet.SHTID, ROWVER: sheet.ROWVER, COMMENT, USR });
      emitSheet("vinidoc.sheet.submitted", state);
      SUBMITTED.push({ ...label(sheet), sheet });
    } catch (err) {
      ERRORS.push({ ...label(sheet), MESSAGES: [errorMessage(err)] });
    }
  }

  if (SUBMITTED.length) {
    void notify.notifySubmittedBatch(SUBMITTED.map((s) => s.sheet), utils.getActorDisplayName(req));
  }
  return { SUBMITTED: SUBMITTED.map(({ sheet, ...s }) => s), ERRORS };
}

/**
 * Validation marketing : fige le contenu courant (toutes langues) dans une
 * nouvelle version. Le ROWVER fourni est celui de la fiche telle que
 * présentée au valideur : si quelqu'un l'a modifiée depuis, 409 — on ne
 * valide jamais un contenu que le marketing n'a pas vu.
 */
export async function validateSheet(req) {
  utils.assertVinidocApp(req);
  utils.assertCanValidateSheets(req);
  const { SHTID } = v.sheetIdParam.parse(req.params);
  const { ROWVER, COMMENT } = v.workflowCommentSchema.parse(await input(req));

  const sheet = await getSheetOrThrow(SHTID);
  if (!utils.hexToRowver(ROWVER).equals(utils.hexToRowver(sheet.ROWVER))) {
    throw new Error("VINIDOC_CONCURRENT_UPDATE");
  }

  const state = await services.validateSheet({
    SHTID,
    ROWVER: sheet.ROWVER,
    SNAPSHOT: utils.buildSnapshot(sheet),
    COMMENT,
    USR: utils.getActor(req),
  });
  emitSheet("vinidoc.sheet.validated", state);

  void notify.notifyValidated(
    sheet,
    state.LASTVER,
    utils.getActorDisplayName(req),
    COMMENT,
  );
  return sheetState(state);
}

export async function rejectSheet(req) {
  utils.assertVinidocApp(req);
  utils.assertCanValidateSheets(req);
  const { SHTID } = v.sheetIdParam.parse(req.params);
  const { ROWVER, COMMENT } = v.rejectSchema.parse(await input(req));

  const state = await services.rejectSheet({
    SHTID,
    ROWVER,
    COMMENT,
    USR: utils.getActor(req),
  });
  emitSheet("vinidoc.sheet.rejected", state);

  const sheet = await services.getSheet(SHTID);
  if (sheet)
    void notify.notifyRejected(sheet, utils.getActorDisplayName(req), COMMENT);
  return sheetState(state);
}

/* ═════════════════════════════ Contrôle des longueurs ═════════════════════════════ */

/** Regroupe les lignes de getTextTagLimits par modèle. */
function groupTagsByTemplate(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.TPLID))
      map.set(r.TPLID, { TPLID: r.TPLID, TPLNAM: r.TPLNAM, TAGS: [] });
    map.get(r.TPLID).TAGS.push(r);
  }
  return [...map.values()];
}

/**
 * Contrôle d'une fiche face aux contraintes des modèles (longueurs max,
 * balises obligatoires), sans rien générer.
 *   SOURCE=CURRENT   : données en cours de saisie (aide à la rédaction)
 *   SOURCE=VALIDATED : dernière version validée (ce qui est généré pour une fiche validée)
 *   TPLID absent     : tous les modèles actifs compatibles avec la langue
 */
export async function checkSheet(req) {
  utils.assertVinidocApp(req);
  const { SHTID } = v.sheetIdParam.parse(req.params);
  const { LNGCOD, TPLID, SOURCE } = v.checkSchema.parse(await input(req));

  let data;
  let VERNUM = null;
  if (SOURCE === "VALIDATED") {
    const version = await services.getSheetVersion(SHTID);
    if (!version) {
      await getSheetOrThrow(SHTID);
      throw new Error("VINIDOC_SHEET_NOT_VALIDATED");
    }
    data = version.SNAPSHOT;
    VERNUM = version.VERNUM;
  } else {
    data = await getSheetOrThrow(SHTID);
  }

  let templates;
  if (TPLID) {
    const tpl = await services.getTemplate(TPLID);
    if (!tpl) throw new Error("VINIDOC_TEMPLATE_NOT_FOUND");
    templates = [{ TPLID: tpl.TPLID, TPLNAM: tpl.TPLNAM, TAGS: tpl.TAGS }];
  } else {
    templates = groupTagsByTemplate(await services.getTextTagLimits(LNGCOD));
  }

  const color = await services.getColorTrans(data.COLCOD, LNGCOD);
  const { text } = utils.buildMergeData(data, LNGCOD, color);

  const TEMPLATES = templates.map((t) => ({
    TPLID: t.TPLID,
    TPLNAM: t.TPLNAM,
    ...utils.checkAgainstTemplate(text, t.TAGS),
  }));

  return {
    SHTID,
    SOURCE,
    VERNUM,
    LNGCOD,
    TRANSLATION_MISSING: !data.TRANSLATIONS?.[LNGCOD],
    OK: TEMPLATES.every((t) => t.OK),
    TEMPLATES,
  };
}

/* ═════════════════════════════ Modèles PowerPoint ═════════════════════════════ */

function formatTemplate(t) {
  if (!t) return null;
  return {
    ...t,
    ACTIVE: !!t.ACTIVE,
    ROWVER: utils.rowverToHex(t.ROWVER),
    FILEURL: fileUrl(t.RELATIVEPATH),
    ...(t.TAGS && {
      TAGS: t.TAGS.map((g) => ({
        ...g,
        REQUIRED: !!g.REQUIRED,
        ISKNOWN: !!g.ISKNOWN,
      })),
    }),
  };
}

async function inspectTemplateFile(file) {
  if (!file) throw new Error("VINIDOC_TEMPLATE_FILE_REQUIRED");
  const tpl = await OoxmlTemplate.load(file.path);
  const inventory = await tpl.listTags();
  const TAGS = utils.tagsFromInventory(inventory);
  const LENGTHWARNINGS = utils.maxLenWarnings(inventory);
  return {
    TAGS,
    LENGTHWARNINGS,
    WARNINGS: [
      ...TAGS.filter((t) => !t.ISKNOWN).map(
        (t) =>
          `Balise ${t.TAGTYP} "${t.TAGNAM}" inconnue du catalogue : elle sera rendue vide.`,
      ),
      ...LENGTHWARNINGS,
    ],
  };
}

export async function listTemplates(req) {
  utils.assertVinidocApp(req);
  const filters = v.templateListQuery.parse(await input(req));
  // Les non-administrateurs ne voient que les modèles actifs.
  if (!utils.canManageTemplates(req)) filters.ACTIVE = true;
  return (await services.listTemplates(filters)).map(formatTemplate);
}

export async function getTemplate(req) {
  utils.assertVinidocApp(req);
  const { TPLID } = v.templateIdParam.parse(req.params);
  const tpl = await services.getTemplate(TPLID);
  if (!tpl || (!tpl.ACTIVE && !utils.canManageTemplates(req))) {
    throw new Error("VINIDOC_TEMPLATE_NOT_FOUND");
  }
  return formatTemplate(tpl);
}

/**
 * Analyse d'un .pptx SANS l'enregistrer (multipart : file) : permet au front
 * d'afficher les balises inconnues / absentes dès le choix du fichier.
 * Le fichier temporaire est supprimé par `handle` (cleanupTmpFiles).
 */
export async function inspectTemplate(req) {
  utils.assertVinidocApp(req);
  utils.assertCanManageTemplates(req);
  const { TAGS, WARNINGS, LENGTHWARNINGS } = await inspectTemplateFile(req.file);
  return {
    TAGS,
    UNKNOWN: TAGS.filter((t) => !t.ISKNOWN),
    LENGTHWARNINGS,
    MISSING: utils.missingCatalogTags(TAGS),
    WARNINGS,
  };
}

/** Dépôt d'un modèle (multipart : file + TPLNAM, DESCR?, LNGCOD?). */
export async function createTemplate(req) {
  utils.assertVinidocApp(req);
  utils.assertCanManageTemplates(req);
  const body = v.templateCreateSchema.parse(await input(req));
  const { TAGS, WARNINGS } = await inspectTemplateFile(req.file);

  const TPLKEY = ulid();
  const USR = utils.getActor(req);
  const saved = await storage().saveUploadedFile({
    appCode: APP_CODE,
    file: req.file,
    entityType: ENTITY_TEMPLATE,
    entityId: TPLKEY,
    uploadedBy: USR,
  });

  let TPLID;
  try {
    ({ TPLID } = await services.createTemplate({
      ...body,
      TPLKEY,
      FILECODE: saved.FILECODE,
      TAGS,
      USR,
    }));
  } catch (err) {
    await discardFile(saved.FILECODE);
    throw err;
  }

  broadcastToAll({ type: "vinidoc.template.created", payload: { TPLID } });
  return { ...formatTemplate(await services.getTemplate(TPLID)), WARNINGS };
}

export async function updateTemplate(req) {
  utils.assertVinidocApp(req);
  utils.assertCanManageTemplates(req);
  const { TPLID } = v.templateIdParam.parse(req.params);
  const body = v.templateUpdateSchema.parse(await input(req));

  await services.updateTemplate({ TPLID, ...body, USR: utils.getActor(req) });
  broadcastToAll({ type: "vinidoc.template.updated", payload: { TPLID } });
  return formatTemplate(await services.getTemplate(TPLID));
}

/** Remplacement du fichier .pptx (multipart : file). Réglages des balises conservés. */
export async function replaceTemplateFile(req) {
  utils.assertVinidocApp(req);
  utils.assertCanManageTemplates(req);
  const { TPLID } = v.templateIdParam.parse(req.params);

  const current = await services.getTemplate(TPLID);
  if (!current) throw new Error("VINIDOC_TEMPLATE_NOT_FOUND");

  const { TAGS, WARNINGS } = await inspectTemplateFile(req.file);
  const USR = utils.getActor(req);
  const saved = await storage().saveUploadedFile({
    appCode: APP_CODE,
    file: req.file,
    entityType: ENTITY_TEMPLATE,
    entityId: current.TPLKEY,
    uploadedBy: USR,
  });

  let diff;
  try {
    diff = await services.replaceTemplateFile({
      TPLID,
      FILECODE: saved.FILECODE,
      TAGS,
      USR,
    });
  } catch (err) {
    await discardFile(saved.FILECODE);
    throw err;
  }

  broadcastToAll({ type: "vinidoc.template.updated", payload: { TPLID } });
  return {
    ...formatTemplate(await services.getTemplate(TPLID)),
    ADDEDTAGS: diff.ADDED,
    REMOVEDTAGS: diff.REMOVED,
    MAXLENTAGS: diff.MAXLEN,
    WARNINGS,
  };
}

/** Longueurs max / caractère obligatoire, par balise. */
export async function setTemplateTags(req) {
  utils.assertVinidocApp(req);
  utils.assertCanManageTemplates(req);
  const { TPLID } = v.templateIdParam.parse(req.params);
  const { TAGS } = v.templateTagsSchema.parse(await input(req));

  const invalid = TAGS.find((t) => t.TAGTYP !== "TEXT" && t.MAXLEN != null);
  if (invalid) {
    throw badRequest(
      `Longueur max réservée aux balises texte (${invalid.TAGTYP} ${invalid.TAGNAM}).`,
    );
  }

  await services.setTemplateTags({
    TPLID,
    TAGS: TAGS.map((t) => ({
      ...t,
      MAXLEN: t.MAXLEN ?? null,
      REQUIRED: t.REQUIRED ? 1 : 0,
    })),
    USR: utils.getActor(req),
  });
  broadcastToAll({ type: "vinidoc.template.updated", payload: { TPLID } });
  return formatTemplate(await services.getTemplate(TPLID));
}

export async function deleteTemplate(req) {
  utils.assertVinidocApp(req);
  utils.assertCanManageTemplates(req);
  const { TPLID } = v.templateIdParam.parse(req.params);
  const result = await services.deleteTemplate({
    TPLID,
    USR: utils.getActor(req),
  });
  broadcastToAll({ type: "vinidoc.template.deleted", payload: { TPLID } });
  return result;
}

/* ═════════════════════════════ Génération ═════════════════════════════ */

function constraintsError(errors) {
  const detail = errors
    .map((e) =>
      e.ISSUE === "TOO_LONG"
        ? `${e.TAGNAM} ${e.LENGTH}/${e.MAXLEN}`
        : `${e.TAGNAM} vide`,
    )
    .join(", ");
  return new Error(`VINIDOC_TAG_CONSTRAINTS_[${detail}]`);
}

/**
 * Contenu utilisé pour la génération :
 *   fiche VALIDATED → dernière version validée (VERNUM) ;
 *   sinon           → saisie en cours (VERNUM null), non validée par le
 *                     marketing : autorisé, le front affiche un avertissement.
 */
async function getGenerationSource(SHTID) {
  const sheet = await getSheetOrThrow(SHTID);
  if (sheet.STATUS === "VALIDATED") {
    const version = await services.getSheetVersion(SHTID);
    if (version) {
      return { SOURCE: "VALIDATED", VERNUM: version.VERNUM, data: version.SNAPSHOT };
    }
  }
  return { SOURCE: "CURRENT", VERNUM: null, data: sheet };
}

/**
 * Génère la fiche technique (version validée, ou saisie en cours si la fiche
 * n'est pas validée — voir getGenerationSource).
 * multipart : SHTID, TPLID, LNGCOD, FORMAT (pdf|pptx, défaut pdf),
 *             HVE?, BIO? (affichage des logos, défaut false), photo? (image)
 */
export async function generate(req) {
  utils.assertVinidocApp(req);
  const { SHTID, TPLID, LNGCOD, FORMAT, HVE, BIO } = v.generateSchema.parse(
    await input(req),
  );

  const [source, template] = await Promise.all([
    getGenerationSource(SHTID),
    services.getTemplate(TPLID),
  ]);
  const { SOURCE, VERNUM, data: snapshot } = source;
  if (!template || !template.ACTIVE)
    throw new Error("VINIDOC_TEMPLATE_NOT_FOUND");
  if (template.LNGCOD && template.LNGCOD !== LNGCOD) {
    throw new Error(`VINIDOC_TEMPLATE_LANGUAGE_MISMATCH_[${template.LNGCOD}]`);
  }
  if (!template.RELATIVEPATH) throw new Error("VINIDOC_TEMPLATE_FILE_MISSING");

  if (!snapshot.TRANSLATIONS?.[LNGCOD]) {
    throw new Error(`VINIDOC_TRANSLATION_MISSING_[${LNGCOD}]`);
  }

  const color = await services.getColorTrans(snapshot.COLCOD, LNGCOD);
  const merge = utils.buildMergeData(snapshot, LNGCOD, color);
  const report = utils.checkAgainstTemplate(merge.text, template.TAGS);
  if (!report.OK) throw constraintsError(report.ERRORS);

  await fsp.mkdir(TMP_ROOT, { recursive: true });
  const workDir = await fsp.mkdtemp(path.join(TMP_ROOT, "vinidoc-gen-"));
  const USR = utils.getActor(req);

  try {
    let tpl;
    try {
      tpl = await OoxmlTemplate.load(
        path.join(UPLOAD_ROOT, template.RELATIVEPATH),
      );
    } catch (err) {
      if (err.code === "ENOENT")
        throw new Error("VINIDOC_TEMPLATE_FILE_MISSING", { cause: err });
      throw err;
    }

    await tpl.render({
      ...merge,
      badges: { ...merge.badges, ...utils.certificationBadges({ HVE, BIO }, template.TAGS) },
      images: req.file ? { BOTTLEPHOTO: req.file.path } : {},
    });

    const pptxPath = path.join(
      workDir,
      utils.outputFileName(snapshot, LNGCOD, "pptx"),
    );
    await tpl.save(pptxPath);

    const outPath =
      FORMAT === "pdf" ? await convertPptxToPdf(pptxPath, workDir) : pptxPath;
    const saved = await storage().saveUploadedFile({
      appCode: APP_CODE,
      file: {
        path: outPath,
        originalname: path.basename(outPath),
        mimetype: FORMAT === "pdf" ? "application/pdf" : PPTX_MIME,
      },
      entityType: ENTITY_GENERATION,
      entityId: String(SHTID),
      uploadedBy: USR,
    });

    let generation;
    try {
      generation = await services.insertGeneration({
        SHTID,
        VERNUM,
        TPLID,
        TPLFILECODE: template.FILECODE,
        LNGCOD,
        FORMAT,
        HVE,
        BIO,
        FILECODE: saved.FILECODE,
        USR,
      });
    } catch (err) {
      await discardFile(saved.FILECODE);
      throw err;
    }

    logger.info(
      `[VINIDOC] Génération ${FORMAT} | fiche ${SHTID} ${VERNUM ? `v${VERNUM}` : "saisie en cours (non validée)"} | modèle ${TPLID} | ${LNGCOD} | HVE=${HVE} BIO=${BIO} | ${USR}`,
    );

    return {
      GENID: generation.GENID,
      CREDAT: generation.CREDAT,
      SHTID,
      VERNUM,
      SOURCE,
      TPLID,
      LNGCOD,
      FORMAT,
      HVE,
      BIO,
      FILECODE: saved.FILECODE,
      ORIGINALNAME: saved.ORIGINALNAME,
      URL: saved.URLPATH,
      WARNINGS: report.TAGS.filter((t) => t.ISSUE === "UNKNOWN_TAG").map(
        (t) => `Balise "${t.TAGNAM}" inconnue : rendue vide.`,
      ),
    };
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function listGenerations(req) {
  utils.assertVinidocApp(req);
  const filters = v.generationListQuery.parse(await input(req));
  return (await services.listGenerations(filters)).map((g) => ({
    ...g,
    HVE: !!g.HVE,
    BIO: !!g.BIO,
    URL: fileUrl(g.RELATIVEPATH),
  }));
}
