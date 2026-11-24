import { describe, it, expect } from "vitest";
import { signFileLink, verifyFileLink } from "../../../../modules/procs/links.js";

const NOW = Date.UTC(2026, 10, 24);
const DAY = 86400 * 1000;

describe("liens directs signés", () => {
  it("aller-retour : version en vigueur, document d'origine", () => {
    const { TOKEN, EXPIRES } = signFileLink({ PRCID: 7, KIND: "original", USRID: 12 }, NOW);
    expect(TOKEN).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(EXPIRES.getTime()).toBe(NOW + 7 * DAY);
    expect(verifyFileLink(TOKEN, NOW)).toEqual({ PRCID: 7, VERNUM: null, KIND: "original", USRID: 12 });
  });

  it("aller-retour : version précise, aperçu PDF", () => {
    const { TOKEN } = signFileLink({ PRCID: 7, VERNUM: 2, KIND: "preview", USRID: 12 }, NOW);
    expect(verifyFileLink(TOKEN, NOW)).toEqual({ PRCID: 7, VERNUM: 2, KIND: "preview", USRID: 12 });
  });

  it("lien expiré → 410", () => {
    const { TOKEN } = signFileLink({ PRCID: 7, KIND: "original", USRID: 12 }, NOW);
    expect(() => verifyFileLink(TOKEN, NOW + 7 * DAY)).toThrow(expect.objectContaining({ status: 410 }));
  });

  it("charge utile modifiée (autre procédure) → 404", () => {
    const { TOKEN } = signFileLink({ PRCID: 7, KIND: "original", USRID: 12 }, NOW);
    const [, signature] = TOKEN.split(".");
    const forged = Buffer.from(`8.0.0.12.${NOW / 1000 + 86400}`).toString("base64url");
    expect(() => verifyFileLink(`${forged}.${signature}`, NOW)).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("jeton mal formé → 404", () => {
    for (const bad of ["", "abc", "a.b.c", "a.b"]) {
      expect(() => verifyFileLink(bad, NOW)).toThrow(expect.objectContaining({ status: 404 }));
    }
  });
});
