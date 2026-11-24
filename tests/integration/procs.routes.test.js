import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { buildTestApp } from "../helpers/buildTestApp.js";
import { buildFormattedUser, buildRawUserRow } from "../helpers/fixtures.js";
import * as jwtUtils from "../../core/utils/jwt.utils.js";

vi.mock("../../modules/procs/services.js", async (importOriginal) => {
  const actual = await importOriginal();
  const mocked = Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === "function" ? vi.fn() : v]),
  );
  // Fonction pure (découpage de la recherche) : implémentation réelle.
  mocked.parseSearchTerms = actual.parseSearchTerms;
  return mocked;
});
vi.mock("../../modules/procs/extract.js", () => ({
  ALLOWED_EXTENSIONS: ["pdf", "docx", "doc", "odt", "rtf", "txt", "docm", "dotx"],
  extractDocumentText: vi.fn().mockResolvedValue({ status: "OK", text: "texte", pages: 1 }),
  needsPreview: vi.fn(() => false),
  generatePdfPreview: vi.fn(),
}));
vi.mock("../../core/services/storage.service.js", () => ({
  StorageService: class {
    async saveUploadedFile({ file }) {
      return {
        FILECODE: "01TESTFILECODE",
        CHECKSUMSHA256: "a".repeat(64),
        SIZEBYTES: file.size,
        RELATIVEPATH: "PROCS/2026/11/19/01/01TESTFILECODE.pdf",
      };
    }
  },
}));
vi.mock("../../modules/usersmanager/services.js", () => ({ getUserByEmail: vi.fn() }));
vi.mock("../../config/websocket/wsManager.js", () => ({ broadcastToAll: vi.fn() }));

const services = await import("../../modules/procs/services.js");
const usersmanagerServices = await import("../../modules/usersmanager/services.js");
const { broadcastToAll } = await import("../../config/websocket/wsManager.js");
const { default: router } = await import("../../modules/procs/routes.js");
const { clearCache } = await import("../../core/utils/request.utils.js");

const app = buildTestApp(router, "/api/procs");

async function tokenFor({ email, appcode = "PROCS", permissionName = "USER" }) {
  const overrides = { EMAIL: email, appcode, permissionName };
  const user = await buildFormattedUser(overrides);
  const payload = jwtUtils.generatePayload(user, user.PERMISSIONS[0].PERMISSION, appcode);
  return { token: jwtUtils.generateJWT(payload), raw: buildRawUserRow(overrides) };
}

const PROC_ROW = {
  PRCID: 7,
  REFCODE: "PROC-QUA-001",
  TITLE: "Nettoyage des cuves",
  SUMMARY: "Mode opératoire",
  OWNER: "Qualité",
  STATUS: "PUBLISHED",
  REVIEWDAT: new Date("2020-01-01T00:00:00Z"),
  DLTD: false,
  CREUSR: 1,
  CREUSRNAM: "Jean Test",
  CATID: 2,
  CATNAME: "Qualité",
  CURVERID: 11,
  VERNUM: 3,
  ORIGINALNAME: "nettoyage.pdf",
  EXTENSION: "pdf",
  TEXTSTATUS: "OK",
  HASPREVIEW: 0,
  KEYWORDS: "cuve|hygiène",
  VERSIONCOUNT: 3,
  ACKED: 0,
  SCORE: 110,
  SNIPPET: "rincer la cuve à l'eau chaude",
  SNIPPETCUT: 1,
  MATCHINCONTENT: 1,
};

describe("Intégration :: /api/procs", () => {
  const users = {};

  beforeAll(async () => {
    users.reader = await tokenFor({ email: "lecteur@union-vignerons.com", permissionName: "USER" });
    users.admin = await tokenFor({ email: "admin@union-vignerons.com", permissionName: "ADMIN" });
    users.otherApp = await tokenFor({ email: "faq@union-vignerons.com", appcode: "FAQ", permissionName: "ADMIN" });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
    const byEmail = Object.fromEntries(Object.values(users).map((u) => [u.raw.EMAIL, u.raw]));
    usersmanagerServices.getUserByEmail.mockImplementation(async (email) => [byEmail[email]]);
    services.addHistory.mockResolvedValue(undefined);
  });

  const auth = (who) => ({ Authorization: `Bearer ${users[who].token}` });

  it("sans token → 401", async () => {
    const res = await request(app).get("/api/procs/procedures");
    expect(res.status).toBe(401);
  });

  it("jeton d'une autre application (même ADMIN) → refusé sans déconnexion (460)", async () => {
    const res = await request(app).get("/api/procs/me").set(auth("otherApp"));
    expect(res.status).toBe(460);
  });

  it("GET /me : rédacteur selon la permission (ADMIN oui, USER non)", async () => {
    const admin = await request(app).get("/api/procs/me").set(auth("admin"));
    const reader = await request(app).get("/api/procs/me").set(auth("reader"));
    expect(admin.body.data).toEqual({ EDITOR: true });
    expect(reader.body.data).toEqual({ EDITOR: false });
  });

  it("GET /procedures (lecteur) : recherche transmise, filtres rédacteurs ignorés, extrait formaté", async () => {
    services.listProcedures.mockResolvedValue([PROC_ROW]);

    const res = await request(app)
      .get("/api/procs/procedures")
      .query({ SEARCH: "cuve", STATUS: "DRAFT", DLTD: "true" })
      .set(auth("reader"));

    expect(res.status).toBe(200);
    const [ctx, filters] = services.listProcedures.mock.calls[0];
    expect(ctx).toMatchObject({ ISEDITOR: false });
    expect(filters).toEqual({ SEARCH: "cuve" });
    expect(res.body.data[0]).toMatchObject({
      PRCID: 7,
      KEYWORDS: ["cuve", "hygiène"],
      OVERDUE: true,
      CURRENT: { VERID: 11, VERNUM: 3, HASPREVIEW: false },
      SNIPPET: "…rincer la cuve à l'eau chaude…",
      MATCHINCONTENT: true,
    });
  });

  it("POST /procedures par un lecteur → refusé", async () => {
    const res = await request(app)
      .post("/api/procs/procedures")
      .set(auth("reader"))
      .field("TITLE", "Test")
      .attach("file", Buffer.from("%PDF-1.4"), "test.pdf");
    expect(res.status).toBe(460);
    expect(services.createProcedure).not.toHaveBeenCalled();
  });

  it("POST /procedures sans document → 400", async () => {
    const res = await request(app)
      .post("/api/procs/procedures")
      .set(auth("admin"))
      .field("TITLE", "Test")
      .field("CATID", "2");
    expect(res.status).toBe(400);
  });

  it("POST /procedures avec un format refusé → 400", async () => {
    const res = await request(app)
      .post("/api/procs/procedures")
      .set(auth("admin"))
      .field("TITLE", "Test")
      .field("CATID", "2")
      .attach("file", Buffer.from("MZ"), "virus.exe");
    expect(res.status).toBe(400);
    expect(services.createProcedure).not.toHaveBeenCalled();
  });

  it("POST /procedures (rédacteur) : crée, enregistre le fichier, trace, publie", async () => {
    services.isRefcodeTaken.mockResolvedValue(false);
    services.getCategory.mockResolvedValue({ CATID: 2 });
    services.createProcedure.mockResolvedValue({ PRCID: 7, VERID: 11 });
    services.getProcedure.mockResolvedValue(PROC_ROW);
    services.getVersions.mockResolvedValue([]);

    const res = await request(app)
      .post("/api/procs/procedures")
      .set(auth("admin"))
      .field("TITLE", "Nettoyage des cuves")
      .field("REFCODE", "PROC-QUA-001")
      .field("CATID", "2")
      .field("KEYWORDS", JSON.stringify(["cuve", "hygiène"]))
      .field("PUBLISH", "true")
      .attach("file", Buffer.from("%PDF-1.4"), "Procédure nettoyage.pdf");

    expect(res.status).toBe(201);
    const [data, file] = services.createProcedure.mock.calls[0];
    expect(data).toMatchObject({ TITLE: "Nettoyage des cuves", CATID: 2, KEYWORDS: ["cuve", "hygiène"], PUBLISH: true });
    expect(file).toMatchObject({ EXTENSION: "pdf", ORIGINALNAME: "Procédure nettoyage.pdf" });
    expect(services.attachVersionFile).toHaveBeenCalledWith(11, expect.objectContaining({ FILECODE: "01TESTFILECODE" }));
    expect(services.setStatus).toHaveBeenCalledWith(7, "PUBLISHED", expect.any(Number));
    expect(services.addHistory.mock.calls.map((c) => c[0].ACTION)).toEqual(["CREATE", "PUBLISH"]);
    expect(broadcastToAll).toHaveBeenCalledWith({ type: "procs.procedure.created", payload: { PRCID: 7 } });
  });

  it("POST /procedures sans catégorie → 400", async () => {
    const res = await request(app)
      .post("/api/procs/procedures")
      .set(auth("admin"))
      .field("TITLE", "Sans catégorie")
      .attach("file", Buffer.from("%PDF-1.4"), "a.pdf");
    expect(res.status).toBe(400);
    expect(services.createProcedure).not.toHaveBeenCalled();
  });

  it("GET /procedures : filtre DIRECT transmis (masquer les sous-catégories)", async () => {
    services.listProcedures.mockResolvedValue([]);
    await request(app).get("/api/procs/procedures").query({ CATID: 1, DIRECT: "true" }).set(auth("reader"));
    expect(services.listProcedures.mock.calls[0][1]).toEqual({ CATID: 1, DIRECT: true });
  });

  it("POST /categories : 4ᵉ niveau refusé (400)", async () => {
    services.getCategoryLinks.mockResolvedValue([
      { CATID: 1, PARENTID: null },
      { CATID: 2, PARENTID: 1 },
      { CATID: 3, PARENTID: 2 },
    ]);
    const res = await request(app).post("/api/procs/categories").set(auth("admin")).send({ NAME: "Trop profond", PARENTID: 3 });
    expect(res.status).toBe(400);
    expect(services.createCategory).not.toHaveBeenCalled();
  });

  it("DELETE /categories/:catid : catégorie inutilisée supprimée", async () => {
    services.getCategory.mockResolvedValue({ CATID: 5, NAME: "Vide" });
    services.getCategoryUsage.mockResolvedValue({ PROCCOUNT: 0, CHILDCOUNT: 0 });
    const res = await request(app).delete("/api/procs/categories/5").set(auth("admin"));
    expect(res.status).toBe(200);
    expect(res.body.data ?? res.body).toEqual({ CATID: 5 });
    expect(services.deleteCategory).toHaveBeenCalledWith(5);
    expect(broadcastToAll).toHaveBeenCalled();
  });

  it("DELETE /categories/:catid : catégorie utilisée → 409", async () => {
    services.getCategory.mockResolvedValue({ CATID: 2, NAME: "Réseau" });
    services.getCategoryUsage.mockResolvedValue({ PROCCOUNT: 1, CHILDCOUNT: 2 });
    const res = await request(app).delete("/api/procs/categories/2").set(auth("admin"));
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("2 sous-catégories");
    expect(services.deleteCategory).not.toHaveBeenCalled();
  });

  it("DELETE /categories/:catid : réservé aux rédacteurs", async () => {
    const res = await request(app).delete("/api/procs/categories/5").set(auth("reader"));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(services.deleteCategory).not.toHaveBeenCalled();
  });

  it("POST /procedures : référence déjà utilisée → 409", async () => {
    services.isRefcodeTaken.mockResolvedValue(true);
    const res = await request(app)
      .post("/api/procs/procedures")
      .set(auth("admin"))
      .field("TITLE", "Doublon")
      .field("CATID", "2")
      .field("REFCODE", "PROC-QUA-001")
      .attach("file", Buffer.from("%PDF-1.4"), "a.pdf");
    expect(res.status).toBe(409);
  });

  it("PUT /procedures/:prcid : ne trace que les champs réellement modifiés", async () => {
    services.getProcedureRow.mockResolvedValue({ ...PROC_ROW, DLTD: false });
    services.getKeywords.mockResolvedValue(["cuve", "hygiène"]);
    services.isRefcodeTaken.mockResolvedValue(false);
    services.getProcedure.mockResolvedValue(PROC_ROW);
    services.getVersions.mockResolvedValue([]);

    const res = await request(app)
      .put("/api/procs/procedures/7")
      .set(auth("admin"))
      .send({ TITLE: "Nettoyage des cuves inox", OWNER: "Qualité", KEYWORDS: ["hygiène", "cuve"] });

    expect(res.status).toBe(200);
    expect(services.addHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        ACTION: "UPDATE",
        DETAILS: { TITLE: { from: "Nettoyage des cuves", to: "Nettoyage des cuves inox" } },
      }),
    );
  });

  it("PUT /procedures/:prcid/status : publication sans document → 409", async () => {
    services.getProcedureRow.mockResolvedValue({ ...PROC_ROW, STATUS: "DRAFT", CURVERID: null, DLTD: false });
    const res = await request(app)
      .put("/api/procs/procedures/7/status")
      .set(auth("admin"))
      .send({ STATUS: "PUBLISHED" });
    expect(res.status).toBe(409);
    expect(services.setStatus).not.toHaveBeenCalled();
  });

  it("GET /history : réservé aux rédacteurs", async () => {
    services.getHistory.mockResolvedValue([]);
    const reader = await request(app).get("/api/procs/history").set(auth("reader"));
    const admin = await request(app).get("/api/procs/history").set(auth("admin"));
    expect(reader.status).toBe(460);
    expect(admin.status).toBe(200);
  });

  it("GET /versions/:verid/file : un lecteur ne peut pas ouvrir une ancienne version", async () => {
    services.getVersion.mockResolvedValue({ VERID: 5, PRCID: 7, ISCURRENT: 0, FILECODE: "X" });
    services.getProcedure.mockResolvedValue(PROC_ROW);
    const res = await request(app).get("/api/procs/versions/5/file").set(auth("reader"));
    expect(res.status).toBe(460);
    expect(services.addConsult).not.toHaveBeenCalled();
  });

  it("GET /procedures/:prcid/file-link : lien signé, puis ouverture sans jeton", async () => {
    services.getProcedure.mockResolvedValue(PROC_ROW);
    services.getVersion.mockResolvedValue({ VERID: 11, PRCID: 7, VERNUM: 3, FILECODE: "F11", ORIGINALNAME: "nettoyage.pdf" });
    services.getAttachment.mockResolvedValue(null); // fichier absent : on s'arrête à "introuvable"

    const created = await request(app).get("/api/procs/procedures/7/file-link").set(auth("reader"));
    expect(created.status).toBe(200);
    expect(created.body.data.PATH).toMatch(/^\/procs\/files\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/nettoyage\.pdf$/);

    const opened = await request(app).get(`/api${created.body.data.PATH}`);
    expect(services.getProcedure).toHaveBeenLastCalledWith({ USRID: expect.any(Number), ISEDITOR: false }, 7);
    expect(services.getAttachment).toHaveBeenCalledWith("F11");
    expect(opened.status).toBe(404);
    expect(opened.text).toBe("Document introuvable.");

    // Lien sans nom de fichier (copié avant l'ajout du nom) : toujours accepté.
    const bare = await request(app).get(`/api${created.body.data.PATH.replace(/\/[^/]+$/, "")}`);
    expect(bare.text).toBe("Document introuvable.");
    expect(services.getAttachment).toHaveBeenCalledTimes(2);
  });

  it("GET /procedures/:prcid/file-link : aperçu PDF d'un Word → nom en .pdf, encodé", async () => {
    services.getProcedure.mockResolvedValue({ ...PROC_ROW, EXTENSION: "docx" });
    services.getVersion.mockResolvedValue({
      VERID: 11, PRCID: 7, VERNUM: 3, FILECODE: "F11", PREVIEWCODE: "P11", ORIGINALNAME: "Procédure cuves.docx",
    });
    const res = await request(app).get("/api/procs/procedures/7/file-link?KIND=preview").set(auth("reader"));
    expect(res.body.data.PATH).toMatch(/\/Proc%C3%A9dure%20cuves\.pdf$/);
  });

  it("GET /procedures/:prcid/file-link : procédure non publiée → 409", async () => {
    services.getProcedure.mockImplementation(async (ctx) => (ctx.ISEDITOR ? { ...PROC_ROW, STATUS: "DRAFT" } : null));
    const res = await request(app).get("/api/procs/procedures/7/file-link").set(auth("admin"));
    expect(res.status).toBe(409);
  });

  it("GET /files/:token : lien altéré → 404 en texte, sans accès aux données", async () => {
    const res = await request(app).get("/api/procs/files/abc.def");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(services.getProcedure).not.toHaveBeenCalled();
  });

  it("PUT /procedures/:prcid/acknowledge : accusé de lecture sur la version courante", async () => {
    services.getProcedure.mockResolvedValue(PROC_ROW);
    services.acknowledge.mockResolvedValue(undefined);
    const res = await request(app).put("/api/procs/procedures/7/acknowledge").set(auth("reader"));
    expect(res.status).toBe(200);
    expect(services.acknowledge).toHaveBeenCalledWith(7, 11, expect.any(Number));
    expect(res.body.data).toEqual({ PRCID: 7, VERID: 11, ACKED: true });
  });
});
