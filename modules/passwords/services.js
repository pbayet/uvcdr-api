/* ─────────────────────────────────────────────
   Module "passwords" — accès aux données externes

   Aucune table propre : les données viennent de l'Active Directory
   (getPasswordExpirations, core/middlewares/auth.middleware.js) et de
   users-manager (sp_GetUsers_JSON, modules/usersmanager/services.js). Ce
   fichier isole ces dépendances pour que controllers.js reste testable
   (vi.mock de ce seul fichier).
───────────────────────────────────────────── */

import { getPasswordExpirations } from "../../core/middlewares/auth.middleware.js";
import { sendTemplatedMail } from "../../core/services/mail.service.js";
import * as usersmanagerServices from "../usersmanager/services.js";

export const MAIL_TEMPLATE = "passwords/expiration";

/** Comptes AD actifs (tous, ou filtrés sur un/des emails). */
export async function getAdAccounts({ email, emails } = {}) {
  return getPasswordExpirations({ email, emails, includeDisabled: false });
}

/** Tous les utilisateurs users-manager (actifs et inactifs, filtrés ensuite). */
export async function getUsers() {
  return usersmanagerServices.getUsers();
}

/** Utilisateur users-manager par email — lève USER_NOT_FOUND si absent. */
export async function getUserByEmail(email) {
  const rows = await usersmanagerServices.getUserByEmail(email);
  return rows[0] ?? null;
}

export async function sendReminderMail({ to, subject, data, from }) {
  // Rappel personnel (expiration de mot de passe) : pas de copies mails.
  return sendTemplatedMail({
    template: MAIL_TEMPLATE,
    to,
    subject,
    data,
    from,
    noMailCopies: true,
  });
}
