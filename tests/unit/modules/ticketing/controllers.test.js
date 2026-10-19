import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildTicketRow } from "../../../helpers/fixtures.js";

vi.mock("../../../../modules/ticketing/services.js");
vi.mock("../../../../config/websocket/wsManager.js", () => ({
  broadcastToAll: vi.fn(),
  broadcastToUsers: vi.fn(),
}));
vi.mock("../../../../core/services/mail.service.js", () => ({
  sendTemplatedMail: vi.fn().mockResolvedValue(undefined),
  // NB : modules/ticketing/controllers.js utilise réellement
  // renderDetailGroups/renderNoteList (pas renderDetailsList/
  // renderContactList, absents de ce mock jusqu'ici — un import non mocké
  // fait échouer silencieusement tout appelant, cf. notifyTicketEvent
  // try/catch, d'où les échecs "0 appel" observés sur toute notification).
  renderDetailsList: vi.fn(() => "<li>détails</li>"),
  renderContactList: vi.fn(() => ""),
  renderDetailGroups: vi.fn(() => "<li>détails</li>"),
  renderNoteList: vi.fn(() => "<li>note</li>"),
}));

const services = await import("../../../../modules/ticketing/services.js");
const { broadcastToAll } = await import("../../../../config/websocket/wsManager.js");
const { sendTemplatedMail, renderDetailsList } = await import("../../../../core/services/mail.service.js");
// Volontairement PAS mocké : on veut exercer le vrai regroupement/anti-spam
// (cf. besoin métier ticketing) plutôt qu'une version simulée.
const { flushAllDebounced } = await import("../../../../core/utils/debounce.utils.js");
const controllers = await import("../../../../modules/ticketing/controllers.js");

// Valeur injectée par vitest.config.js (test.env.BASE_RECIPIENT_EMAIL). En
// dehors de la production (NODE_ENV="test" ici), notifyTicketEvent() redirige
// tous les mails vers cette adresse plutôt que les vraies adresses métier
// (même garde-fou que modules/declcav/controllers.js) — cf. commentaire
// d'en-tête de modules/ticketing/controllers.js.
const DEV_FALLBACK_RECIPIENT = "qa-mail-fallback@union-vignerons.com";

// Délais par défaut de modules/ticketing/controllers.js (STATUS_MAIL_DEBOUNCE_MS
// / NOTE_MAIL_DEBOUNCE_MS) : aucune variable d'env dédiée n'est définie pour
// les tests, donc ce sont bien ces valeurs par défaut qui s'appliquent.
const MAIL_DEBOUNCE_MS = 2 * 60 * 1000;

function buildReq({ payload = { data: { id: 1 } }, body = {}, params = {}, query = {} } = {}) {
  return { method: "POST", payload, body, params, query, headers: {}, originalUrl: "/api/ticketing" };
}

describe("modules/ticketing/controllers :: getTickets", () => {
  beforeEach(() => vi.clearAllMocks());

  it("liste tous les tickets de l'utilisateur si aucun TCKNUM fourni", async () => {
    services.getTickets.mockResolvedValue([buildTicketRow()]);

    const result = await controllers.getTickets(buildReq());

    expect(services.getTickets).toHaveBeenCalledWith(1);
    expect(result).toHaveLength(1);
    expect(result[0].TCKCOD).toBe("TCK-000100");
  });

  it("récupère un ticket précis si TCKNUM fourni", async () => {
    services.getTicket.mockResolvedValue([buildTicketRow()]);

    const result = await controllers.getTickets(buildReq({ body: { TCKNUM: "TCK-000100" } }));

    expect(services.getTicket).toHaveBeenCalledWith(1, "TCK-000100");
    expect(result.TCKID).toBe(100);
  });
});

describe("modules/ticketing/controllers :: createTicket", () => {
  beforeEach(() => vi.clearAllMocks());

  it("valide, crée le ticket, diffuse l'événement WS et notifie les membres du service par email", async () => {
    services.createTicket.mockResolvedValue("TCK-000200");
    services.getTicket.mockResolvedValue([
      // STSCOD "NEW" : c'est ce statut initial qui sélectionne le template
      // "ticketing/creation" (cf. STATUS_MAIL_CONFIG côté controllers.js) —
      // le défaut de buildTicketRow ("OPEN") tombe sinon sur le template
      // générique DEFAULT_STATUS_MAIL_CONFIG ("ticketing/modification").
      buildTicketRow({
        TCKID: 200,
        TCKCOD: "TCK-000200",
        SRVID: 10,
        STSID: 1,
        STSNAM: "Nouveau",
        STSCOD: "NEW",
      }),
    ]);
    // Notification de création : résout désormais les membres de TOUS les
    // services attribués (principal + co-attribués via TICKETSERVICES, cf.
    // controllers.getServicesRecipients) via getServiceMemberEmailsMulti
    // plutôt que getServiceMemberEmails (mono-service) — le ticket de ce
    // test n'a pas de service supplémentaire (SERVICES: []), seul le
    // principal (SRVID: 10) est donc résolu.
    services.getServiceMemberEmailsMulti.mockResolvedValue([
      { USRID: 5, EMAIL: "alice@union-vignerons.com" },
    ]);

    const req = buildReq({ body: { TITLE: "Nouveau ticket", SRVID: 10 } });
    const result = await controllers.createTicket(req);

    expect(result.TCKCOD).toBe("TCK-000200");
    expect(services.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ TITLE: "Nouveau ticket", SRVID: 10, CREUSR: 1, ASGUSR: 1 }),
    );
    expect(broadcastToAll).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ticket.created", payload: expect.objectContaining({ TCKCOD: "TCK-000200" }) }),
    );

    // La notification est "best-effort" et non attendue par createTicket
    // (envoi immédiat, pas de regroupement pour la création) : on laisse les
    // micro-tâches s'écouler avant de vérifier l'appel.
    await new Promise((r) => setTimeout(r, 20));

    // Destinataires résolus dynamiquement (membres de tous les services
    // attribués — ici uniquement le principal, SRVID 10).
    expect(services.getServiceMemberEmailsMulti).toHaveBeenCalledWith([10]);
    // Hors production, le mail part vers le repli dev plutôt que la vraie adresse.
    expect(sendTemplatedMail).toHaveBeenCalledWith(
      expect.objectContaining({ template: "ticketing/creation", to: [DEV_FALLBACK_RECIPIENT] }),
    );
  });

  it("rejette un payload invalide (TITLE manquant) avant tout appel service", async () => {
    const req = buildReq({ body: { SRVID: 10 } });
    await expect(controllers.createTicket(req)).rejects.toThrow();
    expect(services.createTicket).not.toHaveBeenCalled();
  });

  it("lève DB_QUERY_ERROR si le service ne renvoie aucun code", async () => {
    services.createTicket.mockResolvedValue(undefined);
    const req = buildReq({ body: { TITLE: "T", SRVID: 1 } });
    await expect(controllers.createTicket(req)).rejects.toThrow("DB_QUERY_ERROR");
  });
});

describe("modules/ticketing/controllers :: updateTicket", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    // Vide tout lot de notification laissé en attente : sans ça, un lot
    // planifié par un test (même TCKID=100 par défaut dans les fixtures)
    // pourrait fuiter sur le test suivant.
    await flushAllDebounced();
    vi.useRealTimers();
  });

  it("fusionne les champs non fournis avec les valeurs existantes du ticket", async () => {
    const existing = buildTicketRow({ TITLE: "Titre existant" });
    services.getTicket.mockResolvedValue([existing]);
    services.updateTicket.mockResolvedValue({ AFFECTED: 1 });

    const req = buildReq({ body: { TCKNUM: "TCK-000100", STSID: 2 } });
    await controllers.updateTicket(req);

    const [args] = services.updateTicket.mock.calls[0];
    expect(args.TITLE).toBe("Titre existant"); // conservé car non fourni
    expect(args.STSID).toBe(2); // remplacé
  });

  it("conserve planification et sous-catégories lors d'un simple changement de statut (drag & drop)", async () => {
    const existing = buildTicketRow({
      DATDEB: new Date("2026-10-01"),
      DATFIN: new Date("2026-10-15"),
      DATDEBREEL: new Date("2026-10-02"),
      DATFINREEL: null,
      TPSPREV: 120,
      TPSREEL: 0,
      SC2ID: 7,
      SC3ID: 9,
    });
    services.getTicket.mockResolvedValue([existing]);
    services.updateTicket.mockResolvedValue({ AFFECTED: 1 });

    await controllers.updateTicket(
      buildReq({ body: { TCKNUM: "TCK-000100", STSID: 2 } }),
    );

    const [args] = services.updateTicket.mock.calls[0];
    expect(args.DATDEB).toEqual(existing.DATDEB);
    expect(args.DATFIN).toEqual(existing.DATFIN);
    expect(args.DATDEBREEL).toEqual(existing.DATDEBREEL);
    expect(args.TPSPREV).toBe(120);
    expect(args.TPSREEL).toBe(0);
    expect(args.SC2ID).toBe(7);
    expect(args.SC3ID).toBe(9);
  });

  it("efface la planification envoyée vide (\"\" ou null)", async () => {
    const existing = buildTicketRow({
      MYPRIMARYSRV: 1, // seul le service principal peut modifier la catégorisation
      DATDEB: new Date("2026-10-01"),
      TPSPREV: 120,
      SC2ID: 7,
    });
    services.getTicket.mockResolvedValue([existing]);
    services.updateTicket.mockResolvedValue({ AFFECTED: 1 });
    services.logTicketFieldChanges?.mockResolvedValue?.(undefined);

    await controllers.updateTicket(
      buildReq({ body: { TCKNUM: "TCK-000100", DATDEB: "", TPSPREV: null, SC2ID: "" } }),
    );

    const [args] = services.updateTicket.mock.calls[0];
    expect(args.DATDEB).toBeNull();
    expect(args.TPSPREV).toBeNull();
    expect(args.SC2ID).toBeNull();
  });

  it("ne notifie pas immédiatement un changement de statut : l'email est différé", async () => {
    const oldTicket = buildTicketRow({ STSID: 1, STSNAM: "Ouvert" });
    const newTicket = buildTicketRow({ STSID: 3, STSNAM: "Résolu" });
    services.getTicket.mockResolvedValueOnce([oldTicket]).mockResolvedValue([newTicket]);
    services.updateTicket.mockResolvedValue({ AFFECTED: 1 });

    const req = buildReq({ body: { TCKNUM: "TCK-000100", STSID: 3 } });
    await controllers.updateTicket(req);

    expect(sendTemplatedMail).not.toHaveBeenCalled();
  });

  it("notifie un changement de statut avec l'ancien et le nouveau statut, après une courte période de silence", async () => {
    const oldTicket = buildTicketRow({ STSID: 1, STSNAM: "Ouvert" });
    const newTicket = buildTicketRow({ STSID: 3, STSNAM: "Résolu" });
    services.getTicket.mockResolvedValueOnce([oldTicket]).mockResolvedValue([newTicket]);
    services.updateTicket.mockResolvedValue({ AFFECTED: 1 });

    const req = buildReq({ body: { TCKNUM: "TCK-000100", STSID: 3 } });
    await controllers.updateTicket(req);

    await vi.advanceTimersByTimeAsync(MAIL_DEBOUNCE_MS);

    expect(sendTemplatedMail).toHaveBeenCalledWith(
      expect.objectContaining({
        template: "modification",
        subject: expect.stringContaining("modifié"),
        to: [DEV_FALLBACK_RECIPIENT],
      }),
    );
  });

  it("regroupe plusieurs changements de statut rapprochés (aller-retour) en un seul email", async () => {
    // Scénario type : Nouveau -> En cours -> Nouveau, en quelques dizaines de
    // secondes. Doit produire UN SEUL email au lieu d'un par changement.
    const brandNew = buildTicketRow({ STSID: 1, STSNAM: "Nouveau" });
    const inProgress = buildTicketRow({ STSID: 2, STSNAM: "En cours" });
    services.updateTicket.mockResolvedValue({ AFFECTED: 1 });

    services.getTicket.mockResolvedValueOnce([brandNew]).mockResolvedValue([inProgress]);
    await controllers.updateTicket(buildReq({ body: { TCKNUM: "TCK-000100", STSID: 2 } }));

    await vi.advanceTimersByTimeAsync(30 * 1000); // bien avant la fin du silence

    services.getTicket.mockResolvedValueOnce([inProgress]).mockResolvedValue([brandNew]);
    await controllers.updateTicket(buildReq({ body: { TCKNUM: "TCK-000100", STSID: 1 } }));

    expect(sendTemplatedMail).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(MAIL_DEBOUNCE_MS);

    // Un seul email, malgré deux modifications rapprochées.
    expect(sendTemplatedMail).toHaveBeenCalledTimes(1);
  });
});

describe("modules/ticketing/controllers :: deleteTicket / closeTicket", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deleteTicket lève une 404 si le ticket n'existe pas ou est inaccessible", async () => {
    services.getTicket.mockResolvedValue([]);
    const req = buildReq({ body: { TCKNUM: "TCK-INEXISTANT" } });

    let caught;
    try {
      await controllers.deleteTicket(req);
    } catch (err) {
      caught = err;
    }
    expect(caught.status).toBe(404);
  });

  it("deleteTicket diffuse ticket.deleted.perm si PERM=true et notifie le créateur", async () => {
    const ticket = buildTicketRow();
    services.getTicket.mockResolvedValue([ticket]);
    services.deleteTicket.mockResolvedValue({ AFFECTED: 0 });

    const req = buildReq({ body: { TCKNUM: "TCK-000100", PERM: true } });
    await controllers.deleteTicket(req);

    expect(broadcastToAll).toHaveBeenCalledWith(expect.objectContaining({ type: "ticket.deleted.perm" }));

    await new Promise((r) => setTimeout(r, 0));
    expect(sendTemplatedMail).toHaveBeenCalledWith(
      expect.objectContaining({ template: "deletion", to: [DEV_FALLBACK_RECIPIENT] }),
    );
  });

  it("closeTicket clôture, diffuse ticket.closed et notifie le créateur immédiatement", async () => {
    const ticket = buildTicketRow();
    services.getTicket.mockResolvedValue([ticket]);
    services.closeTicket.mockResolvedValue({ AFFECTED: 1 });

    const req = buildReq({ body: { TCKNUM: "TCK-000100" } });
    const result = await controllers.closeTicket(req);

    expect(result.TCKID).toBe(100);
    expect(broadcastToAll).toHaveBeenCalledWith(expect.objectContaining({ type: "ticket.closed" }));

    // Action ponctuelle et délibérée : pas de regroupement, envoi immédiat.
    await new Promise((r) => setTimeout(r, 0));
    expect(sendTemplatedMail).toHaveBeenCalledWith(
      expect.objectContaining({ template: "modification", subject: expect.stringContaining("clôturé") }),
    );
  });
});

describe("modules/ticketing/controllers :: notes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await flushAllDebounced();
    vi.useRealTimers();
  });

  it("createNote diffuse ticket.note.created et retourne la note créée", async () => {
    services.createNote.mockResolvedValue({ NTEID: 9 });
    services.getNote.mockResolvedValue([
      buildTicketRow({ NOTID: 9, NOTCMT: "Nouvelle note", NOTUSRID: 7, NOTUSRNAM: "Alice" }),
    ]);

    const req = buildReq({ body: { TCKID: 100, CMNT: "Nouvelle note" } });
    const result = await controllers.createNote(req);

    expect(result.NOTID).toBe(9);
    expect(broadcastToAll).toHaveBeenCalledWith(expect.objectContaining({ type: "ticket.note.created" }));
    // L'email est différé (cf. tests dédiés ci-dessous) : rien d'envoyé encore.
    expect(sendTemplatedMail).not.toHaveBeenCalled();
  });

  it("note d'une personne du service (auteur ≠ créateur) : email différé vers le créateur du ticket", async () => {
    services.createNote.mockResolvedValue({ NTEID: 9 });
    services.getNote.mockResolvedValue([
      // CREUSR = 1 (fixture par défaut) ; auteur de la note = 7 (personne du service).
      buildTicketRow({ NOTID: 9, NOTCMT: "Réponse du support", NOTUSRID: 7, NOTUSRNAM: "Alice" }),
    ]);

    await controllers.createNote(buildReq({ body: { TCKID: 100, CMNT: "Réponse du support" } }));
    await vi.advanceTimersByTimeAsync(MAIL_DEBOUNCE_MS);

    // Pas besoin de résoudre les membres du service dans ce sens.
    expect(services.getServiceMemberEmails).not.toHaveBeenCalled();
    expect(sendTemplatedMail).toHaveBeenCalledWith(
      expect.objectContaining({ template: "notification", to: [DEV_FALLBACK_RECIPIENT] }),
    );
  });

  it("note du demandeur (auteur = créateur) : email différé vers les membres du service, en l'excluant lui-même", async () => {
    services.createNote.mockResolvedValue({ NTEID: 10 });
    services.getNote.mockResolvedValue([
      // CREUSR = 1 (fixture par défaut) ; auteur de la note = 1 (le demandeur).
      buildTicketRow({ NOTID: 10, NOTCMT: "Où en est mon ticket ?", NOTUSRID: 1, NOTUSRNAM: "Jean Dupont", SRVID: 10 }),
    ]);
    services.getServiceMemberEmails.mockResolvedValue([
      { USRID: 5, EMAIL: "alice@union-vignerons.com" },
    ]);

    await controllers.createNote(buildReq({ body: { TCKID: 100, CMNT: "Où en est mon ticket ?" } }));
    await vi.advanceTimersByTimeAsync(MAIL_DEBOUNCE_MS);

    // Service du ticket, en excluant le demandeur (USRID=1) au cas où il en serait membre.
    expect(services.getServiceMemberEmails).toHaveBeenCalledWith(10);
    expect(sendTemplatedMail).toHaveBeenCalledWith(
      expect.objectContaining({ template: "notification", to: [DEV_FALLBACK_RECIPIENT] }),
    );
  });

  it("regroupe plusieurs notes rapprochées du même auteur en un seul email", async () => {
    services.createNote.mockResolvedValueOnce({ NTEID: 1 }).mockResolvedValueOnce({ NTEID: 2 });
    services.getNote
      .mockResolvedValueOnce([buildTicketRow({ NOTID: 1, NOTCMT: "Première note", NOTUSRID: 7, NOTUSRNAM: "Alice" })])
      .mockResolvedValueOnce([buildTicketRow({ NOTID: 2, NOTCMT: "Deuxième note", NOTUSRID: 7, NOTUSRNAM: "Alice" })]);

    await controllers.createNote(buildReq({ body: { TCKID: 100, CMNT: "Première note" } }));
    await vi.advanceTimersByTimeAsync(30 * 1000); // bien avant la fin du silence
    await controllers.createNote(buildReq({ body: { TCKID: 100, CMNT: "Deuxième note" } }));

    expect(sendTemplatedMail).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(MAIL_DEBOUNCE_MS);

    // Un seul email, listant les deux notes.
    expect(sendTemplatedMail).toHaveBeenCalledTimes(1);
    expect(renderDetailsList).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ value: "Première note" }),
        expect.objectContaining({ value: "Deuxième note" }),
      ]),
    );
  });

  it("deleteNote valide NTEID et retourne true", async () => {
    services.deleteNote.mockResolvedValue(undefined);
    const req = buildReq({ body: { NTEID: 9 } });
    await expect(controllers.deleteNote(req)).resolves.toBe(true);
    expect(services.deleteNote).toHaveBeenCalledWith({ NTEID: 9 });
  });
});
