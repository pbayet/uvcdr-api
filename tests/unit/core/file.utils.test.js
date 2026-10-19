import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  sanitizeFilename,
  getSafeExtension,
  buildRelativeStoragePath,
  ensureDirectoryForFile,
  computeFileSha256,
} from "../../../core/utils/file.utils.js";

describe("core/utils/file.utils :: sanitizeFilename", () => {
  it("retourne 'file' pour une entrée vide", () => {
    expect(sanitizeFilename(null)).toBe("file");
    expect(sanitizeFilename("")).toBe("file");
  });

  it("supprime le chemin et ne garde que le nom de base", () => {
    // path.basename() est dépendant de l'OS pour les séparateurs `\` — on ne
    // teste ici que le séparateur `/`, portable sur toutes les plateformes.
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("uploads/sous-dossier/rapport final.pdf")).toBe("rapport_final.pdf");
  });

  it("remplace les espaces par des underscores", () => {
    expect(sanitizeFilename("mon fichier test.docx")).toBe("mon_fichier_test.docx");
  });

  it("retire les caractères spéciaux dangereux", () => {
    expect(sanitizeFilename('fichier<>:"|?*.txt')).toBe("fichier.txt");
  });

  it("tronque à 150 caractères", () => {
    const longName = `${"a".repeat(200)}.txt`;
    expect(sanitizeFilename(longName).length).toBeLessThanOrEqual(150);
  });
});

describe("core/utils/file.utils :: getSafeExtension", () => {
  it("retourne l'extension en minuscules sans le point", () => {
    expect(getSafeExtension("photo.JPG")).toBe("jpg");
    expect(getSafeExtension("archive.tar.GZ")).toBe("gz");
  });

  it("retourne 'bin' si aucune extension", () => {
    expect(getSafeExtension("fichier")).toBe("bin");
    expect(getSafeExtension("")).toBe("bin");
    expect(getSafeExtension(undefined)).toBe("bin");
  });
});

describe("core/utils/file.utils :: buildRelativeStoragePath", () => {
  it("construit un chemin appCode/année/mois/jour/shard/id.ext", () => {
    const date = new Date(Date.UTC(2026, 6, 3)); // 2026-07-03
    const relPath = buildRelativeStoragePath({
      appCode: "ticketing",
      fileId: "01F8MECHZX3TBDSZ7XR8H8JHAF",
      extension: "pdf",
      date,
    });

    const parts = relPath.split(path.sep);
    expect(parts[0]).toBe("ticketing");
    expect(parts[1]).toBe("2026");
    expect(parts[2]).toBe("07");
    expect(parts[3]).toBe("03");
    expect(parts[4]).toBe("01"); // shard = 2 premiers caractères du fileId
    expect(parts[5]).toBe("01F8MECHZX3TBDSZ7XR8H8JHAF.pdf");
  });
});

describe("core/utils/file.utils :: ensureDirectoryForFile", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "uvcdr-file-utils-"));

  afterAll(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("crée récursivement le dossier parent et retourne le chemin absolu", async () => {
    const absolutePath = await ensureDirectoryForFile(rootDir, "a/b/c/file.txt");
    expect(absolutePath).toBe(path.join(rootDir, "a/b/c/file.txt"));
    expect(existsSync(path.dirname(absolutePath))).toBe(true);
  });

  it("lève une erreur si rootDir ou relativePath est manquant", async () => {
    await expect(ensureDirectoryForFile(null, "a/b")).rejects.toThrow("rootDir is required");
    await expect(ensureDirectoryForFile(rootDir, null)).rejects.toThrow("relativePath is required");
  });
});

describe("core/utils/file.utils :: computeFileSha256", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "uvcdr-file-utils-sha-"));

  afterAll(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("calcule le sha256 correct d'un fichier", async () => {
    const filePath = path.join(rootDir, "sample.txt");
    const content = "contenu de test pour sha256";
    writeFileSync(filePath, content);

    const expected = createHash("sha256").update(content).digest("hex");
    await expect(computeFileSha256(filePath)).resolves.toBe(expected);
  });

  it("rejette si le fichier n'existe pas", async () => {
    await expect(computeFileSha256(path.join(rootDir, "inexistant.txt"))).rejects.toThrow();
  });
});
