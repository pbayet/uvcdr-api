import { describe, it, expect, vi } from "vitest";
import jwt from "jsonwebtoken";
import {
  getRequestAuthorization,
  generatePayload,
  generateJWT,
  verifyJWT,
  decodeJWT,
} from "../../../core/utils/jwt.utils.js";

const baseUser = {
  USRID: 42,
  LSTNAM: "Dupont",
  FSTNAM: "Jean",
  EMAIL: "jean.dupont@union-vignerons.com",
  USRACTV: 1,
  SERVICE: { SRVID: 10, SRVNAM: "Support", POSITIONS: [{ POSNAM: "Technicien", POSCOD: "TECH", POSLVL: 3 }] },
};

const basePermission = { PRMID: 3, PRMNAM: "USER", PRMLVL: 4 };

describe("core/utils/jwt.utils :: getRequestAuthorization", () => {
  it("extrait le token d'un header 'Bearer <token>'", () => {
    const req = { headers: { authorization: "Bearer abc.def.ghi" } };
    expect(getRequestAuthorization(req)).toBe("abc.def.ghi");
  });

  it("lève INVALID_TOKEN si l'en-tête est absent", () => {
    expect(() => getRequestAuthorization({ headers: {} })).toThrow("INVALID_TOKEN");
  });

  it("lève INVALID_TOKEN si l'en-tête ne commence pas par 'Bearer '", () => {
    expect(() => getRequestAuthorization({ headers: { authorization: "abc.def.ghi" } })).toThrow(
      "INVALID_TOKEN",
    );
  });

  it("lève INVALID_TOKEN si le token est vide après 'Bearer '", () => {
    expect(() => getRequestAuthorization({ headers: { authorization: "Bearer " } })).toThrow(
      "INVALID_TOKEN",
    );
  });
});

describe("core/utils/jwt.utils :: generatePayload", () => {
  it("construit un payload cohérent à partir de l'utilisateur/permission", () => {
    const payload = generatePayload(baseUser, basePermission, "TICKETING");

    expect(payload.permission).toBe("USER");
    expect(payload.permissionLevel).toBe(4);
    expect(payload.application).toBe("TICKETING");
    expect(payload.data.id).toBe(42);
    expect(payload.data.email).toBe("jean.dupont@union-vignerons.com");
    expect(payload.data.service.id).toBe(10);
    expect(payload.data.position.code).toBe("TECH");
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it("retombe sur des valeurs par défaut sûres si permission/service manquants", () => {
    const payload = generatePayload({ USRID: 1 }, null, "");
    expect(payload.permission).toBe("");
    expect(payload.permissionLevel).toBe(-1);
    expect(payload.data.service.id).toBe(0);
    expect(payload.data.position.name).toBe("");
  });
});

describe("core/utils/jwt.utils :: generateJWT / verifyJWT", () => {
  it("génère un JWT signé décodable et vérifiable", () => {
    const payload = generatePayload(baseUser, basePermission, "TICKETING");
    const token = generateJWT(payload);

    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3);

    const decoded = verifyJWT(token);
    expect(decoded.data.email).toBe(baseUser.EMAIL);
    expect(decoded.permissionLevel).toBe(4);
  });

  it("lève ACCESS_DENIED si permissionLevel === -1", () => {
    const payload = generatePayload(baseUser, null, "");
    const token = generateJWT(payload);
    expect(() => verifyJWT(token)).toThrow("ACCESS_DENIED");
  });

  it("lève TOKEN_EXPIRED pour un token expiré", () => {
    const expiredToken = jwt.sign(
      { iat: 0, exp: 1, permission: "USER", permissionLevel: 4, application: "TICKETING", data: { id: 1, email: "x@x.com" } },
      process.env.JWT_SECRET,
    );
    expect(() => verifyJWT(expiredToken)).toThrow("TOKEN_EXPIRED");
  });

  it("lève INVALID_TOKEN pour un token signé avec un autre secret", () => {
    const badToken = jwt.sign({ permissionLevel: 4, data: { id: 1 } }, "un-autre-secret", { expiresIn: "1h" });
    expect(() => verifyJWT(badToken)).toThrow("INVALID_TOKEN");
  });

  it("lève INVALID_TOKEN pour un token malformé", () => {
    expect(() => verifyJWT("pas.un.jwt")).toThrow("INVALID_TOKEN");
  });
});

describe("core/utils/jwt.utils :: decodeJWT", () => {
  it("décode un token sans vérifier la signature", () => {
    const payload = generatePayload(baseUser, basePermission, "TICKETING");
    const token = generateJWT(payload);

    const decoded = decodeJWT(token);
    expect(decoded.data.email).toBe(baseUser.EMAIL);
  });

  it("retourne null pour une entrée invalide", () => {
    expect(decodeJWT("pas-un-token")).toBeNull();
  });
});
