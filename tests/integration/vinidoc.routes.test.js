import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { buildTestApp } from "../helpers/buildTestApp.js";
import { buildFormattedUser, buildRawUserRow } from "../helpers/fixtures.js";
import * as jwtUtils from "../../core/utils/jwt.utils.js";

vi.mock("../../modules/vinidoc/services.js");
vi.mock("../../modules/vinidoc/engine/pdf-converter.js", () => ({ convertPptxToPdf: vi.fn() }));
vi.mock("../../modules/usersmanager/services.js", () => ({ getUserByEmail: vi.fn() }));
vi.mock("../../modules/files/services.js", () => ({ deleteFileByCode: vi.fn() }));
vi.mock("../../config/websocket/wsManager.js", () => ({ broadcastToAll: vi.fn() }));
vi.mock("../../core/services/mail.service.js", () => ({
  sendTemplatedMail: vi.fn().mockResolvedValue(undefined),
  renderDetailsList: vi.fn(() => ""),
}));

const services = await import("../../modules/vinidoc/services.js");
const usersmanagerServices = await import("../../modules/usersmanager/services.js");
const { default: router } = await import("../../modules/vinidoc/routes.js");
const { clearCache } = await import("../../core/utils/request.utils.js");

const app = buildTestApp(router, "/api/vinidoc");

const ROWVER = "0x00000000000007D1";
const ROWVER_BUF = Buffer.from("00000000000007d1", "hex");

/** JWT d'un utilisateur d'un service donné, pour l'application `appcode`. */
async function tokenFor({ email, service, appcode = "VINDOC", permissionName = "USER" }) {
  const overrides = { EMAIL: email, appcode, permissionName };
  const user = await buildFormattedUser(overrides);
  user.SERVICE = { ...user.SERVICE, SRVNAM: service };
  const payload = jwtUtils.generatePayload(user, user.PERMISSIONS[0].PERMISSION, appcode);
  return { token: jwtUtils.generateJWT(payload), raw: buildRawUserRow(overrides) };
}

const SHEET = {
  SHTID: 1,
  CODVRAC: "VHL09393",
  MILLESIME: 2025,
  APPELL: "CDR",
  COLCOD: "BLANC",
  INTARO: 3,
  INTBOU: 1,
  ECHFRU: 3,
  TEMPMIN: 8,
  TEMPMAX: 10,
  STATUS: "SUBMITTED",
  LASTVER: 0,
  SUBUSR: "oeno@union-vignerons.com",
  ROWVER,
  TRANSLATIONS: { fr: { DEGUST: "Robe jaune pâle brillante.", MODUSR: "x", MODDAT: null } },
};

describe("Intégration :: /api/vinidoc", () => {
  const users = {};

  beforeAll(async () => {
    process.env.VINIDOC_EDITOR_SERVICES = "OENOLOGIE";
    process.env.VINIDOC_VALIDATOR_SERVICES = "MARKETING";
    users.oeno = await tokenFor({ email: "oeno@union-vignerons.com", service: "Œnologie" });
    users.marketing = await tokenFor({ email: "marketing@union-vignerons.com", service: "Marketing" });
    users.otherApp = await tokenFor({ email: "autre@union-vignerons.com", service: "Œnologie", appcode: "TICKETING" });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
    const byEmail = Object.fromEntries(Object.values(users).map((u) => [u.raw.EMAIL, u.raw]));
    usersmanagerServices.getUserByEmail.mockImplementation(async (email) => [byEmail[email]]);
    services.getLanguages.mockResolvedValue([{ LNGCOD: "fr", ISDEFAULT: true }]);
  });

  const auth = (who) => ({ Authorization: `Bearer ${users[who].token}` });

  it("sans token → 401", async () => {
    const res = await request(app).get("/api/vinidoc/sheets");
    expect(res.status).toBe(401);
  });

  it("token d'une autre application → refusé (460, sans déconnexion)", async () => {
    const res = await request(app).get("/api/vinidoc/sheets").set(auth("otherApp"));
    expect(res.status).toBe(460);
  });

  it("GET /me expose les droits selon le service", async () => {
    services.getColors.mockResolvedValue([]);
    const oeno = await request(app).get("/api/vinidoc/me").set(auth("oeno"));
    const mkt = await request(app).get("/api/vinidoc/me").set(auth("marketing"));
    expect(oeno.body.data.RIGHTS).toMatchObject({ EDIT: true, VALIDATE: false });
    expect(mkt.body.data.RIGHTS).toMatchObject({ EDIT: false, VALIDATE: true });
    expect(oeno.body.data.DEFAULT_LNGCOD).toBe("fr");
  });

  it("POST /sheets par l'œnologie → 201 avec la traduction dans la langue par défaut", async () => {
    services.createSheet.mockResolvedValue({ SHTID: 1, STATUS: "DRAFT", LASTVER: 0, ROWVER: ROWVER_BUF });

    const res = await request(app)
      .post("/api/vinidoc/sheets")
      .set(auth("oeno"))
      .send({ CODVRAC: "vhl09393", MILLESIME: 2025, APPELL: "CDR", COLCOD: "BLANC", TRANSLATION: { GARDE: "2 ans" } });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ SHTID: 1, STATUS: "DRAFT", LASTVER: 0, ROWVER });
    expect(services.createSheet).toHaveBeenCalledWith(
      expect.objectContaining({
        LNGCOD: "fr",
        USR: "oeno@union-vignerons.com",
        sheet: expect.objectContaining({ CODVRAC: "VHL09393" }),
        translation: expect.objectContaining({ GARDE: "2 ans" }),
      }),
    );
  });

  it("POST /sheets par le marketing → refusé", async () => {
    const res = await request(app)
      .post("/api/vinidoc/sheets")
      .set(auth("marketing"))
      .send({ CODVRAC: "X", APPELL: "CDR", COLCOD: "ROUGE" });
    expect(res.status).toBe(460);
    expect(services.createSheet).not.toHaveBeenCalled();
  });

  it("POST /sheets invalide → 400 (zod)", async () => {
    const res = await request(app).post("/api/vinidoc/sheets").set(auth("oeno")).send({ CODVRAC: "X", INTARO: 9 });
    expect(res.status).toBe(400);
  });

  it("POST /sheets en doublon → 409", async () => {
    services.createSheet.mockRejectedValue(new Error("VINIDOC_SHEET_ALREADY_EXISTS"));
    const res = await request(app)
      .post("/api/vinidoc/sheets")
      .set(auth("oeno"))
      .send({ CODVRAC: "X", APPELL: "CDR", COLCOD: "ROUGE" });
    expect(res.status).toBe(409);
    expect(res.body.error.key).toBe("VINIDOC_SHEET_ALREADY_EXISTS");
  });

  it("POST /sheets/:id/validate fige un instantané sans métadonnées de workflow", async () => {
    services.getSheet.mockResolvedValue(SHEET);
    services.validateSheet.mockResolvedValue({ SHTID: 1, STATUS: "VALIDATED", LASTVER: 1, ROWVER: ROWVER_BUF });

    const res = await request(app)
      .post("/api/vinidoc/sheets/1/validate")
      .set(auth("marketing"))
      .send({ ROWVER: ROWVER.toLowerCase() });

    expect(res.status).toBe(200);
    expect(res.body.data.STATUS).toBe("VALIDATED");
    const { SNAPSHOT } = services.validateSheet.mock.calls[0][0];
    expect(SNAPSHOT.STATUS).toBeUndefined();
    expect(SNAPSHOT.TRANSLATIONS.fr).toEqual({ DEGUST: "Robe jaune pâle brillante." });
  });

  it("POST /sheets/:id/validate avec un ROWVER périmé → 409, rien n'est validé", async () => {
    services.getSheet.mockResolvedValue(SHEET);
    const res = await request(app)
      .post("/api/vinidoc/sheets/1/validate")
      .set(auth("marketing"))
      .send({ ROWVER: "0x0000000000000001" });
    expect(res.status).toBe(409);
    expect(services.validateSheet).not.toHaveBeenCalled();
  });

  it("POST /sheets/:id/validate par l'œnologie → refusé", async () => {
    const res = await request(app).post("/api/vinidoc/sheets/1/validate").set(auth("oeno")).send({ ROWVER });
    expect(res.status).toBe(460);
  });

  it("PUT /sheets/:id par le marketing → transmis au service avec les droits de relecture", async () => {
    services.updateSheet.mockResolvedValue({ SHTID: 1, STATUS: "SUBMITTED", LASTVER: 0, ROWVER: ROWVER_BUF });
    const res = await request(app)
      .put("/api/vinidoc/sheets/1")
      .set(auth("marketing"))
      .send({ CODVRAC: "VHL09393", APPELL: "CDR", COLCOD: "BLANC", ROWVER });
    expect(res.status).toBe(200);
    expect(res.body.data.STATUS).toBe("SUBMITTED");
    expect(services.updateSheet).toHaveBeenCalledWith(
      expect.objectContaining({ RIGHTS: { CANEDIT: false, CANVALIDATE: true }, USR: "marketing@union-vignerons.com" }),
    );
  });

  it("PUT /sheets/:id/translations/:lng par l'œnologie → droits de saisie", async () => {
    services.upsertTranslation.mockResolvedValue({ SHTID: 1, STATUS: "DRAFT", LASTVER: 0, ROWVER: ROWVER_BUF });
    const res = await request(app)
      .put("/api/vinidoc/sheets/1/translations/fr")
      .set(auth("oeno"))
      .send({ DEGUST: "Robe or.", ROWVER });
    expect(res.status).toBe(200);
    expect(services.upsertTranslation).toHaveBeenCalledWith(
      expect.objectContaining({ RIGHTS: { CANEDIT: true, CANVALIDATE: false } }),
    );
  });

  it("PUT /sheets/:id par le marketing hors relecture → transition refusée par le service", async () => {
    services.updateSheet.mockRejectedValue(new Error("VINIDOC_INVALID_STATUS_TRANSITION"));
    const res = await request(app)
      .put("/api/vinidoc/sheets/1")
      .set(auth("marketing"))
      .send({ CODVRAC: "VHL09393", APPELL: "CDR", COLCOD: "BLANC", ROWVER });
    expect(res.body.error.key).toBe("VINIDOC_INVALID_STATUS_TRANSITION");
  });

  it("DELETE /sheets/:id par le marketing → refusé", async () => {
    const res = await request(app).delete("/api/vinidoc/sheets/1").set(auth("marketing")).send({ ROWVER });
    expect(res.status).toBe(460);
    expect(services.deleteSheet).not.toHaveBeenCalled();
  });

  it("POST /sheets/:id/reject sans motif → 400", async () => {
    const res = await request(app).post("/api/vinidoc/sheets/1/reject").set(auth("marketing")).send({ ROWVER });
    expect(res.status).toBe(400);
  });

  const VALIDATED_SHEET = { ...SHEET, STATUS: "VALIDATED", LASTVER: 1 };
  const DEGUST_MAX_10 = {
    TPLID: 2,
    ACTIVE: true,
    RELATIVEPATH: "x.pptx",
    TAGS: [{ TAGTYP: "TEXT", TAGNAM: "DEGUST", MAXLEN: 10, REQUIRED: false, ISKNOWN: true }],
  };

  it("POST /generate d'une fiche non validée → contrôle la saisie en cours (non bloquant)", async () => {
    services.getSheet.mockResolvedValue({
      ...SHEET,
      TRANSLATIONS: { fr: { DEGUST: "Saisie en cours, pas encore validée." } },
    });
    services.getTemplate.mockResolvedValue(DEGUST_MAX_10);
    services.getColorTrans.mockResolvedValue({ LABEL: "Blanc" });

    const res = await request(app)
      .post("/api/vinidoc/generate")
      .set(auth("marketing"))
      .send({ SHTID: 1, TPLID: 2, LNGCOD: "fr" });

    // Plus de 409 "non validée" : c'est bien le texte en cours (36 car.) qui est contrôlé.
    expect(res.status).toBe(422);
    expect(res.body.error.values).toEqual({ DETAILS: "DEGUST 36/10" });
    expect(services.getSheetVersion).not.toHaveBeenCalled();
  });

  it("POST /generate : traduction absente dans la version validée → 422", async () => {
    services.getSheet.mockResolvedValue(VALIDATED_SHEET);
    services.getSheetVersion.mockResolvedValue({ VERNUM: 1, SNAPSHOT: SHEET });
    services.getTemplate.mockResolvedValue({ TPLID: 2, ACTIVE: true, RELATIVEPATH: "x.pptx", TAGS: [] });

    const res = await request(app)
      .post("/api/vinidoc/generate")
      .set(auth("marketing"))
      .send({ SHTID: 1, TPLID: 2, LNGCOD: "en" });

    expect(res.status).toBe(422);
    expect(res.body.error.values).toEqual({ LNGCOD: "en" });
  });

  it("POST /generate : texte trop long dans la version validée → 422 avec le détail", async () => {
    services.getSheet.mockResolvedValue(VALIDATED_SHEET);
    services.getSheetVersion.mockResolvedValue({ VERNUM: 1, SNAPSHOT: SHEET });
    services.getTemplate.mockResolvedValue({
      TPLID: 2,
      ACTIVE: true,
      RELATIVEPATH: "x.pptx",
      TAGS: [{ TAGTYP: "TEXT", TAGNAM: "DEGUST", MAXLEN: 10, REQUIRED: false, ISKNOWN: true }],
    });
    services.getColorTrans.mockResolvedValue({ LABEL: "Blanc" });

    const res = await request(app)
      .post("/api/vinidoc/generate")
      .set(auth("marketing"))
      .send({ SHTID: 1, TPLID: 2, LNGCOD: "fr" });

    expect(res.status).toBe(422);
    expect(res.body.error.key).toBe("VINIDOC_TAG_CONSTRAINTS_DEGUST 26/10");
    expect(res.body.error.values).toEqual({ DETAILS: "DEGUST 26/10" });
  });

  it("POST /sheets/:id/check contrôle les données en cours contre les modèles actifs", async () => {
    services.getSheet.mockResolvedValue(SHEET);
    services.getColorTrans.mockResolvedValue({});
    services.getTextTagLimits.mockResolvedValue([
      { TPLID: 2, TPLNAM: "Standard", TAGTYP: "TEXT", TAGNAM: "DEGUST", MAXLEN: 300, REQUIRED: 1, ISKNOWN: 1 },
      { TPLID: 3, TPLNAM: "Compacte", TAGTYP: "TEXT", TAGNAM: "DEGUST", MAXLEN: 10, REQUIRED: 0, ISKNOWN: 1 },
    ]);

    const res = await request(app).post("/api/vinidoc/sheets/1/check").set(auth("oeno")).send({ LNGCOD: "fr" });

    expect(res.status).toBe(200);
    expect(res.body.data.OK).toBe(false);
    expect(res.body.data.TEMPLATES.map((t) => [t.TPLID, t.OK])).toEqual([
      [2, true],
      [3, false],
    ]);
  });

  it("GET /sheets signale les anomalies de saisie de chaque fiche", async () => {
    services.listSheets.mockResolvedValue({
      TOTAL: 2, PAGE: 1, PAGESIZE: 50,
      ITEMS: [{ SHTID: 1, CODVRAC: "A" }, { SHTID: 2, CODVRAC: "B" }],
    });
    services.getSheetsFull.mockResolvedValue([
      { ...SHEET, SHTID: 1 },
      { ...SHEET, SHTID: 2, TRANSLATIONS: { en: { DEGUST: "x" } } },
    ]);
    services.getColors.mockResolvedValue([]);
    services.getTextTagLimits.mockResolvedValue([
      { TPLID: 3, TPLNAM: "Compacte", TPLLNG: null, TAGTYP: "TEXT", TAGNAM: "DEGUST", MAXLEN: 10, REQUIRED: 0, ISKNOWN: 1 },
    ]);

    const res = await request(app).get("/api/vinidoc/sheets").set(auth("marketing"));

    expect(res.status).toBe(200);
    expect(services.getSheetsFull).toHaveBeenCalledWith({ SHTIDS: [1, 2] });
    const [a, b] = res.body.data.ITEMS;
    expect(a.ISSUES).toEqual([
      "[FR] Dégustation : texte trop long (26 caractères, 10 max — modèle Compacte).",
    ]);
    expect(b.ISSUES).toEqual(["[FR] Traduction de la langue par défaut absente."]);
  });

  it("POST /sheets/submit-all soumet les fiches conformes et écarte celles en anomalie", async () => {
    services.getSheetsFull.mockResolvedValue([
      { ...SHEET, SHTID: 1, STATUS: "DRAFT" },
      { ...SHEET, SHTID: 2, STATUS: "DRAFT", CODVRAC: "LONG", TRANSLATIONS: { fr: { DEGUST: "x".repeat(400) } } },
    ]);
    services.getColors.mockResolvedValue([]);
    services.getTextTagLimits.mockResolvedValue([
      { TPLID: 2, TPLNAM: "Standard", TPLLNG: null, TAGTYP: "TEXT", TAGNAM: "DEGUST", MAXLEN: 300, REQUIRED: 1, ISKNOWN: 1 },
    ]);
    services.submitSheet.mockResolvedValue({ SHTID: 1, STATUS: "SUBMITTED", LASTVER: 0, ROWVER: ROWVER_BUF });

    const res = await request(app)
      .post("/api/vinidoc/sheets/submit-all")
      .set(auth("oeno"))
      .send({ COLCOD: "blanc" });

    expect(res.status).toBe(200);
    expect(services.getSheetsFull).toHaveBeenCalledWith({ COLCOD: "BLANC", SUBMITTABLE: true });
    expect(services.submitSheet).toHaveBeenCalledTimes(1);
    expect(services.submitSheet.mock.calls[0][0]).toMatchObject({ SHTID: 1, ROWVER });
    expect(res.body.data.SUBMITTED).toEqual([{ SHTID: 1, CODVRAC: "VHL09393", MILLESIME: 2025 }]);
    expect(res.body.data.ERRORS).toEqual([
      {
        SHTID: 2,
        CODVRAC: "LONG",
        MILLESIME: 2025,
        MESSAGES: ["[FR] Dégustation : texte trop long (400 caractères, 300 max — modèle Standard)."],
      },
    ]);
  });

  it("POST /sheets/submit-all par le marketing → refusé", async () => {
    const res = await request(app).post("/api/vinidoc/sheets/submit-all").set(auth("marketing")).send({});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(services.submitSheet).not.toHaveBeenCalled();
  });
});
