import { describe, it, expect } from "vitest";
import { parseToJSON, truncate } from "../../../core/utils/functions.utils.js";

describe("core/utils/functions.utils :: parseToJSON", () => {
  it("retourne false pour null/undefined", () => {
    expect(parseToJSON(null)).toBe(false);
    expect(parseToJSON(undefined)).toBe(false);
  });

  it("retourne la valeur telle quelle si ce n'est pas une chaîne", () => {
    const obj = { a: 1 };
    expect(parseToJSON(obj)).toBe(obj);
    expect(parseToJSON(42)).toBe(42);
    expect(parseToJSON(true)).toBe(true);
  });

  it("parse une chaîne JSON valide", () => {
    expect(parseToJSON('{"a":1}')).toEqual({ a: 1 });
    expect(parseToJSON("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("retourne false pour une chaîne JSON invalide", () => {
    expect(parseToJSON("{invalide")).toBe(false);
    expect(parseToJSON("")).toBe(false);
  });
});

describe("core/utils/functions.utils :: truncate", () => {
  it("laisse une valeur plus courte que la limite inchangée", () => {
    expect(truncate("abc", 10)).toBe("abc");
  });

  it("tronque une valeur plus longue que la limite", () => {
    expect(truncate("a".repeat(50), 10)).toBe("a".repeat(10));
  });

  it("convertit les valeurs non-chaînes en chaîne avant troncature", () => {
    expect(truncate(12345, 3)).toBe("123");
  });

  it("laisse passer null/undefined tel quel (paramètre optionnel)", () => {
    expect(truncate(null, 10)).toBeNull();
    expect(truncate(undefined, 10)).toBeUndefined();
  });
});
