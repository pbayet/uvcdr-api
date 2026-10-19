import { isManagerPermission } from "../files/utils.js";

/* ═══════════════════════════════════════════════════════════════
   VINIDOC — Utilitaires (droits, catalogue des balises, mise en forme)
   Aucune dépendance base de données : tout ici est testable unitairement.
═══════════════════════════════════════════════════════════════ */

/* ───────────────────────────── Droits ───────────────────────────── */

/** Liste d'env "A,B,C" → ["A","B","C"] (majuscules, sans accents). */
const normalize = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/Œ/gi, "OE")
    .trim()
    .toUpperCase();

const envList = (name, fallback = "") =>
  (process.env[name] ?? fallback).split(",").map(normalize).filter(Boolean);

const serviceOf = (req) => normalize(req?.payload?.data?.service?.name);
const isManager = (req) => isManagerPermission(req?.payload?.permission);

function inServices(req, envName, fallback) {
  const service = serviceOf(req);
  return !!service && envList(envName, fallback).includes(service);
}

/**
 * Le token doit avoir été émis pour l'application VINIDOC (cf. /auth/app).
 * Indispensable : authVerifyMiddleware laisse passer un token "HOME" sans
 * contrôle de permission, et ne vérifie la permission que pour
 * l'application portée par le token.
 */
export function assertVinidocApp(req) {
  const allowed = envList("VINIDOC_APPCODES", "VINDOC");
  if (
    !allowed.includes(normalize(req?.payload?.application)) ||
    req?.payload?.isCave
  ) {
    throw new Error("ACCESS_DENIED_WO_LOGOUT");
  }
}

/** Œnologues : saisie, traduction, soumission. */
export const canEditSheets = (req) =>
  isManager(req) || inServices(req, "VINIDOC_EDITOR_SERVICES", "OENOLOGIE");

/** Marketing : validation / refus. */
export const canValidateSheets = (req) =>
  isManager(req) || inServices(req, "VINIDOC_VALIDATOR_SERVICES", "MARKETING");

/** Administration des modèles PowerPoint. */
export const canManageTemplates = (req) =>
  isManager(req) || inServices(req, "VINIDOC_TEMPLATE_SERVICES", "MARKETING");

const assertOr = (ok) => {
  if (!ok) throw new Error("ACCESS_DENIED_WO_LOGOUT");
};
export const assertCanEditSheets = (req) => assertOr(canEditSheets(req));
export const assertCanValidateSheets = (req) =>
  assertOr(canValidateSheets(req));
export const assertCanManageTemplates = (req) =>
  assertOr(canManageTemplates(req));

/**
 * Modification du contenu d'une fiche (champs, cépages, traductions) :
 * œnologie, ou marketing pendant sa relecture. Renvoie les droits transmis
 * au service, qui décide sous verrou du statut résultant (le marketing ne
 * peut modifier qu'une fiche SUBMITTED, qui reste alors SUBMITTED).
 */
export function getSheetEditRights(req) {
  const rights = {
    CANEDIT: canEditSheets(req),
    CANVALIDATE: canValidateSheets(req),
  };
  assertOr(rights.CANEDIT || rights.CANVALIDATE);
  return rights;
}

/** Droits de l'utilisateur courant, exposés au front (GET /vinidoc/me). */
export const getRights = (req) => ({
  EDIT: canEditSheets(req),
  VALIDATE: canValidateSheets(req),
  TEMPLATES: canManageTemplates(req),
  GENERATE: true,
});

/** Identifiant de l'auteur d'une action (email : sert aussi aux notifications). */
export function getActor(req) {
  const d = req?.payload?.data ?? {};
  return String(
    d.email || `${d.FirstName ?? ""} ${d.LastName ?? ""}`.trim() || "inconnu",
  )
    .toLowerCase()
    .slice(0, 254);
}

export function getActorDisplayName(req) {
  const d = req?.payload?.data ?? {};
  return (
    `${d.FirstName ?? ""} ${d.LastName ?? ""}`.trim() ||
    d.email ||
    "Utilisateur"
  );
}

/* ───────────────────────── Verrouillage optimiste ───────────────────────── */

/** rowversion (Buffer mssql) → "0x0000000000000A1F". */
export const rowverToHex = (buf) =>
  Buffer.isBuffer(buf) ? `0x${buf.toString("hex").toUpperCase()}` : null;

/** "0x…" → Buffer pour un paramètre sql.VarBinary(8). */
export const hexToRowver = (hex) =>
  Buffer.from(String(hex).replace(/^0x/i, ""), "hex");

/* ───────────────────────── Catalogue des balises ───────────────────────── */

export const SCALES = {
  INTENSITE_AROMATIQUE: "INTARO",
  INTENSITE_BOUCHE: "INTBOU",
  ECHELLE_FRUIT: "ECHFRU",
};

/**
 * Balises texte disponibles dans les modèles ({{TAG}}) — alignées sur les
 * balises du modèle PowerPoint du POC (fiche-template.pptx).
 *   TRANSLATED : valeur dépendant de la langue demandée.
 *   FIELD      : champ de traduction (SHEETTRANS) dont la balise est issue.
 *   AVAILABLE  : false = pas encore de donnée en base (balise reconnue mais
 *                rendue vide) — cas des données logistiques, qui ne font
 *                pas partie des données œnologiques saisies dans VINIDOC.
 */
export const TEXT_FIELDS = [
  {
    TAG: "APPELLATION", // ancien : WINE.APPELLATIONLABEL
    LABEL: "Intitulé (intitulé commercial, sinon « appellation - couleur »)",
    TRANSLATED: true,
    AVAILABLE: true,
  },
  {
    TAG: "TEMP", // ancien : WINE.SERVINGTEMP
    LABEL: "Température de dégustation",
    TRANSLATED: false,
    AVAILABLE: true,
  },
  {
    TAG: "DEGUST", // ancien : WINE.TASTINGNOTES
    LABEL: "Dégustation (œil, nez, bouche)",
    TRANSLATED: true,
    FIELD: "DEGUST",
    AVAILABLE: true,
  },
  {
    TAG: "TERROIR", // ancien : WINE.TERROIR
    LABEL: "Terroir et sol",
    TRANSLATED: true,
    FIELD: "TERROIR",
    AVAILABLE: true,
  },
  {
    TAG: "VINIF", // ancien : WINE.VINEYARD
    LABEL: "Vendanges et vinification",
    TRANSLATED: true,
    FIELD: "VINIF",
    AVAILABLE: true,
  },
  ...[
    ["LOG.BTLDIM", "Dimensions bouteille"], // ancien : LOGISTICS.BOTTLEDIMENSIONS
    ["LOG.BTLWGT", "Poids bouteille"], // ancien : LOGISTICS.BOTTLEWEIGHT
    ["LOG.CASEDIM", "Dimensions carton"], // ancien : LOGISTICS.CASEDIMENSIONS
    ["LOG.CASEPAL", "Cartons par palette"], // ancien : LOGISTICS.CASESPERPALLET
    ["LOG.CASEWGT", "Poids carton"], // ancien : LOGISTICS.CASEWEIGHT
    ["LOG.EANBTL", "EAN bouteille"], // ancien : LOGISTICS.EANBOTTLE
    ["LOG.EANCASE", "EAN carton"], // ancien : LOGISTICS.EANCARTON
    ["LOG.LVLPAL", "Couches par palette"], // ancien : LOGISTICS.LEVELPERPALLET
    ["LOG.PALHGT", "Hauteur palette"], // ancien : LOGISTICS.PALLETHEIGHT
    ["LOG.PALWGT", "Poids palette"], // ancien : LOGISTICS.PALLETWEIGHT
    ["LOG.UNITCASE", "Bouteilles par carton"], // ancien : LOGISTICS.UNITSPERCASE
    ["LOG.UNITPAL", "Bouteilles par palette"], // ancien : LOGISTICS.UNITSPERPALLET
  ].map(([TAG, LABEL]) => ({
    TAG,
    LABEL: `${LABEL} (logistique — non alimenté)`,
    TRANSLATED: false,
    AVAILABLE: false,
  })),
];

/**
 * Logos de certification : formes "badge:HVE" / "badge:BIO", affichées
 * uniquement si l'option est cochée à la génération (non stockée sur la
 * fiche ; tracée dans GENERATIONS).
 */
export const CERTIFICATIONS = ["HVE", "BIO"];

/** Logo combiné ("badge:BIOHVE"), affiché à la place des deux logos séparés. */
export const CERTIFICATION_COMBINED = "BIOHVE";

/**
 * Badges de certification à partir des options de génération.
 * Les deux options cochées → logo combiné BIOHVE seul, si le modèle le
 * contient ; sinon (modèle sans badge:BIOHVE) les deux logos séparés.
 * @param {{HVE?:boolean, BIO?:boolean}} options
 * @param {Array<{TAGTYP:string, TAGNAM:string}>} [templateTags] balises du modèle
 */
export function certificationBadges(options = {}, templateTags = []) {
  const selected = Object.fromEntries(
    CERTIFICATIONS.map((c) => [c, options[c] === true]),
  );
  const hasCombined = templateTags.some(
    (t) => t.TAGTYP === "BADGE" && t.TAGNAM === CERTIFICATION_COMBINED,
  );
  const combined = hasCombined && CERTIFICATIONS.every((c) => selected[c]);
  return {
    ...Object.fromEntries(CERTIFICATIONS.map((c) => [c, selected[c] && !combined])),
    [CERTIFICATION_COMBINED]: combined,
  };
}

/** Formes conditionnelles ("badge:TAG"), décrites par motif. */
export const BADGE_PATTERNS = [
  ...CERTIFICATIONS.map((c) => ({
    PATTERN: c,
    LABEL: `Logo ${c} : affiché si seul ${c} est coché à la génération`,
  })),
  {
    PATTERN: CERTIFICATION_COMBINED,
    LABEL: "Logo combiné : affiché si HVE et BIO sont cochés (remplace les 2 logos)",
  },
  {
    PATTERN: "COULEUR_<ROUGE|ROSE|BLANC>",
    LABEL: "Affiché si la couleur correspond",
  },
  ...Object.keys(SCALES).flatMap((s) => [
    { PATTERN: `${s}_<1..5>`, LABEL: `Jauge : affiché si ${s} ≥ n` },
    {
      PATTERN: `${s}_EQ_<0..5>`,
      LABEL: `Affiché si ${s} = n (0 = non renseigné)`,
    },
  ]),
];

export const IMAGE_FIELDS = [
  { TAG: "BOTTLEPHOTO", LABEL: "Photo bouteille (fournie à la génération)" },
];

const TEXT_TAGS = new Set(TEXT_FIELDS.map((f) => f.TAG));
const IMAGE_TAGS = new Set(IMAGE_FIELDS.map((f) => f.TAG));
const BADGE_RE = new RegExp(
  `^(${[...CERTIFICATIONS, CERTIFICATION_COMBINED].join("|")}|COULEUR_[A-Z]+|(${Object.keys(SCALES).join("|")})_([1-5]|EQ_[0-5]))$`,
);

/** La balise détectée dans un modèle fait-elle partie du catalogue ? */
export function isKnownTag(TAGTYP, TAGNAM) {
  if (TAGTYP === "TEXT") return TEXT_TAGS.has(TAGNAM);
  if (TAGTYP === "IMAGE") return IMAGE_TAGS.has(TAGNAM);
  if (TAGTYP === "BADGE") return BADGE_RE.test(TAGNAM);
  return false;
}

/** Bornes d'une longueur max de balise (cf. validators.templateTagsSchema). */
export const TAG_MAXLEN_MIN = 1;
export const TAG_MAXLEN_MAX = 10000;

const isValidMaxLen = (n) =>
  Number.isInteger(n) && n >= TAG_MAXLEN_MIN && n <= TAG_MAXLEN_MAX;

/**
 * Longueur max saisie dans le modèle ({{TAG-250}}) : la plus stricte des
 * valeurs valides si la balise apparaît plusieurs fois ; null si aucune.
 */
export function maxLenFromInventory(inventory, TAGNAM) {
  const valid = (inventory?.LENGTHS?.[TAGNAM] ?? []).filter(isValidMaxLen);
  return valid.length ? Math.min(...valid) : null;
}

/**
 * Résultat de OoxmlTemplate.listTags() → lignes TEMPLATETAGS.
 * MAXLEN : longueur saisie dans la balise texte (null = non précisée).
 */
export function tagsFromInventory(inventory) {
  return ["TEXT", "IMAGE", "BADGE"].flatMap((TAGTYP) =>
    (inventory?.[TAGTYP] ?? []).map((TAGNAM) => ({
      TAGTYP,
      TAGNAM,
      ISKNOWN: isKnownTag(TAGTYP, TAGNAM),
      MAXLEN: TAGTYP === "TEXT" ? maxLenFromInventory(inventory, TAGNAM) : null,
    })),
  );
}

/** Avertissements sur les longueurs saisies dans les balises du modèle. */
export function maxLenWarnings(inventory) {
  return Object.entries(inventory?.LENGTHS ?? {}).flatMap(([TAGNAM, values]) => {
    const out = [];
    const invalid = values.filter((n) => !isValidMaxLen(n));
    const valid = values.filter(isValidMaxLen);
    if (invalid.length) {
      out.push(
        `Balise {{${TAGNAM}}} : longueur ${invalid.join(", ")} ignorée ` +
          `(attendu entre ${TAG_MAXLEN_MIN} et ${TAG_MAXLEN_MAX}).`,
      );
    }
    if (valid.length > 1) {
      out.push(
        `Balise {{${TAGNAM}}} : longueurs différentes dans le modèle ` +
          `(${valid.join(", ")}) — la plus stricte (${valid[0]}) est retenue.`,
      );
    }
    return out;
  });
}

/**
 * Balises du catalogue absentes d'un modèle : balises texte alimentées et
 * images. Les badges (décrits par motif) et les balises logistiques (non
 * alimentées) ne sont pas listés.
 */
export function missingCatalogTags(TAGS) {
  const present = new Set((TAGS ?? []).map((t) => `${t.TAGTYP}:${t.TAGNAM}`));
  return [
    ...TEXT_FIELDS.filter((f) => f.AVAILABLE).map((f) => ({
      TAGTYP: "TEXT",
      TAGNAM: f.TAG,
      LABEL: f.LABEL,
    })),
    ...IMAGE_FIELDS.map((f) => ({
      TAGTYP: "IMAGE",
      TAGNAM: f.TAG,
      LABEL: f.LABEL,
    })),
  ].filter((t) => !present.has(`${t.TAGTYP}:${t.TAGNAM}`));
}

/* ───────────────────────── Mise en forme des fiches ───────────────────────── */

const num = (v) => (v == null ? null : Number(v));

/**
 * Lignes SQL (fiche, traductions) → objet fiche. Même forme que
 * l'instantané JSON stocké à la validation (SHEETVERS.SNAPSHOT), pour que
 * la génération manipule une seule structure.
 */
export function formatSheet(row, translations = []) {
  if (!row) return null;
  return {
    SHTID: row.SHTID,
    CODVRAC: row.CODVRAC,
    MILLESIME: row.MILLESIME ?? null,
    APPELL: row.APPELL,
    COLCOD: row.COLCOD,
    DESCVRAC: row.DESCVRAC ?? null,
    INTARO: row.INTARO ?? null,
    INTBOU: row.INTBOU ?? null,
    ECHFRU: row.ECHFRU ?? null,
    TEMPMIN: num(row.TEMPMIN),
    TEMPMAX: num(row.TEMPMAX),
    STATUS: row.STATUS,
    LASTVER: row.LASTVER ?? 0,
    CREUSR: row.CREUSR,
    CREDAT: row.CREDAT,
    MODUSR: row.MODUSR,
    MODDAT: row.MODDAT,
    SUBUSR: row.SUBUSR ?? null,
    SUBDAT: row.SUBDAT ?? null,
    ROWVER: rowverToHex(row.ROWVER),
    TRANSLATIONS: Object.fromEntries(
      translations.map((t) => [
        t.LNGCOD,
        {
          LIBELLE: t.LIBELLE ?? null,
          TERROIR: t.TERROIR ?? null,
          VINIF: t.VINIF ?? null,
          DEGUST: t.DEGUST ?? null,
          GARDE: t.GARDE ?? null,
          CEPAGES: t.CEPAGES ?? null,
          ACCORDS: t.ACCORDS ?? null,
          ACCEXPL: t.ACCEXPL ?? null,
          MODUSR: t.MODUSR,
          MODDAT: t.MODDAT,
        },
      ]),
    ),
  };
}

/** Copie de `obj` sans les clés `keys`. */
export const omitKeys = (obj, keys) =>
  Object.fromEntries(
    Object.entries(obj ?? {}).filter(([k]) => !keys.includes(k)),
  );

const WORKFLOW_KEYS = [
  "STATUS",
  "LASTVER",
  "ROWVER",
  "SUBUSR",
  "SUBDAT",
  "CREUSR",
  "CREDAT",
];

/** Contenu figé à la validation (sans les métadonnées de workflow). */
export function buildSnapshot(sheet) {
  return {
    ...omitKeys(sheet, WORKFLOW_KEYS),
    TRANSLATIONS: Object.fromEntries(
      Object.entries(sheet.TRANSLATIONS ?? {}).map(([lng, t]) => [
        lng,
        omitKeys(t, ["MODUSR", "MODDAT"]),
      ]),
    ),
  };
}

const formatNumber = (lng, value) =>
  new Intl.NumberFormat(lng, { maximumFractionDigits: 2 }).format(value);

/** Ancienne liste structurée de cépages → texte ("Grenache 60 %, Syrah"). */
export function formatGrapes(grapes = [], lng = "fr") {
  return grapes
    .map((g) =>
      g.PCT != null ? `${g.CEPAGE} ${formatNumber(lng, g.PCT)} %` : g.CEPAGE,
    )
    .join(", ");
}

/**
 * Instantané validé → forme actuelle. Les versions validées avant le passage
 * des cépages en texte traduisible portent `GRAPES: [{ CEPAGE, PCT }]` au
 * niveau de la fiche : converti en `CEPAGES` dans chaque traduction (sans
 * écraser une valeur existante). Les instantanés stockés ne sont pas modifiés.
 */
export function upgradeSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.GRAPES)) return snapshot;
  const { GRAPES, ...rest } = snapshot;
  return {
    ...rest,
    TRANSLATIONS: Object.fromEntries(
      Object.entries(rest.TRANSLATIONS ?? {}).map(([lng, t]) => [
        lng,
        { ...t, CEPAGES: t?.CEPAGES ?? (formatGrapes(GRAPES, lng) || null) },
      ]),
    ),
  };
}

export function formatTemperature(min, max, lng = "fr") {
  if (min == null && max == null) return "";
  if (min == null || max == null || min === max) {
    return `${formatNumber(lng, min ?? max)}°C`;
  }
  return `${formatNumber(lng, min)}-${formatNumber(lng, max)}°C`;
}

/**
 * Données de fusion d'une fiche dans une langue.
 * @param {object} sheet   formatSheet() ou instantané validé
 * @param {string} lng
 * @param {{LABEL?:string, BOUMIN?:string, BOUMAX?:string}} [color] libellés COLORTRANS
 * @returns {{ text: Record<string,string>, badges: Record<string,boolean> }}
 */
export function buildMergeData(sheet, lng, color = {}) {
  const tr = sheet.TRANSLATIONS?.[lng] ?? {};
  const str = (v) =>
    v == null ? "" : String(v).replace(/\r\n?/g, "\n").trim();

  // Valeurs calculées (balises sans champ de traduction direct).
  const computed = {
    APPELLATION:
      str(tr.LIBELLE) ||
      [str(sheet.APPELL), str(color.LABEL ?? sheet.COLCOD)]
        .filter(Boolean)
        .join(" - ")
        .toUpperCase(),
    TEMP: formatTemperature(sheet.TEMPMIN, sheet.TEMPMAX, lng),
  };

  // Toutes les balises du catalogue sont présentes (vides si sans donnée,
  // ex. LOG.*) : le contrôle des longueurs et des balises
  // obligatoires porte ainsi sur une valeur définie.
  const text = Object.fromEntries(
    TEXT_FIELDS.map((f) => [
      f.TAG,
      f.FIELD ? str(tr[f.FIELD]) : (computed[f.TAG] ?? ""),
    ]),
  );

  const badges = { [`COULEUR_${sheet.COLCOD}`]: true };
  for (const [tag, col] of Object.entries(SCALES)) {
    const value = Number(sheet[col]) || 0; // non renseigné → 0
    badges[`${tag}_EQ_0`] = value === 0;
    for (let n = 1; n <= 5; n++) {
      badges[`${tag}_${n}`] = value >= n;
      badges[`${tag}_EQ_${n}`] = value === n;
    }
  }

  return { text, badges };
}

/** Longueur "visible" (points de code, \r\n compté pour 1). */
export const textLength = (s) =>
  [...String(s ?? "").replace(/\r\n?/g, "\n")].length;

/**
 * Contrôle des données de fusion face aux balises texte d'un modèle.
 * @param {Record<string,string>} text   buildMergeData().text
 * @param {Array<{TAGTYP,TAGNAM,MAXLEN,REQUIRED,ISKNOWN}>} tags
 */
export function checkAgainstTemplate(text, tags = []) {
  const TAGS = tags
    .filter((t) => t.TAGTYP === "TEXT")
    .map((t) => {
      const LENGTH = textLength(text[t.TAGNAM]);
      const MAXLEN = t.MAXLEN ?? null;
      let ISSUE = null;
      if (!t.ISKNOWN) ISSUE = "UNKNOWN_TAG";
      else if (t.REQUIRED && LENGTH === 0) ISSUE = "MISSING";
      else if (MAXLEN != null && LENGTH > MAXLEN) ISSUE = "TOO_LONG";
      return {
        TAGNAM: t.TAGNAM,
        LENGTH,
        MAXLEN,
        REQUIRED: !!t.REQUIRED,
        ISSUE,
      };
    });

  // Une balise inconnue est rendue vide : simple avertissement, pas bloquant.
  const ERRORS = TAGS.filter(
    (t) => t.ISSUE === "MISSING" || t.ISSUE === "TOO_LONG",
  );
  return { OK: ERRORS.length === 0, TAGS, ERRORS };
}

/** Nom de fichier lisible pour une fiche générée. */
export function outputFileName(sheet, lng, format) {
  const base = [sheet.CODVRAC, sheet.MILLESIME, lng.toUpperCase()]
    .filter((v) => v != null && v !== "")
    .join("_")
    .replace(/[^\w-]+/g, "-");
  return `${base}.${format}`;
}
