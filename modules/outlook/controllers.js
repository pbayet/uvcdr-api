import * as requestUtils from "../../core/utils/request.utils.js";
import { createEventSchema } from "./validators.js";
import { createCalendarEvent } from "../../core/services/outlook.service.js";

/**
 * Crée un événement de calendrier Outlook.
 *
 * Route volontairement générique (cf. modules/outlook/routes.js) : un même
 * champ `subject`/`start`/`end` + champs optionnels couvre les 3 usages
 * métier (événement simple, rappel via reminderMinutesBeforeStart/
 * isReminderOn, réunion via attendees/isOnlineMeeting) sans multiplier les
 * endpoints — c'est à l'appelant (le module métier : ticketing, declcav...)
 * de choisir quels champs renseigner selon son besoin.
 */
export async function createEvent(req) {
  const payload = createEventSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  payload.mailbox = payload.mailbox || req?.payload?.data?.email;

  const event = await createCalendarEvent(payload);

  // Réponse volontairement réduite au strict nécessaire pour l'appelant
  // (id à conserver pour update/delete ultérieurs, liens utiles) plutôt que
  // l'objet Graph complet — évite de figer les modules appelants sur la
  // forme exacte de la réponse Graph, qui peut évoluer.
  return {
    id: event.id,
    webLink: event.webLink,
    onlineMeetingUrl: event.onlineMeeting?.joinUrl ?? null,
  };
}
