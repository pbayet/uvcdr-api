// app.js
import "./config/env.js"; // DOIT rester le premier import (cf. commentaire dans ce fichier)

import express from "express";
import cors from "cors";
import { createServer } from "node:http";

import corsOptions from "./config/cors.config.js";
import { logger } from "./config/logger.config.js";
import { initDatabases, closeAllPools } from "./config/db/index.js";
import { initWebSocket } from "./config/websocket/wsManager.js";
import { generalLimiter, authLimiter } from "./config/rateLimit.config.js";

import { closeAllPreparedStatements } from "./core/utils/db.utils.js";
import { responseFormatter } from "./core/utils/response.utils.js";
import { formatLog } from "./core/utils/logs.utils.js";
import { errorHandler } from "./core/middlewares/error.middleware.js";
import {
  getAuthorizationPayload,
  PerfMonitoring,
  logHandler,
} from "./core/middlewares/log.middleware.js";
import { z } from "zod";
import * as authMiddlewares from "./core/middlewares/auth.middleware.js";
import { loadModules } from "./modules/index.js";

import {
  sendTemplatedMail,
  renderDetailsList,
} from "./core/services/mail.service.js";

// Filet de sécurité process-level (cf. audit dette technique 4.8) : V1.0.0 ne
// gérait que SIGINT/SIGTERM. Une exception async non interceptée pouvait
// planter le process silencieusement, sans le nettoyage de gracefulShutdown.
process.on("uncaughtException", (err) => {
  logger.error(`[UNCAUGHT EXCEPTION] ${err?.stack || err?.message || err}`);
});
process.on("unhandledRejection", (reason) => {
  logger.error(
    `[UNHANDLED REJECTION] ${reason instanceof Error ? reason.stack : reason}`,
  );
});

(async () => {
  const app = express();
  const server = createServer(app);

  // Connecter toutes les bases avant de charger les routes
  await initDatabases();

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cors(corsOptions));

  // CORS aligné sur corsOptions (piloté par CORS_ORIGINS) au lieu d'une
  // origine "http://localhost:5173" figée en dur (cf. audit dette 4.7).
  app.use("/api/uploads", cors(corsOptions), express.static("uploads"));

  app.use(
    getAuthorizationPayload,
    PerfMonitoring,
    logHandler,
    responseFormatter,
  );

  // express-rate-limit, présent en dépendance mais jamais branché en V1.0.0
  // (cf. audit sécurité 1.5) : limiteur général + limiteur renforcé sur /auth.
  app.use(`/${process.env.API_BASE_ROUTE}`, generalLimiter);

  //? --------[ROUTES]--------

  app.get(`/${process.env.API_BASE_ROUTE}/test`, (_req, res) => {
    res.status(200).json({
      success: true,
      message: "API is running",
      environment: process.env.NODE_ENV,
      version: process.env.npm_package_version,
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
    });
  });

  app.get(`/${process.env.API_BASE_ROUTE}/test/email`, async (_req, res) => {
    // Ticket fictif : cette route ne fait que vérifier que l'envoi SMTP et le
    // template "creation" fonctionnent, sans dépendre d'un vrai ticket en base.
    const template = "creation";
    const subject = "Test email";
    const message =
      "Ceci est un email de test envoyé depuis la route /test/email.";
    const ticket = {
      TCKCOD: "TCK-TEST-000",
      TITLE: "Ticket de test",
      SRV: { NAME: "Support" },
      STS: { NAME: "Ouvert" },
      PRI: { NAME: "Normale" },
      USRNAM: "Test User",
      ASGNAM: "Test Assigné",
    };

    const data = {
      APP_NAME: "Ticketing UVCDR",
      TITLE: subject,
      MESSAGE: message,
      DETAILS_ROWS_HTML: renderDetailsList([
        { label: "Numéro", value: ticket.TCKCOD },
        { label: "Titre", value: ticket.TITLE },
        { label: "Service", value: ticket.SRV?.NAME },
        { label: "Statut", value: ticket.STS?.NAME },
        { label: "Priorité", value: ticket.PRI?.NAME },
        { label: "Créé par", value: ticket.USRNAM },
        { label: "Assigné à", value: ticket.ASGNAM },
      ]),
    };

    try {
      await sendTemplatedMail({
        template,
        to: "p.bayet@union-vignerons.com",
        subject,
        data,
      });

      res.status(200).json({
        success: true,
        message: "Email de test envoyé avec succès",
        environment: process.env.NODE_ENV,
        version: process.env.npm_package_version,
        timestamp: new Date().toISOString(),
        uptime: Math.round(process.uptime()),
      });
    } catch (err) {
      logger.error(`[TEST][MAIL] Échec envoi "${template}" : ${err.message}`);

      res.status(500).json({
        success: false,
        message: "Échec de l'envoi de l'email de test",
        error: err.message,
      });
    }
  });

  // Route de TEST : expiration du mot de passe AD d'un utilisateur.
  // GET /ldap/pwd/exp/:email[?days=15]
  // L'email est validé par zod puis échappé côté LDAP (escapeLdapFilterValue).
  app.get(
    `/${process.env.API_BASE_ROUTE}/ldap/pwd/exp/:email`,
    async (req, res) => {
      const { email, days } = z
        .object({
          email: z.string().trim().toLowerCase().email().max(254),
          days: z.coerce.number().int().min(0).max(365).optional(),
        })
        .parse({ email: req.params.email, days: req.query.days });

      const result = await authMiddlewares.getPasswordExpirations({
        email,
        expiringWithinDays: days,
      });

      res.status(200).json(result);
    },
  );

  // Route de TEST : expiration des mots de passe AD de tous les utilisateurs.
  // GET /ldap/pwd/exp[?days=15&includeDisabled=true]
  app.get(`/${process.env.API_BASE_ROUTE}/ldap/pwd/exp`, async (req, res) => {
    const { days, includeDisabled } = z
      .object({
        days: z.coerce.number().int().min(0).max(365).optional(),
        includeDisabled: z
          .enum(["true", "false"])
          .optional()
          .transform((v) => v === "true"),
      })
      .parse(req.query);

    const result = await authMiddlewares.getPasswordExpirations({
      includeDisabled,
      expiringWithinDays: days,
    });

    res.status(200).json({ count: result.length, data: result });
  });

  // Route de TEST : expiration des mots de passe AD d'une liste d'utilisateurs.
  // POST /ldap/pwd/exp   body : { emails: [...], days?: 15 }
  // POST plutôt que GET : une liste longue dépasserait la taille max d'une URL.
  app.post(
    `/${process.env.API_BASE_ROUTE}/ldap/pwd/exp`,
    authMiddlewares.authVerifyMiddleware,
    async (req, res) => {
      const { emails, days } = z
        .object({
          emails: z
            .array(z.string().trim().toLowerCase().email().max(254))
            .min(1)
            .max(500),
          days: z.number().int().min(0).max(365).optional(),
        })
        .parse(req.body);

      const result = await authMiddlewares.getPasswordExpirations({
        emails,
        expiringWithinDays: days,
      });

      // Emails demandés mais absents du résultat (inconnus de l'AD,
      // désactivés, illisibles ou hors du filtre `days`).
      const found = new Set(result.map((r) => r.email?.toLowerCase()));
      const notFound = emails.filter((e) => !found.has(e));

      res.status(200).json({ count: result.length, data: result, notFound });
    },
  );

  app.post(
    `/${process.env.API_BASE_ROUTE}/auth`,
    authLimiter,
    authMiddlewares.loginMiddleware,
  );

  // Connexion au compte d'un autre utilisateur avec la permission choisie,
  // réservée aux comptes ayant le statut Développeur (permissionLevel 1).
  app.get(
    `/${process.env.API_BASE_ROUTE}/auth/dev`,
    authMiddlewares.authVerifyMiddleware,
    authMiddlewares.loginDevMiddleware,
  );

  // Génère, à partir du token courant, un nouveau token dédié à l'application
  // ciblée, si l'utilisateur y dispose d'une permission active.
  app.get(
    `/${process.env.API_BASE_ROUTE}/auth/app`,
    authMiddlewares.authVerifyMiddleware,
    authMiddlewares.loginAppMiddleware,
  );

  app.get(
    `/${process.env.API_BASE_ROUTE}/auth/verify`,
    authMiddlewares.authVerifyMiddleware,
    (req, res) => {
      res.status(200).json(true);
    },
  );

  /**
   * Charge les routes des modules (ex: modules/ticketing/routes.js → /api/ticketing)
   */
  await loadModules(app);

  app.use(errorHandler);

  initWebSocket(server);

  const PORT = process.env.PORT || 3001;
  server.listen(PORT, () => {
    logger.info(
      formatLog(`[API START] [${process.env.NODE_ENV?.toUpperCase()}]`, {
        Listening: "http://localhost:" + PORT,
        "Route test": `http://localhost:${PORT}/${process.env.API_BASE_ROUTE}/test`,
        "Base route": `/${process.env.API_BASE_ROUTE}`,
        "CORS origins": process.env.CORS_ORIGINS.split(","),
      }),
    );
  });

  async function gracefulShutdown(signal) {
    logger.info(`[SHUTDOWN] Signal ${signal} reçu — fermeture propre...`);

    await closeAllPreparedStatements().catch(() => {});
    await closeAllPools().catch(() => {});

    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
})();
