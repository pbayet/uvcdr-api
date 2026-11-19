import { describe, it, expect } from "vitest";
import { formatRefcode, refcodePrefix } from "../../../../modules/procs/utils.js";
import { procedureCreateSchema, procedureUpdateSchema } from "../../../../modules/procs/validators.js";

describe("référence générée", () => {
  it("préfixe d'après la catégorie racine, sans accents", () => {
    expect(refcodePrefix("Qualité")).toBe("PROC-QUA-");
    expect(refcodePrefix("Sécurité")).toBe("PROC-SEC-");
    expect(refcodePrefix("Ressources humaines")).toBe("PROC-RES-");
    expect(refcodePrefix("RH")).toBe("PROC-RH-");
    expect(refcodePrefix("Œ 2 é")).toBe("PROC-E-");
    expect(refcodePrefix("")).toBe("PROC-GEN-");
    expect(refcodePrefix(null)).toBe("PROC-GEN-");
  });

  it("numéro sur 3 chiffres au moins", () => {
    expect(formatRefcode("PROC-QUA-", 1)).toBe("PROC-QUA-001");
    expect(formatRefcode("PROC-QUA-", 42)).toBe("PROC-QUA-042");
    expect(formatRefcode("PROC-QUA-", 1234)).toBe("PROC-QUA-1234");
  });

  it("une référence envoyée par le client est ignorée", () => {
    expect(procedureCreateSchema.parse({ TITLE: "A", CATID: 3, REFCODE: "X" }).REFCODE).toBeUndefined();
    expect(procedureUpdateSchema.parse({ REFCODE: "X" }).REFCODE).toBeUndefined();
  });
});
