import { describe, it, expect, afterEach, vi } from "vitest";

// express-rate-limit valide aussi request.app.get("trust proxy") (protection
// contre un trust proxy trop permissif) : un req minimal doit exposer `app`.
function buildReq(ip) {
  return { ip, headers: {}, app: { get: () => false } };
}

/**
 * Exécute un middleware Express (req, res, next) et résout dès que la requête
 * est "terminée" d'une façon ou d'une autre :
 * - `next()` est appelée (requête autorisée à continuer) ;
 * - ou `res.send`/`res.json` est appelée (ex. handler 429 par défaut
 *   d'express-rate-limit, qui répond directement SANS jamais appeler next()).
 * Sans ce second cas, une requête bloquée ferait pendre indéfiniment le test :
 * express-rate-limit ne relaie jamais le rejet via next().
 */
function runMiddleware(middleware, req) {
  const statuses = [];
  return new Promise((resolve) => {
    const res = {
      setHeader: () => {},
      status(code) {
        statuses.push(code);
        return res;
      },
      send() {
        resolve(statuses);
      },
      json() {
        resolve(statuses);
      },
    };
    middleware(req, res, () => resolve(statuses));
  });
}

describe("config/rateLimit.config", () => {
  it("expose deux middlewares Express valides (req, res, next)", async () => {
    const { generalLimiter, authLimiter } = await import("../../../config/rateLimit.config.js");
    expect(typeof generalLimiter).toBe("function");
    expect(generalLimiter.length).toBe(3);
    expect(typeof authLimiter).toBe("function");
    expect(authLimiter.length).toBe(3);
  });

  // La valeur de `loadTestModeEnabled` est figée à l'import du module (lecture
  // de process.env une seule fois) : chaque scénario doit repartir d'un
  // module frais (vi.resetModules) après avoir positionné NODE_ENV/LOADTEST_MODE.
  describe("LOADTEST_MODE (bypass generalLimiter/authLimiter)", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalLoadTestMode = process.env.LOADTEST_MODE;

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
      process.env.LOADTEST_MODE = originalLoadTestMode;
      vi.resetModules();
    });

    it("n'a aucun effet par défaut (LOADTEST_MODE non défini) : le plafond s'applique toujours", async () => {
      process.env.NODE_ENV = "development";
      delete process.env.LOADTEST_MODE;
      vi.resetModules();

      const { generalLimiter } = await import("../../../config/rateLimit.config.js");

      let lastStatuses = [];
      // max: 300 pour generalLimiter → la 301e requête depuis la même IP doit être bloquée.
      for (let i = 0; i < 301; i++) {
        lastStatuses = await runMiddleware(generalLimiter, buildReq("10.0.0.2"));
      }

      expect(lastStatuses).toContain(429);
    });

    it("désactive les limiteurs hors production quand LOADTEST_MODE=true", async () => {
      process.env.NODE_ENV = "development";
      process.env.LOADTEST_MODE = "true";
      vi.resetModules();

      const { generalLimiter, authLimiter } = await import("../../../config/rateLimit.config.js");

      // On appelle le middleware bien plus de fois que `max` ne l'autorise :
      // s'il est correctement skip, aucune requête ne doit être bloquée (429).
      for (let i = 0; i < 350; i++) {
        await runMiddleware(generalLimiter, buildReq("127.0.0.1"));
      }

      const generalStatuses = await runMiddleware(generalLimiter, buildReq("127.0.0.1"));
      const authStatuses = await runMiddleware(authLimiter, buildReq("127.0.0.1"));

      expect(generalStatuses).not.toContain(429);
      expect(authStatuses).not.toContain(429);
    });

    it("reste inopérant si NODE_ENV=production, même avec LOADTEST_MODE=true", async () => {
      process.env.NODE_ENV = "production";
      process.env.LOADTEST_MODE = "true";
      vi.resetModules();

      const { generalLimiter } = await import("../../../config/rateLimit.config.js");

      let lastStatuses = [];
      // max: 300 pour generalLimiter → la 301e requête depuis la même IP doit être bloquée.
      for (let i = 0; i < 301; i++) {
        lastStatuses = await runMiddleware(generalLimiter, buildReq("10.0.0.1"));
      }

      expect(lastStatuses).toContain(429);
    });
  });
});
