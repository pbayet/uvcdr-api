// Fabrique de descripteurs de connexion DB.
// Dans V1.0.0, chaque fichier config/db/*.db.config.js dupliquait ~30 lignes
// identiques (déduction du nom depuis le nom de fichier, résolution des clés
// d'env DB_HOST_*/DB_USER_*/DB_PASS_*, création du pool). Ici, chaque fichier
// *.db.config.js se réduit à un appel de `makeConnectionConfigGetter(name)`.
// Autre changement : ce fichier ne crée PLUS le pool lui-même — il retourne
// juste un descripteur { dbName, appCode, connection }. C'est config/db/index.js
// qui décide de créer un nouveau pool ou de réutiliser un pool physique déjà
// ouvert vers le même (host + base), ce qui permet la mutualisation des pools
// (cf. audit perf 3.1 — jusqu'à 240 connexions simultanées possibles avant).

const SHARED_HOST_APPCODES = new Set(["BAS", "HOME", ""]);

export function makeConnectionConfigGetter(dbConfigName) {
  const NAME_KEY = `DB_NAME_${dbConfigName.toUpperCase()}`;
  const APPCODE_KEY = `DB_APP_CODE_${dbConfigName.toUpperCase()}`;

  return function getConnectionConfig() {
    const dbName = process.env[NAME_KEY];
    const appCode = process.env[APPCODE_KEY];

    if (!dbName || appCode === undefined) {
      throw new Error("DB_LOGIN_FAILED");
    }

    const dedicated = SHARED_HOST_APPCODES.has(appCode);

    const portValue = dedicated
      ? Number(process.env[`DB_PORT_${dbConfigName.toUpperCase()}`]) || 1433
      : Number(process.env.DB_PORT) || 1433;

    const hostKey = dedicated
      ? `DB_HOST_${dbConfigName.toUpperCase()}`
      : "DB_HOST";
    const userKey = dedicated
      ? `DB_USER_${dbConfigName.toUpperCase()}`
      : "DB_USER";
    const passKey = dedicated
      ? `DB_PASS_${dbConfigName.toUpperCase()}`
      : "DB_PASS";

    return {
      dbName: dbConfigName,
      appCode,
      connection: {
        server: process.env[hostKey],
        user: process.env[userKey],
        password: process.env[passKey],
        database: dbName,
        port: portValue,
      },
    };
  };
}
