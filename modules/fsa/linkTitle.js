import http from "http";
import https from "https";
import dns from "dns";
import net from "net";

/* ═══════════════════════════════════════════════════════════════
   FSA — Titre d'un lien externe (GET /fsa/liens/titre)

   Sert à préremplir le nom d'un lien ajouté à un dossier (FSALIENS) avec
   le titre de la page, c.-à-d. ce que le navigateur affiche dans l'onglet
   (ex : "Cahier des charges.pdf - Google Drive" -> "Cahier des charges.pdf").
   Le front ne peut pas le faire lui-même (CORS) : c'est l'API qui va lire
   la page.

   Limites connues : seuls les liens accessibles SANS connexion renvoient
   un titre (Drive "tous les utilisateurs disposant du lien", etc.). Pour un
   document privé, Google/Microsoft renvoient une page de connexion : on la
   détecte et on renvoie null (l'utilisateur saisit le nom à la main).

   Sécurité (SSRF) : l'URL vient de l'utilisateur et la requête part du
   serveur, donc depuis le réseau interne. On n'autorise que http(s), on
   refuse toute adresse IP privée / locale (vérifiée sur l'IP réellement
   utilisée pour la connexion, via `lookup`, ce qui couvre aussi le DNS
   rebinding), on suit les redirections à la main en revérifiant chaque
   saut, avec un délai et une taille de lecture bornés.
═══════════════════════════════════════════════════════════════ */

const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 4;
const MAX_BYTES = 512 * 1024;

/** Hôtes de pages de connexion : y être redirigé = document non public. */
const LOGIN_HOSTS = [
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.live.com",
  "login.microsoft.com",
];

/** Titres de pages de connexion / d'accueil génériques (non pertinents). */
const GENERIC_TITLES = [
  /sign[ -]?in/i,
  /se connecter/i,
  /connexion/i,
  /^google drive$/i,
  /^meet google drive/i,
  /^onedrive$/i,
  /^sharepoint$/i,
];

/** Suffixes ajoutés par les services au nom du document. */
const TITLE_SUFFIXES =
  /\s+[-–|]\s+(Google (Drive|Docs|Sheets|Slides|Forms|Doc|Sheet)|Microsoft (Word|Excel|PowerPoint)( Online)?|OneDrive|SharePoint|Dropbox|Box)\s*$/i;

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local / métadonnées cloud
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224 // multicast / réservé
    );
  }

  const ip = address.toLowerCase();
  if (ip.startsWith("::ffff:")) return isPrivateAddress(ip.slice(7));
  return (
    ip === "::" ||
    ip === "::1" ||
    ip.startsWith("fc") ||
    ip.startsWith("fd") ||
    ip.startsWith("fe80") ||
    ip.startsWith("ff")
  );
}

// `lookup` passé à http(s).request : refuse la connexion vers une IP privée.
// Node >= 20 (autoSelectFamily) l'appelle avec `all: true` et attend un
// tableau d'adresses : on gère les deux formes.
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (
      !addresses.length ||
      addresses.some((a) => isPrivateAddress(a.address))
    ) {
      return callback(new Error("FORBIDDEN_ADDRESS"));
    }
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** og:title en priorité (souvent le nom exact du fichier), sinon <title>. */
export function extractTitle(html) {
  const ogTitle =
    html.match(
      /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i,
    ) ||
    html.match(
      /<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:title["']/i,
    );
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  const raw = ogTitle?.[1] || title?.[1];
  if (!raw) return null;

  const cleaned = decodeEntities(raw)
    .replace(/\s+/g, " ")
    .trim()
    .replace(TITLE_SUFFIXES, "")
    .trim();

  if (!cleaned || GENERIC_TITLES.some((re) => re.test(cleaned))) return null;

  return cleaned.slice(0, 255);
}

/** Paramètres d'URL portant le chemin du fichier (SharePoint / OneDrive). */
const FILE_PATH_PARAMS = ["id", "file", "FileRef", "SourceUrl"];

/** Dernier segment d'un chemin, s'il ressemble à un nom de fichier (extension). */
function fileNameFromPath(path) {
  const last = path.split("/").filter(Boolean).pop();
  if (!last) return null;

  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // segment mal encodé : on le garde tel quel
  }

  return /\.[a-z0-9]{2,5}$/i.test(name) ? name.slice(0, 255) : null;
}

/**
 * Nom du fichier lu dans le lien lui-même, sans appel réseau. Couvre les
 * liens SharePoint/OneDrive (privés : la page renvoie un écran de
 * connexion) dont le chemin du fichier est passé en paramètre, ex :
 *   .../AllItems.aspx?id=/sites/X/QUALITE/Certificat IFS 2026.pdf
 *
 * @param {URL} url
 * @returns {string|null}
 */
export function titleFromUrl(url) {
  for (const param of FILE_PATH_PARAMS) {
    const value = url.searchParams.get(param);
    const name = value && fileNameFromPath(value);
    if (name) return name;
  }

  return null;
}

function fetchOnce(url) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;

    const req = client.request(
      url,
      {
        method: "GET",
        lookup: safeLookup,
        timeout: TIMEOUT_MS,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; UVCDR-FSA/1.1)",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
        },
      },
      (res) => {
        const { statusCode = 0, headers } = res;

        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          return resolve({ redirect: new URL(headers.location, url) });
        }

        const contentType = String(headers["content-type"] || "");
        if (statusCode >= 400 || !/html/i.test(contentType)) {
          res.resume();
          return resolve({ html: null });
        }

        const charset =
          contentType.match(/charset=([\w-]+)/i)?.[1]?.toLowerCase() ||
          "utf-8";

        const chunks = [];
        let size = 0;

        res.on("data", (chunk) => {
          chunks.push(chunk);
          size += chunk.length;
          // Le <title> est dans le <head> : inutile de tout télécharger.
          if (size >= MAX_BYTES) res.destroy();
        });

        const done = () => {
          let decoder;
          try {
            decoder = new TextDecoder(charset);
          } catch {
            decoder = new TextDecoder("utf-8");
          }
          resolve({ html: decoder.decode(Buffer.concat(chunks)) });
        };

        res.on("end", done);
        res.on("close", done);
        res.on("error", reject);
      },
    );

    req.on("timeout", () => req.destroy(new Error("TIMEOUT")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Renvoie le titre de la page pointée par `rawUrl`, ou null s'il n'a pas pu
 * être déterminé (page privée, pas du HTML, hôte refusé, délai dépassé...).
 * Ne lève jamais d'erreur : un titre absent n'est pas bloquant.
 *
 * @param {string} rawUrl
 * @returns {Promise<string|null>}
 */
export async function getLinkTitle(rawUrl) {
  try {
    let url = new URL(rawUrl);

    // Nom du fichier présent dans le lien : prioritaire, c'est le nom exact
    // (et la page, souvent privée, n'apporterait rien de mieux).
    const fromUrl = titleFromUrl(url);
    if (fromUrl) return fromUrl;

    const original = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      if (LOGIN_HOSTS.includes(url.hostname.toLowerCase())) return null;

      const result = await fetchOnce(url);

      if (result.redirect) {
        url = result.redirect;
        continue;
      }

      const title = result.html ? extractTitle(result.html) : null;
      // Pas de titre exploitable : dernier recours, le nom de fichier en fin
      // de chemin (ex : .../Documents/Devis.xlsx).
      return title ?? fileNameFromPath(original.pathname);
    }

    return fileNameFromPath(original.pathname);
  } catch {
    try {
      return fileNameFromPath(new URL(rawUrl).pathname);
    } catch {
      return null;
    }
  }
}
