import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { extractDocumentText, normalizeText, wordXmlToText } from "../../../../modules/procs/extract.js";
import { parseSearchTerms } from "../../../../modules/procs/services.js";
import { diffFields, contentDisposition, isEditorPermission } from "../../../../modules/procs/utils.js";

const W = (body) =>
  `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`;

describe("procs :: extraction du texte", () => {
  let dir;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "procs-test-"));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("wordXmlToText garde le texte des <w:t>, ignore le texte supprimé et les balises voisines", () => {
    const xml = W(
      `<w:p><w:r><w:t>Nettoyer la </w:t></w:r><w:r><w:t xml:space="preserve">cuve &amp; rincer</w:t></w:r></w:p>` +
        `<w:p><w:r><w:delText>supprimé</w:delText></w:r><w:r><w:tab/><w:t>Étape 2</w:t></w:r></w:p>` +
        `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
    );
    const text = normalizeText(wordXmlToText(xml));
    expect(text).toContain("Nettoyer la cuve & rincer");
    expect(text).toContain("Étape 2");
    expect(text).not.toContain("supprimé");
    expect(text).toMatch(/A\s+B/);
  });

  it("extrait le texte d'un .docx (corps + en-tête)", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", W(`<w:p><w:r><w:t>Procédure de réception des vendanges</w:t></w:r></w:p>`));
    zip.file("word/header1.xml", `<w:hdr xmlns:w="w"><w:p><w:r><w:t>PROC-LOG-004</w:t></w:r></w:p></w:hdr>`);
    const file = path.join(dir, "test.docx");
    await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));

    const res = await extractDocumentText(file, "docx");
    expect(res.status).toBe("OK");
    expect(res.text.indexOf("Procédure de réception")).toBeLessThan(res.text.indexOf("PROC-LOG-004"));
  });

  it("extrait le texte d'un .odt", async () => {
    const zip = new JSZip();
    zip.file(
      "content.xml",
      `<office:document-content><text:p>Ligne 1</text:p><text:h>Titre<text:s text:c="2"/>fin</text:h></office:document-content>`,
    );
    const file = path.join(dir, "test.odt");
    await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
    const res = await extractDocumentText(file, "odt");
    expect(res).toMatchObject({ status: "OK" });
    expect(res.text).toBe("Ligne 1\nTitre fin");
  });

  it("document vide → EMPTY ; format inconnu → UNSUPPORTED ; fichier corrompu → ERROR", async () => {
    const empty = path.join(dir, "vide.txt");
    await fs.writeFile(empty, "   \n ");
    expect((await extractDocumentText(empty, "txt")).status).toBe("EMPTY");
    expect((await extractDocumentText(empty, "xls")).status).toBe("UNSUPPORTED");

    const broken = path.join(dir, "casse.docx");
    await fs.writeFile(broken, "pas un zip");
    expect((await extractDocumentText(broken, "docx")).status).toBe("ERROR");
  });
});

describe("procs :: recherche", () => {
  it("parseSearchTerms : guillemets, doublons, termes trop courts, échappement LIKE", () => {
    expect(parseSearchTerms(`"bon de livraison" palette Palette a 100%`)).toEqual([
      { raw: "bon de livraison", like: "%bon de livraison%" },
      { raw: "palette", like: "%palette%" },
      { raw: "100%", like: "%100[%]%" },
    ]);
    expect(parseSearchTerms("   ")).toEqual([]);
  });
});

describe("procs :: utilitaires", () => {
  it("isEditorPermission : MODIFY_PERMS par défaut, PROCS_EDITOR_PERMS prioritaire", () => {
    expect(isEditorPermission("admin")).toBe(true);
    expect(isEditorPermission("USER")).toBe(false);
    process.env.PROCS_EDITOR_PERMS = "QUALITE";
    try {
      expect(isEditorPermission("ADMIN")).toBe(false);
      expect(isEditorPermission("qualite")).toBe(true);
    } finally {
      delete process.env.PROCS_EDITOR_PERMS;
    }
  });

  it("diffFields : seuls les champs modifiés, mots-clés comparés sans ordre, dates normalisées", () => {
    const before = {
      TITLE: "A",
      OWNER: null,
      KEYWORDS: ["b", "a"],
      REVIEWDAT: new Date("2027-01-01T00:00:00Z"),
    };
    expect(
      diffFields(before, { TITLE: "A", OWNER: "", KEYWORDS: ["a", "b"], REVIEWDAT: "2027-01-01" }, [
        "TITLE",
        "OWNER",
        "KEYWORDS",
        "REVIEWDAT",
      ]),
    ).toEqual({});
    expect(diffFields(before, { TITLE: "B", REVIEWDAT: null }, ["TITLE", "REVIEWDAT"])).toEqual({
      TITLE: { from: "A", to: "B" },
      REVIEWDAT: { from: "2027-01-01", to: null },
    });
  });

  it("contentDisposition encode les noms accentués", () => {
    expect(contentDisposition("inline", 'Procédure "cuves".pdf')).toBe(
      `inline; filename="Proce_dure cuves.pdf"; filename*=UTF-8''Proc%C3%A9dure%20cuves.pdf`,
    );
  });
});
