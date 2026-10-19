import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../core/services/ldap.service.js", () => ({
  ldapAuthenticate: vi.fn(),
}));
vi.mock("../../../modules/usersmanager/services.js", () => ({
  getUserByEmail: vi.fn(),
  postLoginStats: vi.fn(),
}));
vi.mock("../../../modules/declcav/services.js", () => ({
  getCavesPW: vi.fn(),
  getCave: vi.fn(),
}));

const { ldapAuthenticate } = await import("../../../core/services/ldap.service.js");
const usersmanagerServices = await import("../../../modules/usersmanager/services.js");
const declcavServices = await import("../../../modules/declcav/services.js");
const authMiddlewares = await import("../../../core/middlewares/auth.middleware.js");
const { clearCache } = await import("../../../core/utils/request.utils.js");
const { buildRawUserRow } = await import("../../helpers/fixtures.js");
const { hashPassword } = await import("../../../core/utils/passwords.utils.js");
const jwtUtils = await import("../../../core/utils/jwt.utils.js");

function buildReq({ body = {}, headers = {}, ip = "127.0.0.1" } = {}) {
  return { method: "POST", body, headers, ip, params: {}, query: {} };
}

function buildRes() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn() };
}

describe("core/middlewares/auth.middleware :: checkPermissions", () => {
  it("lève ACCESS_DENIED si aucune permission n'est fournie", () => {
    expect(() => authMiddlewares.checkPermissions(null, "TICKETING")).toThrow("ACCESS_DENIED");
  });

  it("retourne l'accès standard par défaut pour HOME/BAS ou appcode absent", () => {
    const perm = authMiddlewares.checkPermissions([], "HOME");
    expect(perm.PRMNAM).toBe("USER");
    expect(perm.PRMLVL).toBe(4);
    expect(authMiddlewares.checkPermissions([], undefined).PRMNAM).toBe("USER");
  });

  it("sélectionne la permission avec le PRMLVL le plus bas pour l'appcode demandé", () => {
    const permissions = [
      { APPCOD: "TICKETING", PERMISSION: { PRMNAM: "ADMIN", PRMLVL: 1 } },
      { APPCOD: "TICKETING", PERMISSION: { PRMNAM: "USER", PRMLVL: 4 } },
      { APPCOD: "AUTRE", PERMISSION: { PRMNAM: "ADMIN", PRMLVL: 0 } },
    ];
    expect(authMiddlewares.checkPermissions(permissions, "TICKETING").PRMNAM).toBe("ADMIN");
  });

  it("ignore les permissions avec PRMLVL -1 et lève ACCESS_DENIED s'il n'en reste aucune", () => {
    const permissions = [{ APPCOD: "TICKETING", PERMISSION: { PRMNAM: "NONE", PRMLVL: -1 } }];
    expect(() => authMiddlewares.checkPermissions(permissions, "TICKETING")).toThrow("ACCESS_DENIED");
  });
});

describe("core/middlewares/auth.middleware :: loginMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // loginMiddleware appelle toujours `postLoginStats(...).catch(() => {})`
    // dans son `finally` : le mock doit renvoyer une Promise (sinon `.catch`
    // sur `undefined` lève une TypeError qui masquerait l'assertion réelle).
    usersmanagerServices.postLoginStats.mockResolvedValue(undefined);
  });

  it("lève MISSING_PARAMETERS si email/password absents", async () => {
    const req = buildReq({ body: {} });
    const res = buildRes();
    const next = vi.fn();

    await authMiddlewares.loginMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0][0].message).toBe("MISSING_PARAMETERS");
    expect(usersmanagerServices.postLoginStats).toHaveBeenCalledWith(false, undefined, undefined);
  });

  it("lève INVALID_CREDENTIALS si le LDAP ne renvoie aucun utilisateur", async () => {
    vi.useFakeTimers();
    ldapAuthenticate.mockResolvedValue(null);

    const req = buildReq({ body: { email: "inconnu@union-vignerons.com", password: "x", appcode: "TICKETING" } });
    const res = buildRes();
    const next = vi.fn();

    const promise = authMiddlewares.loginMiddleware(req, res, next);
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();

    expect(next.mock.calls[0][0].message).toBe("INVALID_CREDENTIALS");
  });

  it("lève USER_NOT_FOUND si le LDAP authentifie mais l'utilisateur applicatif est introuvable", async () => {
    vi.useFakeTimers();
    ldapAuthenticate.mockResolvedValue({ dn: "CN=test", mail: "ghost@union-vignerons.com" });
    usersmanagerServices.getUserByEmail.mockResolvedValue([]);

    const req = buildReq({ body: { email: "ghost@union-vignerons.com", password: "x", appcode: "TICKETING" } });
    const res = buildRes();
    const next = vi.fn();

    const promise = authMiddlewares.loginMiddleware(req, res, next);
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();

    expect(next.mock.calls[0][0].message).toBe("USER_NOT_FOUND");
  });

  it("connecte l'utilisateur et renvoie un JWT en cas de succès", async () => {
    const email = "succes@union-vignerons.com";
    ldapAuthenticate.mockResolvedValue({ dn: "CN=succes", mail: email });
    usersmanagerServices.getUserByEmail.mockResolvedValue([buildRawUserRow({ EMAIL: email, appcode: "TICKETING" })]);
    usersmanagerServices.postLoginStats.mockResolvedValue(undefined);

    const req = buildReq({ body: { email, password: "x", appcode: "TICKETING" } });
    const res = buildRes();
    const next = vi.fn();

    await authMiddlewares.loginMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    const [token] = res.json.mock.calls[0];
    expect(typeof token).toBe("string");
    expect(usersmanagerServices.postLoginStats).toHaveBeenCalledWith(true, email, "TICKETING");
  });

  it("bloque temporairement après trop de tentatives échouées (anti-bruteforce)", async () => {
    vi.useFakeTimers();
    const email = "bruteforce@union-vignerons.com";
    ldapAuthenticate.mockResolvedValue(null); // toujours en échec

    for (let i = 0; i < 5; i++) {
      const req = buildReq({ body: { email, password: "x", appcode: "TICKETING" }, ip: "10.0.0.1" });
      const res = buildRes();
      const next = vi.fn();
      const promise = authMiddlewares.loginMiddleware(req, res, next);
      await vi.runAllTimersAsync();
      await promise;
    }

    // La 6e tentative doit être bloquée AVANT même d'appeler le LDAP
    ldapAuthenticate.mockClear();
    const req = buildReq({ body: { email, password: "x", appcode: "TICKETING" }, ip: "10.0.0.1" });
    const res = buildRes();
    const next = vi.fn();
    const promise = authMiddlewares.loginMiddleware(req, res, next);
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();

    expect(next.mock.calls[0][0].message).toBe("ACCOUNT_TEMPORARILY_BLOCKED");
    expect(ldapAuthenticate).not.toHaveBeenCalled();
  });
});

describe("core/middlewares/auth.middleware :: loginMiddleware (cave / appcode DCLING)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usersmanagerServices.postLoginStats.mockResolvedValue(undefined);
  });

  it("authentifie une cave via CAVE.PASSHSH sans jamais appeler le LDAP", async () => {
    const hash = await hashPassword("MotDePasseCave1!");
    declcavServices.getCavesPW.mockResolvedValue([{ ID: 42, PASSHSH: hash }]);

    const req = buildReq({
      body: { email: "cave@example.com", password: "MotDePasseCave1!", appcode: "DCLING" },
    });
    const res = buildRes();
    const next = vi.fn();

    await authMiddlewares.loginMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(ldapAuthenticate).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    const [token] = res.json.mock.calls[0];
    expect(typeof token).toBe("string");

    const decoded = jwtUtils.decodeJWT(token);
    expect(decoded.application).toBe("DCLING");
    expect(decoded.data.id).toBe(42);
    expect(decoded.permissionLevel).toBe(4);
    expect(usersmanagerServices.postLoginStats).toHaveBeenCalledWith(true, "cave@example.com", "DCLING");
  });

  it(
    "retombe sur l'authentification standard (et échoue) si le mot de passe cave est invalide",
    async () => {
      // Pas de fake timers ici : `verifyPassword` (Argon2, natif) est appelé par
      // loginMiddleware lui-même sur ce chemin, et resterait bloqué
      // indéfiniment sous vi.useFakeTimers() (le binding natif ne s'appuie pas
      // sur les timers JS faussés). On accepte donc le vrai délai anti-bruteforce
      // (1 à 3s, cf. randomDelay), largement sous le timeout par défaut du test.
      const hash = await hashPassword("BonMotDePasse1!");
      declcavServices.getCavesPW.mockResolvedValue([{ ID: 42, PASSHSH: hash }]);
      ldapAuthenticate.mockResolvedValue(null);
      usersmanagerServices.getUserByEmail.mockResolvedValue([]);

      const req = buildReq({
        body: { email: "cave@example.com", password: "MauvaisMotDePasse", appcode: "DCLING" },
      });
      const res = buildRes();
      const next = vi.fn();

      await authMiddlewares.loginMiddleware(req, res, next);

      // Un mauvais mot de passe cave ne renvoie pas d'erreur dédiée : la requête
      // retombe sur le chemin LDAP standard (qui échoue à son tour), pour ne
      // pas laisser un attaquant distinguer "cave inconnue" de "mot de passe
      // cave invalide".
      expect(ldapAuthenticate).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledOnce();
    },
  );

  it("retombe sur l'authentification standard si aucune cave ne correspond à l'email", async () => {
    vi.useFakeTimers();
    declcavServices.getCavesPW.mockResolvedValue([]);
    ldapAuthenticate.mockResolvedValue(null);
    usersmanagerServices.getUserByEmail.mockResolvedValue([]);

    const req = buildReq({
      body: { email: "inconnue@example.com", password: "x", appcode: "DCLING" },
    });
    const res = buildRes();
    const next = vi.fn();

    const promise = authMiddlewares.loginMiddleware(req, res, next);
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();

    expect(ldapAuthenticate).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("core/middlewares/auth.middleware :: authVerifyMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  async function issueToken(overrides = {}) {
    const { buildAuthToken } = await import("../../helpers/fixtures.js");
    return buildAuthToken(overrides);
  }

  it("autorise une requête avec un token valide et un utilisateur actif", async () => {
    const { token, raw } = await issueToken({ EMAIL: "actif@union-vignerons.com", appcode: "TICKETING", permissionLevel: 4 });
    usersmanagerServices.getUserByEmail.mockResolvedValue([raw]);

    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = {};
    const next = vi.fn();

    await authMiddlewares.authVerifyMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.payload.data.email).toBe("actif@union-vignerons.com");
  });

  it("rejette une requête sans token", async () => {
    const req = { headers: {} };
    const next = vi.fn();

    await authMiddlewares.authVerifyMiddleware(req, {}, next);

    expect(next.mock.calls[0][0].message).toBe("INVALID_TOKEN");
    expect(req.payload).toBeNull();
  });

  it("rejette si l'utilisateur n'existe plus en base", async () => {
    const { token } = await issueToken({ EMAIL: "supprime@union-vignerons.com" });
    usersmanagerServices.getUserByEmail.mockResolvedValue([]);

    const req = { headers: { authorization: `Bearer ${token}` } };
    const next = vi.fn();

    await authMiddlewares.authVerifyMiddleware(req, {}, next);

    expect(next.mock.calls[0][0].message).toBe("USER_NOT_FOUND");
  });

  it("rejette un utilisateur désactivé (USRACTV = 0)", async () => {
    const { token, raw } = await issueToken({ EMAIL: "desactive@union-vignerons.com", USRACTV: 0 });
    usersmanagerServices.getUserByEmail.mockResolvedValue([raw]);

    const req = { headers: { authorization: `Bearer ${token}` } };
    const next = vi.fn();

    await authMiddlewares.authVerifyMiddleware(req, {}, next);

    expect(next.mock.calls[0][0].message).toBe("ACCESS_DENIED");
  });

  it("rejette si l'application n'a plus aucune permission active pour cet utilisateur", async () => {
    const { token, raw } = await issueToken({ EMAIL: "sanspermission@union-vignerons.com", appcode: "TICKETING" });
    // On retire toute permission TICKETING de l'utilisateur en base (droits révoqués)
    const rawSansAcces = { ...raw, PERMISSIONS: JSON.stringify([]) };
    usersmanagerServices.getUserByEmail.mockResolvedValue([rawSansAcces]);

    const req = { headers: { authorization: `Bearer ${token}` } };
    const next = vi.fn();

    await authMiddlewares.authVerifyMiddleware(req, {}, next);

    expect(next.mock.calls[0][0].message).toBe("ACCESS_DENIED");
  });

  it("met en cache le résultat de getUserByEmail pendant 5 minutes (pas de second appel base)", async () => {
    const { token, raw } = await issueToken({ EMAIL: "cache@union-vignerons.com" });
    usersmanagerServices.getUserByEmail.mockResolvedValue([raw]);

    const req1 = { headers: { authorization: `Bearer ${token}` } };
    const req2 = { headers: { authorization: `Bearer ${token}` } };

    await authMiddlewares.authVerifyMiddleware(req1, {}, vi.fn());
    await authMiddlewares.authVerifyMiddleware(req2, {}, vi.fn());

    expect(usersmanagerServices.getUserByEmail).toHaveBeenCalledOnce();
  });

  // NOTE — comportement actuel potentiellement à revalider avec l'équipe :
  // la comparaison `currentPermission.PRMLVL < payload.permissionLevel` semble
  // inversée par rapport à l'intention documentée juste au-dessus dans le code
  // ("un utilisateur dont les droits étaient révoqués restait pleinement
  // autorisé [...] Ici il est réactivé"). Avec la convention du projet où un
  // PRMLVL plus BAS = un accès plus élevé (cf. checkPermissions, qui choisit le
  // PRMLVL minimal), la condition actuelle bloque un utilisateur dont l'accès
  // s'est AMÉLIORÉ depuis l'émission du token, et laisse passer un utilisateur
  // dont l'accès a été DÉGRADÉ — l'inverse de l'objectif recherché. Ces deux
  // tests figent le comportement actuel (pour éviter une régression silencieuse
  // si le code bouge) ; à corriger si l'inversion est confirmée comme un bug.
  it("[comportement actuel] laisse passer un utilisateur dont la permission a été DÉGRADÉE depuis le token", async () => {
    const { token, raw } = await issueToken({ EMAIL: "degrade@union-vignerons.com", appcode: "TICKETING", permissionLevel: 2 });
    const rawDegrade = {
      ...raw,
      PERMISSIONS: JSON.stringify([
        {
          APPCOD: "TICKETING",
          APPLNK: "[DOMAIN]/app",
          IMGLNK: null,
          PRMLVL: 8, // 8 = accès moins privilégié que 2 → droits dégradés
          PERMISSION: JSON.stringify({ PRMID: 9, PRMNAM: "USER", PRMDES: "", PRMLVL: 8, BYGRP: false, ISCRIT: false }),
        },
      ]),
    };
    usersmanagerServices.getUserByEmail.mockResolvedValue([rawDegrade]);

    const req = { headers: { authorization: `Bearer ${token}` } };
    const next = vi.fn();

    await authMiddlewares.authVerifyMiddleware(req, {}, next);

    expect(next).toHaveBeenCalledWith(); // pas d'erreur : la dégradation n'est pas bloquée
  });

  it("[comportement actuel] rejette un utilisateur dont la permission s'est AMÉLIORÉE depuis le token", async () => {
    const { token, raw } = await issueToken({ EMAIL: "ameliore@union-vignerons.com", appcode: "TICKETING", permissionLevel: 8 });
    const rawAmeliore = {
      ...raw,
      PERMISSIONS: JSON.stringify([
        {
          APPCOD: "TICKETING",
          APPLNK: "[DOMAIN]/app",
          IMGLNK: null,
          PRMLVL: 2, // 2 = accès plus privilégié que 8 → droits améliorés
          PERMISSION: JSON.stringify({ PRMID: 1, PRMNAM: "ADMIN", PRMDES: "", PRMLVL: 2, BYGRP: false, ISCRIT: false }),
        },
      ]),
    };
    usersmanagerServices.getUserByEmail.mockResolvedValue([rawAmeliore]);

    const req = { headers: { authorization: `Bearer ${token}` } };
    const next = vi.fn();

    await authMiddlewares.authVerifyMiddleware(req, {}, next);

    expect(next.mock.calls[0][0].message).toBe("ACCESS_DENIED");
  });

  describe("token cave (appcode DCLING)", () => {
    function buildCaveToken(caveId = 42) {
      const payload = jwtUtils.generatePayload(
        { USRID: caveId, EMAIL: "cave@example.com", USRACTV: true },
        { PRMNAM: "USER", PRMLVL: 4 },
        "DCLING",
      );
      return jwtUtils.generateJWT(payload);
    }

    it("autorise un token cave tant que la cave existe toujours, sans passer par usersmanager", async () => {
      declcavServices.getCave.mockResolvedValue([{ CAVEID: 42, CAVENOM: "Cave Test" }]);
      const token = buildCaveToken(42);

      const req = { headers: { authorization: `Bearer ${token}` } };
      const next = vi.fn();

      await authMiddlewares.authVerifyMiddleware(req, {}, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.payload.application).toBe("DCLING");
      expect(usersmanagerServices.getUserByEmail).not.toHaveBeenCalled();
    });

    it("rejette un token cave si la cave a depuis été supprimée", async () => {
      declcavServices.getCave.mockResolvedValue([]);
      const token = buildCaveToken(999);

      const req = { headers: { authorization: `Bearer ${token}` } };
      const next = vi.fn();

      await authMiddlewares.authVerifyMiddleware(req, {}, next);

      expect(next.mock.calls[0][0].message).toBe("USER_NOT_FOUND");
      expect(req.payload).toBeNull();
    });
  });
});

describe("core/middlewares/auth.middleware :: requirePermission", () => {
  it("laisse passer un payload dont la permission fait partie de MODIFY_PERMS (DEV,SUPERADMIN,ADMIN en test)", () => {
    const req = { payload: { permission: "ADMIN" } };
    const next = vi.fn();

    authMiddlewares.requirePermission(req, {}, next);

    expect(next).toHaveBeenCalledWith();
  });

  it("laisse passer SUPERADMIN et DEV", () => {
    for (const permission of ["SUPERADMIN", "DEV"]) {
      const req = { payload: { permission } };
      const next = vi.fn();

      authMiddlewares.requirePermission(req, {}, next);

      expect(next).toHaveBeenCalledWith();
    }
  });

  it("rejette un utilisateur dont la permission n'est pas gestionnaire (ACCESS_DENIED)", () => {
    const req = { payload: { permission: "USER" } };
    const next = vi.fn();

    authMiddlewares.requirePermission(req, {}, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].message).toBe("ACCESS_DENIED");
  });

  it("rejette une requête sans payload (non authentifiée)", () => {
    const req = {};
    const next = vi.fn();

    authMiddlewares.requirePermission(req, {}, next);

    expect(next.mock.calls[0][0].message).toBe("ACCESS_DENIED");
  });
});
