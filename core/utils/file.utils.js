import path from "node:path";
import fsAsync from "node:fs/promises";
import fsSync from "node:fs";
import { createHash } from "node:crypto";

export function sanitizeFilename(filename) {
  if (!filename) return "file";

  const base = path.basename(filename);

  return base
    .normalize("NFKD")
    .replace(/[^\w.\-()\s]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 150);
}

export function getSafeExtension(filename) {
  const ext = path
    .extname(filename || "")
    .toLowerCase()
    .replace(".", "");

  return ext || "bin";
}

export function buildRelativeStoragePath({ appCode, fileId, extension, date = new Date() }) {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  const shard = fileId.slice(0, 2);

  return path.join(appCode, year, month, day, shard, `${fileId}.${extension}`);
}

export async function ensureDirectoryForFile(rootDir, relativePath) {
  if (!rootDir) throw new Error("rootDir is required");
  if (!relativePath) throw new Error("relativePath is required");

  const absolutePath = path.join(rootDir, relativePath);
  const directoryPath = path.dirname(absolutePath);

  await fsAsync.mkdir(directoryPath, { recursive: true });

  return absolutePath;
}

export function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fsSync.createReadStream(filePath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
