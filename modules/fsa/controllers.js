import * as services from "./services.js";
import * as utils from "./utils.js";
import * as requestUtils from "../../core/utils/request.utils.js";
import * as v from "./validators.js";
import * as usersmanagerService from "../usersmanager/services.js";
import * as usersmanagerUtils from "../usersmanager/utils.js";
import * as dwhbiService from "../dwhbi/services.js";
import * as dwhbiUtils from "../dwhbi/utils.js";
import {
  sendTemplatedMail,
  renderDetailGroups,
  renderNoteList,
  renderFolderList,
  renderNoticeList,
  resolveMailCopies,
} from "../../core/services/mail.service.js";
import { logger } from "../../config/logger.config.js";

/* ─────────────────────────────────────────────
   FSA — Controllers (Fiches Suivi Affaires)
   Responsabilité : valider les paramètres (zod), appeler le service,
   formater la réponse, notifier par mail.

   Emails (cf. audit, même pattern que declcav/ticketing) : V1.0.0 appelait
   un service `emailService.send({ appCode: "FSA", type, data })` qui
   n'existe plus (modules/emails retiré du périmètre V1.1.0). On utilise ici
   le service mail générique core/services/mail.service.js. Les templates
   GÉNÉRIQUES utilisés jusqu'ici (mappés depuis les anciens templates custom
   FSA) ont été remplacés par des templates DÉDIÉS FSA
   (core/services/mail-templates/fsa/), même démarche que la migration déjà
   faite pour Ticketing (cf. mail-templates/ticketing/) :
     - newFsaFolder        → "fsa/creation"            (création/soumission d'un dossier)
     - newFsaValidation    → "fsa/validation"  (validation, ni VAL ni REF)
     - newFsaValidationVal → "fsa/validation-approved" (dossier validé, CODETA = VAL)
     - newFsaValidationRef → "fsa/validation-rejected" (dossier refusé, CODETA = REF)
     - dailyRelaunch       → "fsa/reminder"             (relance groupée, plusieurs dossiers)
   Champs FSA spécifiques passés à ces templates (cf. mail-templates/fsa/*.html,
   et notifyFsaEvent() ci-dessous) : DOSSIER_CODE (badge, NUMDOS), NOMDOS
   (titre du dossier), NOTDOS (détail de la demande, à la création
   uniquement), NOTES_HTML (commentaire du valideur, via renderNoteList()) et
   DOSSIERS_HTML/DOSSIER_COUNT (relance groupée sur plusieurs dossiers, via
   renderFolderList()).
   L'envoi est toujours best-effort (jamais bloquant pour l'opération métier),
   même pattern que notifyDeclcavEvent()/notifyTicketEvent().

   Destinataires : en développement (NODE_ENV !== "production"), tous les
   mails partent vers BASE_RECIPIENT_EMAIL au lieu des vraies adresses
   métier (mêmes garde-fous que declcav/ticketing).

   Correctifs de sécurité/dette appliqués par rapport à V1.0.0 (cf. audit) :
   - CREUSR n'est plus jamais construit à partir d'un couple LastName/FirstName
     codé en dur ; V1.0.0 utilisait déjà `req.payload.data` ici (contrairement
     au bug corrigé dans declcav), ce comportement est conservé tel quel.
   - `postValidation` (V1.0.0) construisait le nom du valideur à partir de
     `req.payload.data.LastName`/`FirstName` ET les réutilisait mal nommés
     (`ATTPT`/`GESNAM`, des noms de variables visiblement copiés-collés
     depuis `patchFsa` où `ATTPT`/`GESNAM` désignent en réalité le
     SERVICE/nom du GESTIONNAIRE du dossier, pas le valideur). Conservé ici
     sous des noms clairs (`validatorLastName`/`validatorFirstName`) sans
     changer la donnée envoyée.
   - Bug corrigé : `patchFsa` (V1.0.0) calculait
     `valEmails.map((v) => v.EMAIL).push(BASE_RECIPIENT_EMAIL)` — `.push()`
     renvoie la NOUVELLE LONGUEUR du tableau (un number), pas le tableau
     lui-même. `emails` valait donc un nombre, et `emails.join(", ")` aurait
     levé une exception (TypeError) si jamais exécuté avec IS_PROD=true.
     Corrigé en construisant explicitement le tableau puis en y ajoutant
     BASE_RECIPIENT_EMAIL sans muter le résultat de `.map()` en place.
   - Les destinataires des notifications de validation viennent uniquement
     des données métier en base (emails du gestionnaire/demandeur du dossier,
     de `services.getValEmails()`), jamais d'un champ fourni tel quel par le
     client dans le corps de la requête — le body FSA ne contient d'ailleurs
     aucun champ email de ce type en V1.0.0.
   - Toute validation manuelle `if (!x) throw new Error(...)` est remplacée
     par un schéma zod (validators.js), cf. audit dette technique 4.4.
   - Nomenclature depuis un code produit PFI (dwhbiService.getNomenclatureByPFI)
     : le module `dwhbi` n'a pas encore été reconstruit en V1.1.0 (aucun
     config/db/dwhbi.db.config.js, aucun modules/dwhbi). Cette branche
     (paramètre PFICOD dans postFsa) est donc temporairement indisponible ;
     PFICOD est accepté par le schéma zod mais ignoré, à réintégrer dès que
     le module dwhbi sera porté.
───────────────────────────────────────────── */

const IS_PROD = process.env.NODE_ENV === "production";
const DOMAIN = process.env.DOMAIN;
const BASE_RECIPIENT_EMAIL = process.env.BASE_RECIPIENT_EMAIL;

function getUserIdentity(req) {
  return {
    CREUSR:
      `${req?.payload?.data?.LastName ?? ""} ${req?.payload?.data?.FirstName ?? ""}`.trim(),
    USRID: req?.payload?.data?.id,
    NUMGES: req?.payload?.data?.position?.code,
  };
}

/**
 * Copies mails (USERSMANAGER.dbo.USRMAILCPY) : en production, sendMail()
 * ajoute en BCC les utilisateurs qui suivent les mails d'un destinataire.
 * Ex. Valérie (finance) en copie de Sylvie (direction) reçoit aussi les
 * soumissions, relances et résultats de validation adressés à Sylvie.
 *
 * En développement, tout part vers BASE_RECIPIENT_EMAIL : les copies ne
 * sont pas envoyées (noMailCopies) mais listées dans un encart du mail,
 * avec les destinataires réels, pour pouvoir vérifier le routage.
 */
async function buildDevRecipientsNotice(recipient) {
  const copies = recipient ? await resolveMailCopies(recipient) : [];

  return renderNoticeList([
    {
      type: "info",
      label: "Environnement de développement",
      message: [
        `Destinataires en production : ${recipient || "aucun"}`,
        `Copies mails (BCC) : ${copies.length ? copies.join(", ") : "aucune"}`,
      ].join("\n"),
    },
  ]);
}

/**
 * Envoi best-effort d'une notification fsa. N'importe quelle erreur (SMTP non
 * configuré, template introuvable, destinataire manquant en dev...) est
 * loguée mais jamais propagée : un souci d'email ne doit jamais faire
 * échouer une opération métier fsa.
 */
async function notifyFsaEvent({
  template,
  subject,
  message,
  recipient,
  dossierCode,
  nomdos,
  notdos,
  comment,
  detailGroups = [],
  dossiers = [],
  actionUrl = null,
  actionLabel = "Voir le dossier",
}) {
  const to = IS_PROD ? recipient : BASE_RECIPIENT_EMAIL;

  if (!to) {
    logger.warn(
      `[FSA][MAIL] Aucun destinataire résolu pour "${template}" (${subject}) — envoi ignoré.`,
    );
    return;
  }

  try {
    await sendTemplatedMail({
      from: "fsa@union-vignerons.com",
      template,
      to,
      subject,
      noMailCopies: !IS_PROD,
      data: {
        NOTICES_HTML: IS_PROD
          ? undefined
          : await buildDevRecipientsNotice(recipient),
        APP_NAME: "FSA UVCDR",
        TITLE: subject,
        MESSAGE: message,
        DOSSIER_CODE: dossierCode ?? undefined,
        NOMDOS: nomdos ?? undefined,
        NOTDOS: notdos ?? undefined,
        DETAILS_ROWS_HTML: detailGroups.length
          ? renderDetailGroups(detailGroups)
          : undefined,
        // Commentaire du valideur (VALNOT), affiché comme un bloc citation
        // distinct plutôt que noyé dans DETAILS_ROWS_HTML — même traitement
        // que les notes ticketing (cf. renderNoteList()).
        NOTES_HTML: comment?.content ? renderNoteList([comment]) : undefined,
        // Relance groupée (dailyRelaunch) : plusieurs dossiers pour un même
        // destinataire, affichés en liste plutôt qu'en un unique badge
        // DOSSIER_CODE (cf. fsa/reminder.html).
        DOSSIERS_HTML: dossiers.length ? renderFolderList(dossiers) : undefined,
        DOSSIER_COUNT: dossiers.length || undefined,
        ACTION_URL: actionUrl ?? undefined,
        ACTION_LABEL: actionLabel,
      },
    });
  } catch (err) {
    logger.error(
      `[FSA][MAIL] Échec envoi "${template}" (${subject}) : ${err.message}`,
    );
  }
}

/**
 * Dossier fictif utilisé uniquement par testFsaMailTemplates() (route de
 * test manuelle, cf. GET /fsa/mail-templates/test) pour peupler les
 * placeholders des templates fsa/*.html sans dépendre d'un dossier réel en
 * base. Même principe que SAMPLE_TEST_TICKET dans modules/ticketing/
 * controllers.js, mais avec la VRAIE forme d'un dossier fsa telle que
 * renvoyée par utils.formatFsasJson() (FSAENT/FSACLIENT/FSAPRODUITS/
 * FSAVENTES/FSAPJS/FSAVALIDS — cf. modules/fsa/utils.js, mapFolder()) plutôt
 * qu'un objet plat : ce test doit lire les données exactement comme
 * patchFsa()/postValidation() le font sur un vrai dossier, pour prévenir
 * tout écart de champ qui passerait inaperçu avec des raccourcis.
 */
const SAMPLE_TEST_FSA = {
  FSAENT: {
    ENTID: 1,
    APPVRS: "V1.1.0",
    NUMDOS: "FSA-260921-00001",
    NUMDOSBAS: null,
    NOMDOS: "Dossier de test — aperçu des templates email",
    TYPE: {
      TYPID: 1,
      TYPDOS: "STD",
      TYDOSN: "Dossier standard",
    },
    GESUSRID: 1001,
    // Gestionnaire du dossier — c'est lui (SERVGES + GESNAM) que patchFsa()
    // utilise pour construire "applicant" à la création (cf. notifyFsaEvent
    // "fsa/creation" plus haut), pas le demandeur (DEMA).
    GEST: {
      USRID: 1001,
      GESID: 10,
      NUMGES: "G010",
      NOMGES: "Service Commercial",
      VALGES: true,
      CREGES: true,
      SERVGES: "Service Commercial",
      GESNAM: "Marie Martin",
      CREUSR: "Marie Martin",
      CREDAT: "2026-09-21T08:00:00.000+02:00",
      MODUSR: "Marie Martin",
      MODDAT: "2026-09-21T08:00:00.000+02:00",
    },
    // Demandeur — non utilisé par les templates actuels (cf. commentaire
    // ci-dessus) mais renseigné pour rester fidèle à la forme réelle.
    DEMA: {
      USRID: 1002,
      GESID: 11,
      NUMGES: "G011",
      NOMGES: "Service Production",
      VALGES: false,
      CREGES: false,
      SERVGES: "Service Production",
      GESNAM: "Jean Dupont",
      CREUSR: "Jean Dupont",
      CREDAT: "2026-09-21T08:00:00.000+02:00",
      MODUSR: "Jean Dupont",
      MODDAT: "2026-09-21T08:00:00.000+02:00",
    },
    SRVMSTVAL: [],
    CURETADOS: {
      STAID: 1,
      CODETA: "EAV",
      DESETA: "En attente de validation",
    },
    NOTDOS:
      "Ceci est un détail de demande de test généré par la route de prévisualisation des templates fsa.",
    CREUSR: "Jean Dupont",
    CREDAT: "2026-09-21T08:00:00.000+02:00",
    EAVDAT: "2026-09-21T08:00:00.000+02:00",
    MODUSR: "Jean Dupont",
    MODDAT: "2026-09-21T08:00:00.000+02:00",
    DELETED: false,
    INNO: false,
  },

  FSACLIENT: {
    CLIENTID: 1,
    NUMDOS: "FSA-260921-00001",
    CLIEXI: true,
    BPCNUM: "C000123",
    BPCNAM: "Client Test SARL",
    CLIPAY: {
      PAYSID: 1,
      NUMDOS: "FSA-260921-00001",
      CLIPAY: "FR",
      CLIPAYN: "France",
    },
    CLIACT: "01",
    NOMACT: "Grande distribution",
    CLICCON: "Contact Test",
    CLINAM: "Paul Client",
    CLIMAIL: "client-test@example.com",
    CLITEL: "0102030405",
    CLINOT: "Client de test.",
  },

  FSAPRODUITS: {
    PRODUITID: 1,
    NUMDOS: "FSA-260921-00001",
    TCLCOD: "CHA",
    CATNOM: "Chardonnay",
    ITMREF: "REF-CHA-001",
    ITMDES: "Chardonnay IGP",
    ITMFMT: "75CL",
    DESFMT: "Bouteille 75cl",
    CENTFMT: 1,
    ITMMAR: "MARQ",
    DESMAR: "Marque Test",
    ITMGAM: "GAM",
    DESGAM: "Gamme Test",
    ITMAPP: "APP",
    DESAPP: "AOP Test",
    ITMCEP: "CEP",
    DESCEP: "Chardonnay",
    ITMCOU: "BLA",
    DESCOU: "Blanc",
    ITMQUA: "STD",
    DESQUA: "Standard",
    ITMTYP: "TRA",
    DESTYP: "Tranquille",
    ITMSPT: null,
    DESSPT: null,
    ITMMIL: "2024",
    CODCHADOM: null,
    CHADOM: null,
    CODDESALC: false,
    CODBOIS: false,
    MEDAIL: null,
    ITMCON: null,
    ITMNOT: null,
    NOMENCLATURES: [],
  },

  FSAVENTES: {
    VENTEID: 1,
    NUMDOS: "FSA-260921-00001",
    DATMAD: "2026-09-21T00:00:00.000+02:00",
    ONESHO: false,
    VOLANN: 1000,
    VOLANN1: 1000,
    VOLANN2: 1000,
    VOLTIR: 5000,
    PRIANN: 3.5,
    PRIANN1: 3.5,
    PRIANN2: 3.6,
    PVC: 6.9,
    VENNOT: "Vente de test.",
    FRANCO: true,
    FDC: false,
    AFA: false,
    AFANOT: null,
  },

  FSAPJS: [],

  // Un seul enregistrement de validation, de type "Direction" — suffisant
  // pour peupler les templates VAL/REF/PARTIAL (seul VALTYP/VALNOT/CREUSR
  // nous intéressent ici, cf. getMailTemplateVariants() ci-dessous).
  FSAVALIDS: [
    {
      VALIDID: 1,
      NUMDOS: "FSA-260921-00001",
      GEST: {
        USRID: null,
        GESID: 12,
        NUMGES: "G012",
        NOMGES: "Assitant de direction",
        VALGES: true,
        CREGES: false,
        SERVGES: "Direction",
        ENBUSRS: [],
        GESNAM: "Marie Martin",
        CREUSR: "Marie Martin",
        CREDAT: "2026-09-21T09:00:00.000+02:00",
        MODUSR: "Marie Martin",
        MODDAT: "2026-09-21T09:00:00.000+02:00",
      },
      VALTYP: {
        VALTYPID: 1,
        VALTYPCOD: "VAL",
        VALTYPNOM: "Validé",
      },
      VALNOT:
        "Commentaire de test : dossier conforme, aucune remarque particulière.",
      CREDAT: "2026-09-21T09:00:00.000+02:00",
      // CREUSR : auteur de la validation, résolu depuis le JWT côté réel
      // (cf. getUserIdentity/postValidation) — utilisé ici comme auteur du
      // commentaire prévisualisé (NOTES_HTML).
      CREUSR: "Marie Martin",
      PJS: [],
    },
  ],
};

/**
 * Dossiers fictifs utilisés uniquement par la variante REMINDER (relance
 * groupée sur plusieurs dossiers, cf. fsa/reminder.html / DOSSIERS_HTML) —
 * un événement qui porte sur PLUSIEURS NUMDOS et non sur le dossier complet
 * ci-dessus, d'où une structure séparée, plus légère (mêmes codes que
 * dailyRelaunch() : simples NUMDOS regroupés par destinataire).
 */
const SAMPLE_TEST_DOSSIERS = ["FSA-260921-00001", "FSA-260921-00002"];

/**
 * Une entrée par template de core/services/mail-templates/fsa/ : les mêmes
 * subject/message, et la MÊME LECTURE DES CHAMPS (fsa.FSAENT.*,
 * fsa.FSAVALIDS[0].*), que les fonctions notifyFsaEvent()/patchFsa()/
 * postValidation()/dailyRelaunch() correspondantes (cf. commentaire d'en-tête
 * de ce fichier), pour que cette route de test prévisualise exactement ce
 * qu'un vrai dossier enverrait.
 */
function getMailTemplateVariants(fsa) {
  const { NUMDOS, NOMDOS, NOTDOS, GEST, TYPE, INNO } = fsa.FSAENT;
  const [validation] = fsa.FSAVALIDS;

  const detailsCreation = renderDetailGroups([
    {
      title: "Informations générales",
      items: [
        { label: "Type de dossier", value: TYPE.TYDOSN },
        { label: "Innovation", value: INNO ? "Oui" : "Non" },
      ],
    },
    {
      title: "Demande",
      items: [
        { label: "Service demandeur", value: GEST.SERVGES },
        { label: "Demandeur", value: GEST.GESNAM },
      ],
    },
  ]);

  const detailsValidation = renderDetailGroups([
    {
      title: "Valideur",
      items: [
        { label: "Service", value: validation.GEST.SERVGES },
        { label: "Utilisateur", value: validation.GEST.GESNAM },
      ],
    },
    {
      title: "Validation",
      items: [
        { label: "Validation", value: validation.VALTYP.VALTYPNOM },
        { label: "Pièces jointe", value: validation.PJS.length },
      ],
    },
  ]);

  const notesValidation = renderNoteList([
    { author: validation.GEST.GESNAM, content: validation.VALNOT },
  ]);

  const dossiersHtml = renderFolderList(
    SAMPLE_TEST_DOSSIERS.map((numdos) => ({
      code: numdos,
      url: `${DOMAIN}/fsa/folders/${numdos}/0`,
    })),
  );

  return [
    {
      key: "CREATION",
      template: "fsa/creation",
      subject: `Nouveau dossier FSA ${NUMDOS}`,
      message:
        "Un nouveau dossier FSA vient d'être créé et soumis à votre validation.",
      data: {
        DOSSIER_CODE: NUMDOS,
        NOMDOS,
        NOTDOS,
        DETAILS_ROWS_HTML: detailsCreation,
      },
    },
    {
      key: "VAL",
      template: "fsa/validation-approved",
      subject: `Dossier FSA ${NUMDOS} validé`,
      message: "Votre dossier FSA vient d'être validé.",
      data: {
        DOSSIER_CODE: NUMDOS,
        NOMDOS,
        DETAILS_ROWS_HTML: detailsValidation,
        NOTES_HTML: notesValidation,
      },
    },
    {
      key: "REF",
      template: "fsa/validation-rejected",
      subject: `Dossier FSA ${NUMDOS} refusé`,
      message: "Votre dossier FSA vient d'être refusé.",
      data: {
        DOSSIER_CODE: NUMDOS,
        NOMDOS,
        DETAILS_ROWS_HTML: detailsValidation,
        NOTES_HTML: notesValidation,
      },
    },
    {
      key: "PARTIAL",
      template: "fsa/validation",
      subject: `Validation d'un dossier FSA — ${NUMDOS}`,
      message: "Une validation vient d'être effectuée sur votre dossier FSA.",
      data: {
        DOSSIER_CODE: NUMDOS,
        NOMDOS,
        DETAILS_ROWS_HTML: detailsValidation,
        NOTES_HTML: notesValidation,
      },
    },
    {
      key: "REMINDER",
      template: "fsa/reminder",
      subject: "Relance dossier(s) FSA en attente de validation",
      message:
        "Un ou plusieurs dossiers FSA sont en attente de votre validation.",
      data: {
        DOSSIERS_HTML: dossiersHtml,
        DOSSIER_COUNT: SAMPLE_TEST_DOSSIERS.length,
      },
    },
  ];
}

/**
 * Route de test manuelle (dev/staging uniquement, cf. IS_PROD dans
 * routes.js) : envoie un exemplaire de CHAQUE variante d'email fsa (5
 * templates) à BASE_RECIPIENT_EMAIL, pour vérifier visuellement leur rendu
 * dans une vraie boîte mail après une modification des templates — sans
 * avoir à faire transiter un vrai dossier par tout le cycle de validation.
 * Même principe que testTicketMailTemplates() dans modules/ticketing/
 * controllers.js.
 *
 * `?template=<nom>` (ex: "creation", "validation-approved") restreint
 * l'envoi à la seule variante correspondante ; sans paramètre, les 5
 * templates sont envoyés.
 *
 * Toujours envoyé à BASE_RECIPIENT_EMAIL, jamais à un utilisateur réel :
 * indépendant de la logique de destinataires (recipient réel/dev) de
 * notifyFsaEvent() — ce n'est pas un test métier, juste un aperçu de
 * gabarits.
 *
 * Best-effort par variante : une erreur sur un template (ex: fichier
 * introuvable après une modification en cours) ne doit pas empêcher
 * l'envoi des autres — chaque résultat est rapporté individuellement dans
 * la réponse plutôt que de faire échouer toute la requête.
 */
export async function testFsaMailTemplates(req) {
  if (!BASE_RECIPIENT_EMAIL) {
    const err = new Error(
      "BASE_RECIPIENT_EMAIL n'est pas configuré (variable d'environnement requise pour ce test).",
    );
    err.status = 400;
    throw err;
  }

  const { template } = (await requestUtils.getRequestParams(req)).params;

  const fsa = SAMPLE_TEST_FSA;
  const APP_NAME = "FSA UVCDR";
  const APP_MAIL = "fsa@union-vignerons.com";

  const results = [];

  for (const variant of getMailTemplateVariants(fsa)) {
    if (
      (template !== undefined && variant.template.includes(`/${template}`)) ||
      template === undefined
    ) {
      const subject = `[TEST] ${variant.subject}`;

      const data = {
        APP_NAME,
        TITLE: subject,
        MESSAGE: variant.message,
        ACTION_URL: `${DOMAIN}/fsa/folders/${fsa.FSAENT.NUMDOS}/0`,
        ACTION_LABEL:
          variant.key === "REMINDER" ? "Voir mes dossiers" : "Voir le dossier",
        ...variant.data,
      };

      try {
        await sendTemplatedMail({
          from: APP_MAIL,
          template: variant.template,
          to: BASE_RECIPIENT_EMAIL,
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
          `[FSA][MAIL][TEST] Échec envoi "${variant.template}" : ${err.message}`,
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
    to: BASE_RECIPIENT_EMAIL,
    sent: results.filter((r) => r.status === "sent").length,
    failed: results.filter((r) => r.status === "error").length,
    results,
  };
}

/**
 * Planifiée par routes.js via core/utils/scheduler.utils.js (scheduleDailyTask).
 * Relance chaque email ayant un ou plusieurs dossiers en attente de
 * validation (statut EAV), en regroupant les NUMDOS par destinataire.
 */
export async function dailyRelaunch() {
  const valEmails = await services.getValEmails();

  if (!valEmails.length) {
    throw new Error("DATA_NOT_FOUND");
  }

  // Regroupement par EMAIL pour éviter de traiter plusieurs fois le même destinataire
  const dossiersByEmail = Object.values(
    valEmails.reduce((acc, item) => {
      if (!acc[item.EMAIL]) {
        acc[item.EMAIL] = { EMAIL: item.EMAIL, NUMDOS: [] };
      }

      if (!acc[item.EMAIL].NUMDOS.includes(item.NUMDOS)) {
        acc[item.EMAIL].NUMDOS.push(item.NUMDOS);
      }

      return acc;
    }, {}),
  );

  for (const group of dossiersByEmail) {
    await notifyFsaEvent({
      template: "fsa/reminder",
      subject: "Relance dossier(s) FSA en attente de validation",
      message:
        "Un ou plusieurs dossiers FSA sont en attente de votre validation.",
      recipient: group.EMAIL,
      dossiers: group.NUMDOS.map((numdos) => ({
        code: numdos,
        url: `${DOMAIN}/fsa/folders/${numdos}/0`,
      })),
      actionUrl: `${DOMAIN}/fsa/folders/${group.NUMDOS[0]}/0`,
      actionLabel: "Voir mes dossiers",
    });
  }

  return true;
}

/* -------------------------------------------------------------------------- */
/*                                    GETS                                    */
/* -------------------------------------------------------------------------- */

export async function getFsas(req) {
  const { numdos, numges, permlvl, type } = v.foldersQuerySchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const { USRID } = getUserIdentity(req);

  /* ------------------------------------------------------------------
   * 1. Sélection de la source FSA
   * ------------------------------------------------------------------ */
  const getSourceFsas = () => {
    if (numdos) return services.getFsa(numdos);

    if (numges && permlvl) {
      if (permlvl > 2) {
        if (permlvl === 5) return services.getReadOnlyFsas(type);

        if (type === "delete") {
          return services.getFsas(USRID, type);
        }
        return services.getFsas(USRID, type);
      }

      return services.getFsas(USRID, type);
    }

    return services.getFsas(USRID, type);
  };

  /* ------------------------------------------------------------------
   * 2. Traitement et formatage final
   * ------------------------------------------------------------------ */
  const gestsMustValidate = await services.getGestsMustValidate();
  const formattedGests = utils.formatGestsMustValidate(gestsMustValidate);

  const rawFsa = await getSourceFsas();
  const formattedFsas = numdos
    ? utils.formatFsasJson(rawFsa, formattedGests)
    : utils.formatFsasJsonList(rawFsa, formattedGests);

  return numdos ? formattedFsas[0] : formattedFsas;
}

export async function getGestionnaires() {
  const rawGestionnaires = await services.getGestionnaires();
  return utils.formatGestionnaires(rawGestionnaires);
}

export async function getStatusGest(req) {
  const { usrid } = v.statusGestQuerySchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const rawStatusGest = await services.getStatusGest(usrid);
  return utils.formatStatusGest(rawStatusGest, usrid);
}

export async function getGestsMustValidate() {
  const gestsMustValidate = await services.getGestsMustValidate();
  return utils.formatGestsMustValidate(gestsMustValidate);
}

export async function getGestsMustValidateByNumDos(req) {
  const { numdos } = v.gestsMustValidateByNumDosSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const gestsMustValidate = await services.getGestsMustValidateByNumDos(numdos);
  const formattedGestsMustValidate =
    utils.formatGestsMustValidate(gestsMustValidate);

  if (!formattedGestsMustValidate.length || !formattedGestsMustValidate[0])
    throw new Error("DATA_NOT_FOUND");

  return formattedGestsMustValidate[0];
}

export async function getStatus() {
  return services.getStatus();
}

export async function getTypes() {
  return services.getTypes();
}

export async function getServices() {
  const rawServices = await services.getServices();
  return utils.formatServices(rawServices);
}

export async function getValTypes() {
  return services.getValTypes();
}

export async function getValDelays() {
  return services.getValDelays();
}

export async function getCanDelGests() {
  const rawCanDelGests = await services.getCanDelGests();
  return utils.formatCanDelGests(rawCanDelGests);
}

export async function getValEmails() {
  return services.getValEmails();
}

export async function getConditionOperators() {
  return services.getConditionOperators();
}

export async function getViewFields() {
  return services.getViewFields();
}

export async function getGestConditions() {
  return services.getGestConditions();
}

/**
 * Paramètres globaux de l'application FSA (délais du cycle de vie des
 * dossiers : validation/archivage/corbeille/purge), persistés dans la table
 * singleton [dbo].[FSASETTINGS]. Alimente SettingsPage.tsx (onglet "Général"),
 * qui tournait jusqu'ici uniquement sur DEFAULT_APP_SETTINGS côté front.
 */
export async function getSettings() {
  const rawSettings = await services.getSettings();
  const formattedSettings = utils.formatSettings(rawSettings);

  if (!formattedSettings) throw new Error("DATA_NOT_FOUND");

  return formattedSettings;
}

/* -------------------------------------------------------------------------- */
/*                                   POSTS                                    */
/* -------------------------------------------------------------------------- */

export async function postFsa(req) {
  const { PFICOD, NUMDOSBAS, NOMDOS, TYPDOS, NUMGES, NUMDEM, INNO, NOTDOS } =
    v.fsaCreateSchema.parse((await requestUtils.getRequestParams(req)).params);

  const { CREUSR, USRID } = getUserIdentity(req);

  let NOMENCLATURE = [];
  let PRODUCT = undefined;

  const newRawNumDos = await services.postFsa(
    NUMDOSBAS,
    NOMDOS,
    TYPDOS,
    USRID || 0,
    NUMGES,
    NUMDEM,
    INNO,
    NOTDOS,
    CREUSR,
  );

  if (!newRawNumDos.length || !newRawNumDos[0].NUMDOS)
    throw new Error("DATA_NOT_FOUND");

  const newNumDos = newRawNumDos[0].NUMDOS;

  if (PFICOD) {
    const pfiNommenclature = await dwhbiService.getNomenclatureByPFI(PFICOD);
    const formattedPfiNommenclature =
      await dwhbiUtils.formatNomenclature(pfiNommenclature);

    NOMENCLATURE = formattedPfiNommenclature;
    PRODUCT = {
      TCLCOD: NOMENCLATURE[0].CODCAT,
      CATNOM: NOMENCLATURE[0].LLCAT,
      ITMREF: NOMENCLATURE[0].ITMREF,
      ITMDES: NOMENCLATURE[0].ITMDES,
      ITMFMT: NOMENCLATURE[0].CODFMT,
      DESFMT: NOMENCLATURE[0].LLFMT,
      CENTFMT: NOMENCLATURE[0].COEFFMT,
    };

    await services.delsertNomenclature(newNumDos, NOMENCLATURE);
    await services.upsertProduct(newNumDos, PRODUCT);
  }

  const gestsMustValidate =
    await services.getGestsMustValidateByNumDos(newNumDos);
  const formattedGestsMustValidate =
    utils.formatGestsMustValidate(gestsMustValidate);

  const newRawsFsa = await services.getFsa(newNumDos);
  const newFormattedFsa = utils.formatFsasJson(
    newRawsFsa,
    formattedGestsMustValidate,
  );

  if (!newFormattedFsa.length) throw new Error("DATA_NOT_FOUND");

  return newFormattedFsa[0];
}

export async function duplicateFsa(req) {
  const { NUMDOS, NOMDOS, PFICOD, NOTDOS } = v.fsaDuplicateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const { CREUSR } = getUserIdentity(req);

  let NOMENCLATURE = [];
  let PRODUCT = undefined;

  const baseFsaData = await services.getFsa(NUMDOS);
  const formattedBaseFsa = utils.formatFsasJson(baseFsaData);

  if (!formattedBaseFsa.length || !formattedBaseFsa[0])
    throw new Error("DATA_NOT_FOUND");

  const baseFsa = formattedBaseFsa[0];

  const newRawNumDos = await services.postFsa(
    NUMDOS,
    NOMDOS ?? baseFsa.FSAENT.NOMDOS,
    baseFsa.FSAENT.TYPE.TYPDOS,
    baseFsa.FSAENT.GESUSRID,
    baseFsa.FSAENT.GEST.NUMGES,
    baseFsa.FSAENT.DEMA.NUMGES,
    baseFsa.FSAENT.INNO,
    NOTDOS ?? "",
    CREUSR,
  );

  if (!newRawNumDos.length || !newRawNumDos[0])
    throw new Error("DATA_NOT_FOUND");

  const newNumDos = newRawNumDos[0].NUMDOS;
  if (!newNumDos) throw new Error("MISSING_PARAMETERS");

  const { FSACLIENT, FSAPRODUITS, FSAVENTES } = baseFsa;
  const FSANOMENCLATURES = FSAPRODUITS?.NOMENCLATURES;

  if (PFICOD) {
    const pfiNommenclature = await dwhbiService.getNomenclatureByPFI(PFICOD);
    const formattedPfiNommenclature =
      await dwhbiUtils.formatNomenclature(pfiNommenclature);

    NOMENCLATURE = formattedPfiNommenclature;
    PRODUCT = {
      TCLCOD: NOMENCLATURE[0].CODCAT,
      CATNOM: NOMENCLATURE[0].LLCAT,
      ITMREF: NOMENCLATURE[0].ITMREF,
      ITMDES: NOMENCLATURE[0].ITMDES,
      ITMFMT: NOMENCLATURE[0].CODFMT,
      DESFMT: NOMENCLATURE[0].LLFMT,
      CENTFMT: NOMENCLATURE[0].COEFFMT,
    };

    await services.delsertNomenclature(newNumDos, NOMENCLATURE);
    await services.upsertProduct(newNumDos, PRODUCT);
  } else if (FSAPRODUITS) {
    await services.upsertProduct(newNumDos, FSAPRODUITS);
    if (FSANOMENCLATURES) {
      await services.delsertNomenclature(newNumDos, FSANOMENCLATURES);
    }
  }

  if (FSACLIENT) {
    await services.upsertClient(newNumDos, FSACLIENT);
  }

  if (FSAVENTES) {
    await services.upsertVente(newNumDos, FSAVENTES);
  }

  return newNumDos;
}

export async function postValidation(req) {
  const { NUMDOS, VALTYPCOD, VALNOT } = v.validationCreateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const { CREUSR, NUMGES } = getUserIdentity(req);

  await services.postValidation(NUMDOS, VALTYPCOD, VALNOT, NUMGES, CREUSR);

  const gestsMustValidate = await services.getGestsMustValidateByNumDos(NUMDOS);
  const formattedGestsMustValidate =
    utils.formatGestsMustValidate(gestsMustValidate);

  const baseFsaData = await services.getFsa(NUMDOS);
  const formattedBaseFsa = utils.formatFsasJson(
    baseFsaData,
    formattedGestsMustValidate,
  );

  if (!formattedBaseFsa.length || !formattedBaseFsa[0])
    throw new Error("DATA_NOT_FOUND");

  const newFormattedFsa = formattedBaseFsa[0];

  const valid = newFormattedFsa.FSAVALIDS.find(
    (val) => val.GEST.NUMGES === NUMGES && val.VALTYP.VALTYPCOD === VALTYPCOD,
  );

  if (!valid) throw new Error("DATA_NOT_FOUND");

  // REFONTE BDD : services.getFsa() renvoie désormais { header, nomenclatures,
  // pjs, validations } (4 recordsets distincts) au lieu d'un tableau de
  // lignes brutes — cf. modules/fsa/services.js. Les champs ENT_GES_USRID /
  // ENT_DEM_USRID vivent dans la ligne d'en-tête.
  const ENT_GES_USRID = baseFsaData.header?.[0]?.ENT_GES_USRID;
  const ENT_DEM_USRID = baseFsaData.header?.[0]?.ENT_DEM_USRID;

  const gest = await usersmanagerService.getUserById(ENT_GES_USRID);
  const dem = await usersmanagerService.getUserById(ENT_DEM_USRID);

  const formattedGest = await usersmanagerUtils.formatUsers(gest);
  const formattedDem = await usersmanagerUtils.formatUsers(dem);

  const gestEmail = formattedGest[0]?.EMAIL;
  const demEmail = formattedDem[0]?.EMAIL;

  // Destinataires : uniquement les emails métier (gestionnaire + demandeur du
  // dossier) résolus depuis la base, jamais un champ fourni par le client.
  const recipientEmails = [...new Set([gestEmail, demEmail].filter(Boolean))];
  recipientEmails.push(BASE_RECIPIENT_EMAIL);

  const CODETA = newFormattedFsa.FSAENT.CURETADOS.CODETA;
  const template =
    CODETA === "REF"
      ? "fsa/validation-rejected"
      : CODETA === "VAL"
        ? "fsa/validation-approved"
        : "fsa/validation";

  const subject =
    CODETA === "REF"
      ? `Dossier FSA refusé`
      : CODETA === "VAL"
        ? `Dossier FSA validé`
        : `Validation d'un dossier FSA`;

  notifyFsaEvent({
    template,
    subject,
    message:
      CODETA === "REF"
        ? "Votre dossier FSA vient d'être refusé."
        : CODETA === "VAL"
          ? "Votre dossier FSA vient d'être validé."
          : "Une validation vient d'être effectuée sur votre dossier FSA.",
    recipient: recipientEmails.filter(Boolean).join(","),
    dossierCode: NUMDOS,
    nomdos: newFormattedFsa.FSAENT.NOMDOS,
    // Même regroupement que les variantes VAL/REF/PARTIAL de
    // getMailTemplateVariants() (cf. testFsaMailTemplates) — à tenir à jour
    // ensemble si l'un des deux change.
    detailGroups: [
      {
        title: "Valideur",
        items: [
          { label: "Service", value: valid.GEST.SERVGES },
          { label: "Utilisateur", value: valid.GEST.GESNAM },
        ],
      },
      {
        title: "Validation",
        items: [
          { label: "Validation", value: valid.VALTYP.VALTYPNOM },
          { label: "Pièces jointe", value: valid.PJS.length },
        ],
      },
    ],
    // Commentaire éventuel du valideur (VALNOT), attribué à l'utilisateur du
    // valideur résolu sur l'enregistrement de validation (valid.GEST.GESNAM)
    // plutôt qu'au CREUSR de la requête courante — même source que le champ
    // "Utilisateur" du groupe "Valideur" ci-dessus, pour rester cohérent
    // dans l'email si les deux venaient un jour à diverger.
    comment: VALNOT
      ? { author: valid.GEST.GESNAM, content: VALNOT }
      : undefined,
    actionUrl: `${DOMAIN}/fsa/folders/${NUMDOS}/0`,
  });

  return newFormattedFsa;
}

export async function postGestionnaire(req) {
  const { NUMGES, NOMGES, VALGES, CREGES, SERVGES, ENBUSRS } =
    v.gestionnaireCreateSchema.parse(
      (await requestUtils.getRequestParams(req)).params,
    );

  const { CREUSR } = getUserIdentity(req);

  return services.postGestionnaire(
    NUMGES,
    NOMGES,
    VALGES,
    CREGES,
    SERVGES,
    ENBUSRS,
    CREUSR,
  );
}

/* -------------------------------------------------------------------------- */
/*                                 PATCHS                                     */
/* -------------------------------------------------------------------------- */

/**
 * Mise à jour partielle des paramètres globaux de l'application FSA (table
 * singleton FSASETTINGS) — cf. getSettings() ci-dessus et SettingsPage.tsx.
 * L'auteur de la modification (MODUSR) est résolu depuis le JWT, jamais
 * fourni par le client, même convention que patchGestionnaire/postFsa.
 */
export async function patchSettings(req) {
  const { VALDELAY, ARCDELAY, DELDELAY, PURDELAY } =
    v.settingsPatchSchema.parse(
      (await requestUtils.getRequestParams(req)).params,
    );

  const { CREUSR } = getUserIdentity(req);

  const rawSettings = await services.patchSettings(
    VALDELAY,
    ARCDELAY,
    DELDELAY,
    PURDELAY,
    CREUSR,
  );

  const formattedSettings = utils.formatSettings(rawSettings);
  if (!formattedSettings) throw new Error("DATA_NOT_FOUND");

  return formattedSettings;
}

export async function patchFsa(req) {
  const {
    NUMDOS,
    ENT_NOMDOS,
    ENT_NOTDOS,
    FSACLIENT_STRINGIFY: FSACLIENT,
    FSAPRODUITS_STRINGIFY: FSAPRODUITS,
    FSAVENTES_STRINGIFY: FSAVENTES,
    EAV,
  } = v.fsaPatchSchema.parse((await requestUtils.getRequestParams(req)).params);

  const FSANOMENCLATURES = FSAPRODUITS?.NOMENCLATURES;

  await services.patchFsaEnt(NUMDOS, ENT_NOMDOS, ENT_NOTDOS, EAV);

  if (FSAPRODUITS) {
    await services.upsertProduct(NUMDOS, FSAPRODUITS);

    if (FSANOMENCLATURES) {
      await services.delsertNomenclature(NUMDOS, FSANOMENCLATURES);
    }
  }

  if (FSACLIENT) {
    await services.upsertClient(NUMDOS, FSACLIENT);
  }

  if (FSAVENTES) {
    await services.upsertVente(NUMDOS, FSAVENTES);
  }

  const gestsMustValidate = await services.getGestsMustValidate();
  const formattedGests = utils.formatGestsMustValidate(gestsMustValidate);

  if (EAV) {
    const newFsa = await services.getFsa(NUMDOS);
    const newFormattedFsas = utils.formatFsasJson(newFsa, formattedGests);

    const valEmails = await services.getValEmails(NUMDOS);

    if (!newFormattedFsas.length || !valEmails.length)
      throw new Error("DATA_NOT_FOUND");

    const newFormattedFsa = newFormattedFsas[0];

    // Correctif (cf. audit, en-tête du fichier) : `.map().push(...)` en
    // V1.0.0 renvoyait la longueur du tableau (un number), pas le tableau.
    // On construit ici explicitement le tableau de destinataires.
    const recipientEmails = valEmails.map((email) => email.EMAIL);
    recipientEmails.push(BASE_RECIPIENT_EMAIL);

    notifyFsaEvent({
      template: "fsa/creation",
      subject: `Nouveau dossier FSA`,
      message:
        "Un nouveau dossier FSA vient d'être créé et soumis à votre validation.",
      recipient: recipientEmails.filter(Boolean).join(","),
      dossierCode: NUMDOS,
      nomdos: newFormattedFsa.FSAENT.NOMDOS,
      notdos: newFormattedFsa.FSAENT.NOTDOS,
      // Même regroupement que la variante CREATION de
      // getMailTemplateVariants() (cf. testFsaMailTemplates) — à tenir à
      // jour ensemble si l'un des deux change.
      detailGroups: [
        {
          title: "Informations générales",
          items: [
            {
              label: "Type de dossier",
              value: newFormattedFsa.FSAENT.TYPE.TYDOSN,
            },
            {
              label: "Innovation",
              value: newFormattedFsa.FSAENT.INNO ? "Oui" : "Non",
            },
          ],
        },
        {
          title: "Demande",
          items: [
            {
              label: "Service demandeur",
              value: newFormattedFsa.FSAENT.GEST.SERVGES,
            },
            { label: "Demandeur", value: newFormattedFsa.FSAENT.GEST.GESNAM },
          ],
        },
      ],
      actionUrl: `${DOMAIN}/fsa/folders/${NUMDOS}/0`,
    });
  }

  const rawFsa = await services.getFsa(NUMDOS);
  const formattedFsas = utils.formatFsasJson(rawFsa, formattedGests);

  return formattedFsas[0];
}

export async function patchFsaNotes(req) {
  const { NUMDOS, NOTDOS } = v.fsaNotesPatchSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  await services.upsertFsaNotes(NUMDOS, NOTDOS);
  return true;
}

export async function patchGestionnaires(req) {
  const { GESTS } = v.gestionnairesPatchSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const { CREUSR } = getUserIdentity(req);

  for (const gest of GESTS) {
    await services.patchGestionnaire(
      gest.NUMGES,
      gest.VALGES,
      gest.CREGES,
      gest.ENBUSRS,
      CREUSR,
    );
  }

  return true;
}

export async function patchGestionnaire(req) {
  const { NUMGES, VALGES, CREGES, ENBUSRS } = v.gestionnairePatchSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const { CREUSR } = getUserIdentity(req);

  await services.patchGestionnaire(NUMGES, VALGES, CREGES, ENBUSRS, CREUSR);
  return true;
}

/* -------------------------------------------------------------------------- */
/*                                 DELETES                                    */
/* -------------------------------------------------------------------------- */

export async function deleteFsa(req) {
  const { NUMDOS, DELETED } = v.fsaDeleteSchema.parse(
    (
      await requestUtils.getRequestParams(req, {
        NUMDOS: "string",
        DELETED: "boolean",
      })
    ).params,
  );

  await services.deleteFsa(NUMDOS, DELETED);
  return true;
}

export async function deleteValidation(req) {
  const { NUMDOS } = v.validationDeleteSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const { CREUSR, NUMGES } = getUserIdentity(req);

  await services.postValidation(NUMDOS, "DEL", "", NUMGES, CREUSR);
  return true;
}

export async function deleteGestionnaire(req) {
  const { NUMGES } = v.gestionnaireDeleteSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  await services.deleteGestionnaire(NUMGES);
  return true;
}
