import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { buildTestApp } from "../helpers/buildTestApp.js";
import { buildAuthToken } from "../helpers/fixtures.js";

// Le cron de purge tmp/ (startTmpPurgeCron, cf. modules/files/config/module.config.js)
// est déclenché à l'import de routes.js : on le neutralise en test pour ne
// pas laisser un setTimeout planifié (parfois plusieurs jours) vivant après
// la suite de tests.
vi.mock("../../modules/files/config/module.config.js", () => ({
  startTmpPurgeCron: vi.fn(),
  purgeOldTmpFiles: vi.fn(),
  startDeletedAttachmentsPurgeCron: vi.fn(),
  purgeDeletedAttachments: vi.fn(),
}));
vi.mock("../../modules/files/services.js");
vi.mock("../../modules/usersmanager/services.js", () => ({
  getUserByEmail: vi.fn(),
  postLoginStats: vi.fn(),
}));
// Une vraie `class` (plutôt que vi.fn().mockImplementation(...)) est
// nécessaire ici : un mock construit avec `new` via vi.fn() ne relaie pas
// toujours correctement l'objet retourné par l'implémentation (le `this`
// de l'instance mockée se retrouve alors sans `saveUploadedFiles`).
vi.mock("../../core/services/storage.service.js", () => ({
  StorageService: class {
    async saveUploadedFiles() {
      return [{ FILECODE: "abc123", ORIGINALNAME: "test.png" }];
    }
  },
}));

const filesServices = await import("../../modules/files/services.js");
const usersmanagerServices = await import("../../modules/usersmanager/services.js");
const { default: filesRouter } = await import("../../modules/files/routes.js");
const { clearCache } = await import("../../core/utils/request.utils.js");

const app = buildTestApp(filesRouter, "/api/files");

describe("Intégration :: /api/files", () => {
  let token;
  let rawUser;

  beforeAll(async () => {
    ({ token, raw: rawUser } = await buildAuthToken({ EMAIL: "int-files@union-vignerons.com", appcode: "FILES" }));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
    usersmanagerServices.getUserByEmail.mockResolvedValue([rawUser]);
  });

  it("POST /api/files/upload sans token → 401", async () => {
    const res = await request(app).post("/api/files/upload");
    expect(res.status).toBe(401);
  });

  it("POST /api/files/upload sans fichier joint → 400", async () => {
    const res = await request(app)
      .post("/api/files/upload")
      .set("Authorization", `Bearer ${token}`)
      .field("appcode", "ticketing")
      .field("entityid", "100")
      .field("entitytyp", "ticket");

    expect(res.status).toBe(400);
  });

  it("POST /api/files/upload avec un fichier → 201 + métadonnées du fichier", async () => {
    const res = await request(app)
      .post("/api/files/upload")
      .set("Authorization", `Bearer ${token}`)
      .field("appcode", "ticketing")
      .field("entityid", "100")
      .field("entitytyp", "ticket")
      .attach("files", Buffer.from("contenu de test"), "test.png");

    expect(res.status).toBe(201);
    expect(res.body.data[0].FILECODE).toBe("abc123");
  });

  it("DELETE /api/files/delete par filecode → 200", async () => {
    filesServices.deleteFileByCode.mockResolvedValue(true);

    const res = await request(app)
      .delete("/api/files/delete")
      .set("Authorization", `Bearer ${token}`)
      .send({ metas: [{ filecode: "abc123" }] });

    expect(res.status).toBe(200);
    expect(res.body.data).toBe(true);
    expect(filesServices.deleteFileByCode).toHaveBeenCalledWith("abc123");
  });
});
