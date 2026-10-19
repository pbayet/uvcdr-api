import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { logger } from "../../../config/logger.config.js";

/* ═══════════════════════════════════════════════════════════════
   VINIDOC — Conversion PPTX → PDF
   Deux moteurs (repris du POC), au choix via VINIDOC_PDF_ENGINE :
     - "libreoffice" (défaut) : soffice --headless, profil isolé par appel.
       Multiplateforme ; peut substituer une police non installée "pour
       tous les utilisateurs" sur le serveur (cf. README du POC).
     - "powerpoint" : automatisation COM (Windows + PowerPoint sous licence,
       session interactive requise) — rendu 100 % fidèle. Sérialisé.

   Concurrence : les conversions passent par une file en mémoire limitée à
   VINIDOC_PDF_CONCURRENCY (défaut 2 pour LibreOffice, forcé à 1 pour
   PowerPoint) pour ne pas saturer le serveur lors de générations
   simultanées. Au-delà d'une instance de l'API (cluster PM2), prévoir une
   vraie file de jobs.
═══════════════════════════════════════════════════════════════ */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PS_SCRIPT = path.join(__dirname, "convert-with-powerpoint.ps1");

const ENGINE = (process.env.VINIDOC_PDF_ENGINE || "libreoffice").toLowerCase();
const TIMEOUT_MS = Number(process.env.VINIDOC_PDF_TIMEOUT_MS) || 90_000;
const CONCURRENCY =
  ENGINE === "powerpoint" ? 1 : Math.max(1, Number(process.env.VINIDOC_PDF_CONCURRENCY) || 2);

const WINDOWS_SOFFICE_PATHS = [
  "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
  "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
];

/* ───────────────────────── File d'attente ───────────────────────── */

let running = 0;
const waiting = [];

function enqueue(task) {
  return new Promise((resolve, reject) => {
    const start = async () => {
      running++;
      try {
        resolve(await task());
      } catch (err) {
        reject(err);
      } finally {
        running--;
        waiting.shift()?.();
      }
    };
    if (running < CONCURRENCY) start();
    else waiting.push(start);
  });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      err.details = `${stderr || stdout || ""}`.trim();
      reject(err);
    });
  });
}

/* ───────────────────────── LibreOffice ───────────────────────── */

export function resolveSofficeCommand() {
  if (process.env.SOFFICE_PATH) return process.env.SOFFICE_PATH;
  if (process.platform === "win32") {
    const found = WINDOWS_SOFFICE_PATHS.find((p) => fs.existsSync(p));
    if (found) return found;
  }
  return "soffice";
}

async function convertWithLibreOffice(pptxPath, outDir) {
  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinidoc-soffice-"));
  try {
    await run(resolveSofficeCommand(), [
      "--headless",
      "--norestore",
      `-env:UserInstallation=${pathToFileURL(profileDir).toString()}`,
      "--convert-to",
      "pdf",
      "--outdir",
      outDir,
      pptxPath,
    ]);
  } finally {
    await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ───────────────────────── PowerPoint (COM) ───────────────────────── */

async function convertWithPowerPoint(pptxPath, pdfPath) {
  if (process.platform !== "win32") {
    throw new Error("VINIDOC_PDF_ENGINE=powerpoint nécessite Windows.");
  }
  await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    PS_SCRIPT,
    "-PptxPath",
    pptxPath,
    "-PdfPath",
    pdfPath,
  ]);
}

/* ───────────────────────── API ───────────────────────── */

/**
 * Convertit `pptxPath` en PDF dans `outDir` ; retourne le chemin du PDF.
 * Lève VINIDOC_PDF_CONVERSION_FAILED (détail technique uniquement loggé).
 */
export async function convertPptxToPdf(pptxPath, outDir) {
  await fsp.mkdir(outDir, { recursive: true });
  const pdfPath = path.join(outDir, `${path.basename(pptxPath, path.extname(pptxPath))}.pdf`);

  return enqueue(async () => {
    try {
      if (ENGINE === "powerpoint") await convertWithPowerPoint(pptxPath, pdfPath);
      else await convertWithLibreOffice(pptxPath, outDir);
      await fsp.access(pdfPath);
      return pdfPath;
    } catch (err) {
      logger.error(
        `[VINIDOC][PDF] Conversion "${ENGINE}" échouée pour ${path.basename(pptxPath)} | ${err.code === "ENOENT" ? `exécutable introuvable (${ENGINE === "powerpoint" ? "powershell.exe" : resolveSofficeCommand()}) — renseigner SOFFICE_PATH` : err.message} ${err.details ?? ""}`,
      );
      throw new Error("VINIDOC_PDF_CONVERSION_FAILED", { cause: err });
    }
  });
}

export const pdfEngineName = ENGINE;
