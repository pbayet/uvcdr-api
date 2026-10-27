import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  assertVinidocApp,
  canEditSheets,
  canValidateSheets,
  canManageTemplates,
  isKnownTag,
  tagsFromInventory,
  maxLenWarnings,
  missingCatalogTags,
  TEXT_FIELDS,
  IMAGE_FIELDS,
  certificationBadges,
  formatSheet,
  buildSnapshot,
  buildMergeData,
  checkAgainstTemplate,
  formatGrapes,
  upgradeSnapshot,
  formatTemperature,
  loremText,
  sortArticleSheets,
  articleSheetStatus,
  cleanText,
  cleanSheetTexts,
  articleFromRow,
  logisticsText,
  logisticsFields,
  LOGISTICS_TEST_TAGS,
  previewMergeData,
  PREVIEW_DEFAULT_LENGTH,
  textLength,
  rowverToHex,
  hexToRowver,
  outputFileName,
} from "../../../../modules/vinidoc/utils.js";

const req = ({
  service = "",
  permission = "USER",
  application = "VINDOC",
  isCave = false,
} = {}) => ({
  payload: {
    application,
    permission,
    isCave,
    data: { email: "x@y.fr", service: { name: service } },
  },
});

/** Fiche du cahier des charges (VHL09393). */
const SHEET = {
  SHTID: 1,
  CODVRAC: "VHL09393",
  MILLESIME: 2025,
  APPELL: "CDR",
  COLCOD: "BLANC",
  DESCVRAC: "STANDARD",
  INTARO: 3,
  INTBOU: 1,
  ECHFRU: 3,
  TEMPMIN: 8,
  TEMPMAX: 10,
  TRANSLATIONS: {
    fr: {
      LIBELLE: null,
      TERROIR: "Climat Méditerranéen.\r\nDeux types de sol.",
      VINIF: "Élevage en cuve inox.",
      DEGUST: "Robe jaune pâle brillante.",
      GARDE: "2 ans",
      CEPAGES: null,
      ACCORDS: "Viande blanche, dorade à la plancha, salade paysanne",
      ACCEXPL: "Plats légers.",
    },
  },
};

describe("modules/vinidoc/utils :: droits", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.VINIDOC_EDITOR_SERVICES = "Œnologie,Qualité";
    process.env.VINIDOC_VALIDATOR_SERVICES = "MARKETING";
    process.env.VINIDOC_TEMPLATE_SERVICES = "";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("refuse un token émis pour une autre application (ex. HOME)", () => {
    expect(() => assertVinidocApp(req({ application: "HOME" }))).toThrow(
      "ACCESS_DENIED_WO_LOGOUT",
    );
    expect(() => assertVinidocApp(req())).not.toThrow();
  });

  it("refuse un token de cave", () => {
    expect(() => assertVinidocApp(req({ isCave: true }))).toThrow(
      "ACCESS_DENIED_WO_LOGOUT",
    );
  });

  it("compare les services sans tenir compte des accents ni de la casse", () => {
    expect(canEditSheets(req({ service: "oenologie" }))).toBe(true);
    expect(canEditSheets(req({ service: "QUALITE" }))).toBe(true);
    expect(canEditSheets(req({ service: "Marketing" }))).toBe(false);
  });

  it("le marketing valide, l'œnologie non", () => {
    expect(canValidateSheets(req({ service: "Marketing" }))).toBe(true);
    expect(canValidateSheets(req({ service: "Œnologie" }))).toBe(false);
  });

  it("les profils MODIFY_PERMS ont tous les droits", () => {
    const admin = req({ permission: "ADMIN", service: "Informatique" });
    expect(canEditSheets(admin)).toBe(true);
    expect(canValidateSheets(admin)).toBe(true);
    expect(canManageTemplates(admin)).toBe(true);
  });

  it("aucun service n'administre les modèles par défaut", () => {
    expect(canManageTemplates(req({ service: "Marketing" }))).toBe(false);
  });
});

describe("modules/vinidoc/utils :: catalogue des balises", () => {
  it("reconnaît les balises du catalogue", () => {
    expect(isKnownTag("TEXT", "DEGUST")).toBe(true);
    expect(isKnownTag("TEXT", "LOG.EANBTL")).toBe(true);
    expect(isKnownTag("TEXT", "DEGUSTATION")).toBe(false);
    expect(isKnownTag("TEXT", "CUVEE")).toBe(false);
    expect(isKnownTag("IMAGE", "BOTTLEPHOTO")).toBe(true);
    expect(isKnownTag("BADGE", "COULEUR_ROUGE")).toBe(true);
    expect(isKnownTag("BADGE", "INTENSITE_AROMATIQUE_3")).toBe(true);
    expect(isKnownTag("BADGE", "ECHELLE_FRUIT_EQ_5")).toBe(true);
    expect(isKnownTag("BADGE", "ECHELLE_FRUIT_6")).toBe(false);
    expect(isKnownTag("BADGE", "INTENSITE_AROMATIQUE_EQ_0")).toBe(true);
    expect(isKnownTag("BADGE", "INTENSITE_AROMATIQUE_0")).toBe(false);
  });

  it("tagsFromInventory marque les balises inconnues", () => {
    const tags = tagsFromInventory({
      TEXT: ["TERROIR", "FOO"],
      IMAGE: [],
      BADGE: ["COULEUR_VERT_9"],
    });
    expect(tags).toEqual([
      { TAGTYP: "TEXT", TAGNAM: "TERROIR", ISKNOWN: true, MAXLEN: null },
      { TAGTYP: "TEXT", TAGNAM: "FOO", ISKNOWN: false, MAXLEN: null },
      { TAGTYP: "BADGE", TAGNAM: "COULEUR_VERT_9", ISKNOWN: false, MAXLEN: null },
    ]);
  });

  it("tagsFromInventory reprend la longueur saisie dans la balise ({{TAG-250}})", () => {
    const inventory = {
      TEXT: ["APPELLATION", "DEGUST", "TERROIR", "VINIF"],
      IMAGE: [],
      BADGE: [],
      LENGTHS: { APPELLATION: [250], DEGUST: [300, 450], TERROIR: [0], VINIF: [0, 99999, 80] },
    };
    expect(tagsFromInventory(inventory).map((t) => [t.TAGNAM, t.MAXLEN])).toEqual([
      ["APPELLATION", 250],
      ["DEGUST", 300], // la plus stricte
      ["TERROIR", null], // 0 invalide → non précisée
      ["VINIF", 80],
    ]);
    const warnings = maxLenWarnings(inventory);
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toMatch(/DEGUST.*300, 450.*\(300\)/);
    expect(warnings.join("\n")).toMatch(/TERROIR.*longueur 0 ignorée/);
    expect(warnings.join("\n")).toMatch(/VINIF.*longueur 0, 99999 ignorée/);
    expect(maxLenWarnings({ LENGTHS: { APPELLATION: [250] } })).toEqual([]);
  });

  it("logos HVE / BIO : blocs conditionnels (badge:), plus des images", () => {
    expect(isKnownTag("BADGE", "HVE")).toBe(true);
    expect(isKnownTag("BADGE", "BIO")).toBe(true);
    expect(isKnownTag("IMAGE", "HVE")).toBe(false);
    expect(isKnownTag("IMAGE", "BIO")).toBe(false);
    expect(isKnownTag("BADGE", "HVE_3")).toBe(false);
  });

  it("certificationBadges : masqué par défaut, affiché seulement si true", () => {
    expect(certificationBadges()).toEqual({ HVE: false, BIO: false, BIOHVE: false });
    expect(certificationBadges({ HVE: true, BIO: "true" })).toEqual({ HVE: true, BIO: false, BIOHVE: false });
  });

  it("certificationBadges : HVE + BIO → logo combiné BIOHVE si le modèle le contient", () => {
    const tags = [{ TAGTYP: "BADGE", TAGNAM: "BIOHVE" }];
    expect(certificationBadges({ HVE: true, BIO: true }, tags)).toEqual({ HVE: false, BIO: false, BIOHVE: true });
    expect(certificationBadges({ HVE: true, BIO: false }, tags)).toEqual({ HVE: true, BIO: false, BIOHVE: false });
    expect(certificationBadges({ HVE: false, BIO: true }, tags)).toEqual({ HVE: false, BIO: true, BIOHVE: false });
    // Modèle sans badge:BIOHVE : les deux logos séparés.
    expect(certificationBadges({ HVE: true, BIO: true }, [])).toEqual({ HVE: true, BIO: true, BIOHVE: false });
    expect(isKnownTag("BADGE", "BIOHVE")).toBe(true);
  });
});

describe("modules/vinidoc/utils :: missingCatalogTags", () => {
  it("liste les balises texte alimentées et images absentes du modèle", () => {
    const missing = missingCatalogTags([
      { TAGTYP: "TEXT", TAGNAM: "TERROIR" },
      { TAGTYP: "TEXT", TAGNAM: "FOO" },
    ]);
    const names = missing.map((t) => t.TAGNAM);
    expect(names).toContain("DEGUST");
    expect(names).toContain("BOTTLEPHOTO");
    expect(names).not.toContain("TERROIR");
    expect(names.some((n) => n.startsWith("LOG."))).toBe(false);
  });

  it("ne renvoie rien si toutes les balises sont présentes", () => {
    const all = [
      ...TEXT_FIELDS.filter((f) => f.AVAILABLE).map((f) => ({
        TAGTYP: "TEXT",
        TAGNAM: f.TAG,
      })),
      ...IMAGE_FIELDS.map((f) => ({ TAGTYP: "IMAGE", TAGNAM: f.TAG })),
    ];
    expect(missingCatalogTags(all)).toEqual([]);
  });
});

describe("modules/vinidoc/utils :: mise en forme", () => {
  it("formatGrapes affiche les pourcentages s'ils existent", () => {
    expect(
      formatGrapes(
        [
          { CEPAGE: "Grenache", PCT: 60 },
          { CEPAGE: "Syrah", PCT: null },
        ],
        "fr",
      ),
    ).toBe("Grenache 60 %, Syrah");
    expect(formatGrapes([], "fr")).toBe("");
  });

  it("upgradeSnapshot convertit l'ancienne liste GRAPES en CEPAGES par langue", () => {
    const legacy = {
      ...SHEET,
      GRAPES: [
        { CEPAGE: "Grenache", PCT: 60.5 },
        { CEPAGE: "Syrah", PCT: null },
      ],
      TRANSLATIONS: {
        fr: { DEGUST: "x" },
        en: { DEGUST: "y", CEPAGES: "Saisi" },
      },
    };
    const snap = upgradeSnapshot(legacy);
    expect(snap.GRAPES).toBeUndefined();
    expect(snap.TRANSLATIONS.fr.CEPAGES).toBe("Grenache 60,5 %, Syrah");
    expect(snap.TRANSLATIONS.en.CEPAGES).toBe("Saisi"); // jamais écrasé
    expect(
      upgradeSnapshot({ ...legacy, GRAPES: [] }).TRANSLATIONS.fr.CEPAGES,
    ).toBeNull();
    expect(upgradeSnapshot(SHEET)).toBe(SHEET); // instantané récent : inchangé
  });

  it("formatTemperature gère plage, valeur unique et absence", () => {
    expect(formatTemperature(8, 10, "fr")).toBe("8-10°C");
    expect(formatTemperature(16, 16, "fr")).toBe("16°C");
    expect(formatTemperature(null, 12, "fr")).toBe("12°C");
    expect(formatTemperature(null, null, "fr")).toBe("");
    expect(formatTemperature(7.5, 9, "fr")).toBe("7,5-9°C");
    expect(formatTemperature(7.5, 9, "en")).toBe("7.5-9°C");
  });

  it("textLength compte les caractères Unicode et \\r\\n pour 1", () => {
    expect(textLength("œnologie")).toBe(8);
    expect(textLength("a\r\nb")).toBe(3);
    expect(textLength(null)).toBe(0);
  });

  it("rowver aller-retour hex ↔ Buffer", () => {
    const buf = Buffer.from("00000000000007d1", "hex");
    expect(rowverToHex(buf)).toBe("0x00000000000007D1");
    expect(hexToRowver("0x00000000000007d1").equals(buf)).toBe(true);
    expect(rowverToHex(null)).toBeNull();
  });

  it("formatSheet regroupe les traductions par langue (cépages en texte)", () => {
    const sheet = formatSheet(
      {
        SHTID: 1,
        CODVRAC: "A",
        COLCOD: "ROUGE",
        TEMPMIN: "16.0",
        STATUS: "DRAFT",
        LASTVER: 0,
        ROWVER: Buffer.alloc(8),
      },
      [
        {
          LNGCOD: "fr",
          DEGUST: "Rouge",
          CEPAGES: "Grenache 60 %, Syrah 40 %",
          MODUSR: "u",
          MODDAT: null,
        },
      ],
    );
    expect(sheet.GRAPES).toBeUndefined();
    expect(sheet.TRANSLATIONS.fr.CEPAGES).toBe("Grenache 60 %, Syrah 40 %");
    expect(sheet.TEMPMIN).toBe(16);
    expect(sheet.TRANSLATIONS.fr.DEGUST).toBe("Rouge");
    expect(sheet.ROWVER).toBe("0x0000000000000000");
  });

  it("buildSnapshot retire les métadonnées de workflow", () => {
    const snap = buildSnapshot({
      ...SHEET,
      STATUS: "SUBMITTED",
      LASTVER: 0,
      ROWVER: "0x01",
      TRANSLATIONS: {
        fr: { ...SHEET.TRANSLATIONS.fr, MODUSR: "u", MODDAT: "d" },
      },
    });
    expect(snap.STATUS).toBeUndefined();
    expect(snap.ROWVER).toBeUndefined();
    expect(snap.TRANSLATIONS.fr.MODUSR).toBeUndefined();
    expect(snap.TRANSLATIONS.fr.DEGUST).toBe("Robe jaune pâle brillante.");
  });

  it("outputFileName produit un nom sûr", () => {
    expect(outputFileName(SHEET, "en", "pdf")).toBe("VHL09393_2025_EN.pdf");
    expect(
      outputFileName({ CODVRAC: "A B/C", MILLESIME: null }, "fr", "pptx"),
    ).toBe("A-B-C_FR.pptx");
  });
});

describe("modules/vinidoc/utils :: buildMergeData", () => {
  const color = { LABEL: "Blanc", BOUMIN: "Sec", BOUMAX: "Moelleux" };

  it("construit les textes de la langue demandée (balises du modèle POC)", () => {
    const { text } = buildMergeData(SHEET, "fr", color);
    expect(text["TEMP"]).toBe("8-10°C");
    expect(text["DEGUST"]).toBe("Robe jaune pâle brillante.");
    expect(text["TERROIR"]).toBe("Climat Méditerranéen.\nDeux types de sol.");
    expect(text["VINIF"]).toBe("Élevage en cuve inox.");
    // Pas d'intitulé commercial : « appellation - couleur »
    expect(text["APPELLATION"]).toBe("CDR - BLANC");
  });

  it("l'intitulé commercial traduit est prioritaire", () => {
    const sheet = {
      ...SHEET,
      TRANSLATIONS: {
        fr: {
          ...SHEET.TRANSLATIONS.fr,
          LIBELLE: "Côtes du Rhône Prestige Blanc",
        },
      },
    };
    expect(buildMergeData(sheet, "fr", color).text["APPELLATION"]).toBe(
      "Côtes du Rhône Prestige Blanc",
    );
  });

  it("toutes les balises du catalogue sont présentes, LOG.* vides", () => {
    const { text } = buildMergeData(SHEET, "fr", color);
    expect(Object.keys(text)).toHaveLength(17);
    expect(text["LOG.EANBTL"]).toBe("");
    expect(text["LOG.UNITPAL"]).toBe("");
  });

  it("textes traduits vides si la langue est absente", () => {
    const { text } = buildMergeData(SHEET, "de", {});
    expect(text["DEGUST"]).toBe("");
    expect(text["TEMP"]).toBe("8-10°C");
    expect(text["APPELLATION"]).toBe("CDR - BLANC"); // repli sur le code couleur
  });

  it("badges : couleur et jauges", () => {
    const { badges } = buildMergeData(SHEET, "fr", color);
    expect(badges.COULEUR_BLANC).toBe(true);
    expect(badges.COULEUR_ROUGE).toBeUndefined();
    expect(badges.INTENSITE_AROMATIQUE_3).toBe(true);
    expect(badges.INTENSITE_AROMATIQUE_4).toBe(false);
    expect(badges.INTENSITE_AROMATIQUE_EQ_3).toBe(true);
    expect(badges.INTENSITE_AROMATIQUE_EQ_2).toBe(false);
    expect(badges.INTENSITE_BOUCHE_1).toBe(true);
    expect(badges.INTENSITE_BOUCHE_2).toBe(false);
  });
});

describe("modules/vinidoc/utils :: checkAgainstTemplate", () => {
  const tags = [
    {
      TAGTYP: "TEXT",
      TAGNAM: "DEGUST",
      MAXLEN: 10,
      REQUIRED: false,
      ISKNOWN: true,
    },
    {
      TAGTYP: "TEXT",
      TAGNAM: "LOG.EANBTL",
      MAXLEN: null,
      REQUIRED: true,
      ISKNOWN: true,
    },
    {
      TAGTYP: "TEXT",
      TAGNAM: "TEMP",
      MAXLEN: 20,
      REQUIRED: true,
      ISKNOWN: true,
    },
    {
      TAGTYP: "TEXT",
      TAGNAM: "FOO",
      MAXLEN: null,
      REQUIRED: false,
      ISKNOWN: false,
    },
    {
      TAGTYP: "BADGE",
      TAGNAM: "COULEUR_BLANC",
      MAXLEN: null,
      REQUIRED: false,
      ISKNOWN: true,
    },
  ];

  it("signale les dépassements et les balises obligatoires vides", () => {
    const { text } = buildMergeData(SHEET, "fr");
    const report = checkAgainstTemplate(text, tags);

    expect(report.OK).toBe(false);
    expect(report.TAGS).toHaveLength(4); // BADGE ignoré
    expect(report.ERRORS.map((e) => [e.TAGNAM, e.ISSUE])).toEqual([
      ["DEGUST", "TOO_LONG"],
      ["LOG.EANBTL", "MISSING"],
    ]);
    expect(report.TAGS.find((t) => t.TAGNAM === "FOO").ISSUE).toBe(
      "UNKNOWN_TAG",
    );
    expect(report.TAGS.find((t) => t.TAGNAM === "TEMP").ISSUE).toBeNull();
  });

  it("OK quand toutes les contraintes sont respectées", () => {
    const report = checkAgainstTemplate({ TEMP: "8-10°C" }, [tags[2]]);
    expect(report).toMatchObject({ OK: true, ERRORS: [] });
  });
});

describe("loremText", () => {
  it("ne dépasse jamais la longueur demandée et finit proprement", () => {
    for (const n of [1, 12, 80, 250, 1000]) {
      const t = loremText(n);
      expect(t.length).toBeLessThanOrEqual(n);
      expect(t.length).toBeGreaterThan(n * 0.5);
      expect(t).not.toMatch(/\s$/);
    }
  });

  it("vide pour une longueur nulle ou absente", () => {
    expect(loremText(0)).toBe("");
    expect(loremText(null)).toBe("");
  });
});

describe("previewMergeData", () => {
  const tags = [
    { TAGTYP: "TEXT", TAGNAM: "DEGUST", MAXLEN: 250 },
    { TAGTYP: "TEXT", TAGNAM: "TEMP", MAXLEN: null },
    { TAGTYP: "BADGE", TAGNAM: "BIOHVE" },
  ];

  it("remplit chaque balise texte à sa longueur max (défaut sinon)", () => {
    const { text } = previewMergeData(tags);
    expect(Object.keys(text)).toEqual(["DEGUST", "TEMP"]);
    expect(text.DEGUST.length).toBeLessThanOrEqual(250);
    expect(text.DEGUST.length).toBeGreaterThan(200);
    expect(text.TEMP).toBe("8-10°C");
  });

  it("faux texte par défaut sans longueur max, sinon tronqué à la longueur max", () => {
    const { text } = previewMergeData([
      { TAGTYP: "TEXT", TAGNAM: "TERROIR", MAXLEN: null },
      { TAGTYP: "TEXT", TAGNAM: "LOG.EANBTL", MAXLEN: 5 },
    ]);
    expect(text.TERROIR.length).toBeLessThanOrEqual(PREVIEW_DEFAULT_LENGTH);
    expect(text.TERROIR.length).toBeGreaterThan(40);
    expect(text["LOG.EANBTL"]).toBe("3 123");
  });

  it("affiche couleur, échelles et logo combiné", () => {
    const { badges } = previewMergeData(tags);
    expect(badges.COULEUR_ROUGE).toBe(true);
    expect(badges.INTENSITE_BOUCHE_EQ_3).toBe(true);
    expect(badges.BIOHVE).toBe(true);
    expect(badges.HVE).toBe(false);
  });
});

describe("articles PFI", () => {
  // Ligne réelle de services.getArticle (PFI01140), valeurs de test comprises.
  const row = {
    COD_ARTICLE: "PFI01140",
    LIBELLE: "MEDC 14 RG 075 INSALV MGR 13.5 ",
    LIBELLE_COURT: "VDE CUVEE SALVARE IGP MEDITERRANEE - RGE - 75 CL",
    MILLESIME: 2014,
    STATUT: "Non renouvelé",
    CODVRACS: "VHL03217",
    EANBTL: "4985908835151",
    EANCASE: " ",
    UNITCASE: 6,
    UNITPAL: 720,
    LVLPAL: 5,
    BTLWGT: 1.25,
    BTL_LONGUEUR: 30,
    BTL_LARGEUR: 7.5,
    BTL_HAUTEUR: 0,
    CASE_LONGUEUR: 24.5,
    CASE_LARGEUR: 16,
    CASE_HAUTEUR: 30.5,
    CASEWGT: 8,
    PALHGT: 160,
    PALWGT: 900,
  };

  it("articleFromRow : libellés nettoyés, codes vrac en liste", () => {
    expect(articleFromRow(row)).toEqual({
      COD_ARTICLE: "PFI01140",
      LIBELLE: "MEDC 14 RG 075 INSALV MGR 13.5",
      LIBELLE_COURT: "VDE CUVEE SALVARE IGP MEDITERRANEE - RGE - 75 CL",
      MILLESIME: 2014,
      STATUT: "Non renouvelé",
      CODVRACS: ["VHL03217"],
    });
    expect(articleFromRow({ ...row, CODVRACS: null, MILLESIME: 0 })).toMatchObject({
      CODVRACS: [],
      MILLESIME: null,
    });
  });

  it("logisticsText : balises {{LOG.*}} au format français", () => {
    expect(logisticsText(row)).toEqual({
      "LOG.BTLDIM": "7,5 x 30",
      "LOG.BTLWGT": "1,25 kg",
      "LOG.CASEDIM": "16 x 24,5 x 30,5",
      "LOG.CASEPAL": "120",
      "LOG.CASEWGT": "8 kg",
      "LOG.EANBTL": "4985908835151",
      "LOG.EANCASE": "",
      "LOG.LVLPAL": "5",
      "LOG.PALHGT": "160 cm",
      "LOG.PALWGT": "900 kg",
      "LOG.UNITCASE": "6",
      "LOG.UNITPAL": "720",
    });
  });

  it("logisticsText : données absentes → valeurs vides", () => {
    const text = logisticsText({ COD_ARTICLE: "PFI00001" });
    expect(Object.values(text).every((v) => v === "")).toBe(true);
    expect(logisticsText(null)).toEqual({});
  });

  it("logisticsFields : libellés courts et valeurs de test signalées", () => {
    const fields = logisticsFields(row);
    expect(fields).toHaveLength(12);
    expect(fields.find((f) => f.TAG === "LOG.EANBTL")).toEqual({
      TAG: "LOG.EANBTL",
      LABEL: "EAN bouteille",
      VALUE: "4985908835151",
      TEST: false,
    });
    expect(fields.filter((f) => f.TEST).map((f) => f.TAG)).toEqual(LOGISTICS_TEST_TAGS);
  });
});

describe("cleanText", () => {
  it("ramène retours à la ligne, tabulations et espaces multiples à une espace", () => {
    expect(cleanText("  Fruits  rouges\r\n\r\nnotes\tépicées  ")).toBe(
      "Fruits rouges notes épicées",
    );
  });

  it("remplace les espaces insécables et supprime les caractères invisibles", () => {
    expect(cleanText("Belle\u00A0\u202Fbouche\u200B ronde\uFEFF\u00AD")).toBe(
      "Belle bouche ronde",
    );
  });

  it("retire les espaces avant , . ) et après ( mais garde la typographie ; : ! ?", () => {
    expect(cleanText("Rouge , rond . ( servir frais )")).toBe(
      "Rouge, rond. (servir frais)",
    );
    expect(cleanText("Accords : viande ; fromage ! Pourquoi ?")).toBe(
      "Accords : viande ; fromage ! Pourquoi ?",
    );
  });

  it("vide → null, non-chaîne inchangée, texte propre inchangé", () => {
    expect(cleanText(" \r\n\t\u200B ")).toBeNull();
    expect(cleanText(null)).toBeNull();
    expect(cleanText(42)).toBe(42);
    expect(cleanText("13,5 % vol.")).toBe("13,5 % vol.");
  });
});

describe("cleanSheetTexts", () => {
  it("nettoie champs communs et traductions, sans toucher au reste", () => {
    const out = cleanSheetTexts({
      CODVRAC: "VHL1",
      APPELL: " CDR \n",
      DESCVRAC: null,
      INTARO: 3,
      TRANSLATIONS: {
        fr: { DEGUST: "Nez\n\nfruité ", GARDE: "2 ans", MODUSR: "x" },
      },
    });
    expect(out).toEqual({
      CODVRAC: "VHL1",
      APPELL: "CDR",
      DESCVRAC: null,
      INTARO: 3,
      TRANSLATIONS: { fr: { DEGUST: "Nez fruité", GARDE: "2 ans", MODUSR: "x" } },
    });
  });
});

describe("fiche utilisée pour un article PFI", () => {
  const article = { CODVRACS: ["VHL1"], MILLESIME: 2024 };
  const sheets = [
    { SHTID: 1, CODVRAC: "VHL1", MILLESIME: 2025, STATUS: "VALIDATED", LASTVER: 2 },
    { SHTID: 2, CODVRAC: "VHL1", MILLESIME: 2024, STATUS: "SUBMITTED", LASTVER: 0 },
    { SHTID: 3, CODVRAC: "VHL9", MILLESIME: 2024, STATUS: "VALIDATED", LASTVER: 1 },
  ];

  it("sortArticleSheets : même millésime d'abord, ordre conservé sinon", () => {
    expect(sortArticleSheets(sheets, 2024).map((s) => s.SHTID)).toEqual([2, 3, 1]);
    expect(sortArticleSheets(sheets, null).map((s) => s.SHTID)).toEqual([1, 2, 3]);
  });

  it("articleSheetStatus : statut de la fiche du millésime, parmi ses codes vrac", () => {
    expect(articleSheetStatus(article, sheets)).toBe("SUBMITTED");
    expect(articleSheetStatus({ ...article, MILLESIME: 2030 }, sheets)).toBe("VALIDATED");
    expect(articleSheetStatus({ CODVRACS: ["VHL0"], MILLESIME: null }, sheets)).toBeNull();
  });
});
