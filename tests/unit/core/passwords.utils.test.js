import { describe, it, expect } from "vitest";
import {
  generatePassword,
  hashPassword,
  verifyPassword,
} from "../../../core/utils/passwords.utils.js";

describe("core/utils/passwords.utils :: generatePassword", () => {
  it("génère un mot de passe de la longueur demandée", () => {
    expect(generatePassword({ length: 24 })).toHaveLength(24);
  });

  it("génère un mot de passe de 16 caractères par défaut", () => {
    expect(generatePassword()).toHaveLength(16);
  });

  it("respecte les jeux de caractères activés uniquement", () => {
    const pwd = generatePassword({ length: 30, uppercase: false, symbols: false, numbers: false, lowercase: true });
    expect(pwd).toMatch(/^[a-z]+$/);
  });

  it("lève une erreur si la longueur est < 8", () => {
    expect(() => generatePassword({ length: 4 })).toThrow(/at least 8 characters/);
  });

  it("lève une erreur si tous les jeux de caractères sont désactivés", () => {
    expect(() =>
      generatePassword({ uppercase: false, lowercase: false, numbers: false, symbols: false }),
    ).toThrow(/At least one character set/);
  });

  it("génère des mots de passe différents à chaque appel", () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a).not.toBe(b);
  });
});

describe("core/utils/passwords.utils :: hashPassword / verifyPassword", () => {
  it("hash puis vérifie correctement un mot de passe", async () => {
    const hash = await hashPassword("SuperMotDePasse!2026");
    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(hash, "SuperMotDePasse!2026")).resolves.toBe(true);
  });

  it("rejette un mauvais mot de passe sans lever d'exception", async () => {
    const hash = await hashPassword("BonMotDePasse");
    await expect(verifyPassword(hash, "MauvaisMotDePasse")).resolves.toBe(false);
  });

  it("retourne false (et ne lève pas) pour un hash corrompu", async () => {
    await expect(verifyPassword("pas-un-hash-argon2", "quelconque")).resolves.toBe(false);
  });

  it("hashPassword lève une TypeError pour une entrée invalide", async () => {
    await expect(hashPassword("")).rejects.toThrow(TypeError);
    await expect(hashPassword(null)).rejects.toThrow(TypeError);
  });

  it("verifyPassword lève une TypeError pour des arguments invalides", async () => {
    await expect(verifyPassword("", "pwd")).rejects.toThrow(TypeError);
    await expect(verifyPassword("hash", "")).rejects.toThrow(TypeError);
  });
});
