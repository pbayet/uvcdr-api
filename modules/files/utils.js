import { z } from "zod";

export const uploadFilesSchema = z.object({
  appcode: z
    .string()
    .trim()
    .min(2)
    .max(50)
    .regex(/^[a-zA-Z0-9_-]+$/),
  entityid: z.string().trim().min(1).max(100),
  entitytyp: z.string().trim().min(1).max(100),
  ignoreIfExist: z.string().trim().max(100).optional(),
});

export const deleteFilesSchema = z.object({
  metas: z.array(
    z.object({
      filecode: z.string().trim().min(1).optional(),
      entity: z
        .object({
          entityName: z.string().trim().min(1),
          entityId: z.string().trim().min(1),
        })
        .optional(),
    }),
  ),
});

export const revokeSignatureSchema = z.object({
  reason: z.string().trim().max(255).optional(),
});

/** Booléen reçu en JSON, query string ou multipart ("true" / "1"…). */
const bool = (defaultValue) =>
  z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return defaultValue;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    return ["true", "1", "yes", "on", "oui"].includes(String(value).toLowerCase());
  }, z.boolean());

/** Objet reçu en JSON, ou en texte JSON (query string / multipart). */
const jsonObject = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}, z.record(z.string(), z.unknown()));

/** Nom d'un lien : texte libre (100 caractères) ; vide ou null : pas de nom. */
const linkName = z.preprocess(
  (value) => (value === null ? null : typeof value === "string" ? value.trim() || null : value),
  z.string().max(100, "Le nom du lien ne doit pas dépasser 100 caractères.").nullable(),
);

/**
 * POST /api/files/links — `EXPIRESIN` : secondes, ou « 30m », « 12h »,
 * « 7d » / « 7j », « 2w », « 1y » (cf. links.parseDuration).
 */
export const createFileLinkSchema = z
  .object({
    FILECODE: z.string().trim().min(1).max(50).optional(),
    TARGET: jsonObject.optional(),
    EXPIRESIN: z.union([z.number(), z.string().trim().max(20)]).optional(),
    PERMANENT: bool(false),
    WITHNAME: bool(true),
    NAME: linkName.optional(),
  })
  .refine((d) => !(d.PERMANENT && d.EXPIRESIN !== undefined && d.EXPIRESIN !== ""), {
    message: "PERMANENT et EXPIRESIN sont incompatibles.",
    path: ["PERMANENT"],
  });

export const listFileLinksSchema = z.object({
  FILECODE: z.string().trim().max(50).optional(),
  ENTITYTYPE: z.string().trim().max(100).optional(),
  ENTITYID: z.string().trim().max(100).optional(),
  ACTIVE: bool(false),
});

export const lnkidParamSchema = z.object({ lnkid: z.coerce.number().int().positive() });

/**
 * PUT /api/files/links/:lnkid — nouvelle validité à partir de maintenant
 * (`EXPIRESIN` ou `PERMANENT`) et/ou nouveau nom (`NAME`, vide : retiré).
 */
export const updateFileLinkSchema = z
  .object({
    EXPIRESIN: z.union([z.number(), z.string().trim().max(20)]).optional(),
    PERMANENT: bool(false),
    NAME: linkName.optional(),
  })
  .refine((d) => !(d.PERMANENT && d.EXPIRESIN !== undefined && d.EXPIRESIN !== ""), {
    message: "Indiquez soit EXPIRESIN, soit PERMANENT.",
    path: ["EXPIRESIN"],
  })
  .refine((d) => d.PERMANENT || (d.EXPIRESIN !== undefined && d.EXPIRESIN !== "") || d.NAME !== undefined, {
    message: "Indiquez une nouvelle validité (EXPIRESIN ou PERMANENT) ou un nom (NAME).",
    path: ["EXPIRESIN"],
  });

/** Types de mouvement d'un lien (cf. FILELINKEVENTS.EVENT). */
export const FILE_LINK_EVENT_TYPES = ["CREATED", "UPDATED", "REVOKED", "OPENED", "DOWNLOADED", "REFUSED"];

/** Filtres communs aux mouvements (lien, fichier, cible). */
const fileLinkEventTargetSchema = z.object({
  LNKID: z.coerce.number().int().positive().optional(),
  FILECODE: z.string().trim().max(50).optional(),
  ENTITYTYPE: z.string().trim().max(100).optional(),
  ENTITYID: z.string().trim().max(100).optional(),
});

/**
 * GET /api/files/links/events — filtres (lien, fichier, cible, types
 * `EVENT=OPENED,DOWNLOADED`, recherche `SEARCH`, depuis `SINCE`) et
 * pagination (`LIMIT` / `OFFSET` ; sans `LIMIT` : 1000 premiers).
 */
export const listFileLinkEventsSchema = fileLinkEventTargetSchema.extend({
  EVENT: z.preprocess(
    (value) => {
      if (value === undefined || value === null || value === "") return undefined;
      const list = Array.isArray(value) ? value : String(value).split(",");
      const events = list.map((v) => String(v).trim().toUpperCase()).filter(Boolean);
      return events.length ? [...new Set(events)] : undefined;
    },
    z.array(z.enum(FILE_LINK_EVENT_TYPES)).optional(),
  ),
  SEARCH: z.string().trim().max(100).optional().transform((v) => v || undefined),
  SINCE: z.coerce.date().optional(),
  LIMIT: z.coerce.number().int().min(1).max(200).optional(),
  OFFSET: z.coerce.number().int().min(0).default(0),
});

/** GET /api/files/links/events/summary — nombre de mouvements par type et `PERTYPE` derniers. */
export const summarizeFileLinkEventsSchema = fileLinkEventTargetSchema.extend({
  PERTYPE: z.coerce.number().int().min(0).max(50).default(5),
});

export const fileLinkTokenParamSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
});

/**
 * Vérifie si une permission (payload.permission — PRMNAM, cf. JWT) fait
 * partie des profils "gestionnaires" globaux (MODIFY_PERMS, cf. .env) —
 * même convention que modules/faq/utils.js#isManagerPermission (dupliquée
 * ici plutôt que partagée : chaque module applique sa propre notion de
 * "gestionnaire" sur son propre domaine). Utilisé par
 * controllers.revokeFileSignature : un gestionnaire peut révoquer
 * n'importe quelle signature, pas seulement les siennes.
 */
export function isManagerPermission(permission) {
  const managers = (process.env.MODIFY_PERMS || "")
    .split(",")
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);

  return managers.includes(String(permission || "").toUpperCase());
}

export function formatFiles(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const filesMap = new Map();

  for (const row of rows) {
    if (!filesMap.has(row.ID)) {
      filesMap.set(row.ID, {
        ID: row.ID,
        FILECODE: row.FILECODE,
        APPCODE: row.APPCODE,
        ENTITYTYPE: row.ENTITYTYPE,
        ENTITYID: row.ENTITYID,
        ORIGINALNAME: row.ORIGINALNAME,
        STOREDNAME: row.STOREDNAME,
        RELATIVEPATH: row.RELATIVEPATH,
        CHECKSUMSHA256: row.CHECKSUMSHA256,
        MIMETYPE: row.MIMETYPE,
        EXTENSION: row.EXTENSION,
        COMPRESSED: !!row.COMPRESSED,
        ORIGINALSIZEBYTES: Number(row.ORIGINALSIZEBYTES),
        SIZEBYTES: Number(row.SIZEBYTES),
        STATUS: row.STATUS,
        UPLOADEDBY: row.UPLOADEDBY,
        CREATEDAT: row.CREATEDAT,
        DELETEDAT: row.DELETEDAT,
      });
    }
  }

  return Array.from(filesMap.values());
}
