import { describe, it, expect } from "vitest";
import { ERROR_REGISTRY } from "../../../core/utils/error.registry.js";

describe("core/utils/error.registry :: invariants", () => {
  const entries = Object.entries(ERROR_REGISTRY);

  it("chaque entrée a un CODE, un MESSAGE fr/en, une DESCRIPTION fr/en et un HTTP_RESPONSE_CODE valide", () => {
    for (const [key, entry] of entries) {
      expect(typeof entry.CODE, `${key}.CODE`).toBe("number");
      expect(typeof entry.MESSAGE?.fr, `${key}.MESSAGE.fr`).toBe("string");
      expect(typeof entry.MESSAGE?.en, `${key}.MESSAGE.en`).toBe("string");
      expect(typeof entry.DESCRIPTION?.fr, `${key}.DESCRIPTION.fr`).toBe("string");
      expect(typeof entry.DESCRIPTION?.en, `${key}.DESCRIPTION.en`).toBe("string");
      expect(entry.HTTP_RESPONSE_CODE, `${key}.HTTP_RESPONSE_CODE`).toBeGreaterThanOrEqual(400);
      expect(entry.HTTP_RESPONSE_CODE, `${key}.HTTP_RESPONSE_CODE`).toBeLessThan(600);
    }
  });

  it("tous les CODE sont uniques (pas de doublon lors d'un futur ajout)", () => {
    const codes = entries.map(([, entry]) => entry.CODE);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("toutes les clés à placeholder (ex: [TIME]) utilisent la syntaxe [MAJUSCULES]", () => {
    const withPlaceholders = entries.filter(([key]) => key.includes("["));
    for (const [key] of withPlaceholders) {
      expect(key).toMatch(/^[A-Z0-9_]+_\[[A-Z0-9_]+\]$/);
    }
  });
});
