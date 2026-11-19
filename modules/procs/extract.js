import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";
import { logger } from "../../config/logger.config.js";
import { resolveSofficeCommand } from "../vinidoc/engine/pdf-converter.js";

/* ═══════════════════════════════════════════════════════════════
   PROCS — Extraction du texte des documents (recherche plein texte)
   et génération d'un aperçu PDF des documents Word.

   - PDF            : unpdf (pdf.js), texte de toutes les pages ;
   - DOCX/DOCM/DOTX : lecture directe du XML (word/document.xml, en-têtes,
                      pieds de page, notes) — sans dépendance externe ;
   - ODT            : content.xml ;
   - DOC/RTF        : LibreOffice (soffice --convert-to txt), si installé ;
   - TXT/MD         : lecture brute.

   Aperçu : les documents non PDF sont convertis en PDF par LibreOffice
   (best-effort, PROCS_PREVIEW=false pour désactiver) afin d'être lus
   directement dans le navigateur. Sans LibreOffice, l'application propose
   le téléchargement du fichier et l'affichage du texte extrait.

   Un PDF scanné (images sans couche texte) donne un texte vide
   (TEXTSTATUS = EMPTY) : seuls ses métadonnées (titre, résumé, mots-clés)
   sont alors cherchables.
═══════════════════════════════════════════════════════════════ */

/** Extensions acceptées pour le document d'une procédure. */
export const ALLOWED_EXTENSIONS = [
  "pdf",
  "docx",
  "docm",
  "dotx",
  "doc",
  "odt",
  "rtf",
  "txt",
];

/** Extensions converties en PDF pour l'aperçu dans le navigateur. */
const PREVIEWABLE = new Set(["docx", "docm", "dotx", "doc", "odt", "rtf"]);

/** Taille maximale du texte indexé (caractères). */
const MAX_TEXT_LENGTH = 2_000_000;

const SOFFICE_TIMEOUT_MS = Number(process.env.PROCS_SOFFICE_TIMEOUT_MS) || 120_000;
const PREVIEW_ENABLED = process.env.PROCS_PREVIEW !== "false";

/* ───────────────────────── Utilitaires ───────────────────────── */

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X"
        ? parseInt(e.slice(2), 16)
        : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    return XML_ENTITIES[e.toLowerCase()] ?? "";
  });
}

/** Nettoie le texte : espaces multiples, lignes vides en série, longueur. */
export function normalizeText(text) {
  return String(text ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

/** Texte d'une partie WordprocessingML (document, en-tête, pied de page…). */
export function wordXmlToText(xml) {
  // Seul le contenu des balises <w:t> est conservé (le texte supprimé en
  // mode révision est dans <w:delText>, donc ignoré) ; fins de paragraphe,
  // sauts de ligne, tabulations et cellules de tableau deviennent des
  // séparateurs.
  const TOKENS =
    /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<\/w:p>|<w:(?:br|cr)\b[^>]*\/>|<w:tab\b[^>]*\/>|<\/w:tc>/g;
  const out = [];
  let m;
  while ((m = TOKENS.exec(xml))) {
    if (m[1] !== undefined) out.push(decodeXml(m[1]));
    else if (m[0] === "</w:p>" || /^<w:(br|cr)\b/.test(m[0])) out.push("\n");
    else out.push("\t");
  }
  return out.join("");
}

async function docxToText(filePath) {
  const zip = await JSZip.loadAsync(await fsp.readFile(filePath));
  const parts = Object.keys(zip.files)
    .filter((name) =>
      /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(name),
    )
    // Corps du document d'abord, puis en-têtes / pieds de page / notes.
    .sort((a, b) => (a === "word/document.xml" ? -1 : b === "word/document.xml" ? 1 : a.localeCompare(b)));

  const texts = [];
  for (const name of parts) {
    texts.push(wordXmlToText(await zip.file(name).async("string")));
  }
  return { text: texts.join("\n"), pages: null };
}

async function odtToText(filePath) {
  const zip = await JSZip.loadAsync(await fsp.readFile(filePath));
  const xml = (await zip.file("content.xml")?.async("string")) ?? "";
  const text = decodeXml(
    xml
      .replace(/<\/text:(p|h)>/g, "\n")
      .replace(/<text:line-break\s*\/>/g, "\n")
      .replace(/<text:tab\s*\/>/g, "\t")
      .replace(/<text:s(?:\s+text:c="(\d+)")?\s*\/>/g, (_, n) => " ".repeat(Number(n) || 1))
      .replace(/<[^>]+>/g, ""),
  );
  return { text, pages: null };
}

async function pdfToText(filePath) {
  const pdf = await getDocumentProxy(new Uint8Array(await fsp.readFile(filePath)));
  try {
    const { totalPages, text } = await extractPdfText(pdf, { mergePages: false });
    return {
      text: (Array.isArray(text) ? text : [text]).join("\n\n"),
      pages: totalPages ?? null,
    };
  } finally {
    await pdf.destroy?.().catch?.(() => {});
  }
}

/* ───────────────────────── LibreOffice ───────────────────────── */

let sofficeQueue = Promise.resolve();

/** Conversions LibreOffice sérialisées (un processus soffice à la fois). */
function enqueueSoffice(task) {
  const run = sofficeQueue.then(task, task);
  sofficeQueue = run.catch(() => {});
  return run;
}

function execSoffice(args) {
  return new Promise((resolve, reject) => {
    execFile(
      resolveSofficeCommand(),
      args,
      { timeout: SOFFICE_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        err.details = `${stderr || stdout || ""}`.trim();
        reject(err);
      },
    );
  });
}

/**
 * Convertit `filePath` au format `target` ("pdf", "txt:Text (encoded):UTF8"…)
 * dans un dossier temporaire ; retourne le chemin du fichier produit.
 * L'appelant doit supprimer `dir` (renvoyé) une fois le fichier exploité.
 */
async function convertWithSoffice(filePath, target, outExt) {
  return enqueueSoffice(async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "procs-soffice-"));
    const profileDir = path.join(dir, "profile");
    try {
      await execSoffice([
        "--headless",
        "--norestore",
        `-env:UserInstallation=${pathToFileURL(profileDir).toString()}`,
        "--convert-to",
        target,
        "--outdir",
        dir,
        filePath,
      ]);
      const out = path.join(dir, `${path.basename(filePath, path.extname(filePath))}.${outExt}`);
      await fsp.access(out);
      return { dir, out };
    } catch (err) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  });
}

async function sofficeToText(filePath) {
  const { dir, out } = await convertWithSoffice(filePath, "txt:Text (encoded):UTF8", "txt");
  try {
    return { text: await fsp.readFile(out, "utf8"), pages: null };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ───────────────────────── API ───────────────────────── */

/**
 * Extrait le texte d'un document.
 * @returns {Promise<{ status: "OK"|"EMPTY"|"UNSUPPORTED"|"ERROR", text: string|null, pages: number|null }>}
 */
export async function extractDocumentText(filePath, extension) {
  const ext = String(extension || "").toLowerCase();
  try {
    let result;
    switch (ext) {
      case "pdf":
        result = await pdfToText(filePath);
        break;
      case "docx":
      case "docm":
      case "dotx":
        result = await docxToText(filePath);
        break;
      case "odt":
        result = await odtToText(filePath);
        break;
      case "doc":
      case "rtf":
        result = await sofficeToText(filePath);
        break;
      case "txt":
      case "md":
        result = { text: await fsp.readFile(filePath, "utf8"), pages: null };
        break;
      default:
        return { status: "UNSUPPORTED", text: null, pages: null };
    }

    const text = normalizeText(result.text);
    return { status: text ? "OK" : "EMPTY", text: text || null, pages: result.pages };
  } catch (err) {
    const missingSoffice = err.code === "ENOENT";
    logger.warn(
      `[PROCS][TEXT] Extraction impossible (${ext}) ${path.basename(filePath)} | ${missingSoffice ? `LibreOffice introuvable (${resolveSofficeCommand()}) — renseigner SOFFICE_PATH` : err.message} ${err.details ?? ""}`,
    );
    return { status: missingSoffice ? "UNSUPPORTED" : "ERROR", text: null, pages: null };
  }
}

/** Le document doit-il recevoir un aperçu PDF ? */
export function needsPreview(extension) {
  return PREVIEW_ENABLED && PREVIEWABLE.has(String(extension || "").toLowerCase());
}

/**
 * Génère l'aperçu PDF d'un document Word / ODT / RTF. Best-effort : renvoie
 * null (et logue) si LibreOffice est absent ou si la conversion échoue.
 * @returns {Promise<{ dir: string, pdfPath: string } | null>}
 */
export async function generatePdfPreview(filePath) {
  try {
    const { dir, out } = await convertWithSoffice(filePath, "pdf", "pdf");
    return { dir, pdfPath: out };
  } catch (err) {
    logger.warn(
      `[PROCS][PREVIEW] Aperçu PDF non généré pour ${path.basename(filePath)} | ${err.code === "ENOENT" ? `LibreOffice introuvable (${resolveSofficeCommand()})` : err.message}`,
    );
    return null;
  }
}
