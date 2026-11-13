import { describe, it, expect, vi, beforeEach } from "vitest";

// Temps réel declcav (broadcastDeclcav) : évènements réduits aux
// identifiants, envoyés aux internes (broadcastToAll) et à la cave concernée
// (broadcastToCaves), jamais à une autre cave.

vi.mock("../../../../modules/declcav/services.js");
vi.mock("../../../../modules/declcav/utils.js");
vi.mock("../../../../modules/declcav/audits/services.js");
vi.mock("../../../../modules/declcav/audits/utils.js");
vi.mock("../../../../config/websocket/wsManager.js", () => ({
  broadcastToAll: vi.fn(),
  broadcastToUsers: vi.fn(),
  broadcastToApps: vi.fn(),
  broadcastToCaves: vi.fn(),
}));
vi.mock("../../../../core/services/mail.service.js", () => ({
  sendTemplatedMail: vi.fn().mockResolvedValue(undefined),
  renderDetailGroups: vi.fn(() => ""),
  renderNoticeList: vi.fn(() => ""),
  renderFolderList: vi.fn(() => ""),
}));
vi.mock("../../../../core/utils/passwords.utils.js", () => ({
  generatePassword: vi.fn().mockResolvedValue("Xk8pQ2mZ"),
  hashPassword: vi.fn().mockResolvedValue("hash"),
}));

const services = await import("../../../../modules/declcav/services.js");
const utils = await import("../../../../modules/declcav/utils.js");
const auditServices = await import("../../../../modules/declcav/audits/services.js");
const auditUtils = await import("../../../../modules/declcav/audits/utils.js");
const { broadcastToAll, broadcastToCaves } = await import(
  "../../../../config/websocket/wsManager.js"
);
const controllers = await import("../../../../modules/declcav/controllers.js");
const auditControllers = await import(
  "../../../../modules/declcav/audits/controllers.js"
);

const STAFF = { data: { id: 1, LastName: "Dupont", FirstName: "Jean" } };
const CAVE = { data: { id: 42 }, isCave: true, application: "DCLING" };

function buildReq({ payload = STAFF, body = {}, params = {} } = {}) {
  return { method: "POST", payload, body, params, query: {}, headers: {} };
}

const folder = (NUMDOS, CAVEID = 42) => ({
  ent: { NUMDOS, DESA2: "Chardonnay" },
  cave: { CAVEID, MAILS: [] },
  ingres: [],
});

/** Évènement envoyé aux internes (dernier appel de broadcastToAll). */
const sentToAll = () => broadcastToAll.mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  utils.formatFolders.mockReturnValue([]);
  utils.formatCaves.mockReturnValue([]);
  utils.formatResponses.mockReturnValue([]);
  utils.formatIngredients.mockReturnValue([]);
  utils.formatRelaunchData.mockReturnValue([]);
  utils.formatQuestRelaunchData.mockReturnValue([]);
});

describe("modules/declcav/controllers :: broadcastDeclcav", () => {
  it("diffuse aux internes et à la cave concernée", () => {
    controllers.broadcastDeclcav("declcav.folder.updated", { NUMDOS: "D/1" }, { caveId: 42 });

    const message = { type: "declcav.folder.updated", payload: { NUMDOS: "D/1" } };
    expect(broadcastToAll).toHaveBeenCalledWith(message);
    expect(broadcastToCaves).toHaveBeenCalledWith([42], message);
  });

  it("sans cave connue : internes uniquement", () => {
    controllers.broadcastDeclcav("declcav.cave.deleted", { CAVEID: 3 });
    expect(broadcastToAll).toHaveBeenCalledTimes(1);
    expect(broadcastToCaves).not.toHaveBeenCalled();
  });

  it("ne lève jamais (best-effort)", () => {
    broadcastToAll.mockImplementationOnce(() => {
      throw new Error("ws down");
    });
    expect(() =>
      controllers.broadcastDeclcav("declcav.folder.updated", { NUMDOS: "D/1" }),
    ).not.toThrow();
  });
});

describe("modules/declcav/controllers :: écritures dossiers", () => {
  it("setDeclaration → declcav.folder.created vers la cave du dossier", async () => {
    services.setDeclaration.mockResolvedValue("D/1/0");
    utils.formatFolders.mockReturnValue([folder("D/1/0", 7)]);

    await controllers.setDeclaration(
      buildReq({ body: { REFMAR: "MRV1", CAVEID: 7, DESA2: "X", QTEMRV: 10 } }),
    );

    expect(sentToAll()).toEqual({
      type: "declcav.folder.created",
      payload: { NUMDOS: "D/1/0" },
    });
    expect(broadcastToCaves).toHaveBeenCalledWith([7], sentToAll());
  });

  it("setRectification → declcav.folder.created avec OLDNUMDOS", async () => {
    utils.formatFolders.mockReturnValue([folder("D/1/1", 7)]);

    await controllers.setRectification(
      buildReq({ body: { NUMDOS: "D/1/0", DONE: true } }),
    );

    expect(sentToAll()).toEqual({
      type: "declcav.folder.created",
      payload: { NUMDOS: "D/1/1", OLDNUMDOS: "D/1/0" },
    });
    expect(broadcastToCaves).toHaveBeenCalledWith([7], sentToAll());
  });

  it("setMrvIngredients → declcav.folder.updated", async () => {
    utils.formatFolders.mockReturnValue([folder("D/1/0", 42)]);

    await controllers.setMrvIngredients(
      buildReq({ payload: CAVE, body: { NUMDOS: "D/1/0", VALDDATE: "", DONE: false } }),
    );

    expect(sentToAll()).toEqual({
      type: "declcav.folder.updated",
      payload: { NUMDOS: "D/1/0" },
    });
    expect(broadcastToCaves).toHaveBeenCalledWith([42], sentToAll());
  });

  it("setMrvIngredients sur une rectification non terminée : rien n'est écrit, rien n'est diffusé", async () => {
    await controllers.setMrvIngredients(
      buildReq({ body: { NUMDOS: "D/1/0", VALDDATE: "", ISRECT: true, DONE: false } }),
    );
    expect(broadcastToAll).not.toHaveBeenCalled();
  });

  it("deleteDecl → declcav.folder.deleted avec l'état obtenu, sans requête de plus", async () => {
    services.deleteDecl.mockResolvedValue({ CAVEID: 9, DEL: false });

    await controllers.deleteDecl(buildReq({ body: { NUMDOS: "D/1/0" } }));

    expect(sentToAll()).toEqual({
      type: "declcav.folder.deleted",
      payload: { NUMDOS: "D/1/0", DELETED: false },
    });
    expect(broadcastToCaves).toHaveBeenCalledWith([9], sentToAll());
    expect(services.getFolderCaveId).not.toHaveBeenCalled();
  });

  it("relaunchDecl → un seul declcav.folder.relaunched pour toute la relance, internes uniquement", async () => {
    utils.formatRelaunchData.mockReturnValue([
      { CAVEID: 1, MAILS: ["a@x.fr"], NUMDOSS: ["D/1/0", "D/2/0"] },
      { CAVEID: 2, MAILS: ["b@x.fr"], NUMDOSS: ["D/3/0"] },
    ]);

    await controllers.relaunchDecl(buildReq());

    expect(broadcastToAll).toHaveBeenCalledTimes(1);
    expect(sentToAll()).toEqual({
      type: "declcav.folder.relaunched",
      payload: { NUMDOSS: ["D/1/0", "D/2/0", "D/3/0"] },
    });
    expect(broadcastToCaves).not.toHaveBeenCalled();
  });

  it("relaunchQuest sans dossier éligible : rien n'est diffusé", async () => {
    await controllers.relaunchQuest(buildReq());
    expect(broadcastToAll).not.toHaveBeenCalled();
  });
});

describe("modules/declcav/controllers :: questionnaires, caves, ingrédients", () => {
  it("upsertResponses par la cave : sa propre cave, sans lecture du dossier", async () => {
    services.upsertResponsesSubmit.mockResolvedValue(15);

    await controllers.upsertResponses(
      buildReq({
        payload: CAVE,
        body: { REFEXT: "D/1/0", RESPONSES: [{ QSTCOD: "Q1" }] },
      }),
    );

    expect(sentToAll()).toEqual({
      type: "declcav.questionnaire.updated",
      payload: { NUMDOS: "D/1/0", SUBID: 15 },
    });
    expect(broadcastToCaves).toHaveBeenCalledWith([42], sentToAll());
    expect(services.getFolderCaveId).not.toHaveBeenCalled();
  });

  it("upsertResponses par la Qualité : cave du dossier (lecture légère)", async () => {
    services.upsertResponsesSubmit.mockResolvedValue(15);
    services.getFolderCaveId.mockResolvedValue(8);

    await controllers.upsertResponses(
      buildReq({ body: { REFEXT: "D/1/0", RESPONSES: [{ QSTCOD: "Q1" }] } }),
    );

    expect(services.getFolderCaveId).toHaveBeenCalledWith("D/1/0");
    expect(broadcastToCaves).toHaveBeenCalledWith([8], sentToAll());
  });

  it("upsertCave : création → internes seulement ; modification → la cave aussi", async () => {
    services.upsertCave.mockResolvedValue(5);

    await controllers.upsertCave(buildReq({ body: { CAVENOM: "Cave", TYPID: 1 } }));
    expect(sentToAll()).toEqual({ type: "declcav.cave.created", payload: { CAVEID: 5 } });
    expect(broadcastToCaves).not.toHaveBeenCalled();

    await controllers.upsertCave(
      buildReq({ body: { CAVEID: 5, CAVENOM: "Cave", TYPID: 1 } }),
    );
    expect(sentToAll()).toEqual({ type: "declcav.cave.updated", payload: { CAVEID: 5 } });
    expect(broadcastToCaves).toHaveBeenCalledWith([5], sentToAll());
  });

  it("deleteCave → declcav.cave.deleted, internes uniquement", async () => {
    await controllers.deleteCave(buildReq({ body: { CAVEID: 5 } }));
    expect(sentToAll()).toEqual({ type: "declcav.cave.deleted", payload: { CAVEID: 5 } });
    expect(broadcastToCaves).not.toHaveBeenCalled();
  });

  it("patchIngredient → declcav.ingredient.updated, internes uniquement", async () => {
    await controllers.patchIngredient(buildReq({ body: { CODE: "SO2", LIBEL: "Sulfites" } }));
    expect(sentToAll()).toEqual({
      type: "declcav.ingredient.updated",
      payload: { CODE: "SO2", IS_CEP: false },
    });
    expect(broadcastToCaves).not.toHaveBeenCalled();
  });

  it("setCavePassword ne diffuse rien", async () => {
    services.setCavePassword.mockResolvedValue("cave@x.fr");
    await controllers.setCavePassword(buildReq({ body: { CAVEID: 5 } }));
    expect(broadcastToAll).not.toHaveBeenCalled();
  });
});

describe("modules/declcav/audits/controllers :: temps réel", () => {
  const auditDetail = { AUDID: 3, CAVEID: 42, TITLE: "Audit", CURRENT: { VERNUM: 1 } };

  beforeEach(() => {
    auditServices.getAudit.mockResolvedValue({ AUDID: 3, CAVEID: 42 });
    auditServices.getAuditHistory.mockResolvedValue({});
    auditUtils.formatAuditDetail.mockReturnValue(auditDetail);
  });

  it("reviewReturn → declcav.audit.updated vers la cave de l'audit", async () => {
    await auditControllers.reviewReturn(
      buildReq({ params: { AUDID: "3", RETID: "4" }, body: { DECISION: "VALID" } }),
    );

    expect(sentToAll()).toEqual({ type: "declcav.audit.updated", payload: { AUDID: 3 } });
    expect(broadcastToCaves).toHaveBeenCalledWith([42], sentToAll());
  });

  it("deleteAudit → declcav.audit.deleted vers la cave de l'audit", async () => {
    await auditControllers.deleteAudit(
      buildReq({ params: { AUDID: "3" }, body: { COMMENT: "Doublon" } }),
    );

    expect(sentToAll()).toEqual({ type: "declcav.audit.deleted", payload: { AUDID: 3 } });
    expect(broadcastToCaves).toHaveBeenCalledWith([42], sentToAll());
  });
});
