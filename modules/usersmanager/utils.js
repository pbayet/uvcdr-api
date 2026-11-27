import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as functionsUtils from "../../core/utils/functions.utils.js";

const domain = process.env.DOMAIN || "";

// Dossier physique servi en ${DOMAIN}/API/assets (par défaut : <api>/assets)
const ASSETS_DIR = process.env.ASSETS_DIR
  ? path.resolve(process.env.ASSETS_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets");
// Extensions reconnues. Si plusieurs fichiers portent le même APPCOD, le plus
// récemment modifié l'emporte ; cet ordre ne départage qu'à date égale.
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".svg", ".gif", ".avif", ".bmp", ".ico"];
const ASSETS_CACHE_TTL_MS = 60_000;
let assetsCache = { map: new Map(), expiresAt: 0 };

/**
 * `true` si `candidate` doit remplacer `current` pour un même APPCOD : fichier
 * le plus récent d'abord, puis ordre de IMAGE_EXTENSIONS à date égale.
 */
export function isPreferredAsset(candidate, current) {
  if (!current) return true;
  if (candidate.mtimeMs !== current.mtimeMs) {
    return candidate.mtimeMs > current.mtimeMs;
  }
  return candidate.rank < current.rank;
}

/**
 * Construit (avec cache court) un index APPCOD (minuscule) -> nom de fichier image
 * à partir du dossier assets, quelle que soit l'extension (le plus récent en
 * cas de doublon, ex : ancien FSA.jpg et nouveau FSA.png).
 */
function getAssetsIndex() {
  const now = Date.now();
  if (now < assetsCache.expiresAt) return assetsCache.map;

  const map = new Map();
  try {
    const files = fs.readdirSync(ASSETS_DIR);
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      const rank = IMAGE_EXTENSIONS.indexOf(ext);
      if (rank === -1) continue;
      const key = path.basename(file, path.extname(file)).toLowerCase();
      let mtimeMs = 0;
      try {
        const stat = fs.statSync(path.join(ASSETS_DIR, file));
        if (!stat.isFile()) continue;
        mtimeMs = stat.mtimeMs;
      } catch {
        // Fichier illisible : date inconnue, départagé par l'extension.
      }
      const candidate = { file, rank, mtimeMs };
      if (isPreferredAsset(candidate, map.get(key))) map.set(key, candidate);
    }
  } catch {
    // Dossier absent/inaccessible : on retombe sur le .jpg par défaut
  }
  assetsCache = { map, expiresAt: now + ASSETS_CACHE_TTL_MS };
  return map;
}

/**
 * Renvoie l'URL de l'image d'une application : IMGLNK si défini, sinon le
 * premier fichier de /assets dont le nom est l'APPCOD (toute extension image),
 * sinon `${APPCOD}.jpg` par défaut.
 */
export function getAppImageLink(appcod, imglnk) {
  if (!appcod || !domain) return "";
  if (imglnk) return imglnk;
  return getAppDefaultImageLink(appcod);
}

/**
 * Lien de l'image par défaut d'une application (indépendant de IMGLNK) : le
 * premier fichier de /assets dont le nom est l'APPCOD, avec son extension
 * réelle (toute extension image), sinon `${APPCOD}.jpg`.
 */
export function getAppDefaultImageLink(appcod) {
  if (!appcod || !domain) return "";
  const found = getAssetsIndex().get(String(appcod).toLowerCase());
  const fileName = found ? found.file : `${appcod}.jpg`;
  return `${domain}/API/assets/${encodeURIComponent(fileName)}`;
}

/**
 * sp_GetUsers_JSON renvoie SERVICE/PERMISSIONS/GROUPS/SUBORDINATES/MAILCOPIES/USRIMG
 * sous forme de chaînes JSON — cette fonction les parse et les normalise.
 */
export async function formatUsers(rows) {
  if (!Array.isArray(rows)) return [];

  return rows.map((row) => {
    const SERVICE = (() => {
      const parsed = functionsUtils.parseToJSON(row.SERVICE);
      if (!parsed) return null;
      return {
        ...parsed,
        POSITIONS: functionsUtils.parseToJSON(parsed.POSITIONS) ?? [],
      };
    })();

    const PERMISSIONS = (() => {
      const parsed = functionsUtils.parseToJSON(row.PERMISSIONS);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((perm) => {
        const permParsed = functionsUtils.parseToJSON(perm.PERMISSION);

        return {
          ...perm,
          APPLNK: perm.APPLNK ? perm.APPLNK.replace("[DOMAIN]", domain) : "",
          IMGLNK: getAppImageLink(perm.APPCOD, perm.IMGLNK),
          PERMISSION: permParsed,
        };
      });
    })();

    return {
      ...row,
      USRIMG: functionsUtils.parseToJSON(row.USRIMG),
      SERVICE,
      SUBORDINATES: functionsUtils.parseToJSON(row.SUBORDINATES) ?? [],
      PERMISSIONS,
      GROUPS: functionsUtils.parseToJSON(row.GROUPS) ?? [],
      MAILCOPIES: functionsUtils.parseToJSON(row.MAILCOPIES) ?? [],
    };
  });
}

export function formatApplications(rows = []) {
  return rows.length > 0
    ? rows.map((application) => ({
        ...application,
        IMGLNK: getAppImageLink(application.APPCOD, application.IMGLNK),
        // Lien par défaut réel (extension existante dans /assets) : permet au
        // front de reconnaître un IMGLNK "auto" et de l'afficher en placeholder.
        DEFIMGLNK: getAppDefaultImageLink(application.APPCOD),
      }))
    : [];
}

/**
 * Regroupe les lignes de V_App_Last_Version_Details (jointes aux
 * changements/APPCHANGES) en une entrée par version d'application.
 * `groupBy` : "APPCOD" (une entrée par application, défaut) ou "VID" (une
 * entrée par version, pour l'historique complet d'une application).
 */
export function formatAppVersions(rows, groupBy = "APPCOD") {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const appMap = new Map();

  for (const row of rows) {
    let app = appMap.get(row[groupBy]);

    if (!app) {
      app = {
        VID: row.VID,
        APPCOD: row.APPCOD,
        VNUM: row.VNUM,
        RELEASEDTE: row.RELEASEDTE,
        SUMMARY: row.SUMMARY || "",
        CREATED_BY: {
          USRID: row.CREUSR_ID,
          LSTNAM: row.CREUSR_LNAME,
          FSTNAM: row.CREUSR_FNAME,
          EMAIL: row.CREUSR_EMAIL,
        },
        ISVIEW: row.ISVIEW ?? null,
        CHANGES: [],
        _changeSet: new Set(),
      };
      appMap.set(row[groupBy], app);
    }

    if (row.CID && !app._changeSet.has(row.CID)) {
      app._changeSet.add(row.CID);
      app.CHANGES.push({
        CID: row.CID,
        CTYPE: row.CTYPE,
        CTITLE: row.CTITLE,
        CDESC: row.CDESC,
      });
    }
  }

  for (const app of appMap.values()) {
    delete app._changeSet;
  }

  return Array.from(appMap.values());
}

/* ─────────────────────────────────────────────
   MODES OPÉRATOIRES PAR VERSION (APPVERSIONDOCS)
───────────────────────────────────────────── */

/** Code de users-manager : ses tokens voient tous les modes opératoires. */
export const MANAGER_APPCOD = "USRMAN";

/**
 * Lecteur des modes opératoires, déduit du token :
 * - token users-manager (gestion) : tout ;
 * - token de l'application APPCOD : statut du token (permissionLevel, y
 *   compris un niveau simulé) ;
 * - autre token : statut inconnu, modes opératoires sans restriction seuls.
 */
export function getDocumentViewer(payload, APPCOD) {
  if (payload?.application === MANAGER_APPCOD) return { all: true };
  if (APPCOD && payload?.application === APPCOD) {
    const level = Number(payload?.permissionLevel);
    return { level: Number.isFinite(level) && level !== -1 ? level : null };
  }
  return { level: null };
}

/** Vrai si `viewer` peut voir `doc` (aucun statut = visible par tous). */
export function isDocumentVisible(doc, viewer) {
  if (viewer?.all) return true;
  if (!doc.PERMISSIONS?.length) return true;
  return (
    viewer?.level != null &&
    doc.PERMISSIONS.some((p) => Number(p.PRMLVL) === Number(viewer.level))
  );
}

/**
 * Regroupe les lignes de services.getAppVersionDocuments (une par statut)
 * en Map VID -> { VID, APPCOD, VNUM, DOCUMENTS }, dans l'ordre des lignes
 * (version la plus récente d'abord).
 */
export function groupVersionDocuments(rows = []) {
  const versions = new Map();
  const docs = new Map();

  for (const row of rows) {
    let version = versions.get(row.VID);
    if (!version) {
      version = {
        VID: row.VID,
        APPCOD: row.APPCOD,
        VNUM: row.VNUM,
        DOCUMENTS: [],
      };
      versions.set(row.VID, version);
    }

    let doc = docs.get(row.DID);
    if (!doc) {
      doc = {
        DID: row.DID,
        DOCNAM: row.DOCNAM,
        DOCLNK: row.DOCLNK,
        ORDNUM: row.ORDNUM,
        PERMISSIONS: [],
      };
      docs.set(row.DID, doc);
      version.DOCUMENTS.push(doc);
    }

    if (row.PRMID != null) {
      doc.PERMISSIONS.push({
        PRMID: row.PRMID,
        PRMNAM: row.PRMNAM,
        PRMLVL: row.PRMLVL,
      });
    }
  }

  return versions;
}

/** Ancien lien de documentation de l'application, au format mode opératoire. */
function legacyDocuments(appDocLink) {
  return appDocLink
    ? [
        {
          DID: null,
          DOCNAM: "Mode opératoire",
          DOCLNK: appDocLink,
          ORDNUM: 0,
          PERMISSIONS: [],
        },
      ]
    : [];
}

/**
 * Ajoute à chaque version (historique formatAppVersions, plus récente
 * d'abord) :
 * - DOCUMENTS : ses propres modes opératoires visibles par `viewer` ;
 * - EFFECTIVE_DOCUMENTS : ceux à afficher — les siens, sinon ceux de la
 *   version antérieure la plus proche qui en a (visibles par `viewer`),
 *   sinon l'ancien lien de l'application (`appDocLink`) ;
 * - EFFECTIVE_DOCS_VNUM : version d'où viennent EFFECTIVE_DOCUMENTS (null
 *   = ancien lien de l'application, ou aucun).
 */
export function attachVersionDocuments(
  versions,
  documentsByVID,
  appDocLink,
  viewer,
) {
  const legacy = legacyDocuments(appDocLink);
  let current = null;

  // Parcours de la plus ancienne à la plus récente.
  for (let i = versions.length - 1; i >= 0; i--) {
    const version = versions[i];
    const own = (documentsByVID.get(version.VID)?.DOCUMENTS ?? []).filter(
      (doc) => isDocumentVisible(doc, viewer),
    );

    if (own.length > 0) current = { VNUM: version.VNUM, DOCUMENTS: own };

    version.DOCUMENTS = own;
    version.EFFECTIVE_DOCUMENTS = current?.DOCUMENTS ?? legacy;
    version.EFFECTIVE_DOCS_VNUM = current?.VNUM ?? null;
  }

  return versions;
}

/**
 * Modes opératoires à afficher pour la dernière version d'une application
 * (portail) : ceux de la version la plus récente qui en a de visibles par
 * `viewer`, sinon l'ancien lien de l'application.
 */
export function resolveLatestDocuments(appVersionDocs, appDocLink, viewer) {
  for (const version of appVersionDocs) {
    const visible = version.DOCUMENTS.filter((doc) =>
      isDocumentVisible(doc, viewer),
    );
    if (visible.length > 0) {
      return { VNUM: version.VNUM, DOCUMENTS: visible };
    }
  }
  return { VNUM: null, DOCUMENTS: legacyDocuments(appDocLink) };
}

/**
 * Transforme le résultat SQL V_GroupsPermission en structure
 * Group -> Applications -> Permission.
 */
export function formatGroupsPermissions(rows = []) {
  const groupsMap = new Map();

  for (const row of rows) {
    const groupId = row.GRPID;
    const appId = row.APPID;

    if (!groupsMap.has(groupId)) {
      groupsMap.set(groupId, {
        GRPID: row.GRPID,
        GRPNAM: row.GRPNAM,
        GRPDES: row.GRPDES,
        ACTIVE: Boolean(row.GRPACTV),
        GRPBAS: Boolean(row.GRPBAS),
        PERMISSIONS: [],
      });
    }

    const group = groupsMap.get(groupId);

    let application = group.PERMISSIONS.find((app) => app.APPID === appId);

    if (!application) {
      application = {
        APPID: row.APPID,
        APPCOD: row.APPCOD,
        APPNAM: row.APPNAM,
        APPDES: row.APPDES,
        LOGLNK: row.LOGLNK,
        APPLNK: row.APPLNK?.replace("[DOMAIN]", domain) || "[DOMAIN]/",
        DOCLNK: row.DOCLNK,
        IMGLNK: getAppImageLink(row.APPCOD, row.IMGLNK),
        ACTIVE: Boolean(row.APPACTV),
        PERMISSION: null,
      };

      group.PERMISSIONS.push(application);
    }

    if (row.PRMID) {
      application.PERMISSION = {
        PRMID: row.PRMID,
        PRMNAM: row.PRMNAM,
        PRMDES: row.PRMDES,
        PRMLVL: row.PRMLVL,
        BYGRP: true,
        ISCRIT: Boolean(row.ISCRIT),
      };
    }
  }

  return Array.from(groupsMap.values());
}

/**
 * Transforme le résultat SQL V_PositionsServices en structure
 * Service -> Positions.
 */
export function formatServices(rows = []) {
  const servicesMap = new Map();

  for (const row of rows) {
    const servId = row.SRVID;
    const posId = row.POSID;

    if (!servicesMap.has(servId)) {
      servicesMap.set(servId, {
        SRVID: row.SRVID,
        SRVCOD: row.SRVCOD,
        SRVNAM: row.SRVNAM,
        SRVDES: row.SRVDES,
        POSITIONS: [],
      });
    }

    const service = servicesMap.get(servId);

    let position = service.POSITIONS.find((pos) => pos.POSID === posId);

    if (!position) {
      position = {
        POSID: row.POSID,
        POSNAM: row.POSNAM,
        POSCOD: row.POSCOD,
        POSLVL: row.POSLVL,
        POSDES: row.POSDES,
      };

      service.POSITIONS.push(position);
    }
  }

  return Array.from(servicesMap.values());
}
