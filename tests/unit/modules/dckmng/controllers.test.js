import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../../modules/dckmng/services.js");
vi.mock("../../../../modules/dckmng/realtime.js", () => ({
  publish: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn(),
}));

const services = await import("../../../../modules/dckmng/services.js");
const realtime = await import("../../../../modules/dckmng/realtime.js");
const controllers = await import("../../../../modules/dckmng/controllers.js");
const v = await import("../../../../modules/dckmng/validators.js");

const LOAD = {
  LODID: 7,
  LODDAT: "2026-11-17",
  LODHOU: "08:04",
  NOM: "LIDL",
  QUAI: "4",
  QUAEFF: null,
  OPEDEB: null,
  OPEFIN: null,
  STSCOD: "ATTENTE",
  STSNAME: "ATTENTE DE CHARGEMENT",
  STSLVL: 1,
};

const req = ({ application = "DCKMNG", params = {}, body = {} } = {}) => ({
  method: "PUT",
  params,
  query: {},
  body,
  ip: "::ffff:10.0.0.12",
  headers: {},
  payload: { application, data: { id: "42" } },
});

beforeEach(() => {
  vi.clearAllMocks();
  services.getLoad.mockResolvedValue(LOAD);
});

describe("dckmng validators", () => {
  it("met les opérateurs en majuscules et vide les chaînes blanches", () => {
    expect(v.publicLoadUpdate.parse({ LODID: "3", OPEDEB: " jm ", OPEFIN: "  " })).toEqual({
      LODID: 3,
      OPEDEB: "JM",
      OPEFIN: null,
    });
  });

  it("refuse une saisie cariste sans champ", () => {
    expect(v.publicLoadUpdate.safeParse({ LODID: 3 }).success).toBe(false);
  });

  it("refuse un nom vide côté admin", () => {
    expect(v.loadUpdate.safeParse({ LODID: 1, NOM: " " }).success).toBe(false);
  });

  it("remet une plage de statistiques dans l'ordre et la borne à 366 jours", () => {
    expect(v.statsQuery.parse({ FROM: "2026-11-20", TO: "2026-11-01" })).toEqual({
      FROM: "2026-11-01",
      TO: "2026-11-20",
    });
    expect(v.statsQuery.safeParse({ FROM: "2024-01-01", TO: "2026-01-01" }).success).toBe(false);
  });

  it("refuse une date impossible", () => {
    expect(v.loadsQuery.safeParse({ LODDAT: "2026-02-31" }).success).toBe(false);
  });
});

describe("dckmng controllers — espace cariste", () => {
  it("ne transmet que les champs cariste, limité au jour, avec l'IP", async () => {
    services.updateLoad.mockResolvedValue("UPDATED");

    await controllers.updatePublicLoad(
      req({ params: { LODID: "7" }, body: { QUAEFF: "4", NOM: "piratage" } }),
    );

    expect(services.updateLoad).toHaveBeenCalledWith(
      7,
      { QUAEFF: "4" },
      { SOURCE: "CARISTE", USRID: null, IPADDR: "10.0.0.12" },
      { onlyToday: true },
    );
    expect(realtime.publish).toHaveBeenCalledWith("2026-11-17");
  });

  it("refuse un chargement d'un autre jour", async () => {
    services.updateLoad.mockResolvedValue("LOCKED");
    await expect(
      controllers.updatePublicLoad(req({ params: { LODID: "7" }, body: { OPEDEB: "jm" } })),
    ).rejects.toThrow("DCKMNG_LOAD_LOCKED");
    expect(realtime.publish).not.toHaveBeenCalled();
  });
});

describe("dckmng controllers — espace admin", () => {
  it("refuse un jeton d'une autre application (ex. portail HOME)", async () => {
    await expect(controllers.getLoads(req({ application: "HOME" }))).rejects.toThrow(
      "ACCESS_DENIED_WO_LOGOUT",
    );
  });

  it("crée un chargement au nom de l'utilisateur connecté", async () => {
    services.createLoad.mockResolvedValue(7);

    const load = await controllers.createLoad(req({ body: { NOM: " LIDL ", QUAI: "4" } }));

    expect(services.createLoad).toHaveBeenCalledWith(
      { NOM: "LIDL", QUAI: "4" },
      { SOURCE: "ADMIN", USRID: 42, IPADDR: "10.0.0.12" },
    );
    expect(load).toMatchObject({ LODID: 7, QUAEFF: "", STSCOD: "ATTENTE" });
  });

  it("complète les jours sans chargement dans les statistiques", async () => {
    services.getStats.mockResolvedValue({
      range: { FROM: "2026-11-15", TO: "2026-11-17" },
      totalsAll: { TOTALALL: 10, TOTALDONE: 8 },
      totals: { TOTAL: 2, DONE: 1, INPROGRESS: 1, WAITING: 0, AVGWAITMIN: 12.345, AVGLOADMIN: null },
      byDay: [{ DATE: "2026-11-16", TOTAL: 2, DONE: 1, INPROGRESS: 1, WAITING: 0 }],
      byQuai: [],
      byHour: [],
      byOperator: [],
    });

    const stats = await controllers.getStats(req());

    expect(stats.BYDAY.map((d) => [d.DATE, d.TOTAL])).toEqual([
      ["2026-11-15", 0],
      ["2026-11-16", 2],
      ["2026-11-17", 0],
    ]);
    expect(stats.AVGWAITMIN).toBe(12.3);
  });

  it("renvoie les jours ayant des chargements", async () => {
    services.getLoadDays.mockResolvedValue(["2026-11-16", "2026-11-17"]);

    await expect(controllers.getLoadDays(req())).resolves.toEqual(["2026-11-16", "2026-11-17"]);
  });
});
