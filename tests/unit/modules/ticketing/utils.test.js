import { describe, it, expect } from "vitest";
import { formatTickets, formatTicket } from "../../../../modules/ticketing/utils.js";
import { buildTicketRow } from "../../../helpers/fixtures.js";

describe("modules/ticketing/utils :: formatTickets", () => {
  it("retourne un tableau vide pour une entrée vide", () => {
    expect(formatTickets([])).toEqual([]);
    expect(formatTickets(null)).toEqual([]);
  });

  it("formate une ligne unique en objet ticket structuré", () => {
    const [ticket] = formatTickets([buildTicketRow()]);

    expect(ticket.TCKID).toBe(100);
    expect(ticket.TCKCOD).toBe("TCK-000100");
    expect(ticket.SRV).toEqual({ SRVID: 10, NAME: "Support" });
    expect(ticket.STS).toMatchObject({ STSID: 1, NAME: "Ouvert", CODE: "OPEN" });
    expect(ticket.PRI).toMatchObject({ PRIID: 2, NAME: "Normale" });
    expect(ticket.NOTES).toEqual([]);
    expect(ticket.PJS).toEqual([]);
    expect(ticket.CREDAT).toBe("2026-06-01T12:00:00+02:00"); // conversion Europe/Paris (DST été)
    expect(ticket.CREEMAIL).toBe("jean.dupont@union-vignerons.com"); // destinataire des notifications créateur
  });

  it("regroupe plusieurs lignes (notes multiples) sous le même ticket", () => {
    const rows = [
      buildTicketRow({ NOTID: 1, NOTCMT: "Première note", NOTUSRID: 5, NOTUSRNAM: "Alice", NOTCREDAT: "2026-06-01T11:00:00Z" }),
      buildTicketRow({ NOTID: 2, NOTCMT: "Deuxième note", NOTUSRID: 6, NOTUSRNAM: "Bob", NOTCREDAT: "2026-06-01T12:00:00Z" }),
    ];

    const [ticket] = formatTickets(rows);
    expect(ticket.NOTES).toHaveLength(2);
    expect(ticket.NOTES.map((n) => n.CMNT)).toEqual(["Première note", "Deuxième note"]);
  });

  it("trie les notes par date de création croissante", () => {
    const rows = [
      buildTicketRow({ NOTID: 2, NOTCMT: "Plus récente", NOTCREDAT: "2026-06-02T00:00:00Z" }),
      buildTicketRow({ NOTID: 1, NOTCMT: "Plus ancienne", NOTCREDAT: "2026-06-01T00:00:00Z" }),
    ];

    const [ticket] = formatTickets(rows);
    expect(ticket.NOTES.map((n) => n.CMNT)).toEqual(["Plus ancienne", "Plus récente"]);
  });

  it("dédoublonne les pièces jointes de ticket (même ATTID sur plusieurs lignes)", () => {
    const rows = [
      buildTicketRow({ ATTID: 9, ATTORIGINALNAME: "capture.png" }),
      buildTicketRow({ ATTID: 9, ATTORIGINALNAME: "capture.png" }),
    ];

    const [ticket] = formatTickets(rows);
    expect(ticket.PJS).toHaveLength(1);
  });

  it("associe correctement l'ID de pièce jointe de note (fix NATTID, cf. audit)", () => {
    const rows = [
      buildTicketRow({
        NOTID: 1,
        NOTCMT: "Note avec pièce jointe",
        NATTID: 55,
        NATTORIGINALNAME: "screenshot.png",
      }),
    ];

    const [ticket] = formatTickets(rows);
    expect(ticket.NOTES[0].PJS[0].ID).toBe(55);
    expect(ticket.NOTES[0].PJS[0].ORIGINALNAME).toBe("screenshot.png");
  });

  it("ignore les lignes sans TCKID", () => {
    expect(formatTickets([{}])).toEqual([]);
  });
});

describe("modules/ticketing/utils :: formatTicket", () => {
  it("retourne le premier ticket formaté", () => {
    const ticket = formatTicket([buildTicketRow()]);
    expect(ticket.TCKID).toBe(100);
  });

  it("lève une 404 si aucune ligne (ticket introuvable ou inaccessible)", () => {
    let caught;
    try {
      formatTicket([]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.status).toBe(404);
    expect(caught.message).toMatch(/introuvable/);
  });
});
