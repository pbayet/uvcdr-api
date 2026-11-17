import { z } from "zod";

/**
 * Schémas zod du module dckmng (Dock Manager). Même convention que les
 * autres modules : toute entrée client passe par un schéma avant d'atteindre
 * les services SQL.
 */

const id = z.coerce.number().int().positive();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Date "YYYY-MM-DD" valide (pas de 2026-02-31). */
const isoDate = z
  .string()
  .trim()
  .regex(DATE_RE, "Date attendue au format AAAA-MM-JJ")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Date invalide");

/** Date facultative : "" / absente → undefined (= aujourd'hui côté SQL). */
const optionalDate = z.preprocess(
  (v) => (v === "" || v === null ? undefined : v),
  isoDate.optional(),
);

/**
 * Texte libre facultatif : espaces retirés, "" → null (champ vidé).
 * `undefined` = champ non transmis (non modifié).
 */
const nullableText = (max) =>
  z.preprocess(
    (v) => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      const s = String(v).trim();
      return s === "" ? null : s;
    },
    z.string().max(max).nullable().optional(),
  );

/** N° de quai : chiffres/lettres courts (ex. "12", "3B"). */
const dock = (max = 10) =>
  z.preprocess(
    (v) => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      const s = String(v).trim().toUpperCase();
      return s === "" ? null : s;
    },
    z
      .string()
      .max(max)
      .regex(/^[0-9A-Z-]+$/, "N° de quai invalide")
      .nullable()
      .optional(),
  );

/** Initiales / nom d'opérateur, mis en majuscules (ex. "jm" → "JM"). */
const operator = z.preprocess(
  (v) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const s = String(v).trim().toUpperCase();
    return s === "" ? null : s;
  },
  z.string().max(50).nullable().optional(),
);

/** Au moins un champ modifiable doit être transmis. */
const atLeastOne = (obj) => Object.values(obj).some((v) => v !== undefined);

/* ─────────────────────────────────────────────
   Espace cariste (public)
───────────────────────────────────────────── */

export const publicLoadUpdate = z
  .object({
    LODID: id,
    QUAEFF: dock(),
    OPEDEB: operator,
    OPEFIN: operator,
  })
  .refine(({ LODID: _id, ...rest }) => atLeastOne(rest), {
    message: "Aucun champ à modifier",
  });

/* ─────────────────────────────────────────────
   Espace admin (authentifié)
───────────────────────────────────────────── */

export const loadsQuery = z.object({
  LODDAT: optionalDate,
});

export const loadCreate = z.object({
  NOM: z.string().trim().min(1, "Nom obligatoire").max(200),
  QUAI: dock(),
});

export const loadUpdate = z
  .object({
    LODID: id,
    NOM: nullableText(200).refine((v) => v !== null, "Nom obligatoire"),
    QUAI: dock(),
    QUAEFF: dock(),
    OPEDEB: operator,
    OPEFIN: operator,
  })
  .refine(({ LODID: _id, ...rest }) => atLeastOne(rest), {
    message: "Aucun champ à modifier",
  });

export const loadId = z.object({ LODID: id });

/** Plage de statistiques : 7 derniers jours par défaut, 366 jours maximum. */
export const statsQuery = z
  .object({
    FROM: optionalDate,
    TO: optionalDate,
  })
  .transform(({ FROM, TO }) => {
    let from = FROM ?? TO;
    let to = TO ?? FROM;
    if (from && to && from > to) [from, to] = [to, from];
    return { FROM: from, TO: to };
  })
  .refine(
    ({ FROM, TO }) =>
      !FROM ||
      !TO ||
      (new Date(`${TO}T00:00:00Z`) - new Date(`${FROM}T00:00:00Z`)) / 86400000 <= 366,
    { message: "Plage limitée à 366 jours" },
  );
