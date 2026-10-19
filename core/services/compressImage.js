// core/services/compressImage.js
import sharp from "sharp";
import fs from "fs/promises";
import { logger } from "../../config/logger.config.js";

// Sous Windows, le cache interne de sharp/libvips peut retenir un descripteur
// ouvert sur le fichier source (et parfois sur le fichier de sortie) au-delà
// de la fin de `toFile()`, tant que ce cache n'est pas vidé. Résultat :
// unlink/rename juste après échouent avec EBUSY/EPERM ("resource busy or
// locked" / "operation not permitted"), alors que sur Linux ça ne pose jamais
// de problème (pas de verrouillage exclusif de ce type côté OS).
// On désactive ce cache : le coût (pas de réutilisation de buffers entre deux
// appels) est négligeable ici puisque chaque upload traite une image
// différente d'un utilisateur différent.
sharp.cache(false);

const SUPPORTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);
const MIN_GAIN_RATIO = 0.95; // on remplace uniquement si on gagne > 5%

// Délais avant nouvelle tentative si le fichier est encore verrouillé
// (antivirus/EDR qui scanne le fichier juste après écriture, indexation
// Windows, etc.) : ~1.9s de budget total avant d'abandonner.
const LOCK_RETRY_DELAYS_MS = [50, 100, 250, 500, 1000];

function isTransientLockError(error) {
  return error?.code === "EBUSY" || error?.code === "EPERM" || error?.code === "EACCES";
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exécute une opération fs (unlink/rename) avec retries en cas de verrou
 * transitoire (Windows uniquement en pratique). Relance immédiatement toute
 * autre erreur (fichier absent, permissions définitives, etc.).
 */
async function withLockRetry(operation, description) {
  for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const isLastAttempt = attempt === LOCK_RETRY_DELAYS_MS.length;
      if (!isTransientLockError(error) || isLastAttempt) {
        throw error;
      }
      logger.warn(
        `[compressImage] ${description} : ${error.code}, nouvelle tentative (${attempt + 1}/${LOCK_RETRY_DELAYS_MS.length})`,
      );
      await wait(LOCK_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/**
 * Compresse une image sur disque si le gain est significatif.
 *
 * La compression est un "best effort" : elle ne doit jamais faire échouer
 * l'upload. En cas d'échec (verrou fichier persistant, image corrompue,
 * format inattendu...), on log un warning et on renvoie le fichier original
 * tel quel plutôt que de propager l'erreur.
 *
 * @returns {{ compressed: boolean, originalSize: number, finalSize: number }}
 */
export async function compressImageIfWorthIt(filePath, mimetype) {
  if (!SUPPORTED_TYPES.has(mimetype)) {
    const size = (await fs.stat(filePath)).size;
    return { compressed: false, originalSize: size, finalSize: size };
  }

  const originalSize = (await fs.stat(filePath)).size;
  const tmpOut = `${filePath}.compressed`;

  let instance;
  try {
    instance = sharp(filePath, { failOn: "none" });
    const { format } = await instance.metadata();

    switch (format) {
      case "jpeg":
        await instance.jpeg({ quality: 82, progressive: true, mozjpeg: true }).toFile(tmpOut);
        break;
      case "png":
        await instance.png({ compressionLevel: 8, palette: true }).toFile(tmpOut);
        break;
      case "webp":
        await instance.webp({ quality: 82 }).toFile(tmpOut);
        break;
      case "avif":
        await instance.avif({ quality: 60 }).toFile(tmpOut);
        break;
      default:
        return { compressed: false, originalSize, finalSize: originalSize };
    }

    // Libère explicitement les ressources natives de libvips (dont le
    // descripteur sur `filePath`) avant de toucher au fichier source. C'est
    // ce relâchement tardif, combiné au cache sharp, qui cause les
    // EBUSY/EPERM sous Windows si on rename/unlink immédiatement après.
    instance.destroy();
    instance = undefined;

    const compressedSize = (await fs.stat(tmpOut)).size;

    if (compressedSize < originalSize * MIN_GAIN_RATIO) {
      await withLockRetry(() => fs.rename(tmpOut, filePath), `rename ${tmpOut} -> ${filePath}`);
      return { compressed: true, originalSize, finalSize: compressedSize };
    }

    await withLockRetry(() => fs.unlink(tmpOut), `unlink ${tmpOut}`);
    return { compressed: false, originalSize, finalSize: originalSize };
  } catch (error) {
    instance?.destroy();
    await fs.unlink(tmpOut).catch(() => {});
    logger.warn(
      `[compressImage] Compression ignorée pour ${filePath} (${error.code ?? error.message}) — fichier original conservé.`,
    );
    return { compressed: false, originalSize, finalSize: originalSize };
  }
}
