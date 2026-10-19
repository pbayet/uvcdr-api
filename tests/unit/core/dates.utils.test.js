import { describe, it, expect } from "vitest";
import { utcToParisIso } from "../../../core/utils/dates.utils.js";

describe("core/utils/dates.utils :: utcToParisIso", () => {
  it("retourne null pour une entrée vide", () => {
    expect(utcToParisIso(null)).toBeNull();
    expect(utcToParisIso(undefined)).toBeNull();
    expect(utcToParisIso("")).toBeNull();
  });

  it("retourne null pour une date invalide", () => {
    expect(utcToParisIso("pas-une-date")).toBeNull();
    expect(utcToParisIso("2026-99-99")).toBeNull();
  });

  it("applique l'offset hiver (+01:00)", () => {
    // 15 janvier 10:00 UTC → 11:00 à Paris (UTC+1, hors DST)
    expect(utcToParisIso("2026-01-15T10:00:00.000Z")).toBe("2026-01-15T11:00:00+01:00");
  });

  it("applique l'offset été (+02:00, DST)", () => {
    // 15 juillet 10:00 UTC → 12:00 à Paris (UTC+2, DST actif)
    expect(utcToParisIso("2026-07-15T10:00:00.000Z")).toBe("2026-07-15T12:00:00+02:00");
  });

  it("accepte directement un objet Date", () => {
    const d = new Date("2026-01-15T10:00:00.000Z");
    expect(utcToParisIso(d)).toBe("2026-01-15T11:00:00+01:00");
  });
});
