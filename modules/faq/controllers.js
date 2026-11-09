import * as services from "./services.js";
import * as utils from "./utils.js";
import * as v from "./validators.js";
import * as requestUtils from "../../core/utils/request.utils.js";
import * as ticketingServices from "../ticketing/services.js";
import { broadcastToAll } from "../../config/websocket/wsManager.js";
import {
  sendTemplatedMail,
  renderDetailsList,
} from "../../core/services/mail.service.js";
import { logger } from "../../config/logger.config.js";

/* ─────────────────────────────────────────────
   FAQ — Controllers (Foire aux questions)
   Responsabilité : valider les paramètres (zod), contrôler les droits,
   appeler le service, formater la réponse, notifier.

   Droits :
     - lecture / publication / réponse / like : tout utilisateur connecté,
       dans la limite de la visibilité par application (cf. services.js) ;
     - modification de sa publication / réponse : son auteur (une réponse
       validée n'est plus modifiable que par un modérateur) ;
     - statut, épinglage, mots-clés, bonne réponse, ticket, suppression
       définitive, catégories : modérateurs (FAQMODERATORS) et gestionnaires
       globaux (MODIFY_PERMS) ;
     - désignation des modérateurs : gestionnaires globaux uniquement.

   Temps réel : événements légers `faq.*` (identifiants uniquement) diffusés
   à tous les clients, qui rechargent eux-mêmes ce qu'ils affichent — même
   principe que modules/ticketing.

   Emails (best-effort, jamais bloquants) via le template
   mail-templates/faq/notification.html :
     - nouvelle publication      → modérateurs ;
     - nouvelle réponse          → auteur + participants de la discussion ;
     - bonne réponse retenue     → auteur de la publication et de la réponse.
   Hors production, tout part vers BASE_RECIPIENT_EMAIL.
───────────────────────────────────────────── */

const IS_PROD = process.env.NODE_ENV === "production";
const DOMAIN = process.env.DOMAIN;
const BASE_RECIPIENT_EMAIL = process.env.BASE_RECIPIENT_EMAIL;

const TYPE_LABELS = { QUESTION: "question", SUGGESTION: "suggestion" };

async function params(req, schema) {
  return schema.parse((await requestUtils.getRequestParams(req)).params);
}

function emit(type, payload) {
  broadcastToAll({ type, payload });
}

function assertModerator(ctx) {
  if (!ctx.ISMOD) throw new Error("ACCESS_DENIED_WO_LOGOUT");
}

async function loadVisiblePost(ctx, PSTID) {
  const post = await services.getPost(ctx, PSTID);
  if (!post) throw new Error("DATA_NOT_FOUND");
  return post;
}

async function buildPost(ctx, PSTID) {
  const post = await loadVisiblePost(ctx, PSTID);
  const answers = await services.getAnswers(ctx, [PSTID]);
  const [formatted] = await attachFiles([utils.formatPost(post, answers)]);
  return formatted;
}

/**
 * Ajoute les pièces jointes (PJS) aux publications formatées et à leurs
 * réponses, et le nombre de pièces jointes de la publication (ATTCOUNT).
 * Deux requêtes au plus, quel que soit le nombre de publications. Un
 * incident sur la base des pièces jointes ne bloque jamais l'affichage.
 */
async function attachFiles(posts, { answers = true } = {}) {
  if (!posts.length) return posts;

  const answerIds = answers
    ? posts.flatMap((p) => (p.ANSWERS ?? []).map((a) => a.ANSID))
    : [];

  let postFiles = new Map();
  let answerFiles = new Map();
  try {
    const [postRows, answerRows] = await Promise.all([
      services.getAttachments(
        services.ATTACHMENT_TYPES.POST,
        posts.map((p) => p.PSTID),
      ),
      services.getAttachments(services.ATTACHMENT_TYPES.ANSWER, answerIds),
    ]);
    postFiles = utils.groupAttachments(postRows);
    answerFiles = utils.groupAttachments(answerRows);
  } catch (err) {
    logger.warn(`[FAQ][PJ] Pièces jointes indisponibles : ${err.message}`);
  }

  return posts.map((post) => {
    const PJS = postFiles.get(String(post.PSTID)) ?? [];
    return {
      ...post,
      PJS,
      ATTCOUNT: PJS.length,
      ...(post.ANSWERS
        ? {
            ANSWERS: post.ANSWERS.map((a) => ({
              ...a,
              PJS: answerFiles.get(String(a.ANSID)) ?? [],
            })),
          }
        : {}),
    };
  });
}

/* ─────────────────────────────────────────────
   Emails
───────────────────────────────────────────── */

function postUrl(PSTID) {
  return DOMAIN ? `${DOMAIN}/faq/publications/${PSTID}` : "";
}

async function notifyFaqEvent({ to, subject, title, message, post, answer, reason }) {
  try {
    const real = [...new Set((to ?? []).filter(Boolean))];
    const recipients = IS_PROD
      ? real
      : BASE_RECIPIENT_EMAIL && real.length
        ? [BASE_RECIPIENT_EMAIL]
        : [];
    if (!recipients.length) return;

    await sendTemplatedMail({
      template: "faq/notification",
      to: recipients,
      subject,
      data: {
        APP_NAME: "Foire aux questions",
        TITLE: title,
        MESSAGE: message,
        POST_REF: `#${post.PSTID}`,
        POST_TITLE: post.TITLE,
        POST_BODY: post.BODY,
        ANSWER_BODY: answer?.BODY ?? "",
        DETAILS_ROWS_HTML: renderDetailsList(
          [
            { label: "Type", value: post.TYPE === "QUESTION" ? "Question" : "Suggestion" },
            { label: "Auteur", value: post.USRNAM },
            { label: "Catégorie", value: post.CATNAME },
            { label: "Application", value: post.APPNAM },
          ].filter((d) => d.value),
        ),
        ACTION_URL: postUrl(post.PSTID),
        ACTION_LABEL: "Ouvrir la discussion",
        RECIPIENT_REASON: IS_PROD
          ? reason
          : `Environnement de développement — destinataires réels : ${real.join(", ")}.`,
      },
    });
  } catch (err) {
    logger.error(`[FAQ][MAIL] Échec notification "${subject}" : ${err.message}`);
  }
}

/* ─────────────────────────────────────────────
   Modérateurs
───────────────────────────────────────────── */

export async function getMyModeratorStatus(req) {
  const ctx = await utils.getUserContext(req);
  return { MODERATOR: ctx.ISMOD, MANAGER: ctx.ISMANAGER };
}

export async function getModerators(req) {
  await utils.getUserContext(req);
  return services.getModerators();
}

export async function addModerator(req) {
  const ctx = await utils.getUserContext(req);
  if (!ctx.ISMANAGER) throw new Error("ACCESS_DENIED_WO_LOGOUT");
  const { USRID } = await params(req, v.moderatorCreateSchema);

  await services.addModerator(USRID, ctx.USRID);
  emit("faq.moderators.updated", { USRID });
  return services.getModerators();
}

export async function removeModerator(req) {
  const ctx = await utils.getUserContext(req);
  if (!ctx.ISMANAGER) throw new Error("ACCESS_DENIED_WO_LOGOUT");
  const { usrid } = await params(req, v.usridParamSchema);

  await services.removeModerator(usrid);
  emit("faq.moderators.updated", { USRID: usrid });
  return services.getModerators();
}

/* ─────────────────────────────────────────────
   Référentiels
───────────────────────────────────────────── */

export async function getStatuses(req) {
  const { TYPE } = await params(req, v.statusQuerySchema);
  return requestUtils.getCachedResult(
    `faq.statuses.${TYPE ?? "ALL"}`,
    () => services.getStatuses(TYPE),
    10 * 60 * 1000,
  );
}

export async function getCategories() {
  return services.getCategories();
}

export async function getAllCategories(req) {
  const ctx = await utils.getUserContext(req);
  assertModerator(ctx);
  return services.getCategories({ includeInactive: true });
}

export async function createCategory(req) {
  const ctx = await utils.getUserContext(req);
  assertModerator(ctx);
  const body = await params(req, v.categoryCreateSchema);

  if (await services.categoryNameTaken(body.NAME)) {
    throw new Error("FAQ_CATEGORY_NAME_EXISTS");
  }

  const CATID = await services.createCategory({ ...body, CREUSR: ctx.USRID });
  emit("faq.categories.updated", { CATID });
  return services.getCategories({ includeInactive: true });
}

export async function updateCategory(req) {
  const ctx = await utils.getUserContext(req);
  assertModerator(ctx);
  const { catid } = await params(req, v.catidParamSchema);
  const body = await params(req, v.categoryUpdateSchema);

  const category = await services.getCategory(catid);
  if (!category) throw new Error("DATA_NOT_FOUND");

  const willBeActive = body.ACTIVE ?? !!category.ACTIVE;
  const name = body.NAME ?? category.NAME;
  if (willBeActive && (await services.categoryNameTaken(name, catid))) {
    throw new Error("FAQ_CATEGORY_NAME_EXISTS");
  }

  await services.updateCategory(catid, body);
  emit("faq.categories.updated", { CATID: catid });
  return services.getCategories({ includeInactive: true });
}

export async function getApplications(req) {
  const ctx = await utils.getUserContext(req);
  const appcods = await utils.getAllowedAppCodes(ctx);
  return services.getApplications(appcods);
}

/* ─────────────────────────────────────────────
   Publications
───────────────────────────────────────────── */

export async function getPosts(req) {
  const ctx = await utils.getUserContext(req);
  const filters = await params(req, v.postListQuerySchema);
  const rows = await services.getPosts(ctx, filters);
  return attachFiles(rows.map((row) => utils.formatPost(row)), {
    answers: false,
  });
}

export async function getSimilarPosts(req) {
  const ctx = await utils.getUserContext(req);
  const query = await params(req, v.similarQuerySchema);
  const rows = await services.getSimilarPosts(ctx, query);
  return rows.map((row) => utils.formatPost(row));
}

export async function getPost(req) {
  const ctx = await utils.getUserContext(req);
  const { pstid } = await params(req, v.pstidParamSchema);
  return buildPost(ctx, pstid);
}

export async function createPost(req) {
  const ctx = await utils.getUserContext(req);
  const body = await params(req, v.postCreateSchema);

  const PSTID = await services.createPost({ ...body, CREUSR: ctx.USRID });
  if (!PSTID) throw new Error("DB_QUERY_ERROR");

  const post = await loadVisiblePost(ctx, PSTID);
  emit("faq.post.created", { PSTID, TYPE: body.TYPE });

  void services.getModeratorEmails().then((emails) =>
    notifyFaqEvent({
      to: emails.filter((e) => e !== post.USREMAIL),
      subject: `[FAQ] Nouvelle ${TYPE_LABELS[post.TYPE]} : ${post.TITLE}`,
      title: `Nouvelle ${TYPE_LABELS[post.TYPE]}`,
      message: `${post.USRNAM ?? "Un utilisateur"} a publié une nouvelle ${TYPE_LABELS[post.TYPE]}.`,
      post,
      reason: "Vous recevez ce message en tant que modérateur de la FAQ.",
    }),
  );

  return utils.formatPost(post, []);
}

export async function updatePost(req) {
  const ctx = await utils.getUserContext(req);
  const { pstid } = await params(req, v.pstidParamSchema);
  const body = await params(req, v.postUpdateSchema);

  const post = await loadVisiblePost(ctx, pstid);
  const isAuthor = Number(post.CREUSR) === ctx.USRID;
  if (!isAuthor && !ctx.ISMOD) throw new Error("ACCESS_DENIED_WO_LOGOUT");

  const fields = {
    TITLE: body.TITLE,
    BODY: body.BODY,
    CATID: body.CATID,
    APPID: body.APPID,
  };

  if (ctx.ISMOD) {
    fields.PINNED = body.PINNED;
    if (body.STSID !== undefined) {
      if (body.STSID !== null) {
        const status = await services.getStatus(body.STSID);
        if (!status || status.TYPE !== post.TYPE) throw new Error("FAQ_INVALID_STATUS");
      }
      fields.STSID = body.STSID;
    }
  }

  await services.updatePost(pstid, fields);
  emit("faq.post.updated", { PSTID: pstid });
  return buildPost(ctx, pstid);
}

export async function deletePost(req) {
  const ctx = await utils.getUserContext(req);
  const { pstid } = await params(req, v.pstidParamSchema);
  const { DLTD, PERM } = await params(req, v.postDeleteSchema);

  const post = await services.getPostRaw(pstid);
  if (!post) throw new Error("DATA_NOT_FOUND");

  const isAuthor = Number(post.CREUSR) === ctx.USRID;
  // Masquer : auteur ou modérateur ; restaurer / supprimer définitivement :
  // modérateur uniquement.
  if (PERM || !DLTD) assertModerator(ctx);
  else if (!isAuthor && !ctx.ISMOD) throw new Error("ACCESS_DENIED_WO_LOGOUT");

  if (PERM) {
    const answerIds = await services.getAnswerIds(pstid);
    await services.deletePostPermanently(pstid);
    // Pièces jointes de la publication et de ses réponses (best-effort).
    await Promise.all([
      services.deleteAttachments(services.ATTACHMENT_TYPES.POST, [pstid]),
      services.deleteAttachments(services.ATTACHMENT_TYPES.ANSWER, answerIds),
    ]).catch((err) =>
      logger.warn(`[FAQ][PJ] Nettoyage des pièces jointes #${pstid} : ${err.message}`),
    );
    emit("faq.post.deleted", { PSTID: pstid, PERM: true });
  } else {
    await services.setPostDeleted(pstid, DLTD);
    emit(DLTD ? "faq.post.deleted" : "faq.post.restored", { PSTID: pstid });
  }

  return { PSTID: pstid, DLTD, PERM };
}

export async function registerView(req) {
  const ctx = await utils.getUserContext(req);
  const { pstid } = await params(req, v.pstidParamSchema);
  await loadVisiblePost(ctx, pstid);
  const row = await services.incrementViews(pstid);
  if (!row) throw new Error("DATA_NOT_FOUND");
  return row;
}

export async function convertPost(req) {
  const ctx = await utils.getUserContext(req);
  const { pstid } = await params(req, v.pstidParamSchema);
  const { TYPE } = await params(req, v.postConvertSchema);

  const post = await loadVisiblePost(ctx, pstid);
  const isAuthor = Number(post.CREUSR) === ctx.USRID;
  if (!isAuthor && !ctx.ISMOD) throw new Error("ACCESS_DENIED_WO_LOGOUT");
  if (post.TYPE === TYPE) return buildPost(ctx, pstid);

  if (await services.hasAnyTicket(pstid)) {
    throw new Error("FAQ_CONVERSION_TICKET_LINKED");
  }
  if (TYPE === "SUGGESTION" && post.VALIDATEDCOUNT > 0 && !ctx.ISMOD) {
    throw new Error("FAQ_CONVERSION_VALIDATED_ANSWERS");
  }

  await services.convertPost(pstid, TYPE);
  emit("faq.post.updated", { PSTID: pstid });
  return buildPost(ctx, pstid);
}

export async function setKeywords(req) {
  const ctx = await utils.getUserContext(req);
  assertModerator(ctx);
  const { pstid } = await params(req, v.pstidParamSchema);
  const { KEYWORDS } = await params(req, v.postKeywordsSchema);

  await loadVisiblePost(ctx, pstid);
  await services.setKeywords(pstid, utils.normalizeKeywords(KEYWORDS), ctx.USRID);
  emit("faq.post.keywords.updated", { PSTID: pstid });
  return buildPost(ctx, pstid);
}

/**
 * Transforme une suggestion (ou l'une de ses réponses) en ticket du module
 * ticketing. La ligne FAQTICKETS est réservée AVANT la création du ticket
 * (index unique) pour éviter un doublon en cas de double soumission.
 */
export async function createTicket(req) {
  const ctx = await utils.getUserContext(req);
  assertModerator(ctx);
  const { pstid } = await params(req, v.pstidParamSchema);
  const body = await params(req, v.postTicketSchema);

  const post = await loadVisiblePost(ctx, pstid);
  if (post.TYPE !== "SUGGESTION") throw new Error("FAQ_TICKET_NOT_SUGGESTION");

  let answer = null;
  if (body.ANSID) {
    answer = await services.getAnswerRaw(body.ANSID);
    if (!answer || answer.PSTID !== pstid || answer.DLTD) {
      throw new Error("DATA_NOT_FOUND");
    }
  }

  const FTKID = await services.reserveTicket(pstid, body.ANSID, ctx.USRID);
  if (!FTKID) throw new Error("FAQ_TICKET_ALREADY_EXISTS");

  try {
    const link = postUrl(pstid);
    const DESCR = [body.DESCR, link ? `Origine : suggestion FAQ #${pstid} — ${link}` : null]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 2000);

    const TCKCOD = await ticketingServices.createTicket({
      TITLE: body.TITLE,
      DESCR,
      SRVID: body.SRVID,
      PRIID: body.PRIID ?? null,
      ASGUSR: null,
      CREUSR: ctx.USRID,
    });
    if (!TCKCOD) throw new Error("DB_QUERY_ERROR");

    const created = await ticketingServices.getTicket(ctx.USRID, TCKCOD);
    const TCKID = created?.[0]?.TCKID;
    if (!TCKID) throw new Error("DB_QUERY_ERROR");

    await services.completeTicket(FTKID, TCKID, TCKCOD);

    if (body.CCAUTHORS) {
      const authors = [post.CREUSR, answer?.CREUSR]
        .map(Number)
        .filter((id) => id && id !== ctx.USRID);
      if (authors.length) {
        await ticketingServices
          .setTicketCc({ TCKID, USRIDS: [...new Set(authors)], CREUSR: ctx.USRID })
          .catch((err) =>
            logger.warn(`[FAQ][TICKET] Copie des auteurs impossible (${TCKCOD}) : ${err.message}`),
          );
      }
    }

    // La suggestion est prise en charge : Nouvelle / En étude → Planifiée.
    await services.moveStatus(pstid, "PLANNED", ["NEW", "UNDER_REVIEW"]);

    emit("ticket.created", { TCKID, TCKCOD, SRVID: body.SRVID });
    emit("faq.post.updated", { PSTID: pstid });

    return { TICKET: { TCKID, TCKCOD } };
  } catch (err) {
    await services.releaseTicket(FTKID).catch(() => {});
    throw err;
  }
}

/* ─────────────────────────────────────────────
   Réponses
───────────────────────────────────────────── */

async function loadAnswerForAction(ctx, ANSID) {
  const answer = await services.getAnswerRaw(ANSID);
  if (!answer) throw new Error("DATA_NOT_FOUND");
  // Vérifie aussi que la publication est visible pour l'utilisateur.
  await loadVisiblePost(ctx, answer.PSTID);
  return answer;
}

export async function createAnswer(req) {
  const ctx = await utils.getUserContext(req);
  const { PSTID, BODY } = await params(req, v.answerCreateSchema);

  const post = await loadVisiblePost(ctx, PSTID);
  if (post.DLTD) throw new Error("ACCESS_DENIED_WO_LOGOUT");

  const ANSID = await services.createAnswer({ PSTID, BODY, CREUSR: ctx.USRID });
  if (!ANSID) throw new Error("DB_QUERY_ERROR");

  // Première réponse d'un tiers à une question ouverte → « Répondue ».
  if (post.TYPE === "QUESTION" && Number(post.CREUSR) !== ctx.USRID) {
    await services.moveStatus(PSTID, "ANSWERED", ["OPEN"]);
  }

  emit("faq.answer.created", { PSTID, ANSID });

  void services.getParticipantEmails(PSTID, ctx.USRID).then((emails) =>
    notifyFaqEvent({
      to: emails,
      subject: `[FAQ] Nouvelle réponse : ${post.TITLE}`,
      title: "Nouvelle réponse",
      message: `${ctx.USRNAM || "Un utilisateur"} a répondu à une discussion que vous suivez.`,
      post,
      answer: { BODY },
      reason: "Vous recevez ce message car vous participez à cette discussion.",
    }),
  );

  // NEWANSID : permet au front d'envoyer ensuite les pièces jointes de la
  // réponse (ENTITYID = ANSID).
  return { ...(await buildPost(ctx, PSTID)), NEWANSID: ANSID };
}

export async function updateAnswer(req) {
  const ctx = await utils.getUserContext(req);
  const { ansid } = await params(req, v.ansidParamSchema);
  const { BODY } = await params(req, v.answerUpdateSchema);

  const answer = await loadAnswerForAction(ctx, ansid);
  const isAuthor = Number(answer.CREUSR) === ctx.USRID;
  if (!ctx.ISMOD && (!isAuthor || answer.VALIDATED)) {
    throw new Error("ACCESS_DENIED_WO_LOGOUT");
  }

  await services.updateAnswer(ansid, BODY);
  emit("faq.answer.updated", { PSTID: answer.PSTID, ANSID: ansid });
  return buildPost(ctx, answer.PSTID);
}

export async function validateAnswer(req) {
  const ctx = await utils.getUserContext(req);
  assertModerator(ctx);
  const { ansid } = await params(req, v.ansidParamSchema);
  const { VALIDATED, BODY } = await params(req, v.answerValidateSchema);

  const answer = await loadAnswerForAction(ctx, ansid);
  if (answer.PSTTYPE !== "QUESTION") throw new Error("FAQ_VALIDATION_NOT_ALLOWED");
  if (answer.DLTD) throw new Error("FAQ_VALIDATION_NOT_ALLOWED");

  // Reformulation éventuelle par le modérateur au moment de la validation.
  if (VALIDATED && BODY && BODY !== answer.BODY) {
    await services.updateAnswer(ansid, BODY);
  }
  await services.validateAnswer(ansid, VALIDATED, ctx.USRID);

  if (VALIDATED) {
    await services.moveStatus(answer.PSTID, "RESOLVED", ["OPEN", "ANSWERED"]);
  } else if ((await services.countValidatedAnswers(answer.PSTID)) === 0) {
    await services.moveStatus(answer.PSTID, "ANSWERED", ["RESOLVED"]);
  }

  emit("faq.answer.validated", { PSTID: answer.PSTID, ANSID: ansid, VALIDATED });

  if (VALIDATED) {
    const post = await services.getPostRaw(answer.PSTID);
    const emails = await services
      .getParticipantEmails(answer.PSTID, ctx.USRID)
      .catch(() => []);
    void notifyFaqEvent({
      to: emails,
      subject: `[FAQ] Bonne réponse retenue : ${post.TITLE}`,
      title: "Bonne réponse retenue",
      message:
        "Un modérateur a retenu une réponse : elle est désormais visible dans la base de connaissance.",
      post,
      answer: { BODY: BODY ?? answer.BODY },
      reason: "Vous recevez ce message car vous participez à cette discussion.",
    });
  }

  return buildPost(ctx, answer.PSTID);
}

export async function likeAnswer(req) {
  const ctx = await utils.getUserContext(req);
  const { ansid } = await params(req, v.ansidParamSchema);
  const { LIKED } = await params(req, v.answerLikeSchema);

  const answer = await loadAnswerForAction(ctx, ansid);
  if (answer.DLTD) throw new Error("DATA_NOT_FOUND");

  await services.setAnswerLike(ansid, ctx.USRID, LIKED);
  emit("faq.answer.liked", { PSTID: answer.PSTID, ANSID: ansid });
  return { ANSID: ansid, LIKED };
}

export async function getAnswerLikers(req) {
  const ctx = await utils.getUserContext(req);
  const { ansid } = await params(req, v.ansidParamSchema);
  await loadAnswerForAction(ctx, ansid);
  return services.getAnswerLikers(ansid);
}

export async function deleteAnswer(req) {
  const ctx = await utils.getUserContext(req);
  const { ansid } = await params(req, v.ansidParamSchema);
  const { DLTD, PERM } = await params(req, v.answerDeleteSchema);

  const answer = await loadAnswerForAction(ctx, ansid);
  const isAuthor = Number(answer.CREUSR) === ctx.USRID;

  if (PERM || !DLTD) assertModerator(ctx);
  else if (!ctx.ISMOD && (!isAuthor || answer.VALIDATED)) {
    throw new Error("ACCESS_DENIED_WO_LOGOUT");
  }

  if (PERM) {
    await services.deleteAnswerPermanently(ansid);
    await services
      .deleteAttachments(services.ATTACHMENT_TYPES.ANSWER, [ansid])
      .catch((err) =>
        logger.warn(`[FAQ][PJ] Nettoyage des pièces jointes de la réponse #${ansid} : ${err.message}`),
      );
  } else await services.setAnswerDeleted(ansid, DLTD);

  // Une bonne réponse masquée ne compte plus : statut recalculé.
  if (answer.VALIDATED && (PERM || DLTD)) {
    if ((await services.countValidatedAnswers(answer.PSTID)) === 0) {
      await services.moveStatus(answer.PSTID, "ANSWERED", ["RESOLVED"]);
    }
  }

  emit(DLTD || PERM ? "faq.answer.deleted" : "faq.answer.restored", {
    PSTID: answer.PSTID,
    ANSID: ansid,
  });
  return { ANSID: ansid, DLTD, PERM };
}

/* ─────────────────────────────────────────────
   Base de connaissance & statistiques
───────────────────────────────────────────── */

/**
 * Questions résolues (au moins une bonne réponse), avec leurs seules
 * réponses validées.
 */
export async function getKnowledgeBase(req) {
  const ctx = await utils.getUserContext(req);
  const rows = (
    await services.getPosts(ctx, { TYPE: "QUESTION", DLTD: false })
  ).filter((row) => row.VALIDATEDCOUNT > 0);

  const answers = await services.getAnswers(
    { ...ctx, ISMOD: false },
    rows.map((r) => r.PSTID),
    { onlyValidated: true },
  );

  return (await attachFiles(utils.attachAnswers(rows, answers))).sort(
      (a, b) =>
        Number(b.PINNED) - Number(a.PINNED) ||
        b.VIEWS - a.VIEWS ||
        new Date(b.CREDAT).getTime() - new Date(a.CREDAT).getTime(),
    );
}

export async function getStats(req) {
  const ctx = await utils.getUserContext(req);
  return utils.formatStats(await services.getStats(ctx));
}
