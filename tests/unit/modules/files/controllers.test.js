import { describe, it, expect, vi, beforeEach } from "vitest";

const saveUploadedFilesMock = vi.fn();

// Une vraie `class` (plutôt que vi.fn().mockImplementation(...)) est
// nécessaire ici : un mock construit avec `new` via vi.fn() ne relaie pas
// toujours correctement l'objet retourné par l'implémentation (le `this`
// de l'instance mockée se retrouve alors sans `saveUploadedFiles`).
vi.mock("../../../../core/services/storage.service.js", () => ({
  StorageService: class {
    saveUploadedFiles(...args) {
      return saveUploadedFilesMock(...args);
    }
  },
}));
vi.mock("../../../../modules/files/services.js");

const services = await import("../../../../modules/files/services.js");
const controllers = await import("../../../../modules/files/controllers.js");

function buildReq({ body = {}, files = [], payload = { data: { LastName: "Dupont", FirstName: "Jean" } } } = {}) {
  return { method: "POST", body, files, payload, params: {}, query: {}, headers: {} };
}

describe("modules/files/controllers :: uploadFiles", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejette si aucun fichier n'est fourni", async () => {
    const req = buildReq({ body: { appcode: "ticketing", entityid: "1", entitytyp: "ticket" }, files: [] });

    let caught;
    try {
      await controllers.uploadFiles(req);
    } catch (err) {
      caught = err;
    }
    expect(caught.status).toBe(400);
  });

  it("rejette un payload invalide (appcode manquant)", async () => {
    const req = buildReq({ body: {}, files: [{ originalname: "a.png" }] });
    await expect(controllers.uploadFiles(req)).rejects.toThrow();
  });

  it("délègue à StorageService.saveUploadedFiles avec les métadonnées attendues", async () => {
    saveUploadedFilesMock.mockResolvedValue([{ FILECODE: "abc" }]);

    const req = buildReq({
      body: { appcode: "ticketing", entityid: "100", entitytyp: "ticket" },
      files: [{ originalname: "a.png", path: "/tmp/a.png", mimetype: "image/png" }],
    });

    const result = await controllers.uploadFiles(req);

    expect(result).toEqual([{ FILECODE: "abc" }]);
    expect(saveUploadedFilesMock).toHaveBeenCalledWith(
      expect.objectContaining({ appCode: "ticketing", entityId: "100", entityType: "ticket", uploadedBy: "Dupont Jean" }),
    );
  });

  it("uploadedBy est null si le nom/prénom sont absents du payload", async () => {
    saveUploadedFilesMock.mockResolvedValue([]);
    const req = buildReq({
      body: { appcode: "ticketing", entityid: "100", entitytyp: "ticket" },
      files: [{ originalname: "a.png", path: "/tmp/a.png", mimetype: "image/png" }],
      payload: null,
    });

    await controllers.uploadFiles(req);

    expect(saveUploadedFilesMock).toHaveBeenCalledWith(expect.objectContaining({ uploadedBy: null }));
  });
});

describe("modules/files/controllers :: deleteFiles", () => {
  beforeEach(() => vi.clearAllMocks());

  it("supprime par filecode et par entité, puis retourne true", async () => {
    services.deleteFileByEntity.mockResolvedValue(true);
    services.deleteFileByCode.mockResolvedValue(true);

    const req = buildReq({
      body: {
        metas: JSON.stringify([{ filecode: "abc" }, { entity: { entityName: "ticket", entityId: "100" } }]),
      },
    });

    await expect(controllers.deleteFiles(req)).resolves.toBe(true);
    expect(services.deleteFileByCode).toHaveBeenCalledWith("abc");
    expect(services.deleteFileByEntity).toHaveBeenCalledWith("ticket", "100");
  });

  it("accepte metas déjà sous forme de tableau (pas seulement une chaîne JSON)", async () => {
    services.deleteFileByCode.mockResolvedValue(true);
    const req = buildReq({ body: { metas: [{ filecode: "xyz" }] } });

    await controllers.deleteFiles(req);
    expect(services.deleteFileByCode).toHaveBeenCalledWith("xyz");
  });
});

describe("modules/files/controllers :: signFileAttachment", () => {
  beforeEach(() => vi.clearAllMocks());

  function buildSignReq({ filecode = "FILE1", payload }) {
    return {
      method: "POST",
      body: {},
      files: [],
      payload,
      params: { filecode },
      query: {},
      headers: {},
    };
  }

  it("signe avec le nom du staff (LastName/FirstName) quand le token n'est pas une cave", async () => {
    services.getFiles.mockResolvedValue([
      { ID: 1, ENTITYTYPE: "TCKCOD", ENTITYID: "T1", DELETEDAT: null },
    ]);
    services.signAttachment.mockResolvedValue({ SIGID: 1, STATUS: "VALID" });

    const req = buildSignReq({
      payload: { application: "DCLDESK", data: { LastName: "Dupont", FirstName: "Jean" } },
    });

    await controllers.signFileAttachment(req);

    expect(services.signAttachment).toHaveBeenCalledWith("FILE1", "Dupont Jean");
    // Pas de vérification cave (getFolderCaveId) pour un token staff.
    expect(services.getFolderCaveId).not.toHaveBeenCalled();
  });

  it("rejette (403) si l'utilisateur n'est identifiable ni par Nom/Prénom ni par CAVENOM", async () => {
    const req = buildSignReq({ payload: { application: "DCLDESK", data: {} } });

    let caught;
    try {
      await controllers.signFileAttachment(req);
    } catch (err) {
      caught = err;
    }

    expect(caught.status).toBe(403);
    expect(services.signAttachment).not.toHaveBeenCalled();
  });

  it("une cave (DCLING) signe avec CAVENOM les PJ 'du dossier' (ENTITYTYPE NUMDOS) de SON PROPRE dossier", async () => {
    services.getFiles.mockResolvedValue([
      { ID: 1, ENTITYTYPE: "NUMDOS", ENTITYID: "DOS-1", DELETEDAT: null },
    ]);
    services.getFolderCaveId.mockResolvedValue(42);
    services.signAttachment.mockResolvedValue({ SIGID: 1, STATUS: "VALID" });

    const req = buildSignReq({
      payload: { application: "DCLING", data: { id: 42, CAVENOM: "Cave Test" } },
    });

    await controllers.signFileAttachment(req);

    expect(services.getFolderCaveId).toHaveBeenCalledWith("DOS-1");
    expect(services.signAttachment).toHaveBeenCalledWith("FILE1", "Cave Test");
  });

  it("rejette une cave qui tente de signer la PJ 'du dossier' d'une AUTRE cave", async () => {
    services.getFiles.mockResolvedValue([
      { ID: 1, ENTITYTYPE: "NUMDOS", ENTITYID: "DOS-1", DELETEDAT: null },
    ]);
    services.getFolderCaveId.mockResolvedValue(99); // dossier appartient à une autre cave

    const req = buildSignReq({
      payload: { application: "DCLING", data: { id: 42, CAVENOM: "Cave Test" } },
    });

    await expect(controllers.signFileAttachment(req)).rejects.toThrow("ACCESS_DENIED_WO_LOGOUT");
    expect(services.signAttachment).not.toHaveBeenCalled();
  });

  it("rejette une cave qui tente de signer une PJ hors dossier (ex: ENTITYTYPE TCKCOD)", async () => {
    services.getFiles.mockResolvedValue([
      { ID: 1, ENTITYTYPE: "TCKCOD", ENTITYID: "T1", DELETEDAT: null },
    ]);

    const req = buildSignReq({
      payload: { application: "DCLING", data: { id: 42, CAVENOM: "Cave Test" } },
    });

    await expect(controllers.signFileAttachment(req)).rejects.toThrow("ACCESS_DENIED_WO_LOGOUT");
    expect(services.getFolderCaveId).not.toHaveBeenCalled();
    expect(services.signAttachment).not.toHaveBeenCalled();
  });
});
