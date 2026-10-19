// core/services/attachmentSigning.service.js
//
// Calcul/vérification des signatures HMAC-SHA256 des pièces jointes
// (cf. modules/files/sql/ATTACHMENTSIGNATURES.table.sql pour le schéma et
// les motivations détaillées).
//
// Rotation de clé : ATTACHMENT_SIGNING_KEY_VERSION désigne la version
// "courante" utilisée pour SIGNER une nouvelle pièce jointe.
// ATTACHMENT_SIGNING_SECRET_<VERSION> (une variable par version, ex.
// ATTACHMENT_SIGNING_SECRET_V1) fournit le secret de CETTE version — pour
// vérifier une signature ancienne, on relit KEYVERSION en base et on va
// chercher le secret correspondant, jamais le secret courant. Pour faire
// tourner la clé : ajouter ATTACHMENT_SIGNING_SECRET_V2, ne PAS retirer
// ATTACHMENT_SIGNING_SECRET_V1 (sinon les signatures existantes deviennent
// invérifiables), puis basculer ATTACHMENT_SIGNING_KEY_VERSION="V2".
import { createHmac, timingSafeEqual } from "node:crypto";

function getSecretForVersion(keyVersion) {
  if (!keyVersion) {
    throw new Error("ATTACHMENT_SIGNING_KEY_VERSION_REQUIRED");
  }

  const secret = process.env[`ATTACHMENT_SIGNING_SECRET_${keyVersion.toUpperCase()}`];

  if (!secret) {
    throw new Error(`ATTACHMENT_SIGNING_SECRET_MISSING_FOR_VERSION_${keyVersion}`);
  }

  return secret;
}

export function getCurrentKeyVersion() {
  const version = process.env.ATTACHMENT_SIGNING_KEY_VERSION;

  if (!version) {
    throw new Error("ATTACHMENT_SIGNING_KEY_VERSION_NOT_CONFIGURED");
  }

  return version;
}

/**
 * Signe un hash SHA256 (hex, ATTACHMENTS.CHECKSUMSHA256) avec le secret de
 * la version demandée (par défaut : la version courante).
 * @returns {Buffer} digest HMAC-SHA256 (32 octets)
 */
export function computeSignature(sha256Hex, keyVersion = getCurrentKeyVersion()) {
  if (!sha256Hex) {
    throw new Error("SHA256_HASH_REQUIRED");
  }

  const secret = getSecretForVersion(keyVersion);

  return createHmac("sha256", secret).update(sha256Hex, "utf8").digest();
}

/**
 * Vérifie qu'une valeur de signature correspond bien au hash signé, pour la
 * version de clé enregistrée avec cette signature — comparaison en temps
 * constant (timingSafeEqual) pour ne pas fuiter d'information via le timing.
 */
export function verifySignatureValue(sha256Hex, keyVersion, signatureValue) {
  const expected = computeSignature(sha256Hex, keyVersion);
  const provided = Buffer.isBuffer(signatureValue) ? signatureValue : Buffer.from(signatureValue);

  if (expected.length !== provided.length) return false;

  return timingSafeEqual(expected, provided);
}
