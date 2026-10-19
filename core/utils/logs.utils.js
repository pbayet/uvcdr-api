/**
 * Masque les paramètres sensibles dans l'URL
 * Exemples :
 *   /api/auth?email=test@test.com&password=1234  →  /api/auth?email=test@test.com&password=******
 *   /login?pwd=abc  →  /login?pwd=******
 */
function isSensitiveKey(key) {
  const sensitiveKeys = ["password", "pwd", "pass", "secret", "token"];
  return sensitiveKeys.includes(key.toLowerCase());
}

export function sanitizeUrl(url) {
  if (!url || typeof url !== "string") return url;

  try {
    const urlObj = new URL(url, "http://localhost"); // Base factice pour parsing
    for (const [key] of urlObj.searchParams.entries()) {
      if (isSensitiveKey(key)) {
        urlObj.searchParams.set(key, "******");
      }
    }
    return urlObj.pathname + urlObj.search;
  } catch {
    return url.replace(/(password|pwd|pass)=([^&]+)/gi, "$1=******");
  }
}

/**
 * Compile un chemin de route façon Express (ex: "/api/ticketing/note/:id")
 * en RegExp anchorée, utilisée pour matcher le pathname d'une requête
 * (query string ignorée par l'appelant) contre ROUTES_TO_SAVE_IN_BASE
 * (core/config/activityLog.config.js).
 *
 * - Un segment `:param` matche n'importe quel segment non vide (`[^/]+`).
 * - Les autres segments sont matchés littéralement (caractères spéciaux
 *   regex échappés).
 * - Le slash final est optionnel ("/api/foo" matche aussi "/api/foo/").
 */
export function generateRoutePattern(route) {
  const pattern = String(route || "")
    .split("/")
    .map((segment) =>
      segment.startsWith(":")
        ? "[^/]+"
        : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");

  return new RegExp(`^${pattern}/?$`);
}

/**
 * Codes ANSI pour la console. Volontairement pas de dépendance chalk/
 * picocolors pour un besoin aussi simple. Ces codes sont automatiquement
 * retirés des fichiers de logs par winston.format.uncolorize() (cf.
 * config/logger.config.js) : ils ne polluent donc jamais logs/*.log.
 */
export const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

/** Colorie `text` avec une couleur de `ansi` (no-op si la couleur n'existe pas). */
export function colorize(text, color) {
  return `${ansi[color] ?? ""}${text}${ansi.reset}`;
}

/**
 * Bannière encadrée pour délimiter visuellement, dans la console, une
 * séquence de logs (ex: initialisation des bases de données au démarrage)
 * du reste du flux applicatif (requêtes HTTP, erreurs métier, etc.).
 */
export function banner(title, color = "cyan") {
  const line = "─".repeat(Math.max(60, title.length + 4));
  return [
    "",
    colorize(line, color),
    colorize(`  ${title}`, color),
    colorize(line, color),
  ].join("\n");
}

export function formatLog(title, entries) {
  return [
    title,
    "",
    ...Object.entries(entries).flatMap(([key, value]) => {
      if (Array.isArray(value)) {
        return [`${key}:`, ...value.map((v) => `\t• ${v}`), ""];
      }

      return [`${key}: ${value}`, ""];
    }),
  ]
    .join("\n")
    .trimEnd();
}
