import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateJWT, generatePayload } from "../../../core/utils/jwt.utils.js";

vi.mock("../../../modules/usersmanager/services.js", () => ({
  postActivityStats: vi.fn().mockResolvedValue(true),
}));

const { postActivityStats } = await import("../../../modules/usersmanager/services.js");
const {
  getAuthorizationPayload,
  PerfMonitoring,
  logHandler,
  saveLogInBase,
} = await import("../../../core/middlewares/log.middleware.js");

function buildRes() {
  const listeners = {};
  return {
    locals: {},
    on: vi.fn((event, cb) => {
      listeners[event] = cb;
    }),
    emitFinish: () => listeners.finish?.(),
  };
}

describe("core/middlewares/log.middleware :: getAuthorizationPayload", () => {
  it("décode le payload JWT si un Bearer token valide est présent", () => {
    const payload = generatePayload({ USRID: 1, EMAIL: "a@b.com" }, { PRMNAM: "USER", PRMLVL: 4 }, "TICKETING");
    const token = generateJWT(payload);
    const req = { headers: { authorization: `Bearer ${token}` } };
    const next = vi.fn();

    getAuthorizationPayload(req, {}, next);

    expect(req.payload.data.email).toBe("a@b.com");
    expect(next).toHaveBeenCalledOnce();
  });

  it("met payload à null (sans lever) si aucun token n'est présent", () => {
    const req = { headers: {} };
    const next = vi.fn();

    getAuthorizationPayload(req, {}, next);

    expect(req.payload).toBeNull();
    expect(next).toHaveBeenCalledOnce();
  });

  it("met payload à null pour un token malformé", () => {
    const req = { headers: { authorization: "Bearer pas-un-jwt" } };
    const next = vi.fn();

    getAuthorizationPayload(req, {}, next);

    expect(req.payload).toBeNull();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("core/middlewares/log.middleware :: PerfMonitoring", () => {
  it("appelle next() immédiatement et enregistre un listener 'finish'", () => {
    const req = { method: "GET", originalUrl: "/api/ticketing" };
    const res = buildRes();
    const next = vi.fn();

    PerfMonitoring(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.on).toHaveBeenCalledWith("finish", expect.any(Function));
  });
});

describe("core/middlewares/log.middleware :: logHandler", () => {
  it("appelle next() et enregistre un listener 'finish' sans lever", () => {
    const req = { method: "GET", originalUrl: "/api/ticketing", payload: null };
    const res = buildRes();
    const next = vi.fn();

    logHandler(req, res, next);
    expect(next).toHaveBeenCalledOnce();

    expect(() => res.emitFinish()).not.toThrow();
  });
});

describe("core/middlewares/log.middleware :: saveLogInBase", () => {
  beforeEach(() => postActivityStats.mockClear());

  function buildReq(overrides = {}) {
    return {
      method: "POST",
      query: {},
      params: {},
      body: {},
      headers: {},
      ...overrides,
    };
  }

  it("appelle postActivityStats pour une route listée dans activityLog.config.js", async () => {
    const req = buildReq({ body: { TITLE: "Nouveau ticket" } });

    await saveLogInBase(
      req,
      "/api/ticketing",
      "POST",
      "jean@test.com",
      "127.0.0.1",
      12,
      true,
    );

    expect(postActivityStats).toHaveBeenCalledOnce();
    const [method, route, comment, appcode, email, ip, duration, params, success] =
      postActivityStats.mock.calls[0];
    expect(method).toBe("POST");
    expect(route).toBe("/api/ticketing");
    expect(appcode).toBe("TICKETING");
    expect(email).toBe("jean@test.com");
    expect(ip).toBe("127.0.0.1");
    expect(duration).toBe(12);
    expect(params).toContain("Nouveau ticket");
    expect(success).toBe(true);
    expect(comment).toBeTruthy();
  });

  it("ignore le matching sur la query string (ne compare que le pathname)", async () => {
    const req = buildReq();

    await saveLogInBase(
      req,
      "/api/ticketing?TCKNUM=TCK-000100",
      "POST",
      null,
      null,
      1,
      true,
    );

    expect(postActivityStats).toHaveBeenCalledOnce();
  });

  it("ne fait rien pour une route non listée (ex: GET)", async () => {
    const req = buildReq({ method: "GET" });

    await saveLogInBase(req, "/api/ticketing", "GET", null, null, 1, true);

    expect(postActivityStats).not.toHaveBeenCalled();
  });

  it("ne récupère pas les params (fichiers) pour les routes /api/files", async () => {
    const req = buildReq({
      method: "POST",
      body: { unused: true },
      files: [{ originalname: "x.pdf", size: 999999 }],
    });

    await saveLogInBase(
      req,
      "/api/files/upload",
      "POST",
      "jean@test.com",
      "127.0.0.1",
      5,
      true,
    );

    const [, , , , , , , params] = postActivityStats.mock.calls[0];
    expect(params).toBeNull();
  });

  it("ne rejette jamais, même si postActivityStats échoue (fire-and-forget robuste)", async () => {
    postActivityStats.mockRejectedValueOnce(new Error("DB indisponible"));
    const req = buildReq();

    await expect(
      saveLogInBase(req, "/api/ticketing", "POST", null, null, 1, false, "boom"),
    ).resolves.toBeUndefined();
  });
});
