import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

vi.mock("../../../../modules/files/services.js", () => ({
  getAttachmentsToPurge: vi.fn(),
  markPurgedAttachment: vi.fn(),
}));
vi.mock("../../../../core/utils/scheduler.utils.js", () => ({
  scheduleDailyTask: vi.fn(() => () => {}),
}));

const services = await import("../../../../modules/files/services.js");
const { scheduleDailyTask } = await import("../../../../core/utils/scheduler.utils.js");
const { purgeDeletedAttachments, startDeletedAttachmentsPurgeCron } = await import(
  "../../../../modules/files/config/module.config.js"
);

describe("modules/files/config — purgeDeletedAttachments", () => {
  let root;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "files-purge-"));
    services.markPurgedAttachment.mockResolvedValue(true);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function createFile(relativePath) {
    const abs = path.join(root, relativePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "x");
    return abs;
  }

  it("supprime le fichier physique et marque la ligne PURGED", async () => {
    const abs = await createFile("APP/2026/01/01/AB/AB1.pdf");
    services.getAttachmentsToPurge.mockResolvedValueOnce([
      { ID: 1, FILECODE: "AB1", RELATIVEPATH: "APP/2026/01/01/AB/AB1.pdf", SIZEBYTES: 1 },
    ]);

    const stats = await purgeDeletedAttachments({ rootDir: root, retentionMonths: 3 });

    await expect(fs.access(abs)).rejects.toThrow();
    expect(services.markPurgedAttachment).toHaveBeenCalledWith(1);
    expect(stats).toMatchObject({ purged: 1, missing: 0, failed: 0 });
    expect(services.getAttachmentsToPurge).toHaveBeenCalledWith(expect.objectContaining({ retentionMonths: 3 }));
  });

  it("marque PURGED un fichier déjà absent (ENOENT)", async () => {
    services.getAttachmentsToPurge.mockResolvedValueOnce([{ ID: 2, FILECODE: "X", RELATIVEPATH: "APP/absent.pdf" }]);

    const stats = await purgeDeletedAttachments({ rootDir: root });

    expect(stats.missing).toBe(1);
    expect(services.markPurgedAttachment).toHaveBeenCalledWith(2);
  });

  it("refuse un RELATIVEPATH sortant du répertoire de stockage", async () => {
    services.getAttachmentsToPurge.mockResolvedValueOnce([{ ID: 3, FILECODE: "Y", RELATIVEPATH: "../../etc/passwd" }]);

    const stats = await purgeDeletedAttachments({ rootDir: root });

    expect(stats.failed).toBe(1);
    expect(services.markPurgedAttachment).not.toHaveBeenCalled();
  });

  it("dry-run : ne supprime rien et ne met pas à jour la base", async () => {
    const abs = await createFile("APP/keep.pdf");
    services.getAttachmentsToPurge.mockResolvedValueOnce([{ ID: 4, FILECODE: "Z", RELATIVEPATH: "APP/keep.pdf" }]);

    await purgeDeletedAttachments({ rootDir: root, dryRun: true });

    await expect(fs.access(abs)).resolves.toBeUndefined();
    expect(services.markPurgedAttachment).not.toHaveBeenCalled();
  });

  it("pagine par ID jusqu'à épuisement des lignes", async () => {
    services.getAttachmentsToPurge
      .mockResolvedValueOnce([
        { ID: 10, FILECODE: "A", RELATIVEPATH: "APP/a" },
        { ID: 11, FILECODE: "B", RELATIVEPATH: "APP/b" },
      ])
      .mockResolvedValueOnce([{ ID: 12, FILECODE: "C", RELATIVEPATH: "APP/c" }]);

    await purgeDeletedAttachments({ rootDir: root, batchSize: 2 });

    expect(services.getAttachmentsToPurge).toHaveBeenCalledTimes(2);
    expect(services.getAttachmentsToPurge.mock.calls[1][0].afterId).toBe(11);
  });

  it("n'exécute rien sans UPLOAD_PATH", async () => {
    await purgeDeletedAttachments({ rootDir: "" });
    expect(services.getAttachmentsToPurge).not.toHaveBeenCalled();
  });

  it("startDeletedAttachmentsPurgeCron planifie la tâche à 3h20", () => {
    startDeletedAttachmentsPurgeCron();
    expect(scheduleDailyTask).toHaveBeenCalledWith(expect.any(Function), 3, 20);
  });
});
