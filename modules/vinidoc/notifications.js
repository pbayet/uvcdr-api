import { sendTemplatedMail, renderDetailsList } from "../../core/services/mail.service.js";
import { logger } from "../../config/logger.config.js";

/* ─────────────────────────────────────────────
   VINIDOC — Notifications mail du workflow de validation
     - soumission  → équipe marketing (VINIDOC_MARKETING_EMAIL)
     - validation  → soumissionnaire (SHEETS.SUBUSR)
     - refus       → soumissionnaire, avec le motif
   Comme ticketing/declcav : hors production, tout part vers
   BASE_RECIPIENT_EMAIL (le vrai destinataire est indiqué dans l'objet).
   Best-effort : un échec d'envoi est loggé, jamais propagé à l'action métier.
───────────────────────────────────────────── */

const IS_PROD = process.env.NODE_ENV === "production";
const APP_NAME = "VINIDOC";

const appUrl = () =>
  process.env.VINIDOC_APP_URL || `${process.env.DOMAIN ?? ""}/vinidoc`;

const sheetLabel = (s) => [s.CODVRAC, s.MILLESIME].filter(Boolean).join(" — ");

function details(sheet, extra = []) {
  return renderDetailsList([
    { label: "Code vrac", value: sheet.CODVRAC },
    { label: "Millésime", value: sheet.MILLESIME ?? "Non millésimé" },
    { label: "Appellation", value: sheet.APPELL },
    { label: "Couleur", value: sheet.COLCOD },
    { label: "Langues", value: Object.keys(sheet.TRANSLATIONS ?? {}).join(", ").toUpperCase() },
    ...extra,
  ]);
}

async function send({ to, template, subject, data }) {
  const recipient = IS_PROD ? to : process.env.BASE_RECIPIENT_EMAIL;
  if (!recipient) {
    logger.warn(`[VINIDOC][MAIL] Aucun destinataire pour "${subject}" — envoi ignoré.`);
    return;
  }
  try {
    await sendTemplatedMail({
      template,
      to: recipient,
      subject: IS_PROD ? subject : `[TEST → ${to || "?"}] ${subject}`,
      data: { APP_NAME, ACTION_URL: appUrl(), ...data },
    });
  } catch (err) {
    logger.error(`[VINIDOC][MAIL] Échec envoi "${subject}" : ${err.message}`);
  }
}

export function notifySubmitted(sheet, actorName) {
  return send({
    to: process.env.VINIDOC_MARKETING_EMAIL,
    template: "validation",
    subject: `Fiche œnologique à valider : ${sheetLabel(sheet)}`,
    data: {
      TITLE: "Fiche œnologique à valider",
      MESSAGE: `${actorName} a soumis la fiche ${sheetLabel(sheet)} à la validation du marketing.`,
      DETAILS_ROWS_HTML: details(sheet),
      ACTION_LABEL: "Ouvrir VINIDOC",
    },
  });
}

/** Soumission en masse : un seul mail récapitulant les fiches soumises. */
export function notifySubmittedBatch(sheets, actorName) {
  if (sheets.length === 1) return notifySubmitted(sheets[0], actorName);
  return send({
    to: process.env.VINIDOC_MARKETING_EMAIL,
    template: "validation",
    subject: `${sheets.length} fiches œnologiques à valider`,
    data: {
      TITLE: "Fiches œnologiques à valider",
      MESSAGE: `${actorName} a soumis ${sheets.length} fiches à la validation du marketing.`,
      DETAILS_ROWS_HTML: renderDetailsList(
        sheets.map((s) => ({ label: sheetLabel(s), value: `${s.APPELL} — ${s.COLCOD}` })),
      ),
      ACTION_LABEL: "Ouvrir VINIDOC",
    },
  });
}

export function notifyValidated(sheet, VERNUM, actorName, comment) {
  return send({
    to: sheet.SUBUSR,
    template: "validation-approved",
    subject: `Fiche œnologique validée : ${sheetLabel(sheet)}`,
    data: {
      TITLE: "Fiche validée",
      MESSAGE: `${actorName} a validé la fiche ${sheetLabel(sheet)} (version ${VERNUM}). Elle est désormais utilisable pour générer les fiches techniques.`,
      DETAILS_ROWS_HTML: details(sheet, comment ? [{ label: "Commentaire", value: comment }] : []),
      ACTION_LABEL: "Ouvrir VINIDOC",
    },
  });
}

export function notifyRejected(sheet, actorName, reason) {
  return send({
    to: sheet.SUBUSR,
    template: "validation-rejected",
    subject: `Fiche œnologique refusée : ${sheetLabel(sheet)}`,
    data: {
      TITLE: "Fiche refusée",
      MESSAGE: `${actorName} a refusé la fiche ${sheetLabel(sheet)}. Corrigez-la puis soumettez-la de nouveau.`,
      REASON: reason,
      DETAILS_ROWS_HTML: details(sheet),
      ACTION_LABEL: "Ouvrir VINIDOC",
    },
  });
}
