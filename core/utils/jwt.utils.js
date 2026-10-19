// core/utils/jwt.utils.js
import ms from "ms";
import jwt from "jsonwebtoken";
import { logger } from "../../config/logger.config.js";

const secretKey = process.env.JWT_SECRET;

if (!secretKey) {
  logger.error("JWT_SECRET manquant dans les variables d'environnement !");
  throw new Error("JWT_CONFIGURATION_ERROR");
}

const jwtExpiration = process.env.EXP || "1h";

/**
 * Récupère le header Authorization de la requête (Bearer <token>).
 */
export const getRequestAuthorization = (req) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("INVALID_TOKEN");
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    throw new Error("INVALID_TOKEN");
  }

  return token;
};

/**
 * Génère le payload du token JWT à partir d'un utilisateur et de sa permission.
 */
export const generatePayload = (user, permission, appcode, devToken = "") => {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + Math.floor(ms(jwtExpiration) / 1000);

  return {
    iat,
    exp,
    permission: permission?.PRMNAM || "",
    permissionLevel: permission?.PRMLVL ?? -1,
    application: appcode || "",
    devToken,
    isCave: !!user.ISCAVE,
    data: {
      id: user.USRID ?? 0,
      LastName: user.LSTNAM || "",
      FirstName: user.FSTNAM || "",
      email: user.EMAIL || "",
      isActive: !!user.USRACTV,
      service: {
        id: user.SERVICE?.SRVID ?? 0,
        name: user.SERVICE?.SRVNAM || "",
      },
      position: {
        name: user.SERVICE?.POSITIONS?.[0]?.POSNAM || "",
        code: user.SERVICE?.POSITIONS?.[0]?.POSCOD || "",
        level: user.SERVICE?.POSITIONS?.[0]?.POSLVL ?? 0,
      },
    },
  };
};

export const generateJWT = (payload) => {
  const {
    iat,
    exp,
    permission,
    permissionLevel,
    application,
    devToken,
    isCave,
    data,
  } = payload;

  const tokenPayload = {
    iat: iat || Math.floor(Date.now() / 1000),
    exp:
      exp ||
      Math.floor(Date.now() / 1000) + Math.floor(ms(jwtExpiration) / 1000),
    permission,
    permissionLevel,
    application,
    devToken,
    isCave,
    data,
  };

  try {
    return jwt.sign(tokenPayload, secretKey);
  } catch (err) {
    logger.error(`[JWT ERROR] Token generation failed: ${err.message}`);
    throw new Error("JWT_GENERATION_FAILED");
  }
};

/**
 * Vérifie et décode un token JWT.
 * ⚠️ Ne vérifie QUE la signature/expiration. La ré-vérification des permissions
 * applicatives (contre l'état actuel en base) est faite séparément par
 * authVerifyMiddleware — cf. audit sécurité 1.2.
 */
export const verifyJWT = (token) => {
  try {
    const decoded = jwt.verify(token, secretKey);

    if (decoded.permissionLevel === -1) {
      throw new Error("ACCESS_DENIED");
    }

    return decoded;
  } catch (err) {
    if (err.name === "TokenExpiredError") throw new Error("TOKEN_EXPIRED");
    if (err.name === "JsonWebTokenError") throw new Error("INVALID_TOKEN");
    throw err;
  }
};

/**
 * Décode un JWT SANS vérification de signature.
 * À n'utiliser que dans des cas non sensibles (ex: logging).
 */
export const decodeJWT = (token) => {
  try {
    return jwt.decode(token);
  } catch {
    return null;
  }
};
