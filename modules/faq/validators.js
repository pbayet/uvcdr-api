import { z } from "zod";

/**
 * Schémas zod du module faq (Foire aux questions : questions, suggestions,
 * réponses, catégories, modérateurs). Même convention que les autres
 * modules (cf. modules/ticketing/validators.js) : toute entrée client passe
 * par un schéma avant d'atteindre les services SQL.
 */

/* ─────────────────────────────────────────────
   Helpers
───────────────────────────────────────────── */

export const POST_TYPES = ["QUESTION", "SUGGESTION"];

const id = z.coerce.number().int().positive();

/** Booléen transmis en query string ("true"/"1") ou en JSON. */
const bool = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return ["true", "1", "yes", "on"].includes(String(value).toLowerCase());
}, z.boolean().optional());

/** Identifiant facultatif : "" / null → null (remise à zéro). */
const nullableId = z.preprocess(
  (value) => (value === "" || value === "null" ? null : value),
  id.nullish(),
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

const text = (max) => z.string().trim().min(1).max(max);

/* ─────────────────────────────────────────────
   Paramètres de route
───────────────────────────────────────────── */

export const pstidParamSchema = z.object({ pstid: id });
export const ansidParamSchema = z.object({ ansid: id });
export const catidParamSchema = z.object({ catid: id });
export const usridParamSchema = z.object({ usrid: id });

/* ─────────────────────────────────────────────
   Publications
───────────────────────────────────────────── */

export const postListQuerySchema = z.object({
  TYPE: z.enum(POST_TYPES).optional(),
  CATID: id.optional(),
  APPID: id.optional(),
  STSID: id.optional(),
  SEARCH: z.string().trim().max(200).optional(),
  PINNED: bool,
  MINE: bool,
  DLTD: bool,
  UNANSWERED: bool,
});

export const postCreateSchema = z.object({
  TYPE: z.enum(POST_TYPES),
  TITLE: text(255),
  BODY: text(4000),
  CATID: nullableId,
  APPID: nullableId,
});

export const postUpdateSchema = z.object({
  TITLE: text(255).optional(),
  BODY: text(4000).optional(),
  CATID: nullableId,
  APPID: nullableId,
  STSID: nullableId,
  PINNED: bool,
});

export const postDeleteSchema = z.object({
  DLTD: bool.default(true),
  PERM: bool.default(false),
});

/** Épinglage personnel (PUT /posts/:pstid/pin). */
export const postUserPinSchema = z.object({
  PINNED: bool.default(true),
});

/** "J'aime" sur une publication (PUT /posts/:pstid/like). */
export const postLikeSchema = z.object({
  LIKED: bool.default(true),
});

export const postConvertSchema = z.object({
  TYPE: z.enum(POST_TYPES),
});

export const postKeywordsSchema = z.object({
  KEYWORDS: jsonArray(z.coerce.string().trim().min(1).max(50)).pipe(
    z.array(z.string()).max(30, "30 mots-clés maximum."),
  ),
});

export const postTicketSchema = z.object({
  ANSID: id.optional(),
  TITLE: text(255),
  DESCR: z.string().trim().max(2000).nullish(),
  SRVID: id,
  PRIID: id.nullish(),
  CCAUTHORS: bool.default(true),
});

export const similarQuerySchema = z.object({
  SEARCH: z.string().trim().min(3).max(255),
  TYPE: z.enum(POST_TYPES).optional(),
  EXCLUDE: id.optional(),
});

/* ─────────────────────────────────────────────
   Réponses
───────────────────────────────────────────── */

export const answerCreateSchema = z.object({
  PSTID: id,
  BODY: text(4000),
});

export const answerUpdateSchema = z.object({
  BODY: text(4000),
});

export const answerValidateSchema = z.object({
  VALIDATED: bool.default(true),
  BODY: z.string().trim().min(1).max(4000).optional(),
});

export const answerLikeSchema = z.object({
  LIKED: bool.default(true),
});

export const answerDeleteSchema = postDeleteSchema;

/* ─────────────────────────────────────────────
   Référentiels
───────────────────────────────────────────── */

export const statusQuerySchema = z.object({
  TYPE: z.enum(POST_TYPES).optional(),
});

export const categoryCreateSchema = z.object({
  NAME: text(100),
  DESCR: z.string().trim().max(500).nullish(),
});

export const categoryUpdateSchema = z.object({
  NAME: text(100).optional(),
  DESCR: z.string().trim().max(500).nullish(),
  ACTIVE: bool,
});

export const moderatorCreateSchema = z.object({
  USRID: id,
});
