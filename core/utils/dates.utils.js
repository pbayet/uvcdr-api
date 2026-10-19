/**
 * Convertit une date UTC en ISO Europe/Paris avec offset (+01:00 / +02:00)
 * Exemple : "2025-01-11T10:20:00+01:00"
 */
export function utcToParisIso(input) {
  if (!input) return null;

  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return null;

  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = dtf.formatToParts(d).reduce((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});

  const {
    year: yyyy,
    month: mm,
    day: dd,
    hour: HH,
    minute: MM,
    second: SS,
  } = parts;

  const asIfUtc = Date.UTC(
    Number(yyyy),
    Number(mm) - 1,
    Number(dd),
    Number(HH),
    Number(MM),
    Number(SS),
  );

  const offsetMinutes = Math.round((asIfUtc - d.getTime()) / 60000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offH = String(Math.floor(abs / 60)).padStart(2, "0");
  const offM = String(abs % 60).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}${sign}${offH}:${offM}`;
}
