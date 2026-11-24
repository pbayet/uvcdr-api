import fs from "node:fs/promises";
import path from "node:path";
import * as services from "./services.js";
import * as links from "./links.js";
import { StorageService } from "../../core/services/storage.service.js";
import {
  uploadFilesSchema,
  deleteFilesSchema,
  revokeSignatureSchema,
  isManagerPermission,
  createFileLinkSchema,
  listFileLinksSchema,
  lnkidParamSchema,
  fileLinkTokenParamSchema,
} from "./utils.js";
import * as requestUtils from "../../core/utils/request.utils.js";
import {
  broadcastToAll,
  broadcastToCaves,
} from "../../config/websocket/wsManager.js";
import { logger } from "../../config/logger.config.js";

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
  if (!entityId) return;

  // FAQ (modules/faq) : pièces jointes d'une publication (FAQPST, ENTITYID =
  // PSTID) ou d'une réponse (FAQANS, ENTITYID = ANSID). Un seul évènement,
  // le front recharge la discussion concernée.
  if (entityType === "FAQPST" || entityType === "FAQANS") {
    broadcastToAll({
      type: "faq.attachments.updated",
      payload: { ENTITYTYPE: entityType, ENTITYID: String(entityId) },
    });
    return;
  }

  if (entityType !== "TCKCOD") return;
  broadcastToAll({ type, payload: { TCKCOD: entityId } });
}

/**
 * Pièces jointes d'un dossier declaration-ingredients : "NUMDOS" (déposées à
 * la création du dossier) et "NUMDOSDECL" (déposées avec la déclaration),
 * ENTITYID = NUMDOS. cf. front Attachment.class (ENTITYTYPE_FOLDER /
 * ENTITYTYPE_DECLARATION).
 */
const DECLCAV_ENTITY_TYPES = new Set(["NUMDOS", "NUMDOSDECL"]);

/**
 * Temps réel declcav (liste des évènements : modules/declcav/controllers.js,
 * broadcastDeclcav) : declcav.attachment.updated { NUMDOS, ENTITYTYPE } aux
 * internes et à la cave du dossier. La cave est celle du jeton quand c'est
 * elle qui dépose ; sinon une lecture légère du CAVEID du dossier
 * (getFolderCaveId), indispensable pour la prévenir. Best-effort, sans
 * retarder la réponse : une erreur est seulement loguée.
 */
function notifyDeclcavAttachmentChange(req, entityType, entityId) {
  if (!entityId || !DECLCAV_ENTITY_TYPES.has(entityType)) return;

  const type = "declcav.attachment.updated";
  const message = {
    type,
    payload: { NUMDOS: String(entityId), ENTITYTYPE: entityType },
  };
  const ownCaveId = req?.payload?.isCave
    ? Number(req.payload.data?.id) || null
    : null;

  Promise.resolve(ownCaveId ?? services.getFolderCaveId(String(entityId)))
    .then((caveId) => {
      broadcastToAll(message);
      if (caveId) broadcastToCaves([caveId], message);
    })
    .catch((err) => logger.warn(`[WS] ${type} non diffusé : ${err.message}`));
}

/** Pièces jointes du module FAQ (cf. modules/faq/services.ATTACHMENT_TYPES). */
const FAQ_ENTITY_TYPES = new Set(["FAQPST", "FAQANS"]);

/**
 * Pièce jointe FAQ : ajout / suppression réservés à l'auteur de la
 * publication ou de la réponse et aux modérateurs. Import à la demande pour
 * ne pas lier le chargement de ce module générique à celui de la FAQ.
 */
async function assertFaqAttachmentAccess(req, entityType, entityId) {
  if (!FAQ_ENTITY_TYPES.has(entityType)) return;
  const faq = await import("../faq/controllers.js");
  await faq.assertCanManageAttachments(req, entityType, entityId);
}

export async function uploadFiles(req) {
  const payload = uploadFilesSchema.parse(
    (await requestUtils.getRequestParams(req)).params,
  );

  await assertFaqAttachmentAccess(req, payload.entitytyp, payload.entityid);

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
  notifyDeclcavAttachmentChange(req, payload.entitytyp, payload.entityid);

  return result;
}

export async function deleteFiles(req) {
  const { metas } = (await requestUtils.getRequestParams(req)).params;

  const jsonMetas = typeof metas === "string" ? JSON.parse(metas) : metas;
  const { metas: validatedMetas } = deleteFilesSchema.parse({
    metas: jsonMetas,
  });

  // Contrôle d'accès des pièces jointes FAQ AVANT toute suppression (une
  // requête refusée ne doit rien supprimer, même partiellement).
  for (const meta of validatedMetas) {
    if (meta.entity) {
      await assertFaqAttachmentAccess(
        req,
        meta.entity.entityName,
        meta.entity.entityId,
      );
    }
    if (meta.filecode) {
      const [file] = await services.getFiles({ FILECODE: meta.filecode });
      if (file) {
        await assertFaqAttachmentAccess(req, file.ENTITYTYPE, file.ENTITYID);
      }
    }
  }

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
      notifyDeclcavAttachmentChange(
        req,
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
        notifyDeclcavAttachmentChange(
          req,
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
 * Ne s'applique qu'aux tokens DCLING (propriété du dossier : caves
 * uniquement, `isCave`) : le staff des autres applications (comptes
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

  // Jeton de cave : le dossier de la PJ doit être le sien (data.id = CAVEID).
  // Un compte staff connecté à DCLING (mode admin) n'a pas de cave : il
  // garde la seule restriction ci-dessus.
  if (!req?.payload?.isCave) return;

  const ownCaveId = Number(req.payload.data?.id) || null;
  const folderCaveId = await services.getFolderCaveId(String(attachment.ENTITYID));

  if (!ownCaveId || Number(folderCaveId) !== ownCaveId) {
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

/* ─────────────────────────────────────────────
   Liens directs vers un fichier (cf. links.js)
───────────────────────────────────────────── */

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Application et auteur de la requête (jeton obligatoire). */
function linkContext(req) {
  const APPCODE = req?.payload?.application;
  const user = links.currentUser(req);
  if (!APPCODE || !user.USRID) throw httpError(403, "Utilisateur non identifiable.");
  return { APPCODE, ...user };
}

/**
 * POST /api/files/links — crée un lien direct. Corps : `FILECODE` (fichier
 * précis) ou `TARGET` (cible propre à l'application, ex. PROCS :
 * `{ PRCID, VERNUM?, KIND? }`), `EXPIRESIN` (« 7d », « 12h », secondes…)
 * ou `PERMANENT: true`, `WITHNAME` (nom du fichier en fin d'URL, défaut
 * true). Les droits (qui, vers quoi, quelle durée) dépendent de
 * l'application du jeton. Le jeton du lien n'est renvoyé qu'ici.
 */
export async function createFileLink(req) {
  const ctx = linkContext(req);
  const input = createFileLinkSchema.parse((await requestUtils.getRequestParams(req)).params);

  let EXPIRESIN;
  if (input.EXPIRESIN !== undefined && input.EXPIRESIN !== "") {
    EXPIRESIN = links.parseDuration(input.EXPIRESIN);
    if (EXPIRESIN === null) {
      throw httpError(400, "Durée illisible : indiquez des secondes ou « 30m », « 12h », « 7j », « 1a ».");
    }
  }

  const provider = await links.getProvider(ctx.APPCODE);
  const target = await provider.authorize(req, { ...input, EXPIRESIN });
  const TTL = links.effectiveTtl({ PERMANENT: input.PERMANENT, EXPIRESIN }, target.POLICY);

  const { token, hash } = links.newToken();
  const row = await services.insertLink({
    TOKENHASH: hash,
    APPCODE: ctx.APPCODE,
    FILECODE: target.FILECODE ?? null,
    ENTITYTYPE: target.ENTITYTYPE ?? null,
    ENTITYID: target.ENTITYID != null ? String(target.ENTITYID) : null,
    PARAMS: target.PARAMS ? JSON.stringify(target.PARAMS) : null,
    FILENAME: target.FILENAME ?? null,
    LABEL: target.LABEL ?? null,
    WITHNAME: input.WITHNAME,
    TTL,
    CREATEDBY: ctx.USRID,
    CREATEDBYNAME: ctx.NAME,
  });
  const link = links.formatLink(row);

  logger.info(
    `[FILES][LINK] #${link.LNKID} ${ctx.APPCODE} ${link.FILECODE ?? `${link.ENTITYTYPE}:${link.ENTITYID}`} par ${ctx.NAME} — ${TTL === null ? "permanent" : `${TTL} s`}`,
  );
  return { ...link, PATH: links.linkPath(token, target.FILENAME, input.WITHNAME) };
}

/**
 * GET /api/files/links — liens de l'application du jeton (filtres :
 * `FILECODE`, `ENTITYTYPE`, `ENTITYID`, `ACTIVE=true`). Gestionnaires de
 * l'application : tous les liens ; autres utilisateurs : les leurs.
 */
export async function listFileLinks(req) {
  const ctx = linkContext(req);
  const filters = listFileLinksSchema.parse((await requestUtils.getRequestParams(req)).params);
  const provider = await links.getProvider(ctx.APPCODE);
  const manager = await provider.canManage(req);
  const rows = await services.listLinks({
    APPCODE: ctx.APPCODE,
    FILECODE: filters.FILECODE,
    ENTITYTYPE: filters.ENTITYTYPE,
    ENTITYID: filters.ENTITYID,
    ACTIVEONLY: filters.ACTIVE,
    CREATEDBY: manager ? null : ctx.USRID,
  });
  return rows.map(links.formatLink);
}

/** DELETE /api/files/links/:lnkid — révoque un lien (son auteur ou un gestionnaire). */
export async function revokeFileLink(req) {
  const ctx = linkContext(req);
  const { lnkid } = lnkidParamSchema.parse(req.params);
  const row = await services.getLinkById(lnkid);
  if (!row || row.APPCODE !== ctx.APPCODE) throw httpError(404, "Lien introuvable.");

  const provider = await links.getProvider(ctx.APPCODE);
  if (row.CREATEDBY !== ctx.USRID && !(await provider.canManage(req))) {
    throw httpError(403, "Seul l'auteur du lien ou un gestionnaire peut le désactiver.");
  }
  const updated = await services.revokeLink(lnkid, ctx.USRID, ctx.NAME);
  logger.info(`[FILES][LINK] #${lnkid} révoqué par ${ctx.NAME}`);
  return links.formatLink(updated);
}

/** Chemin absolu d'un fichier déposé, borné à UPLOAD_PATH. */
function resolveStoredPath(relativePath) {
  if (!UPLOAD_PATH) throw new Error("UPLOAD_PATH non configuré.");
  const root = path.resolve(UPLOAD_PATH);
  const abs = path.resolve(root, relativePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw httpError(404, "Document introuvable.");
  return abs;
}

/** En-tête Content-Disposition avec nom UTF-8 (RFC 6266 / 5987). */
function contentDisposition(type, filename) {
  const ascii = String(filename).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * GET (ou HEAD) /api/files/open/:token[/:filename] — route PUBLIQUE : ouvre
 * le fichier d'un lien direct. Le nom final de l'URL est ignoré. PDF,
 * images et texte s'affichent dans le navigateur, le reste se télécharge.
 * Une requête HEAD (visionneuse qui sonde le type) n'est pas comptée.
 */
export async function openFileLink(req, res) {
  const parsed = fileLinkTokenParamSchema.safeParse(req.params);
  const row = parsed.success
    ? await services.getLinkByTokenHash(links.hashToken(parsed.data.token))
    : null;
  if (!row) throw httpError(404, "Lien invalide : vérifiez qu'il a été copié en entier.");
  if (row.STATUS === "REVOKED") throw httpError(410, "Ce lien a été désactivé.");
  if (row.STATUS === "EXPIRED") throw httpError(410, "Ce lien a expiré : demandez-en un nouveau.");

  const link = links.formatLink(row);
  const provider = await links.getProvider(link.APPCODE);
  const target = await provider.resolve(link, { method: req.method });
  if (!target?.FILECODE) throw httpError(404, "Ce document n'est plus disponible.");

  const [attachment] = await services.getFiles({ FILECODE: target.FILECODE });
  if (!attachment || attachment.APPCODE !== link.APPCODE) {
    throw httpError(404, "Ce document n'est plus disponible.");
  }
  const absPath = resolveStoredPath(attachment.RELATIVEPATH);
  await fs.access(absPath).catch(() => {
    throw httpError(404, "Ce document n'est plus disponible.");
  });

  const mimetype = attachment.MIMETYPE || "application/octet-stream";
  const disposition = /^(application\/pdf|image\/|text\/plain)/.test(mimetype) ? "inline" : "attachment";
  const filename = target.FILENAME || attachment.ORIGINALNAME || "document";

  if (req.method !== "HEAD") {
    services
      .markLinkOpened(link.LNKID)
      .catch((err) => logger.warn(`[FILES][LINK] ouverture #${link.LNKID} non comptée : ${err.message}`));
    Promise.resolve()
      .then(() => target.onOpen?.({ disposition }))
      .catch((err) => logger.warn(`[FILES][LINK] traçabilité #${link.LNKID} : ${err.message}`));
  }

  res.setHeader("Content-Type", mimetype);
  res.setHeader("Content-Disposition", contentDisposition(disposition, filename));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  // dotfiles "allow" : chemin construit ici et borné à UPLOAD_PATH, qui peut
  // lui-même passer par un dossier caché (ex. tests/.tmp/uploads).
  await new Promise((resolve, reject) =>
    res.sendFile(absPath, { dotfiles: "allow" }, (err) => (err ? reject(err) : resolve())),
  );
}
