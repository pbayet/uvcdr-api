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
  // Double du `Request` mssql retourné par `pool.request()` (chemin "requête
  // simple", pris par défaut par runQuery() depuis le correctif de l'incident
  // tarn "operation timed out" — cf. commentaire dans db.utils.js).
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

  it("exécute la requête avec les paramètres mappés et retourne le résultat", async () => {
    executeMock.mockResolvedValue({ recordset: [{ TCKID: 1 }] });

    const result = await runQuery({
      moduleUrl: import.meta.url,
      dbConnectionName: "ticketing",
      key: "test.query",
      query: "SELECT 1",
      ttl: false,
      inputs: { USRID: { type: "Int", value: 42 } },
    });

    expect(result.recordset).toEqual([{ TCKID: 1 }]);
    expect(executeMock).toHaveBeenCalledWith({ USRID: 42 });
    expect(inputMock).toHaveBeenCalledWith("USRID", "Int");
  });

  it("mappe une valeur undefined vers null", async () => {
    executeMock.mockResolvedValue({ recordset: [] });

    await runQuery({
      moduleUrl: import.meta.url,
      dbConnectionName: "ticketing",
      key: "test.query.null",
      query: "SELECT 1",
      ttl: false,
      inputs: { DESCR: { type: "NVarChar(2000)", value: undefined } },
    });

    expect(executeMock).toHaveBeenCalledWith({ DESCR: null });
  });

  it("lève errorIfEmpty si le recordset est vide", async () => {
    executeMock.mockResolvedValue({ recordset: [] });

    await expect(
      runQuery({
        moduleUrl: import.meta.url,
        dbConnectionName: "ticketing",
        key: "test.query.empty",
        query: "SELECT 1",
        ttl: false,
        errorIfEmpty: "DATA_NOT_FOUND",
      }),
    ).rejects.toThrow("DATA_NOT_FOUND");
  });

  it("ne lève pas si errorIfEmpty n'est pas fourni et le recordset est vide", async () => {
    executeMock.mockResolvedValue({ recordset: [] });

    await expect(
      runQuery({
        moduleUrl: import.meta.url,
        dbConnectionName: "ticketing",
        key: "test.query.empty.ok",
        query: "SELECT 1",
        ttl: false,
      }),
    ).resolves.toEqual({ recordset: [] });
  });

  it("propage une erreur de connexion introuvable (DB_NOT_FOUND)", async () => {
    getDatabases.mockReturnValue({});

    await expect(
      runQuery({
        moduleUrl: import.meta.url,
        dbConnectionName: "inconnu",
        key: "test.query.nodb",
        query: "SELECT 1",
        ttl: false,
      }),
    ).rejects.toThrow("DB_NOT_FOUND");
  });

  describe("mode par défaut (requête simple, sans PreparedStatement)", () => {
    it("utilise pool.request() quand ni key, ni ttl≠true, ni destroyImmediately ne sont fournis", async () => {
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

      // Le chemin PreparedStatement (celui qui retient une connexion dédiée
      // et a causé l'incident) ne doit pas être emprunté.
      expect(prepareMock).not.toHaveBeenCalled();
      expect(executeMock).not.toHaveBeenCalled();
    });

    it("mappe une valeur undefined vers null en mode requête simple", async () => {
      requestQueryMock.mockResolvedValue({ recordset: [] });

      await runQuery({
        moduleUrl: import.meta.url,
        dbConnectionName: "ticketing",
        query: "SELECT 1",
        inputs: { DESCR: { type: "NVarChar(2000)", value: undefined } },
      });

      expect(requestInputMock).toHaveBeenCalledWith("DESCR", "NVarChar(2000)", null);
    });

    it("lève errorIfEmpty en mode requête simple si le recordset est vide", async () => {
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

    it("repasse en mode PreparedStatement si usePreparedStatement:true est forcé, même sans key", async () => {
      executeMock.mockResolvedValue({ recordset: [{ ok: 1 }] });

      await runQuery({
        moduleUrl: import.meta.url,
        dbConnectionName: "ticketing",
        query: "SELECT 1",
        usePreparedStatement: true,
      });

      expect(prepareMock).toHaveBeenCalledTimes(1);
      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(fakeDb.request).not.toHaveBeenCalled();
    });

    it("reste en mode requête simple si usePreparedStatement:false est forcé, même avec key fourni", async () => {
      requestQueryMock.mockResolvedValue({ recordset: [{ ok: 1 }] });

      await runQuery({
        moduleUrl: import.meta.url,
        dbConnectionName: "ticketing",
        key: "test.query.forced-simple",
        ttl: false,
        query: "SELECT 1",
        usePreparedStatement: false,
      });

      expect(fakeDb.request).toHaveBeenCalledTimes(1);
      expect(prepareMock).not.toHaveBeenCalled();
      expect(executeMock).not.toHaveBeenCalled();
    });
  });
});

describe("core/utils/db.utils :: closePreparedStatement / closeAllPreparedStatements", () => {
  it("retourne false pour une clé de cache inexistante", async () => {
    await expect(closePreparedStatement("clé-jamais-utilisée")).resolves.toBe(false);
  });

  it("closeAllPreparedStatements ne lève pas si le cache est vide", async () => {
    await expect(closeAllPreparedStatements()).resolves.toBeUndefined();
  });
});
