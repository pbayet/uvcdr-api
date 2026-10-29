import crypto from "node:crypto";
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

   Fiche validée : « Modifier » (PUT /sheets/:SHTID/validated) crée une
   nouvelle version validée, la fiche reste VALIDATED (RG-01).
   Réservation (RG-04) : une fiche ouverte en modification est réservée à
   son auteur ; toute écriture d'un autre utilisateur est refusée.

   Génération : TOUJOURS à partir de la dernière version validée
   (SHEETVERS), jamais des données en cours de saisie — c'est ce qui
   garantit que seul un contenu validé par le marketing est diffusé.
═══════════════════════════════════════════════════════════════ */

const APP_CODE = process.env.DB_APP_CODE_VINIDOC || "VINDOC";
const UPLOAD_ROOT = process.env.UPLOAD_PATH || "uploads";
const TMP_ROOT = process.env.UPLOAD_TMP_PATH || "tmp";
const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** Aperçus PDF des modèles, servis en statique : <UPLOAD_ROOT>/<APP_CODE>/previews. */
const PREVIEW_DIR = "previews";

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

/* ─────────────────────────── Réservation (RG-04) ─────────────────────────── */

const lockTime = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "Europe/Paris",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** Réservation (ligne SHEETLOCKS) → objet API ; MINE = détenue par l'utilisateur courant. */
function formatLock(row, req) {
  if (!row) return null;
  return {
    USR: row.USR,
    USRNAME: row.USRNAME,
    LOCKDAT: row.LOCKDAT,
    LASTSEEN: row.LASTSEEN,
    MINE: row.USR === utils.getActor(req),
  };
}

/**
 * Refuse une écriture sur une fiche réservée par un autre utilisateur, en
 * nommant le titulaire et l'heure de sa prise (le service revérifie sous
 * verrou, cf. ASSERT_NOT_RESERVED).
 */
async function assertNotReserved(SHTID, req) {
  const lock = await services.getSheetLock(SHTID);
  if (lock && lock.USR !== utils.getActor(req)) {
    const since = lockTime.format(new Date(lock.LOCKDAT)).replace(" ", " à ");
    throw new Error(`VINIDOC_SHEET_RESERVED_[${lock.USRNAME}]_[${since}]`);
  }
}

/** Paramètres (table PARAMS) : { PRMKEY: valeur }. */
async function getParamValues() {
  const rows = await services.getParams();
  return Object.fromEntries(rows.map((r) => [r.PRMKEY, r.PRMVAL]));
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
  const [rows, colors] = await Promise.all([
    services.getTextTagLimits(LNGCOD ?? null),
    services.getColors(),
  ]);

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

  // Blocs « COULEUR_* » : un nom par couleur paramétrée.
  const BADGES = utils.BADGE_PATTERNS.map((b) =>
    b.GROUP === "Couleur" && colors.length
      ? { ...b, NAMES: colors.map((c) => `COULEUR_${c.COLCOD}`) }
      : b,
  );
  return { TEXT, BADGES, IMAGES: utils.IMAGE_FIELDS };
}

/* ═════════════════════════════ Fiches — lecture ═════════════════════════════ */

/** Message lisible d'une erreur métier (clé du registre) ou technique. */
const errorMessage = (err) =>
  ERROR_REGISTRY[err?.message]?.MESSAGE?.fr ??
  err?.message ??
  "Erreur inconnue.";

/** Libellé court d'une balise texte (« Dégustation (œil, nez…) » → « Dégustation »). */
const tagLabel = (TAGNAM) =>
  utils.TEXT_FIELDS.find((f) => f.TAG === TAGNAM)?.LABEL.split(" (")[0] ??
  TAGNAM;

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
      issues.push(
        `[${defaultLng.toUpperCase()}] Traduction de la langue par défaut absente.`,
      );
    }
    for (const lng of Object.keys(sheet.TRANSLATIONS)) {
      const color =
        colors.find((c) => c.COLCOD === sheet.COLCOD)?.LABELS[lng] ?? {};
      const { text } = utils.buildMergeData(sheet, lng, color);
      // Une anomalie par balise : limite la plus stricte, modèles concernés.
      const byTag = new Map();
      for (const tpl of templates.filter(
        (t) => !t.TPLLNG || t.TPLLNG === lng,
      )) {
        for (const e of utils.checkAgainstTemplate(text, tpl.TAGS).ERRORS) {
          const key = `${e.ISSUE}|${e.TAGNAM}`;
          const cur = byTag.get(key) ?? { ...e, TEMPLATES: [] };
          if (e.MAXLEN != null && (cur.MAXLEN == null || e.MAXLEN < cur.MAXLEN))
            cur.MAXLEN = e.MAXLEN;
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
  const list = await services.listSheets(
    v.sheetListQuery.parse(await input(req)),
  );
  const sheets = await services.getSheetsFull({
    SHTIDS: list.ITEMS.map((i) => i.SHTID),
  });
  const issues = await sheetsIssues(sheets);
  return {
    ...list,
    ITEMS: list.ITEMS.map((i) => ({ ...i, ISSUES: issues.get(i.SHTID) ?? [] })),
  };
}

export async function getSheet(req) {
  utils.assertVinidocApp(req);
  const { SHTID } = v.sheetIdParam.parse(req.params);
  const [sheet, EVENTS, VERSIONS, lock] = await Promise.all([
    getSheetOrThrow(SHTID),
    services.getSheetEvents(SHTID),
    services.getSheetVersions(SHTID),
    services.getSheetLock(SHTID),
  ]);
  return { ...sheet, EVENTS, VERSIONS, LOCK: formatLock(lock, req) };
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
  await assertNotReserved(SHTID, req);

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

/**
 * Modèle PowerPoint par défaut, présélectionné à la génération. Préférence
 * hors contenu validé : statut inchangé, aucune revalidation nécessaire.
 */
export async function setDefaultTemplate(req) {
  utils.assertVinidocApp(req);
  utils.getSheetEditRights(req);
  const { SHTID } = v.sheetIdParam.parse(req.params);
  const { ROWVER, DEFTPLID } = v.sheetDefaultTemplateSchema.parse(
    await input(req),
  );

  const state = await services.setDefaultTemplate({
    SHTID,
    ROWVER,
    DEFTPLID,
    USR: utils.getActor(req),
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
  await assertNotReserved(SHTID, req);

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
  await assertNotReserved(SHTID, req);

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
  await assertNotReserved(SHTID, req);

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
  await assertNotReserved(SHTID, req);

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

  const sheets = await services.getSheetsFull({
    ...filters,
    SUBMITTABLE: true,
  });
  const issues = await sheetsIssues(sheets);
  const label = (s) => ({
    SHTID: s.SHTID,
    CODVRAC: s.CODVRAC,
    MILLESIME: s.MILLESIME,
  });

  const SUBMITTED = [];
  const ERRORS = [];
  for (const sheet of sheets) {
    const sheetIssues = issues.get(sheet.SHTID) ?? [];
    if (sheetIssues.length) {
      ERRORS.push({ ...label(sheet), MESSAGES: sheetIssues });
      continue;
    }
    try {
      const state = await services.submitSheet({
        SHTID: sheet.SHTID,
        ROWVER: sheet.ROWVER,
        COMMENT,
        USR,
      });
      emitSheet("vinidoc.sheet.submitted", state);
      SUBMITTED.push({ ...label(sheet), sheet });
    } catch (err) {
      ERRORS.push({ ...label(sheet), MESSAGES: [errorMessage(err)] });
    }
  }

  if (SUBMITTED.length) {
    void notify.notifySubmittedBatch(
      SUBMITTED.map((s) => s.sheet),
      utils.getActorDisplayName(req),
    );
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
  await assertNotReserved(SHTID, req);

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
  await assertNotReserved(SHTID, req);

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

/**
 * Modification d'une fiche validée (RG-01) : œnologie ou marketing, via le
 * bouton « Modifier ». La fiche reste VALIDATED ; l'enregistrement (champs
 * communs et/ou textes de plusieurs langues) crée UNE nouvelle version
 * validée, utilisée dès lors pour la génération. Aussi utilisé par la
 * correction des textes trop longs à la génération (EF-53).
 * Corps : ROWVER, COMMENT?, SHEET? (champs communs complets),
 *         TRANSLATIONS? ({ lng: champs modifiés | null = suppression }).
 */
export async function updateValidatedSheet(req) {
  utils.assertVinidocApp(req);
  utils.getSheetEditRights(req);
  const { SHTID } = v.sheetIdParam.parse(req.params);
  const { ROWVER, COMMENT, SHEET, TRANSLATIONS } =
    v.validatedUpdateSchema.parse(await input(req));

  const current = await getSheetOrThrow(SHTID);
  if (current.STATUS !== "VALIDATED")
    throw new Error("VINIDOC_INVALID_STATUS_TRANSITION");
  // L'instantané est construit à partir de cette lecture : elle doit être
  // celle que l'utilisateur a modifiée (le service revérifie sous verrou).
  if (!utils.hexToRowver(ROWVER).equals(utils.hexToRowver(current.ROWVER))) {
    throw new Error("VINIDOC_CONCURRENT_UPDATE");
  }
  await assertNotReserved(SHTID, req);

  const changes = utils.applySheetChanges(current, SHEET ?? null, TRANSLATIONS);
  const defaultLng = await getDefaultLanguage();
  if (!changes.sheet.TRANSLATIONS[defaultLng]) {
    throw new Error("VINIDOC_DEFAULT_TRANSLATION_REQUIRED");
  }

  const state = await services.updateValidatedSheet({
    SHTID,
    ROWVER: current.ROWVER,
    sheet: SHEET ?? null,
    translations: changes.translations,
    deletedLngs: changes.deletedLngs,
    SNAPSHOT: utils.buildSnapshot(changes.sheet),
    COMMENT,
    USR: utils.getActor(req),
  });
  emitSheet("vinidoc.sheet.updated", state);
  broadcastToAll({ type: "vinidoc.sheet.unlocked", payload: { SHTID } });
  return sheetState(state);
}

/**
 * Réservation d'une fiche ouverte en modification (RG-04), ou prolongation
 * (appel périodique tant que l'utilisateur est actif). Réservée par un autre
 * utilisateur : renvoie sa réservation (MINE = false), sans erreur, pour que
 * le front prévienne avant toute saisie.
 */
export async function lockSheet(req) {
  utils.assertVinidocApp(req);
  utils.getSheetEditRights(req);
  const { SHTID } = v.sheetIdParam.parse(req.params);
  const row = await services.acquireSheetLock({
    SHTID,
    USR: utils.getActor(req),
    USRNAME: utils.getActorDisplayName(req),
  });
  if (row?.ACQUIRED) {
    broadcastToAll({
      type: "vinidoc.sheet.locked",
      payload: {
        SHTID,
        USR: row.USR,
        USRNAME: row.USRNAME,
        LOCKDAT: row.LOCKDAT,
      },
    });
  }
  return formatLock(row, req);
}

/** Libération de sa réservation (fermeture de la fiche, abandon de la modification). */
export async function unlockSheet(req) {
  utils.assertVinidocApp(req);
  const { SHTID } = v.sheetIdParam.parse(req.params);
  const RELEASED = await services.releaseSheetLock({
    SHTID,
    USR: utils.getActor(req),
  });
  if (RELEASED)
    broadcastToAll({ type: "vinidoc.sheet.unlocked", payload: { SHTID } });
  return { SHTID, RELEASED };
}

/* ═════════════════════════════ Paramètres ═════════════════════════════ */

export async function getParams(req) {
  utils.assertVinidocApp(req);
  return services.getParams();
}

/** Mise à jour de paramètres existants, dans leurs bornes. */
export async function updateParams(req) {
  utils.assertVinidocApp(req);
  utils.assertCanManageParams(req);
  const { PARAMS } = v.paramsUpdateSchema.parse(await input(req));

  const current = new Map(
    (await services.getParams()).map((r) => [r.PRMKEY, r]),
  );
  for (const { PRMKEY, PRMVAL } of PARAMS) {
    const prm = current.get(PRMKEY);
    if (!prm) throw badRequest(`Paramètre inconnu : ${PRMKEY}.`);
    if (
      (prm.MINVAL != null && PRMVAL < prm.MINVAL) ||
      (prm.MAXVAL != null && PRMVAL > prm.MAXVAL)
    ) {
      throw badRequest(
        `${prm.LABEL} : valeur attendue entre ${prm.MINVAL ?? "-∞"} et ${prm.MAXVAL ?? "+∞"}${prm.UNIT ? ` ${prm.UNIT}` : ""}.`,
      );
    }
  }

  await services.updateParams({ PARAMS, USR: utils.getActor(req) });
  broadcastToAll({ type: "vinidoc.params.updated", payload: {} });
  return services.getParams();
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
/* ═════════════════════════════ Articles PFI (DWH) ═════════════════════════════ */

/** Article PFI ou erreur 404. */
async function getArticleOrThrow(COD_ARTICLE) {
  const row = await services.getArticle(COD_ARTICLE);
  if (!row) throw new Error("VINIDOC_ARTICLE_NOT_FOUND");
  return row;
}

/**
 * Balises logistiques {{LOG.*}} de l'article, dont un code vrac doit être
 * celui de la fiche ; {} sans article.
 */
async function articleMergeText(COD_ARTICLE, CODVRAC) {
  if (!COD_ARTICLE) return {};
  const row = await getArticleOrThrow(COD_ARTICLE);
  if (!utils.articleFromRow(row).CODVRACS.includes(CODVRAC)) {
    throw new Error(`VINIDOC_ARTICLE_SHEET_MISMATCH_[${CODVRAC}]`);
  }
  return utils.logisticsText(row, await getParamValues());
}

/**
 * Recherche d'articles PFI (DWH) : sans recherche, seuls les PFI dont un code
 * vrac a une fiche œnologique ; avec recherche, tous les PFI correspondants,
 * HASSHEET indiquant ceux qui ont une fiche (cf. services.searchArticles) et
 * SHEETSTATUS le statut de la fiche utilisée (VALIDATED = validée).
 */
export async function searchArticles(req) {
  utils.assertVinidocApp(req);
  const filters = v.articleSearchQuery.parse(await input(req));
  const CODVRACS = await services.listSheetCodvracs();
  const rows = await services.searchArticles({ ...filters, CODVRACS });
  const articles = rows.map(utils.articleFromRow);
  console.log(articles);

  // Statut de la fiche qui serait utilisée (badge « non validée » au front).
  const sheets = await services.findSheetsByCodvrac([
    ...new Set(articles.flatMap((a) => a.CODVRACS)),
  ]);

  return articles.map((a, i) => ({
    ...a,
    HASSHEET: !!rows[i].HASSHEET,
    SHEETSTATUS: utils.articleSheetStatus(a, sheets),
  }));
}

/**
 * Article PFI : codes vrac, fiches correspondantes (même millésime d'abord)
 * et données logistiques ({{LOG.*}}, dont des valeurs de test signalées).
 */
export async function getArticle(req) {
  utils.assertVinidocApp(req);
  const { COD_ARTICLE } = v.articleParam.parse(req.params);
  const row = await getArticleOrThrow(COD_ARTICLE);
  const article = utils.articleFromRow(row);

  console.log(row);
  console.log(article);

  const [sheets, params] = await Promise.all([
    services.findSheetsByCodvrac(article.CODVRACS),
    getParamValues(),
  ]);
  return {
    ...article,
    SHEETS: utils.sortArticleSheets(sheets, article.MILLESIME),
    LOGISTICS: utils.logisticsFields(row, params),
  };
}

export async function checkSheet(req) {
  utils.assertVinidocApp(req);
  const { SHTID } = v.sheetIdParam.parse(req.params);
  const { LNGCOD, TPLID, SOURCE, COD_ARTICLE, SHEET, TRANSLATION } =
    v.checkSchema.parse(await input(req));

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
  // Ajustements locaux d'une génération en préparation (non enregistrés).
  data = utils.applyLocalChanges(data, LNGCOD, SHEET, TRANSLATION);

  let templates;
  if (TPLID) {
    const tpl = await services.getTemplate(TPLID);
    if (!tpl) throw new Error("VINIDOC_TEMPLATE_NOT_FOUND");
    templates = [{ TPLID: tpl.TPLID, TPLNAM: tpl.TPLNAM, TAGS: tpl.TAGS }];
  } else {
    templates = groupTagsByTemplate(await services.getTextTagLimits(LNGCOD));
  }

  const color = await services.getColorTrans(data.COLCOD, LNGCOD);
  const text = {
    ...utils.buildMergeData(data, LNGCOD, color).text,
    ...(await articleMergeText(COD_ARTICLE, data.CODVRAC)),
  };

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
  const { TAGS, WARNINGS, LENGTHWARNINGS } = await inspectTemplateFile(
    req.file,
  );
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

/* ───────────────────────── Aperçu ───────────────────────── */

/** Conversions en cours, par fichier d'aperçu (deux demandes simultanées → une seule conversion). */
const previewJobs = new Map();

const previewPrefix = (TPLID) => `tpl-${TPLID}-`;

/** Supprime les aperçus d'un modèle, sauf `keep` (nom de fichier). */
async function removeTemplatePreviews(TPLID, keep = null) {
  const dir = path.join(UPLOAD_ROOT, APP_CODE, PREVIEW_DIR);
  const files = await fsp.readdir(dir).catch(() => []);
  await Promise.all(
    files
      .filter((f) => f.startsWith(previewPrefix(TPLID)) && f !== keep)
      .map((f) => fsp.rm(path.join(dir, f), { force: true }).catch(() => {})),
  );
}

/** Rend le modèle avec des données fictives puis le convertit en PDF (sauf s'il existe déjà). */
async function buildTemplatePreview(template, absPath) {
  const exists = await fsp.access(absPath).then(
    () => true,
    () => false,
  );
  if (exists) return true;

  await fsp.mkdir(TMP_ROOT, { recursive: true });
  const workDir = await fsp.mkdtemp(path.join(TMP_ROOT, "vinidoc-preview-"));
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
    await tpl.render(utils.previewMergeData(template.TAGS));
    const pptxPath = path.join(workDir, "apercu.pptx");
    await tpl.save(pptxPath);
    const pdfPath = await convertPptxToPdf(pptxPath, workDir);

    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    await fsp.copyFile(pdfPath, absPath);
    // Aperçus d'une version précédente (autre fichier, autres longueurs max).
    await removeTemplatePreviews(template.TPLID, path.basename(absPath));
    return false;
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Aperçu PDF d'un modèle rempli de faux texte (cf. utils.previewMergeData).
 * Mis en cache : reconverti seulement si le fichier ou les longueurs max
 * des balises changent. Tout utilisateur VINIDOC (modèles inactifs inclus).
 */
export async function previewTemplate(req) {
  utils.assertVinidocApp(req);
  const { TPLID } = v.templateIdParam.parse(req.params);
  const template = await services.getTemplate(TPLID);
  if (!template) throw new Error("VINIDOC_TEMPLATE_NOT_FOUND");
  if (!template.RELATIVEPATH) throw new Error("VINIDOC_TEMPLATE_FILE_MISSING");

  const signature = crypto
    .createHash("sha1")
    .update(
      JSON.stringify([
        template.FILECODE,
        (template.TAGS ?? []).map((t) => [t.TAGTYP, t.TAGNAM, t.MAXLEN]),
      ]),
    )
    .digest("hex")
    .slice(0, 12);
  const relativePath = path.posix.join(
    APP_CODE,
    PREVIEW_DIR,
    `${previewPrefix(TPLID)}${signature}.pdf`,
  );
  const absPath = path.join(UPLOAD_ROOT, relativePath);

  if (!previewJobs.has(absPath)) {
    previewJobs.set(
      absPath,
      buildTemplatePreview(template, absPath).finally(() =>
        previewJobs.delete(absPath),
      ),
    );
  }
  const CACHED = await previewJobs.get(absPath);

  return {
    TPLID,
    URL: fileUrl(relativePath),
    ORIGINALNAME: `Aperçu - ${template.TPLNAM}.pdf`,
    CACHED,
  };
}

export async function deleteTemplate(req) {
  utils.assertVinidocApp(req);
  utils.assertCanManageTemplates(req);
  const { TPLID } = v.templateIdParam.parse(req.params);
  const result = await services.deleteTemplate({
    TPLID,
    USR: utils.getActor(req),
  });
  await removeTemplatePreviews(TPLID);
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
      return {
        SOURCE: "VALIDATED",
        VERNUM: version.VERNUM,
        data: version.SNAPSHOT,
      };
    }
  }
  return { SOURCE: "CURRENT", VERNUM: null, data: sheet };
}

/**
 * Génère la fiche technique (version validée, ou saisie en cours si la fiche
 * n'est pas validée — voir getGenerationSource).
 * multipart : SHTID, TPLID, LNGCOD, FORMAT (pdf|pptx, défaut pdf),
 *             COD_ARTICLE (article PFI, obligatoire : balises {{LOG.*}}),
 *             HVE?, BIO? (affichage des logos, défaut false), photo? (image),
 *             PACKAGING? (BOUTEILLE|BIB|CANETTE, défaut BOUTEILLE : cadre photo),
 *             FREE? (champs libres {{FREE.*}} : objet, ou chaîne JSON en multipart),
 *             LOGISTICS? (corrections {{LOG.*}}, prioritaires sur l'article : idem),
 *             SHEET?, TRANSLATION? (fiche ajustée pour cette génération, non
 *             enregistrée : caractéristiques complètes, textes de LNGCOD ; idem)
 */
export async function generate(req) {
  utils.assertVinidocApp(req);
  const {
    SHTID,
    TPLID,
    LNGCOD,
    FORMAT,
    HVE,
    BIO,
    PACKAGING,
    COD_ARTICLE,
    FREE,
    LOGISTICS,
    SHEET,
    TRANSLATION,
  } = v.generateSchema.parse(await input(req));

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

  // Fiche ajustée pour cette génération uniquement (fiche inchangée).
  const data = utils.applyLocalChanges(snapshot, LNGCOD, SHEET, TRANSLATION);
  const color = await services.getColorTrans(data.COLCOD, LNGCOD);
  const merge = utils.buildMergeData(data, LNGCOD, color);
  merge.text = {
    ...merge.text,
    ...(await articleMergeText(COD_ARTICLE, snapshot.CODVRAC)),
    // Données logistiques corrigées par l'utilisateur (absentes ou erronées).
    ...LOGISTICS,
    // Champs libres du modèle uniquement (non saisis → vides).
    ...Object.fromEntries(
      template.TAGS.filter(
        (t) => t.TAGTYP === "TEXT" && utils.isFreeTag(t.TAGNAM),
      ).map((t) => [t.TAGNAM, FREE[t.TAGNAM] ?? ""]),
    ),
  };
  const report = utils.checkAgainstTemplate(merge.text, template.TAGS, {
    withFree: true,
  });
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
      badges: {
        ...merge.badges,
        ...utils.certificationBadges({ HVE, BIO }, template.TAGS),
        ...utils.packagingBadges(PACKAGING),
      },
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
        COD_ARTICLE: COD_ARTICLE ?? null,
        FILECODE: saved.FILECODE,
        USR,
      });
    } catch (err) {
      await discardFile(saved.FILECODE);
      throw err;
    }

    logger.info(
      `[VINIDOC] Génération ${FORMAT} | fiche ${SHTID} ${VERNUM ? `v${VERNUM}` : "saisie en cours (non validée)"} | modèle ${TPLID} | ${LNGCOD} | HVE=${HVE} BIO=${BIO} | ${PACKAGING} | ${COD_ARTICLE}${Object.keys(LOGISTICS).length ? ` (logistique corrigée : ${Object.entries(LOGISTICS).map(([k, val]) => `${k}=${val}`).join(", ")})` : ""}${SHEET || TRANSLATION ? ` | fiche ajustée localement : ${[SHEET && "caractéristiques", TRANSLATION && `textes ${LNGCOD}`].filter(Boolean).join(", ")}` : ""} | ${USR}`,
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
      COD_ARTICLE: COD_ARTICLE ?? null,
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
