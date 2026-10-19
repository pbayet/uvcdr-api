/**
 * Formate les lignes de nomenclature en structure normalisée.
 * Gère la conversion des nombres et des valeurs nulles/indéfinies.
 */
export function formatClients(rows) {
  // Regroupement des enregistrements par BPCNUM (après avoir appliqué trim)
  const groupedClients = rows.reduce((acc, record) => {
    const bpcnum = record.BPCNUM ? record.BPCNUM.trim() : null;
    if (!bpcnum) return acc;
    if (!acc[bpcnum]) {
      acc[bpcnum] = [];
    }
    acc[bpcnum].push(record);
    return acc;
  }, {});

  // Transformation des groupes en objets clients avec un tableau de contacts
  return Object.values(groupedClients).map((group) => {
    const first = group[0];
    return {
      BPCNUM: first.BPCNUM ? first.BPCNUM.trim() : "",
      BPCNAM: first.BPCNAM ? first.BPCNAM.trim() : "",
      CLIPAY: {
        PAYSID: 0,
        NUMDOS: "",
        CLIPAY: first.CLIPAY ? first.CLIPAY.trim() : "",
        CLIPAYN: first.CLIPAYN ? first.CLIPAYN.trim() : "",
      },
      CLIACT: first.CODACT ? first.CODACT.trim() : "",
      NOMACT: first.NOMACT ? first.NOMACT.trim() : "",
      CLICON: group.map((rec) => ({
        CLICCON: rec.CLICCON ? rec.CLICCON.trim() : "",
        CLINAM: rec.CLINAM ? rec.CLINAM.trim() : "",
        CLIMAIL: rec.CLIMAIL ? rec.CLIMAIL.trim() : "",
        CLITEL: rec.CLITEL ? rec.CLITEL.trim() : "",
      })),
    };
  });
}

export function formatMsContainers(rows) {
  const groupMap = new Map();

  for (const row of rows) {
    const key = `${row.CODCAT}|${row.LCAT}`;

    if (!groupMap.has(key)) {
      groupMap.set(key, {
        CONTS: {
          CODCAT: row.CODCAT,
          LCAT: row.LCAT,
        },
        FMTS: [],
      });
    }

    groupMap.get(key).FMTS.push({
      CODFMT: row.CODFMT,
      COEF: row.COEF,
      LFMT: row.LFMT,
    });
  }

  // Retourne un tableau d’objets { CONTS, FMTS }
  return Array.from(groupMap.values());
}

export function formatMsNomenclature(rows) {
  const groupMap = new Map();

  for (const row of rows) {
    const key = `${row.CODCAT}|${row.LCAT}`;

    if (!groupMap.has(key)) {
      groupMap.set(key, {
        CAT: {
          CODCAT: row.CODCAT,
          LCAT: row.LCAT,
        },
        ITMS: [],
      });
    }

    const entry = groupMap.get(key);
    entry.ITMS.push({
      ITMREF: row.ITMREF,
      LITM: row.LITM,
    });
  }

  return Array.from(groupMap.values());
}

/**
 * Formate les lignes de nomenclature en structure normalisée.
 * Gère la conversion des nombres et des valeurs nulles/indéfinies.
 */
export function formatNomenclature(rows = []) {
  if (!Array.isArray(rows)) return [];

  const normalize = (value, fallback = null) =>
    value !== undefined && value !== null ? value : fallback;

  const toNumber = (value) =>
    value !== undefined && value !== null ? Number(value) : null;

  return rows.map((row) => ({
    ITMREF: normalize(row.ITMREF, ""),
    ITMDES: normalize(row.ITMDES),
    ITMCAT: normalize(row.ITMCAT, ""),
    DESCAT: normalize(row.DESCAT),
    BASQTY: toNumber(row.BASQTY),
    CPNITMREF: normalize(row.CPNITMREF, ""),
    CPNITMDES: normalize(row.CPNITMDES),
    BOMUOM: normalize(row.BOMUOM),
    BOMSTUCOE: toNumber(row.BOMSTUCOE),
    BOMQTY: toNumber(row.BOMQTY),
    LIKQTY: toNumber(row.LIKQTY),
    STU: normalize(row.STU),
    ITMMIL: toNumber(row.ITMMIL),
    ITMMILN: toNumber(row.ITMMILN),
    NOTLINC: normalize(row.NOTLINC),
    NOTDOS: normalize(row.NOTDOS),
    CODFMT: normalize(row.CODFMT),
    LFMT: normalize(row.LFMT),
    LLFMT: normalize(row.LLFMT),
    COEFFMT: normalize(row.COEFFMT),
    CODCAT: normalize(row.CODCAT),
    LCAT: normalize(row.LCAT),
    LLCAT: normalize(row.LLCAT),
  }));
}
