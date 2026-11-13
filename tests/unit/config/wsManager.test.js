import { describe, it, expect, beforeEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import {
  appsForEvent,
  authenticate,
  register,
  unregister,
  _resetClients,
  broadcastToAll,
  broadcastToApps,
  broadcastToCaves,
  broadcastToUsers,
} from "../../../config/websocket/wsManager.js";

/** Faux socket : seul readyState/send sont utilisés par le diffuseur. */
const fakeSocket = () => ({ readyState: 1, send: vi.fn() });

/** Connexion enregistrée comme le ferait initWebSocket. */
const connect = ({ USRID, app, isCave = false }) => {
  const ws = fakeSocket();
  register(ws, { key: isCave ? `cave:${USRID}` : String(USRID), USRID, isCave, app });
  return ws;
};

const sign = (payload) =>
  jwt.sign({ permissionLevel: 4, ...payload }, process.env.JWT_SECRET);

describe("config/websocket/wsManager", () => {
  beforeEach(() => _resetClients());

  describe("appsForEvent", () => {
    it("route chaque domaine d'évènements vers son application", () => {
      expect(appsForEvent("faq.post.updated")).toEqual(["FAQ"]);
      expect(appsForEvent("ticket.note.created")).toEqual(["TCK"]);
      expect(appsForEvent("project.users.updated")).toEqual(["TCK"]);
      expect(appsForEvent("vinidoc.sheet.locked")).toEqual(["VINDOC"]);
      expect(appsForEvent("fsa.folder.updated")).toEqual(["FSA"]);
    });

    it("ne route pas un préfixe inconnu", () => {
      expect(appsForEvent("autre.chose")).toBeNull();
      expect(appsForEvent(undefined)).toBeNull();
    });
  });

  describe("authenticate", () => {
    it("lit l'utilisateur, l'application et le statut cave du jeton", () => {
      const token = sign({ application: "faq", isCave: false, data: { id: 12 } });
      expect(authenticate(`/ws?token=${token}`)).toEqual({ USRID: 12, isCave: false, app: "FAQ" });
    });

    it("reconnaît un jeton de cave", () => {
      const token = sign({ application: "DCLING", isCave: true, data: { id: 3 } });
      expect(authenticate(`/ws?token=${token}`)).toEqual({ USRID: 3, isCave: true, app: "DCLING" });
    });

    it("refuse un jeton absent, invalide, sans identifiant ou sans permission", () => {
      expect(() => authenticate("/ws")).toThrow();
      expect(() => authenticate("/ws?token=abc")).toThrow();
      expect(() => authenticate(`/ws?token=${sign({ data: {} })}`)).toThrow();
      expect(() =>
        authenticate(`/ws?token=${sign({ permissionLevel: -1, data: { id: 1 } })}`),
      ).toThrow("ACCESS_DENIED");
    });
  });

  describe("broadcastToAll", () => {
    it("n'envoie un évènement qu'aux connexions de son application", () => {
      const faq = connect({ USRID: 1, app: "FAQ" });
      const tck = connect({ USRID: 1, app: "TCK" });
      const um = connect({ USRID: 2, app: "USRMAN" });

      broadcastToAll({ type: "ticket.created", payload: { TCKCOD: "T1" } });

      expect(tck.send).toHaveBeenCalledOnce();
      expect(faq.send).not.toHaveBeenCalled();
      expect(um.send).not.toHaveBeenCalled();
    });

    it("diffuse un préfixe non routé à toutes les applications internes, pas aux caves", () => {
      const faq = connect({ USRID: 1, app: "FAQ" });
      const fsa = connect({ USRID: 2, app: "FSA" });
      const cave = connect({ USRID: 1, app: "DCLING", isCave: true });

      broadcastToAll({ type: "info", payload: {} });

      expect(faq.send).toHaveBeenCalledOnce();
      expect(fsa.send).toHaveBeenCalledOnce();
      expect(cave.send).not.toHaveBeenCalled();
    });

    it("garde l'ancien comportement pour un jeton sans application", () => {
      const legacy = connect({ USRID: 1, app: "" });
      broadcastToAll({ type: "vinidoc.sheet.updated", payload: {} });
      expect(legacy.send).toHaveBeenCalledOnce();
    });

    it("ignore les connexions fermées", () => {
      const ws = connect({ USRID: 1, app: "FAQ" });
      ws.readyState = 3;
      broadcastToAll({ type: "faq.post.created", payload: {} });
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  describe("broadcastToUsers", () => {
    it("ne touche jamais une cave dont l'ID égale le USRID visé", () => {
      const user = connect({ USRID: 7, app: "FAQ" });
      const cave = connect({ USRID: 7, app: "DCLING", isCave: true });

      broadcastToUsers([7], { type: "faq.post.mypin", payload: { PSTID: 1 } });

      expect(user.send).toHaveBeenCalledOnce();
      expect(cave.send).not.toHaveBeenCalled();
    });

    it("respecte le routage par application", () => {
      const faq = connect({ USRID: 7, app: "FAQ" });
      const tck = connect({ USRID: 7, app: "TCK" });

      broadcastToUsers(["7"], { type: "faq.post.mypin", payload: {} });

      expect(faq.send).toHaveBeenCalledOnce();
      expect(tck.send).not.toHaveBeenCalled();
    });
  });

  describe("broadcastToApps", () => {
    it("vise explicitement une ou plusieurs applications, caves comprises pour DCLING", () => {
      const cave = connect({ USRID: 3, app: "DCLING", isCave: true });
      const admin = connect({ USRID: 3, app: "DCLING" });
      const faq = connect({ USRID: 4, app: "FAQ" });

      broadcastToApps("dcling", { type: "declcav.audit.updated", payload: {} });

      expect(cave.send).toHaveBeenCalledOnce();
      expect(admin.send).toHaveBeenCalledOnce();
      expect(faq.send).not.toHaveBeenCalled();
    });
  });

  describe("declcav / usersmanager", () => {
    it("route declcav.* vers les admins DCLING, jamais vers les caves", () => {
      const admin = connect({ USRID: 3, app: "DCLING" });
      const cave = connect({ USRID: 3, app: "DCLING", isCave: true });
      const um = connect({ USRID: 5, app: "USRMAN" });

      broadcastToAll({ type: "declcav.folder.updated", payload: { ID: 1 } });

      expect(admin.send).toHaveBeenCalledOnce();
      expect(cave.send).not.toHaveBeenCalled();
      expect(um.send).not.toHaveBeenCalled();
    });

    it("route usersmanager.* vers USRMAN", () => {
      const um = connect({ USRID: 5, app: "USRMAN" });
      const faq = connect({ USRID: 5, app: "FAQ" });
      broadcastToAll({ type: "usersmanager.user.updated", payload: { USRID: 9 } });
      expect(um.send).toHaveBeenCalledOnce();
      expect(faq.send).not.toHaveBeenCalled();
    });

    it("broadcastToCaves ne vise que les caves données", () => {
      const cave3 = connect({ USRID: 3, app: "DCLING", isCave: true });
      const cave4 = connect({ USRID: 4, app: "DCLING", isCave: true });
      const user3 = connect({ USRID: 3, app: "DCLING" });

      broadcastToCaves([3, null], { type: "declcav.folder.updated", payload: { ID: 1 } });

      expect(cave3.send).toHaveBeenCalledOnce();
      expect(cave4.send).not.toHaveBeenCalled();
      expect(user3.send).not.toHaveBeenCalled();
    });
  });

  it("unregister retire la connexion", () => {
    const ws = connect({ USRID: 1, app: "FAQ" });
    unregister(ws);
    broadcastToAll({ type: "faq.post.created", payload: {} });
    expect(ws.send).not.toHaveBeenCalled();
  });
});
