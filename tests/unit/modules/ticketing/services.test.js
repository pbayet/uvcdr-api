import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../../core/utils/db.utils.js", () => ({
  runQuery: vi.fn(),
}));

const { runQuery } = await import("../../../../core/utils/db.utils.js");
const services = await import("../../../../modules/ticketing/services.js");

describe("modules/ticketing/services :: tickets", () => {
  beforeEach(() => {
    runQuery.mockReset();
  });

  it("getTickets renvoie le recordset et transmet USRID", async () => {
    runQuery.mockResolvedValue({ recordset: [{ TCKID: 1 }] });

    const result = await services.getTickets(42);

    expect(result).toEqual([{ TCKID: 1 }]);
    const [args] = runQuery.mock.calls[0];
    expect(args.inputs.USRID.value).toBe(42);
    expect(args.inputs.CODE.value).toBeNull();
  });

  it("getTicket transmet USRID et CODE", async () => {
    runQuery.mockResolvedValue({ recordset: [{ TCKID: 1, TCKCOD: "TCK-000001" }] });

    await services.getTicket(42, "TCK-000001");

    const [args] = runQuery.mock.calls[0];
    expect(args.inputs.USRID.value).toBe(42);
    expect(args.inputs.CODE.value).toBe("TCK-000001");
  });

  it("createTicket retourne le TCKCOD généré", async () => {
    runQuery.mockResolvedValue({ recordset: [{ TCKCOD: "TCK-000123" }] });

    const code = await services.createTicket({
      TITLE: "Nouveau ticket",
      DESCR: "Description",
      SRVID: 10,
      CREUSR: 1,
    });

    expect(code).toBe("TCK-000123");
    const [args] = runQuery.mock.calls[0];
    expect(args.inputs.TITLE.value).toBe("Nouveau ticket");
    expect(args.inputs.CREUSR.value).toBe(1);
  });

  it("createTicket retourne undefined si le recordset est vide", async () => {
    runQuery.mockResolvedValue({ recordset: [] });
    const code = await services.createTicket({ TITLE: "T", SRVID: 1, CREUSR: 1 });
    expect(code).toBeUndefined();
  });

  it("updateTicket retourne le nombre de lignes affectées", async () => {
    runQuery.mockResolvedValue({ recordset: [{ AFFECTED: 1 }] });

    const result = await services.updateTicket({
      TCKID: 1,
      TITLE: "T",
      DESCR: "D",
      STSID: 2,
      USRID: 1,
    });

    expect(result).toEqual({ AFFECTED: 1 });
  });

  it("deleteTicket (soft delete) utilise rowsAffected et transmet DLTD", async () => {
    runQuery.mockResolvedValue({ rowsAffected: [1] });

    const result = await services.deleteTicket(1, true, false);

    expect(result).toEqual({ AFFECTED: 1 });
    const [args] = runQuery.mock.calls[0];
    expect(args.inputs.DLTD.value).toBe(true);
  });

  it("deleteTicket (suppression définitive) retourne AFFECTED=0 par convention", async () => {
    runQuery.mockResolvedValue({ rowsAffected: [3] });
    const result = await services.deleteTicket(1, false, true);
    expect(result).toEqual({ AFFECTED: 0 });
  });

  it("closeTicket retourne le nombre de lignes affectées", async () => {
    runQuery.mockResolvedValue({ rowsAffected: [1] });
    const result = await services.closeTicket({ TCKID: 1 });
    expect(result).toEqual({ AFFECTED: 1 });
  });

  it("getServiceMemberEmails renvoie le recordset et transmet SRVID", async () => {
    runQuery.mockResolvedValue({
      recordset: [{ USRID: 5, EMAIL: "alice@union-vignerons.com", USRNAM: "Alice Martin" }],
    });

    const result = await services.getServiceMemberEmails(10);

    expect(result).toEqual([{ USRID: 5, EMAIL: "alice@union-vignerons.com", USRNAM: "Alice Martin" }]);
    const [args] = runQuery.mock.calls[0];
    expect(args.inputs.SRVID.value).toBe(10);
  });
});

describe("modules/ticketing/services :: notes", () => {
  beforeEach(() => {
    runQuery.mockReset();
  });

  it("createNote retourne l'identifiant généré", async () => {
    runQuery.mockResolvedValue({ recordset: [{ NTEID: 55 }] });
    const result = await services.createNote({ USRID: 1, TCKID: 1, CMNT: "Note", PUBLIC: true });
    expect(result).toEqual({ NTEID: 55 });
  });

  it("getNote transmet NTEID et USRID", async () => {
    runQuery.mockResolvedValue({ recordset: [] });
    await services.getNote({ USRID: 1, NTEID: 55 });
    const [args] = runQuery.mock.calls[0];
    expect(args.inputs.NTEID.value).toBe(55);
  });

  it("updateNote et deleteNote ne lèvent pas et transmettent les bons identifiants", async () => {
    runQuery.mockResolvedValue({ recordset: [] });

    await expect(services.updateNote({ USRID: 1, NTEID: 5, CMNT: "x", PUBLIC: false })).resolves.toBeUndefined();
    await expect(services.deleteNote({ NTEID: 5 })).resolves.toBeUndefined();

    expect(runQuery).toHaveBeenCalledTimes(2);
  });
});

describe("modules/ticketing/services :: référentiels (categories/services/statuses/priorities)", () => {
  beforeEach(() => {
    runQuery.mockReset();
    runQuery.mockResolvedValue({ recordset: [{ id: 1 }] });
  });

  it("getCategories / getServices / getStatuses / getPriorities renvoient le recordset", async () => {
    await expect(services.getCategories()).resolves.toEqual([{ id: 1 }]);
    await expect(services.getServices()).resolves.toEqual([{ id: 1 }]);
    await expect(services.getStatuses()).resolves.toEqual([{ id: 1 }]);
    await expect(services.getPriorities()).resolves.toEqual([{ id: 1 }]);
  });

  it("createCategory transmet NAME/DESCR/USRID", async () => {
    await services.createCategory({ NAME: "Réseau", DESCR: null, USRID: 1 });
    const [args] = runQuery.mock.calls[0];
    expect(args.inputs.NAME.value).toBe("Réseau");
  });
});

describe("modules/ticketing/services :: setTicketCc :: auto-association des services", () => {
  beforeEach(() => {
    runQuery.mockReset();
  });

  it("ajoute le service d'un nouveau CC aux services associés quand ce n'est pas le service principal", async () => {
    runQuery
      // 1. CC existants avant le delsert : personne
      .mockResolvedValueOnce({ recordset: [] })
      // 2. DELETE/INSERT TICKETCC
      .mockResolvedValueOnce({ recordset: [] })
      // 3. SELECT PRIMARYSRVID/CCUSERSRVID (autoAssignServicesFromNewCc)
      .mockResolvedValueOnce({
        recordset: [{ PRIMARYSRVID: 10, CCUSERSRVID: 20 }],
      })
      // 4. getTicketServices (services associés actuels) : aucun
      .mockResolvedValueOnce({ recordset: [] })
      // 5. DELETE/INSERT TICKETSERVICES (setTicketServices)
      .mockResolvedValueOnce({ recordset: [] })
      // 6. getTicketServices (retour de setTicketServices)
      .mockResolvedValueOnce({
        recordset: [{ TSVID: 1, SRVID: 20, NAME: "Support" }],
      })
      // 7. getTicketCc final
      .mockResolvedValueOnce({
        recordset: [{ TCCID: 1, USRID: 5, USRNAM: "Jean Dupont", EMAIL: "jean@union-vignerons.com" }],
      });

    const result = await services.setTicketCc({ TCKID: 1, USRIDS: [5], CREUSR: 1 });

    expect(result).toEqual([
      { TCCID: 1, USRID: 5, USRNAM: "Jean Dupont", EMAIL: "jean@union-vignerons.com" },
    ]);
    expect(runQuery).toHaveBeenCalledTimes(7);

    // Le 5ᵉ appel est le delsert TICKETSERVICES : il doit inclure le SRVID 20.
    const [servicesArgs] = runQuery.mock.calls[4];
    expect(JSON.parse(servicesArgs.inputs.SRVIDS.value)).toContain(20);
  });

  it("n'ajoute rien si le service du nouveau CC est déjà le service principal du ticket", async () => {
    runQuery
      .mockResolvedValueOnce({ recordset: [] }) // 1. CC existants
      .mockResolvedValueOnce({ recordset: [] }) // 2. DELETE/INSERT TICKETCC
      .mockResolvedValueOnce({
        recordset: [{ PRIMARYSRVID: 10, CCUSERSRVID: 10 }],
      }) // 3. le service du CC EST le service principal
      .mockResolvedValueOnce({ recordset: [] }); // 4. getTicketCc final

    await services.setTicketCc({ TCKID: 1, USRIDS: [5], CREUSR: 1 });

    // Pas d'appel getTicketServices/setTicketServices : seulement 4 requêtes.
    expect(runQuery).toHaveBeenCalledTimes(4);
  });

  it("ne redéclenche pas l'auto-association pour un CC déjà présent (seuls les nouveaux comptent)", async () => {
    runQuery
      .mockResolvedValueOnce({ recordset: [{ TCCID: 1, USRID: 5 }] }) // 1. CC existants : déjà 5
      .mockResolvedValueOnce({ recordset: [] }) // 2. DELETE/INSERT TICKETCC (même liste [5])
      .mockResolvedValueOnce({ recordset: [{ TCCID: 1, USRID: 5 }] }); // 3. getTicketCc final

    await services.setTicketCc({ TCKID: 1, USRIDS: [5], CREUSR: 1 });

    // Aucun nouveau CC → pas de requête d'auto-association (3 appels seulement).
    expect(runQuery).toHaveBeenCalledTimes(3);
  });
});
