import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildRawUserRow } from "../../../helpers/fixtures.js";

vi.mock("../../../../modules/usersmanager/services.js");
vi.mock("../../../../config/websocket/wsManager.js", () => ({
  broadcastToAll: vi.fn(),
  broadcastToUsers: vi.fn(),
}));
vi.mock("../../../../modules/files/services.js", () => ({
  deleteFileByEntity: vi.fn().mockResolvedValue(true),
  deleteFileByCode: vi.fn().mockResolvedValue(true),
}));

const services = await import("../../../../modules/usersmanager/services.js");
const filesServices = await import("../../../../modules/files/services.js");
const { broadcastToAll } = await import("../../../../config/websocket/wsManager.js");
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

describe("modules/usersmanager/controllers :: getAppVersions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exige APPCOD", async () => {
    await expect(controllers.getAppVersions(buildReq({ query: {} }))).rejects.toThrow();
  });

  it("regroupe les lignes par version (VID), dans l'ordre renvoyé", async () => {
    const base = { APPCOD: "USRMAN", CREUSR_ID: 1, CREUSR_LNAME: "B", CREUSR_FNAME: "P" };
    services.getAppVersions.mockResolvedValue([
      { ...base, VID: 2, VNUM: "1.3.1", CID: 10, CTYPE: "ADDED", CTITLE: "a" },
      { ...base, VID: 2, VNUM: "1.3.1", CID: 11, CTYPE: "FIX", CTITLE: "b" },
      { ...base, VID: 1, VNUM: "1.3.0", CID: null },
    ]);

    const result = await controllers.getAppVersions(buildReq({ query: { APPCOD: "USRMAN" } }));

    expect(services.getAppVersions).toHaveBeenCalledWith("USRMAN");
    expect(result.map((v) => v.VID)).toEqual([2, 1]);
    expect(result[0].CHANGES).toHaveLength(2);
    expect(result[1].CHANGES).toHaveLength(0);
  });
});

describe("modules/usersmanager/controllers :: setLastVersion / deleteAppVersion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("transmet le VID (modification d'une version existante)", async () => {
    services.insertAppVersion.mockResolvedValue({ VID: 5, VNUM: "1.0.1", CHANGES: [] });

    await controllers.setLastVersion(
      buildReq({ body: { VID: "5", APPCOD: "USRMAN", VNUM: "1.0.1", CHANGES: "[]" } }),
    );

    expect(services.insertAppVersion).toHaveBeenCalledWith(1, "USRMAN", "1.0.1", null, null, [], 5);
  });

  it("VID absent : création / mise à jour par APPCOD + VNUM (comportement historique)", async () => {
    services.insertAppVersion.mockResolvedValue({ VID: 6, VNUM: "2.0.0", CHANGES: [] });

    await controllers.setLastVersion(buildReq({ body: { APPCOD: "USRMAN", VNUM: "2.0.0" } }));

    expect(services.insertAppVersion).toHaveBeenCalledWith(1, "USRMAN", "2.0.0", null, null, [], null);
  });

  it("supprime la version demandée", async () => {
    services.deleteAppVersion.mockResolvedValue(true);

    await expect(controllers.deleteAppVersion(buildReq({ body: { VID: 7 } }))).resolves.toBe(true);
    expect(services.deleteAppVersion).toHaveBeenCalledWith(7);
  });

  it("deleteAppVersion exige VID", async () => {
    await expect(controllers.deleteAppVersion(buildReq({ body: {} }))).rejects.toThrow();
  });
});

describe("modules/usersmanager/controllers :: journal d'activité global", () => {
  const devPayload = { data: { id: 1 }, permissionLevel: 1 };

  it("refuse un non-développeur (ACCESS_DENIED_WO_LOGOUT)", async () => {
    const req = { ...buildReq({ payload: { data: { id: 1 }, permissionLevel: 3 } }), method: "GET" };
    await expect(controllers.getGeneralActivity(req)).rejects.toThrow("ACCESS_DENIED_WO_LOGOUT");
    await expect(controllers.getActivityParams({ ...req, query: { LOG_ID: "1" } })).rejects.toThrow(
      "ACCESS_DENIED_WO_LOGOUT",
    );
  });

  it("transmet les filtres validés au service et convertit EVENT_DATE", async () => {
    services.getGeneralActivity.mockResolvedValue([
      { LOG_ID: "1", EVENT_DATE: new Date("2026-06-01T10:00:00Z"), DEVEMAIL: "dev@b.com" },
    ]);
    const req = {
      ...buildReq({ payload: devPayload, query: { FROM: "2026-01-01", DEVONLY: "1", SOURCE: "ACTIVITY", LIMIT: "100" } }),
      method: "GET",
    };
    const res = await controllers.getGeneralActivity(req);
    const args = services.getGeneralActivity.mock.calls[0][0];
    expect(args.from).toBeInstanceOf(Date);
    expect(args).toMatchObject({ devOnly: true, source: "ACTIVITY", limit: 100 });
    expect(res[0].EVENT_DATE).toBe("2026-06-01T12:00:00+02:00");
    expect(res[0].DEVEMAIL).toBe("dev@b.com");
  });

  it("rejette une LIMIT hors bornes", async () => {
    const req = { ...buildReq({ payload: devPayload, query: { LIMIT: "999999" } }), method: "GET" };
    await expect(controllers.getGeneralActivity(req)).rejects.toThrow();
  });
});

describe("modules/usersmanager/controllers :: statistiques d'activité", () => {
  it("refuse un profil non gestionnaire", async () => {
    const req = { ...buildReq({ payload: { data: { id: 1 }, permission: "USER", permissionLevel: 4 } }), method: "GET" };
    await expect(controllers.getActivityStats(req)).rejects.toThrow("ACCESS_DENIED_WO_LOGOUT");
  });

  it("accepte un gestionnaire, applique 30 jours par défaut et renvoie des dates locales sans fuseau", async () => {
    services.getActivityStats.mockResolvedValue({
      totals: { ACTIONS: 1 },
      daily: [{ DAY: new Date("2026-11-12T00:00:00Z"), ACTIONS: 1 }],
      byHour: [],
      byApp: [],
      topUsers: [{ EMAIL: "a@b.com", LAST_EVENT: new Date("2026-11-12T17:11:07Z") }],
      topActions: [],
      failedLogins: [],
      byDev: [],
      lastLogins: [{ EMAIL: "a@b.com", LAST_LOGIN: null }],
    });
    const req = { ...buildReq({ payload: { data: { id: 1 }, permission: "ADMIN", permissionLevel: 3 } }), method: "GET" };
    const res = await controllers.getActivityStats(req);
    const { from, to } = services.getActivityStats.mock.calls[0][0];
    expect(Math.round((to - from) / 86_400_000)).toBe(30);
    expect(res.daily[0].DAY).toBe("2026-11-12");
    expect(res.topUsers[0].LAST_EVENT).toBe("2026-11-12T17:11:07");
    expect(res.lastLogins[0].LAST_LOGIN).toBeNull();
  });
});

describe("modules/usersmanager/controllers :: temps réel (broadcastUsersManager)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    broadcastToAll.mockImplementation(() => {});
  });

  const userBody = { LSTNAM: "D", FSTNAM: "J", EMAIL: "j@test.com" };

  it("upsertUser : created sans USRID, updated sinon, payload réduit à l'identifiant", async () => {
    services.upsertUser.mockResolvedValue(7);
    services.getUserById.mockResolvedValue([buildRawUserRow({ USRID: 7 })]);

    await controllers.upsertUser(buildReq({ body: userBody }));
    expect(broadcastToAll).toHaveBeenLastCalledWith({
      type: "usersmanager.user.created",
      payload: { USRID: 7 },
    });

    await controllers.upsertUser(buildReq({ body: { ...userBody, USRID: 7 } }));
    expect(broadcastToAll).toHaveBeenLastCalledWith({
      type: "usersmanager.user.updated",
      payload: { USRID: 7 },
    });
  });

  it("n'émet rien si l'écriture échoue", async () => {
    services.upsertUser.mockRejectedValue(new Error("SQL"));
    await expect(controllers.upsertUser(buildReq({ body: userBody }))).rejects.toThrow("SQL");
    expect(broadcastToAll).not.toHaveBeenCalled();
  });

  it("une erreur de diffusion ne fait pas échouer l'enregistrement", async () => {
    broadcastToAll.mockImplementation(() => {
      throw new Error("ws down");
    });
    services.upsertUser.mockResolvedValue(7);
    services.getUserById.mockResolvedValue([buildRawUserRow({ USRID: 7 })]);

    const result = await controllers.upsertUser(buildReq({ body: { ...userBody, USRID: 7 } }));
    expect(result).toBeDefined();
  });

  it("upsertGroup : usersmanager.group.updated { GRPID } après les permissions", async () => {
    services.upsertGroup.mockResolvedValue(3);
    services.delsertGroupPermissions.mockResolvedValue(undefined);
    services.getGroups.mockResolvedValue([{ GRPID: 3, GRPNAM: "G" }]);

    await controllers.upsertGroup(buildReq({ body: { GRPID: 3, GRPNAM: "G" } }));

    expect(broadcastToAll).toHaveBeenCalledWith({
      type: "usersmanager.group.updated",
      payload: { GRPID: 3 },
    });
  });

  it("upsertService / upsertPosition : created avec l'identifiant renvoyé", async () => {
    services.upsertService.mockResolvedValue(12);
    services.getServicesAll.mockResolvedValue([{ SRVID: 12 }]);
    await controllers.upsertService(buildReq({ body: { SRVCOD: "S", SRVNAM: "Service" } }));
    expect(broadcastToAll).toHaveBeenLastCalledWith({
      type: "usersmanager.service.created",
      payload: { SRVID: 12 },
    });

    services.upsertPosition.mockResolvedValue(40);
    services.getPositions.mockResolvedValue([{ POSID: 40 }]);
    await controllers.upsertPosition(
      buildReq({ body: { POSNAM: "Poste", POSCOD: "P", POSLVL: 1, SRVCOD: "S" } }),
    );
    expect(broadcastToAll).toHaveBeenLastCalledWith({
      type: "usersmanager.position.created",
      payload: { POSID: 40 },
    });
  });

  it("patchServicePosition : usersmanager.position.updated { POSID }", async () => {
    services.patchServicePosition.mockResolvedValue(undefined);
    await controllers.patchServicePosition(buildReq({ body: { SRVCOD: "S", POSID: 40 } }));
    expect(broadcastToAll).toHaveBeenCalledWith({
      type: "usersmanager.position.updated",
      payload: { POSID: 40 },
    });
  });

  it("upsertApplication : usersmanager.application.updated { APPID }", async () => {
    services.upsertApplication.mockResolvedValue(9);
    services.getApplications.mockResolvedValue([{ APPID: 9 }]);
    await controllers.upsertApplication(
      buildReq({ body: { APPID: 9, APPCOD: "USRMAN", APPNAM: "Users" } }),
    );
    expect(broadcastToAll).toHaveBeenCalledWith({
      type: "usersmanager.application.updated",
      payload: { APPID: 9 },
    });
  });

  it("versions : updated { VID, APPCOD } et deleted { VID }", async () => {
    services.insertAppVersion.mockResolvedValue({ VID: 6, VNUM: "2.0.0", CHANGES: [] });
    await controllers.setLastVersion(buildReq({ body: { APPCOD: "USRMAN", VNUM: "2.0.0" } }));
    expect(broadcastToAll).toHaveBeenLastCalledWith({
      type: "usersmanager.version.updated",
      payload: { VID: 6, APPCOD: "USRMAN" },
    });

    services.deleteAppVersion.mockResolvedValue(true);
    await controllers.deleteAppVersion(buildReq({ body: { VID: 6 } }));
    expect(broadcastToAll).toHaveBeenLastCalledWith({
      type: "usersmanager.version.deleted",
      payload: { VID: 6 },
    });
  });

  it("préférences personnelles (thème, notes de version lues) : rien n'est diffusé", async () => {
    services.setUserTheme.mockResolvedValue(true);
    services.getUserThemes.mockResolvedValue([]);
    services.setLastVersionDetailsOpened.mockResolvedValue(undefined);

    await controllers.setTheme(buildReq({ body: { THEME: "dark" } }));
    await controllers.setLastVersionDetailsOpened(buildReq({ body: { VID: 6 } }));

    expect(broadcastToAll).not.toHaveBeenCalled();
  });
});
