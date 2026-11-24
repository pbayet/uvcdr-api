import { describe, it, expect } from "vitest";
import {
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
