import { defineConfig } from "vitest/config";

/**
 * Config Vitest — cf. README section "Tests".
 *
 * - environment "node" (API pure, pas de DOM à simuler).
 * - Variables d'env de test définies ici (chargées AVANT tout import de
 *   fichier de test / setupFile), pour que des modules comme
 *   core/utils/jwt.utils.js (qui lisent process.env dès leur chargement)
 *   trouvent toujours une config valide.
 * - Aucune base SQL / LDAP / SMTP réelle n'est utilisée : les services qui y
 *   accèdent (runQuery, ldapAuthenticate, sendTemplatedMail...) sont mockés
 *   dans chaque fichier de test via vi.mock(). cf. tests/helpers/.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.js"],
    setupFiles: ["./tests/setup.js"],
    testTimeout: 10000,
    hookTimeout: 10000,
    clearMocks: true,
    restoreMocks: true,
    env: {
      NODE_ENV: "test",
      API_BASE_ROUTE: "api",
      DOMAIN: "https://test.union-vignerons.com",
      PORT: "0",
      JWT_SECRET: "test-secret-do-not-use-in-prod-0123456789",
      EXP: "1h",
      MODIFY_PERMS: "DEV,SUPERADMIN,ADMIN",
      CORS_ORIGINS: "http://localhost:5173",
      UPLOAD_PATH: "./tests/.tmp/uploads",
      UPLOAD_TMP_PATH: "./tests/.tmp/tmp",
      TMP_RETENTION_DAYS: "7",
      ATTACHMENT_SIGNING_KEY_VERSION: "V1",
      ATTACHMENT_SIGNING_SECRET_V1: "test-attachment-signing-secret-0123456789",
      API_BASE_UPLOAD_URL: "https://test.union-vignerons.com/api/uploads",
      LOG_LEVEL: "silent",
      LDAP_URL: "ldap://ldap.test.local:389",
      LDAP_DN: "CN=svc-test",
      LDAP_PASSWORD: "test-password",
      SEARCH_BASE: "OU=Utilisateurs,DC=TEST,DC=FR",
      // Repli "dev" des notifications mail (ticketing, declcav — cf. leurs
      // controllers.js) : NODE_ENV="test" n'est jamais "production", donc les
      // tests exercent systématiquement cette branche de repli plutôt que les
      // vraies adresses métier. Valeur dédiée aux tests uniquement.
      BASE_RECIPIENT_EMAIL: "qa-mail-fallback@union-vignerons.com",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["core/**", "config/**", "modules/**"],
      exclude: [
        "**/mail-templates/**",
        "config/env.js",
        "config/env/**",
        "config/db/**",
      ],
    },
  },
});
