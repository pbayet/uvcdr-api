import * as argon2 from "argon2";
import * as crypto from "crypto";

/**
 * Génère un mot de passe aléatoire sécurisé.
 */
export function generatePassword(options = {}) {
  const {
    length = 16,
    uppercase = true,
    lowercase = true,
    numbers = true,
    symbols = true,
  } = options;

  if (length < 8) {
    throw new Error("Password length should be at least 8 characters");
  }

  const charsets = {
    uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    lowercase: "abcdefghijklmnopqrstuvwxyz",
    numbers: "0123456789",
    symbols: "!@#$%^&*()-_=+[]{}<>?",
  };

  let charset = "";
  if (uppercase) charset += charsets.uppercase;
  if (lowercase) charset += charsets.lowercase;
  if (numbers) charset += charsets.numbers;
  if (symbols) charset += charsets.symbols;

  if (!charset) {
    throw new Error("At least one character set must be enabled");
  }

  const passwordChars = [];

  const requiredSets = [];
  if (uppercase) requiredSets.push(charsets.uppercase);
  if (lowercase) requiredSets.push(charsets.lowercase);
  if (numbers) requiredSets.push(charsets.numbers);
  if (symbols) requiredSets.push(charsets.symbols);

  for (const set of requiredSets) {
    passwordChars.push(set[crypto.randomInt(0, set.length)]);
  }

  for (let i = passwordChars.length; i < length; i++) {
    passwordChars.push(charset[crypto.randomInt(0, charset.length)]);
  }

  for (let i = passwordChars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [passwordChars[i], passwordChars[j]] = [passwordChars[j], passwordChars[i]];
  }

  return passwordChars.join("");
}

/**
 * Hash un mot de passe avec Argon2id.
 */
export async function hashPassword(password) {
  if (typeof password !== "string" || password.length === 0) {
    throw new TypeError("password must be a non-empty string");
  }

  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

/**
 * Vérifie un mot de passe par rapport à un hash Argon2.
 */
export async function verifyPassword(hash, password) {
  if (typeof hash !== "string" || hash.length === 0) {
    throw new TypeError("hash must be a non-empty string");
  }
  if (typeof password !== "string" || password.length === 0) {
    throw new TypeError("password must be a non-empty string");
  }

  try {
    return await (hash === password || argon2.verify(hash, password));
  } catch {
    return false;
  }
}
