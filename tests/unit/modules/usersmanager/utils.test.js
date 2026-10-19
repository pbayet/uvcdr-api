import { describe, it, expect } from "vitest";
import {
  formatUsers,
  formatApplications,
  formatAppVersions,
  formatGroupsPermissions,
  formatServices,
} from "../../../../modules/usersmanager/utils.js";
import { buildRawUserRow } from "../../../helpers/fixtures.js";

describe("modules/usersmanager/utils :: formatUsers", () => {
  it("retourne un tableau vide pour une entrée non-tableau", async () => {
    expect(await formatUsers(null)).toEqual([]);
    expect(await formatUsers(undefined)).toEqual([]);
  });

  it("parse SERVICE/PERMISSIONS/GROUPS/SUBORDINATES (double JSON imbriqué)", async () => {
    const [user] = await formatUsers([buildRawUserRow()]);

    expect(user.SERVICE.SRVNAM).toBe("Support");
    expect(user.SERVICE.POSITIONS[0].POSCOD).toBe("TECH");
    expect(user.PERMISSIONS[0].APPCOD).toBe("TICKETING");
    expect(user.PERMISSIONS[0].PERMISSION.PRMNAM).toBe("USER");
    expect(user.SUBORDINATES).toEqual([]);
    expect(user.GROUPS).toEqual([]);
  });

  it("remplace [DOMAIN] dans APPLNK par la variable d'env DOMAIN", async () => {
    const [user] = await formatUsers([buildRawUserRow()]);
    expect(user.PERMISSIONS[0].APPLNK).toBe(`${process.env.DOMAIN}/app`);
  });
});

describe("modules/usersmanager/utils :: formatApplications", () => {
  it("retourne un tableau vide pour une entrée vide", () => {
    expect(formatApplications([])).toEqual([]);
    expect(formatApplications(undefined)).toEqual([]);
  });

  it("génère IMGLNK par défaut si absent", () => {
    const [app] = formatApplications([{ APPCOD: "TICKETING", IMGLNK: null }]);
    expect(app.IMGLNK).toBe(`${process.env.DOMAIN}/API/assets/TICKETING.jpg`);
  });
});

describe("modules/usersmanager/utils :: formatAppVersions", () => {
  it("regroupe les changements par version applicative", () => {
    const rows = [
      { VID: 1, APPCOD: "TICKETING", VNUM: "1.1.0", SUMMARY: "Refonte", CID: 10, CTYPE: "fix", CTITLE: "Bug notes" },
      { VID: 1, APPCOD: "TICKETING", VNUM: "1.1.0", SUMMARY: "Refonte", CID: 11, CTYPE: "feat", CTITLE: "WebSocket" },
    ];

    const result = formatAppVersions(rows);
    expect(result).toHaveLength(1);
    expect(result[0].CHANGES).toHaveLength(2);
  });

  it("retourne un tableau vide pour une entrée vide", () => {
    expect(formatAppVersions([])).toEqual([]);
    expect(formatAppVersions(null)).toEqual([]);
  });
});

describe("modules/usersmanager/utils :: formatGroupsPermissions", () => {
  it("regroupe Group -> Applications -> Permission", () => {
    const rows = [
      { GRPID: 1, GRPNAM: "Admins", GRPACTV: 1, GRPBAS: 0, APPID: 100, APPCOD: "TICKETING", PRMID: 1, PRMNAM: "ADMIN", PRMLVL: 1, ISCRIT: 1 },
    ];

    const [group] = formatGroupsPermissions(rows);
    expect(group.PERMISSIONS).toHaveLength(1);
    expect(group.PERMISSIONS[0].PERMISSION.PRMNAM).toBe("ADMIN");
  });
});

describe("modules/usersmanager/utils :: formatServices", () => {
  it("regroupe Service -> Positions", () => {
    const rows = [
      { SRVID: 10, SRVCOD: "SUP", SRVNAM: "Support", POSID: 1, POSNAM: "Technicien", POSCOD: "TECH", POSLVL: 3 },
      { SRVID: 10, SRVCOD: "SUP", SRVNAM: "Support", POSID: 2, POSNAM: "Responsable", POSCOD: "RESP", POSLVL: 1 },
    ];

    const [service] = formatServices(rows);
    expect(service.POSITIONS).toHaveLength(2);
  });
});
