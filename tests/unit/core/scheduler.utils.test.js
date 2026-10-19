import { describe, it, expect, vi, afterEach } from "vitest";
import { scheduleDailyTask } from "../../../core/utils/scheduler.utils.js";

describe("core/utils/scheduler.utils :: scheduleDailyTask", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lève une erreur si le premier paramètre n'est pas une fonction", () => {
    expect(() => scheduleDailyTask(null)).toThrow(/doit être une fonction/);
  });

  it("exécute la tâche en mode 'test' (delta en secondes) à l'échéance prévue", async () => {
    // Mardi 07/07/2026 10:00:00 (jour ouvré) — évite toute ambiguïté week-end.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T10:00:00Z"));

    const task = vi.fn();
    const stop = scheduleDailyTask(task, 0, 0, 30); // toutes les 30s en mode test

    await vi.advanceTimersByTimeAsync(30_000);
    expect(task).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(task).toHaveBeenCalledTimes(2);

    stop();
  });

  it("stop() empêche toute exécution ultérieure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T10:00:00Z"));

    const task = vi.fn();
    const stop = scheduleDailyTask(task, 0, 0, 10);
    stop();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(task).not.toHaveBeenCalled();
  });

  it("attend qu'une tâche en cours se termine avant de planifier la suivante", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T10:00:00Z"));

    let resolveTask;
    const task = vi.fn(() => new Promise((resolve) => (resolveTask = resolve)));

    const stop = scheduleDailyTask(task, 0, 0, 5);

    await vi.advanceTimersByTimeAsync(5_000); // 1er déclenchement, reste "pending"
    expect(task).toHaveBeenCalledTimes(1);

    // Tant que la promesse n'est pas résolue, scheduleNext() n'a pas encore
    // été rappelé : aucune nouvelle échéance n'est en attente.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task).toHaveBeenCalledTimes(1);

    resolveTask();
    await vi.advanceTimersByTimeAsync(0); // laisse le .finally()/scheduleNext() s'exécuter
    await vi.advanceTimersByTimeAsync(5_000);
    expect(task).toHaveBeenCalledTimes(2);

    stop();
  });

  it("mode normal (delta=0) planifie à l'heure/minute fixe suivante", async () => {
    vi.useFakeTimers();
    // Mardi 07/07/2026 02:00:00 (avant 03:05, jour ouvré)
    vi.setSystemTime(new Date("2026-07-07T02:00:00"));

    const task = vi.fn();
    const stop = scheduleDailyTask(task, 3, 5, 0);

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000); // 02:59 → pas encore déclenché
    expect(task).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // 03:09 → déclenché
    expect(task).toHaveBeenCalledTimes(1);

    stop();
  });
});
