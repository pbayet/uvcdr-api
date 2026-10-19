// tests/helpers/buildTestApp.js
// Construit une app Express minimale reproduisant le pipeline réel de
// app.js (payload JWT décodé → perf/log → formatage de réponse → routes →
// errorHandler), sans DB/CORS/rate-limit réels, pour les tests d'intégration
// (supertest) de chaque module.
import express from "express";
import { responseFormatter } from "../../core/utils/response.utils.js";
import { errorHandler } from "../../core/middlewares/error.middleware.js";
import {
  getAuthorizationPayload,
  PerfMonitoring,
  logHandler,
} from "../../core/middlewares/log.middleware.js";

export function buildTestApp(router, basePath) {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use(getAuthorizationPayload, PerfMonitoring, logHandler, responseFormatter);

  app.use(basePath, router);

  app.use(errorHandler);

  return app;
}
