import * as services from "./services.js";
import * as v from "./validators.js";
import * as realtime from "./realtime.js";
import { formatLoad, formatChange, clientIp, daysBetween } from "./utils.js";
import * as requestUtils from "../../core/utils/request.utils.js";

/* ─────────────────────────────────────────────
   DCKMNG — Controllers (Dock Manager)
   Responsabilité : valider les paramètres (zod), contrôler les droits,
   appeler le service, formater la réponse, notifier (temps réel).

   Deux espaces :
     - ADMIN (authentifié, authVerifyMiddleware) : création / modification /
       suppression des chargements, historique, statistiques. Réservé aux
       jetons des applications DCKMNG_APPCODES (défaut : DCKMNG) — un jeton
       du portail (HOME) passe authVerifyMiddleware sans contrôle de
       permission, il est donc refusé ici.
     - CARISTE (public, sans connexion) : lecture des chargements du jour et
       saisie de QUAEFF / OPEDEB / OPEFIN, uniquement sur les chargements du
       jour. Chaque saisie est historisée avec l'adresse IP.
───────────────────────────────────────────── */

const ALLOWED_APPCODES = (process.env.DCKMNG_APPCODES || "DCKMNG")
  .split(",")
  .map((a) => a.trim().toUpperCase())
  .filter(Boolean);

async function params(req, schema) {
  return schema.parse((await requestUtils.getRequestParams(req)).params);
}

/** Contexte de l'utilisateur admin connecté (lève ACCESS_DENIED sinon). */
function adminContext(req) {
  const payload = req.payload;
  const app = String(payload?.application || "").toUpperCase();
  if (!ALLOWED_APPCODES.includes(app)) throw new Error("ACCESS_DENIED_WO_LOGOUT");

  const USRID = parseInt(payload?.data?.id, 10) || null;
  return { SOURCE: "ADMIN", USRID, IPADDR: clientIp(req) };
}

function caristeContext(req) {
  return { SOURCE: "CARISTE", USRID: null, IPADDR: clientIp(req) };
}

async function loadOrFail(LODID) {
  const load = await services.getLoad(LODID);
  if (!load) throw new Error("DCKMNG_LOAD_NOT_FOUND");
  return load;
}

function assertUpdated(result) {
  if (result === "NOT_FOUND") throw new Error("DCKMNG_LOAD_NOT_FOUND");
  if (result === "LOCKED") throw new Error("DCKMNG_LOAD_LOCKED");
}

/* -------------------------------------------------------------------------- */
/*                              ESPACE CARISTE                                */
/* -------------------------------------------------------------------------- */

/** GET /public/loads — chargements du jour. */
export async function getPublicLoads() {
  const { LODDAT, TODAY, rows } = await services.getLoads();
  return { LODDAT, TODAY, rows: rows.map(formatLoad) };
}

/** PATCH /public/loads/:LODID — saisie cariste (quai effectif, opérateurs). */
export async function updatePublicLoad(req) {
  const { LODID, ...fields } = await params(req, v.publicLoadUpdate);
  const result = await services.updateLoad(LODID, fields, caristeContext(req), {
    onlyToday: true,
  });
  assertUpdated(result);

  const load = await loadOrFail(LODID);
  await realtime.publish(load.LODDAT);
  return formatLoad(load);
}

/** GET /public/events — flux SSE des chargements du jour. */
export async function subscribePublicLoads(req, res) {
  await realtime.subscribe(req, res);
}

/* -------------------------------------------------------------------------- */
/*                               ESPACE ADMIN                                 */
/* -------------------------------------------------------------------------- */

/** GET /statuses */
export async function getStatuses(req) {
  adminContext(req);
  return services.getStatuses();
}

/** GET /loads?LODDAT= — chargements d'un jour (aujourd'hui par défaut). */
export async function getLoads(req) {
  adminContext(req);
  const { LODDAT } = await params(req, v.loadsQuery);
  const result = await services.getLoads({ LODDAT });
  return { LODDAT: result.LODDAT, TODAY: result.TODAY, rows: result.rows.map(formatLoad) };
}

/** POST /loads — nouveau chargement (aujourd'hui). */
export async function createLoad(req) {
  const ctx = adminContext(req);
  const data = await params(req, v.loadCreate);
  const LODID = await services.createLoad(data, ctx);

  const load = await loadOrFail(LODID);
  await realtime.publish(load.LODDAT);
  return formatLoad(load);
}

/** PUT /loads/:LODID — modification (admin : tous les champs, tout jour). */
export async function updateLoad(req) {
  const ctx = adminContext(req);
  const { LODID, ...fields } = await params(req, v.loadUpdate);
  assertUpdated(await services.updateLoad(LODID, fields, ctx));

  const load = await loadOrFail(LODID);
  await realtime.publish(load.LODDAT);
  return formatLoad(load);
}

/** DELETE /loads/:LODID — suppression logique. */
export async function deleteLoad(req) {
  const ctx = adminContext(req);
  const { LODID } = await params(req, v.loadId);
  const load = await loadOrFail(LODID);

  if (!(await services.deleteLoad(LODID, ctx))) throw new Error("DCKMNG_LOAD_NOT_FOUND");
  await realtime.publish(load.LODDAT);
  return { LODID };
}

/** GET /loads/:LODID/changes — historique. */
export async function getChanges(req) {
  adminContext(req);
  const { LODID } = await params(req, v.loadId);
  const load = await services.getLoad(LODID, { includeDeleted: true });
  if (!load) throw new Error("DCKMNG_LOAD_NOT_FOUND");
  return (await services.getChanges(LODID)).map(formatChange);
}

/** GET /days — jours ayant au moins un chargement ("AAAA-MM-JJ", ordre croissant). */
export async function getLoadDays(req) {
  adminContext(req);
  return services.getLoadDays();
}

/** GET /stats?FROM=&TO= — statistiques (7 derniers jours par défaut). */
export async function getStats(req) {
  adminContext(req);
  const range = await params(req, v.statsQuery);
  const stats = await services.getStats(range);

  const { FROM, TO } = stats.range;
  const dayMap = new Map(stats.byDay.map((d) => [d.DATE, d]));
  const round = (n) => (n == null ? null : Math.round(n * 10) / 10);

  return {
    FROM,
    TO,
    TOTALALL: stats.totalsAll.TOTALALL,
    TOTALDONE: stats.totalsAll.TOTALDONE,
    TOTAL: stats.totals.TOTAL,
    DONE: stats.totals.DONE,
    INPROGRESS: stats.totals.INPROGRESS,
    WAITING: stats.totals.WAITING,
    AVGWAITMIN: round(stats.totals.AVGWAITMIN),
    AVGLOADMIN: round(stats.totals.AVGLOADMIN),
    // Un point par jour de la plage, jours sans chargement compris.
    BYDAY: daysBetween(FROM, TO).map((DATE) => ({
      DATE,
      TOTAL: dayMap.get(DATE)?.TOTAL ?? 0,
      DONE: dayMap.get(DATE)?.DONE ?? 0,
      INPROGRESS: dayMap.get(DATE)?.INPROGRESS ?? 0,
      WAITING: dayMap.get(DATE)?.WAITING ?? 0,
    })),
    BYQUAI: stats.byQuai,
    BYHOUR: stats.byHour,
    BYOPERATOR: stats.byOperator,
  };
}
