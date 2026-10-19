import sql from "mssql";
import { runQuery } from "../../core/utils/db.utils.js";

export async function getIngresMrv(MRVCOD) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT
        pq.ITMREF_0 AS ITMREF,
        pq.QTYUOM_0 AS QTYHL,
        itmm.ITMDES1_0 AS DESART1,
        itmm.DES2AXX_0 AS DESART2,
        itmm.YITMAPP_0 AS APPL,
        itmm.YITMCOU_0 AS COUL,
        bp.YACCISE_0 AS CODACCISE,
        bp.CRN_0 AS CRN,
        p.ORDDAT_0 AS ORDDAT,
        p.STRDAT_0 AS STRDAT,
        p.ENDDAT_0 AS ENDDAT,
        pq.BPSNUM_0 AS CODFOURN,
        bps.BPSNAM_0 AS NAMFOURN,
        itmm.YITMCUV_0 AS TYPO,
        pq.POHNUM_0 AS MRVCOD,
        p.ORDREF_0 AS MRVREF,
        itmm.YITMGAM_0 AS QAL,
        itmm.YITMTYPOSPE_0 AS SPECTYPO
    FROM CDD.PORDERQ AS pq
    LEFT JOIN CDD.ITMMASTER AS itmm ON itmm.ITMREF_0 = pq.ITMREF_0
    LEFT JOIN CDD.BPARTNER AS bp ON bp.BPRNUM_0 = pq.BPSNUM_0
    LEFT JOIN CDD.PORDER AS p ON p.POHNUM_0 = pq.POHNUM_0
    LEFT JOIN CDD.BPSUPPLIER AS bps ON bps.BPSNUM_0 = pq.BPSNUM_0
    WHERE pq.POHNUM_0 = @MRVCOD
    `,
    inputs: { MRVCOD: { type: sql.NVarChar, value: MRVCOD } },
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}
