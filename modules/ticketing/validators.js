import { z } from "zod";

/**
 * Champ optionnel "effaçable" : `""` (champ de formulaire vide, ou `null`
 * converti en `""` par un envoi multipart/FormData) est traité comme `null`
 * (= effacer la valeur). Sans ce prétraitement, `z.coerce.date("")` serait
 * une date invalide et `z.coerce.number("")` vaudrait 0.
 * Absent (`undefined`) reste absent → valeur existante conservée en mise à
 * jour (cf. controllers.updateTicket).
 */
const clearable = (schema) =>
  z.preprocess((v) => (v === "" ? null : v), schema.nullish());

/**
 * Schémas zod remplaçant les `if (!champ) throw new Error(...)` manuels
 * répétés dans les contrôleurs de V1.0.0 (cf. audit dette technique 4.4 —
 * zod était déjà une dépendance mais quasiment jamais utilisé).
 */

/**
 * Cohérence DATDEB/DATFIN (planification prévisionnelle du ticket, cf.
 * sql/TICKETS.add-DATDEB-DATFIN.sql) et DATDEBREEL/DATFINREEL (dates
 * réelles, cf. sql/TICKETS.add-DATDEBREEL-DATFINREEL.sql) : pour chaque
 * couple, si les deux dates sont fournies, la date de début ne doit pas
 * être postérieure à la date de fin. Une seule des deux (ou aucune) reste
 * valide — un ticket peut n'avoir qu'une échéance de fin, ou qu'un début,
 * sans que ce soit une erreur.
 */
function refineDateRange(data, ctx) {
  if (
    data.DATDEB &&
    data.DATFIN &&
    new Date(data.DATDEB) > new Date(data.DATFIN)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["DATFIN"],
      message: "La date de fin ne peut pas être antérieure à la date de début.",
    });
  }
  // Dates réelles (cf. sql/TICKETS.add-DATDEBREEL-DATFINREEL.sql) : même
  // règle de cohérence, indépendante du couple prévisionnel ci-dessus.
  if (
    data.DATDEBREEL &&
    data.DATFINREEL &&
    new Date(data.DATDEBREEL) > new Date(data.DATFINREEL)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["DATFINREEL"],
      message:
        "La date de fin réelle ne peut pas être antérieure à la date de début réelle.",
    });
  }
}

export const ticketCreateSchema = z
  .object({
    TITLE: z.string().trim().min(1, "TITLE est obligatoire.").max(255),
    DESCR: z.string().trim().max(2000).nullish(),
    USRID: z.coerce.number().int().nullish(),
    SRVID: z.coerce.number().int("SRVID est obligatoire."),
    STSID: z.coerce.number().int().nullish(),
    CATID: z.coerce.number().int().nullish(),
    SC1ID: z.coerce.number().int().nullish(),
    SC2ID: clearable(z.coerce.number().int()),
    SC3ID: clearable(z.coerce.number().int()),
    PRIID: z.coerce.number().int().nullish(),
    ASGUSR: z.coerce.number().int().nullish(),
    CCUSRIDS: z
      .array(z.coerce.number().int())
      .max(50, "50 destinataires en copie maximum.")
      .optional(),
    PRJIDS: z
      .array(z.coerce.number().int())
      .max(50, "50 projets maximum.")
      .optional(),
    // Services supplémentaires co-attribués au ticket, en plus de SRVID
    // (cf. sql/TICKETSERVICES.table.sql) — mêmes droits d'accès/action que
    // le service principal. Optionnel : absent → aucun service
    // supplémentaire à la création.
    SRVIDS: z
      .array(z.coerce.number().int())
      .max(20, "20 services supplémentaires maximum.")
      .optional(),
    // Planification prévisionnelle (cf. sql/TICKETS.add-DATDEB-DATFIN.sql).
    DATDEB: clearable(
      z.coerce.date({
        invalid_type_error: "DATDEB doit être une date valide.",
      }),
    ),
    DATFIN: clearable(
      z.coerce.date({
        invalid_type_error: "DATFIN doit être une date valide.",
      }),
    ),
    // Dates réelles (cf. sql/TICKETS.add-DATDEBREEL-DATFINREEL.sql).
    DATDEBREEL: clearable(
      z.coerce.date({
        invalid_type_error: "DATDEBREEL doit être une date valide.",
      }),
    ),
    DATFINREEL: clearable(
      z.coerce.date({
        invalid_type_error: "DATFINREEL doit être une date valide.",
      }),
    ),
    // Temps passé, en minutes — représentation alternative aux dates
    // ci-dessus (cf. sql/TICKETS.add-TPSPREV-TPSREEL.sql).
    TPSPREV: clearable(
      z.coerce
        .number()
        .int("TPSPREV doit être un nombre entier de minutes.")
        .nonnegative("TPSPREV ne peut pas être négatif."),
    ),
    TPSREEL: clearable(
      z.coerce
        .number()
        .int("TPSREEL doit être un nombre entier de minutes.")
        .nonnegative("TPSREEL ne peut pas être négatif."),
    ),
  })
  .superRefine(refineDateRange);

export const ticketUpdateSchema = z
  .object({
    TCKNUM: z.string().trim().min(1, "TCKNUM est obligatoire."),
    TITLE: z.string().trim().min(1).max(255).optional(),
    DESCR: z.string().trim().max(2000).nullish(),
    CATID: z.coerce.number().int().nullish(),
    SC1ID: z.coerce.number().int().nullish(),
    SC2ID: clearable(z.coerce.number().int()),
    SC3ID: clearable(z.coerce.number().int()),
    PRIID: z.coerce.number().int().nullish(),
    USRID: z.coerce.number().int().nullish(),
    SRVID: z.coerce.number().int().optional(),
    ASGUSR: z.coerce.number().int().nullish(),
    STSID: z.coerce.number().int().optional(),
    CMNT: z.string().trim().max(4000).nullish(),
    SRVCHD: z.coerce.boolean().optional(),
    CCUSRIDS: z
      .array(z.coerce.number().int())
      .max(50, "50 destinataires en copie maximum.")
      .optional(),
    PRJIDS: z
      .array(z.coerce.number().int())
      .max(50, "50 projets maximum.")
      .optional(),
    // Services supplémentaires (cf. ticketCreateSchema plus haut) : absent
    // du payload → liste inchangée ; présent (même vide) → remplace la
    // liste complète (cf. services.setTicketServices, motif "delsert").
    SRVIDS: z
      .array(z.coerce.number().int())
      .max(20, "20 services supplémentaires maximum.")
      .optional(),
    // Planification prévisionnelle (cf. sql/TICKETS.add-DATDEB-DATFIN.sql).
    // Absent du payload → champ inchangé (cf. controllers.updateTicket) ;
    // present à null → efface la date existante.
    DATDEB: clearable(
      z.coerce.date({
        invalid_type_error: "DATDEB doit être une date valide.",
      }),
    ),
    DATFIN: clearable(
      z.coerce.date({
        invalid_type_error: "DATFIN doit être une date valide.",
      }),
    ),
    // Dates réelles (cf. sql/TICKETS.add-DATDEBREEL-DATFINREEL.sql). Même
    // motif que DATDEB/DATFIN ci-dessus.
    DATDEBREEL: clearable(
      z.coerce.date({
        invalid_type_error: "DATDEBREEL doit être une date valide.",
      }),
    ),
    DATFINREEL: clearable(
      z.coerce.date({
        invalid_type_error: "DATFINREEL doit être une date valide.",
      }),
    ),
    // Temps passé, en minutes (cf. sql/TICKETS.add-TPSPREV-TPSREEL.sql).
    // Même motif que DATDEB/DATFIN ci-dessus (absent = inchangé, null = efface).
    TPSPREV: clearable(
      z.coerce
        .number()
        .int("TPSPREV doit être un nombre entier de minutes.")
        .nonnegative("TPSPREV ne peut pas être négatif."),
    ),
    TPSREEL: clearable(
      z.coerce
        .number()
        .int("TPSREEL doit être un nombre entier de minutes.")
        .nonnegative("TPSREEL ne peut pas être négatif."),
    ),
  })
  .superRefine(refineDateRange);

/* ─────────────────────────────────────────────
   CC — Destinataires en copie
───────────────────────────────────────────── */
export const ticketCcListSchema = z.object({
  TCKNUM: z.string().trim().min(1, "TCKNUM est obligatoire."),
});

export const ticketCcSetSchema = z.object({
  TCKNUM: z.string().trim().min(1, "TCKNUM est obligatoire."),
  CCUSRIDS: z
    .array(z.coerce.number().int())
    .max(50, "50 destinataires en copie maximum.")
    .default([]),
});

export const ticketDeleteSchema = z.object({
  TCKNUM: z.string().trim().min(1, "TCKNUM est obligatoire."),
  DLTD: z.coerce.boolean().optional(),
  PERM: z.coerce.boolean().optional(),
});

/* ─────────────────────────────────────────────
   VUES — Dernière consultation (puce "non vu")
───────────────────────────────────────────── */
export const ticketSeenSchema = z.object({
  TCKNUM: z.string().trim().min(1, "TCKNUM est obligatoire."),
});

export const categoryCreateSchema = z.object({
  NAME: z.string().trim().min(1, "NAME est obligatoire.").max(100),
  DESCR: z.string().trim().max(1000).nullish(),
});

export const categoryUpdateSchema = categoryCreateSchema.extend({
  ACTIVE: z.coerce.boolean().optional(),
});

export const subcategoryCreateSchema = categoryCreateSchema;
export const subcategoryUpdateSchema = categoryUpdateSchema;

export const serviceCreateSchema = z.object({
  NAME: z.string().trim().min(1, "NAME est obligatoire.").max(255),
  DESCR: z.string().trim().max(500).nullish(),
});

export const serviceUpdateSchema = serviceCreateSchema.extend({
  ACTIVE: z.coerce.boolean().optional(),
});

export const serviceMemberSchema = z.object({
  USRID: z.coerce.number().int("USRID est obligatoire."),
  ACTIVE: z.coerce.boolean().optional(),
});

export const serviceMemberUpdateSchema = z.object({
  ACTIVE: z.coerce.boolean(),
});

export const noteCreateSchema = z.object({
  TCKID: z.coerce.number().int("TCKID est obligatoire."),
  CMNT: z.string().trim().min(1, "CMNT est obligatoire.").max(2000),
  PUBLIC: z.coerce.boolean().optional(),
});

export const noteUpdateSchema = z.object({
  NTEID: z.coerce.number().int("NTEID est obligatoire."),
  CMNT: z.string().trim().min(1, "CMNT est obligatoire.").max(2000),
  PUBLIC: z.coerce.boolean().optional(),
});

export const noteDeleteSchema = z.object({
  NTEID: z.coerce.number().int("NTEID est obligatoire."),
});

/* ─────────────────────────────────────────────
   TODOS
───────────────────────────────────────────── */
export const todoListSchema = z.object({
  TCKID: z.coerce.number().int().optional(),
});

export const todoCreateSchema = z.object({
  TCKID: z.coerce.number().int("TCKID est obligatoire."),
  LABEL: z.string().trim().min(1, "LABEL est obligatoire.").max(500),
  PUBLIC: z.coerce.boolean().optional(),
  SECTION: z.string().trim().max(50).optional(),
});

export const todoUpdateSchema = z.object({
  TDOID: z.coerce.number().int("TDOID est obligatoire."),
  LABEL: z
    .string()
    .trim()
    .min(1, "LABEL ne peut pas être vide.")
    .max(500)
    .optional(),
  DONE: z.coerce.boolean().optional(),
  PUBLIC: z.coerce.boolean().optional(),
  // "" explicite = retire la section ; absent = ne touche pas au champ (cf. updateTodo, COALESCE côté service).
  SECTION: z.string().trim().max(50).optional(),
});

export const todoDeleteSchema = z.object({
  TDOID: z.coerce.number().int("TDOID est obligatoire."),
});

/* ─────────────────────────────────────────────
   LIAISONS — Tickets liés
───────────────────────────────────────────── */
// TCKNUM absent = mode "bulk" (toutes les liaisons visibles par
// l'utilisateur courant, cf. controllers.getTicketLinks / services.getAllTicketLinks)
// plutôt que les liaisons d'un seul ticket — utilisé par le Kanban pour
// repérer/mettre en avant les tickets liés sans ouvrir chaque fiche.
export const ticketLinkListSchema = z.object({
  TCKNUM: z.string().trim().min(1).optional(),
});

export const ticketLinkCreateSchema = z.object({
  TCKNUM: z.string().trim().min(1, "TCKNUM est obligatoire."),
  LINKEDTCKNUM: z.string().trim().min(1, "LINKEDTCKNUM est obligatoire."),
});

export const ticketLinkDeleteSchema = z.object({
  LNKID: z.coerce.number().int("LNKID est obligatoire."),
});

/* ─────────────────────────────────────────────
   FUSION — Tickets fusionnés
───────────────────────────────────────────── */
export const ticketMergeListSchema = z.object({
  TCKNUM: z.string().trim().min(1, "TCKNUM est obligatoire."),
});

export const ticketMergeSchema = z.object({
  TCKNUM: z.string().trim().min(1, "TCKNUM est obligatoire."),
  MEMBERTCKNUMS: z
    .array(z.string().trim().min(1))
    .min(1, "Sélectionnez au moins un autre ticket à fusionner.")
    .max(20, "20 tickets maximum par fusion."),
  // Statut à conserver, choisi explicitement par l'utilisateur. Absent →
  // règle de priorité par défaut (cf. controllers.mergeTickets).
  STSID: z.coerce.number().int().nullish(),
});

export const ticketUnmergeSchema = z.object({
  TCKNUM: z.string().trim().min(1, "TCKNUM est obligatoire."),
});

/* ─────────────────────────────────────────────
   PROJECTS
───────────────────────────────────────────── */
export const projectCreateSchema = z.object({
  NAME: z.string().trim().min(1, "NAME est obligatoire.").max(150),
  DESCR: z.string().trim().max(1000).nullish(),
  COLOR: z.string().trim().max(20).nullish(),
});

export const projectUpdateSchema = projectCreateSchema.extend({
  ACTIVE: z.coerce.boolean().optional(),
});

export const projectUsersSchema = z.object({
  USRIDS: z
    .array(z.coerce.number().int())
    .max(200, "200 utilisateurs associés maximum.")
    .optional(),
});

/* ─────────────────────────────────────────────
   USERSETTINGS — Préférences utilisateur (module ticketing)
───────────────────────────────────────────── */
export const userSettingsSchema = z
  .object({
    SHOWTASKSINFORM: z.coerce.boolean().optional(),
    AUTOSAVETICKET: z.coerce.boolean().optional(),
    MAILONCC: z.coerce.boolean().optional(),
    MAILONPROJECT: z.coerce.boolean().optional(),
  })
  .refine(
    (data) => Object.keys(data).length > 0,
    "Aucune préférence à mettre à jour.",
  );
