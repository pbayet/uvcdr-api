import { z } from "zod";

/**
 * Schémas zod pour le module usersmanager (screens d'admin RH portés depuis
 * V1.0.0 : users, services, positions, groupes, applications). Remplace les
 * `if (!champ) throw new Error(...)` manuels de V1.0.0, dans le même esprit
 * que modules/ticketing/validators.js.
 */

// Accepte soit un tableau déjà parsé, soit une chaîne JSON (comme envoyé par
// certains clients V1.0.0) — le parsing fin (JSON.parse) reste fait dans les
// controllers via functionsUtils.parseToJSON.
const jsonArrayLike = z.union([z.array(z.any()), z.string()]).nullish();

export const userQuerySchema = z
  .object({
    email: z.string().trim().email().optional(),
    id: z.coerce.number().int().optional(),
    poscod: z.string().trim().optional(),
  })
  .refine((data) => data.email || data.id || data.poscod, {
    message: "Un des paramètres email, id ou poscod est requis.",
  });

export const permissionQuerySchema = z.object({
  lvl: z.coerce.number().int("lvl est obligatoire."),
});

export const homeApplicationsQuerySchema = z.object({
  USRID: z.coerce.number().int("USRID est obligatoire."),
});

export const upsertUserSchema = z.object({
  USRID: z.coerce.number().int().nullish(),
  LSTNAM: z.string().trim().min(1, "LSTNAM est obligatoire.").max(255),
  FSTNAM: z.string().trim().min(1, "FSTNAM est obligatoire.").max(255),
  EMAIL: z.string().trim().email("EMAIL invalide.").max(255),
  PHNNUM: z.string().trim().max(255).nullish(),
  USRACTV: z.coerce.boolean().optional(),
  ISEXT: z.coerce.boolean().optional(),
  POSID: z.coerce.number().int().nullish(),
  GRPIDS: jsonArrayLike,
  PERMISSIONS: jsonArrayLike,
  SUBORDINATES: jsonArrayLike,
  MAILCOPIES: jsonArrayLike,
  ENTITYNAME: z.string().trim().nullish(),
});

export const upsertServiceSchema = z.object({
  SRVID: z.coerce.number().int().nullish(),
  SRVCOD: z.string().trim().min(1, "SRVCOD est obligatoire.").max(10),
  SRVNAM: z.string().trim().min(1, "SRVNAM est obligatoire.").max(255),
  SRVDES: z.string().trim().max(4000).nullish(),
});

export const upsertPositionSchema = z.object({
  POSID: z.coerce.number().int().nullish(),
  POSNAM: z.string().trim().min(1, "POSNAM est obligatoire.").max(255),
  POSDES: z.string().trim().max(4000).nullish(),
  POSCOD: z.string().trim().min(1, "POSCOD est obligatoire.").max(10),
  POSLVL: z.coerce.number().int("POSLVL est obligatoire."),
  SRVCOD: z.string().trim().min(1, "SRVCOD est obligatoire.").max(10),
});

export const upsertGroupSchema = z.object({
  GRPID: z.coerce.number().int().nullish(),
  GRPNAM: z.string().trim().min(1, "GRPNAM est obligatoire.").max(255),
  GRPDES: z.string().trim().max(4000).nullish(),
  ACTIVE: z.coerce.boolean().optional(),
  GRPBAS: z.coerce.boolean().optional(),
  PERMISSIONS: jsonArrayLike,
});

export const upsertApplicationSchema = z.object({
  APPID: z.coerce.number().int().nullish(),
  APPCOD: z.string().trim().min(1, "APPCOD est obligatoire.").max(20),
  APPNAM: z.string().trim().min(1, "APPNAM est obligatoire.").max(255),
  APPDES: z.string().trim().max(4000).nullish(),
  LOGLNK: z.string().trim().max(500).nullish(),
  APPLNK: z.string().trim().max(500).nullish(),
  DOCLNK: z.string().trim().max(500).nullish(),
  IMGLNK: z.string().trim().max(500).nullish(),
  ACTIVE: z.coerce.boolean().optional(),
});

export const servicePositionPatchSchema = z.object({
  SRVCOD: z.string().trim().min(1, "SRVCOD est obligatoire.").max(10),
  POSID: z.coerce.number().int("POSID est obligatoire."),
});

export const lastVersionDetailsOpenedSchema = z.object({
  VID: z.coerce.number().int("VID est obligatoire."),
});

export const appVersionsQuerySchema = z.object({
  APPCOD: z.string().trim().min(1, "APPCOD est obligatoire.").max(20),
});

/** Plafond dur du nombre de lignes renvoyées par GET /global/activity. */
export const ACTIVITY_MAX_LIMIT = 20000;
export const ACTIVITY_DEFAULT_LIMIT = 5000;

const optionalDate = z
  .union([z.string().trim(), z.date()])
  .nullish()
  .transform((value, ctx) => {
    if (value === null || value === undefined || value === "") return undefined;
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "Date invalide." });
      return z.NEVER;
    }
    return d;
  });

const optionalEmail = z
  .string()
  .trim()
  .max(320)
  .nullish()
  .transform((value) => value || undefined);

/**
 * GET /global/activity — journal d'activité global (écran DEV). Tous les
 * paramètres sont optionnels : sans rien, renvoie les ACTIVITY_DEFAULT_LIMIT
 * événements les plus récents (actions + connexions).
 */
export const generalActivityQuerySchema = z
  .object({
    FROM: optionalDate,
    TO: optionalDate,
    EMAIL: optionalEmail,
    DEVEMAIL: optionalEmail,
    // "1"/"true" → uniquement les actions faites "en tant que" (DEVEMAIL non NULL)
    DEVONLY: z
      .union([z.boolean(), z.string()])
      .nullish()
      .transform((v) => v === true || v === "1" || v === "true"),
    SOURCE: z
      .enum(["ACTIVITY", "LOGIN"])
      .nullish()
      .transform((v) => v || undefined),
    LIMIT: z.coerce
      .number()
      .int()
      .min(1)
      .max(ACTIVITY_MAX_LIMIT)
      .default(ACTIVITY_DEFAULT_LIMIT),
  })
  .refine((d) => !d.FROM || !d.TO || d.FROM <= d.TO, {
    message: "FROM doit être antérieure à TO.",
  });

/** GET /global/activity/stats — période (défaut : 30 derniers jours, max 2 ans). */
export const activityStatsQuerySchema = z
  .object({ FROM: optionalDate, TO: optionalDate })
  .transform(({ FROM, TO }) => {
    const to = TO ?? new Date();
    const from = FROM ?? new Date(to.getTime() - 30 * 86_400_000);
    return { FROM: from, TO: to };
  })
  .refine((d) => d.FROM <= d.TO, { message: "FROM doit être antérieure à TO." })
  .refine((d) => d.TO.getTime() - d.FROM.getTime() <= 731 * 86_400_000, {
    message: "Période limitée à 2 ans.",
  });

export const activityParamsQuerySchema = z.object({
  LOG_ID: z.coerce.number().int("LOG_ID est obligatoire.").positive(),
});

export const deleteAppVersionSchema = z.object({
  VID: z.coerce.number().int("VID est obligatoire."),
});

export const lastVersionSchema = z.object({
  // Fourni pour modifier une version existante (y compris son VNUM).
  VID: z.coerce.number().int().nullish(),
  APPCOD: z.string().trim().min(1, "APPCOD est obligatoire.").max(20),
  VNUM: z.string().trim().min(1, "VNUM est obligatoire.").max(20),
  RELEASEDTE: z.coerce.date().nullish(),
  SUMMARY: z.string().trim().max(1000).nullish(),
  CHANGES: z
    .preprocess(
      (val) => (typeof val === "string" ? JSON.parse(val) : val),
      z.array(
        z.object({
          CTYPE: z.string().trim().min(1, "CTYPE est obligatoire.").max(20),
          CTITLE: z.string().trim().min(1, "CTITLE est obligatoire.").max(200),
          CDESC: z.string().trim().max(4000).nullish(),
        }),
      ),
    )
    .nullish(),
});

export const THEMES =["light", "dark", "system"];

// Codes applicatifs « de base » (portail HOME, BAS) : absents de la table
// APPLICATIONS, ils n'ont pas de thème propre et utilisent le thème par
// défaut de l'utilisateur (APPID NULL dans USRTHEME).
export const BASE_APPCODES = ["HOME", "BAS"];

const themeAppcodSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .nullish()
  .transform((APPCOD) =>
    APPCOD && BASE_APPCODES.includes(APPCOD.toUpperCase()) ? null : APPCOD,
  );

export const themeQuerySchema = z.object({
  APPCOD: themeAppcodSchema,
});

// APPCOD absent (ou code de base) = thème par défaut (THEME obligatoire) ;
// APPCOD renseigné et THEME null = l'application repasse sur le thème par
// défaut.
export const setThemeSchema = z
  .object({
    APPCOD: themeAppcodSchema,
    THEME: z.enum(THEMES, "THEME doit valoir light, dark ou system.").nullish(),
  })
  .refine((data) => data.APPCOD || data.THEME, {
    message: "THEME est obligatoire pour le thème par défaut.",
    path: ["THEME"],
  });
