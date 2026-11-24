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
    filesServices.addLinkEvent.mockResolvedValue(undefined);
    filesServices.updateLinkExpiry.mockImplementation(async (LNKID, TTL) => linkRow({ LNKID, EXPIRESAT: TTL === null ? null : new Date() }));
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

  it("création : jeton stocké chiffré, recopiable depuis la liste", async () => {
    const created = await request(app)
      .post("/api/files/links")
      .set(auth("reader"))
      .send({ TARGET: { PRCID: 7 }, WITHNAME: false });
    const stored = filesServices.insertLink.mock.calls[0][0];
    expect(stored.TOKENENC).toMatch(/^v1\./);
    expect(stored).not.toHaveProperty("TOKEN");

    filesServices.listLinks.mockResolvedValue([linkRow({ TOKENENC: stored.TOKENENC, WITHNAME: 0 })]);
    const list = await request(app).get("/api/files/links?ENTITYTYPE=PROCEDURE&ENTITYID=7").set(auth("reader"));
    expect(created.body.data.PATH).toMatch(/^\/files\/open\/[A-Za-z0-9_-]{32}$/);
    expect(list.body.data[0].PATH).toBe(created.body.data.PATH);
    expect(list.body.data[0]).not.toHaveProperty("TOKENENC");
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

  it("mouvements : création, ouverture (IP, navigateur) et refus journalisés ; HEAD ignoré", async () => {
    await request(app).post("/api/files/links").set(auth("reader")).send({ TARGET: { PRCID: 7 } });
    await vi.waitFor(() =>
      expect(filesServices.addLinkEvent).toHaveBeenCalledWith(
        expect.objectContaining({ EVENT: "CREATED", USRID: 2, DETAIL: "Validité : 7 jours · nom du fichier dans le lien" }),
      ),
    );

    filesServices.addLinkEvent.mockClear();
    filesServices.getLinkByTokenHash.mockResolvedValue(linkRow());
    filesServices.getFiles.mockResolvedValue([
      { FILECODE: "F11", APPCODE: "PROCS", RELATIVEPATH: "LINKS/nettoyage.pdf", MIMETYPE: "application/pdf", ORIGINALNAME: "nettoyage.pdf" },
    ]);
    const token = "c".repeat(32);
    await request(app).head(`/api/files/open/${token}`);
    await request(app).get(`/api/files/open/${token}`).set("X-Forwarded-For", "10.1.2.3, 10.0.0.1").set("User-Agent", "Navigateur test");
    await vi.waitFor(() =>
      expect(filesServices.addLinkEvent).toHaveBeenCalledWith({
        LNKID: 1,
        EVENT: "OPENED",
        IP: "10.1.2.3",
        USERAGENT: "Navigateur test",
        USRID: null,
        USRNAME: null,
        DETAIL: "v3 · nettoyage.pdf",
      }),
    );
    expect(filesServices.addLinkEvent).toHaveBeenCalledTimes(1);

    // Lecteur identifié par le cookie de session UNIS de son navigateur.
    filesServices.addLinkEvent.mockClear();
    await request(app)
      .get(`/api/files/open/${token}`)
      .set("Cookie", `theme=dark; uvcdr-apps-jwt-PROCS=${users.reader.token}`);
    await vi.waitFor(() =>
      expect(filesServices.addLinkEvent).toHaveBeenCalledWith(
        expect.objectContaining({ EVENT: "OPENED", USRID: 2 }),
      ),
    );

    filesServices.getLinkByTokenHash.mockResolvedValue(linkRow({ STATUS: "EXPIRED" }));
    await request(app).get(`/api/files/open/${token}`);
    await vi.waitFor(() =>
      expect(filesServices.addLinkEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ EVENT: "REFUSED", DETAIL: "Lien expiré" }),
      ),
    );
  });

  it("modification : le lecteur prolonge son lien dans la limite, le rédacteur le rend permanent", async () => {
    filesServices.getLinkById.mockResolvedValue(linkRow({ CREATEDBY: 2, STATUS: "EXPIRED" }));

    const tooLong = await request(app).put("/api/files/links/1").set(auth("reader")).send({ EXPIRESIN: "30j" });
    const permanentByReader = await request(app).put("/api/files/links/1").set(auth("reader")).send({ PERMANENT: true });
    const extended = await request(app).put("/api/files/links/1").set(auth("reader")).send({ EXPIRESIN: "3j" });
    expect(tooLong.status).toBe(403);
    expect(permanentByReader.status).toBe(403);
    expect(extended.status).toBe(200);
    expect(filesServices.updateLinkExpiry).toHaveBeenLastCalledWith(1, 3 * DAY);

    const permanent = await request(app).put("/api/files/links/1").set(auth("admin")).send({ PERMANENT: true });
    expect(permanent.status).toBe(200);
    expect(filesServices.updateLinkExpiry).toHaveBeenLastCalledWith(1, null);
    await vi.waitFor(() =>
      expect(filesServices.addLinkEvent).toHaveBeenCalledWith(
        expect.objectContaining({ EVENT: "UPDATED", USRID: 3, DETAIL: "Rendu permanent" }),
      ),
    );
  });

  it("modification : lien désactivé → 409 ; lien d'un autre → 403 pour un lecteur", async () => {
    filesServices.getLinkById.mockResolvedValueOnce(linkRow({ CREATEDBY: 2, REVOKEDAT: new Date(), STATUS: "REVOKED" }));
    const revoked = await request(app).put("/api/files/links/1").set(auth("reader")).send({ EXPIRESIN: "1j" });
    filesServices.getLinkById.mockResolvedValueOnce(linkRow({ CREATEDBY: 99 }));
    const other = await request(app).put("/api/files/links/1").set(auth("reader")).send({ EXPIRESIN: "1j" });
    expect(revoked.status).toBe(409);
    expect(other.status).toBe(403);
    expect(filesServices.updateLinkExpiry).not.toHaveBeenCalled();
  });

  it("mouvements : le lecteur voit ceux de ses liens sans IP, le rédacteur tous avec IP", async () => {
    const event = {
      EVTID: 9, LNKID: 1, EVENT: "OPENED", IP: "10.1.2.3", USERAGENT: "Navigateur test", DETAIL: "v3 · nettoyage.pdf",
      CREATEDAT: new Date(), PARAMS: JSON.stringify({ VERNUM: null, KIND: "original" }), FILENAME: "nettoyage.pdf", CREATEDBY: 2,
    };
    filesServices.listLinkEvents.mockResolvedValue([event]);

    const reader = await request(app).get("/api/files/links/events?ENTITYTYPE=PROCEDURE&ENTITYID=7").set(auth("reader"));
    expect(filesServices.listLinkEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ APPCODE: "PROCS", ENTITYTYPE: "PROCEDURE", ENTITYID: "7", CREATEDBY: 2 }),
    );
    expect(reader.body.data[0]).toMatchObject({ EVENT: "OPENED", DETAIL: "v3 · nettoyage.pdf" });
    expect(reader.body.data[0].IP).toBeUndefined();

    const admin = await request(app).get("/api/files/links/events?LNKID=1").set(auth("admin"));
    expect(filesServices.listLinkEvents).toHaveBeenLastCalledWith(expect.objectContaining({ LNKID: 1, CREATEDBY: null }));
    expect(admin.body.data[0]).toMatchObject({ IP: "10.1.2.3", USERAGENT: "Navigateur test" });
  });
});
