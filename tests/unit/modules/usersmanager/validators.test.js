import { describe, it, expect } from "vitest";
import {
  userQuerySchema,
  permissionQuerySchema,
  upsertUserSchema,
  upsertServiceSchema,
  upsertPositionSchema,
  servicePositionPatchSchema,
} from "../../../../modules/usersmanager/validators.js";

describe("modules/usersmanager/validators :: userQuerySchema", () => {
  it("exige au moins un des paramètres email/id/poscod", () => {
    expect(userQuerySchema.safeParse({}).success).toBe(false);
    expect(userQuerySchema.safeParse({ email: "a@b.com" }).success).toBe(true);
    expect(userQuerySchema.safeParse({ id: "5" }).success).toBe(true);
    expect(userQuerySchema.safeParse({ poscod: "TECH" }).success).toBe(true);
  });

  it("rejette un email invalide", () => {
    expect(userQuerySchema.safeParse({ email: "pas-un-email" }).success).toBe(false);
  });
});

describe("modules/usersmanager/validators :: permissionQuerySchema", () => {
  it("exige un lvl numérique", () => {
    expect(permissionQuerySchema.safeParse({}).success).toBe(false);
    expect(permissionQuerySchema.safeParse({ lvl: "4" }).data.lvl).toBe(4);
  });
});

describe("modules/usersmanager/validators :: upsertUserSchema", () => {
  it("exige LSTNAM, FSTNAM et un EMAIL valide", () => {
    expect(upsertUserSchema.safeParse({ LSTNAM: "Dupont", FSTNAM: "Jean", EMAIL: "jean@test.com" }).success).toBe(
      true,
    );
    expect(upsertUserSchema.safeParse({ LSTNAM: "", FSTNAM: "Jean", EMAIL: "jean@test.com" }).success).toBe(
      false,
    );
    expect(upsertUserSchema.safeParse({ LSTNAM: "Dupont", FSTNAM: "Jean", EMAIL: "invalide" }).success).toBe(
      false,
    );
  });

  it("accepte GRPIDS/PERMISSIONS/SUBORDINATES en tableau ou en chaîne JSON", () => {
    const base = { LSTNAM: "Dupont", FSTNAM: "Jean", EMAIL: "jean@test.com" };
    expect(upsertUserSchema.safeParse({ ...base, GRPIDS: [1, 2] }).success).toBe(true);
    expect(upsertUserSchema.safeParse({ ...base, GRPIDS: "[1,2]" }).success).toBe(true);
  });
});

describe("modules/usersmanager/validators :: upsertServiceSchema / upsertPositionSchema", () => {
  it("exige SRVCOD et SRVNAM pour un service", () => {
    expect(upsertServiceSchema.safeParse({ SRVCOD: "SUP", SRVNAM: "Support" }).success).toBe(true);
    expect(upsertServiceSchema.safeParse({ SRVNAM: "Support" }).success).toBe(false);
  });

  it("exige POSNAM/POSCOD/POSLVL/SRVCOD pour une position", () => {
    const result = upsertPositionSchema.safeParse({
      POSNAM: "Technicien",
      POSCOD: "TECH",
      POSLVL: "3",
      SRVCOD: "SUP",
    });
    expect(result.success).toBe(true);
    expect(result.data.POSLVL).toBe(3);
  });
});

describe("modules/usersmanager/validators :: servicePositionPatchSchema", () => {
  it("exige SRVCOD et POSID", () => {
    expect(servicePositionPatchSchema.safeParse({ SRVCOD: "SUP", POSID: "1" }).success).toBe(true);
    expect(servicePositionPatchSchema.safeParse({ SRVCOD: "SUP" }).success).toBe(false);
  });
});
