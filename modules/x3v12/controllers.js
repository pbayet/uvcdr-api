import * as services from "./services.js";
import * as requestUtils from "../../core/utils/request.utils.js";

// ============================================================================
// Contrôleurs
// ============================================================================

export async function getIngresMrv(req) {
  const { MRVCOD } = (await requestUtils.getRequestParams(req)).params;

  return requestUtils.getCachedResult(`x3v12_mrv_${MRVCOD}`, async () => {
    const raw = await services.getIngresMrv(MRVCOD);
    return raw?.[0];
  });
}
