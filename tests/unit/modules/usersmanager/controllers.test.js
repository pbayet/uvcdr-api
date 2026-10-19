import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildRawUserRow } from "../../../helpers/fixtures.js";

vi.mock("../../../../modules/usersmanager/services.js");
vi.mock("../../../../modules/files/services.js", () => ({
  deleteFileByEntity: vi.fn().mockResolvedValue(true),
  deleteFileByCode: vi.fn().mockResolvedValue(true),
}));

const services = await import("../../../../modules/usersmanager/services.js");
const filesServices = await import("../../../../modules/files/services.js");
const controllers = await import("../../../../modules/usersmanager/controllers.js");
const { clearCache } = await import("../../../../core/utils/request.utils.js");

function buildReq({ payload = { data: { id: 1 }, application: "TICKETING" }, body = {}, query = {} } = {}) {
  return { method: "POST", payload, body, query, params: {}, headers: {} };
}

describe("modules/usersmanager/controllers :: getMe", () => {
  it("retourne directement les données du payload JWT (sans appel base)", () => {
    const req = { payload: { data: { id: 1, EMAIL: "a@b.com" } } };
    expect(controllers.getMe(req)).toEqual({ id: 1, EMAIL: "a@b.com" });
  });

  it("retourne null si aucun payload", () => {
    expect(controllers.getMe({})).toBeNull();
  });
});

describe("modules/usersmanager/controllers :: getUsers (cache)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  it("met en cache le résultat tant que force n'est pas demandé", async () => {
    services.getUsers.mockResolvedValue([buildRawUserRow()]);

    await controllers.getUsers(buildReq());
    await controllers.getUsers(buildReq());

    expect(services.getUsers).toHaveBeenCalledOnce();
  });

  it("bypasse le cache si force=true", async () => {
    services.getUsers.mockResolvedValue([buildRawUserRow()]);

    await controllers.getUsers(buildReq({ body: { force: "true" } }));
    await controllers.getUsers(buildReq({ body: { force: "true" } }));

    expect(services.getUsers).toHaveBeenCalledTimes(2);
  });
});

describe("modules/usersmanager/controllers :: getUser", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejette si aucun de email/id/poscod n'est fourni (validation zod)", async () => {
    await expect(controllers.getUser(buildReq({ body: {} }))).rejects.toThrow();
  });

  it("recherche par email et lève USER_NOT_FOUND si absent", async () => {
    services.getUserByEmail.mockResolvedValue([]);
    await expect(controllers.getUser(buildReq({ body: { email: "x@x.com" } }))).rejects.toThrow(
      "USER_NOT_FOUND",
    );
  });

  it("retourne l'utilisateur formaté trouvé par email", async () => {
    services.getUserByEmail.mockResolvedValue([buildRawUserRow({ EMAIL: "trouve@test.com" })]);
    const result = await controllers.getUser(buildReq({ body: { email: "trouve@test.com" } }));
    expect(result.EMAIL).toBe("trouve@test.com");
  });
});

describe("modules/usersmanager/controllers :: upsertUser", () => {
  beforeEach(() => vi.clearAllMocks());

  it("valide le payload, met à jour groupes/permissions/subordonnés puis renvoie l'utilisateur", async () => {
    services.upsertUser.mockResolvedValue(7);
    services.delsertUserGroups.mockResolvedValue(undefined);
    services.delsertUserPermissions.mockResolvedValue(undefined);
    services.delsertUserSubordinates.mockResolvedValue(undefined);
    services.getUserById.mockResolvedValue([buildRawUserRow({ USRID: 7 })]);

    const req = buildReq({
      body: {
        LSTNAM: "Dupont",
        FSTNAM: "Jean",
        EMAIL: "jean.dupont@test.com",
        GRPIDS: [1, 2],
        PERMISSIONS: [{ APPCOD: "TICKETING", PRMID: 3 }],
      },
    });

    const result = await controllers.upsertUser(req);

    expect(services.upsertUser).toHaveBeenCalled();
    // USRID absent du payload (création) : les relations utilisent l'id renvoyé par upsertUser
    expect(services.delsertUserGroups).toHaveBeenCalledWith(7, JSON.stringify([1, 2]));
    expect(services.delsertUserPermissions).toHaveBeenCalled();
    expect(result.EMAIL).toBeDefined();
  });

  it("enregistre les copies mails (MAILCOPIES) sur l'utilisateur", async () => {
    services.upsertUser.mockResolvedValue(7);
    services.delsertUserMailCopies.mockResolvedValue(7);
    services.getUserById.mockResolvedValue([buildRawUserRow({ USRID: 7 })]);

    await controllers.upsertUser(
      buildReq({
        body: { USRID: 7, LSTNAM: "D", FSTNAM: "J", EMAIL: "j@test.com", MAILCOPIES: "[3,4]" },
      }),
    );

    expect(services.delsertUserMailCopies).toHaveBeenCalledWith(7, JSON.stringify([3, 4]));
  });

  it("vide les copies mails si MAILCOPIES est un tableau vide, sans y toucher s'il est absent", async () => {
    services.upsertUser.mockResolvedValue(7);
    services.getUserById.mockResolvedValue([buildRawUserRow({ USRID: 7 })]);

    await controllers.upsertUser(
      buildReq({ body: { USRID: 7, LSTNAM: "D", FSTNAM: "J", EMAIL: "j@test.com", MAILCOPIES: [] } }),
    );
    expect(services.delsertUserMailCopies).toHaveBeenCalledWith(7, "");

    services.delsertUserMailCopies.mockClear();
    await controllers.upsertUser(
      buildReq({ body: { USRID: 7, LSTNAM: "D", FSTNAM: "J", EMAIL: "j@test.com" } }),
    );
    expect(services.delsertUserMailCopies).not.toHaveBeenCalled();
  });

  it("supprime le fichier associé si ENTITYNAME est fourni", async () => {
    services.upsertUser.mockResolvedValue(7);
    services.getUserById.mockResolvedValue([buildRawUserRow({ USRID: 7 })]);

    const req = buildReq({
      body: { LSTNAM: "D", FSTNAM: "J", EMAIL: "j@test.com", ENTITYNAME: "users" },
    });

    await controllers.upsertUser(req);

    expect(filesServices.deleteFileByEntity).toHaveBeenCalledWith("users", "undefined");
  });

  it("rejette un email invalide avant tout appel service", async () => {
    const req = buildReq({ body: { LSTNAM: "D", FSTNAM: "J", EMAIL: "invalide" } });
    await expect(controllers.upsertUser(req)).rejects.toThrow();
    expect(services.upsertUser).not.toHaveBeenCalled();
  });
});

describe("modules/usersmanager/controllers :: getLastVersionDetails", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lève MISSING_PARAMETERS si USRID ou application absents du payload", async () => {
    await expect(controllers.getLastVersionDetails({ payload: { data: {} } })).rejects.toThrow(
      "MISSING_PARAMETERS",
    );
  });

  it("lève DATA_NOT_FOUND si aucune version n'est trouvée", async () => {
    services.getLastVersionDetails.mockResolvedValue([]);
    await expect(controllers.getLastVersionDetails(buildReq())).rejects.toThrow("DATA_NOT_FOUND");
  });
});
