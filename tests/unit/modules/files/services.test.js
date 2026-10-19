import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../../core/utils/db.utils.js", () => ({
  runQuery: vi.fn(),
}));

const { runQuery } = await import("../../../../core/utils/db.utils.js");
const services = await import("../../../../modules/files/services.js");

describe("modules/files/services", () => {
  beforeEach(() => runQuery.mockReset());

  it("getFiles filtre par FILECODE si fourni", async () => {
    runQuery.mockResolvedValue({ recordset: [{ ID: 1 }] });
    await services.getFiles({ FILECODE: "abc" });

    const { query, inputs } = runQuery.mock.calls[0][0];
    expect(query).toContain("WHERE FILECODE = @FILECODE");
    expect(inputs.FILECODE.value).toBe("abc");
  });

  it("getFiles filtre par ENTITYTYPE/ENTITYID si FILECODE absent", async () => {
    runQuery.mockResolvedValue({ recordset: [] });
    await services.getFiles({ ENTITYTYPE: "ticket", ENTITYID: "100" });

    expect(runQuery.mock.calls[0][0].query).toContain("WHERE ENTITYTYPE = @ENTITYTYPE AND ENTITYID = @ENTITYID");
  });

  it("saveMetaAttachment retourne true si une ligne a été insérée", async () => {
    runQuery.mockResolvedValue({ recordset: [{ INSERTED: 1 }] });
    await expect(services.saveMetaAttachment({ FILECODE: "abc" }, false)).resolves.toBe(true);
  });

  it("saveMetaAttachment retourne false si aucune ligne insérée (ignoreIfExist)", async () => {
    runQuery.mockResolvedValue({ recordset: [{ INSERTED: 0 }] });
    await expect(services.saveMetaAttachment({ FILECODE: "abc" }, true)).resolves.toBe(false);
  });

  it("markReadyAttachment retourne toujours true", async () => {
    runQuery.mockResolvedValue({ recordset: [] });
    await expect(services.markReadyAttachment("abc")).resolves.toBe(true);
  });

  it("deleteFileByCode retourne false si le fichier n'existe pas", async () => {
    runQuery.mockResolvedValueOnce({ recordset: [] }); // getFiles → aucun résultat
    await expect(services.deleteFileByCode("inconnu")).resolves.toBe(false);
    expect(runQuery).toHaveBeenCalledOnce(); // pas de requête UPDATE si rien à supprimer
  });

  it("deleteFileByCode marque le fichier comme supprimé s'il existe", async () => {
    runQuery
      .mockResolvedValueOnce({ recordset: [{ ID: 1, FILECODE: "abc" }] }) // getFiles
      .mockResolvedValueOnce({ recordset: [] }); // UPDATE

    await expect(services.deleteFileByCode("abc")).resolves.toBe(true);
    expect(runQuery).toHaveBeenCalledTimes(2);
  });

  it("deleteFileByEntity retourne false si aucun fichier ne correspond", async () => {
    runQuery.mockResolvedValueOnce({ recordset: [] });
    await expect(services.deleteFileByEntity("ticket", "100")).resolves.toBe(false);
  });
});

describe("modules/files/services — purge des PJ supprimées", () => {
  beforeEach(() => runQuery.mockReset());

  it("getAttachmentsToPurge filtre sur DELETEDAT, STATUS et pagine par ID", async () => {
    runQuery.mockResolvedValue({ recordset: [{ ID: 1 }] });
    await expect(services.getAttachmentsToPurge({ retentionMonths: 3, afterId: 5, batchSize: 100 })).resolves.toEqual([{ ID: 1 }]);

    const { query, inputs } = runQuery.mock.calls[0][0];
    expect(query).toContain("DATEADD(MONTH, -@RETENTIONMONTHS, SYSDATETIME())");
    expect(query).toContain("STATUS <> 'PURGED'");
    expect(inputs.AFTERID.value).toBe(5);
    expect(inputs.BATCHSIZE.value).toBe(100);
  });

  it("markPurgedAttachment passe la ligne en STATUS PURGED", async () => {
    runQuery.mockResolvedValue({ recordset: [] });
    await services.markPurgedAttachment(7);

    const { query, inputs } = runQuery.mock.calls[0][0];
    expect(query).toContain("SET STATUS = 'PURGED'");
    expect(inputs.ID.value).toBe(7);
  });
});
