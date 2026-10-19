import { ConfidentialClientApplication } from "@azure/msal-node";
import { logger } from "../../config/logger.config.js";

/**
 * Service Outlook / Calendrier générique, appelable directement depuis
 * n'importe quel module (ex: ticketing, declcav, usersmanager...) via un
 * simple import JS — même logique que core/services/mail.service.js.
 *
 * Volontairement pas de route HTTP exposée par défaut : même raison que pour
 * le service mail (cf. audit sécurité V1.0.0 — un déclencheur HTTP arbitraire
 * et non authentifié est une source de faille). Si un module a besoin d'un
 * déclencheur HTTP (ex: bouton "Ajouter à mon agenda" sur un ticket), il doit
 * exposer sa propre route authentifiée qui appelle ce service en interne.
 *
 * ---------------------------------------------------------------------------
 * Choix d'architecture
 * ---------------------------------------------------------------------------
 * - API : Microsoft Graph (v1.0), ressource /users/{mailbox}/events.
 *   Nécessite que les boîtes cibles soient sur Microsoft 365 / Exchange
 *   Online (Graph ne fonctionne pas sur un Exchange on-premise pur — il
 *   faudrait alors EWS, non implémenté ici).
 * - Auth : "client credentials" (app-only, MSAL), PAS de connexion déléguée
 *   utilisateur. L'App Registration Azure AD utilisée doit avoir la
 *   permission APPLICATION "Calendars.ReadWrite" avec consentement admin —
 *   c'est ce qui permet au service de créer un événement dans la boîte de
 *   n'importe quel utilisateur (ou boîte partagée) de l'organisation sans
 *   qu'aucun utilisateur ne soit connecté / sans refresh token à maintenir.
 *   C'est le sens de "générique / commun à toutes les applis" demandé : le
 *   service ne dépend d'aucune session utilisateur.
 * - Boîte organisatrice : passée explicitement par l'appelant (`mailbox`,
 *   UPN ou id Graph, ex: "p.bayet@union-vignerons.com"), ou repliée sur
 *   OUTLOOK_DEFAULT_MAILBOX (ex: une boîte de service type
 *   "calendrier-technique@union-vignerons.com") si non fournie. Le choix
 *   "dans la boîte de qui créer l'événement" reste métier, donc laissé à
 *   l'appelant au cas par cas plutôt que figé ici.
 * - Un seul type de ressource Graph ("event") sous-tend les 3 notions
 *   métier demandées (événement générique, rappel, réunion) : trois
 *   fonctions haut niveau (createEvent / createReminder / createMeeting)
 *   sont fournies comme sucre syntaxique au-dessus de createCalendarEvent(),
 *   pour éviter à chaque module de reconstruire le payload Graph à la main.
 *
 * ---------------------------------------------------------------------------
 * Configuration requise (config/env/*.env) :
 *   AZURE_TENANT_ID          - tenant Azure AD (GUID ou nom de domaine)
 *   AZURE_CLIENT_ID          - client id de l'App Registration
 *   AZURE_CLIENT_SECRET      - secret de l'App Registration
 *   OUTLOOK_DEFAULT_MAILBOX  - boîte organisatrice par défaut (optionnel,
 *                              requis seulement si `mailbox` n'est pas fourni
 *                              à chaque appel)
 *   OUTLOOK_DEFAULT_TIMEZONE - fuseau horaire par défaut (optionnel, défaut
 *                              "Romance Standard Time" = Europe/Paris ; le
 *                              nom de fuseau IANA "Europe/Paris" est aussi
 *                              accepté par Graph)
 *
 * ---------------------------------------------------------------------------
 * Exemple d'utilisation depuis un module (ex: ticketing) :
 *
 *   import { createMeeting } from "../../core/services/outlook.service.js";
 *
 *   const event = await createMeeting({
 *     subject: `Point ticket ${ticket.TCKCOD} — ${ticket.TITLE}`,
 *     start: "2026-09-20T14:00:00",
 *     end: "2026-09-20T14:30:00",
 *     attendees: [
 *       { name: "Alexandre VERGNES", email: "a.vergnes@union-vignerons.com" },
 *     ],
 *     description: `Ticket ${ticket.TCKCOD} : ${ticket.TITLE}`,
 *   });
 *   // event.id à conserver (ex: colonne OUTLOOKEVTID sur TICKETS) pour
 *   // pouvoir updateCalendarEvent()/deleteCalendarEvent() ensuite.
 */

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const DEFAULT_TIMEZONE =
  process.env.OUTLOOK_DEFAULT_TIMEZONE || "Romance Standard Time";
const GRAPH_SCOPES = ["https://graph.microsoft.com/.default"];

let msalClient = null;

/**
 * Crée (une seule fois) le client MSAL "confidential" (app-only). Lève
 * OUTLOOK_NOT_CONFIGURED si les variables Azure AD obligatoires ne sont pas
 * renseignées, plutôt que de planter au démarrage de l'API — l'intégration
 * Outlook est une dépendance optionnelle pour la plupart des modules (même
 * logique que mail.service.js / getTransporter()).
 */
function getMsalClient() {
  if (msalClient) return msalClient;

  const { AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET } = process.env;

  if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET) {
    throw new Error("OUTLOOK_NOT_CONFIGURED");
  }

  msalClient = new ConfidentialClientApplication({
    auth: {
      clientId: AZURE_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${AZURE_TENANT_ID}`,
      clientSecret: AZURE_CLIENT_SECRET,
    },
  });

  return msalClient;
}

/**
 * Récupère un access token app-only pour Microsoft Graph. MSAL gère lui-même
 * la mise en cache et le renouvellement (le token n'est redemandé au
 * endpoint Azure AD que lorsque le précédent est expiré) — pas de cache
 * maison nécessaire ici.
 */
async function getAccessToken() {
  const client = getMsalClient();

  let result;
  try {
    result = await client.acquireTokenByClientCredential({
      scopes: GRAPH_SCOPES,
    });
  } catch (err) {
    // MSAL renvoie ici une AuthError/ServerError avec errorCode/errorMessage
    // exploitables (ex: invalid_client, unauthorized_client, AADSTS7000215
    // secret invalide/expiré, AADSTS90002 tenant introuvable...). On les
    // journalise explicitement car error.middleware.js ne loggue que
    // err.message, qui serait sinon juste "OUTLOOK_AUTH_FAILED" — sans ça,
    // impossible de diagnostiquer la cause réelle depuis les logs serveur.
    logger.error(
      `[OUTLOOK][AUTH] acquireTokenByClientCredential a échoué | errorCode: ${err.errorCode || "?"} | ${err.errorMessage || err.message}`,
    );
    throw new Error("OUTLOOK_AUTH_FAILED", { cause: err });
  }

  if (!result?.accessToken) {
    logger.error("[OUTLOOK][AUTH] acquireTokenByClientCredential a réussi sans renvoyer d'accessToken.");
    throw new Error("OUTLOOK_AUTH_FAILED");
  }

  return result.accessToken;
}

/**
 * Appel bas niveau à Microsoft Graph, avec gestion d'erreur uniforme. Les
 * erreurs Graph (4xx/5xx) sont remontées avec le code d'erreur Graph en
 * cause (`err.cause.graphCode`) pour permettre à l'appelant de distinguer
 * ex. "ErrorInvalidUser" (mailbox inconnue) d'un vrai souci de config.
 */
async function graphRequest(method, path, body) {
  const accessToken = await getAccessToken();

  const response = await fetch(`${GRAPH_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) return null;

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const graphCode = payload?.error?.code;
    const graphMessage = payload?.error?.message;

    logger.error(
      `[OUTLOOK] Échec ${method} ${path} — HTTP ${response.status}${graphCode ? ` (${graphCode})` : ""}${graphMessage ? ` : ${graphMessage}` : ""}`,
    );

    throw new Error("OUTLOOK_GRAPH_ERROR", {
      cause: { status: response.status, graphCode, graphMessage, raw: payload },
    });
  }

  return payload;
}

function toGraphDateTime(value, timeZone) {
  const dateTime =
    value instanceof Date ? value.toISOString().slice(0, 19) : String(value);
  return { dateTime, timeZone };
}

function toGraphAttendees(attendees = []) {
  return attendees.map(({ name, email, required = true }) => {
    if (!email) throw new Error("OUTLOOK_INVALID_ATTENDEE");
    return {
      emailAddress: { address: email, name: name || email },
      type: required ? "required" : "optional",
    };
  });
}

/**
 * Construit le corps de requête Graph pour une ressource "event", commun aux
 * 3 wrappers haut niveau (createEvent / createReminder / createMeeting) et à
 * updateCalendarEvent().
 */
function buildEventPayload({
  subject,
  description,
  descriptionHtml,
  start,
  end,
  timeZone = DEFAULT_TIMEZONE,
  isAllDay = false,
  location,
  attendees,
  isOnlineMeeting = false,
  reminderMinutesBeforeStart,
  isReminderOn,
  categories,
  showAs,
  sensitivity,
}) {
  const payload = {};

  if (subject !== undefined) payload.subject = subject;

  if (description !== undefined || descriptionHtml !== undefined) {
    payload.body = {
      contentType: descriptionHtml ? "HTML" : "Text",
      content: descriptionHtml ?? description ?? "",
    };
  }

  if (start !== undefined) payload.start = toGraphDateTime(start, timeZone);
  if (end !== undefined) payload.end = toGraphDateTime(end, timeZone);
  if (isAllDay !== undefined) payload.isAllDay = isAllDay;

  if (location !== undefined) {
    payload.location =
      typeof location === "string" ? { displayName: location } : location;
  }

  if (attendees !== undefined) payload.attendees = toGraphAttendees(attendees);

  if (isOnlineMeeting) {
    payload.isOnlineMeeting = true;
    payload.onlineMeetingProvider = "teamsForBusiness";
  }

  if (reminderMinutesBeforeStart !== undefined) {
    payload.reminderMinutesBeforeStart = reminderMinutesBeforeStart;
  }
  if (isReminderOn !== undefined) payload.isReminderOn = isReminderOn;
  if (categories !== undefined) payload.categories = categories;
  if (showAs !== undefined) payload.showAs = showAs;
  if (sensitivity !== undefined) payload.sensitivity = sensitivity;

  return payload;
}

function resolveMailbox(mailbox) {
  const resolved = mailbox || process.env.OUTLOOK_DEFAULT_MAILBOX;
  if (!resolved) throw new Error("OUTLOOK_MISSING_MAILBOX");
  return resolved;
}

/**
 * Crée un événement de calendrier Outlook — fonction générique bas niveau,
 * commune aux notions métier "événement" / "rappel" / "réunion" (cf.
 * createEvent / createReminder / createMeeting ci-dessous pour les usages
 * courants).
 *
 * @param {object} options
 * @param {string} [options.mailbox] - UPN ou id Graph de la boîte
 *   organisatrice (défaut OUTLOOK_DEFAULT_MAILBOX)
 * @param {string} options.subject
 * @param {string} [options.description] - texte brut
 * @param {string} [options.descriptionHtml] - HTML, prioritaire sur description
 * @param {string|Date} options.start - ISO local (sans offset) ou Date
 * @param {string|Date} options.end
 * @param {string} [options.timeZone] - défaut OUTLOOK_DEFAULT_TIMEZONE
 * @param {boolean} [options.isAllDay]
 * @param {string|object} [options.location] - libellé ou objet Graph "location"
 * @param {Array<{name?: string, email: string, required?: boolean}>} [options.attendees]
 * @param {boolean} [options.isOnlineMeeting] - ajoute un lien Teams (réunion en ligne)
 * @param {number} [options.reminderMinutesBeforeStart]
 * @param {boolean} [options.isReminderOn]
 * @param {string[]} [options.categories]
 * @param {"free"|"tentative"|"busy"|"oof"|"workingElsewhere"} [options.showAs]
 * @param {"normal"|"personal"|"private"|"confidential"} [options.sensitivity]
 * @returns {Promise<object>} l'événement Graph créé (contient `id`, `webLink`,
 *   et `onlineMeeting.joinUrl` si `isOnlineMeeting`)
 */
export async function createCalendarEvent({
  mailbox,
  subject,
  start,
  end,
  ...rest
}) {
  if (!subject) throw new Error("OUTLOOK_MISSING_SUBJECT");
  if (!start) throw new Error("OUTLOOK_MISSING_START");
  if (!end) throw new Error("OUTLOOK_MISSING_END");

  const resolvedMailbox = resolveMailbox(mailbox);
  const payload = buildEventPayload({ subject, start, end, ...rest });

  const event = await graphRequest(
    "POST",
    `/users/${encodeURIComponent(resolvedMailbox)}/events`,
    payload,
  );

  logger.info(
    `[OUTLOOK] Événement créé dans ${resolvedMailbox} : "${subject}" (id=${event.id})`,
  );

  return event;
}

/**
 * Met à jour un événement existant (patch partiel — ne fournir que les
 * champs à modifier).
 *
 * @param {object} options
 * @param {string} [options.mailbox] - défaut OUTLOOK_DEFAULT_MAILBOX
 * @param {string} options.eventId
 * ...mêmes champs optionnels que createCalendarEvent (sauf mailbox/eventId)
 */
export async function updateCalendarEvent({ mailbox, eventId, ...rest }) {
  if (!eventId) throw new Error("OUTLOOK_MISSING_EVENT_ID");

  const resolvedMailbox = resolveMailbox(mailbox);
  const payload = buildEventPayload(rest);

  const event = await graphRequest(
    "PATCH",
    `/users/${encodeURIComponent(resolvedMailbox)}/events/${encodeURIComponent(eventId)}`,
    payload,
  );

  logger.info(
    `[OUTLOOK] Événement ${eventId} mis à jour dans ${resolvedMailbox}`,
  );

  return event;
}

/**
 * Supprime un événement de calendrier (annulation d'une réunion/rappel).
 *
 * @param {object} options
 * @param {string} [options.mailbox] - défaut OUTLOOK_DEFAULT_MAILBOX
 * @param {string} options.eventId
 */
export async function deleteCalendarEvent({ mailbox, eventId }) {
  if (!eventId) throw new Error("OUTLOOK_MISSING_EVENT_ID");

  const resolvedMailbox = resolveMailbox(mailbox);

  await graphRequest(
    "DELETE",
    `/users/${encodeURIComponent(resolvedMailbox)}/events/${encodeURIComponent(eventId)}`,
  );

  logger.info(
    `[OUTLOOK] Événement ${eventId} supprimé dans ${resolvedMailbox}`,
  );
}

/**
 * Récupère un événement existant (utile pour vérifier son statut avant une
 * mise à jour, ou récupérer le lien Teams généré après coup).
 *
 * @param {object} options
 * @param {string} [options.mailbox] - défaut OUTLOOK_DEFAULT_MAILBOX
 * @param {string} options.eventId
 */
export async function getCalendarEvent({ mailbox, eventId }) {
  if (!eventId) throw new Error("OUTLOOK_MISSING_EVENT_ID");

  const resolvedMailbox = resolveMailbox(mailbox);

  return graphRequest(
    "GET",
    `/users/${encodeURIComponent(resolvedMailbox)}/events/${encodeURIComponent(eventId)}`,
  );
}

/**
 * Événement générique — alias direct de createCalendarEvent(), fourni pour
 * la symétrie avec createReminder()/createMeeting() (vocabulaire métier
 * "événement / rappel / réunion").
 */
export const createEvent = createCalendarEvent;

/**
 * Rappel — événement sans participant, avec rappel Outlook activé. Pratique
 * pour une échéance interne (ex: relance à faire, date limite d'un ticket)
 * sans notifier/inviter personne d'autre que le propriétaire de la boîte.
 *
 * `end` est optionnel : par défaut, un rappel dure 15 minutes après `start`
 * (bloc court, purement indicatif dans le calendrier).
 *
 * @param {object} options
 * @param {string} [options.mailbox] - défaut OUTLOOK_DEFAULT_MAILBOX
 * @param {string} options.subject
 * @param {string|Date} options.start
 * @param {string|Date} [options.end] - défaut start + 15 min
 * @param {string} [options.timeZone]
 * @param {string} [options.description]
 * @param {number} [options.reminderMinutesBeforeStart] - défaut 15
 */
export async function createReminder({
  mailbox,
  subject,
  start,
  end,
  timeZone = DEFAULT_TIMEZONE,
  reminderMinutesBeforeStart = 15,
  ...rest
}) {
  if (!start) throw new Error("OUTLOOK_MISSING_START");

  const resolvedEnd =
    end ?? new Date(new Date(start).getTime() + 15 * 60_000).toISOString();

  return createCalendarEvent({
    mailbox,
    subject,
    start,
    end: resolvedEnd,
    timeZone,
    isReminderOn: true,
    reminderMinutesBeforeStart,
    showAs: "free",
    ...rest,
  });
}

/**
 * Réunion — événement avec participants (invitations envoyées par Outlook)
 * et, par défaut, un lien Microsoft Teams.
 *
 * @param {object} options
 * @param {string} [options.mailbox] - défaut OUTLOOK_DEFAULT_MAILBOX
 * @param {string} options.subject
 * @param {string|Date} options.start
 * @param {string|Date} options.end
 * @param {string} [options.timeZone]
 * @param {Array<{name?: string, email: string, required?: boolean}>} options.attendees
 * @param {boolean} [options.isOnlineMeeting] - défaut true (lien Teams)
 * @param {string|object} [options.location]
 * @param {string} [options.description]
 */
export async function createMeeting({
  mailbox,
  subject,
  start,
  end,
  timeZone = DEFAULT_TIMEZONE,
  attendees,
  isOnlineMeeting = true,
  ...rest
}) {
  if (!attendees?.length) throw new Error("OUTLOOK_MISSING_ATTENDEES");

  return createCalendarEvent({
    mailbox,
    subject,
    start,
    end,
    timeZone,
    attendees,
    isOnlineMeeting,
    ...rest,
  });
}
