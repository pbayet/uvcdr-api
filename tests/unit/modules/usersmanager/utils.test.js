import { describe, it, expect } from "vitest";
import {
  formatUsers,
  formatApplications,
  formatAppVersions,
  formatGroupsPermissions,
  formatServices,
  isPreferredAsset,
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

  it("renvoie DEFIMGLNK (lien par défaut) même si IMGLNK est renseigné", () => {
    const [app] = formatApplications([
      { APPCOD: "TICKETING", IMGLNK: "https://exemple.fr/image.png" },
    ]);
    expect(app.IMGLNK).toBe("https://exemple.fr/image.png");
    expect(app.DEFIMGLNK).toBe(`${process.env.DOMAIN}/API/assets/TICKETING.jpg`);
  });

  it("DEFIMGLNK reprend l'extension réelle du fichier présent dans /assets", () => {
    // USRMAN.png existe dans le dossier assets du dépôt.
    const [app] = formatApplications([{ APPCOD: "USRMAN", IMGLNK: null }]);
    expect(app.DEFIMGLNK).toBe(`${process.env.DOMAIN}/API/assets/USRMAN.png`);
    expect(app.IMGLNK).toBe(app.DEFIMGLNK);
  });
});

describe("modules/usersmanager/utils :: isPreferredAsset", () => {
  it("garde le fichier le plus récent, quelle que soit l'extension", () => {
    const oldJpg = { file: "FSA.jpg", rank: 0, mtimeMs: 1000 };
    const newPng = { file: "FSA.png", rank: 2, mtimeMs: 2000 };
    expect(isPreferredAsset(newPng, oldJpg)).toBe(true);
    expect(isPreferredAsset(oldJpg, newPng)).toBe(false);
  });

  it("départage par l'ordre des extensions à date égale", () => {
    const jpg = { file: "FSA.jpg", rank: 0, mtimeMs: 1000 };
    const png = { file: "FSA.png", rank: 2, mtimeMs: 1000 };
    expect(isPreferredAsset(jpg, png)).toBe(true);
    expect(isPreferredAsset(png, jpg)).toBe(false);
  });

  it("accepte le premier fichier trouvé", () => {
    expect(isPreferredAsset({ file: "A.png", rank: 2, mtimeMs: 0 }, undefined)).toBe(true);
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
