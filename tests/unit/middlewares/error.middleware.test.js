import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { errorHandler } from "../../../core/middlewares/error.middleware.js";

function buildReqRes(overrides = {}) {
  const req = {
    method: "GET",
    originalUrl: "/api/ticketing",
    headers: {},
    ip: "127.0.0.1",
    payload: null,
    ...overrides,
  };
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json: vi.fn(),
  };
  return { req, res, next: vi.fn() };
}

describe("core/middlewares/error.middleware :: errorHandler", () => {
  it("formate une ZodError en 400 avec le détail des issues", () => {
    const schema = z.object({ TITLE: z.string().min(1, "TITLE est obligatoire.") });
    const result = schema.safeParse({});
    const { req, res } = buildReqRes();

    errorHandler(result.error, req, res, () => {});

    expect(res.statusCode).toBe(400);
    const [body] = res.json.mock.calls[0];
    expect(body.success).toBe(false);
    expect(body.error.key).toBe("MISSING_PARAMETERS");
    expect(body.error.issues[0]).toMatchObject({ path: "TITLE" });
  });

  it("résout une erreur connue du registre (ex: USER_NOT_FOUND) en français par défaut", () => {
    const { req, res } = buildReqRes();
    errorHandler(new Error("USER_NOT_FOUND"), req, res, () => {});

    expect(res.statusCode).toBe(404);
    const [body] = res.json.mock.calls[0];
    expect(body.error.code).toBe(1105);
    expect(body.error.message).toBe("Utilisateur introuvable");
  });

  it("respecte Accept-Language: en pour les messages traduits", () => {
    const { req, res } = buildReqRes({ headers: { "accept-language": "en-US,en;q=0.9" } });
    errorHandler(new Error("USER_NOT_FOUND"), req, res, () => {});

    const [body] = res.json.mock.calls[0];
    expect(body.error.message).toBe("User not found");
  });

  it("résout les erreurs avec placeholder (ex: ACCOUNT_LOCKED_[120s])", () => {
    const { req, res } = buildReqRes();
    errorHandler(new Error("ACCOUNT_LOCKED_[120s]"), req, res, () => {});

    expect(res.statusCode).toBe(429);
    const [body] = res.json.mock.calls[0];
    expect(body.error.code).toBe(1108);
    expect(body.error.message).toContain("120s");
  });

  it("respecte err.status explicite (ex: 404 métier) sans retomber en 500", () => {
    const { req, res } = buildReqRes();
    const err = new Error("Ticket introuvable ou accès refusé.");
    err.status = 404;

    errorHandler(err, req, res, () => {});

    expect(res.statusCode).toBe(404);
    const [body] = res.json.mock.calls[0];
    expect(body.error.message).toBe("Ticket introuvable ou accès refusé.");
  });

  it("retombe sur INTERNAL_ERROR (500) pour une erreur totalement inconnue", () => {
    const { req, res } = buildReqRes();
    errorHandler(new Error("Boom inattendu"), req, res, () => {});

    expect(res.statusCode).toBe(500);
    const [body] = res.json.mock.calls[0];
    expect(body.error.code).toBe(9999);
    expect(body.error.key).toBe("INTERNAL_ERROR");
  });

  it("marque res.locals.hasError = true", () => {
    const { req, res } = buildReqRes();
    errorHandler(new Error("USER_NOT_FOUND"), req, res, () => {});
    expect(res.locals.hasError).toBe(true);
  });
});
