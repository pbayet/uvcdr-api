import * as services from "./services.js";
import * as utils from "./utils.js";
import * as requestUtils from "../../core/utils/request.utils.js";
import * as functionsUtils from "../../core/utils/functions.utils.js";
import * as filesServices from "../files/services.js";
import * as v from "./validators.js";
import { utcToParisIso } from "../../core/utils/dates.utils.js";

/**
 * GET /me — profil de l'utilisateur connecté (déduit du JWT, déjà
 * revérifié par authVerifyMiddleware). Pas de nouvel appel base ici.
 */
export function getMe(req) {
  return req.payload?.data ?? null;
}

/* -------------------------------------------------------------------------- */
/*                                    GETS                                    */
/* -------------------------------------------------------------------------- */

export async function getUsers(req) {
  const cacheKey = `usersmanager_all`;
  const { force } = (await requestUtils.getRequestParams(req)).params;

  if (!force) {
    return requestUtils.getCachedResult(cacheKey, async () => {
      const rawUsers = await services.getUsers();
      return utils.formatUsers(rawUsers);
    });
  }

  const rawUsers = await services.getUsers();
  return utils.formatUsers(rawUsers);
}

export async function getUser(req) {
  const { email, id, poscod } = v.userQuerySchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  let formattedUsers = [];

  if (email) {
    formattedUsers = await utils.formatUsers(
      await services.getUserByEmail(email),
    );
  } else if (id) {
    formattedUsers = await utils.formatUsers(await services.getUserById(id));
  } else if (poscod) {
    formattedUsers = await utils.formatUsers(
      await services.getUserByPosCod(poscod),
    );
  }

  const formattedUser = formattedUsers[0];
  if (!formattedUser) throw new Error("USER_NOT_FOUND");

  return formattedUser;
}

export async function getApplications(req) {
  const { APPCOD } = (await requestUtils.getRequestParams(req)).params;

  const rawApplications = await services.getApplications();
  const applications = utils.formatApplications(rawApplications);

  return APPCOD ? applications.find((a) => a.APPCOD === APPCOD) : applications;
}

export async function getApplicationCurrentVersion(req) {
  const { APPCOD } = (await requestUtils.getRequestParams(req)).params;
  const rawApplications = await services.getApplicationCurrentVersion(APPCOD);
  return rawApplications[0];
}

export async function getHomeApplications(req) {
  const { USRID } = v.homeApplicationsQuerySchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const rawUsers = await services.getUserById(USRID);
  const formattedUsers = await utils.formatUsers(rawUsers);

  return services.getHomeApplications(formattedUsers[0]);
}

export async function getGeneralActivity(req) {
  const { EMAIL } = (await requestUtils.getRequestParams(req)).params;

  const activities = await services.getGeneralActivity(EMAIL);

  return activities.map((a) => {
    return {
      ...a,
      EVENT_DATE: utcToParisIso(a.EVENT_DATE),
    };
  });
}

export async function getUserActivity(req) {
  const { EMAIL, SOURCE } = (await requestUtils.getRequestParams(req)).params;

  const activities = await services.getUserActivity(EMAIL, SOURCE);

  return activities[0]
    ? {
        ...activities[0],
        EVENT_DATE: utcToParisIso(activities[0].EVENT_DATE),
      }
    : {};
}

export async function getPermissions() {
  return services.getPermissions();
}

export async function getPermission(req) {
  const { lvl } = v.permissionQuerySchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const permission = await services.getPermission(lvl);
  if (!permission || !permission[0]) throw new Error("DATA_NOT_FOUND");

  return permission[0];
}

export async function getServices() {
  return utils.formatServices(await services.getServices());
}

export async function getServicesAll() {
  return utils.formatServices(await services.getServicesAll());
}

export async function getPositions() {
  return services.getPositions();
}

export async function getGroups() {
  return utils.formatGroupsPermissions(await services.getGroups());
}

export async function getLastVersionDetails(req) {
  const USRID = req?.payload?.data?.id;
  const VNUM = req?.payload?.application;

  if (!USRID || !VNUM) throw new Error("MISSING_PARAMETERS");

  const rowDetails = await services.getLastVersionDetails(USRID, VNUM);
  const formattedDetails = await utils.formatAppVersions(rowDetails);

  if (!formattedDetails || !formattedDetails[0])
    throw new Error("DATA_NOT_FOUND");

  return formattedDetails[0];
}

/* -------------------------------------------------------------------------- */
/*                                   POSTS                                    */
/* -------------------------------------------------------------------------- */

export async function upsertUser(req) {
  const {
    USRID,
    LSTNAM,
    FSTNAM,
    EMAIL,
    PHNNUM,
    USRACTV,
    ISEXT,
    POSID,
    GRPIDS,
    PERMISSIONS,
    SUBORDINATES,
    MAILCOPIES,
    ENTITYNAME,
  } = v.upsertUserSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const postUSRID = req?.payload?.data?.id;

  if (ENTITYNAME) {
    await filesServices.deleteFileByEntity(ENTITYNAME, String(USRID));
  }

  const newUSRID = await services.upsertUser(
    USRID,
    LSTNAM,
    FSTNAM,
    EMAIL,
    PHNNUM,
    USRACTV,
    ISEXT,
    POSID,
    postUSRID,
  );

  const jsonGRPIDS = functionsUtils.parseToJSON(GRPIDS);
  const jsonPERMISSIONS = functionsUtils.parseToJSON(PERMISSIONS);
  const jsonSUBORDINATES = functionsUtils.parseToJSON(SUBORDINATES);
  const jsonMAILCOPIES = functionsUtils.parseToJSON(MAILCOPIES);

  if (jsonGRPIDS) {
    await services.delsertUserGroups(
      newUSRID,
      jsonGRPIDS.length > 0 ? JSON.stringify(jsonGRPIDS) : "",
    );
  }

  if (jsonPERMISSIONS) {
    await services.delsertUserPermissions(
      newUSRID,
      jsonPERMISSIONS.length > 0 ? jsonPERMISSIONS : [],
    );
  }

  if (jsonSUBORDINATES) {
    await services.delsertUserSubordinates(
      newUSRID,
      jsonSUBORDINATES.length > 0 ? JSON.stringify(jsonSUBORDINATES) : "",
    );
  }

  if (jsonMAILCOPIES) {
    await services.delsertUserMailCopies(
      newUSRID,
      jsonMAILCOPIES.length > 0 ? JSON.stringify(jsonMAILCOPIES) : "",
    );
  }

  const user = await services.getUserById(newUSRID);
  const formattedUser = await utils.formatUsers(user);

  return formattedUser[0];
}

export async function upsertService(req) {
  const { SRVID, SRVCOD, SRVNAM, SRVDES } = v.upsertServiceSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const USRID = req?.payload?.data?.id;

  const serviceId = await services.upsertService(
    USRID,
    SRVID,
    SRVCOD,
    SRVNAM,
    SRVDES,
  );

  const servicesData = await services.getServicesAll(serviceId);
  if (servicesData.length === 0) throw new Error("DATA_NOT_FOUND");

  return servicesData[0];
}

export async function upsertPosition(req) {
  const { POSID, POSNAM, POSDES, POSCOD, POSLVL, SRVCOD } =
    v.upsertPositionSchema.parse(
      (await requestUtils.getRequestParams(req)).params,
    );

  const USRID = req?.payload?.data?.id;

  const positionId = await services.upsertPosition(
    USRID,
    POSID,
    POSNAM,
    POSDES,
    POSCOD,
    POSLVL,
    SRVCOD,
  );

  const positions = await services.getPositions(positionId);
  if (positions.length === 0) throw new Error("DATA_NOT_FOUND");

  return positions[0];
}

export async function upsertGroup(req) {
  const { GRPID, GRPNAM, GRPDES, ACTIVE, GRPBAS, PERMISSIONS } =
    v.upsertGroupSchema.parse(
      (await requestUtils.getRequestParams(req)).params,
    );

  const USRID = req?.payload?.data?.id;

  const jsonPERMISSIONS = functionsUtils.parseToJSON(PERMISSIONS);

  const groupId = await services.upsertGroup(
    USRID,
    GRPID,
    GRPNAM,
    GRPDES,
    ACTIVE,
    GRPBAS,
  );

  await services.delsertGroupPermissions(groupId, jsonPERMISSIONS || []);

  const groups = await services.getGroups(groupId);
  const groupsData = utils.formatGroupsPermissions(groups);

  if (groupsData.length === 0) throw new Error("DATA_NOT_FOUND");

  return groupsData[0];
}

export async function upsertApplication(req) {
  const {
    APPID,
    APPCOD,
    APPNAM,
    APPDES,
    LOGLNK,
    APPLNK,
    DOCLNK,
    IMGLNK,
    ACTIVE,
  } = v.upsertApplicationSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const USRID = req?.payload?.data?.id;

  const applicationId = await services.upsertApplication(
    USRID,
    APPID,
    APPCOD,
    APPNAM,
    APPDES,
    LOGLNK,
    APPLNK,
    DOCLNK,
    IMGLNK,
    ACTIVE,
    0,
  );

  const applications = await services.getApplications(applicationId);
  if (applications.length === 0) throw new Error("DATA_NOT_FOUND");

  return applications[0];
}

export async function setLastVersionDetailsOpened(req) {
  const { VID } = v.lastVersionDetailsOpenedSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const USRID = req?.payload?.data?.id;
  if (!USRID) throw new Error("MISSING_PARAMETERS");

  await services.setLastVersionDetailsOpened(USRID, VID);

  return true;
}

export async function patchServicePosition(req) {
  const { SRVCOD, POSID } = v.servicePositionPatchSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const USRID = req?.payload?.data?.id;
  if (!USRID) throw new Error("MISSING_PARAMETERS");

  await services.patchServicePosition(SRVCOD, POSID, USRID);

  return true;
}

/* -------------------------------------------------------------------------- */
/*                                   THÈMES                                   */
/* -------------------------------------------------------------------------- */

// Thème appliqué quand l'utilisateur n'a rien choisi (ni pour l'application,
// ni par défaut).
export const FALLBACK_THEME = "light";

/**
 * GET /themes — préférences de l'utilisateur connecté : thème par défaut
 * (DEFAULT, FALLBACK_THEME si non défini) et thèmes spécifiques par
 * application (seules les applications personnalisées sont listées).
 */
export async function getThemes(req) {
  const USRID = req?.payload?.data?.id;
  if (!USRID) throw new Error("MISSING_PARAMETERS");

  const rows = await services.getUserThemes(USRID);

  return {
    DEFAULT: rows.find((r) => r.APPID == null)?.THEME ?? FALLBACK_THEME,
    APPLICATIONS: rows
      .filter((r) => r.APPID != null)
      .map(({ APPID, APPCOD, THEME }) => ({ APPID, APPCOD, THEME })),
  };
}

/**
 * GET /theme?APPCOD=… — thème à appliquer par une application pour
 * l'utilisateur connecté : celui de l'application, sinon le thème par
 * défaut, sinon FALLBACK_THEME. SOURCE indique d'où vient la valeur.
 */
export async function getTheme(req) {
  const { APPCOD } = v.themeQuerySchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const { DEFAULT, APPLICATIONS } = await getThemes(req);
  const appTheme = APPCOD
    ? APPLICATIONS.find((a) => a.APPCOD === APPCOD)?.THEME
    : undefined;

  return {
    APPCOD: APPCOD ?? null,
    THEME: appTheme ?? DEFAULT,
    DEFAULT,
    SOURCE: appTheme ? "APPLICATION" : "DEFAULT",
  };
}

/**
 * POST /theme — enregistre une préférence de l'utilisateur connecté
 * (uniquement la sienne, quel que soit son niveau de permission). Sans
 * APPCOD : thème par défaut. Avec APPCOD et THEME null : l'application
 * repasse sur le thème par défaut. Renvoie l'état complet (cf. getThemes).
 */
export async function setTheme(req) {
  const { APPCOD, THEME } = v.setThemeSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const USRID = req?.payload?.data?.id;
  if (!USRID) throw new Error("MISSING_PARAMETERS");

  const done = await services.setUserTheme(USRID, APPCOD ?? null, THEME ?? null);
  if (!done) throw new Error("DATA_NOT_FOUND");

  return getThemes(req);
}
