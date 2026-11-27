import { describe, it, expect } from "vitest";
import {
  MANAGER_APPCOD,
  attachVersionDocuments,
  getDocumentViewer,
  groupVersionDocuments,
  isDocumentVisible,
  resolveLatestDocuments,
} from "../../../../modules/usersmanager/utils.js";

// Lignes de services.getAppVersionDocuments (une par statut, plus récente d'abord).
const docRow = (VID, VNUM, DID, DOCNAM, PRMLVL = null) => ({
  VID,
  APPCOD: "APP",
  VNUM,
  DID,
  DOCNAM,
  DOCLNK: `https://docs/${DOCNAM}.pdf`,
  ORDNUM: 0,
  PRMID: PRMLVL == null ? null : PRMLVL * 10,
  PRMNAM: PRMLVL == null ? null : `LVL${PRMLVL}`,
  PRMLVL,
});

// Historique formatAppVersions : 1.3.0, 1.2.0, 1.0.0, 0.9.0.
const history = () => [
  { VID: 4, VNUM: "1.3.0" },
  { VID: 3, VNUM: "1.2.0" },
  { VID: 2, VNUM: "1.0.0" },
  { VID: 1, VNUM: "0.9.0" },
];

const names = (docs) => docs.map((d) => d.DOCNAM);

describe("modules/usersmanager/utils :: modes opératoires par version", () => {
  it("getDocumentViewer : users-manager voit tout, l'application son statut, les autres rien de restreint", () => {
    expect(getDocumentViewer({ application: MANAGER_APPCOD }, "APP")).toEqual({ all: true });
    expect(getDocumentViewer({ application: "APP", permissionLevel: 3 }, "APP")).toEqual({ level: 3 });
    expect(getDocumentViewer({ application: "APP", permissionLevel: -1 }, "APP")).toEqual({ level: null });
    expect(getDocumentViewer({ application: "OTHER", permissionLevel: 1 }, "APP")).toEqual({ level: null });
  });

  it("isDocumentVisible : sans statut = visible par tous, sinon statut requis", () => {
    const open = { PERMISSIONS: [] };
    const admin = { PERMISSIONS: [{ PRMLVL: 2 }] };
    expect(isDocumentVisible(open, { level: null })).toBe(true);
    expect(isDocumentVisible(admin, { level: null })).toBe(false);
    expect(isDocumentVisible(admin, { level: 4 })).toBe(false);
    expect(isDocumentVisible(admin, { level: 2 })).toBe(true);
    expect(isDocumentVisible(admin, { all: true })).toBe(true);
  });

  it("groupVersionDocuments : un mode opératoire par DID, statuts cumulés", () => {
    const grouped = groupVersionDocuments([
      docRow(2, "1.0.0", 10, "guide", 2),
      docRow(2, "1.0.0", 10, "guide", 4),
      docRow(2, "1.0.0", 11, "public"),
    ]);
    const docs = grouped.get(2).DOCUMENTS;
    expect(names(docs)).toEqual(["guide", "public"]);
    expect(docs[0].PERMISSIONS.map((p) => p.PRMLVL)).toEqual([2, 4]);
    expect(docs[1].PERMISSIONS).toEqual([]);
  });

  it("version sans mode opératoire : celui de la version antérieure la plus proche, pas d'une plus récente", () => {
    const docs = groupVersionDocuments([
      docRow(4, "1.3.0", 40, "modop-1.3"),
      docRow(2, "1.0.0", 20, "modop-1.0"),
    ]);
    const [v130, v120, v100, v090] = attachVersionDocuments(history(), docs, "https://legacy.pdf", { level: 4 });

    expect(names(v130.EFFECTIVE_DOCUMENTS)).toEqual(["modop-1.3"]);
    expect(v130.EFFECTIVE_DOCS_VNUM).toBe("1.3.0");
    expect(names(v120.EFFECTIVE_DOCUMENTS)).toEqual(["modop-1.0"]);
    expect(v120.EFFECTIVE_DOCS_VNUM).toBe("1.0.0");
    expect(v120.DOCUMENTS).toEqual([]);
    expect(names(v100.EFFECTIVE_DOCUMENTS)).toEqual(["modop-1.0"]);
    // Avant le premier mode opératoire : ancien lien de l'application.
    expect(v090.EFFECTIVE_DOCUMENTS).toEqual([
      expect.objectContaining({ DID: null, DOCLNK: "https://legacy.pdf" }),
    ]);
    expect(v090.EFFECTIVE_DOCS_VNUM).toBeNull();
  });

  it("filtre par statut, plusieurs modes opératoires et repli calculé sur les seuls visibles", () => {
    const docs = groupVersionDocuments([
      docRow(3, "1.2.0", 30, "admin-1.2", 2),
      docRow(2, "1.0.0", 20, "reader-1.0", 5),
      docRow(2, "1.0.0", 21, "admin-1.0", 2),
      docRow(2, "1.0.0", 22, "tous-1.0"),
    ]);

    const reader = attachVersionDocuments(history(), docs, null, { level: 5 });
    expect(names(reader[1].EFFECTIVE_DOCUMENTS)).toEqual(["reader-1.0", "tous-1.0"]);
    expect(reader[1].EFFECTIVE_DOCS_VNUM).toBe("1.0.0");

    const admin = attachVersionDocuments(history(), docs, null, { level: 2 });
    expect(names(admin[1].EFFECTIVE_DOCUMENTS)).toEqual(["admin-1.2"]);
    expect(names(admin[2].EFFECTIVE_DOCUMENTS)).toEqual(["admin-1.0", "tous-1.0"]);
    expect(admin[3].EFFECTIVE_DOCUMENTS).toEqual([]);
  });

  it("resolveLatestDocuments : dernière version avec des modes opératoires visibles, sinon ancien lien", () => {
    const versions = [
      ...groupVersionDocuments([
        docRow(3, "1.2.0", 30, "admin-1.2", 2),
        docRow(2, "1.0.0", 20, "tous-1.0"),
      ]).values(),
    ];
    expect(names(resolveLatestDocuments(versions, null, { level: 2 }).DOCUMENTS)).toEqual(["admin-1.2"]);
    expect(resolveLatestDocuments(versions, null, { level: 4 })).toMatchObject({ VNUM: "1.0.0" });
    expect(resolveLatestDocuments([], "https://legacy.pdf", { level: 4 }).DOCUMENTS[0].DOCLNK).toBe(
      "https://legacy.pdf",
    );
    expect(resolveLatestDocuments([], null, { level: 4 }).DOCUMENTS).toEqual([]);
  });
});
