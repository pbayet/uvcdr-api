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
