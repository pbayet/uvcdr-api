import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../../modules/passwords/services.js", () => ({
  MAIL_TEMPLATE: "passwords/expiration",
  getAdAccounts: vi.fn(),
  getUsers: vi.fn(),
  getUserByEmail: vi.fn(),
  sendReminderMail: vi.fn().mockResolvedValue({ messageId: "x" }),
}));

const services = await import("../../../../modules/passwords/services.js");
const controllers = await import("../../../../modules/passwords/controllers.js");

const ADMIN = { application: "USRMAN", permission: "ADMIN", data: { email: "admin@x.fr" } };
const buildReq = (body = {}, payload = ADMIN) => ({
  method: "POST",
  payload,
  body,
  query: {},
  params: {},
  headers: {},
});

const ad = (email, over = {}) => ({
  sAMAccountName: email.split("@")[0],
  email,
  displayName: email,
  mustChangeAtNextLogon: false,
  isExpired: false,
  neverExpires: false,
  daysRemaining: 5,
  expiresAt: "2026-10-04T08:00:00.000Z",
  pwdLastSet: "2026-07-06T08:00:00.000Z",
  ...over,
});
const user = (id, email, over = {}) => ({ USRID: id, EMAIL: email, FSTNAM: "Prénom", LSTNAM: "Nom", USRACTV: 1, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  controllers.__resetCooldowns();
  services.sendReminderMail.mockResolvedValue({ messageId: "x" });
});

describe("modules/passwords/controllers :: sendUserReminder", () => {
  it("refuse un non-gestionnaire", async () => {
    await expect(
      controllers.sendUserReminder(buildReq({ email: "a@x.fr" }, { application: "USRMAN", permission: "USER" })),
    ).rejects.toThrow("ACCESS_DENIED_WO_LOGOUT");
    expect(services.sendReminderMail).not.toHaveBeenCalled();
  });

  it("envoie vers BASE_RECIPIENT_EMAIL hors production, objet préfixé", async () => {
    services.getUserByEmail.mockResolvedValue(user(1, "a@x.fr"));
    services.getAdAccounts.mockResolvedValue([ad("a@x.fr")]);

    const res = await controllers.sendUserReminder(buildReq({ email: "A@x.fr" }));

    expect(res).toMatchObject({ email: "a@x.fr", status: "expiring", result: "sent" });
    const call = services.sendReminderMail.mock.calls[0][0];
    expect(call.to).toBe(process.env.BASE_RECIPIENT_EMAIL);
    expect(call.subject).toMatch(/^\[DEV → a@x\.fr\] /);
  });

  it("bloque une seconde relance dans le délai (cooldown)", async () => {
    services.getUserByEmail.mockResolvedValue(user(1, "a@x.fr"));
    services.getAdAccounts.mockResolvedValue([ad("a@x.fr")]);

    await controllers.sendUserReminder(buildReq({ email: "a@x.fr" }));
    await expect(controllers.sendUserReminder(buildReq({ email: "a@x.fr" }))).rejects.toThrow(
      /^PWD_REMINDER_TOO_RECENT_\[/,
    );
  });

  it("refuse un compte dont le mot de passe n'expire jamais", async () => {
    services.getUserByEmail.mockResolvedValue(user(1, "a@x.fr"));
    services.getAdAccounts.mockResolvedValue([ad("a@x.fr", { neverExpires: true, daysRemaining: null })]);
    await expect(controllers.sendUserReminder(buildReq({ email: "a@x.fr" }))).rejects.toThrow(
      "PWD_REMINDER_NOT_APPLICABLE",
    );
  });

  it("refuse un utilisateur inactif ou sans compte AD", async () => {
    services.getUserByEmail.mockResolvedValue(user(1, "a@x.fr", { USRACTV: 0 }));
    await expect(controllers.sendUserReminder(buildReq({ email: "a@x.fr" }))).rejects.toThrow("USER_NOT_FOUND");

    services.getUserByEmail.mockResolvedValue(user(1, "a@x.fr"));
    services.getAdAccounts.mockResolvedValue([]);
    await expect(controllers.sendUserReminder(buildReq({ email: "a@x.fr" }))).rejects.toThrow(
      "PWD_REMINDER_AD_ACCOUNT_NOT_FOUND",
    );
  });
});

describe("modules/passwords/controllers :: sendGeneralReminder", () => {
  beforeEach(() => {
    services.getAdAccounts.mockResolvedValue([
      ad("a@x.fr", { daysRemaining: 3 }),
      ad("b@x.fr", { isExpired: true, daysRemaining: -2 }),
      ad("c@x.fr", { daysRemaining: 60 }),
      ad("svc@x.fr", { daysRemaining: 1 }), // non référencé
    ]);
    services.getUsers.mockResolvedValue([user(1, "a@x.fr"), user(2, "b@x.fr"), user(3, "c@x.fr")]);
  });

  it("dryRun : liste les destinataires sans envoyer", async () => {
    const res = await controllers.sendGeneralReminder(buildReq({ dryRun: true, days: 15 }));
    expect(res.total).toBe(2);
    expect(res.recipients.map((r) => r.email)).toEqual(["a@x.fr", "b@x.fr"]);
    expect(services.sendReminderMail).not.toHaveBeenCalled();
  });

  it("envoie, ignore les comptes en cooldown et reporte les échecs", async () => {
    services.getUserByEmail.mockResolvedValue(user(1, "a@x.fr"));
    await controllers.sendUserReminder(buildReq({ email: "a@x.fr" })); // a@ en cooldown
    services.sendReminderMail.mockClear();
    services.sendReminderMail.mockRejectedValueOnce(new Error("SMTP down"));

    const res = await controllers.sendGeneralReminder(buildReq({ days: 15 }));

    expect(res).toMatchObject({ total: 2, sent: 0, skipped: 1, failed: 1 });
    expect(res.results.find((r) => r.email === "b@x.fr").reason).toBe("SMTP down");
  });
});

describe("modules/passwords/controllers :: runScheduledReminders", () => {
  it("n'envoie qu'aux comptes sur un palier", async () => {
    services.getAdAccounts.mockResolvedValue([
      ad("a@x.fr", { daysRemaining: 7 }),
      ad("b@x.fr", { daysRemaining: 6 }),
    ]);
    services.getUsers.mockResolvedValue([user(1, "a@x.fr"), user(2, "b@x.fr")]);

    const res = await controllers.runScheduledReminders(new Date("2026-09-29T08:00:00"));
    expect(res).toMatchObject({ total: 1, sent: 1 });
  });
});
