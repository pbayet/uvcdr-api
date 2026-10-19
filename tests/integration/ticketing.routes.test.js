import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { buildTestApp } from "../helpers/buildTestApp.js";
import { buildAuthToken, buildTicketRow } from "../helpers/fixtures.js";

// Seules les "feuilles" qui toucheraient une vraie base/LDAP/SMTP sont
// mockées : les vrais routes.js / controllers.js / validators.js / utils.js
// / auth.middleware.js sont exécutés, ce qui exerce le routage, la
// validation zod, l'auth JWT et le formatage de réponse de bout en bout.
vi.mock("../../modules/ticketing/services.js");
vi.mock("../../modules/usersmanager/services.js", () => ({
  getUserByEmail: vi.fn(),
  postLoginStats: vi.fn(),
}));
vi.mock("../../config/websocket/wsManager.js", () => ({
  broadcastToAll: vi.fn(),
  broadcastToUsers: vi.fn(),
}));
vi.mock("../../core/services/mail.service.js", () => ({
  sendTemplatedMail: vi.fn().mockResolvedValue(undefined),
  renderDetailsList: vi.fn(() => ""),
  renderContactList: vi.fn(() => ""),
}));

const ticketingServices = await import("../../modules/ticketing/services.js");
const usersmanagerServices = await import("../../modules/usersmanager/services.js");
const { default: ticketingRouter } = await import("../../modules/ticketing/routes.js");
const { clearCache } = await import("../../core/utils/request.utils.js");

const app = buildTestApp(ticketingRouter, "/api/ticketing");

describe("Intégration :: /api/ticketing", () => {
  let token;
  let rawUser;

  beforeAll(async () => {
    ({ token, raw: rawUser } = await buildAuthToken({ EMAIL: "int-ticketing@union-vignerons.com", appcode: "TICKETING" }));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
    usersmanagerServices.getUserByEmail.mockResolvedValue([rawUser]);
  });

  it("GET /api/ticketing sans token → 401", async () => {
    const res = await request(app).get("/api/ticketing");
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.key).toBe("INVALID_TOKEN");
  });

  it("GET /api/ticketing avec un token valide → 200 + liste de tickets formatés", async () => {
    ticketingServices.getTickets.mockResolvedValue([buildTicketRow()]);

    const res = await request(app).get("/api/ticketing").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].TCKCOD).toBe("TCK-000100");
  });

  it("POST /api/ticketing avec un payload invalide → 400 (validation zod)", async () => {
    const res = await request(app)
      .post("/api/ticketing")
      .set("Authorization", `Bearer ${token}`)
      .send({ SRVID: 10 }); // TITLE manquant

    expect(res.status).toBe(400);
    expect(res.body.error.key).toBe("MISSING_PARAMETERS");
    expect(ticketingServices.createTicket).not.toHaveBeenCalled();
  });

  it("POST /api/ticketing avec un payload valide → 201 + ticket créé", async () => {
    ticketingServices.createTicket.mockResolvedValue("TCK-000300");
    ticketingServices.getTicket.mockResolvedValue([buildTicketRow({ TCKID: 300, TCKCOD: "TCK-000300" })]);

    const res = await request(app)
      .post("/api/ticketing")
      .set("Authorization", `Bearer ${token}`)
      .send({ TITLE: "Panne réseau", SRVID: 10 });

    expect(res.status).toBe(201);
    expect(res.body.data.TCKCOD).toBe("TCK-000300");
  });

  it("DELETE /api/ticketing renvoie 404 si le ticket n'existe pas", async () => {
    ticketingServices.getTicket.mockResolvedValue([]);

    const res = await request(app)
      .delete("/api/ticketing")
      .set("Authorization", `Bearer ${token}`)
      .send({ TCKNUM: "TCK-INEXISTANT" });

    expect(res.status).toBe(404);
  });

  it("GET /api/ticketing/statuses et /priorities répondent 200", async () => {
    ticketingServices.getStatuses.mockResolvedValue([{ STSID: 1, NAME: "Ouvert" }]);
    ticketingServices.getPriorities.mockResolvedValue([{ PRIID: 1, NAME: "Normale" }]);

    const statuses = await request(app).get("/api/ticketing/statuses").set("Authorization", `Bearer ${token}`);
    const priorities = await request(app).get("/api/ticketing/priorities").set("Authorization", `Bearer ${token}`);

    expect(statuses.status).toBe(200);
    expect(priorities.status).toBe(200);
  });

  it("un token expiré est rejeté avec 401 TOKEN_EXPIRED", async () => {
    const jwt = await import("jsonwebtoken");
    const expiredToken = jwt.default.sign(
      { permissionLevel: 4, application: "TICKETING", data: { id: 1, email: "x@x.com" } },
      process.env.JWT_SECRET,
      { expiresIn: -10 },
    );

    const res = await request(app).get("/api/ticketing").set("Authorization", `Bearer ${expiredToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error.key).toBe("TOKEN_EXPIRED");
  });
});
