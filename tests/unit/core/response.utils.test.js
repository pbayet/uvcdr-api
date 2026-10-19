import { describe, it, expect, vi } from "vitest";
import { responseFormatter } from "../../../core/utils/response.utils.js";

function buildRes(statusCode = 200) {
  const res = { statusCode };
  res.json = vi.fn();
  return res;
}

describe("core/utils/response.utils :: responseFormatter", () => {
  it("enveloppe un body brut dans { success, timestamp, statusCode, data }", () => {
    const res = buildRes(201);
    const next = vi.fn();
    const originalJson = vi.fn();
    res.json = originalJson;

    responseFormatter({}, res, next);
    expect(next).toHaveBeenCalledOnce();

    // res.json a été remplacé par le middleware : on l'appelle pour vérifier le wrapping
    res.json({ TCKID: 1, TITLE: "Ticket" });

    expect(originalJson).toHaveBeenCalledOnce();
    const [wrapped] = originalJson.mock.calls[0];
    expect(wrapped.success).toBe(true);
    expect(wrapped.statusCode).toBe(201);
    expect(wrapped.data).toEqual({ TCKID: 1, TITLE: "Ticket" });
    expect(typeof wrapped.timestamp).toBe("string");
    expect(() => new Date(wrapped.timestamp).toISOString()).not.toThrow();
  });

  it("laisse passer un body qui contient déjà une clé 'success'", () => {
    const res = buildRes(400);
    const next = vi.fn();
    const originalJson = vi.fn();
    res.json = originalJson;

    responseFormatter({}, res, next);

    const alreadyFormatted = { success: false, error: { code: 1106 } };
    res.json(alreadyFormatted);

    expect(originalJson).toHaveBeenCalledWith(alreadyFormatted);
  });

  it("enveloppe aussi les valeurs non-objet (ex: true, tableau)", () => {
    const res = buildRes(200);
    const next = vi.fn();
    const originalJson = vi.fn();
    res.json = originalJson;

    responseFormatter({}, res, next);
    res.json(true);

    const [wrapped] = originalJson.mock.calls[0];
    expect(wrapped.data).toBe(true);
    expect(wrapped.success).toBe(true);
  });
});
