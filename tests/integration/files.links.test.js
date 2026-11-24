import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import request from "supertest";
import { buildTestApp } from "../helpers/buildTestApp.js";
import { buildFormattedUser, buildRawUserRow } from "../helpers/fixtures.js";
import * as jwtUtils from "../../core/utils/jwt.utils.js";

// Crons du module files neutralisés (cf. files.routes.test.js).
vi.mock("../../modules/files/config/module.config.js", () => ({
  startTmpPurgeCron: vi.fn(),
  purgeOldTmpFiles: vi.fn(),
  startDeletedAttachmentsPurgeCron: vi.fn(),
  purgeDeletedAttachments: vi.fn(),
}));
vi.mock("../../modules/files/services.js");
vi.mock("../../modules/procs/services.js");
vi.mock("../../modules/usersmanager/services.js", () => ({ getUserByEmail: vi.fn(), postLoginStats: vi.fn() }));

const filesServices = await import("../../modules/files/services.js");
const procsServices = await import("../../modules/procs/services.js");
const usersmanagerServices = await import("../../modules/usersmanager/services.js");
const { default: filesRouter } = await import("../../modules/files/routes.js");
const { clearCache } = await import("../../core/utils/request.utils.js");
const { hashToken } = await import("../../modules/files/links.js");

const app = buildTestApp(filesRouter, "/api/files");
const DAY = 86400;

async function tokenFor({ email, appcode = "PROCS", permissionName = "USER", USRID }) {
  const overrides = { EMAIL: email, appcode, permissionName, USRID };
  const user = await buildFormattedUser(overrides);
  const payload = jwtUtils.generatePayload(user, user.PERMISSIONS[0].PERMISSION, appcode);
  return { token: jwtUtils.generateJWT(payload), raw: buildRawUserRow(overrides) };
}

const PROC = { PRCID: 7, REFCODE: "PROC-QUA-001", TITLE: "Nettoyage des cuves", CURVERID: 11 };
const VERSION = { VERID: 11, PRCID: 7, VERNUM: 3, FILECODE: "F11", PREVIEWCODE: null, ORIGINALNAME: "nettoyage.pdf" };

/** Ligne FILELINKS telle que renvoyée par services.insertLink / getLink*. */
const linkRow = (over = {}) => ({
  LNKID: 1,
  APPCODE: "PROCS",
  FILECODE: null,
  ENTITYTYPE: "PROCEDURE",
  ENTITYID: "7",
  PARAMS: JSON.stringify({ VERNUM: null, KIND: "original" }),
  FILENAME: "nettoyage.pdf",
  WITHNAME: 1,
  EXPIRESAT: new Date(Date.now() + DAY * 1000),
  CREATEDBY: 2,
  STATUS: "ACTIVE",
  OPENCOUNT: 0,
  ...over,
});

describe("Intégration :: liens directs /api/files", () => {
  const users = {};

  beforeAll(async () => {
    users.reader = await tokenFor({ email: "lecteur-lnk@union-vignerons.com", USRID: 2 });
    users.admin = await tokenFor({ email: "admin-lnk@union-vignerons.com", permissionName: "ADMIN", USRID: 3 });
    // Fichier réel servi par l'ouverture (UPLOAD_PATH de test, cf. vitest.config.js).
    mkdirSync("./tests/.tmp/uploads/LINKS", { recursive: true });
    writeFileSync("./tests/.tmp/uploads/LINKS/nettoyage.pdf", "%PDF-1.4 test");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
    const byEmail = Object.fromEntries(Object.values(users).map((u) => [u.raw.EMAIL, u.raw]));
    usersmanagerServices.getUserByEmail.mockImplementation(async (email) => [byEmail[email]]);
    procsServices.getProcedure.mockResolvedValue(PROC);
    procsServices.getVersion.mockResolvedValue(VERSION);
    procsServices.getVersions.mockResolvedValue([VERSION]);
    procsServices.addConsult.mockResolvedValue(undefined);
    filesServices.insertLink.mockImplementation(async (l) => linkRow({ ...l, EXPIRESAT: l.TTL === null ? null : new Date() }));
    filesServices.markLinkOpened.mockResolvedValue(undefined);
  });

  const auth = (who) => ({ Authorization: `Bearer ${users[who].token}` });

  it("lecteur : lien temporaire (durée par défaut), nom du fichier en fin d'URL", async () => {
    const res = await request(app).post("/api/files/links").set(auth("reader")).send({ TARGET: { PRCID: 7 } });
    expect(res.status).toBe(201);
    expect(res.body.data.PATH).toMatch(/^\/files\/open\/[A-Za-z0-9_-]{32}\/nettoyage\.pdf$/);
    expect(filesServices.insertLink).toHaveBeenCalledWith(
      expect.objectContaining({
        APPCODE: "PROCS",
        ENTITYTYPE: "PROCEDURE",
        ENTITYID: "7",
        PARAMS: JSON.stringify({ VERNUM: null, KIND: "original" }),
        TTL: 7 * DAY,
        WITHNAME: true,
      }),
    );
  });

  it("lecteur : ni lien permanent, ni durée au-delà du maximum", async () => {
    const permanent = await request(app)
      .post("/api/files/links")
      .set(auth("reader"))
      .send({ TARGET: { PRCID: 7 }, PERMANENT: true });
    const long = await request(app)
      .post("/api/files/links")
      .set(auth("reader"))
      .send({ TARGET: { PRCID: 7 }, EXPIRESIN: "30j" });
    expect(permanent.status).toBe(403);
    expect(long.status).toBe(403);
    expect(filesServices.insertLink).not.toHaveBeenCalled();
  });

  it("rédacteur : lien permanent sans nom de fichier", async () => {
    const res = await request(app)
      .post("/api/files/links")
      .set(auth("admin"))
      .send({ TARGET: { PRCID: 7, VERNUM: 3 }, PERMANENT: true, WITHNAME: false });
    expect(res.status).toBe(201);
    expect(res.body.data.PATH).toMatch(/^\/files\/open\/[A-Za-z0-9_-]{32}$/);
    expect(res.body.data.PERMANENT).toBe(true);
    expect(filesServices.insertLink).toHaveBeenCalledWith(
      expect.objectContaining({ TTL: null, WITHNAME: false, PARAMS: JSON.stringify({ VERNUM: 3, KIND: "original" }) }),
    );
  });

  it("procédure non publiée → 409", async () => {
    procsServices.getProcedure.mockImplementation(async (ctx) => (ctx.ISEDITOR ? PROC : null));
    const res = await request(app).post("/api/files/links").set(auth("admin")).send({ TARGET: { PRCID: 7 } });
    expect(res.status).toBe(409);
  });

  it("ouverture sans jeton : version en vigueur servie, consultation tracée ; HEAD non compté", async () => {
    filesServices.getLinkByTokenHash.mockResolvedValue(linkRow());
    filesServices.getFiles.mockResolvedValue([
      { FILECODE: "F11", APPCODE: "PROCS", RELATIVEPATH: "LINKS/nettoyage.pdf", MIMETYPE: "application/pdf", ORIGINALNAME: "nettoyage.pdf" },
    ]);
    const token = "a".repeat(32);

    const head = await request(app).head(`/api/files/open/${token}/nettoyage.pdf`);
    expect(head.status).toBe(200);
    expect(filesServices.markLinkOpened).not.toHaveBeenCalled();

    const res = await request(app).get(`/api/files/open/${token}/nettoyage.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.headers["content-disposition"]).toMatch(/^inline;/);
    expect(filesServices.getLinkByTokenHash).toHaveBeenCalledWith(hashToken(token));
    expect(procsServices.getProcedure).toHaveBeenCalledWith({ USRID: 2, ISEDITOR: false }, 7);
    expect(filesServices.getFiles).toHaveBeenCalledWith({ FILECODE: "F11" });
    expect(filesServices.markLinkOpened).toHaveBeenCalledWith(1);
    await vi.waitFor(() =>
      expect(procsServices.addConsult).toHaveBeenCalledWith({ PRCID: 7, VERID: 11, USRID: 2, KIND: "VIEW" }),
    );
  });

  it("ouverture : lien révoqué ou expiré → 410, procédure dépubliée → 404 (texte brut)", async () => {
    const token = "b".repeat(32);
    filesServices.getLinkByTokenHash.mockResolvedValueOnce(linkRow({ STATUS: "REVOKED" }));
    const revoked = await request(app).get(`/api/files/open/${token}`);
    filesServices.getLinkByTokenHash.mockResolvedValueOnce(linkRow({ STATUS: "EXPIRED" }));
    const expired = await request(app).get(`/api/files/open/${token}`);
    filesServices.getLinkByTokenHash.mockResolvedValueOnce(linkRow());
    procsServices.getProcedure.mockResolvedValueOnce(null);
    const unpublished = await request(app).get(`/api/files/open/${token}`);

    expect(revoked.status).toBe(410);
    expect(expired.status).toBe(410);
    expect(unpublished.status).toBe(404);
    expect(unpublished.headers["content-type"]).toMatch(/text\/plain/);
    expect(filesServices.getFiles).not.toHaveBeenCalled();
  });

  it("ouverture : jeton mal formé → 404 sans requête en base", async () => {
    const res = await request(app).get("/api/files/open/pas-un-jeton");
    expect(res.status).toBe(404);
    expect(filesServices.getLinkByTokenHash).not.toHaveBeenCalled();
  });

  it("liste : un lecteur ne voit que ses liens, un rédacteur tous", async () => {
    filesServices.listLinks.mockResolvedValue([linkRow()]);
    await request(app).get("/api/files/links?ENTITYTYPE=PROCEDURE&ENTITYID=7").set(auth("reader"));
    expect(filesServices.listLinks).toHaveBeenLastCalledWith(expect.objectContaining({ APPCODE: "PROCS", CREATEDBY: 2 }));
    const res = await request(app).get("/api/files/links?ENTITYTYPE=PROCEDURE&ENTITYID=7").set(auth("admin"));
    expect(filesServices.listLinks).toHaveBeenLastCalledWith(expect.objectContaining({ CREATEDBY: null }));
    expect(res.body.data[0]).toMatchObject({ LNKID: 1, PARAMS: { VERNUM: null, KIND: "original" }, WITHNAME: true });
  });

  it("révocation : par son auteur ou un rédacteur, pas par un autre lecteur", async () => {
    filesServices.getLinkById.mockResolvedValue(linkRow({ CREATEDBY: 99 }));
    filesServices.revokeLink.mockResolvedValue(linkRow({ STATUS: "REVOKED" }));
    const reader = await request(app).delete("/api/files/links/1").set(auth("reader"));
    const admin = await request(app).delete("/api/files/links/1").set(auth("admin"));
    expect(reader.status).toBe(403);
    expect(admin.status).toBe(200);
    expect(filesServices.revokeLink).toHaveBeenCalledTimes(1);
  });
});
