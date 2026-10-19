import path from "node:path";
import fs from "node:fs/promises";
import { ulid } from "ulid";
import * as fileServices from "../../modules/files/services.js";
import { compressImageIfWorthIt } from "./compressImage.js";

import {
  buildRelativeStoragePath,
  ensureDirectoryForFile,
  computeFileSha256,
  sanitizeFilename,
  getSafeExtension,
} from "../utils/file.utils.js";

const API_BASE_UPLOAD_URL = process.env.API_BASE_UPLOAD_URL;

export class StorageService {
  constructor({ rootDir }) {
    this.rootDir = rootDir;
  }

  async saveUploadedFile({ appCode, file, entityType = null, entityId = null, uploadedBy = null, ignoreIfExist = false }) {
    if (!file?.path) {
      throw new Error("Uploaded file missing");
    }

    const fileId = ulid();
    const originalName = sanitizeFilename(file.originalname);
    const extension = getSafeExtension(originalName);

    const relativePath = buildRelativeStoragePath({ appCode, fileId, extension });
    const finalPath = await ensureDirectoryForFile(this.rootDir, relativePath);

    // Compression conditionnelle (images uniquement, si gain > 5%)
    const { finalSize, originalSize, compressed } = await compressImageIfWorthIt(file.path, file.mimetype);

    const checksum = await computeFileSha256(file.path);

    const metadata = {
      FILECODE: fileId,
      APPCODE: appCode,
      ENTITYTYPE: entityType,
      ENTITYID: entityId,
      ORIGINALNAME: originalName,
      STOREDNAME: `${fileId}.${extension}`,
      RELATIVEPATH: relativePath,
      URLPATH: `${API_BASE_UPLOAD_URL}/${relativePath}`.replace(/\\/g, "/"),
      MIMETYPE: file.mimetype,
      EXTENSION: extension,
      COMPRESSED: compressed,
      ORIGINALSIZEBYTES: originalSize,
      SIZEBYTES: finalSize,
      CHECKSUMSHA256: checksum,
      UPLOADEDBY: uploadedBy,
    };

    const inserted = await fileServices.saveMetaAttachment(metadata, ignoreIfExist);

    if (inserted) {
      await fs.rename(file.path, finalPath);
      await fileServices.markReadyAttachment(fileId);
    }

    return { ...metadata, STATUS: "READY" };
  }

  async saveUploadedFiles({ appCode, files, entityType = null, entityId = null, uploadedBy = null, ignoreIfExist = false }) {
    const results = [];

    for (const file of files) {
      results.push(
        await this.saveUploadedFile({ appCode, file, entityType, entityId, uploadedBy, ignoreIfExist }),
      );
    }

    return results;
  }

  getAbsolutePath(relativePath) {
    return path.join(this.rootDir, relativePath);
  }
}
