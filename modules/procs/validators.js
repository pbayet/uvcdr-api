import { z } from "zod";

/**
 * Schémas zod du module procs (Procédures UVCDR). Même convention que les
 * autres modules (cf. modules/faq/validators.js) : toute entrée client passe
 * par un schéma avant d'atteindre les services SQL.
 */

export const STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"];

const id = z.coerce.number().int().positive();

/** Booléen transmis en query string / multipart ("true"/"1") ou en JSON. */
const bool = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return ["true", "1", "yes", "on"].includes(String(value).toLowerCase());
}, z.boolean().optional());

/** Valeur facultative : "" / "null" → null (remise à zéro). */
const emptyToNull = (value) =>
  value === "" || value === "null" || value === "undefined" ? null : value;

const nullableId = z.preprocess(emptyToNull, id.nullish());

const nullableText = (max) =>
  z.preprocess(
    emptyToNull,
    z
      .string()
      .trim()
      .max(max)
      .nullish()
      // Absent → undefined (champ inchangé) ; vide → null (champ effacé).
      .transform((v) => (v === undefined ? undefined : v || null)),
  );

const text = (max) => z.string().trim().min(1).max(max);

/** Date "AAAA-MM-JJ" facultative. */
const nullableDate = z.preprocess(
  emptyToNull,
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}/, "Date attendue au format AAAA-MM-JJ.")
    .transform((v) => v.slice(0, 10))
    .nullish(),
);

/** Tableau transmis en JSON (multipart / query) ou déjà parsé. */
function jsonArray(itemSchema) {
  return z.preprocess((value) => {
    if (value == null || value === "") return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [value];
      } catch {
        return value.split(",");
      }
    }
    return value;
  }, z.array(itemSchema));
}

const keywords = jsonArray(z.coerce.string().trim().min(1).max(50)).pipe(
  z.array(z.string()).max(30, "30 mots-clés maximum."),
);

/* ─────────────────────────────────────────────
   Paramètres de route
───────────────────────────────────────────── */

export const prcidParamSchema = z.object({ prcid: id });
export const veridParamSchema = z.object({ verid: id });
export const catidParamSchema = z.object({ catid: id });

/* ─────────────────────────────────────────────
   Procédures
───────────────────────────────────────────── */

export const procedureListQuerySchema = z.object({
  SEARCH: z.string().trim().max(200).optional(),
  /** Catégorie : inclut ses sous-catégories (jusqu'à 2 niveaux sous elle). */
  CATID: id.optional(),
  /** true : uniquement les procédures rangées directement dans CATID. */
  DIRECT: bool,
  /** Filtre de statut (rédacteurs uniquement ; lecteurs : PUBLISHED forcé). */
  STATUS: z.enum(STATUSES).optional(),
  /** Révision dépassée (REVIEWDAT < aujourd'hui) — rédacteurs. */
  OVERDUE: bool,
  /** Fiches supprimées (corbeille) — rédacteurs. */
  DLTD: bool,
});

export const procedureCreateSchema = z.object({
  REFCODE: nullableText(50),
  TITLE: text(255),
  SUMMARY: nullableText(2000),
  /** Catégorie obligatoire (n'importe quel niveau de l'arborescence). */
  CATID: z.coerce
    .number({ message: "La catégorie est obligatoire." })
    .int()
    .positive("La catégorie est obligatoire."),
  OWNER: nullableText(150),
  REVIEWDAT: nullableDate,
  KEYWORDS: keywords.optional(),
  /** Publier immédiatement (sinon : brouillon). */
  PUBLISH: bool.default(false),
  /** Motif / commentaire de la première version. */
  COMMENT: nullableText(1000),
});

export const procedureUpdateSchema = z.object({
  REFCODE: nullableText(50),
  TITLE: text(255).optional(),
  SUMMARY: nullableText(2000),
  /** Catégorie : modifiable mais jamais retirée (obligatoire). */
  CATID: id.optional(),
  OWNER: nullableText(150),
  REVIEWDAT: nullableDate,
  KEYWORDS: keywords.optional(),
});

export const procedureStatusSchema = z.object({
  STATUS: z.enum(STATUSES),
  COMMENT: nullableText(1000),
});

export const procedureDeleteSchema = z.object({
  /** false = restaurer une fiche supprimée. */
  DLTD: bool.default(true),
});

export const versionCreateSchema = z.object({
  COMMENT: nullableText(1000),
  /** Publier la fiche avec cette nouvelle version. */
  PUBLISH: bool.default(false),
});

export const versionRestoreSchema = z.object({
  COMMENT: nullableText(1000),
});

export const textQuerySchema = z.object({
  prcid: id,
  /** Version (rédacteurs) ; version courante par défaut. */
  VERID: id.optional(),
});

export const fileQuerySchema = z.object({
  /** inline = consultation dans le navigateur, attachment = téléchargement. */
  DISPOSITION: z.enum(["inline", "attachment"]).default("inline"),
  /** original = document déposé, preview = aperçu PDF généré. */
  KIND: z.enum(["original", "preview"]).default("original"),
});

/* ─────────────────────────────────────────────
   Journal / consultations
───────────────────────────────────────────── */

export const historyQuerySchema = z.object({
  PRCID: id.optional(),
  USRID: id.optional(),
  ACTION: z.string().trim().max(30).optional(),
  FROM: nullableDate,
  TO: nullableDate,
  LIMIT: z.coerce.number().int().min(1).max(5000).default(500),
});

/* ─────────────────────────────────────────────
   Catégories
───────────────────────────────────────────── */

const color = z.preprocess(
  emptyToNull,
  z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{3,8}$/, "Couleur attendue au format #RRGGBB.")
    .nullish(),
);

const icon = z.preprocess(
  emptyToNull,
  z
    .string()
    .trim()
    .max(50)
    .regex(/^[a-z0-9-]+$/, "Nom d'icône Font Awesome attendu (ex: truck).")
    .nullish(),
);

export const categoryListQuerySchema = z.object({
  /** Inclure les catégories désactivées (rédacteurs). */
  ALL: bool,
});

export const categoryCreateSchema = z.object({
  NAME: text(100),
  DESCR: nullableText(500),
  PARENTID: nullableId,
  COLOR: color,
  ICON: icon,
  SORTORD: z.coerce.number().int().min(0).max(100000).optional(),
});

export const categoryUpdateSchema = z.object({
  NAME: text(100).optional(),
  DESCR: nullableText(500),
  PARENTID: nullableId,
  COLOR: color,
  ICON: icon,
  SORTORD: z.coerce.number().int().min(0).max(100000).optional(),
  ACTIVE: bool,
});
