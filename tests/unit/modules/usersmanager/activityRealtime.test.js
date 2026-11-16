import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../../config/websocket/wsManager.js", () => ({
  broadcastToAll: vi.fn(),
}));

const { broadcastToAll } = await import("../../../../config/websocket/wsManager.js");
const {
  notifyActivityLogged,
  _resetActivityRealtime,
  ACTIVITY_CREATED_EVENT,
  THROTTLE_MS,
} = await import("../../../../modules/usersmanager/activityRealtime.js");

describe("modules/usersmanager/activityRealtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    broadcastToAll.mockReset();
    _resetActivityRealtime();
  });
  afterEach(() => {
    _resetActivityRealtime();
    vi.useRealTimers();
  });

  it("diffuse immédiatement la première ligne ajoutée", () => {
    notifyActivityLogged("LOGINDEV");
    expect(broadcastToAll).toHaveBeenCalledWith({
      type: ACTIVITY_CREATED_EVENT,
      payload: { SOURCES: ["LOGINDEV"] },
    });
  });

  it("regroupe les lignes suivantes dans la fenêtre de THROTTLE_MS", () => {
    notifyActivityLogged("ACTIVITY");
    notifyActivityLogged("ACTIVITY");
    notifyActivityLogged("LOGIN");
    expect(broadcastToAll).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(THROTTLE_MS);
    expect(broadcastToAll).toHaveBeenCalledTimes(2);
    expect(broadcastToAll.mock.calls[1][0].payload.SOURCES).toEqual(["ACTIVITY", "LOGIN"]);
  });

  it("ignore une source vide et ne lève jamais si la diffusion échoue", () => {
    notifyActivityLogged(undefined);
    expect(broadcastToAll).not.toHaveBeenCalled();

    broadcastToAll.mockImplementationOnce(() => {
      throw new Error("WS indisponible");
    });
    expect(() => notifyActivityLogged("ACTIVITY")).not.toThrow();
  });
});
