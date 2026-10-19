import { describe, it, expect, vi, beforeEach } from "vitest";

// Ni SMTP ni SQL réels : nodemailer et runQuery sont remplacés par des doubles.
const sendMailMock = vi.fn();
const runQueryMock = vi.fn();

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: sendMailMock }) },
}));
vi.mock("../../../core/utils/db.utils.js", () => ({ runQuery: runQueryMock }));

process.env.HOST = process.env.HOST || "smtp.test.local";
process.env.EMAIL_USER = process.env.EMAIL_USER || "user";
process.env.EMAIL_PASS = process.env.EMAIL_PASS || "pass";

const { sendMail, resolveMailCopies } = await import("../../../core/services/mail.service.js");

const base = { subject: "Sujet", html: "<p>x</p>" };

describe("core/services/mail.service :: sendMail (copies mails)", () => {
  beforeEach(() => {
    sendMailMock.mockResolvedValue({ messageId: "m1" });
  });

  it("ajoute en BCC les utilisateurs qui suivent les mails des destinataires", async () => {
    runQueryMock.mockResolvedValue({ recordset: [{ EMAIL: "assistante@test.com" }] });

    await sendMail({ ...base, to: "Chef <Chef@Test.com>", cc: ["autre@test.com"], bcc: "cache@test.com" });

    const lookup = runQueryMock.mock.calls[0][0];
    expect(lookup.dbConnectionName).toBe("usersmanager");
    expect(JSON.parse(lookup.inputs.EMAILS.value)).toEqual([
      "chef@test.com",
      "autre@test.com",
      "cache@test.com",
    ]);
    expect(sendMailMock.mock.calls[0][0].bcc).toEqual(["cache@test.com", "assistante@test.com"]);
  });

  it("n'ajoute pas une copie déjà destinataire", async () => {
    runQueryMock.mockResolvedValue({ recordset: [{ EMAIL: "autre@test.com" }] });

    await sendMail({ ...base, to: "chef@test.com, autre@test.com" });

    expect(sendMailMock.mock.calls[0][0].bcc).toBeUndefined();
  });

  it("n'interroge pas la base si noMailCopies est passé", async () => {
    await sendMail({ ...base, to: "chef@test.com", noMailCopies: true });

    expect(runQueryMock).not.toHaveBeenCalled();
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it("envoie quand même le mail si la recherche des copies échoue", async () => {
    runQueryMock.mockRejectedValue(new Error("Invalid object name 'dbo.USRMAILCPY'"));

    await sendMail({ ...base, to: "chef@test.com" });

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0][0].to).toBe("chef@test.com");
  });

  it("resolveMailCopies renvoie les copies sans envoyer de mail", async () => {
    runQueryMock.mockResolvedValue({ recordset: [{ EMAIL: "valerie@test.com" }] });

    const copies = await resolveMailCopies("Sylvie@Test.com,dev@test.com");

    expect(JSON.parse(runQueryMock.mock.calls.at(-1)[0].inputs.EMAILS.value)).toEqual([
      "sylvie@test.com",
      "dev@test.com",
    ]);
    expect(copies).toEqual(["valerie@test.com"]);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
