import { describe, it, expect } from "vitest";
import {
  sheetCreateSchema,
  sheetUpdateSchema,
  translationUpsertSchema,
  rejectSchema,
  templateTagsSchema,
  generateSchema,
  sheetListQuery,
  checkSchema,
} from "../../../../modules/vinidoc/validators.js";

const ROWVER = "0x00000000000007D1";

const base = {
  CODVRAC: " vhl09393 ",
  MILLESIME: "2025",
  APPELL: "CDR",
  COLCOD: "blanc",
  DESCVRAC: "STANDARD",
  INTARO: 3,
  INTBOU: "1",
  ECHFRU: 3,
  TEMPMIN: 8,
  TEMPMAX: 10,
};

describe("modules/vinidoc/validators :: fiches", () => {
  it("accepte la fiche du cahier des charges et normalise", () => {
    const r = sheetCreateSchema.safeParse({
      ...base,
      TRANSLATION: { DEGUST: "Robe jaune pâle", GARDE: "2 ans", LIBELLE: "" },
    });
    expect(r.success).toBe(true);
    expect(r.data.CODVRAC).toBe("VHL09393");
    expect(r.data.COLCOD).toBe("BLANC");
    expect(r.data.MILLESIME).toBe(2025);
    expect(r.data.INTBOU).toBe(1);
    expect(r.data.GRAPES).toBeUndefined(); // ancien champ ignoré
    expect(r.data.TRANSLATION.LIBELLE).toBeNull(); // "" → effacement
  });

  it("millésime vide = non millésimé", () => {
    const r = sheetCreateSchema.safeParse({ ...base, MILLESIME: "" });
    expect(r.success).toBe(true);
    expect(r.data.MILLESIME).toBeNull();
  });

  it("rejette une échelle hors 1-5", () => {
    expect(sheetCreateSchema.safeParse({ ...base, INTARO: 6 }).success).toBe(false);
    expect(sheetCreateSchema.safeParse({ ...base, ECHFRU: 0 }).success).toBe(false);
  });

  it("rejette une plage de température inversée", () => {
    const r = sheetCreateSchema.safeParse({ ...base, TEMPMIN: 12, TEMPMAX: 8 });
    expect(r.success).toBe(false);
    expect(r.error.issues[0].path).toEqual(["TEMPMAX"]);
  });

  it("cépages : texte libre traduisible, 1000 caractères max", () => {
    const ok = sheetCreateSchema.safeParse({ ...base, TRANSLATION: { CEPAGES: "  Grenache 60 %, Syrah 40 %  " } });
    expect(ok.success).toBe(true);
    expect(ok.data.TRANSLATION.CEPAGES).toBe("Grenache 60 %, Syrah 40 %");
    expect(sheetCreateSchema.safeParse({ ...base, TRANSLATION: { CEPAGES: "x".repeat(1001) } }).success).toBe(false);
  });

  it("rejette un code vrac avec caractères spéciaux", () => {
    expect(sheetCreateSchema.safeParse({ ...base, CODVRAC: "VHL'; DROP" }).success).toBe(false);
  });

  it("la mise à jour exige un ROWVER valide", () => {
    expect(sheetUpdateSchema.safeParse(base).success).toBe(false);
    expect(sheetUpdateSchema.safeParse({ ...base, ROWVER: "abc" }).success).toBe(false);
    expect(sheetUpdateSchema.safeParse({ ...base, ROWVER }).success).toBe(true);
  });

  it("traduction : longueurs max respectées", () => {
    expect(translationUpsertSchema.safeParse({ ROWVER, GARDE: "x".repeat(101) }).success).toBe(false);
    expect(translationUpsertSchema.safeParse({ ROWVER, DEGUST: "x".repeat(4000) }).success).toBe(true);
  });

  it("refus : motif obligatoire", () => {
    expect(rejectSchema.safeParse({ ROWVER }).success).toBe(false);
    expect(rejectSchema.safeParse({ ROWVER, COMMENT: "  " }).success).toBe(false);
    expect(rejectSchema.safeParse({ ROWVER, COMMENT: "Accords à revoir" }).success).toBe(true);
  });

  it("liste : valeurs par défaut de pagination et filtre booléen", () => {
    const r = sheetListQuery.parse({ GENERABLE: "true", STATUS: "" });
    expect(r).toMatchObject({ PAGE: 1, PAGESIZE: 50, GENERABLE: true });
    expect(r.STATUS).toBeUndefined();
    expect(sheetListQuery.safeParse({ PAGESIZE: 1000 }).success).toBe(false);
  });

  it("contrôle : source par défaut = données en cours", () => {
    expect(checkSchema.parse({ LNGCOD: "FR" })).toMatchObject({ LNGCOD: "fr", SOURCE: "CURRENT" });
  });
});

describe("modules/vinidoc/validators :: modèles & génération", () => {
  it("balises : MAXLEN optionnel, REQUIRED booléen (multipart)", () => {
    const r = templateTagsSchema.parse({
      TAGS: [
        { TAGNAM: "degustation", MAXLEN: "350", REQUIRED: "true" },
        { TAGTYP: "BADGE", TAGNAM: "COULEUR_ROUGE", MAXLEN: "" },
      ],
    });
    expect(r.TAGS[0]).toEqual({ TAGTYP: "TEXT", TAGNAM: "DEGUSTATION", MAXLEN: 350, REQUIRED: true });
    expect(r.TAGS[1].MAXLEN).toBeNull();
  });

  it("génération : format pdf par défaut, langue normalisée", () => {
    const r = generateSchema.parse({ SHTID: "1", TPLID: "2", COD_ARTICLE: "pfi01140", LNGCOD: "EN" });
    expect(r).toEqual({ SHTID: 1, TPLID: 2, COD_ARTICLE: "PFI01140", LNGCOD: "en", FORMAT: "pdf", HVE: false, BIO: false, PACKAGING: "BOUTEILLE", FREE: {}, LOGISTICS: {} });
    expect(generateSchema.safeParse({ SHTID: 1, TPLID: 2, COD_ARTICLE: "PFI01140", LNGCOD: "en", FORMAT: "docx" }).success).toBe(false);
  });

  it("génération : article PFI obligatoire (données logistiques)", () => {
    for (const COD_ARTICLE of [undefined, "", "  "]) {
      const r = generateSchema.safeParse({ SHTID: 1, TPLID: 2, LNGCOD: "fr", COD_ARTICLE });
      expect(r.success).toBe(false);
      expect(r.error.issues[0].path).toEqual(["COD_ARTICLE"]);
    }
  });

  it("génération : options logos HVE / BIO (multipart en chaînes)", () => {
    const r = generateSchema.parse({ SHTID: "1", TPLID: "2", COD_ARTICLE: "pfi01140", LNGCOD: "fr", HVE: "true", BIO: "0" });
    expect(r.HVE).toBe(true);
    expect(r.BIO).toBe(false);
    expect(generateSchema.safeParse({ SHTID: 1, TPLID: 2, COD_ARTICLE: "PFI01140", LNGCOD: "fr", HVE: "oui" }).success).toBe(false);
  });

  it("génération : conditionnement de la photo (défaut BOUTEILLE)", () => {
    const parse = (PACKAGING) => generateSchema.parse({ SHTID: 1, TPLID: 2, COD_ARTICLE: "PFI01140", LNGCOD: "fr", PACKAGING });
    expect(parse(" bib ").PACKAGING).toBe("BIB");
    expect(parse("CANETTE").PACKAGING).toBe("CANETTE");
    expect(parse("").PACKAGING).toBe("BOUTEILLE");
    expect(generateSchema.safeParse({ SHTID: 1, TPLID: 2, COD_ARTICLE: "PFI01140", LNGCOD: "fr", PACKAGING: "MAGNUM" }).success).toBe(false);
  });

  it("génération : champs libres (objet ou JSON multipart, clés en majuscules)", () => {
    const parse = (FREE) => generateSchema.safeParse({ SHTID: 1, TPLID: 2, COD_ARTICLE: "PFI01140", LNGCOD: "fr", FREE });
    expect(parse(undefined).data.FREE).toEqual({});
    expect(parse("").data.FREE).toEqual({});
    expect(parse({ "free.promo": " Promo\r\nété " }).data.FREE).toEqual({ "FREE.PROMO": "Promo\nété" });
    expect(parse({ FREE_1: "x" }).success).toBe(false);
    expect(parse('{"FREE.PRIX":"x"}').data.FREE).toEqual({ "FREE.PRIX": "x" });
    expect(parse({ DEGUST: "x" }).success).toBe(false);
    expect(parse("{pas du json").success).toBe(false);
  });

  it("génération : corrections des données logistiques (balises LOG.* connues)", () => {
    const parse = (LOGISTICS) =>
      generateSchema.safeParse({ SHTID: 1, TPLID: 2, COD_ARTICLE: "PFI01140", LNGCOD: "fr", LOGISTICS });
    expect(parse(undefined).data.LOGISTICS).toEqual({});
    expect(parse({ "log.btlwgt": " 1,35 kg " }).data.LOGISTICS).toEqual({ "LOG.BTLWGT": "1,35 kg" });
    expect(parse('{"LOG.EANBTL":"3 123"}').data.LOGISTICS).toEqual({ "LOG.EANBTL": "3 123" });
    expect(parse({ "LOG.INCONNU": "x" }).success).toBe(false);
    expect(parse({ DEGUST: "x" }).success).toBe(false);
    expect(parse({ "LOG.BTLWGT": "x".repeat(101) }).success).toBe(false);
  });

  it("génération et contrôle : fiche ajustée localement (SHEET, TRANSLATION)", () => {
    const base = { SHTID: 1, TPLID: 2, COD_ARTICLE: "PFI01140", LNGCOD: "fr" };
    const SHEET = { CODVRAC: "vhl1", APPELL: "CDR", COLCOD: "rouge", INTARO: 4, TEMPMIN: 14, TEMPMAX: 16 };
    const r = generateSchema.parse({ ...base, SHEET: JSON.stringify(SHEET), TRANSLATION: { DEGUST: " Nez  fruité " } });
    expect(r.SHEET).toMatchObject({ CODVRAC: "VHL1", COLCOD: "ROUGE", INTARO: 4 });
    expect(r.TRANSLATION).toEqual({ DEGUST: "Nez fruité" });
    expect(generateSchema.parse(base).SHEET).toBeUndefined();
    expect(generateSchema.safeParse({ ...base, SHEET: { ...SHEET, TEMPMIN: 18 } }).success).toBe(false);
    expect(generateSchema.safeParse({ ...base, SHEET: { ...SHEET, APPELL: "" } }).success).toBe(false);
    expect(checkSchema.parse({ LNGCOD: "fr", TRANSLATION: '{"VINIF":"x"}' }).TRANSLATION).toEqual({ VINIF: "x" });
  });
});

describe("nettoyage des textes œnologiques", () => {
  it("traductions : retours à la ligne et espaces en trop supprimés, vide → null", () => {
    const r = translationUpsertSchema.parse({
      ROWVER,
      DEGUST: "  Robe  rubis.\n\nNez  de fruits rouges . ",
      GARDE: " \n ",
    });
    expect(r.DEGUST).toBe("Robe rubis. Nez de fruits rouges.");
    expect(r.GARDE).toBeNull();
  });

  it("appellation nettoyée, toujours obligatoire", () => {
    expect(sheetCreateSchema.parse({ ...base, APPELL: " Côtes  du\nRhône " }).APPELL).toBe(
      "Côtes du Rhône",
    );
    expect(sheetCreateSchema.safeParse({ ...base, APPELL: " \n\u200B " }).success).toBe(false);
  });

  it("longueur max contrôlée après nettoyage", () => {
    const r = translationUpsertSchema.safeParse({ ROWVER, GARDE: `${"a".repeat(100)}\n\n   ` });
    expect(r.success).toBe(true);
  });
});
