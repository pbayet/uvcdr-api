import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

vi.mock("../../../core/utils/db.utils.js", () => ({ runQuery: vi.fn() }));
vi.mock("../../../core/utils/scheduler.utils.js", () => ({
  scheduleDailyTask: vi.fn(() => () => {}),
}));

const { runQuery } = await import("../../../core/utils/db.utils.js");
const { purgeDbLogs, purgeLogFiles } = await import(
  "../../../core/services/logsPurge.service.js"
);
const { getLogsRetentionDays } = await import(
  "../../../core/config/logsRetention.config.js"
);

describe("core/config/logsRetention.config :: getLogsRetentionDays", () => {
  it("365 j en production, 60 j sinon", () => {
    expect(getLogsRetentionDays({ NODE_ENV: "production" })).toBe(365);
    expect(getLogsRetentionDays({ NODE_ENV: "development" })).toBe(60);
  });

  it("LOGS_RETENTION_DAYS surcharge si entier > 0", () => {
    expect(getLogsRetentionDays({ NODE_ENV: "production", LOGS_RETENTION_DAYS: "30" })).toBe(30);
    expect(getLogsRetentionDays({ NODE_ENV: "production", LOGS_RETENTION_DAYS: "abc" })).toBe(365);
  });
});

describe("core/services/logsPurge :: purgeDbLogs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("supprime par lots jusqu'à un lot incomplet, sur les deux tables", async () => {
    runQuery.mockResolvedValue({ rowsAffected: [0] });
    runQuery
      .mockResolvedValueOnce({ rowsAffected: [2] })
      .mockResolvedValueOnce({ rowsAffected: [1] });

    const stats = await purgeDbLogs({ retentionDays: 60, batchSize: 2, dryRun: false });

    expect(stats).toEqual({ USERSACTIVITY: 3, LOGINHISTORY: 0 });
    const calls = runQuery.mock.calls.map(([a]) => a);
    expect(calls[0].dbConnectionName).toBe("generalactivity");
    expect(calls[0].query).toMatch(/DELETE TOP \(@BATCH\) FROM \[dbo\]\.\[USERSACTIVITY\] WHERE CREDAT </);
    expect(calls[0].inputs.DAYS.value).toBe(60);
    expect(calls[2].dbConnectionName).toBe("usersmanager");
    expect(calls[2].query).toMatch(/LOGINHISTORY\] WHERE LOGIN_DATE </);
  });

  it("dry-run : compte sans supprimer", async () => {
    runQuery.mockResolvedValue({ recordset: [{ CNT: 7 }] });

    const stats = await purgeDbLogs({ retentionDays: 365, dryRun: true });

    expect(stats).toEqual({ USERSACTIVITY: 7, LOGINHISTORY: 7 });
    for (const [a] of runQuery.mock.calls) expect(a.query).not.toMatch(/DELETE/);
  });

  it("une table en erreur n'empêche pas la purge de l'autre", async () => {
    runQuery
      .mockRejectedValueOnce(new Error("DB_NOT_FOUND"))
      .mockResolvedValueOnce({ rowsAffected: [4] });

    const stats = await purgeDbLogs({ retentionDays: 60, batchSize: 10, dryRun: false });

    expect(stats).toEqual({ USERSACTIVITY: null, LOGINHISTORY: 4 });
  });
});

describe("core/services/logsPurge :: purgeLogFiles", () => {
  let root;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "logs-purge-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function createFile(rel, ageDays) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "x");
    const t = new Date(Date.now() - ageDays * 86400000);
    await fs.utimes(abs, t, t);
    return abs;
  }

  it("supprime récursivement les fichiers plus vieux que la rétention", async () => {
    const old = await createFile("errors/errors_2025-01-01.log", 61);
    const recent = await createFile("success/output_2026-11-10.log", 10);

    const stats = await purgeLogFiles({ logDir: root, retentionDays: 60, dryRun: false });

    expect(stats.removed).toBe(1);
    await expect(fs.access(old)).rejects.toThrow();
    await expect(fs.access(recent)).resolves.toBeUndefined();
  });

  it("dry-run : ne supprime rien", async () => {
    const old = await createFile("errors/old.log", 400);

    const stats = await purgeLogFiles({ logDir: root, retentionDays: 365, dryRun: true });

    expect(stats.removed).toBe(1);
    await expect(fs.access(old)).resolves.toBeUndefined();
  });

  it("dossier absent : aucune erreur", async () => {
    const stats = await purgeLogFiles({ logDir: path.join(root, "nope"), retentionDays: 60 });
    expect(stats.removed).toBe(0);
  });
});
