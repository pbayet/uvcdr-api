import * as services from "./services.js";
import * as utils from "./utils.js";
import * as v from "./validators.js";
import * as declcavServices from "../services.js";
import { formatCaves } from "../utils.js";
import { notifyDeclcavEvent } from "../controllers.js";
import * as fileServices from "../../files/services.js";
import { StorageService } from "../../../core/services/storage.service.js";
import * as requestUtils from "../../../core/utils/request.utils.js";
import { logger } from "../../../config/logger.config.js";

/* ─────────────────────────────────────────────
   AUDITS — Controllers
   Droits :
     - lecture         : utilisateurs internes (tous audits) ; cave (les siens)
     - dépôt / version / validation / suppression : service Qualité
       (cf. utils.isAuditManager)
     - retour          : cave propriétaire, ou Qualité (retour reçu hors
       application, même principe que la saisie papier des questionnaires)
   Fichiers : enregistrés AVANT la transaction SQL (il faut leurs FILECODE),
   puis supprimés logiquement (compensation) si la transaction échoue — on
   ne laisse pas de document orphelin rattaché à rien.
───────────────────────────────────────────── */

const APP_CODE = process.env.DB_APP_CODE_DECLCAV || "DCLING";
const ENTITYTYPE_AUDIT = "AUDIT"; // ATTACHMENTS.ENTITYTYPE ; ENTITYID = CAVEID
const DOMAIN = process.env.DOMAIN;

const DEV_FALLBACK_RECIPIENT = process.env.BASE_RECIPIENT_EMAIL;

const params = async (req) => (await requestUtils.getRequestParams(req)).params;

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/* ───────────────────────── Fichiers ───────────────────────── */

async function storeFiles(req, CAVEID) {
  const storage = new StorageService({ rootDir: process.env.UPLOAD_PATH });
  const filecodes = [];
  try {
    for (const file of req.files ?? []) {
      const saved = await storage.saveUploadedFile({
        appCode: APP_CODE,
        file,
        entityType: ENTITYTYPE_AUDIT,
        entityId: String(CAVEID),
        uploadedBy: utils.getActorName(req),
      });
      filecodes.push(saved.FILECODE);
    }
    return filecodes;
  } catch (err) {
    await discardFiles(filecodes);
    throw err;
  }
}

async function discardFiles(filecodes) {
  for (const code of filecodes) {
    await fileServices
      .deleteFileByCode(code)
      .catch((e) =>
        logger.error(
          `[AUDITS] Compensation fichier ${code} impossible : ${e.message}`,
        ),
      );
  }
}

/** Enregistre les fichiers puis exécute l'écriture SQL ; compense en cas d'échec. */
async function withStoredFiles(req, CAVEID, write) {
  const filecodes = await storeFiles(req, CAVEID);
  try {
    return await write(filecodes);
  } catch (err) {
    await discardFiles(filecodes);
    throw err;
  }
}

/* ───────────────────────── Notifications ───────────────────────── */

const frDate = (iso) =>
  iso
    ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("fr-FR", {
        timeZone: "UTC",
      })
    : "—";

async function caveRecipients(CAVEID) {
  const [cave] = formatCaves(await declcavServices.getCave(CAVEID));
  return (cave?.MAILS ?? [])
    .filter((m) => m.ACTIF && m.MAIL)
    .map((m) => m.MAIL)
    .join(",");
}

async function notifyAudit(
  audit,
  { template, subject, message, toQuality = false, notices = [] },
) {
  // const recipient = toQuality
  //   ? process.env.AUDITS_QUALITY_EMAIL
  //   : await caveRecipients(audit.CAVEID).catch(() => "");

  const recipient = toQuality
    ? process.env.AUDITS_QUALITY_EMAIL
    : DEV_FALLBACK_RECIPIENT;

  await notifyDeclcavEvent({
    template,
    subject,
    message,
    recipient,
    dossierCode: `AUDIT-${audit.AUDID}`,
    desdos: audit.TITLE,
    detailGroups: [
      {
        title: "Audit",
        items: [
          { label: "Intitulé", value: audit.TITLE },
          { label: "Cave", value: audit.CAVENOM },
          { label: "Version", value: `v${audit.CURRENT.VERNUM}` },
          { label: "Date d'expiration", value: frDate(audit.CURRENT.DATEXP) },
        ],
      },
    ],
    notices,
    actionUrl:
      DOMAIN && ADMIN_DOMAIN
        ? `${toQuality ? ADMIN_DOMAIN : DOMAIN}/audits/${audit.AUDID}`
        : null,
    actionLabel: "Voir l'audit",
  });
}

/* ───────────────────────── Chargement ───────────────────────── */

async function loadAuditDetail(AUDID) {
  const row = await services.getAudit(AUDID);
  if (!row) return null;
  return utils.formatAuditDetail(row, await services.getAuditHistory(AUDID));
}

async function loadAccessibleAudit(req, AUDID) {
  const row = await services.getAudit(AUDID);
  utils.assertCanAccessAudit(req, row);
  return row;
}

/* ─────────────────────────────── GET ─────────────────────────────── */

export async function getAudits(req) {
  const query = v.auditsQuerySchema.parse(await params(req));
  const isCave = utils.isCaveToken(req);

  console.log("tests");

  const rows = await services.listAudits({
    // Une cave ne peut JAMAIS lister les audits d'une autre cave, quel que
    // soit le CAVEID envoyé.
    CAVEID: isCave ? utils.getCaveId(req) : (query.CAVEID ?? null),
    INCLUDE_DELETED: !isCave && query.INCLUDE_DELETED,
  });
  return rows.map(utils.formatAuditSummary);
}

export async function getAudit(req) {
  const { AUDID } = v.auditIdParamSchema.parse(req.params);
  await loadAccessibleAudit(req, AUDID);
  return loadAuditDetail(AUDID);
}

/* ─────────────────────────────── POST ─────────────────────────────── */

export async function createAudit(req) {
  utils.assertAuditManager(req);
  const body = v.auditCreateSchema.parse(await params(req));

  if (!req.files?.length) throw badRequest("Au moins un document est requis.");

  const [cave] = await declcavServices.getCave(body.CAVEID);
  if (!cave) {
    const err = new Error("Cave introuvable.");
    err.status = 404;
    throw err;
  }

  const { AUDID } = await withStoredFiles(req, body.CAVEID, (FILECODES) =>
    services.createAudit({ ...body, FILECODES, USR: utils.getActorName(req) }),
  );

  const audit = await loadAuditDetail(AUDID);
  await notifyAudit(audit, {
    template: "declcav/creation",
    subject: "Nouvel audit à compléter",
    message:
      "Le service Qualité a déposé un audit à compléter. Téléchargez les documents, complétez-les puis redéposez-les depuis la page Audits.",
  });
  return audit;
}

export async function createVersion(req) {
  utils.assertAuditManager(req);
  const { AUDID } = v.auditIdParamSchema.parse(req.params);
  const body = v.auditVersionSchema.parse(await params(req));
  const row = await loadAccessibleAudit(req, AUDID);

  if (!req.files?.length && !body.KEEP_FILECODES.length) {
    throw badRequest("Au moins un document est requis.");
  }

  await withStoredFiles(req, row.CAVEID, (NEW_FILECODES) =>
    services.createVersion({
      AUDID,
      ...body,
      NEW_FILECODES,
      USR: utils.getActorName(req),
    }),
  );

  const audit = await loadAuditDetail(AUDID);
  await notifyAudit(audit, {
    template: "declcav/modification",
    subject: "Audit mis à jour",
    message:
      "Le service Qualité a mis à jour un audit (documents et/ou date d'expiration). Merci de repartir des nouveaux documents.",
  });
  return audit;
}

export async function createReturn(req) {
  const { AUDID } = v.auditIdParamSchema.parse(req.params);
  const body = v.auditReturnSchema.parse(await params(req));
  const row = await loadAccessibleAudit(req, AUDID);

  if (!utils.isCaveToken(req) && !utils.isAuditManager(req)) {
    throw new Error("ACCESS_DENIED_WO_LOGOUT");
  }
  if (!req.files?.length)
    throw badRequest("Au moins un document complété est requis.");

  await withStoredFiles(req, row.CAVEID, (FILECODES) =>
    services.createReturn({
      AUDID,
      ...body,
      FILECODES,
      USR: utils.getActorName(req),
    }),
  );

  const audit = await loadAuditDetail(AUDID);
  await notifyAudit(audit, {
    template: "declcav/notification",
    subject: "Retour d'audit à traiter",
    message: `La cave ${audit.CAVENOM} a déposé ses documents d'audit complétés.`,
    toQuality: true,
  });
  return audit;
}

export async function reviewReturn(req) {
  utils.assertAuditManager(req);
  const { AUDID, RETID } = v.auditReturnParamSchema.parse(req.params);
  const body = v.auditReviewSchema.parse(await params(req));
  await loadAccessibleAudit(req, AUDID);

  await services.reviewReturn({
    AUDID,
    RETID,
    ...body,
    USR: utils.getActorName(req),
  });

  const audit = await loadAuditDetail(AUDID);
  const valid = body.DECISION === "VALID";
  await notifyAudit(audit, {
    template: valid
      ? "declcav/validation-approved"
      : "declcav/validation-rejected",
    subject: valid ? "Audit validé" : "Audit refusé — corrections demandées",
    message: valid
      ? "Le service Qualité a validé les documents d'audit que vous avez déposés."
      : "Le service Qualité a refusé les documents d'audit déposés. Merci de les corriger et de les redéposer.",
    notices: body.COMMENT
      ? [
          {
            type: valid ? "info" : "warning",
            label: "Commentaire du service Qualité",
            message: body.COMMENT,
          },
        ]
      : [],
  });
  return audit;
}

/* ─────────────────────────────── DELETE ─────────────────────────────── */

export async function deleteAudit(req) {
  utils.assertAuditManager(req);
  const { AUDID } = v.auditIdParamSchema.parse(req.params);
  const { COMMENT } = v.auditDeleteSchema.parse(await params(req));
  await loadAccessibleAudit(req, AUDID);

  await services.deleteAudit({ AUDID, COMMENT, USR: utils.getActorName(req) });
  return true;
}
