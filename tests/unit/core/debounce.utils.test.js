import { describe, it, expect, vi, afterEach } from "vitest";
import { debounceCollect, flushAllDebounced } from "../../../core/utils/debounce.utils.js";

describe("core/utils/debounce.utils :: debounceCollect", () => {
  afterEach(async () => {
    // Sécurité : évite qu'un lot oublié (test qui plante avant d'avancer les
    // timers) fuite sur le test suivant.
    await flushAllDebounced();
    vi.useRealTimers();
  });

  it("attend la période de silence avant d'appeler onFlush", async () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();

    debounceCollect("k1", "a", { delayMs: 1000, onFlush });

    await vi.advanceTimersByTimeAsync(999);
    expect(onFlush).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(["a"]);
  });

  it("réarme le délai à chaque nouvel élément et regroupe tout en un seul appel", async () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();

    debounceCollect("k2", "a", { delayMs: 1000, onFlush });
    await vi.advanceTimersByTimeAsync(600);
    debounceCollect("k2", "b", { delayMs: 1000, onFlush });
    await vi.advanceTimersByTimeAsync(600);
    debounceCollect("k2", "c", { delayMs: 1000, onFlush });

    // 600 + 600 = 1200ms > 1000ms de silence requis, mais le silence a été
    // interrompu à chaque fois : toujours rien.
    expect(onFlush).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(["a", "b", "c"]);
  });

  it("plafonne l'attente à maxWaitMs même si des éléments continuent d'arriver", async () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();

    debounceCollect("k3", "a", { delayMs: 1000, maxWaitMs: 2500, onFlush });

    // Un nouvel élément toutes les 900ms : le silence de 1000ms n'est jamais
    // atteint, mais le plafond de 2500ms depuis le 1er élément doit forcer le flush.
    await vi.advanceTimersByTimeAsync(900);
    debounceCollect("k3", "b", { delayMs: 1000, maxWaitMs: 2500, onFlush });
    await vi.advanceTimersByTimeAsync(900);
    debounceCollect("k3", "c", { delayMs: 1000, maxWaitMs: 2500, onFlush });

    await vi.advanceTimersByTimeAsync(700); // total 2500ms depuis le 1er élément
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(["a", "b", "c"]);
  });

  it("isole les lots par clé", async () => {
    vi.useFakeTimers();
    const onFlushA = vi.fn();
    const onFlushB = vi.fn();

    debounceCollect("ticket-a", 1, { delayMs: 500, onFlush: onFlushA });
    debounceCollect("ticket-b", 2, { delayMs: 500, onFlush: onFlushB });

    await vi.advanceTimersByTimeAsync(500);

    expect(onFlushA).toHaveBeenCalledWith([1]);
    expect(onFlushB).toHaveBeenCalledWith([2]);
  });

  it("logue mais ne rejette pas si onFlush lève une erreur", async () => {
    vi.useFakeTimers();
    const onFlush = vi.fn(() => {
      throw new Error("boom");
    });

    debounceCollect("k4", "a", { delayMs: 100, onFlush });
    await expect(vi.advanceTimersByTimeAsync(100)).resolves.not.toThrow();
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("flushAllDebounced traite immédiatement tous les lots en attente", async () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();

    debounceCollect("k5", "a", { delayMs: 60_000, onFlush });
    debounceCollect("k6", "b", { delayMs: 60_000, onFlush });

    await flushAllDebounced();

    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenCalledWith(["a"]);
    expect(onFlush).toHaveBeenCalledWith(["b"]);
  });
});
