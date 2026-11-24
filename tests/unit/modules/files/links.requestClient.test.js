import { describe, it, expect, vi } from "vitest";

vi.mock("../../../../modules/files/services.js", () => ({}));
const { requestClient, normalizeIp } = await import("../../../../modules/files/links.js");

const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers: { "user-agent": "UA", ...headers } });

describe("files/links :: requestClient (IP du client derrière le proxy)", () => {
  it("proxy local : IP transmise par X-Forwarded-For (premier relais, port IIS ARR retiré)", () => {
    expect(requestClient(req("::1", { "x-forwarded-for": "203.0.113.7:51234, 10.0.0.1" })).IP).toBe("203.0.113.7");
    expect(requestClient(req("::ffff:127.0.0.1", { "x-forwarded-for": "::ffff:10.1.2.3" })).IP).toBe("10.1.2.3");
  });

  it("autres en-têtes de proxy : Forwarded (RFC 7239), X-Real-IP", () => {
    expect(requestClient(req("127.0.0.1", { forwarded: 'for="[2001:db8::1]:4711";proto=https' })).IP).toBe("2001:db8::1");
    expect(requestClient(req("127.0.0.1", { "x-real-ip": "10.20.30.40" })).IP).toBe("10.20.30.40");
  });

  it("proxy sans en-tête : pas d'IP plutôt que ::1 (celle du proxy)", () => {
    expect(requestClient(req("::1")).IP).toBeNull();
    expect(requestClient(req("127.0.0.1")).IP).toBeNull();
  });

  it("client direct (IP publique) : en-têtes ignorés, ils pourraient être falsifiés", () => {
    expect(requestClient(req("203.0.113.9", { "x-forwarded-for": "1.2.3.4" })).IP).toBe("203.0.113.9");
  });

  it("normalizeIp", () => {
    expect(normalizeIp("[::1]:80")).toBe("::1");
    expect(normalizeIp("unknown")).toBeNull();
    expect(normalizeIp("")).toBeNull();
  });
});
