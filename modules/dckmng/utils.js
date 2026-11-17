/* ─────────────────────────────────────────────
   DCKMNG — Utilitaires (formatage, contexte de requête)
───────────────────────────────────────────── */

/**
 * Heure de Paris, quel que soit le fuseau du serveur SQL. Toutes les dates
 * du module (jour du chargement, heure d'ajout, prise en charge, fin) en
 * dépendent : « aujourd'hui » est donc le même pour l'API, la base et les
 * caristes.
 */
export const SQL_NOW_PARIS =
  "CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'Romance Standard Time' AS DATETIME2(0))";

/**
 * Heure (Paris) à laquelle commence la journée de travail : entre minuit et
 * cette heure, « aujourd'hui » reste la veille (équipe de nuit, écrans des
 * quais allumés en permanence qui basculent à 3 h). Doit correspondre à
 * DAY_START_HOUR du front (dckmng/src/app/config.ts).
 */
export const DAY_START_HOUR = Math.min(
  23,
  Math.max(0, parseInt(process.env.DCKMNG_DAY_START_HOUR ?? "3", 10) || 0),
);

/** Jour de travail d'un instant SQL (DATETIME2, heure de Paris). */
export const SQL_WORKDAY = (nowExpr) => `CAST(DATEADD(HOUR, -${DAY_START_HOUR}, ${nowExpr}) AS DATE)`;

/** Jour de travail en cours (cf. DAY_START_HOUR). */
export const SQL_TODAY_PARIS = SQL_WORKDAY(SQL_NOW_PARIS);

/** Champs modifiables par source (liste blanche des colonnes SQL). */
export const EDITABLE_FIELDS = {
  ADMIN: ["NOM", "QUAI", "QUAEFF", "OPEDEB", "OPEFIN"],
  CARISTE: ["QUAEFF", "OPEDEB", "OPEFIN"],
};

/** Adresse IP de l'appelant, sans le préfixe IPv4-mappé (::ffff:). */
export function clientIp(req) {
  const raw =
    req.ip || req.headers?.["x-forwarded-for"]?.split(",")[0] || req.socket?.remoteAddress || "";
  return String(raw).replace(/^::ffff:/, "").slice(0, 45) || null;
}

/** Chargement tel que renvoyé au front. */
export function formatLoad(row) {
  return {
    LODID: row.LODID,
    LODDAT: row.LODDAT,
    LODHOU: row.LODHOU,
    NOM: row.NOM,
    QUAI: row.QUAI ?? "",
    QUAEFF: row.QUAEFF ?? "",
    OPEDEB: row.OPEDEB ?? "",
    OPEFIN: row.OPEFIN ?? "",
    STSCOD: row.STSCOD,
    STSNAME: row.STSNAME,
    STSLVL: row.STSLVL,
    DEBDAT: row.DEBDAT ?? null,
    FINDAT: row.FINDAT ?? null,
    CREDAT: row.CREDAT ?? null,
    CREUSR: row.CREUSR ?? null,
    CRENAM: row.CRENAM ?? null,
    UPDDAT: row.UPDDAT ?? null,
  };
}

export function formatChange(row) {
  return {
    CHGID: row.CHGID,
    LODID: row.LODID,
    ACTION: row.ACTION,
    FIELD: row.FIELD ?? null,
    OLDVAL: row.OLDVAL ?? null,
    NEWVAL: row.NEWVAL ?? null,
    SOURCE: row.SOURCE,
    USRID: row.USRID ?? null,
    USRNAM: row.USRNAM ?? null,
    IPADDR: row.IPADDR ?? null,
    CREDAT: row.CREDAT,
  };
}

/** Liste des jours de [from, to] au format AAAA-MM-JJ (366 au plus). */
export function daysBetween(from, to) {
  const days = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end && days.length < 367) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}
