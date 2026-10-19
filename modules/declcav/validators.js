import { z } from "zod";

/**
 * Schémas zod pour le module declcav (déclarations de cave — MRV, caves,
 * ingrédients, questionnaires). V1.0.0 ne validait quasiment aucune entrée
 * (les params étaient déstructurés puis passés tels quels aux requêtes SQL
 * paramétrées) — cf. audit dette technique 4.4, déjà corrigé de la même
 * façon dans modules/ticketing/validators.js.
 */

/* ─────────────────────────────────────────────
   Helpers
───────────────────────────────────────────── */

/** Accepte un tableau déjà parsé OU une chaîne JSON (le front peut envoyer
 * INGRES/CEPAGES/MAILS/RESPONSES sous forme de JSON.stringify()). */
function toArray(val) {
  if (val == null || val === "") return undefined;
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : val;
    } catch {
      return val; // laisse zod rejeter proprement (pas un tableau)
    }
  }
  return val;
}

function jsonArray(itemSchema) {
  return z.preprocess(toArray, z.array(itemSchema)).optional();
}

/* ─────────────────────────────────────────────
   GETS
───────────────────────────────────────────── */

export const foldersQuerySchema = z.object({
  CAVID: z.coerce.number().int().nullish(),
  NUMDOS: z.string().trim().min(1).nullish(),
  TYPE: z
    .enum(["default", "archives", "deletes"])
    .optional()
    .default("default"),
});

export const folderByMrvSchema = z.object({
  MRVCOD: z.string().trim().min(1, "MRVCOD est obligatoire."),
  DEL: z.boolean().optional().nullish().default(null),
});

export const cavesQuerySchema = z.object({
  ASCCI: z.string().trim().min(1).nullish(),
  NUMFOURN: z.string().trim().min(1).nullish(),
});

export const responsesQuerySchema = z.object({
  REFEXT: z.string().trim().min(1).nullish(),
});

/* ─────────────────────────────────────────────
   DÉCLARATIONS (DECENT)
───────────────────────────────────────────── */

export const declarationCreateSchema = z.object({
  REFMAR: z.string().trim().min(1, "REFMAR est obligatoire.").max(20),
  REFINTR: z.string().trim().max(15).nullish(),
  DATMRC: z.coerce.date().nullish(),
  DEBMRV: z.coerce.date().nullish(),
  FINMRV: z.coerce.date().nullish(),
  REMARQ: z.string().trim().max(255).nullish(),
  CAVEID: z.coerce.number().int("CAVEID est obligatoire."),
  REFVRAC: z.string().trim().max(10).nullish(),
  DESA1: z.string().trim().max(120).nullish(),
  DESA2: z.string().trim().min(1, "DESA2 est obligatoire.").max(120),
  APPL: z.string().trim().max(50).nullish(),
  COUL: z.string().trim().max(50).nullish(),
  QTEMRV: z.coerce.number().nonnegative("QTEMRV est obligatoire."),
  TYPO: z.string().trim().max(50).nullish(),
  SPECTYPO: z.string().trim().max(50).nullish(),
  QAL: z.coerce.number().int().nullish(),
  DECLQST: z.coerce.boolean().optional().default(false),
});

export const relaunchQuerySchema = z.object({
  NUMDOS: z.string().trim().min(1).nullish(),
});

const ingredientLineSchema = z.object({
  CODE: z.string().trim().min(1, "CODE est obligatoire.").max(50),
  REMARK: z.string().trim().max(255).nullish(),
  // Non persisté (DECLIGING ne stocke que CODE/REMARQ) — utilisé côté
  // contrôleur pour détecter les ingrédients à surveiller (AVISUV1 === 3)
  // et déclencher l'alerte mail "badIngre".
  AVISUV1: z.coerce.number().int().nullish(),
});

const cepageLineSchema = z.object({
  CODE: z.string().trim().min(1, "CODE est obligatoire.").max(50),
  POURC: z.coerce.number().min(0).max(100).nullish(),
  REMARK: z.string().trim().max(255).nullish(),
});

export const rectificationSchema = z.object({
  NUMDOS: z.string().trim().min(1, "NUMDOS est obligatoire."),
  INGRES: jsonArray(ingredientLineSchema),
  CEPAGES: jsonArray(cepageLineSchema),
  DONE: z.boolean(),
});

export const mrvIngredientsSchema = z.object({
  NUMDOS: z.string().trim().min(1, "NUMDOS est obligatoire."),
  INGRES: jsonArray(ingredientLineSchema),
  CEPAGES: jsonArray(cepageLineSchema),
  ISRECT: z.coerce.boolean().optional().default(false),
  VALDDATE: z.string().trim(),
  DONE: z.boolean(),
});

/**
 * PATCH / — Actualisation d'un dossier depuis l'ERP (X3), déclenchée par
 * le bouton "Actualiser depuis l'ERP" sur la fiche dossier (en cours et
 * archivé). Seul NUMDOS est requis : les données MRV (désignation,
 * appellation, couleur, volume, typologie, qualité, références, dates de
 * campagne) sont relues depuis x3v12/ingredients/mrv à partir du REFMAR déjà
 * enregistré sur le dossier.
 */
export const declarationRefreshErpSchema = z.object({
  NUMDOS: z.string().trim().min(1, "NUMDOS est obligatoire."),
});

/* ─────────────────────────────────────────────
   CAVES
───────────────────────────────────────────── */

const caveMailSchema = z.object({
  MAIL: z.string().trim().email("Adresse mail invalide."),
  PRIMAIL: z.coerce.boolean().optional().default(false),
  ACTIF: z.coerce.boolean().optional().default(true),
});

export const caveUpsertSchema = z.object({
  CAVEID: z.coerce.number().int().nullish(),
  CAVENOM: z.string().trim().min(1, "CAVENOM est obligatoire.").max(255),
  TYPID: z.coerce.number().int("TYPID est obligatoire."),
  CDFRX3: z.string().trim().max(50).nullish(),
  SIRET: z.string().trim().max(20).nullish(),
  CODACCI: z.string().trim().max(50).nullish(),
  MAILS: jsonArray(caveMailSchema),
});

export const cavePasswordSchema = z.object({
  CAVEID: z.coerce.number().int("CAVEID est obligatoire."),
});

export const caveDeleteSchema = z.object({
  CAVEID: z.coerce.number().int("CAVEID est obligatoire."),
});

/* ─────────────────────────────────────────────
   QUESTIONNAIRES (RESPONSES)
───────────────────────────────────────────── */

const answerLineSchema = z.object({
  ASWRID: z.coerce.number().int().nullish(),
  QSTCOD: z.string().trim().min(1, "QSTCOD est obligatoire.").max(150),
  PRTQSTCOD: z.string().trim().max(150).nullish(),
  ROWCOD: z.string().trim().max(150).nullish(),
  ASWRTYP: z.string().trim().max(30).nullish(),
  VALTXT: z.string().trim().max(2000).nullish(),
  VALBIT: z.coerce.boolean().nullish(),
  VALNUM: z.coerce.number().nullish(),
  VALJSON: z
    .union([z.string(), z.record(z.string(), z.any()), z.array(z.any())])
    .nullish(),
});

export const responsesUpsertSchema = z.object({
  REFEXT: z.string().trim().min(1, "REFEXT est obligatoire."),
  SUBID: z.coerce.number().int().nullish(),
  STATUS: z.string().trim().max(20).optional().default("DRAFT"),
  DONE: z.coerce.boolean().optional().default(false),
  VALID: z.coerce.boolean().optional().default(false),
  INVALID: z.coerce.boolean().optional().default(false),
  RESPONSES: z
    .preprocess(toArray, z.array(answerLineSchema))
    .refine((arr) => arr.length > 0, "RESPONSES est obligatoire."),
});

/* ─────────────────────────────────────────────
   INGRÉDIENTS
───────────────────────────────────────────── */

export const ingredientPatchSchema = z.object({
  IS_CEP: z.coerce.boolean().optional().default(false),
  CODE: z.string().trim().min(1, "CODE est obligatoire.").max(10),
  LIBEL: z.string().trim().min(1, "LIBEL est obligatoire.").max(120),
  AVISUV1: z.coerce.number().int().nullish(),
  AVISUV2: z.coerce.number().int().nullish(),
  ACTIF: z.coerce.boolean().optional().default(true),
  REMARK: z.string().trim().max(255).nullish(),
});

/* ─────────────────────────────────────────────
   SUPPRESSION
───────────────────────────────────────────── */

export const declDeleteSchema = z.object({
  NUMDOS: z.string().trim().min(1, "NUMDOS est obligatoire."),
});
