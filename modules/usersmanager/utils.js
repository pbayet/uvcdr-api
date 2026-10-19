import * as functionsUtils from "../../core/utils/functions.utils.js";

const domain = process.env.DOMAIN || "";

/**
 * sp_GetUsers_JSON renvoie SERVICE/PERMISSIONS/GROUPS/SUBORDINATES/MAILCOPIES/USRIMG
 * sous forme de chaînes JSON — cette fonction les parse et les normalise.
 */
export async function formatUsers(rows) {
  if (!Array.isArray(rows)) return [];

  return rows.map((row) => {
    const SERVICE = (() => {
      const parsed = functionsUtils.parseToJSON(row.SERVICE);
      if (!parsed) return null;
      return {
        ...parsed,
        POSITIONS: functionsUtils.parseToJSON(parsed.POSITIONS) ?? [],
      };
    })();

    const PERMISSIONS = (() => {
      const parsed = functionsUtils.parseToJSON(row.PERMISSIONS);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((perm) => {
        const permParsed = functionsUtils.parseToJSON(perm.PERMISSION);

        return {
          ...perm,
          APPLNK: perm.APPLNK ? perm.APPLNK.replace("[DOMAIN]", domain) : "",
          IMGLNK:
            perm.APPCOD && domain
              ? perm.IMGLNK || `${domain}/API/assets/${perm.APPCOD}.jpg`
              : "",
          PERMISSION: permParsed,
        };
      });
    })();

    return {
      ...row,
      USRIMG: functionsUtils.parseToJSON(row.USRIMG),
      SERVICE,
      SUBORDINATES: functionsUtils.parseToJSON(row.SUBORDINATES) ?? [],
      PERMISSIONS,
      GROUPS: functionsUtils.parseToJSON(row.GROUPS) ?? [],
      MAILCOPIES: functionsUtils.parseToJSON(row.MAILCOPIES) ?? [],
    };
  });
}

export function formatApplications(rows = []) {
  return rows.length > 0
    ? rows.map((application) => ({
        ...application,
        IMGLNK:
          application.APPCOD && domain
            ? application.IMGLNK ||
              `${domain}/API/assets/${application.APPCOD}.jpg`
            : "",
      }))
    : [];
}

/**
 * Regroupe les lignes de V_App_Last_Version_Details (jointes aux
 * changements/APPCHANGES) en une entrée par version d'application.
 */
export function formatAppVersions(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const appMap = new Map();

  for (const row of rows) {
    let app = appMap.get(row.APPCOD);

    if (!app) {
      app = {
        VID: row.VID,
        APPCOD: row.APPCOD,
        VNUM: row.VNUM,
        RELEASEDTE: row.RELEASEDTE,
        SUMMARY: row.SUMMARY || "",
        CREATED_BY: {
          USRID: row.CREUSR_ID,
          LSTNAM: row.CREUSR_LNAME,
          FSTNAM: row.CREUSR_FNAME,
          EMAIL: row.CREUSR_EMAIL,
        },
        ISVIEW: row.ISVIEW ?? null,
        CHANGES: [],
        _changeSet: new Set(),
      };
      appMap.set(row.APPCOD, app);
    }

    if (row.CID && !app._changeSet.has(row.CID)) {
      app._changeSet.add(row.CID);
      app.CHANGES.push({
        CID: row.CID,
        CTYPE: row.CTYPE,
        CTITLE: row.CTITLE,
        CDESC: row.CDESC,
      });
    }
  }

  for (const app of appMap.values()) {
    delete app._changeSet;
  }

  return Array.from(appMap.values());
}

/**
 * Transforme le résultat SQL V_GroupsPermission en structure
 * Group -> Applications -> Permission.
 */
export function formatGroupsPermissions(rows = []) {
  const groupsMap = new Map();

  for (const row of rows) {
    const groupId = row.GRPID;
    const appId = row.APPID;

    if (!groupsMap.has(groupId)) {
      groupsMap.set(groupId, {
        GRPID: row.GRPID,
        GRPNAM: row.GRPNAM,
        GRPDES: row.GRPDES,
        ACTIVE: Boolean(row.GRPACTV),
        GRPBAS: Boolean(row.GRPBAS),
        PERMISSIONS: [],
      });
    }

    const group = groupsMap.get(groupId);

    let application = group.PERMISSIONS.find((app) => app.APPID === appId);

    if (!application) {
      application = {
        APPID: row.APPID,
        APPCOD: row.APPCOD,
        APPNAM: row.APPNAM,
        APPDES: row.APPDES,
        LOGLNK: row.LOGLNK,
        APPLNK: row.APPLNK?.replace("[DOMAIN]", domain) || "[DOMAIN]/",
        DOCLNK: row.DOCLNK,
        IMGLNK:
          row.IMGLNK || domain ? `${domain}/API/assets/${row.APPCOD}.jpg` : "",
        ACTIVE: Boolean(row.APPACTV),
        PERMISSION: null,
      };

      group.PERMISSIONS.push(application);
    }

    if (row.PRMID) {
      application.PERMISSION = {
        PRMID: row.PRMID,
        PRMNAM: row.PRMNAM,
        PRMDES: row.PRMDES,
        PRMLVL: row.PRMLVL,
        BYGRP: true,
        ISCRIT: Boolean(row.ISCRIT),
      };
    }
  }

  return Array.from(groupsMap.values());
}

/**
 * Transforme le résultat SQL V_PositionsServices en structure
 * Service -> Positions.
 */
export function formatServices(rows = []) {
  const servicesMap = new Map();

  for (const row of rows) {
    const servId = row.SRVID;
    const posId = row.POSID;

    if (!servicesMap.has(servId)) {
      servicesMap.set(servId, {
        SRVID: row.SRVID,
        SRVCOD: row.SRVCOD,
        SRVNAM: row.SRVNAM,
        SRVDES: row.SRVDES,
        POSITIONS: [],
      });
    }

    const service = servicesMap.get(servId);

    let position = service.POSITIONS.find((pos) => pos.POSID === posId);

    if (!position) {
      position = {
        POSID: row.POSID,
        POSNAM: row.POSNAM,
        POSCOD: row.POSCOD,
        POSLVL: row.POSLVL,
        POSDES: row.POSDES,
      };

      service.POSITIONS.push(position);
    }
  }

  return Array.from(servicesMap.values());
}
