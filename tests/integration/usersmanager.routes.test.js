import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { buildTestApp } from "../helpers/buildTestApp.js";
import { buildAuthToken, buildRawUserRow } from "../helpers/fixtures.js";

vi.mock("../../modules/usersmanager/services.js");
vi.mock("../../modules/files/services.js", () => ({
  deleteFileByEntity: vi.fn(),
  deleteFileByCode: vi.fn(),
}));

const usersmanagerServices = await import("../../modules/usersmanager/services.js");
const { default: usersmanagerRouter } = await import("../../modules/usersmanager/routes.js");
const { clearCache } = await import("../../core/utils/request.utils.js");

const app = buildTestApp(usersmanagerRouter, "/api/usersmanager");

describe("Intégration :: /api/usersmanager", () => {
  let token;
  let rawUser;

  beforeAll(async () => {
    ({ token, raw: rawUser } = await buildAuthToken({ EMAIL: "int-usersmanager@union-vignerons.com", appcode: "USERSMANAGER" }));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
    // getUserByEmail est utilisé à la fois par authVerifyMiddleware (avec
    // l'email du token) et par certaines routes métier (avec un email de
    // requête) : on retourne l'utilisateur courant par défaut.
    usersmanagerServices.getUserByEmail.mockResolvedValue([rawUser]);
  });

  it("GET /api/usersmanager/me renvoie le profil décodé du token, sans appel base supplémentaire", async () => {
    const res = await request(app).get("/api/usersmanager/me").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe("int-usersmanager@union-vignerons.com");
  });

  it("GET /api/usersmanager/application/current/version est accessible sans authentification", async () => {
    usersmanagerServices.getApplicationCurrentVersion.mockResolvedValue([{ version: "1.1.0" }]);

    const res = await request(app).get("/api/usersmanager/application/current/version?APPCOD=TICKETING");

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe("1.1.0");
  });

  it("GET /api/usersmanager sans token → 401", async () => {
    const res = await request(app).get("/api/usersmanager");
    expect(res.status).toBe(401);
  });

  it("GET /api/usersmanager/user sans paramètre → 400 (validation zod)", async () => {
    const res = await request(app).get("/api/usersmanager/user").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("GET /api/usersmanager/user?email=... renvoie l'utilisateur formaté", async () => {
    usersmanagerServices.getUserByEmail.mockImplementation(async (email) =>
      email === "cherche@test.com" ? [buildRawUserRow({ EMAIL: "cherche@test.com" })] : [rawUser],
    );

    const res = await request(app)
      .get("/api/usersmanager/user?email=cherche@test.com")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.EMAIL).toBe("cherche@test.com");
  });

  it("POST /api/usersmanager (upsertUser) avec un email invalide → 400", async () => {
    const res = await request(app)
      .post("/api/usersmanager")
      .set("Authorization", `Bearer ${token}`)
      .send({ LSTNAM: "Dupont", FSTNAM: "Jean", EMAIL: "invalide" });

    expect(res.status).toBe(400);
  });

  it("GET /api/usersmanager/permissions renvoie la liste des permissions", async () => {
    usersmanagerServices.getPermissions.mockResolvedValue([{ PRMID: 1, PRMNAM: "ADMIN" }]);

    const res = await request(app).get("/api/usersmanager/permissions").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  describe("Thèmes", () => {
    it("GET /api/usersmanager/theme sans préférence → light (repli)", async () => {
      usersmanagerServices.getUserThemes.mockResolvedValue([]);

      const res = await request(app)
        .get("/api/usersmanager/theme?APPCOD=TICKETING")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ THEME: "light", DEFAULT: "light", SOURCE: "DEFAULT" });
      expect(usersmanagerServices.getUserThemes).toHaveBeenCalledWith(rawUser.USRID);
    });

    it("GET /api/usersmanager/theme : le thème de l'application prime sur le défaut", async () => {
      usersmanagerServices.getUserThemes.mockResolvedValue([
        { APPID: null, APPCOD: null, THEME: "system" },
        { APPID: 3, APPCOD: "TICKETING", THEME: "dark" },
      ]);

      const app1 = await request(app)
        .get("/api/usersmanager/theme?APPCOD=TICKETING")
        .set("Authorization", `Bearer ${token}`);
      const app2 = await request(app)
        .get("/api/usersmanager/theme?APPCOD=FSA")
        .set("Authorization", `Bearer ${token}`);

      expect(app1.body.data).toMatchObject({ THEME: "dark", SOURCE: "APPLICATION" });
      expect(app2.body.data).toMatchObject({ THEME: "system", SOURCE: "DEFAULT" });
    });

    it("POST /api/usersmanager/theme enregistre la préférence de l'utilisateur connecté", async () => {
      usersmanagerServices.setUserTheme.mockResolvedValue(true);
      usersmanagerServices.getUserThemes.mockResolvedValue([{ APPID: 3, APPCOD: "TICKETING", THEME: "dark" }]);

      const res = await request(app)
        .post("/api/usersmanager/theme")
        .set("Authorization", `Bearer ${token}`)
        .send({ APPCOD: "TICKETING", THEME: "dark", USRID: 999 });

      expect(res.status).toBe(200);
      expect(usersmanagerServices.setUserTheme).toHaveBeenCalledWith(rawUser.USRID, "TICKETING", "dark");
      expect(res.body.data).toEqual({
        DEFAULT: "light",
        APPLICATIONS: [{ APPID: 3, APPCOD: "TICKETING", THEME: "dark" }],
      });
    });

    it("POST /api/usersmanager/theme : THEME null sur une application → retour au défaut", async () => {
      usersmanagerServices.setUserTheme.mockResolvedValue(true);
      usersmanagerServices.getUserThemes.mockResolvedValue([]);

      const res = await request(app)
        .post("/api/usersmanager/theme")
        .set("Authorization", `Bearer ${token}`)
        .send({ APPCOD: "TICKETING", THEME: null });

      expect(res.status).toBe(200);
      expect(usersmanagerServices.setUserTheme).toHaveBeenCalledWith(rawUser.USRID, "TICKETING", null);
    });

    it("POST /api/usersmanager/theme : valeur invalide ou défaut sans THEME → 400", async () => {
      const invalid = await request(app)
        .post("/api/usersmanager/theme")
        .set("Authorization", `Bearer ${token}`)
        .send({ THEME: "blue" });
      const missing = await request(app)
        .post("/api/usersmanager/theme")
        .set("Authorization", `Bearer ${token}`)
        .send({ THEME: null });

      expect(invalid.status).toBe(400);
      expect(missing.status).toBe(400);
      expect(usersmanagerServices.setUserTheme).not.toHaveBeenCalled();
    });

    it("GET /api/usersmanager/theme?APPCOD=HOME : code de base → thème par défaut", async () => {
      usersmanagerServices.getUserThemes.mockResolvedValue([{ APPID: null, APPCOD: null, THEME: "dark" }]);

      const res = await request(app)
        .get("/api/usersmanager/theme?APPCOD=HOME")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ APPCOD: null, THEME: "dark", DEFAULT: "dark", SOURCE: "DEFAULT" });
    });

    it("POST /api/usersmanager/theme : APPCOD=HOME enregistre le thème par défaut", async () => {
      usersmanagerServices.setUserTheme.mockResolvedValue(true);
      usersmanagerServices.getUserThemes.mockResolvedValue([{ APPID: null, APPCOD: null, THEME: "dark" }]);

      const res = await request(app)
        .post("/api/usersmanager/theme")
        .set("Authorization", `Bearer ${token}`)
        .send({ APPCOD: "HOME", THEME: "dark" });

      expect(res.status).toBe(200);
      expect(usersmanagerServices.setUserTheme).toHaveBeenCalledWith(rawUser.USRID, null, "dark");
      expect(res.body.data).toEqual({ DEFAULT: "dark", APPLICATIONS: [] });
    });

    it("POST /api/usersmanager/theme : APPCOD=HOME sans THEME → 400 (le défaut n'est pas supprimé)", async () => {
      const res = await request(app)
        .post("/api/usersmanager/theme")
        .set("Authorization", `Bearer ${token}`)
        .send({ APPCOD: "HOME", THEME: null });

      expect(res.status).toBe(400);
      expect(usersmanagerServices.setUserTheme).not.toHaveBeenCalled();
    });

    it("POST /api/usersmanager/theme : application inconnue → erreur", async () => {
      usersmanagerServices.setUserTheme.mockResolvedValue(false);

      const res = await request(app)
        .post("/api/usersmanager/theme")
        .set("Authorization", `Bearer ${token}`)
        .send({ APPCOD: "INCONNUE", THEME: "dark" });

      expect(res.status).not.toBe(200);
    });
  });
});
