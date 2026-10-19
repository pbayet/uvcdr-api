import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { OoxmlTemplate } from "../../../../modules/vinidoc/engine/ooxml-engine.js";

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const shape = (name, paragraphs) => `
<p:sp><p:nvSpPr><p:cNvPr id="2" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/>
<p:txBody><a:bodyPr/>${paragraphs}</p:txBody></p:sp>`;

const run = (text, bold = false) =>
  `<a:r><a:rPr lang="fr-FR"${bold ? ' b="1"' : ""}/><a:t>${text}</a:t></a:r>`;

/** Slide de test : balise fragmentée sur 3 runs (cas de la correction auto PowerPoint). */
const SLIDE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${NS}><p:cSld><p:spTree>
${shape("Texte 1", `<a:p>${run("Nez : {{DEGU")}${run("STA", true)}${run("TION}} fin")}</a:p>`)}
${shape("Texte 2", `<a:p>${run("{{terroir}}")}</a:p><a:p>${run("Millésime ")}${run("{{MILLESIME}}")}</a:p>`)}
${shape("Texte 3", `<a:p>${run("Code ")}<a:br/>${run("{{CODE_VRAC}}")}</a:p>`)}
${shape("badge:COULEUR_ROUGE", `<a:p>${run("ROUGE")}</a:p>`)}
${shape("badge:COULEUR_BLANC", `<a:p>${run("BLANC")}</a:p>`)}
${shape("Inconnue", `<a:p>${run("{{CUVEE}}")}</a:p>`)}
${shape("Longueurs", `<a:p>${run("{{APPELLATION-")}${run("250}}")}</a:p><a:p>${run("{{ appellation - 120 }} / {{TEMP-30}}")}</a:p>`)}
</p:spTree></p:cSld></p:sld>`;

async function buildPptx() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("ppt/slides/slide1.xml", SLIDE);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function slideXml(tpl) {
  const zip = await JSZip.loadAsync(await tpl.toBuffer());
  return zip.file("ppt/slides/slide1.xml").async("string");
}

describe("modules/vinidoc/engine :: OoxmlTemplate", () => {
  it("rejette un fichier qui n'est pas un pptx", async () => {
    await expect(OoxmlTemplate.fromBuffer(Buffer.from("pas un zip"))).rejects.toThrow("VINIDOC_TEMPLATE_INVALID");
    const empty = await new JSZip().file("a.txt", "x").generateAsync({ type: "nodebuffer" });
    await expect(OoxmlTemplate.fromBuffer(empty)).rejects.toThrow("VINIDOC_TEMPLATE_INVALID");
  });

  it("inventorie les balises (fragmentées, casse normalisée) et les formes conditionnelles", async () => {
    const tpl = await OoxmlTemplate.fromBuffer(await buildPptx());
    expect(await tpl.listTags()).toEqual({
      TEXT: ["APPELLATION", "CODE_VRAC", "CUVEE", "DEGUSTATION", "MILLESIME", "TEMP", "TERROIR"],
      IMAGE: [],
      BADGE: ["COULEUR_BLANC", "COULEUR_ROUGE"],
      LENGTHS: { APPELLATION: [120, 250], TEMP: [30] },
    });
  });

  it("fusionne les textes, convertit les retours à la ligne et retire les badges inactifs", async () => {
    const tpl = await OoxmlTemplate.fromBuffer(await buildPptx());
    await tpl.render({
      text: {
        DEGUSTATION: "Fruits jaunes & fleurs <blanches>",
        TERROIR: "Ligne 1\nLigne 2",
        MILLESIME: "2025",
        CODE_VRAC: "007",
        APPELLATION: "Côtes du Rhône",
        TEMP: "8-10°C",
      },
      badges: { COULEUR_BLANC: true },
    });
    const xml = await slideXml(tpl);

    // Balise fragmentée reconstituée, texte échappé, mise en forme du 1er run conservée
    expect(xml).toContain("<a:t>Nez : Fruits jaunes &amp; fleurs &lt;blanches&gt; fin</a:t>");
    expect(xml).not.toContain("{{");
    // Retour à la ligne → <a:br> + nouveau run
    expect(xml).toMatch(/<a:t>Ligne 1<\/a:t><\/a:r><a:br>.*?<\/a:br><a:r>.*?<a:t>Ligne 2<\/a:t>/s);
    // Espace de fin de run conservé lors de la fusion ("Millésime " + valeur),
    // valeurs non converties en nombre ("007")
    expect(xml).toContain("<a:t>Millésime 2025</a:t>");
    expect(xml).toContain("<a:t>007</a:t>");
    // Saut de ligne existant avant la balise conservé
    expect(xml).toMatch(/<a:t>Code <\/a:t><\/a:r><a:br\s*\/?>(<\/a:br>)?<a:r>/);
    // Badges
    expect(xml).toContain("BLANC");
    expect(xml).not.toContain('name="badge:COULEUR_ROUGE"');
    // {{X-250}} = {{X}} : remplacée par la valeur, suffixe retiré
    expect(xml).toContain("<a:t>Côtes du Rhône</a:t>");
    expect(xml).toContain("<a:t>Côtes du Rhône / 8-10°C</a:t>");
    expect(xml).not.toMatch(/-250|- 120|-30/);
    // Balise inconnue rendue vide
    expect(xml).not.toContain("CUVEE");
  });
});
