// tests/helpers/fixtures.js
// Fabriques de données de test réutilisables entre suites. Construites à
// partir des VRAIES fonctions de formatage/JWT (formatUsers, jwtUtils) plutôt
// que de deviner la forme finale à la main : si le format réel change, les
// fixtures suivent automatiquement et les tests ne mentent pas sur la forme
// des données.
import * as jwtUtils from "../../core/utils/jwt.utils.js";
import { formatUsers } from "../../modules/usersmanager/utils.js";

/**
 * Construit une ligne "brute" telle que renvoyée par sp_GetUsers_JSON
 * (SERVICE/PERMISSIONS/GROUPS/SUBORDINATES en chaînes JSON imbriquées).
 */
export function buildRawUserRow(overrides = {}) {
  const {
    USRID = 1,
    LSTNAM = "Dupont",
    FSTNAM = "Jean",
    EMAIL = "jean.dupont@union-vignerons.com",
    USRACTV = 1,
    ISEXT = 0,
    appcode = "TICKETING",
    permissionLevel = 4,
    permissionName = "USER",
  } = overrides;

  return {
    USRID,
    LSTNAM,
    FSTNAM,
    EMAIL,
    PHNNUM: null,
    USRACTV,
    ISEXT,
    USRIMG: null,
    SERVICE: JSON.stringify({
      SRVID: 10,
      SRVNAM: "Support",
      POSITIONS: JSON.stringify([{ POSNAM: "Technicien", POSCOD: "TECH", POSLVL: 3 }]),
    }),
    PERMISSIONS: JSON.stringify([
      {
        APPCOD: appcode,
        APPLNK: "[DOMAIN]/app",
        IMGLNK: null,
        PRMLVL: permissionLevel,
        PERMISSION: JSON.stringify({
          PRMID: 3,
          PRMNAM: permissionName,
          PRMDES: "Accès standard",
          PRMLVL: permissionLevel,
          BYGRP: false,
          ISCRIT: false,
        }),
      },
    ]),
    SUBORDINATES: JSON.stringify([]),
    GROUPS: JSON.stringify([]),
  };
}

/** Retourne l'utilisateur déjà formaté (post formatUsers), prêt à l'emploi. */
export async function buildFormattedUser(overrides = {}) {
  const raw = buildRawUserRow(overrides);
  const [formatted] = await formatUsers([raw]);
  return formatted;
}

/**
 * Construit un utilisateur formaté + un JWT valide (signé avec le vrai
 * JWT_SECRET de test, cf. vitest.config.js) correspondant.
 * Utilisé par les tests d'intégration pour authentifier les requêtes
 * supertest sans jamais passer par un vrai LDAP/SQL.
 */
export async function buildAuthToken(overrides = {}) {
  const appcode = overrides.appcode || "TICKETING";
  const user = await buildFormattedUser(overrides);
  const permission = user.PERMISSIONS[0].PERMISSION;
  const payload = jwtUtils.generatePayload(user, permission, appcode);
  const token = jwtUtils.generateJWT(payload);
  return { token, user, payload, raw: buildRawUserRow(overrides) };
}

/**
 * Ligne "brute" telle que renvoyée par SELECT_TICKETS (1 ligne par
 * note/pièce jointe, cf. modules/ticketing/utils.js#formatTickets).
 */
export function buildTicketRow(overrides = {}) {
  return {
    TCKID: 100,
    TCKCOD: "TCK-000100",
    TITLE: "Imprimante HS",
    DESCR: "L'imprimante du service compta ne répond plus.",
    SRVID: 10,
    SRVNAM: "Support",
    STSID: 1,
    STSNAM: "Ouvert",
    STSCOD: "OPEN",
    STSLVL: 0,
    PRIID: 2,
    PRINAM: "Normale",
    PRICOD: "NORMAL",
    PRILVL: 1,
    CATID: null,
    CATNAM: "",
    SC1ID: null,
    SC1NAM: "",
    SC2ID: null,
    SC2NAM: "",
    SC3ID: null,
    SC3NAM: "",
    CREUSR: 1,
    USRNAM: "Jean Dupont",
    CREEMAIL: "jean.dupont@union-vignerons.com",
    ASGUSR: 1,
    ASGNAM: "Jean Dupont",
    CREDAT: new Date("2026-06-01T10:00:00Z"),
    UPDDAT: new Date("2026-06-01T10:00:00Z"),
    CLSDAT: null,
    MYSRV: 1,
    DLTD: 0,
    ATTID: null,
    NOTID: null,
    ...overrides,
  };
}
