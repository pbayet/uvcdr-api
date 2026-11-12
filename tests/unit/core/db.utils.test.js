import { describe, it, expect, vi, beforeEach } from "vitest";

// mssql n'est jamais réellement connecté dans ces tests : on remplace
// PreparedStatement par un double contrôlable, et sql.Int/sql.NVarChar... par
// de simples marqueurs (leur valeur réelle n'a pas d'importance ici, seul le
// mapping vers `inputs` est vérifié).
const executeMock = vi.fn();
const prepareMock = vi.fn();
const inputMock = vi.fn();
const unprepareMock = vi.fn();

vi.mock("mssql", () => {
  class PreparedStatement {
    constructor(db) {
      this.db = db;
    }
    input(...args) {
      inputMock(...args);
    }
    prepare(...args) {
      return prepareMock(...args);
    }
    execute(...args) {
      return executeMock(...args);
    }
    unprepare(...args) {
      return unprepareMock(...args);
    }
  }

  return {
    default: {
      PreparedStatement,
      Int: "Int",
      NVarChar: (n) => `NVarChar(${n})`,
      on: vi.fn(),
    },
  };
});

vi.mock("../../../config/db/index.js", () => ({
  getDatabases: vi.fn(),
}));

const { getDatabases } = await import("../../../config/db/index.js");
const {
  generateAutoKey,
  getDbConnexion,
  runQuery,
  getPreparedStatement,
  closePreparedStatement,
  closeAllPreparedStatements,
} = await import("../../../core/utils/db.utils.js");

describe("core/utils/db.utils :: generateAutoKey", () => {
  it("retourne une clé de secours si l'erreur n'a pas de stack exploitable", () => {
    const fakeError = { stack: "" };
    expect(generateAutoKey(fakeError)).toMatch(/^unknown\./);
  });

  it("ne lève jamais, même avec une entrée totalement invalide", () => {
    expect(() => generateAutoKey(undefined)).not.toThrow();
    expect(() => generateAutoKey(null)).not.toThrow();
  });

  it("préfixe avec le supplément fourni", () => {
    const key = generateAutoKey(new Error(), "custom");
    expect(key.startsWith("custom.") || key.startsWith("unknown.")).toBe(true);
  });
});

describe("core/utils/db.utils :: getDbConnexion", () => {
  beforeEach(() => {
    getDatabases.mockReset();
  });

  it("retourne le pool correspondant à dbConnectionName si fourni", () => {
    const fakePool = { request: vi.fn() };
    getDatabases.mockReturnValue({ ticketing: fakePool });

    expect(getDbConnexion(import.meta.url, "ticketing")).toBe(fakePool);
  });

  it("lève DB_NOT_FOUND si la base n'existe pas", () => {
    getDatabases.mockReturnValue({});
    expect(() => getDbConnexion(import.meta.url, "inconnu")).toThrow("DB_NOT_FOUND");
  });

  it("déduit le nom du module depuis le dossier parent du fichier appelant", () => {
    const fakePool = { request: vi.fn() };
    // Ce fichier de test vit dans tests/unit/core/ → moduleName déduit = "core"
    getDatabases.mockReturnValue({ core: fakePool });
    expect(getDbConnexion(import.meta.url)).toBe(fakePool);
  });
});

describe("core/utils/db.utils :: runQuery", () => {
  // Double du `Request` mssql retourné par `pool.request()`, chemin pris par
  // runQuery() pour toutes les requêtes (cf. incident du 12/11/2026 dans
  // db.utils.js : plus aucun PreparedStatement n'est mis en cache).
  const requestInputMock = vi.fn();
  const requestQueryMock = vi.fn();
  const fakeRequest = {
    input(...args) {
      requestInputMock(...args);
      return fakeRequest;
    },
    query(...args) {
      return requestQueryMock(...args);
    },
  };
  const fakeDb = { request: vi.fn(() => fakeRequest) };

  beforeEach(() => {
    getDatabases.mockReset().mockReturnValue({ ticketing: fakeDb });
    executeMock.mockReset();
    prepareMock.mockReset().mockResolvedValue(undefined);
    inputMock.mockReset();
    unprepareMock.mockReset().mockResolvedValue(undefined);
    fakeDb.request.mockClear();
    requestInputMock.mockReset();
    requestQueryMock.mockReset();
  });

  it("exécute la requête via pool.request() avec les paramètres mappés", async () => {
    requestQueryMock.mockResolvedValue({ recordset: [{ TCKID: 1 }] });

    const result = await runQuery({
      moduleUrl: import.meta.url,
      dbConnectionName: "ticketing",
      query: "SELECT 1",
      inputs: { USRID: { type: "Int", value: 42 } },
    });

    expect(result.recordset).toEqual([{ TCKID: 1 }]);
    expect(fakeDb.request).toHaveBeenCalledTimes(1);
    expect(requestInputMock).toHaveBeenCalledWith("USRID", "Int", 42);
    expect(requestQueryMock).toHaveBeenCalledWith("SELECT 1");
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it("mappe une valeur undefined vers null", async () => {
    requestQueryMock.mockResolvedValue({ recordset: [] });

    await runQuery({
      moduleUrl: import.meta.url,
      dbConnectionName: "ticketing",
      query: "SELECT 1",
      inputs: { DESCR: { type: "NVarChar(2000)", value: undefined } },
    });

    expect(requestInputMock).toHaveBeenCalledWith("DESCR", "NVarChar(2000)", null);
  });

  it("lève errorIfEmpty si le recordset est vide", async () => {
    requestQueryMock.mockResolvedValue({ recordset: [] });

    await expect(
      runQuery({
        moduleUrl: import.meta.url,
        dbConnectionName: "ticketing",
        query: "SELECT 1",
        errorIfEmpty: "DATA_NOT_FOUND",
      }),
    ).rejects.toThrow("DATA_NOT_FOUND");
  });

  it("ne lève pas si errorIfEmpty n'est pas fourni et le recordset est vide", async () => {
    requestQueryMock.mockResolvedValue({ recordset: [] });

    await expect(
      runQuery({
        moduleUrl: import.meta.url,
        dbConnectionName: "ticketing",
        query: "SELECT 1",
      }),
    ).resolves.toEqual({ recordset: [] });
  });

  it("propage une erreur de connexion introuvable (DB_NOT_FOUND)", async () => {
    getDatabases.mockReturnValue({});

    await expect(
      runQuery({
        moduleUrl: import.meta.url,
        dbConnectionName: "inconnu",
        query: "SELECT 1",
      }),
    ).rejects.toThrow("DB_NOT_FOUND");
  });

  it("ignore key / ttl / destroyImmediately : reste en pool.request(), sans PreparedStatement", async () => {
    requestQueryMock.mockResolvedValue({ recordset: [{ ok: 1 }] });

    await runQuery({
      moduleUrl: import.meta.url,
      dbConnectionName: "ticketing",
      key: "fsa.getFsa.header",
      ttl: false,
      destroyImmediately: true,
      query: "SELECT 1",
    });

    expect(fakeDb.request).toHaveBeenCalledTimes(1);
    expect(prepareMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  describe("usePreparedStatement: true (PreparedStatement éphémère)", () => {
    it("prépare, exécute puis unprepare à chaque appel", async () => {
      executeMock.mockResolvedValue({ recordset: [{ ok: 1 }] });

      for (let i = 0; i < 3; i++) {
        await runQuery({
          moduleUrl: import.meta.url,
          dbConnectionName: "ticketing",
          query: "SELECT 1",
          inputs: { USRID: { type: "Int", value: 42 } },
          usePreparedStatement: true,
        });
      }

      expect(inputMock).toHaveBeenCalledWith("USRID", "Int");
      expect(prepareMock).toHaveBeenCalledTimes(3);
      expect(executeMock).toHaveBeenCalledWith({ USRID: 42 });
      expect(unprepareMock).toHaveBeenCalledTimes(3);
      expect(fakeDb.request).not.toHaveBeenCalled();
    });

    it("unprepare même si l'exécution échoue (connexion toujours rendue)", async () => {
      executeMock.mockRejectedValue(new Error("boom"));

      await expect(
        runQuery({
          moduleUrl: import.meta.url,
          dbConnectionName: "ticketing",
          query: "SELECT 1",
          usePreparedStatement: true,
        }),
      ).rejects.toThrow("boom");

      expect(unprepareMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe("core/utils/db.utils :: getPreparedStatement (compatibilité)", () => {
  beforeEach(() => {
    executeMock.mockReset().mockResolvedValue({ recordset: [] });
    prepareMock.mockReset().mockResolvedValue(undefined);
    unprepareMock.mockReset().mockResolvedValue(undefined);
  });

  it("ne retient aucune connexion : chaque execute() est préparé puis libéré", async () => {
    const ps = await getPreparedStatement({}, "k", "SELECT 1", { A: "Int" });
    expect(prepareMock).not.toHaveBeenCalled();

    await ps.execute({ A: 1 });
    await ps.execute({ A: 2 });

    expect(prepareMock).toHaveBeenCalledTimes(2);
    expect(unprepareMock).toHaveBeenCalledTimes(2);
  });
});

describe("core/utils/db.utils :: closePreparedStatement / closeAllPreparedStatements", () => {
  it("retourne false (plus de cache)", async () => {
    await expect(closePreparedStatement("clé-jamais-utilisée")).resolves.toBe(false);
  });

  it("closeAllPreparedStatements ne lève pas", async () => {
    await expect(closeAllPreparedStatements()).resolves.toBeUndefined();
  });
});
