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

export const THEMES = ["light", "dark", "system"];

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
