import { describe, it, expect } from "vitest";
import * as utils from "../../../../modules/passwords/utils.js";

const ENV = { MODIFY_PERMS: "DEV,SUPERADMIN,ADMIN", PWD_REMINDER_TIERS: "15,7,1" };

const account = (overrides = {}) => ({
  sAMAccountName: "jdupont",
  email: "jean.dupont@union-vignerons.com",
  displayName: "Jean Dupont",
  mustChangeAtNextLogon: false,
  isExpired: false,
  neverExpires: false,
  daysRemaining: 30,
  expiresAt: "2026-10-29T08:00:00.000Z",
  pwdLastSet: "2026-07-31T08:00:00.000Z",
  ...overrides,
});

const ref = (info) => ({ info, user: { USRID: 1, FSTNAM: "Jean", LSTNAM: "Dupont", USRACTV: 1 } });

describe("modules/passwords/utils :: assertCanSendReminders", () => {
  it("autorise un ADMIN de USRMAN", () => {
    expect(() =>
      utils.assertCanSendReminders({ application: "USRMAN", permission: "ADMIN" }, ENV),
    ).not.toThrow();
  });

  it("refuse un USER de USRMAN", () => {
    expect(() =>
      utils.assertCanSendReminders({ application: "USRMAN", permission: "USER" }, ENV),
    ).toThrow("ACCESS_DENIED_WO_LOGOUT");
  });

  it("refuse un ADMIN d'une autre application", () => {
    expect(() =>
      utils.assertCanSendReminders({ application: "TICKETING", permission: "ADMIN" }, ENV),
    ).toThrow("ACCESS_DENIED_WO_LOGOUT");
  });
});

describe("modules/passwords/utils :: getPasswordStatus", () => {
  it.each([
    [{ mustChangeAtNextLogon: true, isExpired: true }, "must-change"],
    [{ isExpired: true, daysRemaining: -2 }, "expired"],
    [{ neverExpires: true, daysRemaining: null }, "never"],
    [{ daysRemaining: 10 }, "expiring"],
    [{ daysRemaining: 40 }, "valid"],
  ])("%o → %s", (over, expected) => {
    expect(utils.getPasswordStatus(account(over), 15)).toBe(expected);
  });
});

describe("modules/passwords/utils :: matchReferencedAccounts", () => {
  it("ne garde que les comptes AD liés à un utilisateur actif (casse ignorée)", () => {
    const res = utils.matchReferencedAccounts(
      [account({ email: "Jean.Dupont@union-vignerons.com" }), account({ email: "svc@x.fr" }), account({ email: "old@x.fr" })],
      [
        { USRID: 1, EMAIL: "jean.dupont@union-vignerons.com", USRACTV: 1 },
        { USRID: 2, EMAIL: "old@x.fr", USRACTV: 0 },
      ],
    );
    expect(res).toHaveLength(1);
    expect(res[0].user.USRID).toBe(1);
  });
});

describe("modules/passwords/utils :: selectManualRecipients", () => {
  it("sélectionne expirés, à changer et expirant sous le seuil", () => {
    const res = utils.selectManualRecipients(
      [
        ref(account({ daysRemaining: 5 })),
        ref(account({ daysRemaining: 40 })),
        ref(account({ isExpired: true, daysRemaining: -100 })),
        ref(account({ neverExpires: true, daysRemaining: null })),
      ],
      15,
    );
    expect(res.map((r) => r.status)).toEqual(["expiring", "expired"]);
  });
});

describe("modules/passwords/utils :: selectScheduledRecipients", () => {
  const tuesday = new Date("2026-09-29T08:00:00");
  const monday = new Date("2026-09-28T08:00:00");

  it("déclenche uniquement sur les paliers exacts en semaine", () => {
    const res = utils.selectScheduledRecipients(
      [15, 14, 7, 6, 1, 0].map((d) => ref(account({ daysRemaining: d }))),
      tuesday,
      ENV,
    );
    expect(res.map((r) => r.info.daysRemaining)).toEqual([15, 7, 1]);
  });

  it("rattrape le lundi les paliers franchis pendant le week-end", () => {
    const res = utils.selectScheduledRecipients(
      [16, 13, 5, 4].map((d) => ref(account({ daysRemaining: d }))),
      monday,
      ENV,
    );
    expect(res.map((r) => r.info.daysRemaining)).toEqual([13, 5]);
  });

  it("relance les expirés récents chaque jour, pas les anciens", () => {
    const res = utils.selectScheduledRecipients(
      [ref(account({ isExpired: true, daysRemaining: -3 })), ref(account({ isExpired: true, daysRemaining: -90 }))],
      tuesday,
      ENV,
    );
    expect(res).toHaveLength(1);
  });

  it("relance les 'changement exigé' uniquement le lundi", () => {
    const acc = [ref(account({ mustChangeAtNextLogon: true, isExpired: true, daysRemaining: null }))];
    expect(utils.selectScheduledRecipients(acc, tuesday, ENV)).toHaveLength(0);
    expect(utils.selectScheduledRecipients(acc, monday, ENV)).toHaveLength(1);
  });
});

describe("modules/passwords/utils :: cooldown", () => {
  it("bloque puis libère après le délai", () => {
    const store = utils.createCooldownStore();
    store.mark("A@x.fr", 0);
    expect(store.remaining("a@x.fr", 600_000, 1000)).toBe(599_000);
    expect(store.remaining("a@x.fr", 600_000, 600_000)).toBe(0);
  });
});

describe("modules/passwords/utils :: mapWithConcurrency", () => {
  it("conserve l'ordre et borne la concurrence", async () => {
    let running = 0;
    let max = 0;
    const res = await utils.mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    });
    expect(res).toEqual([2, 4, 6, 8, 10]);
    expect(max).toBeLessThanOrEqual(2);
  });
});

describe("modules/passwords/utils :: contenu du mail", () => {
  it("objet adapté au statut", () => {
    expect(utils.buildSubject("expiring", 1)).toBe("Votre mot de passe expire dans 1 jour");
    expect(utils.buildSubject("expiring", 0)).toBe("Votre mot de passe expire aujourd'hui");
    expect(utils.buildSubject("expired", -3)).toBe("Votre mot de passe a expiré");
  });

  it("buildMailData renseigne prénom, couleur et contacts", () => {
    const data = utils.buildMailData(
      { ...ref(account({ daysRemaining: 7 })), status: "expiring" },
      { PWD_REMINDER_CONTACTS: "Support|support@x.fr" },
    );
    expect(data.FIRST_NAME).toBe("Jean");
    expect(data.THEME_COLOR).toBe(utils.STATUS_THEME.expiring.color);
    expect(data.STATUS_LABEL).toBe("Expire dans 7 jours");
    expect(data.CONTACTS_HTML).toContain("support@x.fr");
    expect(data.ACTION_URL).toBeUndefined();
  });
});
