import * as services from "./services.js";
import { StorageService } from "../../core/services/storage.service.js";
import {
  uploadFilesSchema,
  deleteFilesSchema,
  revokeSignatureSchema,
  isManagerPermission,
} from "./utils.js";
import * as requestUtils from "../../core/utils/request.utils.js";
import { broadcastToAll } from "../../config/websocket/wsManager.js";

const UPLOAD_PATH = process.env.UPLOAD_PATH;

/**
 * Ce module "files" est générique (pièces jointes de tickets, projets,
 * notes... cf. ENTITYTYPE) et n'émettait jusqu'ici aucun évènement WS —
 * une PJ ajoutée/supprimée sur un ticket ne se reflétait donc jamais chez
 * un autre utilisateur (ni même, en pratique, dans la modale de l'auteur
 * lui-même : `ticket.updated`, lui, est diffusé par le PUT `ticketing`
 * AVANT que l'upload/la suppression de fichier n'ait réellement eu lieu,
 * cf. TicketFormModal.tsx — un rechargement déclenché par cet évènement
 * récupère donc encore l'ancien état des PJ). On ne diffuse qu'un
 * évènement dédié, et seulement quand ENTITYTYPE vaut "TCKCOD" (seul cas
 * consommé par le front aujourd'hui) — les PJ de projets/notes n'ont pas
 * (encore) de synchronisation temps réel.
 */
function notifyTicketAttachmentChange(type, entityType, entityId) {
  if (entityType !== "TCKCOD" || !entityId) return;
  broadcastToAll({ type, payload: { TCKCOD: entityId } });
}

export async function uploadFiles(req) {
  const payload = uploadFilesSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const ignoreIfExist =
    payload.ignoreIfExist === "true" || payload.ignoreIfExist === "1";

  if (!req.files || !Array.isArray(req.files) || req.files.length === 0) {
    const err = new Error("Au moins un fichier est requis.");
    err.status = 400;
    throw err;
  }

  const storageService = new StorageService({ rootDir: UPLOAD_PATH });

  const uploadedBy =
    req?.payload?.data?.LastName && req?.payload?.data?.FirstName
      ? `${req.payload.data.LastName} ${req.payload.data.FirstName}`
      : null;

  const result = await storageService.saveUploadedFiles({
    appCode: payload.appcode,
    entityId: payload.entityid,
    entityType: payload.entitytyp,
    ignoreIfExist,
    uploadedBy,
    files: req.files,
  });

  notifyTicketAttachmentChange(
    "ticket.attachment.created",
    payload.entitytyp,
    payload.entityid,
  );

  return result;
}

export async function deleteFiles(req) {
  const { metas } = (await requestUtils.getRequestParams(req)).params;

  const jsonMetas = typeof metas === "string" ? JSON.parse(metas) : metas;
  const { metas: validatedMetas } = deleteFilesSchema.parse({
    metas: jsonMetas,
  });

  for (const meta of validatedMetas) {
    if (meta.entity) {
      await services.deleteFileByEntity(
        meta.entity.entityName,
        meta.entity.entityId,
      );
      notifyTicketAttachmentChange(
        "ticket.attachment.deleted",
        meta.entity.entityName,
        meta.entity.entityId,
      );
    }
    if (meta.filecode) {
      // Contrairement à `meta.entity` ci-dessus (ENTITYTYPE/ENTITYID déjà
      // connus de l'appelant), on ne les découvre ici qu'en retour de
      // `deleteFileByCode` — c'est le cas emprunté par la suppression
      // d'une PJ de ticket (cf. `Attachment.deletedFilesMeta("CURRENT_FILE")`
      // côté front, qui n'envoie que le FILECODE).
      const deleted = await services.deleteFileByCode(meta.filecode);
      if (deleted) {
        notifyTicketAttachmentChange(
          "ticket.attachment.deleted",
          deleted.ENTITYTYPE,
          deleted.ENTITYID,
        );
      }
    }
  }

  return true;
}

/**
 * Reconstitue le nom affiché de l'utilisateur courant à partir du JWT —
 * même convention que `uploadedBy` dans uploadFiles ci-dessus (pas d'ID
 * numérique stocké sur ATTACHMENTS/ATTACHMENTSIGNATURES, juste un nom
 * affichable). Staff : "Nom Prénom". Cave (token DCLING, cf.
 * auth.middleware.js) : pas de LastName/FirstName, on retombe sur CAVENOM
 * (raison sociale, attachée à `payload.data` par authVerifyMiddleware) —
 * permet à la cave en charge de la validation d'un dossier de signer
 * numériquement ses PJ (cf. signFileAttachment). `null` si aucune des deux
 * identités n'est exploitable — signer/révoquer exige alors un rejet
 * explicite plutôt qu'une signature attribuée à un utilisateur non
 * identifiable.
 */
function getCurrentUserDisplayName(req) {
  const data = req?.payload?.data;

  if (data?.LastName && data?.FirstName) {
    return `${data.LastName} ${data.FirstName}`;
  }

  if (data?.CAVENOM) {
    return data.CAVENOM;
  }

  return null;
}

/**
 * Une cave (token DCLING) ne peut signer que les PJ "du dossier" (ENTITYTYPE
 * NUMDOS, cf. front `ENTITYTYPE_FOLDER`) de SON PROPRE dossier — jamais
 * celles d'un autre dossier, ni celles d'un autre domaine (ex. TCKCOD côté
 * ticketing) où la notion de "cave propriétaire" n'a pas de sens. Sans ce
 * contrôle, `signFileAttachment` se contenterait de vérifier l'identité du
 * signataire (getCurrentUserDisplayName) mais pas son droit à signer CETTE
 * PJ précise : n'importe quelle cave authentifiée pourrait alors signer les
 * PJ de n'importe quel autre dossier en devinant/énumérant un FILECODE.
 * Ne s'applique volontairement qu'aux tokens DCLING : le staff (comptes
 * LDAP/usersmanager) n'est pas restreint ici — cf. plutôt le front
 * (FolderInfos.tsx#CAN_SIGN_FOLDER_ATTACHMENTS), qui ne propose la
 * signature qu'à la cave sur cet écran.
 */
async function assertCaveOwnsAttachment(req, filecode) {
  const [attachment] = await services.getFiles({ FILECODE: filecode });

  if (!attachment || attachment.DELETEDAT) {
    const err = new Error("Pièce jointe introuvable.");
    err.status = 404;
    throw err;
  }

  if (attachment.ENTITYTYPE !== "NUMDOS") {
    throw new Error("ACCESS_DENIED_WO_LOGOUT");
  }
}

/**
 * POST /api/files/:filecode/sign — Signe numériquement la PJ désignée par
 * FILECODE (HMAC-SHA256 sur ATTACHMENTS.CHECKSUMSHA256 au moment de
 * l'appel, cf. services.signAttachment). Plusieurs signatures VALID
 * simultanées sont admises sur une même PJ (signataires différents) ; le
 * même signataire ne peut pas la signer deux fois tant que sa précédente
 * signature est VALID (409, cf. contrainte UQ_ATTACHMENTSIGNATURES_
 * FILEID_SIGNEDBY_VALID côté base).
 */
export async function signFileAttachment(req) {
  const { filecode } = req.params;

  if (!filecode) {
    const err = new Error("FILECODE requis.");
    err.status = 400;
    throw err;
  }

  const signedBy = getCurrentUserDisplayName(req);

  if (!signedBy) {
    const err = new Error(
      "Utilisateur non identifiable pour signer cette pièce jointe.",
    );
    err.status = 403;
    throw err;
  }

  if (req?.payload?.application === "DCLING") {
    await assertCaveOwnsAttachment(req, filecode);
  }

  return services.signAttachment(filecode, signedBy);
}

/**
 * GET /api/files/:filecode/signatures — Liste les signatures (VALID +
 * REVOKED, les plus récentes d'abord) d'une PJ.
 */
export async function getFileSignatures(req) {
  const { filecode } = req.params;

  if (!filecode) {
    const err = new Error("FILECODE requis.");
    err.status = 400;
    throw err;
  }

  return services.getSignatures(filecode);
}

/**
 * GET /api/files/signatures/:sigid/verify — Vérifie une signature :
 * validité cryptographique (HMAC recalculé avec le secret de sa
 * KEYVERSION) + absence d'altération du fichier depuis la signature (cf.
 * services.verifySignature pour le détail de `valid`/`cryptographicallyValid`/
 * `fileUnchanged`).
 */
export async function verifyFileSignature(req) {
  const sigid = parseInt(req.params.sigid, 10);

  if (!Number.isInteger(sigid) || sigid <= 0) {
    const err = new Error("Identifiant de signature invalide.");
    err.status = 400;
    throw err;
  }

  return services.verifySignature(sigid);
}

/**
 * DELETE /api/files/signatures/:sigid — Révoque une signature VALID
 * (jamais de suppression physique, cf. sql/ATTACHMENTSIGNATURES.table.sql).
 * Réservé au signataire d'origine ou à un profil "gestionnaire" (MODIFY_PERMS,
 * même convention que modules/faq/controllers.js#addModerator/removeModerator) —
 * un signataire ne peut donc pas voir sa signature révoquée par n'importe
 * quel autre utilisateur authentifié.
 */
export async function revokeFileSignature(req) {
  const sigid = parseInt(req.params.sigid, 10);

  if (!Number.isInteger(sigid) || sigid <= 0) {
    const err = new Error("Identifiant de signature invalide.");
    err.status = 400;
    throw err;
  }

  const { reason } = revokeSignatureSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  const signature = await services.getSignatureById(sigid);

  if (!signature) {
    const err = new Error("Signature introuvable.");
    err.status = 404;
    throw err;
  }

  const currentUserDisplayName = getCurrentUserDisplayName(req);
  const isOwner =
    Boolean(currentUserDisplayName) &&
    signature.SIGNEDBY === currentUserDisplayName;
  const isManager = isManagerPermission(req?.payload?.permission);

  if (!isOwner && !isManager) {
    throw new Error("ACCESS_DENIED_WO_LOGOUT");
  }

  if (signature.STATUS !== "VALID") {
    const err = new Error("Cette signature est déjà révoquée.");
    err.status = 409;
    throw err;
  }

  const revokedBy =
    currentUserDisplayName ||
    `MANAGER:${req?.payload?.data?.email || "unknown"}`;

  await services.revokeSignature(sigid, revokedBy, reason ?? null);

  return { SIGID: sigid, STATUS: "REVOKED" };
}
