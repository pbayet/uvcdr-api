import { utcToParisIso } from "../../core/utils/dates.utils.js";
import { formatFiles } from "../files/utils.js";

/* ═══════════════════════════════════════════════════════════════
   FSA — Formatage

   REFONTE BDD (FSA_BIS) : le JSON final renvoyé au front (FSAENT/
   FSACLIENT/FSAPRODUITS/FSAVENTES/FSAPJS/FSAVALIDS, forme "liste" via
   formatFsasJsonList) est rigoureusement identique à avant — c'était la
   contrainte du chantier, pour ne rien casser côté front. Ce qui change,
   c'est la FORME DES DONNÉES BRUTES en entrée :
     - formatFsasJson consommait avant les colonnes JSON Nomenclatures/Pjs/
       Validations renvoyées ligne par ligne par usp_GetFolders_JSON ; elle
       consomme maintenant directement le résultat à 4 recordsets de
       services.getFsa() (header + 3 listes filles), sans JSON imbriqué.
     - formatFsasJsonList n'a PAS changé : la nouvelle requête liste
       (services.buildFolderListQuery) a été écrite pour renvoyer exactement
       les mêmes alias de colonnes (ENT_*, CLI_*) qu'avant.
     - formatGestionnaires n'a PAS changé de sortie, mais son entrée est
       maintenant une ligne par (service, utilisateur habilité) — cf.
       commentaire sur la fonction, plus bas — au lieu d'une ligne par
       service portant FSAGES.ENBUSRS en texte (colonne supprimée).
═══════════════════════════════════════════════════════════════ */

const toBool = (value) =>
  value === true || value === 1 || value === "1" || value === "true";

function uniqBy(items, keySelector) {
  const map = new Map();

  for (const item of items) {
    const key = keySelector(item);
    if (key !== undefined && key !== null) {
      map.set(key, item);
    }
  }

  return Array.from(map.values());
}

function mapGest(prefix, row) {
  return {
    USRID: row[`${prefix}_USRID`],
    GESID: row[`${prefix}_GESID`],
    NUMGES: row[`${prefix}_NUMGES`] ?? row[`${prefix}_NUMDEM`],
    NOMGES: row[`${prefix}_NOMGES`],
    VALGES: toBool(row[`${prefix}_VALGES`]),
    CREGES: toBool(row[`${prefix}_CREGES`]),
    SERVGES: row[`${prefix}_SERVGES`],
    GESNAM: row[`${prefix}_GESNAM`],
    CREUSR: row[`${prefix}_CREUSR`],
    CREDAT: utcToParisIso(row[`${prefix}_CREDAT`]),
    MODUSR: row[`${prefix}_MODUSR`],
    MODDAT: utcToParisIso(row[`${prefix}_MODDAT`]),
  };
}

function mapFolder(row, mustValidateMap) {
  return {
    FSAENT: {
      ENTID: row.ENT_ENTID,
      APPVRS: row.ENT_APPVRS,
      NUMDOS: row.ENT_NUMDOS,
      NUMDOSBAS: row.ENT_NUMDOSBAS,
      NOMDOS: row.ENT_NOMDOS,
      TYPE: {
        TYPID: row.ENT_TYPDOSID,
        TYPDOS: row.ENT_TYPDOS,
        TYDOSN: row.ENT_TYPDOSN,
      },
      GESUSRID: row.ENT_GESUSRID,
      GEST: mapGest("ENT_GES", row),
      DEMA: mapGest("ENT_DEM", row),
      SRVMSTVAL: mustValidateMap.get(row.ENT_NUMDOS) || [],
      CURETADOS: {
        STAID: row.ENT_STAID,
        CODETA: row.ENT_CODETA,
        DESETA: row.ENT_DESETA,
      },
      NOTDOS: row.ENT_NOTDOS,
      CREUSR: row.ENT_CREUSR,
      CREDAT: utcToParisIso(row.ENT_CREDAT),
      EAVDAT: utcToParisIso(row.ENT_EAVDAT),
      MODUSR: row.ENT_MODUSR,
      MODDAT: utcToParisIso(row.ENT_MODDAT),
      DELETED: toBool(row.ENT_DELETED),
      INNO: toBool(row.ENT_INNO),
    },

    FSACLIENT: {
      CLIENTID: row.CLI_CLIENTID,
      NUMDOS: row.CLI_NUMDOS,
      CLIEXI: toBool(row.CLI_CLIEXI),
      BPCNUM: row.CLI_BPCNUM,
      BPCNAM: row.CLI_BPCNAM,
      CLIPAY: {
        PAYSID: row.CLI_PAY_PAYSID,
        NUMDOS: row.CLI_PAY_NUMDOS,
        CLIPAY: row.CLI_PAY_CLIPAY,
        CLIPAYN: row.CLI_PAY_CLIPAYN,
      },
      CLIACT: row.CLI_CLIACT,
      NOMACT: row.CLI_NOMACT,
      CLICCON: row.CLI_CLICCON,
      CLINAM: row.CLI_CLINAM,
      CLIMAIL: row.CLI_CLIMAIL,
      CLITEL: row.CLI_CLITEL,
      CLINOT: row.CLI_CLINOT,
    },

    FSAPRODUITS: {
      PRODUITID: row.NOMS_PRODUITID,
      NUMDOS: row.NOMS_NUMDOS,
      TCLCOD: row.NOMS_TCLCOD,
      CATNOM: row.NOMS_CATNOM,
      ITMREF: row.NOMS_ITMREF,
      ITMDES: row.NOMS_ITMDES,
      ITMFMT: row.NOMS_ITMFMT,
      DESFMT: row.NOMS_DESFMT,
      CENTFMT: row.NOMS_CENTFMT,
      ITMMAR: row.NOMS_ITMMAR,
      DESMAR: row.NOMS_DESMAR,
      ITMGAM: row.NOMS_ITMGAM,
      DESGAM: row.NOMS_DESGAM,
      ITMAPP: row.NOMS_ITMAPP,
      DESAPP: row.NOMS_DESAPP,
      ITMCEP: row.NOMS_ITMCEP,
      DESCEP: row.NOMS_DESCEP,
      ITMCOU: row.NOMS_ITMCOU,
      DESCOU: row.NOMS_DESCOU,
      ITMQUA: row.NOMS_ITMQUA,
      DESQUA: row.NOMS_DESQUA,
      ITMTYP: row.NOMS_ITMTYP,
      DESTYP: row.NOMS_DESTYP,
      ITMSPT: row.NOMS_ITMSPT,
      DESSPT: row.NOMS_DESSPT,
      ITMMIL: row.NOMS_ITMMIL,
      CODCHADOM: row.NOMS_CODCHADOM,
      CHADOM: row.NOMS_CHADOM,
      CODDESALC: toBool(row.NOMS_CODDESALC),
      CODBOIS: toBool(row.NOMS_CODBOIS),
      MEDAIL: row.NOMS_MEDAIL,
      ITMCON: row.NOMS_ITMCON,
      ITMNOT: row.NOMS_ITMNOT,
      NOMENCLATURES: [],
    },

    FSAVENTES: {
      VENTEID: row.VEN_VENTEID,
      NUMDOS: row.ENT_NUMDOS,
      DATMAD: utcToParisIso(row.VEN_DATMAD),
      ONESHO: toBool(row.VEN_ONESHO),
      VOLANN: row.VEN_VOLANN,
      VOLANN1: row.VEN_VOLANN1,
      VOLANN2: row.VEN_VOLANN2,
      VOLTIR: row.VEN_VOLTIR,
      PRIANN: row.VEN_PRIANN,
      PRIANN1: row.VEN_PRIANN1,
      PRIANN2: row.VEN_PRIANN2,
      PVC: row.VEN_PVC,
      VENNOT: row.VEN_VENNOT,
      FRANCO: toBool(row.VEN_FRANCO),
      FDC: toBool(row.VEN_FDC),
      AFA: toBool(row.VEN_AFA),
      AFANOT: row.VEN_AFANOT,
    },

    FSAPJS: [],
    FSAVALIDS: [],
  };
}

function mapNomenclatureRow(headerRow) {
  return (row) => ({
    NOMENCLATUREID: row.NOMS_NOM_NOMENCLATUREID,
    NUMDOS: row.NOMS_NOM_NUMDOS,
    LINDOS: row.NOMS_NOM_LINDOS,
    CLEDOS: row.NOMS_NOM_CLEDOS,
    ITMCAT: row.NOMS_NOM_ITMCAT,
    DESCAT: row.NOMS_NOM_DESCAT,
    ITMREF: row.NOMS_NOM_ITMREF,
    ITMDES: row.NOMS_NOM_ITMDES,
    BASQTY: row.NOMS_NOM_BASQTY,
    CPNITMREF: row.NOMS_NOM_CPNITMREF,
    CPNITMDES: row.NOMS_NOM_CPNITMDES,
    BOMUOM: row.NOMS_NOM_BOMUOM,
    BOMSTUCOE: row.NOMS_NOM_BOMSTUCOE,
    BOMQTY: row.NOMS_NOM_BOMQTY,
    LIKQTY: row.NOMS_NOM_LIKQTY,
    STU: row.NOMS_NOM_STU,
    ITMMIL: row.NOMS_NOM_ITMMIL,
    ITMMILN: row.NOMS_NOM_ITMMILN,
    NOTLINC: row.NOMS_NOM_NOTLINC,
    NOTDOS: row.NOMS_NOM_NOTDOS,
    CODCAT: headerRow.NOMS_TCLCOD,
    LLCAT: headerRow.NOMS_CATNOM,
    // CODFMT/LLFMT/COEFFMT : déjà toujours undefined dans le flux
    // getFsa/usp_GetFolders_JSON d'origine (ces 3 champs ne sont peuplés que
    // par le chemin PFICOD → dwhbiUtils.formatNomenclature, pas ici) —
    // comportement inchangé, pas une régression introduite par la refonte.
    CODFMT: undefined,
    LLFMT: undefined,
    COEFFMT: undefined,
  });
}

function mapValidationRow(row) {
  return {
    VALIDID: row.VAL_VALIDID,
    NUMDOS: row.VAL_NUMDOS,
    GEST: {
      // VAL_GES_USRID : FSAVALID ne stocke aucun USRID (seulement NUMGES),
      // cf. sql/02_views.sql — jamais peuplé, comme avant.
      USRID: row.VAL_GES_USRID,
      GESID: row.VAL_GES_GESID,
      NUMGES: row.VAL_GES_NUMGES,
      NOMGES: row.VAL_GES_NOMGES,
      VALGES: toBool(row.VAL_GES_VALGES),
      CREGES: toBool(row.VAL_GES_CREGES),
      SERVGES: row.VAL_GES_SERVGES,
      ENBUSRS: [],
      GESNAM: row.VAL_GES_GESNAM,
      CREUSR: row.VAL_GES_CREUSR,
      CREDAT: utcToParisIso(row.VAL_GES_CREDAT),
      MODUSR: row.VAL_GES_MODUSR,
      MODDAT: utcToParisIso(row.VAL_GES_MODDAT),
    },
    VALTYP: {
      VALTYPID: row.VAL_TYP_VALTYPID,
      VALTYPCOD: row.VAL_TYP_VALTYPCOD,
      VALTYPNOM: row.VAL_TYP_VALTYPNOM,
    },
    VALNOT: row.VAL_VALNOT,
    CREDAT: utcToParisIso(row.VAL_CREDAT),
    CREUSR: row.VAL_CREUSR,
    // PJS toujours vide : FSAPJ n'a pas de colonne pour rattacher une pièce
    // jointe à une validation précise (cf. sql/02_views.sql).
    PJS: [],
  };
}

/**
 * Construit la structure hiérarchique d'un dossier à partir du résultat de
 * services.getFsa() : { header: [1 ligne], nomenclatures: [...], pjs: [...],
 * validations: [...] } — 4 requêtes simples plutôt que les colonnes JSON
 * imbriquées de l'ancien usp_GetFolders_JSON (cf. services.js). Renvoie un
 * tableau (0 ou 1 élément) pour ne rien changer à la forme attendue par
 * modules/fsa/controllers.js (qui fait toujours `formattedFsas[0]`).
 */
export function formatFsasJson(fsaData, gestsMustValidate = []) {
  const headerRow = fsaData?.header?.[0];
  if (!headerRow?.ENT_NUMDOS) return [];

  const mustValidateMap = new Map(
    Array.isArray(gestsMustValidate)
      ? gestsMustValidate.map((item) => [item.NUMDOS, item.SERVICES || []])
      : [],
  );

  const folder = mapFolder(headerRow, mustValidateMap);

  folder.FSAPRODUITS.NOMENCLATURES = uniqBy(
    (fsaData.nomenclatures || []).map(mapNomenclatureRow(headerRow)),
    (item) => item.NOMENCLATUREID,
  );

  folder.FSAPJS = formatFiles(fsaData.pjs || []);

  const validationsPjs = formatFiles(fsaData.validationsPjs || []);

  folder.FSAVALIDS = uniqBy(
    (fsaData.validations || []).map(mapValidationRow),
    (item) => item.VALIDID,
  );

  if (validationsPjs.length > 0) {
    folder.FSAVALIDS.map((v) => {
      const pjs = validationsPjs.filter(
        (p) => p.ENTITYID === `${v.NUMDOS}/${v.GEST.NUMGES}`,
      );
      v.PJS = pjs;
    });
  }

  return [folder];
}

/* ═══════════════════════════════════════════════════════════════
   À ajouter dans le même fichier que formatFsasJson (réutilise les
   helpers déjà définis là-bas : toBool, utcToParisIso).
   ═══════════════════════════════════════════════════════════════ */

function mapFolderListItem(row, mustValidateMap) {
  return {
    NUMDOS: row.ENT_NUMDOS,
    NOMDOS: row.ENT_NOMDOS,
    NOTDOS: row.ENT_NOTDOS,
    CODETA: row.ENT_CODETA,
    DESETA: row.ENT_DESETA,
    DELETED: toBool(row.ENT_DELETED),
    CREDAT: utcToParisIso(row.ENT_CREDAT),
    // FsaFolder.folderDate = EAVDAT || CREDAT ; formatCREDAT/openedTime
    // en dépendent (cf. FsaFolder), pas de CREDAT brut.
    EAVDAT: row.ENT_EAVDAT ? utcToParisIso(row.ENT_EAVDAT) : null,

    GES_GESNAM: row.ENT_GES_GESNAM,
    GES_NOMGES: row.ENT_GES_NOMGES,

    DEM_NUMGES: row.ENT_DEM_NUMDEM,
    DEM_GESNAM: row.ENT_DEM_GESNAM,
    DEM_NOMGES: row.ENT_DEM_NOMGES,

    BPCNUM: row.CLI_BPCNUM,
    BPCNAM: row.CLI_BPCNAM,
    CLINAM: row.CLI_CLINAM,
    CLIACT: row.CLI_CLIACT,
    NOMACT: row.CLI_NOMACT,
    MY_VALIDATION_CODE: row.ENT_MY_VALIDATION_CODE,

    PJ_COUNT: row.ENT_PJ_COUNT ?? 0,

    // CSV -> tableau, comme les autres listes sont déjà parsées côté
    // back (mapPjs/mapValidations) avant d'être envoyées au front.
    VALIDATED_SERVICES: (row.ENT_VALIDATED_SERVICES || "")
      .split(",")
      .filter(Boolean),

    // Nécessaire pour reconstruire le vrai statut quand CODETA = 'ARC'
    // (cf. setRelEtaDos côté front) : Refusé si une validation REF existe
    // pour ce dossier, Validé sinon.
    IS_REF: toBool(row.ENT_IS_REF),

    SRVMSTVAL: mustValidateMap.get(row.ENT_NUMDOS) || [],
  };
}

/**
 * Équivalent allégé de formatFsasJson, pour les lignes renvoyées par
 * usp_GetFoldersList_JSON (vue liste des dossiers / FolderCard).
 *
 * Même principe de dédoublonnage par NUMDOS que formatFsasJson (le JOIN
 * sur #Clients peut en théorie dupliquer une ligne par dossier, ex:
 * plusieurs clients rattachés) : on garde la première occurrence.
 *
 * Contrairement à formatFsasJson, il n'y a ici aucun sous-tableau à
 * fusionner (Nomenclatures/Pjs/Validations) — usp_GetFoldersList_JSON
 * ne renvoie que des champs scalaires par dossier (PJ_COUNT,
 * VALIDATED_SERVICES), donc pas de merge nécessaire au-delà du dédoublonnage.
 */
export function formatFsasJsonList(rows = [], gestsMustValidate = []) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const mustValidateMap = new Map(
    Array.isArray(gestsMustValidate)
      ? gestsMustValidate.map((item) => [item.NUMDOS, item.SERVICES || []])
      : [],
  );

  const foldersMap = new Map();

  for (const row of rows) {
    const numdos = row?.ENT_NUMDOS;
    if (!numdos) continue;

    if (foldersMap.has(numdos)) continue;

    foldersMap.set(numdos, mapFolderListItem(row, mustValidateMap));
  }

  return Array.from(foldersMap.values());
}

/**
 * REFONTE BDD : FSAGES.ENBUSRS (chaîne "1;2;3") a disparu, remplacé par la
 * table de jointure FSAGES_UTILISATEURS(GESID, USRID) — cf.
 * services.gestionnairesQuery(), qui renvoie désormais une ligne par
 * (service, utilisateur habilité) au lieu d'une ligne par service portant
 * la liste complète en texte.
 *
 * Le JSON renvoyé au front reste rigoureusement identique à avant : un
 * objet par USRID, avec ENBUSRS recalculé ici comme le tableau de tous les
 * USRID habilités sur le même GESID (regroupement fait en JS plutôt que par
 * un split(';') côté ancien code — même résultat).
 */
export function formatGestionnaires(rows = []) {
  const usrIdsByGesId = new Map();

  for (const row of rows) {
    if (row.USRID == null) continue;
    if (!usrIdsByGesId.has(row.GESID)) usrIdsByGesId.set(row.GESID, []);
    usrIdsByGesId.get(row.GESID).push(Number(row.USRID));
  }

  const gestsMap = new Map();

  for (const row of rows) {
    if (row.USRID == null) continue;

    if (!gestsMap.has(row.USRID)) {
      gestsMap.set(row.USRID, {
        USRID: row.USRID,
        GESID: row.GESID,
        NUMGES: row.NUMGES,
        NOMGES: row.NOMGES,
        VALGES: row.VALGES,
        CREGES: row.CREGES,
        SERVGES: row.SERVGES,
        ENBUSRS: usrIdsByGesId.get(row.GESID) || [],
        GESNAM: row.GESNAM,
        CREUSR: row.CREUSR,
        CREDAT: utcToParisIso(row.CREDAT),
        MODUSR: row.MODUSR,
        MODDAT: utcToParisIso(row.MODDAT),
      });
    }
  }

  return Array.from(gestsMap.values());
}

/**
 * Correctif (cf. audit) : V1.0.0 testait `formatted.lenght` (faute de frappe
 * sur `.length`, toujours `undefined` donc toujours faux) — la branche de
 * retour anticipé `{ VALGES: false, CREGES: false }` n'était donc jamais
 * empruntée pour une liste vide, et `.some()` sur un tableau vide retourne de
 * toute façon `false` : le résultat final était fonctionnellement identique.
 * On simplifie ici en retirant la vérification morte plutôt que de reporter
 * la faute de frappe.
 */
export function formatStatusGest(rows, userId) {
  const formatted = formatGestionnaires(rows);

  return {
    VALGES: formatted.some(
      (g) => g.VALGES && g.ENBUSRS.includes(Number(userId)),
    ),
    CREGES: formatted.some(
      (g) => g.CREGES && g.ENBUSRS.includes(Number(userId)),
    ),
  };
}

/**
 * BREAKING CHANGE (ajout de LATE, cf. vw_FsaServicesMustValidate) : chaque
 * entrée de SERVICES était une simple chaîne (SERVGES) ; c'est désormais un
 * objet { SERVGES, LATE } pour porter le retard éventuel de CE service sur
 * CE dossier. Impacte SRVMSTVAL (FSAENT / liste des dossiers) et les deux
 * endpoints GET /gestionnaires/must/validate(/numdos) — le front doit être
 * adapté en conséquence (`SERVICES.map(s => s.SERVGES)` pour retrouver
 * l'ancien comportement, `SERVICES.some(s => s.LATE)` pour savoir si le
 * dossier a au moins un service en retard).
 */
export function formatGestsMustValidate(rows = []) {
  const map = new Map();

  for (const row of rows) {
    const numdos = row.NUMDOS;
    const services = map.get(numdos) || [];

    // éviter les doublons éventuels (plusieurs NUMGES pour un même SERVGES) ;
    // LATE est identique pour tous les NUMGES d'un même SERVGES (cf. la vue),
    // donc la première occurrence rencontrée suffit.
    if (!services.some((service) => service.SERVGES === row.SERVGES)) {
      services.push({ SERVGES: row.SERVGES, LATE: toBool(row.LATE) });
    }

    map.set(numdos, services);
  }

  // Transforme la map en tableau d'objets { NUMDOS, SERVICES: [...] }
  return Array.from(map.entries()).map(([NUMDOS, SERVICES]) => ({
    NUMDOS,
    SERVICES,
  }));
}

export function formatServices(rows = []) {
  const servsMap = new Map();

  for (const row of rows) {
    const servKey = row.SERVGES;
    if (!servsMap.has(servKey)) {
      servsMap.set(servKey, { SERV: servKey, GEST: [] });
    }
    servsMap.get(servKey).GEST.push(row);
  }

  return Array.from(servsMap.values());
}

export function formatCanDelGests(rows = []) {
  const gests = formatGestionnaires(rows);
  const canDelGests = [];

  for (const rec of rows) {
    for (const row of gests) {
      if (row.NUMGES === rec.NUMGES) {
        canDelGests.push({
          FSAGES: row,
          CANDEL: rec.CanDelete,
        });
      }
    }
  }

  return canDelGests;
}

/**
 * FSASETTINGS est une table singleton : services.getSettings() renvoie un
 * recordset d'une seule ligne. On la met à plat en un objet unique — la
 * forme attendue par FsaAppSettings côté front (entities/fsa/FsaAppSettings.class.ts),
 * plutôt qu'une liste à un élément.
 */
export function formatSettings(rows = []) {
  const row = rows[0];
  if (!row) return null;

  return {
    VALDELAY: row.VALDELAY,
    ARCDELAY: row.ARCDELAY,
    DELDELAY: row.DELDELAY,
    PURDELAY: row.PURDELAY,
    CREUSR: row.CREUSR,
    CREDAT: utcToParisIso(row.CREDAT),
    MODUSR: row.MODUSR,
    MODDAT: utcToParisIso(row.MODDAT),
  };
}
