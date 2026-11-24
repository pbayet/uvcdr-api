import * as services from "./services.js";
import * as utils from "./utils.js";
import * as v from "./validators.js";
import { logger } from "../../config/logger.config.js";

/* ─────────────────────────────────────────────
   PROCS — Fournisseur des liens directs (module files, cf.
   modules/files/links.js)

   Cible : `TARGET = { PRCID, VERNUM?, KIND? }` — document d'origine
   (`original`) ou aperçu PDF (`preview`) ; sans VERNUM, la version EN
   VIGUEUR au moment de l'ouverture (le lien reste à jour après une nouvelle
   version).

   Droits :
     - rédacteurs : durée au choix, ou lien permanent ;
     - lecteurs : lien temporaire seulement, durée maximale
       PROCS_LINK_TTL_DAYS (défaut 7 jours, aussi la durée par défaut).
   Le lien n'ouvre que le document d'une procédure PUBLIÉE (catégorie
   active) : vérifié à la création puis à chaque ouverture, avec les droits
   d'un lecteur. Dépublier, archiver ou supprimer la procédure coupe donc
   tous ses liens. Chaque ouverture est tracée (PROCCONSULTS) au nom de
   l'auteur du lien.
───────────────────────────────────────────── */

export const ENTITY_TYPE = "PROCEDURE";

const DAY = 86400;

/** Durée par défaut (et maximale pour un lecteur) : PROCS_LINK_TTL_DAYS, défaut 7 jours. */
export function defaultTtl() {
  const days = Number(process.env.PROCS_LINK_TTL_DAYS);
  return Math.round((Number.isFinite(days) && days > 0 ? days : 7) * DAY);
}

/** Version visée : `VERNUM`, ou la version en vigueur. */
async function findVersion(proc, VERNUM) {
  if (!VERNUM) return proc.CURVERID ? services.getVersion(proc.CURVERID) : null;
  return (await services.getVersions(proc.PRCID)).find((ver) => ver.VERNUM === VERNUM) ?? null;
}

const fileCode = (version, KIND) => (KIND === "preview" ? version.PREVIEWCODE : version.FILECODE);

export async function authorize(req, input) {
  const ctx = utils.getUserContext(req);
  const { PRCID, VERNUM, KIND } = v.fileLinkTargetSchema.parse(input.TARGET ?? {});

  if (!(await services.getProcedure(ctx, PRCID))) throw new Error("DATA_NOT_FOUND");
  const proc = await services.getProcedure({ USRID: ctx.USRID, ISEDITOR: false }, PRCID);
  if (!proc) {
    throw utils.httpError(
      409,
      "Lien direct indisponible : la procédure doit être publiée (et sa catégorie active).",
    );
  }

  const version = await findVersion(proc, VERNUM);
  if (!version) throw new Error("DATA_NOT_FOUND");
  if (!fileCode(version, KIND)) throw utils.httpError(409, "Ce document n'a pas de fichier à partager.");

  return {
    ENTITYTYPE: ENTITY_TYPE,
    ENTITYID: String(PRCID),
    PARAMS: { VERNUM: VERNUM ?? null, KIND },
    FILENAME: utils.versionFileName(version, KIND),
    LABEL: [proc.REFCODE, proc.TITLE].filter(Boolean).join(" — ").slice(0, 300),
    POLICY: policy(req),
  };
}

export async function resolve(link) {
  if (link.ENTITYTYPE !== ENTITY_TYPE) return null;
  const PRCID = Number(link.ENTITYID);
  const { VERNUM = null, KIND = "original" } = link.PARAMS ?? {};

  const proc = await services.getProcedure({ USRID: link.CREATEDBY, ISEDITOR: false }, PRCID);
  if (!proc) return null;
  const version = await findVersion(proc, VERNUM);
  const code = version && fileCode(version, KIND);
  if (!code) return null;

  const FILENAME = utils.versionFileName(version, KIND);
  return {
    FILECODE: code,
    FILENAME,
    // Mouvements du lien : version effectivement servie (un lien sans
    // version sert la version en vigueur au moment de l'ouverture). Le nom
    // du fichier n'apporte rien : c'est toujours le document de la procédure.
    DETAIL: `v${version.VERNUM}${KIND === "preview" ? " · aperçu PDF" : ""}`,
    // Consultation attribuée au lecteur s'il est identifié (cookie de
    // session UNIS), à l'auteur du lien à défaut.
    onOpen: ({ disposition, opener } = {}) =>
      services
        .addConsult({
          PRCID,
          VERID: version.VERID,
          USRID: opener?.USRID ?? link.CREATEDBY,
          KIND: disposition === "attachment" ? "DOWNLOAD" : "VIEW",
        })
        .catch((err) => logger.warn(`[PROCS][CONSULT] lien #${link.LNKID} non tracé : ${err.message}`)),
  };
}

/** Validité qu'un utilisateur peut donner à un lien existant (mêmes règles qu'à la création). */
export function policy(req) {
  const ttl = defaultTtl();
  let editor = false;
  try {
    editor = utils.getUserContext(req).ISEDITOR;
  } catch {
    editor = false;
  }
  return editor
    ? { ALLOWPERMANENT: true, MAXTTL: null, DEFAULTTTL: ttl }
    : { ALLOWPERMANENT: false, MAXTTL: ttl, DEFAULTTTL: ttl };
}

/** Rédacteurs : voient, modifient et révoquent tous les liens de l'application. */
export function canManage(req) {
  try {
    return utils.getUserContext(req).ISEDITOR;
  } catch {
    return false;
  }
}
