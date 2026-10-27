import { z } from "zod";

/**
 * Schémas zod pour le module fsa (Fiches Suivi Affaires — dossiers commerciaux,
 * gestionnaires, validations). V1.0.0 ne validait quasiment aucune entrée
 * (les params étaient déstructurés puis passés tels quels aux requêtes SQL/
 * procédures stockées), cf. audit dette technique 4.4 — déjà corrigé de la
 * même façon dans modules/declcav/validators.js et modules/ticketing/validators.js.
 */

/* ─────────────────────────────────────────────
   Helpers
───────────────────────────────────────────── */

/** Accepte un tableau/objet déjà parsé OU une chaîne JSON (le front V1.0.0
 * envoyait FSACLIENT_STRINGIFY / FSAPRODUITS_STRINGIFY / FSAVENTES_STRINGIFY /
 * FSAPJS_STRINGIFY / GESTS en JSON.stringify()). */
function toParsed(val) {
  if (val == null || val === "") return undefined;
  if (typeof val === "object") return val;
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return val; // laisse zod rejeter proprement (pas un objet/tableau)
    }
  }
  return val;
}

function jsonArray(itemSchema) {
  return z.preprocess(toParsed, z.array(itemSchema)).optional();
}

function jsonObject(objSchema) {
  return z.preprocess(toParsed, objSchema).optional();
}

/* ─────────────────────────────────────────────
   GETS
───────────────────────────────────────────── */

export const foldersQuerySchema = z.object({
  numdos: z.string().trim().min(1).nullish(),
  numges: z.string().trim().min(1).nullish(),
  permlvl: z.coerce.number().int().nullish(),
  type: z
    .enum(["default", "archive", "delete", "all"])
    .optional()
    .default("default"),
});

export const statusGestQuerySchema = z.object({
  usrid: z.coerce.number().int("usrid est obligatoire."),
});

export const gestsMustValidateByNumDosSchema = z.object({
  numdos: z.string().trim().min(1, "numdos est obligatoire."),
});

export const relaunchTestQuerySchema = z.object({
  numges: z.string().trim().min(1, "numges est obligatoire.").max(15),
});

/* ─────────────────────────────────────────────
   FSA — POST / DUPLICATE
───────────────────────────────────────────── */

const nomenclatureIgnoreCodeSchema = z.array(z.string());

export const fsaCreateSchema = z.object({
  PFICOD: z.string().trim().nullish(),
  NUMDOSBAS: z.string().trim().nullish(),
  NOMDOS: z.string().trim().min(1, "NOMDOS est obligatoire.").max(255),
  TYPDOS: z.string().trim().min(1, "TYPDOS est obligatoire.").max(15),
  NUMGES: z.string().trim().min(1, "NUMGES est obligatoire.").max(15),
  NUMDEM: z.string().trim().nullish(),
  INNO: z.coerce.boolean().optional().default(false),
  NOTDOS: z.string().trim().nullish(),
  IGNNOMCOD: nomenclatureIgnoreCodeSchema.default([]),
});

export const fsaDuplicateSchema = z.object({
  NUMDOS: z.string().trim().min(1, "NUMDOS est obligatoire."),
  NOMDOS: z.string().trim().nullish(),
  PFICOD: z.string().trim().nullish(),
  NOTDOS: z.string().trim().nullish(),
});

/* ─────────────────────────────────────────────
   VALIDATIONS
───────────────────────────────────────────── */

export const validationCreateSchema = z.object({
  NUMDOS: z.string().trim().min(1, "NUMDOS est obligatoire."),
  VALTYPCOD: z.string().trim().min(1, "VALTYPCOD est obligatoire.").max(15),
  VALNOT: z.string().trim().nullish(),
});

export const validationDeleteSchema = z.object({
  NUMDOS: z.string().trim().min(1, "NUMDOS est obligatoire."),
});

/* ─────────────────────────────────────────────
   GESTIONNAIRES
───────────────────────────────────────────── */

export const gestionnaireCreateSchema = z.object({
  NUMGES: z.string().trim().min(1, "NUMGES est obligatoire.").max(15),
  NOMGES: z.string().trim().min(1, "NOMGES est obligatoire.").max(50),
  VALGES: z.coerce.boolean().optional().default(false),
  CREGES: z.coerce.boolean().optional().default(false),
  SERVGES: z.string().trim().max(50).nullish(),
  ENBUSRS: z.string().trim().max(250).nullish(),
});

const gestionnairePatchLineSchema = z.object({
  NUMGES: z.string().trim().min(1, "NUMGES est obligatoire.").max(15),
  VALGES: z.coerce.boolean().optional().default(false),
  CREGES: z.coerce.boolean().optional().default(false),
  ENBUSRS: z.string().trim().max(250).nullish(),
});

export const gestionnairesPatchSchema = z.object({
  GESTS: z
    .preprocess(toParsed, z.array(gestionnairePatchLineSchema))
    .refine((arr) => arr.length > 0, "GESTS est obligatoire."),
});

export const gestionnairePatchSchema = z.object({
  NUMGES: z.string().trim().min(1, "NUMGES est obligatoire.").max(15),
  VALGES: z.coerce.boolean().optional().default(false),
  CREGES: z.coerce.boolean().optional().default(false),
  ENBUSRS: z.string().trim().max(250).nullish(),
});

export const gestionnaireDeleteSchema = z.object({
  NUMGES: z.string().trim().min(1, "NUMGES est obligatoire.").max(15),
});

/* ─────────────────────────────────────────────
   FSA — PATCH (dossier complet)
───────────────────────────────────────────── */

const nomenclatureLineSchema = z.object({
  ITMCAT: z.string().trim().nullish(),
  DESCAT: z.string().trim().nullish(),
  ITMREF: z.string().trim().nullish(),
  ITMDES: z.string().trim().nullish(),
  BASQTY: z.coerce.number().nullish(),
  CPNITMREF: z.string().trim().nullish(),
  CPNITMDES: z.string().trim().nullish(),
  BOMUOM: z.string().trim().nullish(),
  BOMSTUCOE: z.coerce.number().nullish(),
  BOMQTY: z.coerce.number().nullish(),
  LIKQTY: z.coerce.number().nullish(),
  STU: z.string().trim().nullish(),
  ITMMIL: z.coerce.number().int().nullish(),
  ITMMILN: z.coerce.number().int().nullish(),
  NOTLINC: z.string().trim().nullish(),
  NOTDOS: z.string().trim().nullish(),
});

const produitSchema = z.object({
  TCLCOD: z.string().trim().nullish(),
  CATNOM: z.string().trim().nullish(),
  ITMREF: z.string().trim().nullish(),
  ITMDES: z.string().trim().nullish(),
  ITMFMT: z.string().trim().nullish(),
  DESFMT: z.string().trim().nullish(),
  CENTFMT: z.coerce.number().nullish(),
  ITMMAR: z.string().trim().nullish(),
  DESMAR: z.string().trim().nullish(),
  ITMGAM: z.string().trim().nullish(),
  DESGAM: z.string().trim().nullish(),
  ITMAPP: z.string().trim().nullish(),
  DESAPP: z.string().trim().nullish(),
  ITMCEP: z.string().trim().nullish(),
  DESCEP: z.string().trim().nullish(),
  ITMCOU: z.string().trim().nullish(),
  DESCOU: z.string().trim().nullish(),
  ITMQUA: z.string().trim().nullish(),
  DESQUA: z.string().trim().nullish(),
  ITMTYP: z.string().trim().nullish(),
  DESTYP: z.string().trim().nullish(),
  ITMSPT: z.string().trim().nullish(),
  DESSPT: z.string().trim().nullish(),
  ITMMIL: z.coerce.number().int().nullish(),
  CODCHADOM: z.string().trim().nullish(),
  CHADOM: z.string().trim().nullish(),
  CODDESALC: z.coerce.boolean().nullish(),
  CODBOIS: z.coerce.boolean().nullish(),
  MEDAIL: z.coerce.boolean().nullish(),
  ITMCON: z.coerce.number().nullish(),
  ITMNOT: z.string().trim().nullish(),
  NOMENCLATURES: jsonArray(nomenclatureLineSchema),
});

const clientSchema = z.object({
  CLIEXI: z.coerce.boolean().optional().default(false),
  BPCNUM: z.string().trim().nullish(),
  BPCNAM: z.string().trim().nullish(),
  // V1.0.0 lit `FSACLIENT.CLIPAY.CLIPAY` (objet imbriqué) au moment de
  // l'upsert — on conserve cette forme pour ne pas casser le contrat front.
  CLIPAY: z.object({ CLIPAY: z.string().trim().nullish() }).nullish(),
  CLIACT: z.string().trim().nullish(),
  NOMACT: z.string().trim().nullish(),
  CLICCON: z.string().trim().nullish(),
  CLINAM: z.string().trim().nullish(),
  CLIMAIL: z.string().trim().nullish(),
  CLITEL: z.string().trim().nullish(),
  CLINOT: z.string().trim().nullish(),
});

const venteSchema = z.object({
  DATMAD: z.coerce.date().nullish(),
  ONESHO: z.coerce.boolean().optional().default(false),
  VOLANN: z.coerce.number().nullish(),
  VOLANN1: z.coerce.number().nullish(),
  VOLANN2: z.coerce.number().nullish(),
  PRIANN: z.coerce.number().nullish(),
  PRIANN1: z.coerce.number().nullish(),
  PRIANN2: z.coerce.number().nullish(),
  PVC: z.coerce.number().nullish(),
  VENNOT: z.string().trim().nullish(),
  FRANCO: z.coerce.boolean().optional().default(false),
  FDC: z.coerce.boolean().optional().default(false),
  AFA: z.coerce.boolean().optional().default(false),
  AFANOT: z.string().trim().nullish(),
  VOLTIR: z.coerce.number().nullish(),
});

const pjLineSchema = z.object({
  PJN: z.string().trim().nullish(),
  PJL: z.string().trim().nullish(),
});

export const fsaPatchSchema = z.object({
  NUMDOS: z.string().trim().min(1, "NUMDOS est obligatoire."),
  ENT_NOMDOS: z.string().trim().nullish(),
  ENT_NOTDOS: z.string().trim().nullish(),
  FSACLIENT_STRINGIFY: jsonObject(clientSchema),
  FSAPRODUITS_STRINGIFY: jsonObject(produitSchema),
  FSAVENTES_STRINGIFY: jsonObject(venteSchema),
  FSAPJS_STRINGIFY: jsonArray(pjLineSchema),
  EAV: z.coerce.boolean().optional().default(false),
});

export const fsaNotesPatchSchema = z.object({
  NUMDOS: z.string().trim().min(1, "NUMDOS est obligatoire."),
  NOTDOS: z.string().trim().nullish(),
});

/* ─────────────────────────────────────────────
   SETTINGS — PATCH (paramètres globaux, table singleton FSASETTINGS)
───────────────────────────────────────────── */

/** Chaque délai est optionnel (mise à jour partielle : cf. services.patchSettings,
 * COALESCE côté SQL), mais au moins un doit être fourni. */
export const settingsPatchSchema = z
  .object({
    VALDELAY: z.coerce
      .number()
      .int("VALDELAY doit être un nombre entier.")
      .min(0, "VALDELAY doit être supérieur ou égal à 0.")
      .optional(),
    ARCDELAY: z.coerce
      .number()
      .int("ARCDELAY doit être un nombre entier.")
      .min(0, "ARCDELAY doit être supérieur ou égal à 0.")
      .optional(),
    DELDELAY: z.coerce
      .number()
      .int("DELDELAY doit être un nombre entier.")
      .min(0, "DELDELAY doit être supérieur ou égal à 0.")
      .optional(),
    PURDELAY: z.coerce
      .number()
      .int("PURDELAY doit être un nombre entier.")
      .min(0, "PURDELAY doit être supérieur ou égal à 0.")
      .optional(),
  })
  .refine(
    (data) =>
      data.VALDELAY !== undefined ||
      data.ARCDELAY !== undefined ||
      data.DELDELAY !== undefined ||
      data.PURDELAY !== undefined,
    "Au moins un paramètre doit être fourni.",
  );

/* ─────────────────────────────────────────────
   FSA — DELETE
───────────────────────────────────────────── */

export const fsaDeleteSchema = z.object({
  NUMDOS: z.string().trim().min(1, "NUMDOS est obligatoire."),
  DELETED: z.coerce.boolean().optional().default(true),
});
