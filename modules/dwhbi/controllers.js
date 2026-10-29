import * as services from "./services.js";
import * as utils from "./utils.js";
import * as requestUtils from "../../core/utils/request.utils.js";
import * as functionsUtils from "../../core/utils/functions.utils.js";

// ============================================================================
// Contrôleurs
// ============================================================================

export async function getClients(req) {
  const { DEMA } = (await requestUtils.getRequestParams(req)).params;

  return requestUtils.getCachedResult(`dwhbi_clients_${DEMA}`, async () => {
    const raw = await services.getClients(DEMA);
    return utils.formatClients(raw);
  });
}

/** LIMIT demandé, borné à [1, max] (défaut si absent ou invalide). */
function toLimit(LIMIT, fallback, max = 200) {
  const n = parseInt(LIMIT, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

/**
 * Recherche de clients pour un select à chargement distant (SEARCH), ou
 * client déjà choisi (BPCNUM). Contrairement à getClients, rien n'est
 * chargé en entier : seuls les LIMIT premiers clients sont renvoyés.
 */
export async function searchClients(req) {
  const { DEMA, SEARCH, BPCNUM, LIMIT } = (
    await requestUtils.getRequestParams(req)
  ).params;

  const raw = await services.searchClients({
    DEMA,
    SEARCH,
    BPCNUM,
    LIMIT: toLimit(LIMIT, 30),
  });
  return utils.formatClients(raw);
}

export async function getPays(req) {
  return requestUtils.getCachedResult("dwhbi_pays", async () => {
    return await services.getPays();
  });
}

export async function getVrac(req) {
  return requestUtils.getCachedResult("dwhbi_vrac", async () => {
    const rawDwhbi = await services.getVrac();
    return rawDwhbi;
  });
}

/**
 * Recherche des valeurs d'un champ vrac (FIELD : MRQ, GAM, APP, COU, CEP,
 * QAL, TYPO, SPTY, MILL) pour un select à chargement distant (SEARCH), ou
 * valeur déjà choisie (CODE).
 */
export async function searchVrac(req) {
  const { FIELD, SEARCH, CODE, LIMIT } = (
    await requestUtils.getRequestParams(req)
  ).params;

  if (!services.VRAC_FIELD_NAMES.includes(FIELD)) {
    const err = new Error(
      `FIELD doit valoir ${services.VRAC_FIELD_NAMES.join(", ")}`,
    );
    err.status = 400;
    throw err;
  }

  return services.searchVrac({
    FIELD,
    SEARCH,
    CODE,
    LIMIT: toLimit(LIMIT, 50),
  });
}

export async function getMsContainers(req) {
  return requestUtils.getCachedResult("dwhbi_ms_containers", async () => {
    const rawDwhbi = await services.getMsContainers();
    return utils.formatMsContainers(rawDwhbi);
  });
}

export async function getMsNomenclature(req) {
  const { CODCATCOM, FMT, BASQTY } = (await requestUtils.getRequestParams(req))
    .params;

  return requestUtils.getCachedResult(
    `dwhbi_ms_nomenclature_${CODCATCOM}_${FMT}_${BASQTY}`,
    async () => {
      const rawDwhbi = await services.getMsNomenclature(CODCATCOM, FMT, BASQTY);
      return utils.formatMsNomenclature(rawDwhbi);
    },
  );
}

export async function getMsNomenclatureCategories(req) {
  const { CODCATCOM, FMT, BASQTY } = (await requestUtils.getRequestParams(req))
    .params;

  return requestUtils.getCachedResult(
    `dwhbi_ms_nomenclature_categories_${CODCATCOM}_${FMT}_${BASQTY}`,
    async () =>
      services.getMsNomenclatureCategories(CODCATCOM, FMT, BASQTY),
  );
}

/**
 * Recherche des articles d'une catégorie (CODCAT) pour un select à
 * chargement distant (SEARCH), ou article déjà choisi (ITMREF).
 */
export async function searchMsNomenclature(req) {
  const { CODCATCOM, FMT, BASQTY, CODCAT, SEARCH, ITMREF, LIMIT } = (
    await requestUtils.getRequestParams(req)
  ).params;

  return services.searchMsNomenclature({
    CODCATCOM,
    FMT,
    BASQTY,
    CODCAT,
    SEARCH,
    ITMREF,
    LIMIT: toLimit(LIMIT, 50),
  });
}

export async function getNomenclatureByPFI(req) {
  const { PFI } = (await requestUtils.getRequestParams(req)).params;

  return requestUtils.getCachedResult(`dwhbi_nomenclature_${PFI}`, async () => {
    const rawDwhbi = await services.getNomenclatureByPFI(PFI);
    return utils.formatNomenclature(rawDwhbi);
  });
}

export async function getMrvComplement(req) {
  const { NUMS } = (await requestUtils.getRequestParams(req)).params;

  const jsonNUMS = functionsUtils.parseToJSON(NUMS);

  const rawDwhbi = await services.getMrvComplement(jsonNUMS);
  return rawDwhbi;
}
