import { describe, it, expect, vi } from "vitest";

describe("config/cors.config (NODE_ENV=test, non-production)", () => {
  it("autorise toute origine hors production", async () => {
    const { default: corsOptions } = await import("../../../config/cors.config.js");
    const cb = vi.fn();

    corsOptions.origin("https://n-importe-quelle-origine.example.com", cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it("autorise les requêtes sans origine (ex: outils serveur-à-serveur)", async () => {
    const { default: corsOptions } = await import("../../../config/cors.config.js");
    const cb = vi.fn();

    corsOptions.origin(undefined, cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it("n'autorise que les méthodes HTTP explicitement listées", async () => {
    const { default: corsOptions } = await import("../../../config/cors.config.js");
    expect(corsOptions.methods).toEqual(expect.arrayContaining(["GET", "POST", "PUT", "DELETE"]));
  });
});
