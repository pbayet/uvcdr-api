import { describe, it, expect } from "vitest";
import {
  ticketCreateSchema,
  ticketUpdateSchema,
  ticketDeleteSchema,
  categoryCreateSchema,
  noteCreateSchema,
  noteUpdateSchema,
  serviceMemberSchema,
} from "../../../../modules/ticketing/validators.js";

describe("modules/ticketing/validators :: ticketCreateSchema", () => {
  it("accepte un payload minimal valide", () => {
    const result = ticketCreateSchema.safeParse({ TITLE: "Imprimante HS", SRVID: "10" });
    expect(result.success).toBe(true);
    expect(result.data.SRVID).toBe(10); // coercion string → number
  });

  it("rejette un TITLE vide", () => {
    const result = ticketCreateSchema.safeParse({ TITLE: "   ", SRVID: 10 });
    expect(result.success).toBe(false);
  });

  it("rejette un SRVID manquant", () => {
    const result = ticketCreateSchema.safeParse({ TITLE: "Imprimante HS" });
    expect(result.success).toBe(false);
  });

  it("accepte DESCR null/absent (nullish)", () => {
    expect(ticketCreateSchema.safeParse({ TITLE: "T", SRVID: 1, DESCR: null }).success).toBe(true);
    expect(ticketCreateSchema.safeParse({ TITLE: "T", SRVID: 1 }).success).toBe(true);
  });

  it("rejette un TITLE de plus de 255 caractères", () => {
    const result = ticketCreateSchema.safeParse({ TITLE: "a".repeat(256), SRVID: 1 });
    expect(result.success).toBe(false);
  });
});

describe("modules/ticketing/validators :: ticketUpdateSchema", () => {
  it("exige TCKNUM", () => {
    expect(ticketUpdateSchema.safeParse({}).success).toBe(false);
    expect(ticketUpdateSchema.safeParse({ TCKNUM: "TCK-000100" }).success).toBe(true);
  });

  it("coerce SRVCHD en booléen", () => {
    const result = ticketUpdateSchema.safeParse({ TCKNUM: "TCK-000100", SRVCHD: "true" });
    expect(result.data.SRVCHD).toBe(true);
  });
});

describe("modules/ticketing/validators :: ticketDeleteSchema", () => {
  it("exige TCKNUM et coerce DLTD/PERM", () => {
    // z.coerce.boolean() applique Boolean(x) : toute chaîne non vide (même
    // "false") devient `true`. Seule une chaîne VIDE, 0, ou un booléen déjà
    // typé donnent `false` — cf. https://zod.dev/?id=booleans.
    const result = ticketDeleteSchema.safeParse({ TCKNUM: "TCK-000100", DLTD: "1", PERM: "" });
    expect(result.success).toBe(true);
    expect(result.data.DLTD).toBe(true);
    expect(result.data.PERM).toBe(false);
  });

  it("coerce la chaîne 'false' en true (particularité de z.coerce.boolean)", () => {
    const result = ticketDeleteSchema.safeParse({ TCKNUM: "TCK-000100", PERM: "false" });
    expect(result.data.PERM).toBe(true);
  });
});

describe("modules/ticketing/validators :: categoryCreateSchema", () => {
  it("exige NAME non vide", () => {
    expect(categoryCreateSchema.safeParse({ NAME: "" }).success).toBe(false);
    expect(categoryCreateSchema.safeParse({ NAME: "Réseau" }).success).toBe(true);
  });
});

describe("modules/ticketing/validators :: noteCreateSchema / noteUpdateSchema", () => {
  it("exige TCKID et un commentaire non vide", () => {
    expect(noteCreateSchema.safeParse({ TCKID: 1, CMNT: "" }).success).toBe(false);
    expect(noteCreateSchema.safeParse({ TCKID: 1, CMNT: "Note valide" }).success).toBe(true);
  });

  it("exige NTEID pour la mise à jour", () => {
    expect(noteUpdateSchema.safeParse({ CMNT: "x" }).success).toBe(false);
    expect(noteUpdateSchema.safeParse({ NTEID: 5, CMNT: "x" }).success).toBe(true);
  });
});

describe("modules/ticketing/validators :: serviceMemberSchema", () => {
  it("exige un USRID numérique", () => {
    expect(serviceMemberSchema.safeParse({}).success).toBe(false);
    expect(serviceMemberSchema.safeParse({ USRID: "7" }).data.USRID).toBe(7);
  });
});
