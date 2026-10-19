import * as services from "./services.js";
import * as utils from "./utils.js";
import * as requestUtils from "../../core/utils/request.utils.js";
import * as passwordUtils from "../../core/utils/passwords.utils.js";
import * as v from "./validators.js";
import {
  sendTemplatedMail,
  renderDetailGroups,
  renderNoticeList,
  renderFolderList,
} from "../../core/services/mail.service.js";
import { logger } from "../../config/logger.config.js";

/* ─────────────────────────────────────────────
   DECLCAV — Controllers
   Responsabilité : valider les paramètres (zod), appeler le service,
   formater la réponse, notifier par mail.

   Emails (cf. audit) : V1.0.0 appelait un service `emailService.send({
   appCode: "DCLING", type, data })` qui n'existe plus (modules/emails a été
   retiré du périmètre V1.1.0, cf. README). Les templates GÉNÉRIQUES
   utilisés jusqu'ici (core/services/mail-templates/*.html) ont été
   remplacés par des templates DÉDIÉS Declcav
   (core/services/mail-templates/declcav/), même démarche que la migration
   déjà faite pour Ticketing (cf. mail-templates/ticketing/) puis FSA (cf.
   mail-templates/fsa/) :
     - setDeclaration              → "declcav/creation"             (nouvelle déclaration)
     - relaunchDecl                → "declcav/reminder"             (relance déclaration(s), groupée par cave)
     - relaunchQuest                → "declcav/reminder"             (relance questionnaire(s), groupée par cave)
     - setRectification            → "declcav/modification"         (rectification ingrédients/cépages)
     - setMrvIngredients (alerte)  → "declcav/alert"                (ingrédient(s) à surveiller, AVISUV1 = 3)
     - upsertResponses (soumission) → "declcav/notification"         (questionnaire soumis)
     - upsertResponses (VALID)     → "declcav/validation-approved"  (questionnaire validé)
     - upsertResponses (INVALID)   → "declcav/validation-rejected"  (questionnaire refusé)
     - setCavePassword             → "declcav/password-reset"       (mot de passe cave régénéré)
   Champs Declcav spécifiques passés à ces templates (cf.
   mail-templates/declcav/*.html, et notifyDeclcavEvent() ci-dessous) :
   DOSSIER_CODE (badge, NUMDOS/REFEXT), DESDOS (désignation du dossier,
   folder.ent.DESA2), DOSSIERS_HTML/DOSSIER_COUNT (relance groupée sur
   plusieurs dossiers, via renderFolderList() — mêmes conventions que FSA).
   Contrairement à FSA, aucun commentaire/note libre n'est disponible sur un
   dossier declcav à ce jour (pas d'équivalent de VALNOT) : NOTES_HTML n'est
   donc pas utilisé ici.
   L'envoi est toujours best-effort (jamais bloquant pour l'opération métier),
   même pattern que notifyFsaEvent()/notifyTicketEvent().

   Destinataires : en développement (NODE_ENV !== "production"), tous les
   mails partent vers BASE_RECIPIENT_EMAIL au lieu des vraies adresses
   métier (mêmes garde-fous que ticketing/fsa) — évite d'envoyer de faux
   mails à des caves réelles depuis un environnement de dev/staging.

   Adresse d'expédition : "declcav@union-vignerons.com", même convention
   que "fsa@union-vignerons.com"/"ticketing@union-vignerons.com".

   Correctifs de sécurité/dette appliqués par rapport à V1.0.0 (cf. audit) :
   - Plus aucun `console.log` (les mots de passe cave en clair, les listes
     de destinataires et IS_PROD/MAILS transitaient auparavant en clair
     dans les logs applicatifs).
   - CREUSR/MLOPER ne sont plus codés en dur ("BAYET Paul" /
     "p.bayet@union-vignerons.com") dans setRectification/setMrvIngredients
     : c'est désormais l'identité réelle de l'utilisateur connecté
     (req.payload.data) qui est tracée, comme le faisait déjà setDeclaration.
   - `delsertMails` reçoit maintenant CREUSR (en V1.0.0 le contrôleur
     n'appelait jamais la fonction avec ce 3ème paramètre malgré sa
     signature — CREUSR valait `undefined`, silencieusement stocké NULL).
   - Bug corrigé : `badIngres.length >= 0` (toujours vrai, y compris à 0)
     déclenchait l'alerte mail "ingrédient à surveiller" à CHAQUE
     déclaration, avec ou sans ingrédient concerné. Corrigé en `> 0`.
   - Les destinataires des notifications liées à une cave viennent
     désormais uniquement de `folder.cave.MAILS` (base de données), plus
     jamais d'un champ `MAILS` fourni par le client dans le corps de la
     requête — un utilisateur authentifié ne doit pas pouvoir dicter qui
     reçoit les notifications d'une cave.
───────────────────────────────────────────── */

const IS_PROD = process.env.NODE_ENV === "production";
const DOMAIN = process.env.DOMAIN;
const DEV_FALLBACK_RECIPIENT = process.env.BASE_RECIPIENT_EMAIL;

function getUserIdentity(req) {
  return {
    CREUSR:
      `${req?.payload?.data?.LastName ?? ""} ${req?.payload?.data?.FirstName ?? ""}`.trim(),
    MLOPER: req?.payload?.data?.email ?? "",
  };
}

/** Emails actifs d'une cave (folder.cave.MAILS), joints en une chaîne. */
function activeCaveMails(folder) {
  return (folder?.cave?.MAILS ?? [])
    .filter((m) => m.ACTIF)
    .map((m) => m.MAIL)
    .filter(Boolean)
    .join(",");
}

/**
 * Envoi best-effort d'une notification declcav. N'importe quelle erreur
 * (SMTP non configuré, template introuvable, destinataire manquant en dev...)
 * est loguée mais jamais propagée : un souci d'email ne doit jamais faire
 * échouer une opération métier declcav.
 */
export async function notifyDeclcavEvent({
  template,
  subject,
  message,
  recipient,
  dossierCode,
  desdos,
  detailGroups = [],
  notices = [],
  dossiers = [],
  actionUrl = null,
  actionLabel = "Voir la déclaration",
}) {
  // const to = IS_PROD ? recipient : DEV_FALLBACK_RECIPIENT;
  const to = DEV_FALLBACK_RECIPIENT;

  if (!to) {
    logger.warn(
      `[DECLCAV][MAIL] Aucun destinataire résolu pour "${template}" (${subject}) — envoi ignoré.`,
    );
    return;
  }

  try {
    await sendTemplatedMail({
      from: "declaration-ingredients@union-vignerons.com",
      template,
      to,
      subject,
      data: {
        APP_NAME: "Déclaration d'ingredients UVCDR",
        TITLE: subject,
        MESSAGE: message,
        DOSSIER_CODE: dossierCode ?? undefined,
        DESDOS: desdos ?? undefined,
        DETAILS_ROWS_HTML: detailGroups.length
          ? renderDetailGroups(detailGroups)
          : undefined,
        NOTICES_HTML: notices.length ? renderNoticeList(notices) : undefined,
        // Relance groupée (relaunchDecl/relaunchQuest) : plusieurs dossiers
        // pour un même destinataire, affichés en liste plutôt qu'en un
        // unique badge DOSSIER_CODE (cf. declcav/reminder.html, même
        // principe que fsa/reminder.html).
        DOSSIERS_HTML: dossiers.length ? renderFolderList(dossiers) : undefined,
        DOSSIER_COUNT: dossiers.length || undefined,
        ACTION_URL: actionUrl ?? undefined,
        ACTION_LABEL: actionLabel,
      },
    });
  } catch (err) {
    logger.error(
      `[DECLCAV][MAIL] Échec envoi "${template}" (${subject}) : ${err.message}`,
    );
  }
}

/**
 * Dossier fictif utilisé uniquement par testDeclcavMailTemplates() (route
 * de test manuelle, cf. GET /mail-templates/test) pour peupler les
 * placeholders des templates declcav/*.html sans dépendre d'un dossier réel
 * en base. Même principe que SAMPLE_TEST_FSA dans modules/fsa/
 * controllers.js / SAMPLE_TEST_TICKET dans modules/ticketing/controllers.js,
 * mais avec la VRAIE forme d'un dossier declcav telle que renvoyée par
 * utils.formatFolders() (folder.ent.* / folder.cave.* / folder.ingres[])
 * plutôt qu'un objet plat : ce test doit lire les données exactement comme
 * setDeclaration()/setRectification()/upsertResponses() le font sur un vrai
 * dossier, pour prévenir tout écart de champ qui passerait inaperçu avec
 * des raccourcis.
 */
const SAMPLE_TEST_DECLCAV = {
  ent: {
    ENTID: 1,
    NUMDOS: "DCV-260921-00001",
    VRSDEC: 1,
    MAXVRSDEC: 1,
    TYPCOD: "STD",
    TYPNAM: "Déclaration standard",
    STAT: "EAV",
    STATNAM: "En attente de validation",
    ISREL: 0,
    REFMAR: "MRV-000123",
    REFINTR: "REF-000123",
    DATMRC: "2026-09-21T08:00:00.000+02:00",
    DEBMRV: "2026-09-01T00:00:00.000+02:00",
    FINMRV: "2026-09-30T00:00:00.000+02:00",
    REM_ENT: "",
    CODFOUR: "F000123",
    NOMFOUR: "Cave Test SARL",
    REFVRAC: "VRAC-001",
    DESA1: "Chardonnay 2024",
    DESA2: "Chardonnay IGP 2024 — cuve test",
    APPL: "IGP",
    COUL: "Blanc",
    QTEMRV: 150,
    TYPO: "Tranquille",
    SPECTYPO: "",
    QAL: 1,
    VALID: 0,
    MLOPER: "p.bayet@union-vignerons.com",
    DERREL: null,
    CANREL: true,
    DERRELQST: null,
    CANRELQST: true,
    VALDAT: null,
    VALDDATE: null,
    DECLQST: true,
    DECLQSTSTA: "DRAFT",
    DATQST: null,
    VALDATQST: null,
    ENT_CREDAT: "2026-09-21T08:00:00.000+02:00",
    ENT_CREUSR: "Jean Dupont",
    ENT_UPDDAT: "2026-09-21T08:00:00.000+02:00",
    ENT_UPDUSR: "Jean Dupont",
    IS_DEL: false,
    PJS: [],
  },

  cave: {
    CAVEID: 1,
    SIRET: "12345678900012",
    CAVENOM: "Cave Test SARL",
    ACCIID: "ACC001",
    CODACCI: "ACC001",
    CDFRX3: "C000123",
    CAVE_NB_DOS: 3,
    TYPE: {
      CODE: "COOP",
      LIBEL: "Cave coopérative",
    },
    MAILS: [
      { MAILID: 1, MAIL: "cave-test@example.com", PRIMAIL: true, ACTIF: true },
    ],
    LSTDATQST: "2026-09-21T08:00:00.000+02:00",
  },

  ingres: [
    {
      TYP: "ING",
      CODE: "SO2",
      LIBEL: "Anhydride sulfureux",
      CATID: 1,
      CATEGORY: "Conservateur",
      POURC: 0,
      AVISUV1: 3,
      AVISUV2: "",
      ACTIF: true,
      REMARK: "À surveiller — dépassement de seuil habituel.",
      IS_CEP: false,
    },
  ],
};

/**
 * Dossiers fictifs utilisés uniquement par les variantes REMINDER (relance
 * groupée sur plusieurs dossiers, cf. declcav/reminder.html /
 * DOSSIERS_HTML) — un événement qui porte sur PLUSIEURS NUMDOS et non sur
 * le dossier complet ci-dessus, d'où une structure séparée, plus légère
 * (mêmes codes que relaunchDecl()/relaunchQuest() : simples NUMDOS
 * regroupés par destinataire, cf. utils.formatRelaunchData()/
 * formatQuestRelaunchData()).
 */
const SAMPLE_TEST_DOSSIERS = ["DCV-260921-00001", "DCV-260921-00002"];

/**
 * Une entrée par événement mail declcav (les templates
 * declcav/reminder.html étant partagés par relaunchDecl() et
 * relaunchQuest(), deux variantes REMINDER distinctes sont fournies) : les
 * mêmes subject/message et la MÊME LECTURE DES CHAMPS (declcav.ent.*,
 * declcav.cave.*) que les fonctions setDeclaration()/setRectification()/
 * setMrvIngredients()/upsertResponses()/setCavePassword()/relaunchDecl()/
 * relaunchQuest() correspondantes (cf. commentaire d'en-tête de ce
 * fichier), pour que cette route de test prévisualise exactement ce qu'un
 * vrai dossier enverrait.
 */
function getMailTemplateVariants(declcav) {
  const { NUMDOS, DESA2, REFMAR, TYPNAM, QTEMRV } = declcav.ent;
  const { CAVENOM } = declcav.cave;
  const [badIngredient] = declcav.ingres;

  const detailsCreation = renderDetailGroups([
    {
      title: "Dossier",
      items: [
        { label: "Type de dossier", value: TYPNAM },
        { label: "Marché", value: REFMAR },
      ],
    },
    {
      title: "Cave",
      items: [
        { label: "Cave", value: CAVENOM },
        { label: "Volume MRV (HL)", value: QTEMRV },
      ],
    },
  ]);

  const detailsModification = renderDetailGroups([
    {
      title: "Dossier",
      items: [
        { label: "Marché", value: REFMAR },
        { label: "Volume MRV (HL)", value: QTEMRV },
      ],
    },
    {
      title: "Rectification",
      items: [{ label: "Rectifié par", value: "Jean Dupont" }],
    },
  ]);

  const detailsAlert = renderDetailGroups([
    {
      title: "Dossier",
      items: [
        { label: "Désignation", value: DESA2 },
        { label: "Cave", value: CAVENOM },
      ],
    },
    {
      title: "Ingrédients",
      items: [
        { label: "Ingrédients concernés", value: badIngredient.CODE },
        { label: "Nombre", value: 1 },
      ],
    },
  ]);

  const detailsValidation = renderDetailGroups([
    {
      title: "Dossier",
      items: [
        { label: "Désignation", value: DESA2 },
        { label: "Cave", value: CAVENOM },
      ],
    },
  ]);

  const detailsPasswordReset = renderDetailGroups([
    {
      title: "Cave",
      items: [
        { label: "Identifiant cave", value: declcav.cave.CAVEID },
        { label: "Nouveau mot de passe", value: "Xk8pQ2mZ" },
      ],
    },
  ]);

  const dossiersHtml = renderFolderList(
    SAMPLE_TEST_DOSSIERS.map((numdos) => ({
      code: numdos,
      url: `${DOMAIN}/folders/${numdos}`,
    })),
  );

  const relaunchNotice = [
    {
      type: "warning",
      message:
        "Aucune retiraison ne sera possible tant que ces dossiers n'auront pas été validés dans leur intégralité : la sélection des ingrédients, ainsi que le questionnaire de traçabilité (le cas échéant), doivent d'abord être complétés et validés.",
    },
  ];

  return [
    {
      key: "CREATION",
      template: "declcav/creation",
      subject: `Nouvelle déclaration ${NUMDOS}`,
      message: "Une nouvelle déclaration de cave vient d'être créée.",
      data: {
        DOSSIER_CODE: NUMDOS,
        DESDOS: DESA2,
        DETAILS_ROWS_HTML: detailsCreation,
        NOTICES_HTML: renderNoticeList([
          {
            type: "warning",
            message:
              "Aucune retiraison ne sera possible tant que ce dossier n'aura pas été validé dans son intégralité : la sélection des ingrédients, ainsi que le questionnaire de traçabilité (le cas échéant), doivent d'abord être complétés et validés.",
          },
        ]),
      },
    },
    {
      key: "REMINDER_DECL",
      template: "declcav/reminder",
      subject: "Relance déclaration(s) de cave",
      message:
        "Une ou plusieurs déclarations de cave sont en attente de finalisation.",
      data: {
        DOSSIERS_HTML: dossiersHtml,
        DOSSIER_COUNT: SAMPLE_TEST_DOSSIERS.length,
        NOTICES_HTML: renderNoticeList(relaunchNotice),
      },
    },
    {
      key: "REMINDER_QUEST",
      template: "declcav/reminder",
      subject: "Relance questionnaire(s) de traçabilité",
      message:
        "Un ou plusieurs questionnaires de traçabilité sont en attente de soumission ou de correction.",
      data: {
        DOSSIERS_HTML: dossiersHtml,
        DOSSIER_COUNT: SAMPLE_TEST_DOSSIERS.length,
      },
    },
    {
      key: "MODIFICATION",
      template: "declcav/modification",
      subject: `Déclaration ${NUMDOS} rectifiée`,
      message: "Une déclaration de cave a été rectifiée.",
      data: {
        DOSSIER_CODE: NUMDOS,
        DESDOS: DESA2,
        DETAILS_ROWS_HTML: detailsModification,
      },
    },
    {
      key: "ALERT",
      template: "declcav/alert",
      subject: `Ingrédient(s) à surveiller — ${NUMDOS}`,
      message:
        "Un ou plusieurs ingrédients déclarés nécessitent une vérification.",
      data: {
        DOSSIER_CODE: NUMDOS,
        DESDOS: DESA2,
        DETAILS_ROWS_HTML: detailsAlert,
      },
    },
    {
      key: "NOTIFICATION",
      template: "declcav/notification",
      subject: `Questionnaire soumis — ${NUMDOS}`,
      message: "Un questionnaire de déclaration vient d'être soumis.",
      data: {
        DOSSIER_CODE: NUMDOS,
      },
    },
    {
      key: "VALIDATION_APPROVED",
      template: "declcav/validation-approved",
      subject: `Questionnaire validé — ${NUMDOS}`,
      message: "Le questionnaire de déclaration a été validé.",
      data: {
        DOSSIER_CODE: NUMDOS,
        DESDOS: DESA2,
        DETAILS_ROWS_HTML: detailsValidation,
      },
    },
    {
      key: "VALIDATION_REJECTED",
      template: "declcav/validation-rejected",
      subject: `Questionnaire refusé — ${NUMDOS}`,
      message: "Le questionnaire de déclaration a été refusé.",
      data: {
        DOSSIER_CODE: NUMDOS,
        DESDOS: DESA2,
        DETAILS_ROWS_HTML: detailsValidation,
      },
    },
    {
      key: "PASSWORD_RESET",
      template: "declcav/password-reset",
      subject: "Mot de passe cave réinitialisé",
      message: "Un nouveau mot de passe a été généré pour votre espace cave.",
      data: {
        DETAILS_ROWS_HTML: detailsPasswordReset,
      },
    },
  ];
}

/**
 * Route de test manuelle (dev/staging uniquement, cf. IS_PROD dans
 * routes.js) : envoie un exemplaire de CHAQUE variante d'email declcav (9
 * variantes, 8 templates — declcav/reminder étant partagé par
 * REMINDER_DECL/REMINDER_QUEST) à BASE_RECIPIENT_EMAIL, pour vérifier
 * visuellement leur rendu dans une vraie boîte mail après une modification
 * des templates — sans avoir à faire transiter un vrai dossier par tout le
 * cycle de déclaration/validation. Même principe que
 * testFsaMailTemplates()/testTicketMailTemplates().
 *
 * `?template=<nom>` (ex: "creation", "alert") restreint l'envoi aux seules
 * variantes dont le template correspond ; sans paramètre, toutes les
 * variantes sont envoyées.
 *
 * Toujours envoyé à BASE_RECIPIENT_EMAIL, jamais à un utilisateur réel :
 * indépendant de la logique de destinataires (recipient réel/dev) de
 * notifyDeclcavEvent() — ce n'est pas un test métier, juste un aperçu de
 * gabarits.
 *
 * Best-effort par variante : une erreur sur un template (ex: fichier
 * introuvable après une modification en cours) ne doit pas empêcher
 * l'envoi des autres — chaque résultat est rapporté individuellement dans
 * la réponse plutôt que de faire échouer toute la requête.
 */
export async function testDeclcavMailTemplates(req) {
  if (!DEV_FALLBACK_RECIPIENT) {
    const err = new Error(
      "BASE_RECIPIENT_EMAIL n'est pas configuré (variable d'environnement requise pour ce test).",
    );
    err.status = 400;
    throw err;
  }

  const { template } = (await requestUtils.getRequestParams(req)).params;

  const declcav = SAMPLE_TEST_DECLCAV;
  const APP_NAME = "Declcav UVCDR";
  const APP_MAIL = "declcav@union-vignerons.com";

  const results = [];

  for (const variant of getMailTemplateVariants(declcav)) {
    if (
      (template !== undefined && variant.template.includes(`/${template}`)) ||
      template === undefined
    ) {
      const subject = `[TEST] ${variant.subject}`;

      const data = {
        APP_NAME,
        TITLE: subject,
        MESSAGE: variant.message,
        ACTION_URL: `${DOMAIN}/folders/${declcav.ent.NUMDOS}`,
        ACTION_LABEL: variant.key.startsWith("REMINDER")
          ? "Voir mes dossiers"
          : "Voir le dossier",
        ...variant.data,
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
          `[DECLCAV][MAIL][TEST] Échec envoi "${variant.template}" : ${err.message}`,
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

/* -------------------------------------------------------------------------- */
/*                                    GETS                                    */
/* -------------------------------------------------------------------------- */

export async function getFolders(req) {
  const { CAVID, NUMDOS, TYPE } = v.foldersQuerySchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const rawFolders = await services.getFolders(
    CAVID ?? null,
    NUMDOS ?? null,
    TYPE,
  );

  return utils.formatFolders(rawFolders);
}

export async function getFolderByMrv(req) {
  const { MRVCOD, DEL } = v.folderByMrvSchema.parse(
    (
      await requestUtils.getRequestParams(req, {
        DEL: "boolean",
      })
    ).params,
  );

  console.log("DELLLLLLLLLLLLLLLLLLLLLLLLLL", DEL);

  const rawFolders = await services.getFolderByMrv(MRVCOD, DEL);
  const formattedFolders = utils.formatFolders(rawFolders);

  return formattedFolders[0] ?? null;
}

export async function getIngredients() {
  const rawIngredients = await services.getIngredients();
  return utils.formatIngredients(rawIngredients);
}

export async function getTypesCaves() {
  return services.getTypesCaves();
}

export async function getCaves(req) {
  const { ASCCI, NUMFOURN } = v.cavesQuerySchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const rawCaves = await services.getCaves(ASCCI ?? null, NUMFOURN ?? null);
  return utils.formatCaves(rawCaves);
}

export async function getResponses(req) {
  const { REFEXT } = v.responsesQuerySchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const rawResponses = await services.getResponses(REFEXT ?? null);
  const formattedResponses = utils.formatResponses(rawResponses);

  return formattedResponses[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/*                                    POST                                    */
/* -------------------------------------------------------------------------- */

export async function setDeclaration(req) {
  const body = v.declarationCreateSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );
  const { CREUSR, MLOPER } = getUserIdentity(req);

  const folderNumDos = await services.setDeclaration({
    ...body,
    CREUSR,
    MLOPER,
  });

  if (!folderNumDos) throw new Error("DB_QUERY_ERROR");

  const rawFolders = await services.getFolders(body.CAVEID, folderNumDos);
  const formattedFolders = utils.formatFolders(rawFolders);
  const folder = formattedFolders[0];

  notifyDeclcavEvent({
    template: "declcav/creation",
    subject: `Nouvelle déclaration`,
    message: "Une nouvelle déclaration de cave vient d'être créée.",
    recipient: activeCaveMails(folder),
    dossierCode: folder.ent.NUMDOS,
    desdos: folder.ent.DESA2,
    // Même regroupement que la variante CREATION de
    // getMailTemplateVariants() (cf. testDeclcavMailTemplates) — à tenir à
    // jour ensemble si l'un des deux change.
    detailGroups: [
      {
        title: "Marché",
        items: [
          { label: "Désignation", value: body.DESA2 },
          { label: "Couleur", value: body.COUL },
          { label: "Numéro de marché", value: body.REFMAR },
          { label: "Volume MRV (HL)", value: body.QTEMRV },
        ],
      },
    ],
    notices: [
      {
        type: "warning",
        message:
          "Aucune retiraison ne sera possible tant que ce dossier n'aura pas été validé dans son intégralité : la sélection des ingrédients, ainsi que le questionnaire de traçabilité (le cas échéant), doivent d'abord être complétés et validés.",
      },
    ],
    actionUrl: `${DOMAIN}/folders/${folder.ent.NUMDOS}`,
  });

  return folder;
}

export async function relaunchDecl(req) {
  const { NUMDOS } = v.relaunchQuerySchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const data = await services.getRelaunchData(NUMDOS ?? null);
  const formattedData = utils.formatRelaunchData(data);

  for (const d of formattedData) {
    const numdosList = [...new Set((d.NUMDOSS ?? []).filter(Boolean))];
    const isPlural = numdosList.length > 1;

    await notifyDeclcavEvent({
      template: "declcav/reminder",
      subject: "Relance déclaration(s) de cave",
      message:
        "Une ou plusieurs déclarations de cave sont en attente de finalisation.",
      recipient: (d.MAILS ?? []).join(","),
      dossiers: numdosList.map((numdos) => ({
        code: numdos,
        url: `${DOMAIN}/folders/${numdos}`,
      })),
      notices: [
        {
          type: "warning",
          message: isPlural
            ? "Aucune retiraison ne sera possible tant que ces dossiers n'auront pas été validés dans leur intégralité : la sélection des ingrédients, ainsi que le questionnaire de traçabilité (le cas échéant), doivent d'abord être complétés et validés."
            : "Aucune retiraison ne sera possible tant que ce dossier n'aura pas été validé dans son intégralité : la sélection des ingrédients, ainsi que le questionnaire de traçabilité (le cas échéant), doivent d'abord être complétés et validés.",
        },
      ],
      actionUrl: `${DOMAIN}/`,
      actionLabel: "Voir mes déclarations",
    });

    for (const n of numdosList) {
      await services.setRelaunch(n);
    }
  }

  return true;
}

/**
 * Relance des questionnaires de traçabilité en attente (service Qualité) :
 * pendant de relaunchDecl (service Œnologie) ci-dessus, mais scopé sur
 * DECLQST/DECLQSTSTA au lieu de CANREL/TYPCOD, et sur DECENT.DERRELQST au
 * lieu de DERREL pour tracer la dernière relance (cf.
 * services.getQuestRelaunchData / setRelaunchQuest).
 */
export async function relaunchQuest(req) {
  const { NUMDOS } = v.relaunchQuerySchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const data = await services.getQuestRelaunchData(NUMDOS ?? null);
  const formattedData = utils.formatQuestRelaunchData(data);

  for (const d of formattedData) {
    const numdosList = [...new Set((d.NUMDOSS ?? []).filter(Boolean))];

    await notifyDeclcavEvent({
      template: "declcav/reminder",
      subject: "Relance questionnaire(s) de traçabilité",
      message:
        "Un ou plusieurs questionnaires de traçabilité sont en attente de soumission ou de correction.",
      recipient: (d.MAILS ?? []).join(","),
      dossiers: numdosList.map((numdos) => ({
        code: numdos,
        url: `${DOMAIN}/folders/${numdos}`,
      })),
      actionUrl: `${DOMAIN}/`,
      actionLabel: "Voir mes questionnaires",
    });

    for (const n of numdosList) {
      await services.setRelaunchQuest(n);
    }
  }

  return true;
}

export async function setRectification(req) {
  const { NUMDOS, INGRES, CEPAGES, DONE } = v.rectificationSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  if (DONE) {
    const { CREUSR, MLOPER } = getUserIdentity(req);

    const rawFolders = await services.setRectification({
      NUMDOS,
      INGRES,
      CEPAGES,
      CREUSR,
      MLOPER,
    });

    const formattedFolders = utils.formatFolders(rawFolders);
    const folder = formattedFolders[0];

    notifyDeclcavEvent({
      template: "declcav/modification",
      subject: `Déclaration rectifiée`,
      message: "Une déclaration de cave a été rectifiée.",
      recipient: activeCaveMails(folder),
      dossierCode: folder.ent.NUMDOS,
      desdos: folder.ent.DESA2,
      // Même regroupement que la variante MODIFICATION de
      // getMailTemplateVariants() (cf. testDeclcavMailTemplates) — à tenir
      // à jour ensemble si l'un des deux change.
      detailGroups: [
        {
          title: "Marché",
          items: [
            { label: "Désignation", value: folder.ent.DESA2 },
            { label: "Couleur", value: folder.ent.COUL },
            { label: "Numéro de marché", value: folder.ent.REFMAR },
            { label: "Volume MRV (HL)", value: folder.ent.QTEMRV },
          ],
        },
      ],
      actionUrl: `${DOMAIN}/folders/${folder.ent.NUMDOS}`,
    });

    return folder;
  }
}

export async function setMrvIngredients(req) {
  const { NUMDOS, INGRES, CEPAGES, ISRECT, VALDDATE, DONE } =
    v.mrvIngredientsSchema.parse(
      (await requestUtils.getRequestParams(req)).params,
    );

  const { CREUSR } = getUserIdentity(req);

  if (!ISRECT) {
    await services.setMrvIngredients({
      NUMDOS,
      INGRES,
      CEPAGES,
      CREUSR,
      VALDDATE: VALDDATE?.trim() || null,
    });
  }

  if (DONE) await services.validDeclaration(NUMDOS);

  const rawFolders = await services.getFolders(null, NUMDOS);
  const formattedFolders = utils.formatFolders(rawFolders);
  const folder = formattedFolders[0];

  // Correctif : `badIngres.length >= 0` était toujours vrai (y compris à 0),
  // ce qui déclenchait l'alerte "ingrédient à surveiller" à chaque appel.
  const badIngres = (INGRES ?? []).filter((i) => Number(i.AVISUV1) === 3);

  if (DONE && badIngres.length > 0) {
    await notifyDeclcavEvent({
      template: "declcav/alert",
      subject: `Ingrédient(s) à surveiller`,
      message:
        "Un ou plusieurs ingrédients déclarés nécessitent une vérification.",
      recipient: DEV_FALLBACK_RECIPIENT,
      dossierCode: NUMDOS,
      desdos: folder?.ent?.DESA2,
      // Même regroupement que la variante ALERT de
      // getMailTemplateVariants() (cf. testDeclcavMailTemplates) — à tenir
      // à jour ensemble si l'un des deux change.
      detailGroups: [
        {
          title: "Dossier",
          items: [
            { label: "Désignation", value: folder?.ent?.DESA2 },
            { label: "Cave", value: folder?.cave?.CAVENOM },
          ],
        },
        {
          title: "Ingrédients",
          items: [
            {
              label: "Ingrédients concernés",
              value: badIngres.map((i) => i.CODE).join(", "),
            },
            { label: "Nombre", value: badIngres.length },
          ],
        },
      ],
      actionUrl: `${ADMIN_DOMAIN}/folders/${NUMDOS}`,
      actionLabel: "Voir le dossier",
    });
  }

  return folder ?? null;
}

export async function upsertCave(req) {
  const { CAVEID, CAVENOM, TYPID, CDFRX3, SIRET, CODACCI, MAILS } =
    v.caveUpsertSchema.parse((await requestUtils.getRequestParams(req)).params);
  const { CREUSR } = getUserIdentity(req);

  const pwd = await passwordUtils.generatePassword({ length: 8 });
  const hash = await passwordUtils.hashPassword(pwd);

  const caveId = await services.upsertCave({
    CAVEID,
    CAVENOM,
    TYPID,
    CDFRX3,
    SIRET,
    CODACCI,
    CREUSR,
    PASSHSH: hash,
  });

  await services.delsertMails(caveId, MAILS, CREUSR);

  const cavesData = await services.getCave(caveId);
  const formattedCaves = utils.formatCaves(cavesData);

  return formattedCaves?.[0];
}

export async function upsertResponses(req) {
  const { DONE, VALID, INVALID, SUBID, REFEXT, STATUS, RESPONSES } =
    v.responsesUpsertSchema.parse(
      (await requestUtils.getRequestParams(req)).params,
    );

  const newSubId = await services.upsertResponsesSubmit({
    SUBID,
    REFEXT,
    STATUS: INVALID ? "INVALID" : STATUS,
  });

  await services.delsertResponses(newSubId, RESPONSES);

  if (STATUS === "SUBMITTED" && DONE) {
    await notifyDeclcavEvent({
      template: "declcav/notification",
      subject: `Questionnaire soumis`,
      message: "Un questionnaire de déclaration vient d'être soumis.",
      recipient: DEV_FALLBACK_RECIPIENT,
      dossierCode: REFEXT,
      actionUrl: `${ADMIN_DOMAIN}/folders/${REFEXT}/custom:wod:bfrcertif`,
      actionLabel: "Voir le questionnaire",
    });
  }

  if (VALID || INVALID) {
    const rawFolders = await services.getFolders(null, REFEXT);
    const formattedFolders = utils.formatFolders(rawFolders);
    const folder = formattedFolders[0];
    const recipient = activeCaveMails(folder);

    // Même regroupement que les variantes VALIDATION_APPROVED/
    // VALIDATION_REJECTED de getMailTemplateVariants() (cf.
    // testDeclcavMailTemplates) — à tenir à jour ensemble si l'un des deux
    // change.
    const detailGroups = [
      {
        title: "Dossier",
        items: [
          { label: "Désignation", value: folder?.ent?.DESA2 },
          { label: "Cave", value: folder?.cave?.CAVENOM },
        ],
      },
    ];

    if (VALID && !INVALID) {
      await notifyDeclcavEvent({
        template: "declcav/validation-approved",
        subject: `Questionnaire validé`,
        message: "Le questionnaire de déclaration a été validé.",
        recipient,
        dossierCode: REFEXT,
        desdos: folder?.ent?.DESA2,
        detailGroups,
        actionUrl: `${DOMAIN}/folders/${REFEXT}/custom:wod:bfrcertif`,
        actionLabel: "Voir le questionnaire",
      });
    }

    if (INVALID) {
      await notifyDeclcavEvent({
        template: "declcav/validation-rejected",
        subject: `Questionnaire refusé`,
        message: "Le questionnaire de déclaration a été refusé.",
        recipient,
        dossierCode: REFEXT,
        desdos: folder?.ent?.DESA2,
        detailGroups,
        actionUrl: `${DOMAIN}/folders/${REFEXT}/custom:wod:bfrcertif`,
        actionLabel: "Voir le questionnaire",
      });
    }
  }

  const rawResponses = await services.getResponses(REFEXT);
  const formattedResponses = utils.formatResponses(rawResponses);

  return formattedResponses[0] ?? null;
}

export async function setCavePassword(req) {
  const { CAVEID } = v.cavePasswordSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const pwd = await passwordUtils.generatePassword({ length: 8 });
  const hash = await passwordUtils.hashPassword(pwd);

  const email = await services.setCavePassword(CAVEID, hash);

  await notifyDeclcavEvent({
    template: "declcav/password-reset",
    subject: "Mot de passe cave réinitialisé",
    message: "Un nouveau mot de passe a été généré pour votre espace cave.",
    recipient: email,
    // Même regroupement que la variante PASSWORD_RESET de
    // getMailTemplateVariants() (cf. testDeclcavMailTemplates) — à tenir à
    // jour ensemble si l'un des deux change.
    detailGroups: [
      {
        title: "Cave",
        items: [
          { label: "Identifiant cave", value: email },
          { label: "Nouveau mot de passe", value: pwd },
        ],
      },
    ],
  });

  // NB (sécurité) : le mot de passe en clair reste retourné ici pour ne pas
  // changer le contrat d'API existant (comportement V1.0.0), mais il n'est
  // plus jamais journalisé (console.log supprimé). À rediscuter avec
  // l'équipe produit : idéalement, seul le canal mail devrait porter le
  // secret, et cette route ne renverrait que { CAVEID, MAIL, sent: true }.
  return pwd;
}

/* -------------------------------------------------------------------------- */
/*                                    PATCH                                   */
/* -------------------------------------------------------------------------- */

export async function patchIngredient(req) {
  const body = v.ingredientPatchSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const newIngredient = await services.patchIngredient(body);
  const formattedIngredients = utils.formatIngredients(newIngredient);

  return formattedIngredients[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/*                                    DELETE                                  */
/* -------------------------------------------------------------------------- */

export async function deleteDecl(req) {
  const { NUMDOS } = v.declDeleteSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  await services.deleteDecl(NUMDOS);
  return true;
}

export async function deleteCave(req) {
  const { CAVEID } = v.caveDeleteSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  await services.deleteCave(CAVEID);
  return true;
}
