import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { XMLParser, XMLBuilder } from "fast-xml-parser";

/* ═══════════════════════════════════════════════════════════════
   VINIDOC — Moteur de fusion PowerPoint (OOXML)
   Repris du POC technical-data-sheet-tests/webapp/server/src/ooxml-engine.js
   (porté en ESM) avec les évolutions suivantes :
     - lecture depuis un Buffer (fichier issu d'APPATTACHMENTS) ;
     - inventaire des balises d'un modèle (listTags) pour l'administration
       des longueurs max ;
     - balises insensibles à la casse, données "à plat" ({ TAG: valeur }) ;
     - retours à la ligne des textes convertis en <a:br/> (sinon ignorés
       par PowerPoint dans un <a:t>) ;
     - parsing sans conversion de types (parseTagValue: false) ni trim :
       le POC transformait "08" en 8 et supprimait les espaces de fin de
       run ("Hello " + "World" → "HelloWorld").

   Conventions dans le modèle PowerPoint (Volet Sélection pour nommer les
   formes : Accueil > Organiser > Volet Sélection) :
     - Texte  : balise tapée dans une zone de texte, ex. {{DEGUSTATION}}
                avec longueur max facultative : {{DEGUSTATION-250}}
                ({{X}} et {{X-250}} désignent la MÊME balise X)
     - Image  : forme image nommée "img:<TAG>", ex. img:BOTTLEPHOTO
     - Bloc conditionnel : forme (ou groupe) nommée "badge:<TAG>", retirée
       du rendu si data.badges[<TAG>] est faux, ex. badge:COULEUR_ROUGE,
       badge:INTENSITE_AROMATIQUE_3
═══════════════════════════════════════════════════════════════ */

/**
 * Balise texte : {{NOM}} ou {{NOM-LONGUEUR}}.
 *   m[1] = nom (le "-" n'y est pas autorisé : aucune ambiguïté avec le suffixe)
 *   m[2] = longueur max facultative saisie dans le modèle (chaîne de chiffres)
 */
export const TAG_RE = /\{\{\s*([A-Za-z0-9_.]+)\s*(?:-\s*(\d+)\s*)?\}\}/g;
const SLIDE_RE = /^ppt\/slides\/slide\d+\.xml$/;

const parserOptions = {
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  allowBooleanAttributes: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
};

const parser = new XMLParser(parserOptions);
const builder = new XMLBuilder({ ...parserOptions, suppressEmptyNode: false });

/** Nom de l'élément d'un nœud preserveOrder ({ "a:r": [...], ":@": {...} }). */
const tagOf = (node) => Object.keys(node).find((k) => k !== ":@");
const childOf = (children, name) => children?.find((c) => tagOf(c) === name);
const normalizeTag = (name) => String(name).trim().toUpperCase();

export class OoxmlTemplate {
  constructor(zip) {
    this.zip = zip;
  }

  static async fromBuffer(buffer) {
    let zip;
    try {
      zip = await JSZip.loadAsync(buffer);
    } catch {
      throw new Error("VINIDOC_TEMPLATE_INVALID");
    }
    const tpl = new OoxmlTemplate(zip);
    if (tpl._slideFiles().length === 0)
      throw new Error("VINIDOC_TEMPLATE_INVALID");
    return tpl;
  }

  static async load(filePath) {
    return OoxmlTemplate.fromBuffer(await fs.readFile(filePath));
  }

  _slideFiles() {
    return Object.keys(this.zip.files)
      .filter((f) => SLIDE_RE.test(f))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  }

  async _slideTrees() {
    const out = [];
    for (const slidePath of this._slideFiles()) {
      const xml = await this.zip.file(slidePath).async("string");
      out.push({ slidePath, tree: parser.parse(xml) });
    }
    return out;
  }

  /**
   * Inventaire des balises du modèle.
   * LENGTHS : longueurs max saisies dans les balises texte ({{TAG-250}}),
   * brutes (toutes les valeurs distinctes rencontrées, triées) — la règle
   * de choix et la validation relèvent de l'appelant (utils.tagsFromInventory).
   * @returns {Promise<{ TEXT: string[], IMAGE: string[], BADGE: string[], LENGTHS: Record<string, number[]> }>}
   */
  async listTags() {
    const found = { TEXT: new Set(), IMAGE: new Set(), BADGE: new Set() };
    const lengths = new Map(); // TAG → Set<number>

    for (const { tree } of await this._slideTrees()) {
      this._walk(tree, (node, tag) => {
        if (tag === "a:p") {
          for (const segment of this._runSegments(node[tag])) {
            const text = segment
              .map((i) => this._runText(node[tag][i]["a:r"]))
              .join("");
            for (const m of text.matchAll(TAG_RE)) {
              const name = normalizeTag(m[1]);
              found.TEXT.add(name);
              if (m[2] != null) {
                if (!lengths.has(name)) lengths.set(name, new Set());
                lengths.get(name).add(Number(m[2]));
              }
            }
          }
          return false; // pas de forme dans un paragraphe
        }
        const name = this._shapeName(node, tag);
        if (name?.startsWith("img:") && tag === "p:pic")
          found.IMAGE.add(normalizeTag(name.slice(4)));
        if (name?.startsWith("badge:"))
          found.BADGE.add(normalizeTag(name.slice(6)));
        return true;
      });
    }

    return {
      TEXT: [...found.TEXT].sort(),
      IMAGE: [...found.IMAGE].sort(),
      BADGE: [...found.BADGE].sort(),
      LENGTHS: Object.fromEntries(
        [...lengths]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, set]) => [name, [...set].sort((a, b) => a - b)]),
      ),
    };
  }

  /**
   * Applique les données.
   * @param {{ text?: Record<string,string>, badges?: Record<string,boolean>, images?: Record<string,string> }} data
   *   Clés en MAJUSCULES. `images` : TAG → chemin local d'un fichier image.
   */
  async render(data = {}) {
    const text = data.text ?? {};
    const badges = data.badges ?? {};
    const images = data.images ?? {};

    for (const { slidePath, tree } of await this._slideTrees()) {
      this._removeInactiveBadges(tree, badges);
      this._walk(tree, (node, tag) => {
        if (tag !== "a:p") return true;
        this._replaceInParagraph(node[tag], text);
        return false;
      });
      const imageJobs = this._collectImageJobs(tree, images);

      this.zip.file(slidePath, builder.build(tree));

      if (imageJobs.length) {
        const rels = await this._relsFor(slidePath);
        for (const job of imageJobs) await this._replaceImage(rels, job);
      }
    }
    return this;
  }

  async toBuffer() {
    return this.zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });
  }

  async save(outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, await this.toBuffer());
    return outputPath;
  }

  /* ───────────────────────────── internes ───────────────────────────── */

  /** Parcours en profondeur ; `visit` retourne false pour ne pas descendre. */
  _walk(nodes, visit) {
    for (const node of nodes) {
      const tag = tagOf(node);
      if (!tag) continue;
      const descend = visit(node, tag);
      if (descend !== false && Array.isArray(node[tag]))
        this._walk(node[tag], visit);
    }
  }

  _attr(node, name) {
    return node[":@"]?.[`@_${name}`];
  }

  _runText(runChildren) {
    const t = childOf(runChildren, "a:t");
    const content = t?.["a:t"];
    if (!content?.length) return "";
    return content
      .map((c) => (c["#text"] == null ? "" : String(c["#text"])))
      .join("");
  }

  _setRunText(runChildren, value) {
    const t = childOf(runChildren, "a:t");
    if (t) t["a:t"] = [{ "#text": value }];
    else runChildren.push({ "a:t": [{ "#text": value }] });
  }

  /**
   * Indices des runs (a:r) d'un paragraphe, groupés par suites contiguës :
   * une balise ne peut pas traverser un saut de ligne (a:br) ou un champ.
   */
  _runSegments(paraChildren) {
    const segments = [];
    let current = [];
    paraChildren.forEach((child, i) => {
      if (tagOf(child) === "a:r") current.push(i);
      else if (current.length) {
        segments.push(current);
        current = [];
      }
    });
    if (current.length) segments.push(current);
    return segments;
  }

  _replaceInParagraph(paraChildren, values) {
    // Traitement de la fin vers le début : les splice() d'un segment ne
    // décalent pas les indices des segments précédents.
    const segments = this._runSegments(paraChildren).reverse();

    for (const segment of segments) {
      const runs = segment.map((i) => paraChildren[i]["a:r"]);
      const fullText = runs.map((r) => this._runText(r)).join("");
      if (!fullText.includes("{{")) continue;

      const newText = fullText.replace(TAG_RE, (_, name) => {
        const v = values[normalizeTag(name)];
        return v == null ? "" : String(v);
      });
      if (newText === fullText) continue;

      // Le 1er run (et donc sa mise en forme) porte tout le texte fusionné.
      for (let k = segment.length - 1; k >= 1; k--)
        paraChildren.splice(segment[k], 1);

      const firstIdx = segment[0];
      const firstRun = paraChildren[firstIdx]["a:r"];
      const lines = newText.replace(/\r\n?/g, "\n").split("\n");
      this._setRunText(firstRun, lines[0]);

      if (lines.length > 1) {
        const rPr = childOf(firstRun, "a:rPr");
        const inserted = [];
        for (const line of lines.slice(1)) {
          inserted.push({ "a:br": rPr ? [structuredClone(rPr)] : [] });
          const clone = structuredClone(firstRun);
          this._setRunText(clone, line);
          inserted.push({ "a:r": clone });
        }
        paraChildren.splice(firstIdx + 1, 0, ...inserted);
      }
    }
  }

  _shapeName(node, tag) {
    const nvTag = {
      "p:sp": "p:nvSpPr",
      "p:pic": "p:nvPicPr",
      "p:grpSp": "p:nvGrpSpPr",
    }[tag];
    if (!nvTag) return null;
    const nvPr = childOf(node[tag], nvTag);
    const cNvPr = childOf(nvPr?.[nvTag], "p:cNvPr");
    return cNvPr ? (this._attr(cNvPr, "name")?.trim() ?? null) : null;
  }

  /** Retire les formes "badge:TAG" dont la condition est fausse. */
  _removeInactiveBadges(nodes, badges) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      const tag = tagOf(node);
      if (!tag) continue;
      const name = this._shapeName(node, tag);
      if (name?.startsWith("badge:") && !badges[normalizeTag(name.slice(6))]) {
        nodes.splice(i, 1);
        continue;
      }
      if (Array.isArray(node[tag]))
        this._removeInactiveBadges(node[tag], badges);
    }
  }

  _collectImageJobs(nodes, images, jobs = []) {
    this._walk(nodes, (node, tag) => {
      if (tag !== "p:pic") return true;
      const name = this._shapeName(node, tag);
      if (!name?.startsWith("img:")) return false;
      const localPath = images[normalizeTag(name.slice(4))];
      if (!localPath) return false;

      const pic = node["p:pic"];
      const blipFill = childOf(pic, "p:blipFill")?.["p:blipFill"];
      const blip = childOf(blipFill, "a:blip");
      const rId = blip ? this._attr(blip, "r:embed") : null;
      if (!rId) return false;

      const xfrm = childOf(childOf(pic, "p:spPr")?.["p:spPr"], "a:xfrm")?.[
        "a:xfrm"
      ];
      const ext = childOf(xfrm, "a:ext");
      const dims = ext
        ? {
            cx: Number(this._attr(ext, "cx")),
            cy: Number(this._attr(ext, "cy")),
          }
        : null;

      // L'image de remplacement est déjà ajustée au ratio du cadre : on
      // retire un éventuel recadrage PowerPoint (a:srcRect) pour ne pas
      // la rogner (cf. POC).
      const srcIdx = blipFill.findIndex((c) => tagOf(c) === "a:srcRect");
      if (srcIdx !== -1) blipFill.splice(srcIdx, 1);

      jobs.push({ rId, localPath, dims });
      return false;
    });
    return jobs;
  }

  async _relsFor(slidePath) {
    const relsFile = this.zip.file(
      `ppt/slides/_rels/${path.posix.basename(slidePath)}.rels`,
    );
    if (!relsFile) return {};
    const xml = await relsFile.async("string");
    const map = {};
    for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = m[0].match(/\bId="([^"]+)"/)?.[1];
      const target = m[0].match(/\bTarget="([^"]+)"/)?.[1];
      if (id && target) map[id] = target;
    }
    return map;
  }

  async _replaceImage(rels, job) {
    const target = rels[job.rId];
    if (!target) return;
    const mediaPath = path.posix.normalize(
      path.posix.join("ppt/slides", target),
    );

    const EMU_PER_INCH = 914400;
    const DPI = 150;
    const width = job.dims?.cx
      ? Math.round((job.dims.cx / EMU_PER_INCH) * DPI)
      : 1200;
    const height = job.dims?.cy
      ? Math.round((job.dims.cy / EMU_PER_INCH) * DPI)
      : 1200;

    // Image entière dans le cadre (jamais rognée), posée en bas : le vide
    // éventuel est transparent (PNG) ou blanc (JPEG, sans transparence).
    const ext = path.posix.extname(mediaPath).toLowerCase();
    const isJpeg = [".jpg", ".jpeg"].includes(ext);
    let pipeline = sharp(job.localPath)
      .rotate()
      .resize(width, height, {
        fit: "contain",
        position: "bottom",
        background: isJpeg
          ? { r: 255, g: 255, b: 255, alpha: 1 }
          : { r: 0, g: 0, b: 0, alpha: 0 },
      });
    pipeline = isJpeg ? pipeline.jpeg({ quality: 90 }) : pipeline.png();

    this.zip.file(mediaPath, await pipeline.toBuffer());
  }
}
