import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../../core/utils/db.utils.js", () => ({
  runQuery: vi.fn(),
}));

const { runQuery } = await import("../../../../core/utils/db.utils.js");
const services = await import("../../../../modules/usersmanager/services.js");

describe("modules/usersmanager/services :: lectures simples", () => {
  beforeEach(() => runQuery.mockReset());

  it("getUsers exécute sp_GetUsers_JSON et renvoie le recordset", async () => {
    runQuery.mockResolvedValue({ recordset: [{ USRID: 1 }] });
    await expect(services.getUsers()).resolves.toEqual([{ USRID: 1 }]);
    expect(runQuery.mock.calls[0][0].query).toContain("sp_GetUsers_JSON");
  });

  it("getUserByEmail transmet l'email en paramètre EML", async () => {
    runQuery.mockResolvedValue({ recordset: [{ USRID: 1 }] });
    await services.getUserByEmail("jean@test.com");
    expect(runQuery.mock.calls[0][0].inputs.EML.value).toBe("jean@test.com");
  });

  it("getApplications sans APPID sélectionne toutes les applications", async () => {
    runQuery.mockResolvedValue({ recordset: [{ APPID: 1 }, { APPID: 2 }] });
    const apps = await services.getApplications();
    expect(apps).toHaveLength(2);
    expect(runQuery.mock.calls[0][0].inputs.APPID.value).toBeUndefined();
  });

  it("getApplications avec APPID filtre sur une seule application", async () => {
    runQuery.mockResolvedValue({ recordset: [{ APPID: 5 }] });
    await services.getApplications(5);
    expect(runQuery.mock.calls[0][0].query).toContain("WHERE APPID = @APPID");
    expect(runQuery.mock.calls[0][0].inputs.APPID.value).toBe(5);
  });

  it("getPermission filtre par PRMLVL", async () => {
    runQuery.mockResolvedValue({ recordset: [{ PRMID: 3, PRMLVL: 4 }] });
    const result = await services.getPermission(4);
    expect(result).toEqual([{ PRMID: 3, PRMLVL: 4 }]);
    expect(runQuery.mock.calls[0][0].inputs.PRMLVL.value).toBe(4);
  });
});

describe("modules/usersmanager/services :: getHomeApplications (logique pure, sans DB)", () => {
  it("lève USER_NOT_FOUND si aucun utilisateur fourni", async () => {
    await expect(services.getHomeApplications(null)).rejects.toThrow("USER_NOT_FOUND");
  });

  it("ne garde que la permission la plus élevée (PRMLVL le plus bas) par application", async () => {
    const user = {
      PERMISSIONS: [
        { APPCOD: "TICKETING", PRMLVL: 4 },
        { APPCOD: "TICKETING", PRMLVL: 1 },
        { APPCOD: "AUTRE", PRMLVL: 2 },
      ],
    };

    const result = await services.getHomeApplications(user);
    const ticketingEntry = result.find((r) => r.APPCOD === "TICKETING");
    expect(ticketingEntry.PRMLVL).toBe(1);
    expect(result).toHaveLength(2);
  });

  it("ignore les permissions avec un niveau <= 0 ou non numérique", async () => {
    const user = {
      PERMISSIONS: [
        { APPCOD: "A", PRMLVL: 0 },
        { APPCOD: "B", PRMLVL: -1 },
        { APPCOD: "C", PRMLVL: "invalide" },
        { APPCOD: "D", PRMLVL: 2 },
      ],
    };

    const result = await services.getHomeApplications(user);
    expect(result.map((r) => r.APPCOD)).toEqual(["D"]);
  });

  it("trie le résultat par APPCOD", async () => {
    const user = { PERMISSIONS: [{ APPCOD: "Z", PRMLVL: 1 }, { APPCOD: "A", PRMLVL: 1 }] };
    const result = await services.getHomeApplications(user);
    expect(result.map((r) => r.APPCOD)).toEqual(["A", "Z"]);
  });
});

describe("modules/usersmanager/services :: écritures", () => {
  beforeEach(() => runQuery.mockReset());

  it("postLoginStats transmet SUCCESS/EMAIL/APPCOD et retourne true", async () => {
    runQuery.mockResolvedValue({ recordset: [] });
    await expect(services.postLoginStats(true, "a@b.com", "TICKETING")).resolves.toBe(true);

    const { inputs } = runQuery.mock.calls[0][0];
    expect(inputs.SUCCESS.value).toBe(true);
    expect(inputs.EMAIL.value).toBe("a@b.com");
    expect(inputs.APPCOD.value).toBe("TICKETING");
  });

  it("upsertUser retourne l'USRID renvoyé par la requête", async () => {
    runQuery.mockResolvedValue({ recordset: [{ USRID: 42 }] });

    const result = await services.upsertUser(null, "Dupont", "Jean", "jean@test.com", null, true, false, 1, 99);

    expect(result).toBe(42);
    const { inputs } = runQuery.mock.calls[0][0];
    expect(inputs.LSTNAM.value).toBe("Dupont");
    expect(inputs.postUSRID.value).toBe(99);
  });

  it("postActivityStats insère une requête SQL valide (pas de token parasite) avec tous les champs", async () => {
    runQuery.mockResolvedValue({ recordset: [] });

    await expect(
      services.postActivityStats(
        "POST",
        "/api/ticketing",
        "Création d'un ticket",
        "TICKETING",
        "jean@test.com",
        "127.0.0.1",
        42,
        '{"TITLE":"Test"}',
        true,
      ),
    ).resolves.toBe(true);

    const { query, inputs } = runQuery.mock.calls[0][0];

    // Regression test du bug "@USEREMAIL,w" (coquille cassant le INSERT) :
    // chaque paramètre nommé doit être suivi d'une virgule ou d'une
    // parenthèse fermante, jamais d'un caractère parasite.
    expect(query).not.toMatch(/@USEREMAIL\s*,\s*\w/);
    expect(query).toContain("INSERT INTO USERSACTIVITY");

    expect(inputs.METHOD.value).toBe("POST");
    expect(inputs.ROUTE.value).toBe("/api/ticketing");
    expect(inputs.COMMENT.value).toBe("Création d'un ticket");
    expect(inputs.APPCOD.value).toBe("TICKETING");
    expect(inputs.USEREMAIL.value).toBe("jean@test.com");
    expect(inputs.IPADRESS.value).toBe("127.0.0.1");
    expect(inputs.DURATIONMS.value).toBe(42);
    expect(inputs.PARAMS.value).toBe('{"TITLE":"Test"}');
    expect(inputs.SUCCESS.value).toBe(true);
  });

  it("postActivityStats tronque les champs plus longs que leur colonne SQL", async () => {
    runQuery.mockResolvedValue({ recordset: [] });

    await services.postActivityStats(
      "POST",
      "/api/ticketing",
      "x".repeat(400), // COMMENT: NVarChar(300)
      "TICKETING",
      "jean@test.com",
      "127.0.0.1",
      1,
      null,
      true,
    );

    const { inputs } = runQuery.mock.calls[0][0];
    expect(inputs.COMMENT.value).toHaveLength(300);
  });

  it("setLastVersionDetailsOpened et patchServicePosition transmettent leurs paramètres", async () => {
    runQuery.mockResolvedValue({ recordset: [] });

    await services.setLastVersionDetailsOpened(1, 10);
    expect(runQuery.mock.calls[0][0].inputs).toHaveProperty("USRID");
    expect(runQuery.mock.calls[0][0].inputs).toHaveProperty("VID");

    runQuery.mockReset().mockResolvedValue({ recordset: [] });
    await services.patchServicePosition("SUP", 1, 99);
    expect(runQuery).toHaveBeenCalledOnce();
  });
});
