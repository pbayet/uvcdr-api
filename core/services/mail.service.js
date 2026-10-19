import nodemailer from "nodemailer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import { logger } from "../../config/logger.config.js";
import { runQuery } from "../utils/db.utils.js";

/**
 * Service mail générique, appelable directement depuis n'importe quel
 * module (ex: ticketing, usersmanager) via un simple import JS.
 *
 * Volontairement pas de route HTTP exposée : en V1.0.0, GET /emails/send
 * envoyait un email arbitraire (destinataire/template/contenu) sans
 * authentification, avec les paramètres dans une query string (cf. audit
 * sécurité). Si un module a besoin d'un déclencheur HTTP, il doit exposer
 * sa propre route authentifiée qui appelle ce service en interne.
 *
 * Configuration SMTP (mêmes variables que V1.0.0) via config/env/*.env :
 *   HOST        - hôte du relais SMTP
 *   EMAIL_USER  - utilisateur SMTP
 *   EMAIL_PASS  - mot de passe SMTP
 *   EMAIL_PORT  - port SMTP (optionnel, défaut 25)
 *   EMAIL_FROM  - adresse d'expédition (optionnel, défaut noreply@union-vignerons.com)
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, "mail-templates");

const DEFAULT_FROM = process.env.EMAIL_FROM || "noreply@union-vignerons.com";

let transporter = null;

/**
 * Crée (une seule fois) le transporter nodemailer. Lève MAIL_NOT_CONFIGURED
 * si les variables SMTP obligatoires ne sont pas renseignées, plutôt que de
 * planter au démarrage de l'API — le mail est une dépendance optionnelle
 * pour la plupart des modules.
 */
function getTransporter() {
  if (transporter) return transporter;

  if (!process.env.HOST) {
    throw new Error("MAIL_NOT_CONFIGURED");
  }

  transporter = nodemailer.createTransport({
    host: process.env.HOST,
    port: Number(process.env.EMAIL_PORT) || 25,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    tls: {
      rejectUnauthorized: false,
    },
  });

  return transporter;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Échappe les caractères HTML spéciaux. Appliqué par défaut à toute valeur
 * injectée dans un template (une valeur métier — titre de ticket, commentaire
 * utilisateur, etc. — ne doit jamais pouvoir casser la mise en page ou
 * injecter du HTML dans un email). Les clés qui se terminent par `_HTML`
 * (ex: DETAILS_ROWS_HTML, générée par renderDetailsList) sont considérées
 * comme du HTML de confiance déjà construit par le code appelant et ne sont
 * pas échappées.
 */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Remplace les placeholders {{CLE}} d'un template HTML par les valeurs de
 * `data` (espaces tolérés : {{ CLE }}). Les placeholders non renseignés dans
 * `data` sont retirés plutôt que laissés visibles tels quels dans l'email.
 *
 * Supporte aussi des blocs conditionnels non imbriqués :
 *   {{#if CLE}} ... {{/if}}
 * Le bloc est conservé (avec substitution normale à l'intérieur) si
 * `data[CLE]` est "truthy" (tableau non vide compris), sinon il est retiré
 * entièrement. Ces blocs ne peuvent PAS être imbriqués les uns dans les
 * autres — utiliser des blocs indépendants au même niveau si besoin.
 */
export function renderTemplate(rawHtml, data = {}) {
  let output = rawHtml.replace(
    /{{#if\s+([\w.]+)\s*}}([\s\S]*?){{\/if\s*}}/g,
    (_match, key, inner) => {
      const value = data[key];
      const truthy = Array.isArray(value) ? value.length > 0 : Boolean(value);
      return truthy ? inner : "";
    },
  );

  for (const key of Object.keys(data)) {
    const value = data[key];
    const replacement = key.endsWith("_HTML")
      ? String(value ?? "")
      : escapeHtml(value ?? "");
    const regex = new RegExp(`{{\\s*${escapeRegExp(key)}\\s*}}`, "g");
    output = output.replace(regex, replacement);
  }

  output = output
    .replace(/{{#if\s+[\w.]+\s*}}/g, "")
    .replace(/{{\/if\s*}}/g, "");
  output = output.replace(/{{\s*[\w.]+\s*}}/g, "");

  return output;
}

/**
 * Rendu en table HTML (et non en div `display: inline-block`) des paires
 * label/valeur d'un bloc "Détails".
 *
 * Pourquoi une table et pas des div inline-block : la majorité des clients
 * mail (Outlook desktop en particulier, et certains webmails) ne
 * supportent pas correctement `display: inline-block` / `box-sizing` sur
 * des div et peuvent appliquer le layout en deux passes — contenu d'abord
 * peint en bloc pleine largeur, puis réajusté une fois le CSS retraité.
 * Côté destinataire, ça se voit comme une zone "Détails" vide à
 * l'ouverture du mail, qui se peuple avec un léger retard. Les tables sont
 * en revanche interprétées correctement dès le premier rendu par tous les
 * clients mail, y compris Outlook — d'où leur usage ici malgré leur
 * lourdeur relative en HTML moderne.
 */
export function renderDetailsList(items = []) {
  const cells = items.map(
    ({ label, value }) => `
        <td
          valign="top"
          width="48%"
          style="
            padding: 12px 14px;
            background-color: #ffffff;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
          "
        >
          <p
            style="
              margin: 0 0 4px 0;
              font-size: 0.72em;
              font-weight: bold;
              text-transform: uppercase;
              letter-spacing: 0.04em;
              color: #64748b;
            "
          >
            ${escapeHtml(label)}
          </p>
          <p
            style="
              margin: 0;
              font-size: 0.95em;
              font-weight: bold;
              color: #1e293b;
              word-break: break-word;
            "
          >
            ${escapeHtml(value ?? "")}
          </p>
        </td>`,
  );

  const spacer = `<td width="4%" style="font-size: 0; line-height: 0;">&nbsp;</td>`;
  const emptyCell = `<td width="48%">&nbsp;</td>`;
  const rowGap = `<tr><td colspan="3" style="font-size: 0; line-height: 10px; height: 10px;">&nbsp;</td></tr>`;

  const rows = [];
  for (let i = 0; i < cells.length; i += 2) {
    if (rows.length > 0) rows.push(rowGap);
    rows.push(`<tr>${cells[i]}${spacer}${cells[i + 1] ?? emptyCell}</tr>`);
  }

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse; width: 100%;"><tbody>${rows.join("\n")}</tbody></table>`;
}
export function renderDetailGroups(groups = []) {
  return groups
    .map(({ title, items = [] }) => {
      const filtered = items.filter(
        (it) => it.value !== undefined && it.value !== null && it.value !== "",
      );
      if (!filtered.length) return "";
      return `
        <div style="margin: 0 0 18px 0;">
          <p
            style="
              margin: 0 0 8px 0;
              font-size: 0.72em;
              font-weight: bold;
              text-transform: uppercase;
              letter-spacing: 0.05em;
              color: #6b7280;
            "
          >
            ${escapeHtml(title)}
          </p>
          ${renderDetailsList(filtered)}
        </div>`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Construit le HTML d'une liste de contacts (`<li>Nom : email</li>`) à passer
 * dans `data.CONTACTS_HTML` (clé `..._HTML`, non ré-échappée par
 * renderTemplate). Permet d'afficher un ou plusieurs contacts dans l'encart
 * "Besoin d'aide ?" de chaque template.
 *
 * @param {Array<{name: string, email: string}>} contacts
 *
 * @example
 *   renderContactList([
 *     { name: "Alexandre VERGNES", email: "a.vergnes@union-vignerons.com" },
 *     { name: "Camille POTAUX", email: "c.potaux@union-vignerons.com" },
 *   ]);
 */
export function renderContactList(contacts = []) {
  return contacts
    .map(
      ({ name, email }) =>
        `<li style="margin: 0 0 6px 0;">${escapeHtml(name)} : <a href="mailto:${escapeHtml(email)}" style="color: #2563eb; text-decoration: underline;">${escapeHtml(email)}</a></li>`,
    )
    .join("\n");
}

/**
 * Construit le HTML d'une liste de dossiers/entités en attente à passer dans
 * `data.DOSSIERS_HTML` (clé `..._HTML`, non ré-échappée par renderTemplate).
 * Chaque dossier est affiché comme une ligne cliquable (badge + lien vers son
 * détail) plutôt qu'en simple texte, pour un scan rapide quand plusieurs
 * dossiers sont concernés par un même email (ex: relance groupée par
 * destinataire). Utilisé par fsa/reminder.html (cf. dailyRelaunch() dans
 * modules/fsa/controllers.js) ; réutilisable par tout autre module ayant le
 * même besoin (relance/synthèse portant sur plusieurs entités).
 *
 * @param {Array<{code: string, url?: string, label?: string}>} folders
 *
 * @example
 *   DOSSIERS_HTML: renderFolderList([
 *     { code: "FSA-000123", url: `${DOMAIN}/fsa/folders/FSA-000123/0` },
 *   ]);
 */
export function renderFolderList(folders = []) {
  return folders
    .filter((f) => f && f.code)
    .map(({ code, url, label }) => {
      const badge = `<span style="display: inline-block; padding: 3px 10px; border-radius: 4px; background-color: #f1f5f9; border: 1px solid #cbd5e1; font-family: 'Courier New', Courier, monospace; font-weight: bold; font-size: 0.9em; color: #1e293b;">${escapeHtml(code)}</span>`;
      const content = url
        ? `<a href="${escapeHtml(url)}" style="text-decoration: none;">${badge}</a>`
        : badge;
      const suffix = label
        ? ` <span style="color: #475569; font-size: 0.9em;">${escapeHtml(label)}</span>`
        : "";
      return `<li style="margin: 0 0 8px 0;">${content}${suffix}</li>`;
    })
    .join("\n");
}

/**
 * Construit le HTML d'une ou plusieurs notes/commentaires à passer dans
 * `data.NOTES_HTML` (clé `..._HTML`, non ré-échappée par renderTemplate).
 *
 * Une note peut contenir un texte long (plusieurs paragraphes) : contrairement
 * à un simple label/valeur de renderDetailsList() (pensé pour des valeurs
 * courtes affichées sur une ligne, ex. "Statut : Résolu"), chaque note est
 * affichée dans son propre bloc en citation — même traitement visuel que le
 * bloc "Description" des templates ticketing/*.html — avec l'auteur en
 * en-tête. Utilisé par ticketing/new-note.html (cf. scheduleNoteNotification
 * dans modules/ticketing/controllers.js).
 *
 * @param {Array<{author?: string, content: string}>} notes
 *
 * @example
 *   NOTES_HTML: renderNoteList([
 *     { author: "Jean Dupont", content: "Le problème persiste après le dernier correctif, ..." },
 *   ]);
 */
export function renderNoteList(notes = []) {
  return notes
    .filter((n) => n && n.content)
    .map(({ author, content }, idx, arr) => {
      const label =
        arr.length > 1
          ? `Note ${idx + 1}${author ? ` — ${author}` : ""}`
          : author
            ? `Note de ${author}`
            : "Note";
      return `<div style="margin: 0 0 14px 0;">
  <p style="margin: 0 0 6px 0; font-size: 0.72em; font-weight: bold; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b;">${escapeHtml(label)}</p>
  <div style="margin: 0; padding: 12px 16px; background-color: #f8fafc; border-left: 3px solid #94a3b8; border-radius: 0 4px 4px 0; font-size: 0.95em; font-style: italic; color: #334155; white-space: pre-line;">${escapeHtml(content)}</div>
</div>`;
    })
    .join("\n");
}

/**
 * Styles des encarts générés par renderNoticeList(), indexés par type.
 * Exporté pour permettre de réutiliser les mêmes couleurs ailleurs
 * (ex: rendu côté front d'un même type d'alerte) sans les dupliquer.
 */
export const NOTICE_STYLES = {
  error: {
    label: "Erreur",
    border: "#dc2626",
    background: "#fef2f2",
    color: "#7f1d1d",
  },
  warning: {
    label: "Avertissement",
    border: "#f59e0b",
    background: "#fffbeb",
    color: "#92400e",
  },
  success: {
    label: "Succès",
    border: "#16a34a",
    background: "#f0fdf4",
    color: "#14532d",
  },
  info: {
    label: "Information",
    border: "#2563eb",
    background: "#eff6ff",
    color: "#1e3a8a",
  },
};

/**
 * Construit le HTML d'un ou plusieurs encarts d'information complémentaire
 * (message d'erreur, avertissement, succès, information) à passer dans
 * `data.NOTICES_HTML` (clé `..._HTML`, non ré-échappée par renderTemplate).
 * Permet d'afficher, dans n'importe quel template, un ou plusieurs messages
 * additionnels indépendants du corps principal (MESSAGE) — par exemple le
 * détail d'une erreur technique survenue pendant un traitement, une mise en
 * garde, ou une confirmation secondaire.
 *
 * Chaque valeur (message, label, code) est échappée individuellement ;
 * seule la mise en forme (couleurs, structure) est injectée en HTML de
 * confiance.
 *
 * @param {Array<{
 *   type?: "error"|"warning"|"success"|"info", // défaut "info"
 *   message: string,
 *   label?: string,   // surcharge le libellé par défaut du type (ex: "Erreur")
 *   code?: string,    // code/référence technique optionnel, affiché en monospace
 * }>} notices
 *
 * @example
 *   NOTICES_HTML: renderNoticeList([
 *     { type: "error", message: "La synchronisation avec le service X a échoué.", code: "ERR_SYNC_TIMEOUT" },
 *     { type: "warning", message: "3 lignes ont été ignorées car incomplètes." },
 *   ]);
 */
export function renderNoticeList(notices = []) {
  return notices
    .map(({ type = "info", message, label, code }) => {
      const style = NOTICE_STYLES[type] || NOTICE_STYLES.info;
      const displayLabel = label ?? style.label;
      const codeHtml = code
        ? `<div style="margin-top: 8px; font-family: 'Courier New', Courier, monospace; font-size: 0.9em; padding: 8px 10px; border-radius: 6px; background: #ffffff; border: 1px solid ${style.border}; color: ${style.color}; word-break: break-word;">${escapeHtml(code)}</div>`
        : "";
      return `<div style="margin: 0 0 12px 0; padding: 14px 16px; border-radius: 8px; border-left: 4px solid ${style.border}; background: ${style.background}; color: #111111;">
  <p style="margin: 0 0 6px 0; font-weight: bold; color: ${style.color};">${escapeHtml(displayLabel)}</p>
  <p style="margin: 0; white-space: pre-line;">${escapeHtml(message ?? "")}</p>${codeHtml}
</div>`;
    })
    .join("\n");
}

/**
 * Extrait les adresses email d'un champ destinataire nodemailer : chaîne
 * (éventuellement "a@x, b@y" ou "Nom <a@x>"), objet { address } ou tableau
 * de ceux-ci. Renvoie des adresses en minuscules, sans doublon.
 */
function extractAddresses(field) {
  if (!field) return [];

  const items = Array.isArray(field) ? field : [field];
  const addresses = items.flatMap((item) => {
    if (item && typeof item === "object") return [item.address];
    return String(item).split(/[,;]/);
  });

  return [
    ...new Set(
      addresses
        .map((a) => {
          const value = String(a ?? "").trim();
          const match = value.match(/<([^>]+)>/);
          return (match ? match[1] : value).trim().toLowerCase();
        })
        .filter((a) => a.includes("@")),
    ),
  ];
}

/**
 * Copies mails (USERSMANAGER.dbo.USRMAILCPY, cf.
 * modules/usersmanager/sql/USRMAILCPY.table.sql) : renvoie les adresses des
 * utilisateurs actifs qui suivent les mails d'au moins un des destinataires,
 * hors destinataires déjà présents. Un seul niveau, pas de propagation.
 *
 * Best effort : une erreur (BDD indisponible, table absente...) est
 * journalisée et n'empêche jamais l'envoi du mail d'origine.
 */
async function getMailCopyRecipients(recipients) {
  if (recipients.length === 0) return [];

  try {
    const result = await runQuery({
      moduleUrl: import.meta.url,
      dbConnectionName: "usersmanager",
      query: `
      SELECT DISTINCT LOWER(LTRIM(RTRIM(cu.EMAIL))) AS EMAIL
      FROM dbo.USRMAILCPY mc
      JOIN dbo.USERS su ON su.USRID = mc.SRCUSRID
      JOIN dbo.USERS cu ON cu.USRID = mc.USRID
      WHERE LOWER(LTRIM(RTRIM(su.EMAIL))) IN (
          SELECT LOWER([value]) FROM OPENJSON(@EMAILS)
        )
        AND cu.ACTIVE = 1
        AND NULLIF(LTRIM(RTRIM(cu.EMAIL)), '') IS NOT NULL;
      `,
      inputs: {
        EMAILS: {
          type: sql.NVarChar(sql.MAX),
          value: JSON.stringify(recipients),
        },
      },
    });

    return (result?.recordset ?? [])
      .map((row) => row.EMAIL)
      .filter((email) => email && !recipients.includes(email));
  } catch (err) {
    logger.warn(`[MAIL] Copies mails ignorées : ${err?.message ?? err}`);
    return [];
  }
}

/**
 * Adresses qui recevraient une copie (BCC) d'un mail envoyé à `recipients`
 * (même format que to/cc/bcc). Permet à un module qui redirige ses mails en
 * développement (ex. FSA vers BASE_RECIPIENT_EMAIL) d'afficher les copies
 * qui partiraient en production, sans les envoyer réellement.
 */
export async function resolveMailCopies(recipients) {
  return getMailCopyRecipients(extractAddresses(recipients));
}

/**
 * Envoi bas niveau — HTML/texte déjà prêts.
 *
 * Les utilisateurs configurés en « copie mails » d'un destinataire (to, cc
 * ou bcc) sont ajoutés en BCC, sauf si `noMailCopies` est passé (mails
 * personnels : mot de passe, etc.).
 *
 * @param {object} options
 * @param {string|string[]} options.to
 * @param {string} options.subject
 * @param {string} [options.html]
 * @param {string} [options.text]
 * @param {string} [options.from] - par défaut EMAIL_FROM (env) ou noreply@union-vignerons.com
 * @param {string|string[]} [options.cc]
 * @param {string|string[]} [options.bcc]
 * @param {Array} [options.attachments] - format nodemailer standard
 * @param {boolean} [options.noMailCopies] - désactive l'ajout des copies mails
 */
export async function sendMail({
  to,
  subject,
  html,
  text,
  from,
  cc,
  bcc,
  attachments,
  noMailCopies = false,
}) {
  if (!to) throw new Error("MISSING_RECIPIENT");
  if (!subject) throw new Error("MISSING_SUBJECT");
  if (!html && !text) throw new Error("MISSING_CONTENT");

  if (!noMailCopies) {
    const copies = await getMailCopyRecipients(
      extractAddresses([to, cc, bcc].flat().filter(Boolean)),
    );

    if (copies.length > 0) {
      bcc = [...(Array.isArray(bcc) ? bcc : bcc ? [bcc] : []), ...copies];
      logger.info(`[MAIL] Copies mails ajoutées en BCC : ${copies.join(", ")}`);
    }
  }

  const info = await getTransporter().sendMail({
    from: from || DEFAULT_FROM,
    to,
    cc,
    bcc,
    subject,
    html,
    text,
    attachments,
  });

  logger.info(
    `[MAIL] Envoyé à ${Array.isArray(to) ? to.join(", ") : to} | subject="${subject}" | messageId=${info.messageId}`,
  );

  return info;
}

/**
 * Envoi à partir d'un template HTML de core/services/mail-templates/<template>.html.
 * `data` est injecté dans le HTML via renderTemplate().
 *
 * Exemple d'utilisation depuis un autre module :
 *   import { sendTemplatedMail, renderDetailsList, renderContactList, renderNoticeList } from "../../core/services/mail.service.js";
 *
 *   await sendTemplatedMail({
 *     template: "creation",
 *     to: user.EMAIL,
 *     subject: "Nouveau ticket créé",
 *     data: {
 *       APP_NAME: "Ticketing UVCDR",
 *       TITLE: "Ticket créé",
 *       MESSAGE: "Un nouveau ticket vient d'être créé et vous a été assigné.",
 *       DETAILS_ROWS_HTML: renderDetailsList([
 *         { label: "Numéro", value: ticket.TCKCOD },
 *         { label: "Titre", value: ticket.TITLE },
 *       ]),
 *       NOTICES_HTML: renderNoticeList([
 *         { type: "error", message: "La synchronisation a échoué.", code: "ERR_SYNC_TIMEOUT" },
 *       ]),
 *       ACTION_URL: "https://...", ACTION_LABEL: "Voir le ticket",
 *       CONTACTS_HTML: renderContactList([
 *         { name: "Alexandre VERGNES", email: "a.vergnes@union-vignerons.com" },
 *       ]),
 *     },
 *   });
 *
 * Templates disponibles dans mail-templates/ : creation, modification,
 * (tous les templates ci-dessous acceptent en plus NOTICES_HTML, voir
 * renderNoticeList() pour afficher des messages d'erreur/alerte/succès/info
 * complémentaires)
 * deletion, validation-approved, validation-rejected, validation-partial,
 * reminder, information, welcome, password-reset, alert.
 *
 * Templates par module : un module peut disposer de ses propres variantes,
 * plus cohérentes avec son besoin métier (branding dédié, données
 * spécifiques...), rangées dans un sous-dossier mail-templates/<module>/ —
 * `template` accepte alors un chemin relatif, ex. "ticketing/creation" pour
 * core/services/mail-templates/ticketing/creation.html. Cf.
 * mail-templates/ticketing/ pour l'application Ticketing (mêmes clés de
 * `data` que les templates génériques équivalents, plus TICKET_CODE affiché
 * en badge), et mail-templates/fsa/ pour l'application FSA (DOSSIER_CODE en
 * badge, NOMDOS/NOTDOS pour le titre et le détail du dossier, DOSSIERS_HTML
 * — via renderFolderList() — pour la relance groupée sur plusieurs
 * dossiers). Un module migré vers ses propres templates n'a plus besoin des
 * templates génériques équivalents une fois la migration terminée.
 */
export async function sendTemplatedMail({
  template,
  to,
  subject,
  data = {},
  from,
  cc,
  bcc,
  attachments,
  noMailCopies,
}) {
  const templatePath = path.join(TEMPLATES_DIR, `${template}.html`);

  let rawHtml;

  try {
    rawHtml = await fs.readFile(templatePath, "utf-8");
  } catch {
    throw new Error(`MAIL_TEMPLATE_NOT_FOUND_[${template}]`);
  }

  const html = renderTemplate(rawHtml, data);

  return sendMail({
    to,
    subject,
    html,
    from,
    cc,
    bcc,
    attachments,
    noMailCopies,
  });
}
