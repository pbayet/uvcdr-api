import { describe, it, expect } from "vitest";
import { uploadFilesSchema, deleteFilesSchema, formatFiles } from "../../../../modules/files/utils.js";

describe("modules/files/utils :: uploadFilesSchema", () => {
  it("accepte un payload valide", () => {
    const result = uploadFilesSchema.safeParse({ appcode: "ticketing", entityid: "100", entitytyp: "ticket" });
    expect(result.success).toBe(true);
  });

  it("rejette un appcode avec des caractères interdits", () => {
    const result = uploadFilesSchema.safeParse({ appcode: "ticket ing!", entityid: "100", entitytyp: "ticket" });
    expect(result.success).toBe(false);
  });

  it("rejette un appcode trop court", () => {
    expect(uploadFilesSchema.safeParse({ appcode: "a", entityid: "1", entitytyp: "t" }).success).toBe(false);
  });

  it("exige entityid et entitytyp", () => {
    expect(uploadFilesSchema.safeParse({ appcode: "ticketing" }).success).toBe(false);
  });
});

describe("modules/files/utils :: deleteFilesSchema", () => {
  it("accepte un filecode seul", () => {
    const result = deleteFilesSchema.safeParse({ metas: [{ filecode: "abc123" }] });
    expect(result.success).toBe(true);
  });

  it("accepte une entité (entityName/entityId)", () => {
    const result = deleteFilesSchema.safeParse({ metas: [{ entity: { entityName: "ticket", entityId: "100" } }] });
    expect(result.success).toBe(true);
  });

  it("accepte un tableau vide", () => {
    expect(deleteFilesSchema.safeParse({ metas: [] }).success).toBe(true);
  });

  it("rejette une entité incomplète", () => {
    const result = deleteFilesSchema.safeParse({ metas: [{ entity: { entityName: "ticket" } }] });
    expect(result.success).toBe(false);
  });
});

describe("modules/files/utils :: formatFiles", () => {
  it("retourne un tableau vide pour une entrée vide", async () => {
    expect(await formatFiles([])).toEqual([]);
    expect(await formatFiles(null)).toEqual([]);
  });

  it("normalise les types (booléens, nombres) et déduplique par ID", async () => {
    const rows = [
      { ID: 1, FILECODE: "abc", COMPRESSED: 1, ORIGINALSIZEBYTES: "2048", SIZEBYTES: "1024" },
      { ID: 1, FILECODE: "abc", COMPRESSED: 1, ORIGINALSIZEBYTES: "2048", SIZEBYTES: "1024" },
    ];

    const result = await formatFiles(rows);
    expect(result).toHaveLength(1);
    expect(result[0].COMPRESSED).toBe(true);
    expect(result[0].SIZEBYTES).toBe(1024);
  });
});
