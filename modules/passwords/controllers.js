/* ─────────────────────────────────────────────
   Module "passwords" — relances d'expiration des mots de passe AD

   Trois déclencheurs, une seule chaîne d'envoi (deliver → sendReminder) :
   - sendUserReminder      POST /passwords/reminders/user  (bouton par utilisateur)
   - sendGeneralReminder   POST /passwords/reminders       (bouton "relance générale")
   - runScheduledReminders tâche quotidienne (routes.js, prod uniquement)

   Sécurité :
   - routes manuelles réservées aux gestionnaires (PRMNAM ∈ MODIFY_PERMS) d'une
     application autorisée (PWD_REMINDER_APPCODES, défaut USRMAN) ;
   - destinataires TOUJOURS résolus côté serveur (AD ∩ users-manager actifs),
     jamais une adresse arbitraire fournie par le client : l'email reçu sert
     uniquement de clé de recherche ;
   - anti-doublon : une relance manuelle par compte toutes les
     PWD_REMINDER_COOLDOWN_MIN minutes ;
   - hors production, tous les mails partent vers BASE_RECIPIENT_EMAIL (même
     garde-fou que fsa/ticketing/declcav), l'objet indiquant le vrai
     destinataire.

   Envoi best-effort pour les relances groupées (un échec SMTP est reporté
   dans le résultat, sans interrompre les autres envois) ; en revanche la
   relance unitaire remonte l'erreur au client.
───────────────────────────────────────────── */

import * as services from "./services.js";
import * as utils from "./utils.js";
import * as v from "./validators.js";
import * as requestUtils from "../../core/utils/request.utils.js";
import { logger } from "../../config/logger.config.js";

const isProd = () => process.env.NODE_ENV === "production";

const cooldowns = utils.createCooldownStore();
setInterval(
  () => cooldowns.sweep(utils.getReminderConfig().cooldownMs),
  30 * 60_000,
).unref();

/** Exposé pour les tests uniquement. */
export const __resetCooldowns = () => cooldowns.clear();

/* -------------------------------------------------------------------------- */
/*                                   ENVOI                                    */
/* -------------------------------------------------------------------------- */

const displayNameOf = ({ info, user }) =>
  [user?.FSTNAM, user?.LSTNAM].filter(Boolean).join(" ") ||
  info.displayName ||
  info.sAMAccountName ||
  info.email;

function toSummary(recipient) {
  return {
    email: recipient.info.email,
    usrid: recipient.user?.USRID ?? null,
    displayName: displayNameOf(recipient),
    status: recipient.status,
    daysRemaining: recipient.info.daysRemaining,
    expiresAt: recipient.info.expiresAt,
  };
}

/** Envoi d'un mail de relance (lève en cas d'échec). */
async function sendReminder(recipient) {
  const cfg = utils.getReminderConfig();
  const realEmail = recipient.info.email;
  const to = isProd() ? realEmail : process.env.BASE_RECIPIENT_EMAIL;
  if (!to) throw new Error("MISSING_RECIPIENT");

  const subject = utils.buildSubject(
    recipient.status,
    recipient.info.daysRemaining,
  );

  await services.sendReminderMail({
    to,
    from: cfg.from,
    subject: isProd() ? subject : `[DEV → ${realEmail}] ${subject}`,
    data: utils.buildMailData(recipient),
  });

  cooldowns.mark(realEmail);
}

/** Variante best-effort pour les envois groupés. */
async function deliver(recipient, { respectCooldown }) {
  const summary = toSummary(recipient);
  const { cooldownMs } = utils.getReminderConfig();

  if (respectCooldown) {
    const ms = cooldowns.remaining(summary.email, cooldownMs);
    if (ms > 0) {
      return {
        ...summary,
        result: "skipped",
        reason: `Déjà relancé récemment (nouvel envoi possible dans ${utils.formatDuration(ms)}).`,
      };
    }
  }

  try {
    await sendReminder(recipient);
    return { ...summary, result: "sent" };
  } catch (err) {
    logger.error(
      `[PASSWORDS][MAIL] Échec relance ${summary.email} : ${err.message}`,
    );
    return { ...summary, result: "error", reason: err.message };
  }
}

function aggregate(results) {
  return {
    total: results.length,
    sent: results.filter((r) => r.result === "sent").length,
    skipped: results.filter((r) => r.result === "skipped").length,
    failed: results.filter((r) => r.result === "error").length,
    results,
  };
}

async function loadReferencedAccounts() {
  const [adAccounts, users] = await Promise.all([
    services.getAdAccounts(),
    services.getUsers(),
  ]);
  return utils.matchReferencedAccounts(adAccounts, users);
}

/* -------------------------------------------------------------------------- */
/*                                  ROUTES                                    */
/* -------------------------------------------------------------------------- */

/**
 * POST /passwords/reminders/user — relance d'un utilisateur précis.
 * Body : { email }
 */
export async function sendUserReminder(req) {
  utils.assertCanSendReminders(req.payload);

  const { email } = v.userReminderSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );
  const cfg = utils.getReminderConfig();

  const wait = cooldowns.remaining(email, cfg.cooldownMs);
  if (wait > 0) {
    throw new Error(`PWD_REMINDER_TOO_RECENT_[${utils.formatDuration(wait)}]`);
  }

  const user = await services.getUserByEmail(email);
  if (!user?.USRACTV) throw new Error("USER_NOT_FOUND");

  const [info] = await services.getAdAccounts({ email });
  if (!info) throw new Error("PWD_REMINDER_AD_ACCOUNT_NOT_FOUND");

  const status = utils.getPasswordStatus(info, cfg.defaultDays);
  if (status === "never") throw new Error("PWD_REMINDER_NOT_APPLICABLE");

  const recipient = { info, user, status };
  await sendReminder(recipient);

  logger.info(
    `[PASSWORDS] Relance manuelle envoyée à ${email} (${status}) par ${req.payload?.data?.email ?? "?"}`,
  );

  return { ...toSummary(recipient), result: "sent" };
}

/**
 * POST /passwords/reminders — relance générale.
 * Body : { days?: number, dryRun?: boolean }
 * dryRun = true : aucun envoi, renvoie la liste des destinataires (pour
 * afficher un récapitulatif avant confirmation côté front).
 */
export async function sendGeneralReminder(req) {
  utils.assertCanSendReminders(req.payload);

  const params = v.generalReminderSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );
  const cfg = utils.getReminderConfig();
  const days = params.days ?? cfg.defaultDays;

  const recipients = utils.selectManualRecipients(
    await loadReferencedAccounts(),
    days,
  );

  if (params.dryRun) {
    return {
      dryRun: true,
      days,
      total: recipients.length,
      recipients: recipients.map(toSummary),
    };
  }

  const results = await utils.mapWithConcurrency(
    recipients,
    cfg.concurrency,
    (r) => deliver(r, { respectCooldown: true }),
  );
  const summary = aggregate(results);

  logger.info(
    `[PASSWORDS] Relance générale (≤ ${days} j) par ${req.payload?.data?.email ?? "?"} : ${summary.sent} envoyée(s), ${summary.skipped} ignorée(s), ${summary.failed} échec(s).`,
  );

  return { dryRun: false, days, ...summary };
}

/**
 * Tâche planifiée (cf. routes.js). Ne respecte pas le cooldown manuel (elle
 * ne tourne qu'une fois par jour ouvré) mais l'alimente, pour qu'un clic
 * manuel juste après ne renvoie pas le même mail.
 */
export async function runScheduledReminders(now = new Date()) {
  const cfg = utils.getReminderConfig();
  const recipients = utils.selectScheduledRecipients(
    await loadReferencedAccounts(),
    now,
  );

  const results = await utils.mapWithConcurrency(
    recipients,
    cfg.concurrency,
    (r) => deliver(r, { respectCooldown: false }),
  );
  const summary = aggregate(results);

  logger.info(
    `[PASSWORDS][SCHEDULED] Paliers [${cfg.tiers.join(", ")}] : ${summary.sent} envoyée(s), ${summary.failed} échec(s) sur ${summary.total}.`,
  );

  return summary;
}

/**
 * POST /passwords/reminders/scheduled/run — DEV uniquement : exécute la
 * tâche planifiée immédiatement (date simulable via body.date).
 */
export async function runScheduledRemindersNow(req) {
  utils.assertCanSendReminders(req.payload);
  const { date } = v.scheduledRunSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );
  return runScheduledReminders(date ?? new Date());
}
