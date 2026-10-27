import { z } from "zod";
import { TAG_MAXLEN_MAX, TAG_MAXLEN_MIN, cleanText } from "./utils.js";

/* ─────────────────────────────────────────────
   VINIDOC — Schémas zod
   Les routes multipart (modèles, génération) reçoivent tous leurs champs
   en chaînes : d'où les z.coerce / preprocess.
───────────────────────────────────────────── */

const emptyToUndefined = (v) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const emptyToNull = (v) => (typeof v === "string" && v.trim() === "" ? null : v);

/** Texte optionnel ; "" ou null → null (= effacer la valeur). */
const optText = (max) =>
  z.preprocess(emptyToNull, z.string().trim().max(max, `${max} caractères maximum.`).nullish());

/**
 * Texte œnologique optionnel, nettoyé (cf. utils.cleanText : retours à la
 * ligne, espaces en trop, caractères invisibles) ; vide → null.
 */
const cleanedText = (max) =>
  z.preprocess(
    (v) => (typeof v === "string" ? cleanText(v) : v),
    z.string().max(max, `${max} caractères maximum.`).nullish(),
  );

const optInt = (schema) => z.preprocess(emptyToNull, schema.nullish());

const positiveInt = z.coerce.number().int().positive();
const scale = z.coerce.number().int().min(1, "Valeur entre 1 et 5.").max(5, "Valeur entre 1 et 5.");
const temperature = z.coerce.number().min(-5).max(30).multipleOf(0.5, "Pas de 0,5 °C.");

export const lngCode = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z]{2}(-[a-z]{2})?$/, "Code langue invalide (ex. fr, en).");

export const rowver = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{16}$/, "ROWVER invalide (valeur renvoyée par la lecture de la fiche).");

const boolish = z.preprocess(
  (v) => (v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : v),
  z.boolean(),
);

/** Code article X3 (ex. PFI01140). */
export const articleCode = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(30)
  .regex(/^[A-Z0-9_.-]+$/, "Code article invalide (ex. PFI01140).");

const optArticle = z.preprocess(emptyToUndefined, articleCode.optional());

/* ───────────────────────────── Paramètres ───────────────────────────── */

export const sheetIdParam = z.object({ SHTID: positiveInt });
export const sheetLngParam = z.object({ SHTID: positiveInt, LNGCOD: lngCode });
export const sheetVersionParam = z.object({ SHTID: positiveInt, VERNUM: positiveInt });
export const templateIdParam = z.object({ TPLID: positiveInt });
export const articleParam = z.object({ COD_ARTICLE: articleCode });

export const articleSearchQuery = z.object({
  SEARCH: z.preprocess(emptyToUndefined, z.string().trim().max(100).optional()),
  LIMIT: z.coerce.number().int().min(1).max(50).default(30),
});

/* ───────────────────────────── Fiches ───────────────────────────── */

export const sheetListQuery = z.object({
  SEARCH: z.preprocess(emptyToUndefined, z.string().trim().max(100).optional()),
  STATUS: z.preprocess(
    emptyToUndefined,
    z.enum(["DRAFT", "SUBMITTED", "VALIDATED", "REJECTED"]).optional(),
  ),
  COLCOD: z.preprocess(emptyToUndefined, z.string().trim().toUpperCase().max(10).optional()),
  MILLESIME: z.preprocess(emptyToUndefined, z.coerce.number().int().optional()),
  GENERABLE: z.preprocess(emptyToUndefined, boolish.optional()), // au moins une version validée
  PAGE: z.coerce.number().int().min(1).default(1),
  PAGESIZE: z.coerce.number().int().min(1).max(200).default(50),
});

const translationFields = {
  LIBELLE: cleanedText(200),
  TERROIR: cleanedText(4000),
  VINIF: cleanedText(4000),
  DEGUST: cleanedText(4000),
  GARDE: cleanedText(100),
  CEPAGES: cleanedText(1000),
  ACCORDS: cleanedText(1000),
  ACCEXPL: cleanedText(4000),
};

export const translationSchema = z.object(translationFields);

const sheetCommonFields = {
  CODVRAC: z
    .string()
    .trim()
    .toUpperCase()
    .min(1, "Code vrac obligatoire.")
    .max(30)
    .regex(/^[A-Z0-9_.-]+$/, "Code vrac : lettres, chiffres, '-', '_' ou '.' uniquement."),
  MILLESIME: optInt(z.coerce.number().int().min(1900).max(2200)),
  APPELL: z.preprocess(
    (v) => (typeof v === "string" ? (cleanText(v) ?? "") : v),
    z.string().min(1, "Appellation obligatoire.").max(100),
  ),
  COLCOD: z.string().trim().toUpperCase().min(1, "Couleur obligatoire.").max(10),
  DESCVRAC: cleanedText(100),
  INTARO: optInt(scale),
  INTBOU: optInt(scale),
  ECHFRU: optInt(scale),
  TEMPMIN: optInt(temperature),
  TEMPMAX: optInt(temperature),
};

function refineSheet(data, ctx) {
  if (data.TEMPMIN != null && data.TEMPMAX != null && data.TEMPMIN > data.TEMPMAX) {
    ctx.addIssue({
      code: "custom",
      path: ["TEMPMAX"],
      message: "La température max doit être supérieure ou égale à la température min.",
    });
  }
}

/** Création : champs communs + traduction dans la langue par défaut (optionnelle). */
export const sheetCreateSchema = z
  .object({
    ...sheetCommonFields,
    TRANSLATION: translationSchema.optional(),
  })
  .superRefine(refineSheet);

/** Mise à jour complète des champs communs (PUT), avec verrou optimiste. */
export const sheetUpdateSchema = z
  .object({ ...sheetCommonFields, ROWVER: rowver })
  .superRefine(refineSheet);

/** Modèle PowerPoint par défaut ; null (ou "") = aucun. */
export const sheetDefaultTemplateSchema = z.object({
  DEFTPLID: optInt(positiveInt),
  ROWVER: rowver,
});

export const translationUpsertSchema = translationSchema.extend({ ROWVER: rowver });

export const rowverOnlySchema = z.object({ ROWVER: rowver });

export const workflowCommentSchema = z.object({
  ROWVER: rowver,
  COMMENT: optText(1000),
});

/** Soumission en masse : mêmes filtres que la liste des fiches. */
export const submitSheetsSchema = z.object({
  SEARCH: z.preprocess(emptyToUndefined, z.string().trim().max(100).optional()),
  COLCOD: z.preprocess(emptyToUndefined, z.string().trim().toUpperCase().max(10).optional()),
  MILLESIME: z.preprocess(emptyToUndefined, z.coerce.number().int().optional()),
  COMMENT: optText(1000),
});

export const rejectSchema = z.object({
  ROWVER: rowver,
  COMMENT: z.string().trim().min(3, "Le motif du refus est obligatoire.").max(1000),
});

/** Contrôle des longueurs avant génération (ou pendant la saisie). */
export const checkSchema = z.object({
  LNGCOD: lngCode,
  // Article PFI : balises logistiques {{LOG.*}} (vides sinon).
  COD_ARTICLE: optArticle,
  TPLID: z.preprocess(emptyToUndefined, positiveInt.optional()),
  // VALIDATED = dernière version validée (ce qui sera généré) ;
  // CURRENT = données en cours de saisie (aide à la rédaction).
  SOURCE: z.enum(["VALIDATED", "CURRENT"]).default("CURRENT"),
});

/* ───────────────────────────── Modèles ───────────────────────────── */

export const templateCreateSchema = z.object({
  TPLNAM: z.string().trim().min(1, "Nom du modèle obligatoire.").max(150),
  DESCR: optText(1000),
  LNGCOD: z.preprocess(emptyToNull, lngCode.nullish()),
});

export const templateUpdateSchema = templateCreateSchema.extend({
  ACTIVE: boolish,
  ROWVER: rowver,
});

export const templateListQuery = z.object({
  ACTIVE: z.preprocess(emptyToUndefined, boolish.optional()),
  LNGCOD: z.preprocess(emptyToUndefined, lngCode.optional()),
});

export const templateTagsSchema = z.object({
  TAGS: z
    .array(
      z.object({
        TAGTYP: z.enum(["TEXT", "IMAGE", "BADGE"]).default("TEXT"),
        TAGNAM: z.string().trim().toUpperCase().min(1).max(100),
        MAXLEN: optInt(z.coerce.number().int().min(TAG_MAXLEN_MIN).max(TAG_MAXLEN_MAX)),
        REQUIRED: boolish.default(false),
      }),
    )
    .min(1)
    .max(300),
});

export const mergeFieldsQuery = z.object({
  LNGCOD: z.preprocess(emptyToUndefined, lngCode.optional()),
});

/* ───────────────────────────── Génération ───────────────────────────── */

export const generateSchema = z.object({
  SHTID: positiveInt,
  TPLID: positiveInt,
  LNGCOD: lngCode,
  // Article PFI dont le code vrac est celui de la fiche : balises {{LOG.*}}.
  COD_ARTICLE: optArticle,
  FORMAT: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
    z.enum(["pptx", "pdf"]).default("pdf"),
  ),
  // Logos de certification (formes "badge:HVE" / "badge:BIO") : masqués par défaut.
  HVE: boolish.default(false),
  BIO: boolish.default(false),
});

export const generationListQuery = z.object({
  SHTID: z.preprocess(emptyToUndefined, positiveInt.optional()),
  TPLID: z.preprocess(emptyToUndefined, positiveInt.optional()),
  LIMIT: z.coerce.number().int().min(1).max(500).default(100),
});
