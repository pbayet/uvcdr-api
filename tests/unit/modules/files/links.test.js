import { describe, it, expect } from "vitest";
import {
  decryptToken,
  describeTtl,
  encryptToken,
  formatLink,
  effectiveTtl,
  hashToken,
  isTokenShape,
  linkPath,
  newToken,
  parseDuration,
} from "../../../../modules/files/links.js";

const DAY = 86400;

describe("liens directs — durées", () => {
  it("lit secondes et unités (m, h, j/d, sem/w, a/y)", () => {
    expect(parseDuration(3600)).toBe(3600);
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("30m")).toBe(1800);
    expect(parseDuration("12h")).toBe(43200);
    expect(parseDuration("7j")).toBe(7 * DAY);
    expect(parseDuration("7d")).toBe(7 * DAY);
    expect(parseDuration("2w")).toBe(14 * DAY);
    expect(parseDuration("1,5h")).toBe(5400);
    expect(parseDuration("1a")).toBe(365 * DAY);
    expect(parseDuration("bientôt")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });

  const editor = { ALLOWPERMANENT: true, MAXTTL: null, DEFAULTTTL: 7 * DAY };
  const reader = { ALLOWPERMANENT: false, MAXTTL: 7 * DAY, DEFAULTTTL: 7 * DAY };

  it("rédacteur : durée au choix, ou permanent (null)", () => {
    expect(effectiveTtl({ PERMANENT: true }, editor)).toBeNull();
    expect(effectiveTtl({ EXPIRESIN: 365 * DAY }, editor)).toBe(365 * DAY);
    expect(effectiveTtl({}, editor)).toBe(7 * DAY);
  });

  it("lecteur : ni permanent, ni au-delà du maximum", () => {
    expect(() => effectiveTtl({ PERMANENT: true }, reader)).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => effectiveTtl({ EXPIRESIN: 30 * DAY }, reader)).toThrow(expect.objectContaining({ status: 403 }));
    expect(effectiveTtl({ EXPIRESIN: 3600 }, reader)).toBe(3600);
  });

  it("bornes : 1 minute à 10 ans", () => {
    expect(() => effectiveTtl({ EXPIRESIN: 10 }, editor)).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => effectiveTtl({ EXPIRESIN: 3651 * DAY }, editor)).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe("liens directs — jeton et chemin", () => {
  it("jeton de 32 caractères, empreinte SHA-256 stable", () => {
    const { token, hash } = newToken();
    expect(isTokenShape(token)).toBe(true);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hash);
    expect(newToken().token).not.toBe(token);
  });

  it("nom du fichier en fin de chemin seulement si demandé", () => {
    expect(linkPath("t".repeat(32), "Procédure cuves.pdf", true)).toBe(
      `/files/open/${"t".repeat(32)}/Proc%C3%A9dure%20cuves.pdf`,
    );
    expect(linkPath("t".repeat(32), "a.pdf", false)).toBe(`/files/open/${"t".repeat(32)}`);
  });
});

describe("liens directs — libellé de validité (journal)", () => {
  it("unité la plus grande qui tombe juste", () => {
    expect(describeTtl(null)).toBe("permanent");
    expect(describeTtl(7 * DAY)).toBe("7 jours");
    expect(describeTtl(DAY)).toBe("1 jour");
    expect(describeTtl(365 * DAY)).toBe("1 an");
    expect(describeTtl(36 * 3600)).toBe("36 heures");
    expect(describeTtl(90)).toBe("90 secondes");
  });
});

describe("liens directs — jeton chiffré (recopie depuis la liste)", () => {
  it("aller-retour, valeur courte, chiffrement différent à chaque fois", () => {
    const { token } = newToken();
    const enc = encryptToken(token);
    expect(enc).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(enc.length).toBeLessThanOrEqual(200);
    expect(decryptToken(enc)).toBe(token);
    expect(encryptToken(token)).not.toBe(enc);
  });

  it("valeur altérée ou absente → null", () => {
    const enc = encryptToken(newToken().token);
    const [v, iv, tag, data] = enc.split(".");
    const altered = `${v}.${iv}.${tag}.${data.slice(0, -2)}${data.endsWith("AA") ? "BB" : "AA"}`;
    expect(decryptToken(altered)).toBeNull();
    expect(decryptToken(null)).toBeNull();
    expect(decryptToken("n'importe quoi")).toBeNull();
  });

  it("PATH seulement sur demande, jamais le jeton chiffré", () => {
    const token = "t".repeat(32);
    const row = { LNKID: 1, TOKENENC: encryptToken(token), FILENAME: "a.pdf", WITHNAME: 1, STATUS: "ACTIVE" };
    expect(formatLink(row, { withPath: true }).PATH).toBe(`/files/open/${token}/a.pdf`);
    expect(formatLink(row)).not.toHaveProperty("PATH");
    expect(formatLink(row, { withPath: true })).not.toHaveProperty("TOKENENC");
    expect(formatLink({ ...row, TOKENENC: null }, { withPath: true }).PATH).toBeNull();
  });
});
