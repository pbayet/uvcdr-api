import { z } from "zod";

/**
 * Schémas zod du module outlook — même logique que
 * modules/ticketing/validators.js (remplace les vérifications manuelles
 * dans les contrôleurs, erreurs renvoyées en 400 via error.middleware.js).
 */

/**
 * Date/heure locale "naïve" (sans fuseau), au format attendu par la
 * ressource Graph `dateTimeTimeZone` (ex: "2026-09-20T14:00:00"). Le fuseau
 * est fourni séparément via `timeZone` — surtout PAS de suffixe "Z"/offset
 * ici, sous peine de double conversion (Graph interpréterait `dateTime`
 * comme une heure locale dans `timeZone`, quoi qu'il contienne).
 */
const localDateTimeSchema = z
  .string()
  .trim()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/,
    "doit être une date/heure locale au format AAAA-MM-JJTHH:mm[:ss], sans fuseau (le fuseau se précise via timeZone).",
  );

const attendeeSchema = z.object({
  name: z.string().trim().max(255).optional(),
  email: z.string().trim().email("email de participant invalide."),
  required: z.boolean().optional(),
});

export const createEventSchema = z
  .object({
    // Boîte organisatrice (UPN) — optionnel, replié sur
    // OUTLOOK_DEFAULT_MAILBOX côté service si absent.
    mailbox: z.string().trim().email("mailbox doit être une adresse email valide.").optional(),

    subject: z.string().trim().min(1, "subject est obligatoire.").max(255),
    description: z.string().trim().max(4000).optional(),
    descriptionHtml: z.string().trim().max(20000).optional(),

    start: localDateTimeSchema,
    end: localDateTimeSchema,
    timeZone: z.string().trim().max(100).optional(),
    isAllDay: z.boolean().optional(),

    location: z.string().trim().max(255).optional(),

    attendees: z.array(attendeeSchema).max(50, "50 participants maximum.").optional(),
    isOnlineMeeting: z.boolean().optional(),

    reminderMinutesBeforeStart: z.coerce.number().int().nonnegative().optional(),
    isReminderOn: z.boolean().optional(),

    categories: z.array(z.string().trim().max(50)).max(20).optional(),
    showAs: z.enum(["free", "tentative", "busy", "oof", "workingElsewhere"]).optional(),
    sensitivity: z.enum(["normal", "personal", "private", "confidential"]).optional(),
  })
  .superRefine((data, ctx) => {
    // Comparaison relative valide même sans fuseau explicite : les deux
    // chaînes sont interprétées de la même façon par Date, donc l'ordre
    // reste correct quel que soit le fuseau réel visé.
    if (new Date(data.start) > new Date(data.end)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end"],
        message: "end ne peut pas être antérieur à start.",
      });
    }
  });
