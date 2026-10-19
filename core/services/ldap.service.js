import ldap from "ldapjs";
import fs from "node:fs";

/**
 * Logique LDAP extraite de auth.middleware.js (V1.0.0) — ce fichier existait
 * mais était vide, toute la logique LDAP vivait dans le middleware. Séparée
 * ici pour que auth.middleware.js reste concentré sur les middlewares Express.
 */

// Codes AD les plus fréquents pour un échec de bind :
// 525 = DN/utilisateur non trouvé (souvent le symptôme du bug d'accent)
// 52e = mot de passe réellement invalide
const AD_DN_NOT_RESOLVED_CODES = new Set(["525"]);

const CACHE_REBIND_INTERVAL = 15 * 60 * 1000; // 15 min entre deux rebind automatiques

let ldapCache = { client: null, connected: false, lastBind: 0 };

function extractAdDiagnosticCode(err) {
  const raw = err?.cause?.message || "";
  const match = raw.match(/data\s+([0-9a-fA-F]{2,4})/i);
  return match ? match[1].toLowerCase() : null;
}

function resetLdapClient() {
  try {
    if (ldapCache.client) ldapCache.client.unbind();
  } finally {
    ldapCache = { client: null, connected: false, lastBind: 0 };
  }
}

/**
 * Retourne un client LDAP "service" connecté et valide (réutilisé tant qu'il
 * fonctionne, recréé sinon).
 */
export async function getLdapServiceClient() {
  const { LDAP_URL, LDAP_DN, LDAP_PASSWORD } = process.env;
  const now = Date.now();

  if (!LDAP_URL || !LDAP_DN || !LDAP_PASSWORD) {
    throw new Error("LDAP_CONFIGURATION_ERROR");
  }

  if (
    ldapCache.client &&
    ldapCache.connected &&
    now - ldapCache.lastBind < CACHE_REBIND_INTERVAL
  ) {
    return ldapCache.client;
  }

  if (ldapCache.client) {
    try {
      await new Promise((resolve, reject) => {
        ldapCache.client.bind(LDAP_DN, LDAP_PASSWORD, (err) =>
          err ? reject(err) : resolve(),
        );
      });
      ldapCache.lastBind = now;
      ldapCache.connected = true;
      return ldapCache.client;
    } catch {
      resetLdapClient();
    }
  }

  const client = ldap.createClient({ url: LDAP_URL, reconnect: true });

  client.on("error", () => {
    resetLdapClient();
  });

  await new Promise((resolve, reject) => {
    client.bind(LDAP_DN, LDAP_PASSWORD, (err) => {
      if (err) {
        resetLdapClient();
        return reject(new Error("LDAP_SERVICE_BIND_FAILED"));
      }
      resolve();
    });
  });

  ldapCache = { client, connected: true, lastBind: now };

  return client;
}

const CA_CERT_PATH = process.env.LDAP_CA_CERT_PATH;

function createLdapClient() {
  return ldap.createClient({
    url: process.env.LDAP_URL,
    timeout: 10_000,
    connectTimeout: 10_000,
    reconnect: false,
  });
}

function startTls(client) {
  const tlsOptions = {
    ...(CA_CERT_PATH ? { ca: [fs.readFileSync(CA_CERT_PATH)] } : {}),
    rejectUnauthorized: true,
  };

  return new Promise((resolve, reject) => {
    client.starttls(tlsOptions, null, (err) => {
      if (err) return reject(new Error("LDAP_STARTTLS_FAILED"));
      resolve();
    });
  });
}

function bind(client, dn, password, errCode) {
  return new Promise((resolve, reject) => {
    client.bind(dn, password, (err) => {
      if (err) return reject(new Error(errCode, { cause: err }));
      resolve();
    });
  });
}

function search(client, base, options) {
  return new Promise((resolve, reject) => {
    const results = [];
    client.search(base, options, (err, res) => {
      if (err) return reject(new Error("LDAP_SEARCH_FAILED", { cause: err }));

      res.on("searchEntry", (entry) => {
        let dnValue = "";
        try {
          dnValue =
            typeof entry.dn === "string"
              ? entry.dn
              : entry.dn?.toString?.() || "";
        } catch {
          dnValue = "";
        }

        // ldapjs v3 : `entry.object` n'existe plus (il valait undefined, seul
        // le DN était donc réellement exploité). Les attributs sont lus depuis
        // `entry.attributes` : valeur scalaire si mono-valuée, tableau sinon.
        const attrs = {};
        for (const attr of entry.attributes || []) {
          const values = attr.values || [];
          attrs[attr.type] = values.length === 1 ? values[0] : values;
        }

        results.push({ ...attrs, dn: dnValue });
      });

      // `cause` conserve l'erreur ldapjs (dont `code` LDAP) pour les appelants.
      res.on("error", (err) =>
        reject(new Error("LDAP_SEARCH_ERROR", { cause: err })),
      );
      res.on("end", () => resolve(results));
    });
  });
}

async function safeUnbind(client) {
  if (!client) return;
  await new Promise((resolve) => client.unbind(() => resolve()));
}

/**
 * Auth LDAP via StartTLS (LDAP 389 + chiffrement) :
 * bind service -> search user -> bind avec le DN trouvé + mot de passe fourni.
 */
export async function ldapAuthenticate({
  SEARCH_BASE,
  searchOptions,
  serviceBindDN,
  serviceBindPassword,
  password,
}) {
  const LDAP_URL = process.env.LDAP_URL;
  if (!LDAP_URL?.startsWith("ldap://")) {
    throw new Error("LDAP_URL_MUST_BE_LDAP_389_FOR_STARTTLS");
  }

  let serviceClient;
  let userClient;

  try {
    serviceClient = createLdapClient();

    await startTls(serviceClient);
    await bind(
      serviceClient,
      serviceBindDN,
      serviceBindPassword,
      "LDAP_SERVICE_BIND_FAILED",
    );

    const entries = await search(serviceClient, SEARCH_BASE, searchOptions);

    if (!entries.length) throw new Error("INVALID_CREDENTIALS");

    const user = entries[0];
    const userDN = user.dn;
    if (!userDN) throw new Error("USER_DN_NOT_FOUND");

    userClient = createLdapClient();

    await startTls(userClient);

    try {
      await bind(userClient, userDN, password, "INVALID_CREDENTIALS");
    } catch (err) {
      const adCode = extractAdDiagnosticCode(err);
      const dnHasNonAscii = /[^\x00-\x7F]/.test(userDN);

      if (adCode && AD_DN_NOT_RESOLVED_CODES.has(adCode)) {
        console.error(
          `[LDAP][ALERTE_DN_NON_RESOLU] Bind utilisateur échoué (code AD "data ${adCode}") ` +
            `alors qu'un utilisateur avait été trouvé par la recherche du service. ` +
            `Ce n'est probablement PAS un mauvais mot de passe mais un problème de résolution du DN` +
            `${dnHasNonAscii ? " — le DN contient des caractères non-ASCII (accent probable)." : "."}` +
            ` dn="${userDN}"`,
        );
      } else if (dnHasNonAscii) {
        console.warn(
          `[LDAP][DN_NON_ASCII] Bind utilisateur échoué pour un DN avec caractères non-ASCII ` +
            `(code AD: ${adCode ?? "inconnu"}). dn="${userDN}"`,
        );
      }

      throw err;
    }

    return user;
  } finally {
    await safeUnbind(userClient);
    await safeUnbind(serviceClient);
  }
}

/**
 * Échappe une valeur destinée à un filtre LDAP (RFC 4515) afin d'empêcher
 * toute injection de filtre : `*`, `(`, `)`, `\` et NUL.
 */
export function escapeLdapFilterValue(value) {
  return String(value).replace(
    /[\\*()\0]/g,
    (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

/**
 * Recherche en lecture seule avec le compte de service (StartTLS) :
 * bind service -> search -> unbind. Pagination activée pour dépasser la
 * limite AD de 1000 résultats (MaxPageSize).
 */
export async function ldapServiceSearch(base, options) {
  const { LDAP_URL, LDAP_DN, LDAP_PASSWORD } = process.env;
  if (!LDAP_URL || !LDAP_DN || !LDAP_PASSWORD || !base) {
    throw new Error("LDAP_CONFIGURATION_ERROR");
  }
  if (!LDAP_URL.startsWith("ldap://")) {
    throw new Error("LDAP_URL_MUST_BE_LDAP_389_FOR_STARTTLS");
  }

  let client;
  try {
    client = createLdapClient();
    await startTls(client);
    await bind(client, LDAP_DN, LDAP_PASSWORD, "LDAP_SERVICE_BIND_FAILED");
    const { paged = { pageSize: 500 }, ...rest } = options;
    return await search(client, base, {
      ...rest,
      ...(paged ? { paged } : {}),
    });
  } finally {
    await safeUnbind(client);
  }
}
