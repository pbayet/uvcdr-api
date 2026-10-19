import { z } from "zod";

/* ─────────────────────────────────────────────
   AUDITS — Schémas zod
   Les routes d'écriture sont en multipart/form-data (fichiers joints) :
   tous les champs arrivent donc sous forme de chaînes — d'où les
   z.coerce / preprocess ci-dessous.
───────────────────────────────────────────── */

const optionalText = (max) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(max).optional(),
  );

/** Date du jour (YYYY-MM-DD) dans le fuseau métier, pas en UTC. */
function todayInParis() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Paris" }).format(
    new Date(),
  );
}

/** Date "YYYY-MM-DD" (champ date HTML), réelle et non passée. */
const futureIsoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date d'expiration invalide (AAAA-MM-JJ).")
  .refine((s) => !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()), {
    message: "Date d'expiration invalide.",
  })
  .refine(
    (s) => s >= todayInParis(),
    "La date d'expiration ne peut pas être dans le passé.",
  );

/** Tableau de FILECODE, accepté en tableau ou en chaîne JSON (multipart). */
const filecodeArray = z.preprocess(
  (v) => {
    if (v == null || v === "") return [];
    if (typeof v === "string") {
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    }
    return v;
  },
  z.array(z.string().trim().min(1).max(50)).max(50),
);

const positiveInt = z.coerce.number().int().positive();

export const auditIdParamSchema = z.object({ AUDID: positiveInt });

export const auditReturnParamSchema = z.object({
  AUDID: positiveInt,
  RETID: positiveInt,
});

export const auditsQuerySchema = z.object({
  CAVEID: positiveInt.optional(),
  INCLUDE_DELETED: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .optional()
    .transform((v) => v === true || v === "true" || v === "1"),
});

export const auditCreateSchema = z.object({
  CAVEID: positiveInt,
  TITLE: z.string().trim().min(1, "L'intitulé est obligatoire.").max(150),
  DATEXP: futureIsoDate,
  COMMENT: optionalText(1000),
});

export const auditVersionSchema = z.object({
  DATEXP: futureIsoDate,
  COMMENT: optionalText(1000),
  /** Documents de la version courante à reconduire dans la nouvelle version. */
  KEEP_FILECODES: filecodeArray,
});

export const auditReturnSchema = z.object({
  /** Version sur laquelle la cave a travaillé (contrôle de concurrence). */
  VERID: positiveInt,
  COMMENT: optionalText(1000),
});

export const auditReviewSchema = z
  .object({
    DECISION: z.enum(["VALID", "INVALID"]),
    COMMENT: optionalText(1000),
  })
  .refine((b) => b.DECISION === "VALID" || !!b.COMMENT, {
    message: "Un motif est obligatoire pour refuser un retour.",
    path: ["COMMENT"],
  });

export const auditDeleteSchema = z.object({
  COMMENT: z
    .string()
    .trim()
    .min(1, "Le motif de suppression est obligatoire.")
    .max(1000),
});
