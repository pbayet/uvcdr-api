import express from "express";
import * as authMiddlewares from "../../core/middlewares/auth.middleware.js";
import * as controllers from "./controllers.js";
import { scheduleDailyTask } from "../../core/utils/scheduler.utils.js";
import { getReminderConfig } from "./utils.js";

/**
 * Module "passwords" — relances d'expiration des mots de passe AD.
 * Monté automatiquement sur /<API_BASE_ROUTE>/passwords (modules/index.js).
 */
const router = express.Router();

const IS_PROD = process.env.NODE_ENV === "production";

// Relance automatique (jours ouvrés) : paliers PWD_REMINDER_TIERS + expirés.
// Production uniquement, comme la relance FSA (modules/fsa/routes.js).
const cfg = getReminderConfig();
if (IS_PROD && cfg.scheduleEnabled) {
  scheduleDailyTask(
    () => controllers.runScheduledReminders(),
    cfg.scheduleHour,
    cfg.scheduleMinute,
  );
}

const handle = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   RELANCES MANUELLES (gestionnaires users-manager)
───────────────────────────────────────────── */

// Relance d'un utilisateur. Body : { email }
router.post(
  "/reminders/user",
  authMiddlewares.authVerifyMiddleware,
  handle(controllers.sendUserReminder),
);

// Relance générale. Body : { days?, dryRun? }
router.post(
  "/reminders",
  authMiddlewares.authVerifyMiddleware,
  handle(controllers.sendGeneralReminder),
);

/* ─────────────────────────────────────────────
   DEV — exécution immédiate de la tâche planifiée
   (désactivée en production, même principe que /fsa/mail-templates/test)
───────────────────────────────────────────── */
router.post(
  "/reminders/scheduled/run",
  (req, res, next) => {
    if (!IS_PROD) return next();
    const err = new Error("Route de test désactivée en production.");
    err.status = 403;
    return next(err);
  },
  authMiddlewares.authVerifyMiddleware,
  handle(controllers.runScheduledRemindersNow),
);

export default router;
