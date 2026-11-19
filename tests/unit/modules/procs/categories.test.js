import { describe, it, expect } from "vitest";
import { categoryDeleteError, checkCategoryPlacement, formatProcedure } from "../../../../modules/procs/utils.js";
import { procedureCreateSchema, procedureUpdateSchema } from "../../../../modules/procs/validators.js";

// Arborescence de test :
//   1 Informatique
//   └─ 2 Réseau
//      └─ 3 Serveur EXT
//   4 Qualité
//   └─ 5 HACCP
const LINKS = [
  { CATID: 1, PARENTID: null },
  { CATID: 2, PARENTID: 1 },
  { CATID: 3, PARENTID: 2 },
  { CATID: 4, PARENTID: null },
  { CATID: 5, PARENTID: 4 },
];

describe("procs :: arborescence des catégories (3 niveaux)", () => {
  it("accepte une nouvelle catégorie aux niveaux 1, 2 et 3", () => {
    expect(checkCategoryPlacement(LINKS, null, null)).toBeNull();
    expect(checkCategoryPlacement(LINKS, null, 1)).toBeNull();
    expect(checkCategoryPlacement(LINKS, null, 2)).toBeNull();
  });

  it("refuse un 4ᵉ niveau", () => {
    expect(checkCategoryPlacement(LINKS, null, 3)).toMatch(/3 niveaux au plus/);
  });

  it("compte les sous-catégories déplacées avec la catégorie", () => {
    // Qualité (+ HACCP) sous Informatique : 3 niveaux → OK.
    expect(checkCategoryPlacement(LINKS, 4, 1)).toBeNull();
    // Qualité (+ HACCP) sous Réseau : 4 niveaux → refusé.
    expect(checkCategoryPlacement(LINKS, 4, 2)).toMatch(/avec ses sous-catégories/);
    // Réseau (+ Serveur EXT) sous Qualité : 3 niveaux → OK.
    expect(checkCategoryPlacement(LINKS, 2, 4)).toBeNull();
  });

  it("refuse les cycles et un parent inconnu", () => {
    expect(checkCategoryPlacement(LINKS, 1, 1)).toMatch(/elle-même/);
    expect(checkCategoryPlacement(LINKS, 1, 3)).toMatch(/sous-catégories/);
    expect(checkCategoryPlacement(LINKS, null, 99)).toBe("NOT_FOUND");
  });
});

describe("procs :: catégorie d'une procédure", () => {
  it("est obligatoire à la création, jamais retirée en modification", () => {
    expect(() => procedureCreateSchema.parse({ TITLE: "A" })).toThrow(/catégorie est obligatoire/);
    expect(() => procedureCreateSchema.parse({ TITLE: "A", CATID: "" })).toThrow();
    expect(procedureCreateSchema.parse({ TITLE: "A", CATID: "3" }).CATID).toBe(3);
    expect(() => procedureUpdateSchema.parse({ CATID: null })).toThrow();
    expect(procedureUpdateSchema.parse({ TITLE: "B" }).CATID).toBeUndefined();
  });

  it("expose le chemin complet de la catégorie", () => {
    const p = formatProcedure({
      PRCID: 1,
      TITLE: "Pare-feu",
      STATUS: "PUBLISHED",
      CATID: 3,
      CATNAME: "Serveur EXT",
      CATPARENTID: 2,
      CATPARENTNAME: "Réseau",
      CATGPID: 1,
      CATGPNAME: "Informatique",
    });
    expect(p.CAT.PATH.map((c) => c.NAME)).toEqual(["Informatique", "Réseau", "Serveur EXT"]);
  });

  it("signale une catégorie désactivée (elle-même ou un parent)", () => {
    const base = { PRCID: 1, TITLE: "A", STATUS: "PUBLISHED", CATID: 3, CATNAME: "Serveur EXT" };
    expect(formatProcedure({ ...base, CATACTIVE: 1 }).CAT).toMatchObject({ ACTIVE: true, INACTIVENAME: null });
    expect(formatProcedure({ ...base, CATACTIVE: 0, CATINACTIVENAME: "Réseau" }).CAT).toMatchObject({
      ACTIVE: false,
      INACTIVENAME: "Réseau",
    });
  });
});

describe("procs :: suppression d'une catégorie", () => {
  it("autorisée si ni procédure ni sous-catégorie", () => {
    expect(categoryDeleteError({ PROCCOUNT: 0, CHILDCOUNT: 0 })).toBeNull();
  });

  it("refusée avec la raison (sous-catégories, procédures)", () => {
    expect(categoryDeleteError({ PROCCOUNT: 0, CHILDCOUNT: 1 })).toContain("1 sous-catégorie");
    expect(categoryDeleteError({ PROCCOUNT: 3, CHILDCOUNT: 0 })).toContain("3 procédures");
    const both = categoryDeleteError({ PROCCOUNT: 1, CHILDCOUNT: 2 });
    expect(both).toContain("2 sous-catégories et 1 procédure");
  });
});
