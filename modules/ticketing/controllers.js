import * as services from "./services.js";
import * as utils from "./utils.js";
import * as requestUtils from "../../core/utils/request.utils.js";
import { broadcastToAll } from "../../config/websocket/wsManager.js";
import * as filesServices from "../files/services.js";
import * as v from "./validators.js";
import {
  sendTemplatedMail,
  renderDetailGroups,
  renderNoteList,
} from "../../core/services/mail.service.js";
import { debounceCollect } from "../../core/utils/debounce.utils.js";
import { logger } from "../../config/logger.config.js";

/* ─────────────────────────────────────────────
   TICKETS — Controllers
   Responsabilité : valider les paramètres (zod), appeler le service,
   formater la réponse, notifier en temps réel.

   Temps réel (décision produit "simplifié") : on diffuse un événement léger
   (IDs uniquement) à TOUS les clients connectés via broadcastToAll, plutôt
   que de recalculer le ticket formaté pour chaque destinataire ciblé comme
   en V1.0.0 (Promise.all + services.getTicket par uid — cf. audit perf 3.4,
   N+1 identifié dans ce même fichier). Chaque client décide lui-même s'il
   doit re-fetcher (GET /ticketing ou /ticketing/:code) suite à l'événement.
   Ça élimine le N+1 ET évite de diffuser le contenu d'un ticket à des
   utilisateurs qui n'y ont pas accès.

   Emails (V1.1.0) : notification par mail sur les événements clés du cycle
   de vie d'un ticket, via le service générique core/services/mail.service.js.
   Destinataires réels par événement (remplace l'ancien destinataire unique
   de développement) :
     - création              → membres du service concerné (SRVID du ticket)
     - modification / statut → créateur du ticket
     - clôture                → créateur du ticket
     - suppression            → créateur du ticket
     - nouvelle note          → si la note vient du créateur (le "demandeur"),
                                les membres du service qui traite le ticket ;
                                si elle vient d'une personne du service, le
                                créateur du ticket.

   Anti auto-notification : un utilisateur ne doit jamais recevoir un email
   pour sa propre action.
     - Création : si le créateur (CREUSR) du ticket est lui-même membre du
       service destinataire (ex: il crée un ticket pour son propre service),
       il est exclu des destinataires "membres du service" — les autres
       membres du service sont notifiés normalement (cf. getServiceRecipients,
       notifyTicketCreated).
     - Modification / statut / clôture / suppression : notification normalement
       adressée au créateur du ticket, mais SAUTÉE si c'est le créateur
       lui-même qui a effectué l'action (ex: il traite son propre ticket) —
       il n'a pas besoin d'être informé de ce qu'il vient de faire. Dès qu'un
       AUTRE membre de son service intervient sur le ticket, la notification
       part normalement (cf. `actorUsrId` sur notifyTicketClosed/
       notifyTicketDeleted/scheduleTicketUpdateNotification).
     - Dans tous les cas, les destinataires "en copie" (TICKETCC) et les
       membres des projets liés au ticket (préférence MAILONPROJECT)
       continuent de recevoir l'email normalement : cette règle anti
       auto-notification ne s'applique qu'au destinataire principal
       (créateur / membres du service), jamais à `getExtraMailRecipients`.
   Comme pour declcav (modules/declcav/controllers.js, même pattern), en
   dehors de la production tous les mails sont redirigés vers
   BASE_RECIPIENT_EMAIL plutôt que les vraies adresses métier, pour ne
   jamais notifier de vrais utilisateurs depuis un environnement de dev/staging.

   Anti-spam (statut & notes) : un changement de statut ou l'ajout d'une note
   déclenchent un email différé plutôt qu'immédiat (cf. debounceCollect,
   core/utils/debounce.utils.js). Si plusieurs changements de statut ou
   plusieurs notes s'enchaînent en peu de temps sur le même ticket, ils sont
   regroupés en un seul email envoyé après une courte période de silence
   (ex: un aller-retour "nouveau → en cours → nouveau → clôturé" ne doit pas
   générer un email par étape). La création, la clôture et la suppression
   restent des actions ponctuelles notifiées immédiatement.

   L'envoi ne doit jamais faire échouer l'opération métier (ex: SMTP non
   configuré en dev, service sans membre, créateur sans email) → toujours
   best-effort, erreurs loguées et avalées avant de sortir de ce fichier.
───────────────────────────────────────────── */

const IS_PROD = process.env.NODE_ENV === "production";
const DEV_FALLBACK_RECIPIENT = process.env.BASE_RECIPIENT_EMAIL;

/**
 * Compare deux valeurs de date potentiellement hétérogènes (Date JS venant
 * du payload zod-coerced côté `resolved`, Date JS renvoyée par mssql côté
 * `ticket` brut) — utilisé pour détecter un changement de planification
 * (cf. updateTicket, groupe "PLANNING"). `null`/`undefined` sont équivalents.
 */
function dateValueDiffers(a, b) {
  const ta = a == null ? null : new Date(a).getTime();
  const tb = b == null ? null : new Date(b).getTime();
  return ta !== tb;
}

/**
 * Vrai si `actorUsrId` (utilisateur ayant déclenché l'action : modification,
 * clôture, suppression...) est le créateur du ticket lui-même — cf.
 * commentaire d'en-tête "Anti auto-notification". `actorUsrId` absent
 * (`null`/`undefined`) est traité comme "pas la même personne" (on notifie
 * par défaut plutôt que de risquer de faire disparaître une notification
 * légitime faute d'information sur l'auteur réel de l'action).
 */
function isSelfAction(ticket, actorUsrId) {
  return (
    actorUsrId != null &&
    ticket?.CREUSR != null &&
    String(actorUsrId) === String(ticket.CREUSR)
  );
}

// Délai de silence avant l'envoi d'un email groupé, et latence max depuis le
// premier événement du lot (cf. debounceCollect). Mêmes valeurs par défaut
// pour statut et notes ; surchargeables indépendamment via l'environnement
// si le besoin diverge en pratique.
const STATUS_MAIL_DEBOUNCE_MS =
  Number(process.env.TICKET_STATUS_MAIL_DEBOUNCE_MS) || 2 * 60 * 1000;
const STATUS_MAIL_DEBOUNCE_MAX_MS =
  Number(process.env.TICKET_STATUS_MAIL_DEBOUNCE_MAX_MS) || 15 * 60 * 1000;
const NOTE_MAIL_DEBOUNCE_MS =
  Number(process.env.TICKET_NOTE_MAIL_DEBOUNCE_MS) || 2 * 60 * 1000;
const NOTE_MAIL_DEBOUNCE_MAX_MS =
  Number(process.env.TICKET_NOTE_MAIL_DEBOUNCE_MAX_MS) || 15 * 60 * 1000;

/**
 * Emails des membres actifs d'un service, en excluant éventuellement un
 * utilisateur (ex: l'auteur d'une note qu'on ne veut pas notifier de son
 * propre message s'il se trouve être aussi membre du service).
 * Ne lève jamais : une erreur de résolution ne doit pas faire échouer
 * l'envoi, juste aboutir à une liste de destinataires vide (loguée par
 * notifyTicketEvent).
 */
async function getServiceRecipients(SRVID, excludeUsrId = null) {
  if (!SRVID) return [];
  const members = (await services.getServiceMemberEmails(SRVID)) ?? [];
  return members
    .filter((m) => !excludeUsrId || String(m.USRID) !== String(excludeUsrId))
    .map((m) => m.EMAIL)
    .filter(Boolean);
}

/**
 * Variante multi-services de `getServiceRecipients` ci-dessus : notifie les
 * membres de TOUS les services d'un ticket (principal + co-attribués via
 * TICKETSERVICES, cf. `ticket.SERVICES`), dédupliqués par email — utilisée
 * pour la notification de création (cf. notifyTicketCreated), le seul
 * événement où tous les services concernés doivent être prévenus dès le
 * départ.
 */
async function getServicesRecipients(SRVIDS, excludeUsrId = null) {
  const ids = [...new Set((SRVIDS ?? []).filter(Boolean))];
  if (!ids.length) return [];
  const members = (await services.getServiceMemberEmailsMulti(ids)) ?? [];
  return [
    ...new Set(
      members
        .filter(
          (m) => !excludeUsrId || String(m.USRID) !== String(excludeUsrId),
        )
        .map((m) => m.EMAIL)
        .filter(Boolean),
    ),
  ];
}

/**
 * Filtre une liste de destinataires {USRID, EMAIL} selon la préférence mail
 * de chacun (cf. services.getUserMailPreferences — USERSETTINGS,
 * MAILONCC/MAILONPROJECT, activées par défaut : un utilisateur sans ligne
 * USERSETTINGS est donc traité comme "reçoit les mails"). `prefKey`
 * désigne la préférence à consulter ("MAILONCC" | "MAILONPROJECT").
 */
async function filterByMailPreference(recipients, prefKey) {
  const withEmail = (recipients ?? []).filter((r) => r?.EMAIL);
  if (!withEmail.length) return [];

  const usrids = withEmail.map((r) => r.USRID).filter((id) => id != null);
  const prefs = await services.getUserMailPreferences(usrids);

  return withEmail
    .filter((r) => (prefs.get(String(r.USRID))?.[prefKey] ?? true) !== false)
    .map((r) => r.EMAIL);
}

/**
 * Emails (avec USRID) des destinataires en copie (CC) d'un ticket déjà
 * formaté (utilise le tableau `CC` imbriqué par utils.formatTicket,
 * alimenté par le LEFT JOIN dbo.TICKETCC de SELECT_TICKETS) — évite une
 * requête supplémentaire pour chaque notification.
 */
function getTicketCcUsers(ticket) {
  return (ticket?.CC ?? [])
    .filter((c) => c.EMAIL)
    .map((c) => ({ USRID: c.USRID, EMAIL: c.EMAIL }));
}

/**
 * Emails (avec USRID) des utilisateurs rattachés à au moins un des projets
 * du ticket (PROJECTUSERS via TICKETPROJECTS, cf. services.
 * getProjectMemberEmails) — destinataires "rattaché à un projet"
 * (préférence MAILONPROJECT), en plus des CC.
 */
async function getTicketProjectUsers(ticket) {
  const prjids = [
    ...new Set((ticket?.PROJECTS ?? []).map((p) => p.PRJID).filter(Boolean)),
  ];
  if (!prjids.length) return [];
  return (await services.getProjectMemberEmails(prjids)) ?? [];
}

/**
 * Destinataires "en copie" d'une notification de ticket : fusion des
 * destinataires CC (TICKETCC) et des utilisateurs rattachés à un projet du
 * ticket (PROJECTUSERS), chacun filtré selon sa propre préférence mail
 * (MAILONCC / MAILONPROJECT, cf. filterByMailPreference — activées par
 * défaut, donc aucun changement de comportement pour un utilisateur qui
 * n'a jamais touché ses préférences). Dédoublonné : un même utilisateur CC
 * ET membre du projet ne reçoit le mail qu'une fois, et le reçoit dès que
 * l'une des deux préférences est active pour lui.
 */
async function getExtraMailRecipients(ticket) {
  const [ccEmails, projectEmails] = await Promise.all([
    filterByMailPreference(getTicketCcUsers(ticket), "MAILONCC"),
    getTicketProjectUsers(ticket).then((users) =>
      filterByMailPreference(users, "MAILONPROJECT"),
    ),
  ]);

  return [...new Set([...ccEmails, ...projectEmails])];
}

/**
 * Envoi best-effort d'un email de notification lié à un ticket.
 * N'importe quelle erreur (SMTP non configuré, template introuvable, etc.)
 * est loguée mais jamais propagée : un souci d'email ne doit pas faire
 * échouer une création/modification/suppression de ticket.
 *
 * `to` : email(s) réel(s) résolus par l'appelant (créateur, membres du
 * service...). En dehors de la production, ignorés au profit de
 * BASE_RECIPIENT_EMAIL (cf. commentaire d'en-tête). Si aucun destinataire
 * n'est disponible (ni réel, ni fallback), l'envoi est simplement ignoré.
 */
async function notifyTicketEvent({
  template,
  subject,
  message,
  ticket,
  extraDetails = [],
  notes = [],
  to,
  cc,
  actionUrl = true,
}) {
  // return;
  const realRecipients = [
    ...new Set(
      (Array.isArray(to) ? to : [to]).filter(
        (email) => typeof email === "string" && email.trim().length > 0,
      ),
    ),
  ];

  // Les destinataires en copie (ticket.CC) reçoivent les mêmes emails que le
  // demandeur/les membres du service, mais en Cc plutôt qu'en To — jamais en
  // dev/staging (même redirection que `to`, cf. commentaire d'en-tête), et
  // jamais en double s'ils apparaissent déjà parmi les destinataires réels.
  const realCc = [
    ...new Set(
      (Array.isArray(cc) ? cc : cc ? [cc] : []).filter(
        (email) => typeof email === "string" && email.trim().length > 0,
      ),
    ),
  ].filter((email) => !realRecipients.includes(email));

  const recipients = IS_PROD
    ? realRecipients
    : DEV_FALLBACK_RECIPIENT
      ? [DEV_FALLBACK_RECIPIENT]
      : [];

  const ccRecipients = IS_PROD ? realCc : [];

  // Le destinataire principal (`to`) peut être volontairement vide — cf.
  // règle anti auto-notification en tête de fichier : le créateur/membre du
  // service concerné a été exclu parce qu'il est lui-même l'auteur de
  // l'action. S'il reste malgré tout des destinataires en copie (CC ticket /
  // membres de projet), on les promeut en destinataires principaux plutôt que
  // d'abandonner l'envoi : sendMail (core/services/mail.service.js) exige un
  // `to` non vide (MISSING_RECIPIENT), et ces destinataires doivent recevoir
  // l'email quoi qu'il arrive.
  let finalRecipients = recipients;
  let finalCc = ccRecipients;
  if (!finalRecipients.length && finalCc.length) {
    finalRecipients = finalCc;
    finalCc = [];
  }

  if (!finalRecipients.length) {
    logger.warn(
      `[TICKETING][MAIL] Aucun destinataire résolu pour "${template}" (${ticket?.TCKCOD ?? "?"}) — envoi ignoré.`,
    );
    return;
  }

  const APP_NAME = "Ticketing UVCDR";
  const APP_MAIL = "ticketing@union-vignerons.com";

  // Données construites une seule fois (cf. audit dette technique — ce bloc
  // était dupliqué entre un console.log() de débogage oublié et l'appel réel
  // à sendTemplatedMail). Le console.log a été retiré : il ne passait pas par
  // le pipeline de logs winston et pouvait faire fuiter du contenu de ticket
  // (titre, description, notes) hors des logs rotatifs/retenus.
  const data = {
    APP_NAME: APP_NAME,
    // Badge affiché sous le titre par les templates ticketing/* (cf.
    // core/services/mail-templates/ticketing/) — ignoré par les templates
    // génériques (renderTemplate() retire les placeholders non fournis dans
    // `data`).
    TICKET_CODE: ticket?.TCKCOD,
    TITLE: subject,
    MESSAGE: message,
    // Titre métier du ticket (distinct de TITLE, qui est le sujet de
    // l'email, ex. "Ticket TCK-000123 clôturé") — affiché en évidence dans
    // le corps par les templates ticketing/*.html, bloc {{#if TCKTITLE}}.
    // Absent avant V1.1.1 : seule la route de test testTicketMailTemplates()
    // le renseignait, pas les vrais envois (cf. commentaire de ce bloc
    // dans testTicketMailTemplates — la parité annoncée avec ce bloc-ci
    // n'était donc pas exacte).
    TCKTITLE: ticket?.TITLE,
    // Sortie du bloc "Détails" pour être affichée à part, en citation (texte
    // libre potentiellement long — se lit mal en ligne label/valeur au
    // milieu de champs courts comme Statut/Assigné à). Cf. templates
    // ticketing/*.html, bloc {{#if DESCRIPTION}}.
    DESCRIPTION: ticket?.DESCR,
    // Regroupé par thème plutôt qu'une seule liste plate de 6-7 lignes (cf.
    // renderDetailGroups() dans mail.service.js) — nettement plus rapide à
    // scanner que l'ancien bloc "Détails" unique. Le groupe "Suivi" ne
    // s'affiche que s'il y a des extraDetails (ex: "Ancien statut") —
    // renderDetailGroups() omet un groupe sans item. Le contenu d'une note
    // ne passe plus par ce groupe : cf. NOTES_HTML plus bas.
    DETAILS_ROWS_HTML: renderDetailGroups([
      {
        title: "Ticket",
        items: [
          { label: "Numéro", value: ticket?.TCKCOD },
          { label: "Statut", value: ticket?.STS?.NAME },
        ],
      },
      {
        title: "Circuit",
        items: [
          { label: "Créé par", value: ticket?.USRNAM },
          { label: "Assigné au service", value: ticket?.SRV?.NAME },
        ],
      },
      {
        title: "Suivi",
        items: extraDetails,
      },
    ]),
    // Contenu de note(s), affiché à part sous le bloc "Détails" plutôt que
    // dans le groupe "Suivi" ci-dessus (cf. renderNoteList() dans
    // mail.service.js) : une note est un texte libre potentiellement long
    // (plusieurs paragraphes), qui se lit mal compressé dans une ligne
    // label/valeur au milieu de champs courts comme Statut/Assigné à — même
    // logique que DESCRIPTION plus haut. Uniquement consommé par le template
    // ticketing/new-note.html, bloc {{#if NOTES_HTML}} (cf.
    // scheduleNoteNotification).
    NOTES_HTML: notes.length ? renderNoteList(notes) : undefined,
    ACTION_URL: actionUrl
      ? `${process.env.DOMAIN}/ticketing/${ticket?.TCKCOD}`
      : undefined,
    ACTION_LABEL: `Voir le ticket`,
  };

  try {
    await sendTemplatedMail({
      from: APP_MAIL,
      template,
      to: finalRecipients,
      cc: finalCc.length ? finalCc : undefined,
      subject,
      data,
    });
  } catch (err) {
    logger.error(
      `[TICKETING][MAIL] Échec envoi "${template}" pour ${ticket?.TCKCOD ?? "?"} : ${err.message}`,
    );
  }
}

/**
 * Config d'email par statut de ticket (STS.CODE) — un template/sujet/message
 * dédié par statut, utilisé à la fois pour la création (un ticket pourrait
 * en théorie être créé directement dans un statut autre que "Nouveau", ex:
 * import) et pour un changement de statut lors d'une modification (cf.
 * scheduleTicketUpdateNotification). Le choix de template reflète le code
 * couleur des colonnes du tableau Kanban (cf. core/services/mail-templates/
 * ticketing/*.html) : bleu pour un nouveau ticket (colonne "Nouveau"), bleu
 * cyan pour une prise en charge (colonne "En cours"), doré pour une attente
 * (colonne "En attente"), vert pour une résolution à valider (colonne
 * "Résolu"), bleu marine pour une clôture (colonne "Clôturé"), rouge bordeaux
 * pour une annulation (colonne "Annulé").
 *
 * `subject`/`message` sont des fonctions plutôt que des chaînes statiques
 * pour pouvoir interpoler le ticket (TCKCOD) et, pour `message`, un
 * contexte optionnel `{ previousStatusName }` renseigné uniquement lors
 * d'un changement de statut (absent à la création).
 */
const STATUS_MAIL_CONFIG = {
  NEW: {
    template: "ticketing/creation",
    subject: (t) => `Nouveau ticket ${t.TCKCOD}`,
    message: () => "Un nouveau ticket a été créé et vous a été assigné.",
  },
  WIP: {
    template: "ticketing/in-progress",
    subject: (t) => `Ticket ${t.TCKCOD} pris en charge`,
    message: (t, { previousStatusName } = {}) =>
      previousStatusName
        ? `Le ticket est passé de "${previousStatusName}" à "En cours" : il est désormais pris en charge.`
        : "Le ticket est en cours de traitement.",
  },
  WAIT: {
    template: "ticketing/waiting",
    subject: (t) => `Ticket ${t.TCKCOD} en attente`,
    message: (t, { previousStatusName } = {}) =>
      previousStatusName
        ? `Le ticket est passé de "${previousStatusName}" à "En attente".`
        : "Le ticket est en attente d'une réponse ou d'un intervenant tiers.",
  },
  RSLV: {
    template: "ticketing/resolved",
    subject: (t) => `Ticket ${t.TCKCOD} résolu`,
    message: () =>
      `Une solution a été apportée à ce ticket. Merci de le déplacer dans la colonne « Clôturé » si celle-ci vous convient. Dans le cas contraire, merci d’ajouter un commentaire afin de préciser le problème rencontré.`,
  },
  CLSD: {
    template: "ticketing/closed",
    subject: (t) => `Ticket ${t.TCKCOD} clôturé`,
    message: () => "Le ticket a été clôturé.",
  },
  CNCL: {
    template: "ticketing/cancelled",
    subject: (t) => `Ticket ${t.TCKCOD} annulé`,
    message: () => "Le ticket a été annulé.",
  },
};

/**
 * Config de repli si un statut n'est pas (ou plus) référencé dans
 * STATUS_MAIL_CONFIG (nouveau statut ajouté en base sans mise à jour de ce
 * fichier) — ne doit jamais faire échouer l'envoi (cf. commentaire
 * d'en-tête, principe best-effort).
 */
const DEFAULT_STATUS_MAIL_CONFIG = {
  template: "ticketing/modification",
  subject: (t) => `Ticket ${t.TCKCOD} modifié`,
  message: (t, { previousStatusName } = {}) =>
    previousStatusName
      ? `Le statut du ticket est passé de "${previousStatusName}" à "${t?.STS?.NAME ?? "?"}".`
      : "Le ticket a été modifié.",
};

/**
 * Résout la config d'email (template/subject/message) correspondant au
 * statut courant du ticket, avec repli sur DEFAULT_STATUS_MAIL_CONFIG.
 */
function getStatusMailConfig(ticket) {
  return STATUS_MAIL_CONFIG[ticket?.STS?.CODE] ?? DEFAULT_STATUS_MAIL_CONFIG;
}

/**
 * Ticket fictif utilisé uniquement par testTicketMailTemplates() (route de
 * test manuelle, cf. GET /ticketing/mail-templates/test) pour peupler les
 * placeholders des templates ticketing/*.html sans dépendre d'un ticket réel
 * en base.
 */
const SAMPLE_TEST_TICKET = {
  TCKCOD: "TCK/260921/00001",
  TITLE: "Ticket de test — aperçu des templates email",
  DESCR:
    "Ceci est une description de test générée par la route de prévisualisation des templates ticketing.",
  STS: { CODE: "NEW", NAME: "Nouveau" },
  SRV: { SRVID: 0, NAME: "Service de test" },
  USRNAM: "Jean Dupont",
  ASGNAM: "Marie Martin",
};

/**
 * Une entrée par template de core/services/mail-templates/ticketing/ : les 6
 * statuts de STATUS_MAIL_CONFIG, le repli DEFAULT_STATUS_MAIL_CONFIG
 * (modification générique), et les deux événements qui n'ont pas de statut
 * dédié (suppression, nouvelle note) — mêmes subject/message que les
 * fonctions notifyTicketXxx correspondantes.
 */
function getMailTemplateVariants() {
  return [
    ...Object.entries(STATUS_MAIL_CONFIG).map(([code, cfg]) => ({
      key: code,
      ...cfg,
    })),
    {
      key: "DEFAULT",
      ...DEFAULT_STATUS_MAIL_CONFIG,
    },
    {
      key: "DELETED",
      template: "ticketing/deletion",
      subject: (t) => `Ticket ${t.TCKCOD} supprimé`,
      message: () => "Le ticket a été supprimé (corbeille).",
    },
    {
      key: "NOTE",
      template: "ticketing/new-note",
      subject: (t) => `Nouvelle note sur le ticket ${t.TCKCOD}`,
      message: () => "Une nouvelle note vient d'être ajoutée au ticket.",
    },
  ];
}

/**
 * Route de test manuelle (dev/staging uniquement, cf. IS_PROD dans
 * routes.js) : envoie un exemplaire de CHAQUE variante d'email ticketing (9
 * templates) à BASE_RECIPIENT_EMAIL, pour vérifier visuellement leur rendu
 * dans une vraie boîte mail après une modification des templates — sans
 * avoir à faire transiter un vrai ticket par tout le cycle de statuts.
 *
 * Toujours envoyé à BASE_RECIPIENT_EMAIL, jamais à un utilisateur réel :
 * indépendant de la logique de destinataires (anti auto-notification,
 * CC, membres de service/projet) de notifyTicketEvent — ce n'est pas un
 * test métier, juste un aperçu de gabarits.
 *
 * Best-effort par variante : une erreur sur un template (ex: fichier
 * introuvable après une modification en cours) ne doit pas empêcher
 * l'envoi des autres — chaque résultat est rapporté individuellement dans
 * la réponse plutôt que de faire échouer toute la requête.
 */
export async function testTicketMailTemplates(req) {
  if (!DEV_FALLBACK_RECIPIENT) {
    const err = new Error(
      "BASE_RECIPIENT_EMAIL n'est pas configuré (variable d'environnement requise pour ce test).",
    );
    err.status = 400;
    throw err;
  }

  const { template } = (await requestUtils.getRequestParams(req)).params;

  const ticket = SAMPLE_TEST_TICKET;
  const APP_NAME = "Ticketing UVCDR";
  const APP_MAIL = "ticketing@union-vignerons.com";

  const results = [];

  for (const variant of getMailTemplateVariants()) {
    if (
      (template !== undefined && variant.template.includes(`/${template}`)) ||
      template === undefined
    ) {
      const subject = `[TEST] ${variant.subject(ticket)}`;
      const message = variant.message(ticket);

      const data = {
        APP_NAME,
        TICKET_CODE: ticket.TCKCOD,
        TITLE: subject,
        MESSAGE: message,
        // Même construction que notifyTicketEvent() (cf. plus haut) — pour
        // que cette route de test prévisualise exactement ce qu'un vrai
        // ticket enverrait, DESCRIPTION/groupes compris.
        TCKTITLE: ticket.TITLE,
        DESCRIPTION: ticket.DESCR,
        DETAILS_ROWS_HTML: renderDetailGroups([
          {
            title: "Ticket",
            items: [
              { label: "Numéro", value: ticket.TCKCOD },
              { label: "Statut", value: ticket.STS.NAME },
            ],
          },
          {
            title: "Circuit",
            items: [
              { label: "Service concerné", value: ticket.SRV.NAME },
              { label: "Créé par", value: ticket.USRNAM },
              { label: "Assigné à", value: ticket.ASGNAM },
            ],
          },
        ]),
        // Aperçu du bloc NOTES_HTML (cf. renderNoteList() dans
        // mail.service.js) uniquement pour la variante NOTE — les autres
        // templates n'ont pas de bloc {{#if NOTES_HTML}} à prévisualiser.
        NOTES_HTML:
          variant.key === "NOTE"
            ? renderNoteList([
                {
                  author: ticket.ASGNAM,
                  content:
                    "Merci de vérifier également la configuration réseau du poste, le problème semble intermittent depuis la mise à jour de la semaine dernière.",
                },
              ])
            : undefined,
        ACTION_URL: `${process.env.DOMAIN}/ticketing/${ticket.TCKCOD}`,
        ACTION_LABEL: "Voir le ticket",
      };

      try {
        await sendTemplatedMail({
          from: APP_MAIL,
          template: variant.template,
          to: DEV_FALLBACK_RECIPIENT,
          subject,
          data,
        });
        results.push({
          variant: variant.key,
          template: variant.template,
          subject,
          status: "sent",
        });
      } catch (err) {
        logger.error(
          `[TICKETING][MAIL][TEST] Échec envoi "${variant.template}" : ${err.message}`,
        );
        results.push({
          variant: variant.key,
          template: variant.template,
          subject,
          status: "error",
          error: err.message,
        });
      }
    }
  }

  return {
    to: DEV_FALLBACK_RECIPIENT,
    sent: results.filter((r) => r.status === "sent").length,
    failed: results.filter((r) => r.status === "error").length,
    results,
  };
}

/**
 * Notifie la création d'un ticket aux membres du service concerné.
 * Anti auto-notification : le créateur du ticket (CREUSR) est exclu de ces
 * destinataires s'il se trouve être lui-même membre du service concerné
 * (ex: il crée un ticket pour son propre service) — les autres membres du
 * service continuent de recevoir l'email normalement (cf. commentaire
 * d'en-tête "Anti auto-notification").
 */
async function notifyTicketCreated(ticket) {
  try {
    const { template, subject, message } = getStatusMailConfig(ticket);

    // Membres de TOUS les services attribués (principal + co-attribués via
    // TICKETSERVICES, cf. commentaire d'en-tête "attribution multi-service")
    // — chacun peut agir sur le ticket au même titre, donc chacun doit être
    // notifié de sa création.
    const recipients = await getServicesRecipients(
      [ticket?.SRV?.SRVID, ...(ticket?.SERVICES ?? []).map((s) => s.SRVID)],
      ticket?.CREUSR,
    );
    await notifyTicketEvent({
      template,
      subject: subject(ticket),
      message: message(ticket),
      ticket,
      to: recipients,
      cc: await getExtraMailRecipients(ticket),
    });
  } catch (err) {
    logger.error(
      `[TICKETING][MAIL] Échec notification création ${ticket?.TCKCOD ?? "?"} : ${err.message}`,
    );
  }
}

/**
 * Notifie la suppression (corbeille ou définitive) d'un ticket à son créateur.
 * Anti auto-notification : sautée si c'est le créateur lui-même qui a
 * supprimé son propre ticket (`actorUsrId`, cf. isSelfAction) — les
 * destinataires en copie/projet continuent de recevoir l'email normalement.
 */
async function notifyTicketDeleted(ticket, { perm, actorUsrId } = {}) {
  try {
    await notifyTicketEvent({
      template: "ticketing/deletion",
      subject: `Ticket ${ticket.TCKCOD} supprimé`,
      message: perm
        ? "Le ticket a été supprimé définitivement."
        : "Le ticket a été supprimé (corbeille).",
      ticket,
      to: isSelfAction(ticket, actorUsrId) ? [] : ticket?.CREEMAIL,
      cc: await getExtraMailRecipients(ticket),
      ACTION_URL: !perm,
    });
  } catch (err) {
    logger.error(
      `[TICKETING][MAIL] Échec notification suppression ${ticket?.TCKCOD ?? "?"} : ${err.message}`,
    );
  }
}

/**
 * Notifie la clôture d'un ticket à son créateur. Action ponctuelle et
 * délibérée (bouton dédié) → pas de regroupement, envoi immédiat.
 * Anti auto-notification : sautée si c'est le créateur lui-même qui a
 * clôturé son propre ticket (`actorUsrId`, cf. isSelfAction) — les
 * destinataires en copie/projet continuent de recevoir l'email normalement.
 */
async function notifyTicketClosed(ticket, actorUsrId) {
  try {
    await notifyTicketEvent({
      template: "ticketing/modification",
      subject: `Ticket ${ticket.TCKCOD} clôturé`,
      message: "Le ticket a été clôturé.",
      ticket,
      extraDetails: [{ label: "Clôturé le", value: ticket.CLSDAT }],
      to: isSelfAction(ticket, actorUsrId) ? [] : ticket?.CREEMAIL,
      cc: await getExtraMailRecipients(ticket),
    });
  } catch (err) {
    logger.error(
      `[TICKETING][MAIL] Échec notification clôture ${ticket?.TCKCOD ?? "?"} : ${err.message}`,
    );
  }
}

/**
 * Planifie une notification de modification/changement de statut au créateur
 * du ticket, en regroupant les modifications rapprochées dans le temps en un
 * seul email (cf. commentaire d'en-tête — anti-spam statut).
 *
 * `baselineTicket` = état complet du ticket juste AVANT la modification qui
 * déclenche cet appel. Seul le tout premier appel du lot (par TCKID) sert de
 * référence de comparaison ; les appels suivants réarment simplement le
 * délai. Au déclenchement, l'état courant du ticket est rechargé pour ne
 * notifier que l'écart net entre le tout premier statut et le statut final.
 *
 * `actorUsrId` = utilisateur à l'origine de CET appel (celui qui vient de
 * modifier le ticket). Chaque appel du lot mémorise son propre auteur (cf.
 * `items` ci-dessous) : anti auto-notification (commentaire d'en-tête) —
 * le créateur du ticket n'est notifié que si AU MOINS une modification du
 * lot vient de quelqu'un d'autre que lui (ex: un autre membre de son
 * service). Si toutes les modifications du lot viennent du créateur
 * lui-même, la notification au créateur est sautée (les destinataires en
 * copie/projet, eux, la reçoivent toujours).
 */
function scheduleTicketUpdateNotification(baselineTicket, actorUsrId) {
  const TCKID = baselineTicket?.TCKID;
  if (!TCKID) return;

  debounceCollect(
    `ticket-update:${TCKID}`,
    { ticket: baselineTicket, actorUsrId },
    {
      delayMs: STATUS_MAIL_DEBOUNCE_MS,
      maxWaitMs: STATUS_MAIL_DEBOUNCE_MAX_MS,
      onFlush: async (items) => {
        const first = items[0].ticket;
        try {
          const rows = await services.getTicket(first.CREUSR, first.TCKCOD);
          const current = utils.formatTicket(rows);
          const statusChanged = first.STS?.STSID !== current.STS?.STSID;

          // Statut inchangé (titre, description, planification...) → email
          // générique "modification". Statut changé → email dédié au nouveau
          // statut (cf. STATUS_MAIL_CONFIG), avec l'ancien statut passé en
          // contexte au message ET affiché en detail dans le corps du mail.
          const { template, subject, message } = statusChanged
            ? getStatusMailConfig(current)
            : {
                template: "ticketing/modification",
                subject: () => `Ticket ${current.TCKCOD} modifié`,
                message: () => "Le ticket a été modifié.",
              };

          // Anti auto-notification : sautée seulement si TOUTES les
          // modifications du lot viennent du créateur lui-même.
          const allBySelf = items.every((it) =>
            isSelfAction(current, it.actorUsrId),
          );

          await notifyTicketEvent({
            template,
            subject: subject(current),
            message: statusChanged
              ? message(current, { previousStatusName: first.STS?.NAME })
              : message(current),
            ticket: current,
            extraDetails: statusChanged
              ? [{ label: "Ancien statut", value: first.STS?.NAME }]
              : [],
            to: allBySelf ? [] : current.CREEMAIL,
            cc: await getExtraMailRecipients(current),
          });
        } catch (err) {
          logger.error(
            `[TICKETING][MAIL] Échec notification modification (lot) ${first?.TCKCOD ?? "?"} : ${err.message}`,
          );
        }
      },
    },
  );
}

/**
 * Planifie une notification de nouvelle note, en regroupant les notes
 * rapprochées dans le temps (même ticket, même sens de notification) en un
 * seul email (cf. commentaire d'en-tête — anti-spam notes).
 *
 * Sens de la notification :
 * - note du créateur (le "demandeur")     → membres du service qui traite le ticket
 * - note d'une personne du service        → créateur du ticket
 */
function scheduleNoteNotification({ ticket, note }) {
  const TCKID = ticket?.TCKID;
  if (!TCKID || !note) return;

  const fromRequester = String(note.USRID) === String(ticket.CREUSR);
  const direction = fromRequester ? "to-service" : "to-requester";

  debounceCollect(
    `ticket-note:${TCKID}:${direction}`,
    { ticket, note },
    {
      delayMs: NOTE_MAIL_DEBOUNCE_MS,
      maxWaitMs: NOTE_MAIL_DEBOUNCE_MAX_MS,
      onFlush: async (items) => {
        const { ticket: lastTicket } = items[items.length - 1];
        try {
          const recipients = fromRequester
            ? await getServiceRecipients(
                lastTicket.SRV?.SRVID,
                lastTicket.CREUSR,
              )
            : [lastTicket.CREEMAIL];

          // Affichées en blocs "citation" sous le bloc "Détails" (cf.
          // NOTES_HTML / renderNoteList() dans mail.service.js) plutôt qu'en
          // lignes label/valeur du groupe "Suivi" — une note peut être un
          // texte long, qui se lit mal compressé dans une ligne courte.
          const notes = items.map(({ note: n }) => ({
            author: n.USRNAM,
            content: n.CMNT,
          }));

          await notifyTicketEvent({
            template: "ticketing/new-note",
            subject:
              items.length > 1
                ? `${items.length} nouvelles notes sur le ticket ${lastTicket.TCKCOD}`
                : `Nouvelle note sur le ticket ${lastTicket.TCKCOD}`,
            message:
              items.length > 1
                ? `${items.length} nouvelles notes viennent d'être ajoutées au ticket.`
                : "Une nouvelle note vient d'être ajoutée au ticket.",
            ticket: lastTicket,
            notes,
            to: recipients,
            cc: await getExtraMailRecipients(lastTicket),
          });
        } catch (err) {
          logger.error(
            `[TICKETING][MAIL] Échec notification note(s) (lot) ${lastTicket?.TCKCOD ?? "?"} : ${err.message}`,
          );
        }
      },
    },
  );
}

export async function getTickets(req) {
  const { TCKNUM } = (await requestUtils.getRequestParams(req)).params;
  const USRID = req?.payload?.data?.id;

  if (TCKNUM) {
    const rawTickets = await services.getTicket(USRID, TCKNUM);
    return utils.formatTicket(rawTickets);
  }

  const rawTickets = await services.getTickets(USRID);
  return utils.formatTickets(rawTickets);
}

export async function createTicket(req) {
  const body = v.ticketCreateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const USRID = body?.USRID ?? req?.payload?.data?.id;

  const newTicketCode = await services.createTicket({
    ...body,
    DESCR: body.DESCR ?? null,
    ASGUSR: body.ASGUSR ?? USRID,
    CREUSR: USRID,
  });

  if (!newTicketCode) throw new Error("DB_QUERY_ERROR");

  if (body.CCUSRIDS?.length) {
    const created = await services.getTicket(USRID, newTicketCode);
    await services.setTicketCc({
      TCKID: created[0].TCKID,
      USRIDS: body.CCUSRIDS,
      CREUSR: USRID,
    });
  }

  if (body.PRJIDS?.length) {
    const createdForProjects = await services.getTicket(USRID, newTicketCode);
    await services.setTicketProjects({
      TCKID: createdForProjects[0].TCKID,
      PRJIDS: body.PRJIDS,
      CREUSR: USRID,
    });
  }

  // Services supplémentaires (attribution multi-service, cf. commentaire
  // d'en-tête) : mêmes droits d'accès/action que le service principal
  // (SRVID) dès la création — cf. services.setTicketServices.
  if (body.SRVIDS?.length) {
    const createdForServices = await services.getTicket(USRID, newTicketCode);
    await services.setTicketServices({
      TCKID: createdForServices[0].TCKID,
      SRVIDS: body.SRVIDS,
      CREUSR: USRID,
    });
  }

  const newTicket = utils.formatTicket(
    await services.getTicket(USRID, newTicketCode),
  );

  broadcastToAll({
    type: "ticket.created",
    payload: {
      TCKID: newTicket.TCKID,
      TCKCOD: newTicket.TCKCOD,
      SRVID: body.SRVID,
    },
  });

  notifyTicketCreated(newTicket);

  return newTicket;
}

export async function updateTicket(req) {
  const body = v.ticketUpdateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const BASE_USRID = req?.payload?.data?.id;

  const rowBaseTicket = await services.getTicket(BASE_USRID, body.TCKNUM);
  const baseTicket = utils.formatTicket(rowBaseTicket); // lève 404 si absent/inaccessible
  const ticket = rowBaseTicket[0];

  // Services co-attribués (attribution multi-service) : modifiable par un
  // membre d'au moins UN des services déjà attribués au ticket
  // (baseTicket.MYSRV, cf. la CTE MyServices étendue de SELECT_TICKETS —
  // même règle que le reste du groupe CLASSIFICATION, cf.
  // `canShowClassificationSection` côté front), OU par le créateur du
  // ticket lui-même — ce dernier cas couvre le champ "Services associés"
  // du bloc de saisie initial (avant classification/prise en charge, cf.
  // TicketInformationSection.tsx), où le demandeur choisit d'emblée à quels
  // services adresser sa demande, au même titre que SRVID.
  if (
    body.SRVIDS !== undefined &&
    !baseTicket.MYSRV &&
    String(ticket.CREUSR) !== String(BASE_USRID)
  ) {
    const err = new Error(
      "Seuls le créateur du ticket ou les membres d'un service déjà attribué peuvent modifier les services attribués.",
    );
    err.status = 403;
    throw err;
  }

  // Catégorisation (CATID/SC1-3) et service PRINCIPAL (SRVID) : réservés au
  // service principal du ticket (baseTicket.MYPRIMARYSRV). Un membre d'un
  // service SECONDAIRE (MYSRV vrai via TICKETSERVICES, mais pas via
  // SRVID — cf. commentaire de MYPRIMARYSRV, SELECT_TICKETS) voit ces
  // champs dans la section Classification (canShowClassificationSection,
  // basé sur MYSRV) mais ne doit pas pouvoir les modifier. Ne s'applique
  // qu'à un membre déjà MYSRV : un simple créateur pas encore pris en
  // charge (ni MYSRV ni MYPRIMARYSRV) garde le droit de choisir le service
  // destinataire (SRVID) depuis le bloc de saisie initial, comme avant.
  if (baseTicket.MYSRV && !baseTicket.MYPRIMARYSRV) {
    const attemptsSrvidChange =
      body.SRVID !== undefined &&
      Number(body.SRVID) !== Number(ticket.SRVID ?? null);
    const attemptsCategoryChange =
      (body.CATID !== undefined &&
        (body.CATID ?? null) !== (ticket.CATID ?? null)) ||
      (body.SC1ID !== undefined &&
        (body.SC1ID ?? null) !== (ticket.SC1ID ?? null)) ||
      (body.SC2ID !== undefined &&
        (body.SC2ID ?? null) !== (ticket.SC2ID ?? null)) ||
      (body.SC3ID !== undefined &&
        (body.SC3ID ?? null) !== (ticket.SC3ID ?? null));

    if (attemptsSrvidChange || attemptsCategoryChange) {
      const err = new Error(
        "Seul le service principal du ticket peut modifier le service ou la catégorisation.",
      );
      err.status = 403;
      throw err;
    }
  }

  const USRID = body?.USRID ?? ticket.CREUSR;

  const resolved = {
    TCKID: ticket.TCKID,
    TITLE: body.TITLE ?? ticket.TITLE,
    DESCR: body.DESCR !== undefined ? body.DESCR : ticket.DESCR,
    CATID: body.CATID !== undefined ? body.CATID : ticket.CATID,
    SC1ID: body.SC1ID !== undefined ? body.SC1ID : ticket.SC1ID,
    SC2ID: body.SC2ID !== undefined ? body.SC2ID : ticket.SC2ID,
    SC3ID: body.SC3ID !== undefined ? body.SC3ID : ticket.SC3ID,
    PRIID: body.PRIID !== undefined ? body.PRIID : ticket.PRIID,
    SRVID: body.SRVID !== undefined ? body.SRVID : ticket.SRVID,
    ASGUSR: body.ASGUSR !== undefined ? body.ASGUSR : ticket.ASGUSR,
    STSID: body.STSID !== undefined ? body.STSID : ticket.STSID,
    USRID,
    CMNT: body.CMNT ?? null,
    // Planification / sous-catégories : absent du payload → valeur actuelle
    // conservée ; présent à null → effacé (cf. validators.ticketUpdateSchema).
    // Indispensable pour les mises à jour partielles, ex. le changement de
    // statut par drag & drop du Kanban qui n'envoie que TCKNUM + STSID.
    DATDEB: body.DATDEB !== undefined ? body.DATDEB : ticket.DATDEB,
    DATFIN: body.DATFIN !== undefined ? body.DATFIN : ticket.DATFIN,
    DATDEBREEL:
      body.DATDEBREEL !== undefined ? body.DATDEBREEL : ticket.DATDEBREEL,
    DATFINREEL:
      body.DATFINREEL !== undefined ? body.DATFINREEL : ticket.DATFINREEL,
    TPSPREV: body.TPSPREV !== undefined ? body.TPSPREV : ticket.TPSPREV,
    TPSREEL: body.TPSREEL !== undefined ? body.TPSREEL : ticket.TPSREEL,
  };

  await services.updateTicket(resolved);

  // Puce "non vu" (cf. flag UNSEEN, SELECT_TICKETS) : les champs ci-dessous
  // sont tous fusionnés dans une seule UPDATE par services.updateTicket, on
  // journalise donc ici — en comparant à `ticket` (ligne brute AVANT
  // modification, déjà chargée juste au-dessus) — les groupes réellement
  // modifiés, un par un, dans TICKETFIELDCHANGES (cf. services.
  // logTicketFieldChanges). Le statut (TICKETTRACKING), les notes et les
  // tâches ont déjà leur propre table horodatée et n'ont pas besoin de ce
  // journal.
  const changedGroups = [];
  if (resolved.TITLE !== ticket.TITLE) changedGroups.push("TITLE");
  if ((resolved.DESCR ?? null) !== (ticket.DESCR ?? null))
    changedGroups.push("DESCR");
  if (
    (resolved.CATID ?? null) !== (ticket.CATID ?? null) ||
    (resolved.SC1ID ?? null) !== (ticket.SC1ID ?? null) ||
    (resolved.SC2ID ?? null) !== (ticket.SC2ID ?? null) ||
    (resolved.SC3ID ?? null) !== (ticket.SC3ID ?? null) ||
    (resolved.PRIID ?? null) !== (ticket.PRIID ?? null)
  )
    changedGroups.push("CLASSIFICATION");
  if (
    (resolved.SRVID ?? null) !== (ticket.SRVID ?? null) ||
    body.SRVIDS !== undefined
  )
    changedGroups.push("SERVICE");
  if ((resolved.ASGUSR ?? null) !== (ticket.ASGUSR ?? null))
    changedGroups.push("ASSIGNEE");
  if (
    dateValueDiffers(resolved.DATDEB, ticket.DATDEB) ||
    dateValueDiffers(resolved.DATFIN, ticket.DATFIN) ||
    dateValueDiffers(resolved.DATDEBREEL, ticket.DATDEBREEL) ||
    dateValueDiffers(resolved.DATFINREEL, ticket.DATFINREEL) ||
    (resolved.TPSPREV ?? null) !== (ticket.TPSPREV ?? null) ||
    (resolved.TPSREEL ?? null) !== (ticket.TPSREEL ?? null)
  )
    changedGroups.push("PLANNING");

  if (changedGroups.length) {
    services
      .logTicketFieldChanges(ticket.TCKID, USRID, changedGroups)
      .catch((err) =>
        logger.error(
          `[TICKETING][UNSEEN] Échec journalisation des changements ${ticket?.TCKCOD ?? "?"} : ${err.message}`,
        ),
      );
  }

  // PRJIDS absent du payload → on ne touche pas aux projets rattachés ;
  // présent (même vide) → remplace la liste complète (cf. services.setTicketProjects).
  if (body.PRJIDS !== undefined) {
    await services.setTicketProjects({
      TCKID: ticket.TCKID,
      PRJIDS: body.PRJIDS,
      CREUSR: USRID,
    });
  }

  // SRVIDS absent du payload → on ne touche pas aux services supplémentaires
  // déjà attribués ; présent (même vide) → remplace la liste complète (cf.
  // services.setTicketServices, autorisation déjà vérifiée plus haut).
  if (body.SRVIDS !== undefined) {
    await services.setTicketServices({
      TCKID: ticket.TCKID,
      SRVIDS: body.SRVIDS,
      CREUSR: USRID,
    });
  }

  // CCUSRIDS absent du payload → on ne touche pas à la liste existante ;
  // présent (même vide) → remplace la liste complète des destinataires en
  // copie (cf. services.setTicketCc, motif "delsert").
  //
  // Émettre "ticket.cc.updated" en plus de "ticket.updated" ci-dessous est
  // indispensable : côté front, handleWsCcUpdated (KanbanBoard.tsx) est le
  // seul handler qui ajoute/retire le ticket du Kanban d'un utilisateur
  // selon son nouvel accès (cf. commentaire de setTicketCc, endpoint dédié,
  // qui émet déjà cet événement). handleWsUpdated, lui, ne fait que
  // remplacer une entrée déjà présente en place — un utilisateur qui vient
  // d'être mis en copie ne voit donc jamais le ticket apparaître (et un
  // utilisateur retiré ne le voit jamais disparaître) si seul
  // "ticket.updated" est émis.
  let ccChanged = false;
  if (body.CCUSRIDS !== undefined) {
    await services.setTicketCc({
      TCKID: ticket.TCKID,
      USRIDS: body.CCUSRIDS,
      CREUSR: USRID,
    });
    ccChanged = true;
  }

  // Fusion (MRGID) : un changement de statut sur un membre d'un groupe de
  // fusion est répercuté sur tous les autres membres — c'est ce qui les
  // garde dans la même colonne Kanban (cf. sql/TICKETS.add-MRGID.sql et
  // commentaire d'en-tête "FUSION" de services.js). `ticket.MRGID` = groupe
  // AVANT cette modification (services.updateTicket ne touche pas MRGID).
  const effectiveSTSID = body.STSID !== undefined ? body.STSID : ticket.STSID;
  const statusActuallyChanged = ticket.STSID !== effectiveSTSID;

  if (ticket.MRGID && statusActuallyChanged) {
    const siblings = await services.getMergeGroupTicketIds(
      ticket.MRGID,
      ticket.TCKID,
    );

    for (const sib of siblings) {
      try {
        // Le créateur d'un ticket y a toujours accès (cf. commentaire de
        // getTicketOwnerUsrid) : on recharge chaque ticket frère via son
        // propre créateur plutôt que via BASE_USRID, qui peut très bien ne
        // pas avoir accès à ce ticket-là (ex: service différent).
        const sibOwnerUsrid = await services.getTicketOwnerUsrid(sib.TCKID);
        const sibRows = await services.getTicket(
          sibOwnerUsrid ?? BASE_USRID,
          sib.TCKCOD,
        );
        if (!sibRows.length) continue;
        const sibBaseline = utils.formatTicket(sibRows);

        await services.applyStatusToTicket({
          TCKID: sib.TCKID,
          STSID: effectiveSTSID,
          USRID,
          CMNT: null,
        });

        broadcastToAll({
          type: "ticket.updated",
          payload: { TCKID: sib.TCKID, TCKCOD: sib.TCKCOD },
        });

        scheduleTicketUpdateNotification(sibBaseline, BASE_USRID);
      } catch (err) {
        logger.error(
          `[TICKETING][MERGE] Échec de la synchronisation de statut du ticket ${sib.TCKCOD ?? sib.TCKID} (groupe ${ticket.MRGID}) : ${err.message}`,
        );
      }
    }
  }

  await services.markTicketSeen(BASE_USRID, ticket.TCKID, 5);

  const newTicket = !body.SRVCHD
    ? utils.formatTicket(await services.getTicket(BASE_USRID, body.TCKNUM))
    : baseTicket;

  broadcastToAll({
    type: "ticket.updated",
    payload: { TCKID: ticket.TCKID, TCKCOD: body.TCKNUM },
  });

  if (ccChanged) {
    broadcastToAll({
      type: "ticket.cc.updated",
      payload: { TCKID: ticket.TCKID, TCKCOD: body.TCKNUM },
    });
  }

  // Anti-spam : différé et regroupé par ticket plutôt qu'envoyé immédiatement
  // (cf. commentaire d'en-tête). `baseTicket` = état avant CETTE modification ;
  // sert de référence de comparaison si c'est le 1er événement du lot en cours.
  scheduleTicketUpdateNotification(baseTicket, BASE_USRID);

  return newTicket;
}

/**
 * DELETE / — Supprime (soft, DLTD) ou clôture définitivement (PERM) un ticket.
 */
export async function deleteTicket(req) {
  const { TCKNUM, DLTD, PERM } = v.ticketDeleteSchema.parse(
    (
      await requestUtils.getRequestParams(req, {
        TCKNUM: "string",
        DLTD: "boolean",
        PERM: "boolean",
      })
    ).params,
  );
  const USRID = req?.payload?.data?.id;

  const existing = await services.getTicket(USRID, TCKNUM);
  if (!existing.length) {
    const err = new Error("Ticket introuvable ou accès refusé.");
    err.status = 404;
    throw err;
  }

  const ticket = existing[0];
  await services.deleteTicket(ticket.TCKID, DLTD, PERM);

  broadcastToAll({
    type: PERM ? "ticket.deleted.perm" : "ticket.deleted",
    payload: { TCKID: ticket.TCKID, TCKCOD: ticket.TCKCOD },
  });

  notifyTicketDeleted(utils.formatTicket(existing), {
    perm: PERM,
    actorUsrId: USRID,
  });

  return { TCKID: ticket.TCKID, TCKCOD: ticket.TCKCOD };
}

export async function closeTicket(req) {
  const USRID = req?.payload?.data?.id;
  const { TCKNUM } = (await requestUtils.getRequestParams(req)).params;

  const existing = await services.getTicket(USRID, TCKNUM);
  if (!existing.length) {
    const err = new Error("Ticket introuvable ou accès refusé.");
    err.status = 404;
    throw err;
  }

  const ticket = existing[0];
  await services.closeTicket({ TCKID: ticket.TCKID });

  const closedTicket = utils.formatTicket(
    await services.getTicket(USRID, TCKNUM),
  );

  broadcastToAll({
    type: "ticket.closed",
    payload: { TCKID: ticket.TCKID, TCKCOD: TCKNUM },
  });

  notifyTicketClosed(closedTicket, USRID);

  return closedTicket;
}

/* ─────────────────────────────────────────────
   CC — Destinataires en copie — Controllers
   Deux chemins équivalents, qui passent tous les deux par
   services.setTicketCc (source unique de vérité) :
   - le payload de création/modification du ticket (CCUSRIDS, cf.
     createTicket/updateTicket ci-dessus) — le chemin emprunté par le
     formulaire de ticket (CustomSelectMultiple) ;
   - ces routes dédiées (GET/PUT /cc), pour gérer les destinataires en
     copie indépendamment du reste du ticket.
───────────────────────────────────────────── */

export async function getTicketCc(req) {
  const USRID = req?.payload?.data?.id;
  const { TCKNUM } = v.ticketCcListSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const existing = await services.getTicket(USRID, TCKNUM);
  if (!existing.length) {
    const err = new Error("Ticket introuvable ou accès refusé.");
    err.status = 404;
    throw err;
  }

  return services.getTicketCc(existing[0].TCKID);
}

export async function setTicketCc(req) {
  const USRID = req?.payload?.data?.id;
  const { TCKNUM, CCUSRIDS } = v.ticketCcSetSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const existing = await services.getTicket(USRID, TCKNUM);
  if (!existing.length) {
    const err = new Error("Ticket introuvable ou accès refusé.");
    err.status = 404;
    throw err;
  }

  const ticket = existing[0];
  const cc = await services.setTicketCc({
    TCKID: ticket.TCKID,
    USRIDS: CCUSRIDS,
    CREUSR: USRID,
  });

  broadcastToAll({
    type: "ticket.cc.updated",
    payload: { TCKID: ticket.TCKID, TCKCOD: ticket.TCKCOD },
  });

  return cc;
}

/* ─────────────────────────────────────────────
   LIAISONS — Tickets liés — Controllers
   "Lier" ne modifie ni statut ni colonne Kanban : accès requis sur les DEUX
   tickets (même modèle de sécurité que le reste du module — cf.
   services.getTicket qui lève 404 si le ticket demandé est introuvable ou
   inaccessible à l'utilisateur courant).
───────────────────────────────────────────── */

export async function getTicketLinks(req) {
  const USRID = req?.payload?.data?.id;
  const { TCKNUM } = v.ticketLinkListSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  // Pas de TCKNUM → mode "bulk" : toutes les liaisons visibles par
  // l'utilisateur courant (mêmes règles d'accès que getTickets), pour que
  // le Kanban puisse repérer/mettre en avant les tickets liés sans ouvrir
  // chaque fiche individuellement (une seule requête pour tout le board).
  if (!TCKNUM) {
    return services.getAllTicketLinks(USRID);
  }

  const existing = await services.getTicket(USRID, TCKNUM);
  if (!existing.length) {
    const err = new Error("Ticket introuvable ou accès refusé.");
    err.status = 404;
    throw err;
  }

  return services.getTicketLinks(existing[0].TCKID);
}

export async function addTicketLink(req) {
  const USRID = req?.payload?.data?.id;
  const { TCKNUM, LINKEDTCKNUM } = v.ticketLinkCreateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  if (TCKNUM === LINKEDTCKNUM) {
    const err = new Error("Un ticket ne peut pas être lié à lui-même.");
    err.status = 400;
    throw err;
  }

  const existing = await services.getTicket(USRID, TCKNUM);
  if (!existing.length) {
    const err = new Error("Ticket introuvable ou accès refusé.");
    err.status = 404;
    throw err;
  }

  const target = await services.getTicket(USRID, LINKEDTCKNUM);
  if (!target.length) {
    const err = new Error(
      `Ticket ${LINKEDTCKNUM} introuvable ou accès refusé.`,
    );
    err.status = 404;
    throw err;
  }

  await services.addTicketLink({
    TCKID: existing[0].TCKID,
    LINKEDTCKID: target[0].TCKID,
    CREUSR: USRID,
  });

  broadcastToAll({
    type: "ticket.link.created",
    payload: {
      TCKIDS: [existing[0].TCKID, target[0].TCKID],
    },
  });

  return services.getTicketLinks(existing[0].TCKID);
}

export async function removeTicketLink(req) {
  const { LNKID } = v.ticketLinkDeleteSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  await services.removeTicketLink(LNKID);

  broadcastToAll({ type: "ticket.link.deleted", payload: { LNKID } });

  return true;
}

/* ─────────────────────────────────────────────
   FUSION — Tickets fusionnés — Controllers
───────────────────────────────────────────── */

export async function getMergedTickets(req) {
  const USRID = req?.payload?.data?.id;
  const { TCKNUM } = v.ticketMergeListSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const existing = await services.getTicket(USRID, TCKNUM);
  if (!existing.length) {
    const err = new Error("Ticket introuvable ou accès refusé.");
    err.status = 404;
    throw err;
  }

  const ticket = existing[0];
  if (!ticket.MRGID) return [];

  return services.getMergedTickets(ticket.MRGID, ticket.TCKID);
}

/**
 * Fusionne TCKNUM avec un ou plusieurs autres tickets (MEMBERTCKNUMS).
 * Accès requis sur TOUS les tickets impliqués.
 *
 * Résolution du statut à conserver (règle produit "fusionner") :
 * - si l'utilisateur a choisi explicitement un statut (STSID) → celui-ci ;
 * - sinon, règle de priorité par défaut : on garde le statut du ticket
 *   "TCKNUM" (celui dans lequel les autres sont fusionnés) — c'est le cas
 *   d'usage typique décrit par le produit ("un nouveau ticket est fusionné
 *   avec un ticket existant déjà en cours" → l'existant garde son statut).
 *
 * Si TCKNUM appartient déjà à un groupe de fusion, les nouveaux membres
 * rejoignent CE groupe (plutôt que d'en créer un second) — cf.
 * commentaire de services.mergeTickets sur la nature "opaque" de MRGID.
 */
export async function mergeTickets(req) {
  const USRID = req?.payload?.data?.id;
  const { TCKNUM, MEMBERTCKNUMS, STSID } = v.ticketMergeSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const primaryRows = await services.getTicket(USRID, TCKNUM);
  if (!primaryRows.length) {
    const err = new Error("Ticket principal introuvable ou accès refusé.");
    err.status = 404;
    throw err;
  }
  const primary = utils.formatTicket(primaryRows);

  const uniqueMemberCodes = [
    ...new Set(MEMBERTCKNUMS.filter((code) => code !== TCKNUM)),
  ];
  if (!uniqueMemberCodes.length) {
    const err = new Error("Sélectionnez au moins un autre ticket à fusionner.");
    err.status = 400;
    throw err;
  }

  const members = [];
  for (const code of uniqueMemberCodes) {
    const rows = await services.getTicket(USRID, code);
    if (!rows.length) {
      const err = new Error(`Ticket ${code} introuvable ou accès refusé.`);
      err.status = 404;
      throw err;
    }
    members.push(utils.formatTicket(rows));
  }

  const targetSTSID = STSID ?? primary.STS?.STSID;
  if (!targetSTSID) {
    const err = new Error("Impossible de déterminer le statut à conserver.");
    err.status = 400;
    throw err;
  }

  const targetMRGID = primary.MRGID ?? primary.TCKID;
  const allTickets = [primary, ...members];
  const allTckids = allTickets.map((t) => t.TCKID);

  await services.mergeTickets({
    ALLTCKIDS: allTckids,
    TARGETMRGID: targetMRGID,
    TARGETSTSID: targetSTSID,
    USRID,
    NOTE: null,
  });

  broadcastToAll({
    type: "ticket.merged",
    payload: { MRGID: targetMRGID, TCKIDS: allTckids },
  });

  // Mail : chaque ticket dont le statut a réellement changé suit le même
  // circuit de notification (regroupé/anti-spam) qu'un changement de statut
  // normal (cf. updateTicket) — `t` ici est l'état AVANT la fusion.
  for (const t of allTickets) {
    if (t.STS?.STSID !== targetSTSID) {
      scheduleTicketUpdateNotification(t, USRID);
    }
  }

  return utils.formatTicket(await services.getTicket(USRID, TCKNUM));
}

export async function unmergeTicket(req) {
  const USRID = req?.payload?.data?.id;
  const { TCKNUM } = v.ticketUnmergeSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const existing = await services.getTicket(USRID, TCKNUM);
  if (!existing.length) {
    const err = new Error("Ticket introuvable ou accès refusé.");
    err.status = 404;
    throw err;
  }

  const ticket = existing[0];
  await services.unmergeTicket(ticket.TCKID);

  broadcastToAll({
    type: "ticket.unmerged",
    payload: { TCKID: ticket.TCKID, TCKCOD: ticket.TCKCOD },
  });

  return utils.formatTicket(await services.getTicket(USRID, TCKNUM));
}

/* ─────────────────────────────────────────────
   CATEGORIES — Controllers
───────────────────────────────────────────── */

export async function getCategories() {
  return services.getCategories();
}

/** Ne retourne que les catégories liées aux services de l'utilisateur */
export async function getMyCategoriesByServices(req) {
  const USRID = req?.payload?.data?.id;
  return services.getCategoriesByUserServices(USRID);
}

export async function createCategory(req) {
  const USRID = req?.payload?.data?.id;
  const body = v.categoryCreateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );
  return services.createCategory({ ...body, DESCR: body.DESCR ?? null, USRID });
}

export async function updateCategory(req) {
  const { catid } = req.params;
  const body = v.categoryUpdateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  return services.updateCategory({
    CATID: parseInt(catid, 10),
    NAME: body.NAME,
    DESCR: body.DESCR ?? null,
    ACTIVE: body.ACTIVE !== undefined ? body.ACTIVE : true,
  });
}

/* ── Sous-catégories 1 ───────────────────────────────────── */

export async function getSC1(req) {
  const { catid } = req.params;
  return services.getSC1(parseInt(catid, 10));
}

export async function createSC1(req) {
  const { catid } = req.params;
  const body = v.subcategoryCreateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );
  return services.createSC1({
    CATID: parseInt(catid, 10),
    NAME: body.NAME,
    DESCR: body.DESCR ?? null,
  });
}

export async function updateSC1(req) {
  const { sc1id } = req.params;
  const body = v.subcategoryUpdateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  return services.updateSC1({
    SC1ID: parseInt(sc1id, 10),
    NAME: body.NAME,
    DESCR: body.DESCR ?? null,
    ACTIVE: body.ACTIVE !== undefined ? body.ACTIVE : true,
  });
}

/* ── Sous-catégories 2 ───────────────────────────────────── */

export async function getSC2(req) {
  const { sc1id } = req.params;
  return services.getSC2(parseInt(sc1id, 10));
}

export async function createSC2(req) {
  const { sc1id } = req.params;
  const body = v.subcategoryCreateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );
  return services.createSC2({
    SC1ID: parseInt(sc1id, 10),
    NAME: body.NAME,
    DESCR: body.DESCR ?? null,
  });
}

export async function updateSC2(req) {
  const { sc2id } = req.params;
  const body = v.subcategoryUpdateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  return services.updateSC2({
    SC2ID: parseInt(sc2id, 10),
    NAME: body.NAME,
    DESCR: body.DESCR ?? null,
    ACTIVE: body.ACTIVE !== undefined ? body.ACTIVE : true,
  });
}

/* ── Sous-catégories 3 ───────────────────────────────────── */

export async function getSC3(req) {
  const { sc2id } = req.params;
  return services.getSC3(parseInt(sc2id, 10));
}

export async function createSC3(req) {
  const { sc2id } = req.params;
  const body = v.subcategoryCreateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );
  return services.createSC3({
    SC2ID: parseInt(sc2id, 10),
    NAME: body.NAME,
    DESCR: body.DESCR ?? null,
  });
}

export async function updateSC3(req) {
  const { sc3id } = req.params;
  const body = v.subcategoryUpdateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  return services.updateSC3({
    SC3ID: parseInt(sc3id, 10),
    NAME: body.NAME,
    DESCR: body.DESCR ?? null,
    ACTIVE: body.ACTIVE !== undefined ? body.ACTIVE : true,
  });
}

/* ─────────────────────────────────────────────
   SERVICES & ASSIGNMENTS — Controllers
───────────────────────────────────────────── */

export async function getServices() {
  const rows = await services.getServices();
  return utils.formatServices(rows);
}

/**
 * Variante "administration" (ADMIN/SUPERADMIN/DEV, cf. requirePermission
 * sur la route GET /services/all) : renvoie tous les services, actifs et
 * inactifs, pour l'écran de gestion des services/paramètres.
 */
export async function getAllServices() {
  return services.getAllServices();
}

export async function getManager(req) {
  const USRID = req?.payload?.data?.id;
  return services.getManager(USRID);
}

export async function createService(req) {
  const body = v.serviceCreateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );
  return services.createService({ NAME: body.NAME, DESCR: body.DESCR ?? null });
}

export async function updateService(req) {
  const { srvid } = req.params;
  const body = v.serviceUpdateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  return services.updateService({
    SRVID: parseInt(srvid, 10),
    NAME: body.NAME,
    DESCR: body.DESCR ?? null,
    ACTIVE: body.ACTIVE !== undefined ? body.ACTIVE : true,
  });
}

export async function getServiceMembers(req) {
  const { srvid } = req.params;
  return services.getServiceMembers(parseInt(srvid, 10));
}

export async function addServiceMember(req) {
  const { srvid } = req.params;
  const body = v.serviceMemberSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );
  return services.addServiceMember({
    SRVID: parseInt(srvid, 10),
    USRID: body.USRID,
    ACTIVE: body.ACTIVE !== undefined ? body.ACTIVE : true,
  });
}

export async function updateServiceMember(req) {
  const { srvid, usrid } = req.params;
  const body = v.serviceMemberUpdateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );
  return services.updateServiceMember({
    SRVID: parseInt(srvid, 10),
    USRID: parseInt(usrid, 10),
    ACTIVE: body.ACTIVE,
  });
}

export async function removeServiceMember(req) {
  const { srvid, usrid } = req.params;
  return services.removeServiceMember({
    SRVID: parseInt(srvid, 10),
    USRID: parseInt(usrid, 10),
  });
}

export async function getStatuses() {
  return services.getStatuses();
}

export async function getPriorities() {
  return services.getPriorities();
}

export async function createNote(req) {
  const USRID = req?.payload?.data?.id;
  const body = v.noteCreateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const { NTEID } = await services.createNote({ USRID, ...body });

  const tickets = await services.getNote({ USRID, NTEID });
  const formattedTicket = utils.formatTicket(tickets);

  broadcastToAll({
    type: "ticket.note.created",
    payload: {
      TCKID: formattedTicket.TCKID,
      TCKCOD: formattedTicket.TCKCOD,
      NTEID,
    },
  });

  const newNote =
    formattedTicket.NOTES.find((n) => String(n.NOTID) === String(NTEID)) ??
    formattedTicket.NOTES[0];

  // Anti-spam : différé et regroupé par ticket + sens de notification plutôt
  // qu'envoyé immédiatement (cf. commentaire d'en-tête) — évite un email par
  // note si le même auteur en écrit plusieurs coup sur coup.
  scheduleNoteNotification({ ticket: formattedTicket, note: newNote });

  return newNote;
}

export async function updateNote(req) {
  const USRID = req?.payload?.data?.id;
  const body = v.noteUpdateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  await services.updateNote({ USRID, ...body });

  const tickets = await services.getNote({ USRID, NTEID: body.NTEID });
  const formattedTicket = utils.formatTicket(tickets);

  // Manquait jusqu'ici (contrairement à createNote ci-dessus) : sans ce
  // broadcast, une modification de commentaire n'était jamais répercutée
  // en temps réel chez les autres utilisateurs (puce "non vu", carte,
  // modale ouverte).
  broadcastToAll({
    type: "ticket.note.updated",
    payload: {
      TCKID: formattedTicket.TCKID,
      TCKCOD: formattedTicket.TCKCOD,
      NTEID: body.NTEID,
    },
  });

  return (
    formattedTicket.NOTES.find((n) => String(n.NOTID) === String(body.NTEID)) ??
    formattedTicket.NOTES[0]
  );
}

export async function deleteNote(req) {
  const USRID = req?.payload?.data?.id;
  const { NTEID } = v.noteDeleteSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  // Contexte (TCKID/TCKCOD) récupéré AVANT suppression — impossible de
  // relier la note à son ticket une fois la ligne supprimée (cf. même
  // motif que deleteTodo ci-dessus).
  const existing = await services.getNote({ USRID, NTEID });
  const ticket = existing?.length ? utils.formatTicket(existing) : null;

  await services.deleteNote({ NTEID });

  // Manquait jusqu'ici, même motif que updateNote ci-dessus.
  if (ticket) {
    broadcastToAll({
      type: "ticket.note.deleted",
      payload: { TCKID: ticket.TCKID, TCKCOD: ticket.TCKCOD, NTEID },
    });
  }

  return true;
}

/* ─────────────────────────────────────────────
   TODOS — Controllers
   Pas de notification mail ici (contrairement aux notes/statuts) : les
   todos sont un outil de suivi personnel/d'équipe à faible enjeu, pas un
   événement de cycle de vie du ticket. Rien n'empêche d'en ajouter plus
   tard sur le même principe (notifyTicketEvent) si le besoin apparaît.
───────────────────────────────────────────── */

export async function getTodos(req) {
  const USRID = req?.payload?.data?.id;
  const { TCKID } = v.todoListSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const rows = TCKID
    ? await services.getTodosByTicket(USRID, TCKID)
    : await services.getTodos(USRID);

  return utils.formatTodos(rows);
}

export async function createTodo(req) {
  const USRID = req?.payload?.data?.id;
  const body = v.todoCreateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const { TDOID } = await services.createTodo({ USRID, ...body });
  if (!TDOID) throw new Error("DB_QUERY_ERROR");

  // Row brute (avant formatTodo, qui ne renvoie que les champs exposés au
  // client) : on y lit TCKCOD pour le broadcast ci-dessous — le front en a
  // besoin pour recharger le ticket concerné (GET ticketing?TCKNUM=…, seul
  // filtre supporté par cet endpoint), la puce "non vu" ainsi que la
  // TicketCard/modale devant refléter l'ajout de cette tâche.
  const rawTodo = await services.getTodo(USRID, TDOID);
  const newTodo = utils.formatTodo(rawTodo);

  broadcastToAll({
    type: "ticket.todo.created",
    payload: { TCKID: body.TCKID, TCKCOD: rawTodo?.TCKCOD ?? null, TDOID },
  });

  return newTodo;
}

export async function updateTodo(req) {
  const USRID = req?.payload?.data?.id;
  const body = v.todoUpdateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  await services.updateTodo({ USRID, ...body });
  const rawTodo = await services.getTodo(USRID, body.TDOID);
  const updatedTodo = utils.formatTodo(rawTodo);

  broadcastToAll({
    type: "ticket.todo.updated",
    payload: {
      TCKID: updatedTodo.TCKID,
      TCKCOD: rawTodo?.TCKCOD ?? null,
      TDOID: body.TDOID,
    },
  });

  return updatedTodo;
}

export async function deleteTodo(req) {
  const USRID = req?.payload?.data?.id;
  const { TDOID } = v.todoDeleteSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  // Contexte (TCKID/TCKCOD) récupéré AVANT suppression — impossible de
  // relier la tâche à son ticket une fois la ligne supprimée.
  const existing = await services.getTodo(USRID, TDOID);

  await services.deleteTodo({ TDOID });

  broadcastToAll({
    type: "ticket.todo.deleted",
    payload: {
      TDOID,
      TCKID: existing?.TCKID ?? null,
      TCKCOD: existing?.TCKCOD ?? null,
    },
  });

  return true;
}

/* ─────────────────────────────────────────────
   PROJECTS — Controllers
   Consultation (getProjects/getMyProjects/getProjectUsers) ouverte à tout
   utilisateur authentifié (authVerifyMiddleware suffit), comme pour
   SERVICES/CATEGORIES. En revanche, modification (updateProject,
   deleteProject, setProjectUsers) est réservée au créateur du projet
   (PROJECTS.CREUSR, cf. services.getProjectOwner/assertProjectOwner
   ci-dessous) — un utilisateur seulement associé (PROJECTUSERS) ne doit
   pouvoir que consulter le projet, jamais le modifier, même en appelant
   l'API directement (le front ne fait que refléter cette règle, cf.
   ProjectsBoard.tsx : bouton "Consulter" à la place de "Modifier"/
   "Supprimer" pour un projet dont il n'est pas ISOWNER).
───────────────────────────────────────────── */

/**
 * Vérifie que l'utilisateur courant est bien le créateur du projet
 * (PROJECTS.CREUSR) avant de laisser passer une modification. Lève une
 * erreur 404 si le projet n'existe pas, 403 s'il existe mais appartient à
 * quelqu'un d'autre — même politique que getTicketOwnerUsrid côté module
 * TICKETS (mergeTickets, addTicketLink, etc.).
 */
async function assertProjectOwner(PRJID, USRID) {
  const CREUSR = await services.getProjectOwner(PRJID);

  if (CREUSR === null) {
    const err = new Error("Projet introuvable.");
    err.status = 404;
    throw err;
  }

  if (String(CREUSR) !== String(USRID)) {
    const err = new Error(
      "Seul le créateur du projet peut effectuer cette action.",
    );
    err.status = 403;
    throw err;
  }
}

export async function getProjects() {
  return utils.formatProjects(await services.getProjects());
}

/**
 * Projets "à moi" pour l'utilisateur courant : ceux qu'il a créés
 * (CREUSR) et ceux auxquels il est associé (PROJECTUSERS) — cf.
 * services.getUserProjects pour le détail. Utilisé côté front à la fois
 * comme périmètre de visibilité de la page "Projets"/du filtre "Projet"
 * du Calendrier pour TOUT utilisateur, y compris un membre de service
 * (cf. ProjectsBoard.tsx/CalendarBoard.tsx — un membre de service ne doit
 * voir que ses propres projets, pas ceux des autres membres du même
 * service), et pour décider d'afficher le lien "Calendrier des tickets" à
 * un utilisateur qui n'est membre d'aucun service (cf. Nav.tsx).
 */
export async function getMyProjects(req) {
  const USRID = req?.payload?.data?.id;
  return services.getUserProjects(USRID);
}

export async function createProject(req) {
  const USRID = req?.payload?.data?.id;
  const body = v.projectCreateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const result = await services.createProject({
    NAME: body.NAME,
    DESCR: body.DESCR ?? null,
    COLOR: body.COLOR ?? null,
    CREUSR: USRID,
  });

  broadcastToAll({ type: "project.created", payload: result });

  return result;
}

export async function updateProject(req) {
  const { prjid } = req.params;
  const USRID = req?.payload?.data?.id;
  const PRJID = parseInt(prjid, 10);
  const body = v.projectUpdateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  await assertProjectOwner(PRJID, USRID);

  const result = await services.updateProject({
    PRJID,
    NAME: body.NAME,
    DESCR: body.DESCR ?? null,
    COLOR: body.COLOR ?? null,
    ACTIVE: body.ACTIVE !== undefined ? body.ACTIVE : true,
  });

  broadcastToAll({
    type: "project.updated",
    payload: { PRJID },
  });

  return result;
}

/**
 * Suppression physique d'un projet (cf. services.deleteProject) — refusée
 * (409) si des tickets y sont encore rattachés, et (403) si l'utilisateur
 * courant n'est pas le créateur du projet (cf. assertProjectOwner
 * ci-dessus et en-tête du module PROJECTS).
 */
export async function deleteProject(req) {
  const { prjid } = req.params;
  const USRID = req?.payload?.data?.id;
  const PRJID = parseInt(prjid, 10);

  await assertProjectOwner(PRJID, USRID);

  await services.deleteProject(PRJID);

  // Purge (soft-delete) des pièces jointes du projet une fois la suppression
  // en base confirmée (services.deleteProject lève une 409 si des tickets
  // sont encore rattachés : on ne veut pas supprimer les PJ dans ce cas).
  // Même mécanisme que usersmanager.controllers (filesServices.deleteFileByEntity).
  await filesServices.deleteFileByEntity("PROJECT", String(PRJID));

  broadcastToAll({ type: "project.deleted", payload: { PRJID } });

  return { PRJID };
}

/**
 * Utilisateurs associés à un projet (accès au Kanban "Projets"/Calendrier
 * du projet, cf. services.getProjectUsers/MyProjects). Même politique
 * d'accès que le reste du module PROJECTS ci-dessus : authVerifyMiddleware
 * suffit, pas de restriction de rôle côté API.
 */
export async function getProjectUsers(req) {
  const { prjid } = req.params;
  return services.getProjectUsers(parseInt(prjid, 10));
}

/**
 * Remplace intégralement la liste des utilisateurs associés à un projet
 * (delsert, même principe que setTicketCc/setTicketProjects) — réservé au
 * créateur du projet (cf. assertProjectOwner ci-dessus) : un utilisateur
 * simplement associé ne doit pas pouvoir ajouter/retirer d'autres membres.
 */
export async function setProjectUsers(req) {
  const { prjid } = req.params;
  const USRID = req?.payload?.data?.id;
  const PRJID = parseInt(prjid, 10);
  const body = v.projectUsersSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  await assertProjectOwner(PRJID, USRID);

  const result = await services.setProjectUsers({
    PRJID,
    USRIDS: body.USRIDS ?? [],
    CREUSR: USRID,
  });

  broadcastToAll({
    type: "project.users.updated",
    payload: { PRJID },
  });

  return result;
}

/**
 * Préférences utilisateur (module ticketing) : affichage/comportement du
 * formulaire de ticket (SHOWTASKSINFORM/AUTOSAVETICKET, ex-localStorage) et
 * préférences de notification mail (MAILONCC/MAILONPROJECT, cf.
 * getExtraMailRecipients ci-dessus). Toujours l'utilisateur courant (le
 * jeton JWT) : aucune route ne permet de lire/modifier les préférences
 * d'un tiers.
 */
export async function getMyUserSettings(req) {
  const USRID = req?.payload?.data?.id;
  return services.getUserSettings(USRID);
}

export async function updateMyUserSettings(req) {
  const body = v.userSettingsSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );
  const USRID = req?.payload?.data?.id;
  return services.upsertUserSettings(USRID, body);
}

/**
 * Marque un ticket comme consulté par l'utilisateur courant "maintenant"
 * (cf. sql/TICKETVIEWS.table.sql, flag UNSEEN dans SELECT_TICKETS). Appelé
 * par le front à l'ouverture du détail d'un ticket existant (TicketFormModal).
 * N'intéresse que l'utilisateur courant → pas de broadcastToAll ici.
 */
export async function markTicketSeen(req) {
  const USRID = req?.payload?.data?.id;
  const { TCKNUM } = v.ticketSeenSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const existing = await services.getTicket(USRID, TCKNUM);
  if (!existing.length) {
    const err = new Error("Ticket introuvable ou accès refusé.");
    err.status = 404;
    throw err;
  }

  await services.markTicketSeen(USRID, existing[0].TCKID);

  return { TCKID: existing[0].TCKID, TCKCOD: TCKNUM };
}
