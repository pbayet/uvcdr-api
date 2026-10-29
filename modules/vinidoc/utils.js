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

/** Paramètres de l'application (calculs logistiques, réservation des fiches). */
export const canManageParams = (req) =>
  isManager(req) || inServices(req, "VINIDOC_PARAM_SERVICES", "INFORMATIQUE");

const assertOr = (ok) => {
  if (!ok) throw new Error("ACCESS_DENIED_WO_LOGOUT");
};
export const assertCanEditSheets = (req) => assertOr(canEditSheets(req));
export const assertCanValidateSheets = (req) =>
  assertOr(canValidateSheets(req));
export const assertCanManageTemplates = (req) =>
  assertOr(canManageTemplates(req));
export const assertCanManageParams = (req) => assertOr(canManageParams(req));

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
  PARAMS: canManageParams(req),
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
 *   AVAILABLE  : false = pas de donnée sur la fiche (balise reconnue, rendue
 *                vide sans article) — cas des données logistiques, issues de
 *                l'article PFI choisi à la génération (DWH, cf. logisticsText).
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
  // Autres données de la fiche : balises facultatives (OPTIONAL), non
  // signalées comme absentes d'un modèle qui ne les utilise pas.
  ...[
    ["CEPAGES", "Cépages", "CEPAGES"],
    ["GARDE", "Potentiel de garde", "GARDE"],
    ["ACCORDS", "Accords mets et vins", "ACCORDS"],
    ["ACCEXPL", "Explication des accords", "ACCEXPL"],
  ].map(([TAG, LABEL, FIELD]) => ({
    TAG,
    LABEL,
    TRANSLATED: true,
    FIELD,
    AVAILABLE: true,
    OPTIONAL: true,
  })),
  ...[
    ["APPELL", "Appellation seule (sans couleur ni intitulé commercial)", false],
    ["COULEUR", "Couleur du vin (libellé traduit)", true],
    ["MILLESIME", "Millésime (vide si non millésimé)", false],
    ["CODVRAC", "Code vrac", false],
    ["DESCVRAC", "Description vrac", false],
  ].map(([TAG, LABEL, TRANSLATED]) => ({
    TAG,
    LABEL,
    TRANSLATED,
    AVAILABLE: true,
    OPTIONAL: true,
  })),
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
    LABEL: `${LABEL} (logistique — article PFI choisi à la génération)`,
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

/**
 * Conditionnements de la photo produit : formes "badge:PHOTO_<TYPE>" (un
 * groupe par type, contenant son cadre "img:BOTTLEPHOTO" au ratio du type),
 * seul le groupe du conditionnement choisi à la génération est conservé.
 */
export const PACKAGINGS = ["BOUTEILLE", "BIB", "CANETTE"];
export const DEFAULT_PACKAGING = "BOUTEILLE";

/** Badges de conditionnement : seul PHOTO_<PACKAGING> est affiché. */
export function packagingBadges(packaging = DEFAULT_PACKAGING) {
  return Object.fromEntries(
    PACKAGINGS.map((p) => [`PHOTO_${p}`, p === packaging]),
  );
}

/** Libellés des échelles (catalogue des balises). */
const SCALE_LABELS = {
  INTENSITE_AROMATIQUE: "Intensité aromatique",
  INTENSITE_BOUCHE: "Intensité en bouche",
  ECHELLE_FRUIT: "Échelle de fruit",
};

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * Formes conditionnelles ("badge:TAG"), décrites par motif (PATTERN) avec la
 * liste exhaustive des noms possibles (NAMES) et leur famille (GROUP).
 * COULEUR_* : complété par les couleurs paramétrées (cf. getMergeFields).
 */
export const BADGE_PATTERNS = [
  ...CERTIFICATIONS.map((c) => ({
    GROUP: "Certifications",
    PATTERN: c,
    NAMES: [c],
    LABEL: `Logo ${c} : affiché si seul ${c} est coché à la génération`,
  })),
  {
    GROUP: "Certifications",
    PATTERN: CERTIFICATION_COMBINED,
    NAMES: [CERTIFICATION_COMBINED],
    LABEL: "Logo combiné : affiché si HVE et BIO sont cochés (remplace les 2 logos)",
  },
  {
    GROUP: "Conditionnement",
    PATTERN: `PHOTO_<${PACKAGINGS.join("|")}>`,
    NAMES: PACKAGINGS.map((p) => `PHOTO_${p}`),
    LABEL: "Groupe contenant le cadre img:BOTTLEPHOTO : conservé si le conditionnement choisi correspond",
  },
  {
    GROUP: "Couleur",
    PATTERN: "COULEUR_<COULEUR>",
    NAMES: ["COULEUR_ROUGE", "COULEUR_ROSE", "COULEUR_BLANC"],
    LABEL: "Affiché si la couleur du vin correspond",
  },
  ...Object.keys(SCALES).flatMap((s) => [
    {
      GROUP: SCALE_LABELS[s],
      PATTERN: `${s}_<1..5>`,
      NAMES: range(1, 5).map((n) => `${s}_${n}`),
      LABEL: "Jauge : affiché si la valeur est ≥ n (ex. 5 pastilles, la n-ième s'allume)",
    },
    {
      GROUP: SCALE_LABELS[s],
      PATTERN: `${s}_EQ_<0..5>`,
      NAMES: range(0, 5).map((n) => `${s}_EQ_${n}`),
      LABEL: "Affiché si la valeur vaut exactement n (0 = non renseignée)",
    },
  ]),
];

export const IMAGE_FIELDS = [
  {
    TAG: "BOTTLEPHOTO",
    LABEL: "Photo produit, fournie à la génération (sinon l'image du modèle est conservée)",
  },
];

const TEXT_TAGS = new Set(TEXT_FIELDS.map((f) => f.TAG));
const IMAGE_TAGS = new Set(IMAGE_FIELDS.map((f) => f.TAG));
const BADGE_RE = new RegExp(
  `^(${[...CERTIFICATIONS, CERTIFICATION_COMBINED].join("|")}|PHOTO_(${PACKAGINGS.join("|")})|COULEUR_[A-Z]+|(${Object.keys(SCALES).join("|")})_([1-5]|EQ_[0-5]))$`,
);

/**
 * Champs libres : balises texte {{FREE.<NOM>}} (ex. {{FREE.PRIX}}, {{FREE.MENTION_PROMO-130}}),
 * hors fiche œnologique, saisies dans le formulaire de génération (un champ
 * par balise du modèle choisi). Non tracées : seul le fichier généré les contient.
 */
export const FREE_TAG_RE = /^FREE\.[A-Z0-9_.]+$/;
export const isFreeTag = (TAGNAM) => FREE_TAG_RE.test(String(TAGNAM ?? ""));

/** La balise détectée dans un modèle fait-elle partie du catalogue ? */
export function isKnownTag(TAGTYP, TAGNAM) {
  if (TAGTYP === "TEXT") return TEXT_TAGS.has(TAGNAM) || isFreeTag(TAGNAM);
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
 * images. Les badges (décrits par motif), les balises logistiques (non
 * alimentées) et les balises facultatives (OPTIONAL) ne sont pas listés.
 */
export function missingCatalogTags(TAGS) {
  const present = new Set((TAGS ?? []).map((t) => `${t.TAGTYP}:${t.TAGNAM}`));
  return [
    ...TEXT_FIELDS.filter((f) => f.AVAILABLE && !f.OPTIONAL).map((f) => ({
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
    DEFTPLID: row.DEFTPLID ?? null,
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
  "DEFTPLID", // préférence de génération, pas du contenu validé
  "STATUS",
  "LASTVER",
  "ROWVER",
  "SUBUSR",
  "SUBDAT",
  "CREUSR",
  "CREDAT",
];

/**
 * Fiche après modification d'une fiche validée (RG-01), avant écriture :
 * champs communs remplacés (`common`, null = inchangés), traductions
 * modifiées fusionnées champ par champ (`translations[lng]` partiel ; null =
 * langue supprimée). Sert à construire l'instantané de la nouvelle version.
 * @returns {{ sheet: object, translations: object[], deletedLngs: string[] }}
 *   translations : textes complets des langues créées ou modifiées
 */
export function applySheetChanges(sheet, common = null, translations = {}) {
  const TRANSLATIONS = { ...(sheet.TRANSLATIONS ?? {}) };
  const changed = [];
  const deletedLngs = [];
  for (const [lng, t] of Object.entries(translations ?? {})) {
    if (t === null) {
      if (TRANSLATIONS[lng]) deletedLngs.push(lng);
      delete TRANSLATIONS[lng];
      continue;
    }
    // Champ absent (ou undefined après validation) = inchangé.
    const edited = Object.fromEntries(
      Object.entries(t).filter(([, v]) => v !== undefined),
    );
    const merged = {
      ...Object.fromEntries(CLEANED_TRANSLATION_FIELDS.map((f) => [f, null])),
      ...omitKeys(TRANSLATIONS[lng], ["MODUSR", "MODDAT"]),
      ...edited,
    };
    TRANSLATIONS[lng] = merged;
    changed.push({ LNGCOD: lng, ...merged });
  }
  return {
    sheet: { ...sheet, ...(common ?? {}), TRANSLATIONS },
    translations: changed,
    deletedLngs,
  };
}

/**
 * Fiche ajustée localement pour une génération (sans enregistrement) :
 * caractéristiques remplacées — sauf le code vrac, qui relie la fiche à
 * l'article PFI — et textes de la langue `lng` fusionnés champ par champ.
 */
export function applyLocalChanges(sheet, lng, common = null, translation = null) {
  if (!common && !translation) return sheet;
  return applySheetChanges(
    sheet,
    common ? omitKeys(common, ["CODVRAC"]) : null,
    translation ? { [lng]: translation } : {},
  ).sheet;
}

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
    APPELL: str(sheet.APPELL),
    COULEUR: str(color.LABEL ?? sheet.COLCOD),
    MILLESIME: str(sheet.MILLESIME),
    CODVRAC: str(sheet.CODVRAC),
    DESCVRAC: str(sheet.DESCVRAC),
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

/* ───────────────────────── Aperçu des modèles ───────────────────────── */

const LOREM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor " +
  "incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud " +
  "exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure " +
  "dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. ";

/** Longueur du texte fictif d'une balise sans longueur max. */
export const PREVIEW_DEFAULT_LENGTH = 80;

/** Valeurs courtes d'exemple (balises non rédigées : température, logistique). */
const PREVIEW_SAMPLES = {
  TEMP: "8-10°C",
  APPELL: "Côtes du Rhône",
  COULEUR: "Rouge",
  MILLESIME: "2024",
  CODVRAC: "VHL12345",
  DESCVRAC: "STANDARD",
  GARDE: "3 à 5 ans",
  "LOG.BTLDIM": "75 x 300 mm",
  "LOG.BTLWGT": "1,3 kg",
  "LOG.CASEDIM": "240 x 160 x 310 mm",
  "LOG.CASEPAL": "100",
  "LOG.CASEWGT": "8 kg",
  "LOG.EANBTL": "3 123456 789012",
  "LOG.EANCASE": "3 123456 789029",
  "LOG.LVLPAL": "5",
  "LOG.PALHGT": "1,60 m",
  "LOG.PALWGT": "800 kg",
  "LOG.UNITCASE": "6",
  "LOG.UNITPAL": "600",
};

/** Longueur du faux texte des balises courtes sans longueur max. */
const PREVIEW_LENGTHS = { APPELLATION: 40 };

/** Faux texte d'au plus `length` caractères, coupé à la fin d'un mot. */
export function loremText(length) {
  if (!(length > 0)) return "";
  const source = LOREM.repeat(Math.ceil(length / LOREM.length) + 1);
  let out = source.slice(0, length).trimEnd();
  const lastSpace = out.lastIndexOf(" ");
  if (out.length === length && lastSpace > length * 0.6) out = out.slice(0, lastSpace);
  out = out.replace(/[,.]$/, "");
  return out.length < length ? `${out}.` : out;
}

/**
 * Données de fusion fictives pour l'aperçu d'un modèle : chaque balise texte
 * reçoit du faux texte à sa longueur max (pire cas), sinon
 * PREVIEW_DEFAULT_LENGTH — sauf les valeurs courtes (température,
 * logistique), remplacées par un exemple réaliste ; blocs conditionnels d'un vin rouge aux échelles à
 * 3, logos HVE + BIO. Les images du modèle sont conservées.
 */
export function previewMergeData(templateTags = []) {
  const text = Object.fromEntries(
    templateTags
      .filter((t) => t.TAGTYP === "TEXT")
      .map((t) => {
        const sample = PREVIEW_SAMPLES[t.TAGNAM];
        if (sample) return [t.TAGNAM, sample.slice(0, t.MAXLEN ?? sample.length)];
        const length = t.MAXLEN ?? PREVIEW_LENGTHS[t.TAGNAM] ?? PREVIEW_DEFAULT_LENGTH;
        return [t.TAGNAM, loremText(length)];
      }),
  );
  const { badges } = buildMergeData(
    { COLCOD: "ROUGE", INTARO: 3, INTBOU: 3, ECHFRU: 3 },
    "fr",
  );
  return {
    text,
    badges: {
      ...badges,
      ...certificationBadges({ HVE: true, BIO: true }, templateTags),
      ...packagingBadges(),
    },
  };
}

/* ───────────────────────── Nettoyage des textes œnologiques ───────────────────────── */

/** Champs texte nettoyés : traductions (SHEETTRANS) et champs communs (SHEETS). */
export const CLEANED_TRANSLATION_FIELDS = [
  "LIBELLE",
  "TERROIR",
  "VINIF",
  "DEGUST",
  "GARDE",
  "CEPAGES",
  "ACCORDS",
  "ACCEXPL",
];
export const CLEANED_SHEET_FIELDS = ["APPELL", "DESCVRAC"];

// Caractères invisibles : espaces de largeur nulle, joiners, BOM, tiret
// conditionnel, caractères de contrôle (hors blancs, traités à part).
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD\u0000-\u0008\u000E-\u001F\u007F]/g;
// Blancs : retours à la ligne, tabulations, espaces insécables et Unicode.
const WHITESPACE = /[\s\u00A0\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g;

/**
 * Nettoie un texte saisi (copier-coller Word, PDF...) : caractères invisibles
 * supprimés, retours à la ligne / tabulations / espaces multiples ramenés à
 * une espace, espaces retirées avant « , . ) » et après « ( » (conservées
 * devant « ; : ! ? », typographie française), début et fin rognés.
 * Chaîne vide → null ; non-chaîne renvoyée telle quelle.
 */
export function cleanText(value) {
  if (typeof value !== "string") return value;
  const out = value
    .normalize("NFC")
    .replace(INVISIBLE, "")
    .replace(WHITESPACE, " ")
    .replace(/ +([,.)])/g, "$1")
    .replace(/\( +/g, "(")
    .trim();
  return out === "" ? null : out;
}

/**
 * Nettoie les champs texte d'une fiche (communs + traductions) — forme
 * formatSheet() ou instantané validé. Renvoie une copie.
 */
export function cleanSheetTexts(sheet) {
  if (!sheet) return sheet;
  const out = { ...sheet };
  for (const f of CLEANED_SHEET_FIELDS) if (f in out) out[f] = cleanText(out[f]);
  if (out.TRANSLATIONS) {
    out.TRANSLATIONS = Object.fromEntries(
      Object.entries(out.TRANSLATIONS).map(([lng, t]) => {
        const tr = { ...t };
        for (const f of CLEANED_TRANSLATION_FIELDS) if (f in tr) tr[f] = cleanText(tr[f]);
        return [lng, tr];
      }),
    );
  }
  return out;
}

/* ───────────────────────── Articles PFI (DWH) ───────────────────────── */

const fr = (value, digits = 1) =>
  new Intl.NumberFormat("fr-FR", { maximumFractionDigits: digits }).format(value);

const positive = (v) => (Number(v) > 0 ? Number(v) : null);

/** Dimensions non nulles, « 16 x 24,5 x 30,5 ». */
const dims = (...values) =>
  values.map(positive).filter((v) => v != null).map((v) => fr(v)).join(" x ");

const withUnit = (v, unit, digits = 1) =>
  positive(v) == null ? "" : `${fr(v, digits)} ${unit}`;

const integer = (v) => (positive(v) == null ? "" : fr(v, 0));

/** Article PFI (ligne de services.searchArticles / getArticle) → objet API. */
export function articleFromRow(row) {
  if (!row) return null;
  return {
    COD_ARTICLE: row.COD_ARTICLE,
    LIBELLE: row.LIBELLE?.trim() || null,
    LIBELLE_COURT: row.LIBELLE_COURT?.trim() || null,
    MILLESIME: positive(row.MILLESIME),
    STATUT: row.STATUT ?? null,
    CODVRACS: row.CODVRACS ? row.CODVRACS.split(",") : [],
  };
}

/**
 * Paramètres des calculs logistiques (table PARAMS, modifiables sans
 * développement) ; valeurs par défaut si la table n'est pas renseignée.
 */
export const DEFAULT_LOGISTICS_PARAMS = {
  WINE_DENSITY: 0.99, // kg/L
  PALLET_WEIGHT: 25, // kg, support palette absent de la nomenclature
  PALLET_HEIGHT: 15, // cm, idem
};

const VOLUME_UNITS = { L: 1, CL: 0.01, ML: 0.001 };

/** Contenance X3 (CAPACITE + UNIT_CAP) en litres ; null si inconnue. */
export function volumeInLiters(value, unit) {
  const factor = VOLUME_UNITS[String(unit ?? "L").trim().toUpperCase()];
  return positive(value) != null && factor ? positive(value) * factor : null;
}

/**
 * Poids pleins et hauteur de la palette chargée (EF-16 / EF-17), calculés à
 * partir des poids à vide de Sage X3 (cf. services.getArticle) :
 *   bouteille pleine = bouteille habillée vide + contenance × masse volumique
 *   carton plein     = bouteilles/carton × (bouteille pleine + emballage carton par bouteille)
 *   palette chargée  = support palette + cartons/palette × carton plein
 *   hauteur palette  = hauteur support + couches × hauteur carton
 * Support palette : composant PAL de la nomenclature, sinon paramètres.
 * Chaque valeur est null si une donnée manque (EF-14 : champ laissé vide) ;
 * DETAIL décrit le calcul (ou la donnée manquante) pour l'affichage.
 */
export function computeLogistics(row, params = {}) {
  const prm = { ...DEFAULT_LOGISTICS_PARAMS, ...params };
  const unitCase = positive(row?.UNITCASE);
  const unitPal = positive(row?.UNITPAL);
  const layers = positive(row?.LVLPAL);
  const caseHeight = positive(row?.CASE_HAUTEUR);
  const volume = volumeInLiters(row?.VOLUME, row?.VOLUME_UNIT);
  const btlTare = positive(row?.BOU_G) && positive(row?.BTLTARE_G) ? row.BTLTARE_G / 1000 : null;
  const casePack = positive(row?.CASETARE_G_BTL) ? row.CASETARE_G_BTL / 1000 : null;
  const cases = unitCase && unitPal ? unitPal / unitCase : null;
  const support = positive(row?.PALSUP_KG) ?? Number(prm.PALLET_WEIGHT);
  const supportHeight = positive(row?.PALSUP_HGT) ?? Number(prm.PALLET_HEIGHT);

  const BTLWGT = btlTare != null && volume != null ? btlTare + volume * prm.WINE_DENSITY : null;
  const CASEWGT = BTLWGT != null && casePack != null && unitCase ? unitCase * (BTLWGT + casePack) : null;
  const PALWGT = CASEWGT != null && cases ? support + cases * CASEWGT : null;
  const PALHGT = caseHeight && layers ? supportHeight + layers * caseHeight : null;

  const kg = (v) => `${fr(v, 3)} kg`;
  const missing = (what) => `Non calculable : donnée manquante dans Sage X3 (${what}).`;
  return {
    BTLWGT,
    CASEWGT,
    PALWGT,
    PALHGT,
    DETAIL: {
      "LOG.BTLWGT":
        BTLWGT != null
          ? `${kg(btlTare)} (bouteille habillée vide) + ${fr(volume, 3)} L × ${fr(prm.WINE_DENSITY, 3)} kg/L`
          : missing(btlTare == null ? "poids de la bouteille vide" : "contenance"),
      "LOG.CASEWGT":
        CASEWGT != null
          ? `${fr(unitCase, 0)} × (${kg(BTLWGT)} + ${kg(casePack)} d'emballage carton)`
          : BTLWGT == null
            ? "Non calculable : poids de la bouteille pleine inconnu."
            : missing(casePack == null ? "poids du carton vide" : "nombre de bouteilles par carton"),
      "LOG.PALWGT":
        PALWGT != null
          ? `${fr(support, 1)} kg (support) + ${fr(cases, 1)} cartons × ${kg(CASEWGT)}`
          : CASEWGT == null
            ? "Non calculable : poids du carton plein inconnu."
            : missing("nombre de bouteilles par palette"),
      "LOG.PALHGT":
        PALHGT != null
          ? `${fr(supportHeight, 1)} cm (support) + ${fr(layers, 0)} couches × ${fr(caseHeight, 1)} cm`
          : missing(layers ? "hauteur du carton" : "nombre de couches"),
    },
  };
}

/** Balises calculées par Vinidoc (et non reprises telles quelles de Sage X3). */
export const LOGISTICS_CALCULATED_TAGS = ["LOG.BTLWGT", "LOG.CASEWGT", "LOG.PALWGT", "LOG.PALHGT"];

/**
 * Valeurs des balises logistiques ({{LOG.*}}) d'un article PFI.
 * Dimensions en cm sans unité (l'unité figure dans l'en-tête du modèle) :
 * bouteille « diamètre x hauteur », carton « largeur x longueur x hauteur ».
 * Cartons par palette = bouteilles par palette / bouteilles par carton.
 * Poids et hauteur palette : cf. computeLogistics (`params` : table PARAMS).
 */
export function logisticsText(row, params = {}) {
  if (!row) return {};
  const unitCase = positive(row.UNITCASE);
  const unitPal = positive(row.UNITPAL);
  const btl = [row.BTL_LONGUEUR, row.BTL_LARGEUR, row.BTL_HAUTEUR]
    .map(positive)
    .filter((v) => v != null)
    .sort((a, b) => a - b);
  const calc = computeLogistics(row, params);
  return {
    "LOG.BTLDIM": dims(...btl),
    "LOG.BTLWGT": withUnit(calc.BTLWGT, "kg", 2),
    "LOG.CASEDIM": dims(row.CASE_LARGEUR, row.CASE_LONGUEUR, row.CASE_HAUTEUR),
    "LOG.CASEPAL":
      unitCase && unitPal ? fr(unitPal / unitCase, unitPal % unitCase ? 1 : 0) : "",
    "LOG.CASEWGT": withUnit(calc.CASEWGT, "kg", 2),
    "LOG.EANBTL": row.EANBTL?.trim() ?? "",
    "LOG.EANCASE": row.EANCASE?.trim() ?? "",
    "LOG.LVLPAL": integer(row.LVLPAL),
    "LOG.PALHGT": withUnit(calc.PALHGT, "cm"),
    "LOG.PALWGT": withUnit(calc.PALWGT, "kg"),
    "LOG.UNITCASE": integer(unitCase),
    "LOG.UNITPAL": integer(unitPal),
  };
}

/**
 * Fiches des codes vrac d'un article, celles de son millésime d'abord (ordre
 * d'origine conservé sinon) : la première est celle utilisée à la génération.
 */
export function sortArticleSheets(sheets = [], MILLESIME = null) {
  const rank = (s) => (MILLESIME != null && s.MILLESIME === MILLESIME ? 0 : 1);
  return [...sheets].sort((a, b) => rank(a) - rank(b));
}

/**
 * Statut de la fiche utilisée pour un article (cf. sortArticleSheets), ou
 * null sans fiche. VALIDATED = validée par le marketing (génération depuis
 * la dernière version validée).
 */
export function articleSheetStatus(article, sheets = []) {
  const own = sheets.filter((s) => article.CODVRACS.includes(s.CODVRAC));
  const [sheet] = sortArticleSheets(own, article.MILLESIME);
  if (!sheet) return null;
  return sheet.STATUS;
}

/**
 * Balises logistiques pour l'affichage : libellé, valeur, et pour les
 * valeurs calculées par Vinidoc le détail du calcul (DETAIL).
 */
export function logisticsFields(row, params = {}) {
  const text = logisticsText(row, params);
  const { DETAIL } = computeLogistics(row, params);
  return TEXT_FIELDS.filter((f) => f.TAG.startsWith("LOG.")).map((f) => {
    const CALCULATED = LOGISTICS_CALCULATED_TAGS.includes(f.TAG);
    return {
      TAG: f.TAG,
      LABEL: f.LABEL.replace(/ \(.*\)$/, ""),
      VALUE: text[f.TAG] ?? "",
      CALCULATED,
      DETAIL: CALCULATED ? DETAIL[f.TAG] : null,
    };
  });
}

/** Longueur "visible" (points de code, \r\n compté pour 1). */
export const textLength = (s) =>
  [...String(s ?? "").replace(/\r\n?/g, "\n")].length;

/**
 * Contrôle des données de fusion face aux balises texte d'un modèle.
 * Les champs libres ({{FREE.*}}) ne dépendent pas de la fiche : ignorés sauf
 * à la génération (withFree), où leur saisie est connue.
 * @param {Record<string,string>} text   buildMergeData().text
 * @param {Array<{TAGTYP,TAGNAM,MAXLEN,REQUIRED,ISKNOWN}>} tags
 * @param {{ withFree?: boolean }} [options]
 */
export function checkAgainstTemplate(text, tags = [], { withFree = false } = {}) {
  const TAGS = tags
    .filter((t) => t.TAGTYP === "TEXT" && (withFree || !isFreeTag(t.TAGNAM)))
    .map((t) => {
      const LENGTH = textLength(text[t.TAGNAM]);
      const MAXLEN = t.MAXLEN ?? null;
      let ISSUE = null;
      // ISKNOWN figé à l'import : un modèle importé avant les champs libres
      // les a enregistrés comme inconnus.
      if (!t.ISKNOWN && !isFreeTag(t.TAGNAM)) ISSUE = "UNKNOWN_TAG";
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
