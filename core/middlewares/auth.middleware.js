import * as jwtUtils from "../utils/jwt.utils.js";
import * as requestUtils from "../utils/request.utils.js";
import { getRequestAuthorization, verifyJWT } from "../utils/jwt.utils.js";
import {
  ldapAuthenticate,
  ldapServiceSearch,
  escapeLdapFilterValue,
} from "../services/ldap.service.js";
import { verifyPassword } from "../utils/passwords.utils.js";

import {
  getUserByEmail,
  getUserById,
  getPermission,
  postLoginStats,
} from "../../modules/usersmanager/services.js";
import { formatUsers } from "../../modules/usersmanager/utils.js";
import { getCavesPW, getCave } from "../../modules/declcav/services.js";
import { logger } from "../../config/logger.config.js";

/**
 * Périmètre par rapport à V1.0.0 : cette V1.1.0 reconstruit ce dont
 * ticketing ET declcav ont besoin pour s'authentifier.
 * - Branche "mot de passe cave" (appcode "DCLING") réintroduite dans
 *   loginMiddleware : les caves ne sont pas des comptes LDAP/usersmanager,
 *   elles s'authentifient avec un hash Argon2 stocké dans CAVE.PASSHSH
 *   (cf. getCavesPW, modules/declcav/services.js). Contrairement à V1.0.0,
 *   aucun identifiant ni mot de passe n'est jamais journalisé (cf. audit
 *   sécurité — voir README, section correctifs) et un succès réinitialise
 *   désormais le compteur anti-bruteforce (oubli en V1.0.0).
 * - loginDevMiddleware / loginAppMiddleware (échange/impersonation de token
 *   multi-application) réintroduits sur demande — repris à l'identique de la
 *   logique V1.0.0.
 */

// Paramètres anti-bruteforce
const BRUTEFORCE_LIMIT = 5;
const BRUTEFORCE_WINDOW_MS = 10 * 60 * 1000;
const BRUTEFORCE_BLOCK_MS = 15 * 60 * 1000;
const RANDOM_DELAY_MIN_MS = 1000;
const RANDOM_DELAY_MAX_MS = 3000;

const bruteForceMap = new Map();

function randomDelay() {
  const delay =
    Math.floor(
      Math.random() * (RANDOM_DELAY_MAX_MS - RANDOM_DELAY_MIN_MS + 1),
    ) + RANDOM_DELAY_MIN_MS;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function checkBruteForce(identifier) {
  const now = Date.now();
  const record = bruteForceMap.get(identifier) || {
    attempts: [],
    blockedUntil: 0,
  };

  if (record.blockedUntil > now) {
    const remaining = Math.ceil((record.blockedUntil - now) / 1000);
    throw new Error(`ACCOUNT_LOCKED_[${remaining}s]`);
  }

  record.attempts = record.attempts.filter(
    (t) => now - t < BRUTEFORCE_WINDOW_MS,
  );

  if (record.attempts.length >= BRUTEFORCE_LIMIT) {
    record.blockedUntil = now + BRUTEFORCE_BLOCK_MS;
    bruteForceMap.set(identifier, record);
    throw new Error("ACCOUNT_TEMPORARILY_BLOCKED");
  }

  bruteForceMap.set(identifier, record);
}

function registerFailedAttempt(identifier) {
  const now = Date.now();
  const record = bruteForceMap.get(identifier) || {
    attempts: [],
    blockedUntil: 0,
  };
  record.attempts.push(now);
  bruteForceMap.set(identifier, record);
}

function resetAttempts(identifier) {
  bruteForceMap.delete(identifier);
}

/**
 * Vérifie si un utilisateur possède la permission d'accéder à une application donnée.
 */
export function checkPermissions(permissions, appcode) {
  if (!permissions) throw new Error("ACCESS_DENIED");

  if (!appcode || ["HOME", "BAS"].includes(appcode)) {
    return {
      PRMID: 3,
      PRMNAM: "USER",
      PRMDES: "Accès standard",
      PRMLVL: 4,
      BYGRP: false,
      ISCRIT: false,
    };
  }

  const appPermission = permissions
    .filter((p) => p.APPCOD === appcode && p.PERMISSION?.PRMLVL !== -1)
    .sort((a, b) => a.PERMISSION.PRMLVL - b.PERMISSION.PRMLVL)[0];

  if (!appPermission || !appPermission.PERMISSION)
    throw new Error("ACCESS_DENIED");

  return appPermission.PERMISSION;
}

/**
 * POST /auth
 * Authentifie via LDAP, récupère l'utilisateur applicatif, vérifie ses
 * permissions pour l'application demandée, retourne un JWT.
 *
 * Cas particulier "cave" (appcode === "DCLING") : les caves ne sont pas des
 * comptes LDAP/usersmanager. Elles s'authentifient avec l'email déclaré dans
 * CAVEMAIL et un mot de passe vérifié contre le hash Argon2 stocké dans
 * CAVE.PASSHSH (cf. getCavesPW, modules/declcav/services.js). En cas de
 * succès, un JWT est émis directement avec la permission USER standard
 * (PRMLVL 4), sans passer par la table PERMISSIONS/USERSMANAGER — repris de
 * V1.0.0. Si aucune cave ne correspond ou que le mot de passe est invalide,
 * la requête continue vers l'authentification LDAP standard (qui échouera à
 * son tour avec INVALID_CREDENTIALS), pour ne pas distinguer "cave inconnue"
 * de "mauvais mot de passe" côté client.
 *
 * Volontairement en POST (et non GET comme en V1.0.0) : les identifiants ne
 * doivent pas circuler dans une query string (logs serveur, historique, etc.).
 */
export async function loginMiddleware(req, res, next) {
  let connexionSuccessful = false;
  const { email, password, appcode } = (
    await requestUtils.getRequestParams(req)
  ).params;

  try {
    const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";

    if (!email || !password) throw new Error("MISSING_PARAMETERS");

    checkBruteForce(email);
    checkBruteForce(ip);

    if (appcode === "DCLING") {
      const [cave] = await getCavesPW(email);

      if (cave?.PASSHSH && (await verifyPassword(cave.PASSHSH, password))) {
        const payload = jwtUtils.generatePayload(
          { USRID: cave.ID, EMAIL: email, USRACTV: true, ISCAVE: true },
          { PRMNAM: "USER", PRMLVL: 4 },
          appcode,
        );
        const token = jwtUtils.generateJWT(payload);

        resetAttempts(email);
        resetAttempts(ip);

        connexionSuccessful = true;
        res.status(200).json(token);
        return;
      }
    }

    const ldapUser = await ldapAuthenticate({
      SEARCH_BASE: process.env.SEARCH_BASE,
      searchOptions: {
        scope: "sub",
        filter: `(mail=${email})`,
        attributes: ["dn", "cn", "mail", "sAMAccountName", "userPrincipalName"],
      },
      serviceBindDN: process.env.LDAP_DN,
      serviceBindPassword: process.env.LDAP_PASSWORD,
      password,
    });

    if (!ldapUser) throw new Error("INVALID_CREDENTIALS");

    const userResponse = await getUserByEmail(email);
    const formattedUser = await formatUsers(userResponse);
    const user = Array.isArray(formattedUser)
      ? formattedUser[0]
      : formattedUser;

    if (!user) throw new Error("USER_NOT_FOUND");

    const permission = checkPermissions(user.PERMISSIONS, appcode);
    if (!permission) throw new Error("ACCESS_DENIED");

    resetAttempts(email);
    resetAttempts(ip);

    const payload = jwtUtils.generatePayload(user, permission, appcode);
    const token = jwtUtils.generateJWT(payload);

    connexionSuccessful = true;
    res.status(200).json(token);
  } catch (err) {
    connexionSuccessful = false;
    await randomDelay();

    if (email) registerFailedAttempt(email);
    if (req?.ip) registerFailedAttempt(req.ip);
    next(err);
  } finally {
    await postLoginStats(connexionSuccessful, email, appcode).catch(() => {});
    logger.info(
      `[LOGIN_ATTEMPT] email=${email || "unknown"} ip=${req?.ip && req?.ip !== "::1" ? req?.ip : "unknown"} success=${connexionSuccessful} appcode=${appcode || "unknown"}`,
    );
  }
}

/**
 * GET /auth/dev
 * Permet à un utilisateur ayant le statut "Développeur" (permissionLevel 1)
 * de se connecter au compte d'un autre utilisateur avec la permission de son
 * choix, en conservant une trace du token d'origine (devToken) dans le
 * nouveau JWT généré. Repris à l'identique de la logique V1.0.0.
 *
 * Paramètres attendus (query/body) : email, permlvl, appcode, isbase (0|1).
 */
export async function loginDevMiddleware(req, res, next) {
  try {
    const myToken = getRequestAuthorization(req);
    const myPayload = jwtUtils.decodeJWT(myToken);

    if (!myPayload) throw new Error("INVALID_TOKEN");
    if (myPayload.permissionLevel !== 1) throw new Error("ACCESS_DENIED");

    const { email, permlvl, appcode, isbase } = (
      await requestUtils.getRequestParams(req)
    ).params;

    if (!email || !permlvl || !appcode) throw new Error("MISSING_PARAMETERS");

    let token = "";

    if (!Number(isbase)) {
      const userResponse = await getUserByEmail(email);
      const formattedUser = await formatUsers(userResponse);
      const user = Array.isArray(formattedUser)
        ? formattedUser[0]
        : formattedUser;

      if (!user) throw new Error("USER_NOT_FOUND");

      const userPermission = user.PERMISSIONS.find(
        (p) => p.APPCOD === appcode,
      )?.PERMISSION;

      if (
        String(permlvl) === "0" &&
        (!userPermission || String(userPermission.PRMLVL) === "-1")
      ) {
        throw new Error("ACCESS_DENIED");
      }

      const permission =
        String(permlvl) === "0" && !!userPermission
          ? await getPermission(userPermission.PRMLVL)
          : await getPermission(permlvl);

      if (!permission || !permission[0]) throw new Error("DATA_NOT_FOUND");

      const payload = jwtUtils.generatePayload(
        user,
        permission[0],
        appcode,
        "true",
      );
      token = jwtUtils.generateJWT(payload);
    }

    const meResponse = await getUserByEmail(myPayload?.data?.email);
    const formattedMe = await formatUsers(meResponse);
    const me = Array.isArray(formattedMe) ? formattedMe[0] : formattedMe;

    if (!me) throw new Error("USER_NOT_FOUND");

    const myNewPayload = jwtUtils.generatePayload(
      me,
      {
        PRMNAM: myPayload.permission,
        PRMLVL: myPayload.permissionLevel,
      },
      appcode,
      token,
    );

    const myNewToken = jwtUtils.generateJWT(myNewPayload);

    res.status(200).json(myNewToken);
  } catch (err) {
    if (req?.query?.email) registerFailedAttempt(req.query.email);
    if (req?.ip) registerFailedAttempt(req.ip);

    next(err);
  }
}

/**
 * GET /auth/app
 * Génère, à partir du token courant de l'utilisateur, un nouveau token
 * spécifique à l'application ciblée (appcode), à condition que l'utilisateur
 * dispose d'une permission active pour cette application. Repris à
 * l'identique de la logique V1.0.0.
 *
 * Paramètre attendu (query/body) : appcode.
 */
export async function loginAppMiddleware(req, res, next) {
  let connexionSuccessful = false;
  const { appcode } = (await requestUtils.getRequestParams(req)).params;

  let email = null;

  try {
    const myToken = getRequestAuthorization(req);
    const myPayload = jwtUtils.decodeJWT(myToken);

    if (!myPayload) throw new Error("INVALID_TOKEN");
    if (myPayload.permissionLevel === -1) throw new Error("ACCESS_DENIED");

    if (!appcode) throw new Error("MISSING_PARAMETERS");

    const userId = myPayload.data.id;

    const rawUsers = await getUserById(userId);
    const formattedUser = await formatUsers(rawUsers);
    const user = formattedUser[0];

    if (!user) throw new Error("USER_NOT_FOUND");

    const userPermission = user.PERMISSIONS.filter(
      (p) => p.APPCOD === appcode && p.PERMISSION !== -1,
    ).reduce(
      (min, p) =>
        !min || p.PERMISSION.PRMLVL < min.PERMISSION.PRMLVL ? p : min,
      null,
    )?.PERMISSION;

    if (!userPermission || String(userPermission.PRMLVL) === "-1") {
      throw new Error("ACCESS_DENIED");
    }

    const myNewPayload = jwtUtils.generatePayload(
      user,
      userPermission,
      appcode,
    );

    const myNewToken = jwtUtils.generateJWT(myNewPayload);

    email = user.EMAIL;
    connexionSuccessful = true;

    res.status(200).json(myNewToken);
  } catch (err) {
    connexionSuccessful = false;

    if (req?.query?.email) registerFailedAttempt(req.query.email);
    if (req?.ip) registerFailedAttempt(req.ip);

    next(err);
  } finally {
    await postLoginStats(connexionSuccessful, email, appcode).catch(() => {});
    logger.info(
      `[LOGIN_ATTEMPT] email=${email || "unknown"} ip=${req?.ip && req?.ip !== "::1" ? req?.ip : "unknown"} success=${connexionSuccessful} appcode=${appcode || "unknown"}`,
    );
  }
}

/**
 * Vérifie le JWT (signature + expiration) PUIS re-vérifie que la permission
 * encodée dans le token correspond toujours à l'état actuel en base.
 *
 * Cf. audit sécurité 1.2 : dans V1.0.0 ce second contrôle était commenté —
 * un utilisateur dont les droits étaient révoqués restait pleinement
 * autorisé jusqu'à l'expiration naturelle de son token. Ici il est réactivé,
 * avec un cache de 5 min (getCachedResult) pour éviter un aller-retour base
 * à chaque requête (cf. audit perf 3.3 — étendre le cache existant).
 *
 * Cas particulier "cave" (appcode "DCLING", cf. loginMiddleware) : une cave
 * n'existe pas dans USERSMANAGER, donc getUserByEmail échouerait toujours
 * pour ce token. La table CAVE n'a ni statut actif/inactif ni notion de
 * permission granulaire (une seule cave = un seul niveau d'accès USER) —
 * l'équivalent du contrôle de révocation ci-dessus est donc simplement de
 * vérifier que la cave existe toujours (elle est supprimée par un vrai
 * DELETE SQL, cf. DELETE /api/declcav/cave), pas de rejouer un contrôle de
 * permission qui n'a pas de sens pour ce type de compte.
 */
export const authVerifyMiddleware = async (req, res, next) => {
  try {
    const token = getRequestAuthorization(req);
    const payload = verifyJWT(token);

    const isHomePage = payload.application === "HOME";

    if (isHomePage) {
      next();
      return;
    }

    if (payload.application === "DCLING" && !!payload.isCave) {
      const caveId = payload?.data?.id;
      if (!caveId) throw new Error("INVALID_TOKEN");

      const cave = await requestUtils.getCachedResult(
        `authcheck.cave.${caveId}`,
        async () => {
          const rows = await getCave(caveId);
          return rows[0] || null;
        },
        5 * 60 * 1000,
      );

      if (!cave) throw new Error("USER_NOT_FOUND");

      // CAVENOM (raison sociale, V_CAVES) rattaché à `payload.data` : seule
      // info exploitable comme identité affichée pour une cave (pas de
      // LastName/FirstName, cf. loginMiddleware) — utilisé par ex. par
      // modules/files/controllers.js#getCurrentUserDisplayName pour attribuer
      // une signature numérique (ATTACHMENTSIGNATURES.SIGNEDBY) à la cave
      // plutôt que de rejeter faute d'identité, cf. audit signature PJ.
      req.payload = {
        ...payload,
        data: { ...payload.data, CAVENOM: cave.CAVENOM || "" },
      };
      next();
      return;
    }

    const isSimulate = payload.devToken === "true";
    const userPermLvl = String(payload.permissionLevel);

    const email = payload?.data?.email;
    if (!email) throw new Error("INVALID_TOKEN");

    const user = await requestUtils.getCachedResult(
      `authcheck.${email}`,
      async () => {
        const rows = await getUserByEmail(email);
        const formatted = await formatUsers(rows);
        return formatted[0] || null;
      },
      5 * 60 * 1000,
    );

    if (!user) throw new Error("USER_NOT_FOUND");
    if (!user.USRACTV) throw new Error("ACCESS_DENIED");

    if (!isSimulate && userPermLvl !== "-1") {
      const currentPermission = user.PERMISSIONS?.filter(
        (p) => p.APPCOD === payload.application && p.PRMLVL !== -1,
      ).reduce(
        (min, current) => (!min || current.PRMLVL < min.PRMLVL ? current : min),
        null, // valeur initiale : évite "Reduce of empty array with no initial value"
        // si l'utilisateur n'a plus aucune permission active pour cette
        // application (droits totalement révoqués) — ce cas doit résoudre en
        // ACCESS_DENIED ci-dessous, pas planter avec une TypeError non gérée.
      )?.PERMISSION;

      if (!currentPermission || Number(currentPermission.PRMLVL) === -1) {
        throw new Error("ACCESS_DENIED");
      }

      if (Number(currentPermission.PRMLVL) < Number(payload.permissionLevel)) {
        throw new Error("ACCESS_DENIED");
      }
    }

    req.payload = payload;
    next();
  } catch (err) {
    req.payload = null;
    next(err);
  }
};

// ---------------------------------------------------------------------------
// Expiration des mots de passe Active Directory
// ---------------------------------------------------------------------------

// FILETIME AD : intervalles de 100 ns depuis le 01/01/1601 (UTC).
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const TICKS_PER_MS = 10000n;
const INT64_MAX = 0x7fffffffffffffffn;
const INT64_MIN = -0x8000000000000000n;
const UAC_ACCOUNTDISABLE = 0x2;
const UAC_DONT_EXPIRE_PASSWORD = 0x10000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PWD_AGE_CACHE_MS = 60 * 60 * 1000; // la stratégie change rarement
// Codes LDAP renvoyés par l'AD pour un objet invisible au compte de service.
const LDAP_NO_SUCH_OBJECT = 32;
const LDAP_INSUFFICIENT_ACCESS_RIGHTS = 50;

/** Convertit un FILETIME AD (pwdLastSet) en timestamp ms, ou null si 0 / vide. */
function fileTimeToMs(value) {
  if (value === undefined || value === null || value === "") return null;
  const ft = BigInt(value);
  if (ft <= 0n || ft >= INT64_MAX) return null;
  return Number((ft - FILETIME_EPOCH_OFFSET) / TICKS_PER_MS);
}

/**
 * DN racine du domaine, déduit des composants DC= de SEARCH_BASE
 * (ex. "OU=Utilisateurs,DC=UVCDR,DC=FR" -> "DC=UVCDR,DC=FR").
 * Surchargeable via LDAP_DOMAIN_DN.
 */
function getDomainDN() {
  if (process.env.LDAP_DOMAIN_DN) return process.env.LDAP_DOMAIN_DN;
  const dcs = (process.env.SEARCH_BASE || "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => /^DC=/i.test(p));
  if (!dcs.length) throw new Error("LDAP_CONFIGURATION_ERROR");
  return dcs.join(",");
}

/** Convertit une durée AD (intervalle négatif de 100 ns) en ms, ou null si "jamais". */
function adIntervalToMs(value) {
  const raw = BigInt(value);
  if (raw === 0n || raw === INT64_MIN) return null;
  return Number((raw < 0n ? -raw : raw) / TICKS_PER_MS);
}

/** Lit un attribut de durée sur un objet (base scope), avec cache. */
function readPolicyMaxAgeMs(dn, attribute) {
  return requestUtils.getCachedResult(
    `ldap.pwdpolicy.${dn.toLowerCase()}`,
    async () => {
      let obj;
      try {
        [obj] = await ldapServiceSearch(dn, {
          scope: "base",
          filter: "(objectClass=*)",
          attributes: [attribute],
          paged: false,
        });
      } catch (err) {
        // Objet non visible (ACL) : l'AD répond noSuchObject plutôt qu'un
        // résultat vide -> traité comme "stratégie non lisible".
        if (
          [LDAP_NO_SUCH_OBJECT, LDAP_INSUFFICIENT_ACCESS_RIGHTS].includes(
            err.cause?.code,
          )
        ) {
          return undefined;
        }
        throw err;
      }
      // Attribut absent = non lisible par le compte de service -> undefined
      // (mis en cache aussi, pour ne pas réinterroger l'AD à chaque appel).
      if (obj?.[attribute] === undefined) return undefined;
      return adIntervalToMs(obj[attribute]);
    },
    MAX_PWD_AGE_CACHE_MS,
  );
}

/**
 * Durée de validité effective pour un utilisateur, en ms (null = n'expire jamais) :
 * - stratégie affinée (PSO/FGPP) si `msDS-ResultantPSO` est renseigné
 *   -> `msDS-MaximumPasswordAge` du PSO ;
 * - sinon stratégie de domaine -> `maxPwdAge` de l'objet domaine.
 */
// undefined = stratégie non lisible (ACL par défaut des PSO : admins
// uniquement) -> formatPasswordExpiration se rabat sur
// msDS-UserPasswordExpiryTimeComputed.
function getEffectiveMaxPasswordAgeMs(resultantPsoDN) {
  return resultantPsoDN
    ? readPolicyMaxAgeMs(resultantPsoDN, "msDS-MaximumPasswordAge")
    : readPolicyMaxAgeMs(getDomainDN(), "maxPwdAge");
}

/**
 * Calcule l'expiration : pwdLastSet + durée de validité.
 * Cas particuliers : flag "le mot de passe n'expire jamais", stratégie sans
 * expiration, pwdLastSet = 0 (changement obligatoire à la prochaine ouverture de session).
 */
function formatPasswordExpiration(entry, policyMaxAgeMs, now = Date.now()) {
  const uac = Number(entry.userAccountControl || 0);
  const pwdLastSetMs = fileTimeToMs(entry.pwdLastSet);
  const mustChangeAtNextLogon = String(entry.pwdLastSet ?? "") === "0";

  // Durée de validité : celle de la stratégie si elle a pu être lue, sinon
  // déduite de msDS-UserPasswordExpiryTimeComputed (calculé par l'AD) moins
  // pwdLastSet — cas d'un PSO non lisible par le compte de service.
  let maxPwdAgeMs = policyMaxAgeMs;
  if (maxPwdAgeMs === undefined) {
    const computed = entry["msDS-UserPasswordExpiryTimeComputed"];
    const computedMs =
      computed !== undefined && BigInt(computed) < INT64_MAX
        ? fileTimeToMs(computed)
        : null;
    maxPwdAgeMs =
      computedMs !== null && pwdLastSetMs !== null
        ? computedMs - pwdLastSetMs
        : null;
  }

  const neverExpires =
    (uac & UAC_DONT_EXPIRE_PASSWORD) !== 0 || maxPwdAgeMs === null;

  const expiresAtMs =
    !neverExpires && pwdLastSetMs !== null ? pwdLastSetMs + maxPwdAgeMs : null;

  return {
    sAMAccountName: entry.sAMAccountName || null,
    email: entry.mail || null,
    displayName: entry.displayName || null,
    accountDisabled: (uac & UAC_ACCOUNTDISABLE) !== 0,
    passwordPolicy: entry["msDS-ResultantPSO"] || "DOMAIN",
    pwdLastSet:
      pwdLastSetMs !== null ? new Date(pwdLastSetMs).toISOString() : null,
    maxPwdAgeDays:
      maxPwdAgeMs !== null ? Math.round(maxPwdAgeMs / DAY_MS) : null,
    neverExpires,
    mustChangeAtNextLogon,
    expiresAt:
      expiresAtMs !== null ? new Date(expiresAtMs).toISOString() : null,
    isExpired:
      mustChangeAtNextLogon || (expiresAtMs !== null && expiresAtMs <= now),
    daysRemaining:
      expiresAtMs !== null ? Math.floor((expiresAtMs - now) / DAY_MS) : null,
  };
}

/**
 * Lit dans l'Active Directory la date d'expiration du mot de passe de chaque
 * utilisateur : date du dernier changement (pwdLastSet) + durée de validité
 * de la stratégie applicable (PSO/FGPP si présente, sinon stratégie de domaine).
 *
 * Prérequis AD : le compte de service (LDAP_DN) doit pouvoir lire
 * pwdLastSet, userAccountControl et msDS-ResultantPSO sur les utilisateurs,
 * ainsi que msDS-MaximumPasswordAge sur les PSO. Sinon l'AD omet ces
 * attributs sans erreur -> on lève LDAP_ATTRIBUTE_NOT_READABLE plutôt que de
 * renvoyer un faux "n'expire jamais".
 *
 * @param {object}  [options]
 * @param {string}  [options.email]              Filtre sur un utilisateur (attribut `mail`).
 * @param {string[]} [options.emails]            Filtre sur une liste d'utilisateurs (fusionné avec `email`).
 * @param {boolean} [options.includeDisabled]    Inclure les comptes désactivés (défaut : false).
 * @param {number}  [options.expiringWithinDays] Ne garder que les MDP expirant sous N jours (expirés inclus).
 * @returns {Promise<Array<object>>} Trié par date d'expiration croissante (sans expiration en fin de liste).
 */
export async function getPasswordExpirations({
  email,
  emails,
  includeDisabled = false,
  expiringWithinDays,
} = {}) {
  const filters = ["(objectCategory=person)", "(objectClass=user)"];
  if (!includeDisabled) {
    filters.push(
      `(!(userAccountControl:1.2.840.113556.1.4.803:=${UAC_ACCOUNTDISABLE}))`,
    );
  }

  // email (unitaire) et emails (liste) sont fusionnés et dédoublonnés.
  const mailList = [...new Set([email, ...(emails ?? [])].filter(Boolean))];
  if (mailList.length) {
    const mailFilters = mailList
      .map((m) => `(mail=${escapeLdapFilterValue(m)})`)
      .join("");
    filters.push(mailList.length === 1 ? mailFilters : `(|${mailFilters})`);
  }

  const entries = await ldapServiceSearch(process.env.SEARCH_BASE, {
    scope: "sub",
    filter: `(&${filters.join("")})`,
    attributes: [
      "sAMAccountName",
      "mail",
      "displayName",
      "userAccountControl",
      "pwdLastSet",
      "msDS-ResultantPSO",
      "msDS-UserPasswordExpiryTimeComputed",
    ],
  });

  const unreadable = entries.filter((e) => e.pwdLastSet === undefined);
  if (unreadable.length) {
    // Typiquement des comptes à privilèges (adminCount=1, AdminSDHolder) :
    // l'héritage des droits de l'OU ne s'applique pas à eux.
    logger.warn(
      `[LDAP][PWD_EXPIRATION] pwdLastSet illisible pour ${unreadable.length} compte(s) (AdminSDHolder probable) : ${unreadable.map((e) => e.sAMAccountName || e.dn).join(", ")}`,
    );
  }
  if (entries.length && unreadable.length === entries.length) {
    logger.error(
      "[LDAP][PWD_EXPIRATION] pwdLastSet non renvoyé par l'AD : le compte de service n'a pas le droit de lecture (Read Account Restrictions).",
    );
    throw new Error("LDAP_ATTRIBUTE_NOT_READABLE");
  }

  const readable = entries.filter((e) => e.pwdLastSet !== undefined);

  // Une seule lecture par stratégie distincte (domaine + chaque PSO).
  const policies = new Map();
  for (const dn of new Set(readable.map((e) => e["msDS-ResultantPSO"] || ""))) {
    policies.set(dn, await getEffectiveMaxPasswordAgeMs(dn || null));
  }

  const now = Date.now();
  let results = readable.map((e) =>
    formatPasswordExpiration(
      e,
      policies.get(e["msDS-ResultantPSO"] || ""),
      now,
    ),
  );

  if (Number.isFinite(Number(expiringWithinDays))) {
    const limit = Number(expiringWithinDays);
    results = results.filter(
      (r) =>
        r.isExpired || (r.daysRemaining !== null && r.daysRemaining <= limit),
    );
  }

  return results.sort((a, b) => {
    if (!a.expiresAt) return b.expiresAt ? 1 : 0;
    if (!b.expiresAt) return -1;
    return a.expiresAt.localeCompare(b.expiresAt);
  });
}

// Nettoyage périodique du bruteForceMap (toutes les 30 min)
setInterval(
  () => {
    const now = Date.now();
    for (const [k, rec] of bruteForceMap.entries()) {
      const last = Math.max(rec.blockedUntil, rec.attempts.at(-1) || 0);
      if (now - last > 60 * 60 * 1000) bruteForceMap.delete(k);
    }
  },
  30 * 60 * 1000,
).unref();
