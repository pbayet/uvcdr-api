import * as requestUtils from "../../core/utils/request.utils.js";
import * as usersmanagerServices from "../usersmanager/services.js";
import * as usersmanagerUtils from "../usersmanager/utils.js";
import * as services from "./services.js";

/* ─────────────────────────────────────────────
   Droits
───────────────────────────────────────────── */

/**
 * Profils "gestionnaires" globaux (PRMNAM ∈ MODIFY_PERMS, cf. .env) : ils
 * sont modérateurs de fait et seuls à pouvoir désigner/retirer des
 * modérateurs. Même convention que modules/files/utils.js.
 */
export function isManagerPermission(permission) {
  const managers = (process.env.MODIFY_PERMS || "")
    .split(",")
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);

  return managers.includes(String(permission || "").toUpperCase());
}

/**
 * Codes des applications auxquelles l'utilisateur a accès (permissions
 * usersmanager, PRMLVL ≠ -1) — conditionne la visibilité des publications
 * rattachées à une application. Mis en cache 5 minutes.
 */
async function getUserAppCodes(USRID) {
  return requestUtils.getCachedResult(
    `faq.appcodes.${USRID}`,
    async () => {
      try {
        const users = await usersmanagerUtils.formatUsers(
          await usersmanagerServices.getUserById(USRID),
        );
        return [
          ...new Set(
            (users[0]?.PERMISSIONS ?? [])
              .filter(
                (p) =>
                  p?.APPCOD &&
                  Number(p?.PERMISSION?.PRMLVL ?? p?.PRMLVL) !== -1,
              )
              .map((p) => p.APPCOD),
          ),
        ];
      } catch {
        return [];
      }
    },
    5 * 60 * 1000,
  );
}

/**
 * Contexte de l'utilisateur courant : identifiant, statut de modération
 * (modérateur désigné OU gestionnaire global) et applications accessibles.
 */
export async function getUserContext(req) {
  const USRID = Number(req?.payload?.data?.id);
  if (!USRID) throw new Error("INVALID_TOKEN");

  const ISMANAGER = isManagerPermission(req?.payload?.permission);
  const ISMOD = ISMANAGER || (await services.isModerator(USRID));
  const APPCODS = ISMOD ? [] : await getUserAppCodes(USRID);

  return {
    USRID,
    ISMOD,
    ISMANAGER,
    APPCODS,
    USRNAM:
      `${req?.payload?.data?.FirstName ?? ""} ${req?.payload?.data?.LastName ?? ""}`.trim(),
  };
}

export async function getAllowedAppCodes(ctx) {
  return ctx.ISMOD ? null : getUserAppCodes(ctx.USRID);
}

/* ─────────────────────────────────────────────
   Formatage (cf. entities/faq côté front)
───────────────────────────────────────────── */

export function formatAnswer(row) {
  return {
    ANSID: row.ANSID,
    PSTID: row.PSTID,
    BODY: row.BODY ?? "",
    CREUSR: row.CREUSR,
    USRNAM: row.USRNAM ?? `Utilisateur #${row.CREUSR}`,
    CREDAT: row.CREDAT,
    UPDDAT: row.UPDDAT,
    VALIDATED: !!row.VALIDATED,
    VALDBY: row.VALDBY ?? null,
    VALDBYNAM: row.VALDBYNAM ?? "",
    VALDAT: row.VALDAT ?? null,
    DLTD: !!row.DLTD,
    LIKECOUNT: row.LIKECOUNT ?? 0,
    LIKED: !!row.LIKED,
    TICKET: row.TCKID ? { TCKID: row.TCKID, TCKCOD: row.TCKCOD } : null,
  };
}

export function formatPost(row, answers = undefined) {
  return {
    PSTID: row.PSTID,
    TYPE: row.TYPE,
    TITLE: row.TITLE,
    BODY: row.BODY,
    CAT: row.CATID ? { CATID: row.CATID, NAME: row.CATNAME } : null,
    APP: row.APPID
      ? { APPID: row.APPID, APPNAM: row.APPNAM ?? "", APPCOD: row.APPCOD ?? "" }
      : null,
    STS: row.STSID
      ? {
          STSID: row.STSID,
          CODE: row.STSCODE,
          NAME: row.STSNAME,
          LVL: row.STSLVL ?? 0,
        }
      : null,
    CREUSR: row.CREUSR,
    USRNAM: row.USRNAM ?? `Utilisateur #${row.CREUSR}`,
    CREDAT: row.CREDAT,
    UPDDAT: row.UPDDAT,
    LASTACTIVITY: row.LASTANSDAT ?? row.UPDDAT ?? row.CREDAT,
    /** Date de la première bonne réponse retenue (null si aucune). */
    FIRSTVALDAT: row.FIRSTVALDAT ?? null,
    PINNED: !!row.PINNED,
    VIEWS: row.VIEWS ?? 0,
    DLTD: !!row.DLTD,
    ANSWERCOUNT: row.ANSWERCOUNT ?? 0,
    VALIDATEDCOUNT: row.VALIDATEDCOUNT ?? 0,
    LIKECOUNT: row.LIKECOUNT ?? 0,
    KEYWORDS: row.KEYWORDS ? String(row.KEYWORDS).split("|") : [],
    TICKET: row.TCKID ? { TCKID: row.TCKID, TCKCOD: row.TCKCOD } : null,
    ...(answers ? { ANSWERS: answers.map(formatAnswer) } : {}),
  };
}

/** Pièce jointe (cf. entities/attachment/Attachment.class côté front). */
export function formatAttachment(row) {
  return {
    ID: row.ID,
    FILECODE: row.FILECODE,
    APPCODE: row.APPCODE,
    ENTITYTYPE: row.ENTITYTYPE,
    ENTITYID: row.ENTITYID,
    ORIGINALNAME: row.ORIGINALNAME,
    STOREDNAME: row.STOREDNAME,
    RELATIVEPATH: row.RELATIVEPATH,
    MIMETYPE: row.MIMETYPE,
    EXTENSION: row.EXTENSION,
    COMPRESSED: !!row.COMPRESSED,
    ORIGINALSIZEBYTES: Number(row.ORIGINALSIZEBYTES),
    SIZEBYTES: Number(row.SIZEBYTES),
    STATUS: row.STATUS,
    UPLOADEDBY: row.UPLOADEDBY,
    CREATEDAT: row.CREATEDAT,
  };
}

/** Regroupe des pièces jointes par ENTITYID (PSTID / ANSID). */
export function groupAttachments(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = String(row.ENTITYID);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(formatAttachment(row));
  }
  return map;
}

/** Rattache à chaque publication ses réponses (une seule requête). */
export function attachAnswers(rows, answerRows) {
  const byPost = new Map();
  for (const answer of answerRows) {
    if (!byPost.has(answer.PSTID)) byPost.set(answer.PSTID, []);
    byPost.get(answer.PSTID).push(answer);
  }
  return rows.map((row) => formatPost(row, byPost.get(row.PSTID) ?? []));
}

/** Normalise une liste de mots-clés (minuscules, sans doublons). */
export function normalizeKeywords(keywords) {
  return [
    ...new Set(
      keywords
        .map((k) => k.trim().toLowerCase().replace(/\s+/g, " "))
        .filter((k) => k.length > 0 && k.length <= 50),
    ),
  ];
}

export function formatStats([
  totals = [],
  statuses = [],
  categories = [],
  applications = [],
  contributors = [],
  activity = [],
  mostViewed = [],
]) {
  const t = totals[0] ?? {};
  const questions = t.QUESTIONS ?? 0;
  return {
    TOTALS: {
      QUESTIONS: questions,
      SUGGESTIONS: t.SUGGESTIONS ?? 0,
      RESOLVED: t.RESOLVED ?? 0,
      RESOLUTIONRATE: questions ? (t.RESOLVED ?? 0) / questions : 0,
      UNANSWERED: t.UNANSWERED ?? 0,
      ANSWERS: t.ANSWERS ?? 0,
      LIKES: t.LIKES ?? 0,
      VIEWS: Number(t.VIEWS ?? 0),
      TICKETS: t.TICKETS ?? 0,
      AVGFIRSTANSWERHOURS:
        t.AVGFIRSTANSWERHOURS == null
          ? null
          : Math.round(t.AVGFIRSTANSWERHOURS * 10) / 10,
    },
    STATUSES: statuses,
    CATEGORIES: categories,
    APPLICATIONS: applications,
    CONTRIBUTORS: contributors,
    ACTIVITY: activity,
    MOSTVIEWED: mostViewed,
  };
}
