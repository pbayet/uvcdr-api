import express from "express";
import * as authMiddlewares from "../../core/middlewares/auth.middleware.js";
import * as controllers from "./controllers.js";
import { scheduleDailyTask } from "../../core/utils/scheduler.utils.js";

const router = express.Router();

const IS_PROD = process.env.NODE_ENV === "production";

// Relance quotidienne des dossiers en attente de validation (cf. V1.0.0
// modules/fsa/config/module.config.js, désormais factorisé dans
// core/utils/scheduler.utils.js et partagé par tous les modules).
if (IS_PROD) scheduleDailyTask(controllers.dailyRelaunch, 10, 0);

/* ─────────────────────────────────────────────
   DEV — Test des templates d'email (envoie un exemplaire de chaque
   variante à BASE_RECIPIENT_EMAIL, cf. controllers.testFsaMailTemplates).
   Même principe que GET /ticketing/mail-templates/test.
   Authentifiée (authVerifyMiddleware), comme le reste du module, et
   désactivée en production : c'est un outil de développement pour
   prévisualiser le rendu réel des templates après modification, pas une
   fonctionnalité produit — et on ne veut pas reproduire l'incident V1.0.0
   d'une route mail exploitable en prod (cf. commentaire d'en-tête de
   controllers.js).
───────────────────────────────────────────── */
router.get("/mail-templates/test", async (req, res, next) => {
  if (IS_PROD) {
    const err = new Error("Route de test désactivée en production.");
    err.status = 403;
    return next(err);
  }
  try {
    res.json(await controllers.testFsaMailTemplates(req));
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------------------- */
/*                                    GETS                                    */
/* -------------------------------------------------------------------------- */

router.get(
  "/",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getFsas(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/gestionnaires",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getGestionnaires(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/gestionnaires/status",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getStatusGest(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/gestionnaires/must/validate",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getGestsMustValidate());
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/gestionnaires/must/validate/numdos",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getGestsMustValidateByNumDos(req));
    } catch (err) {
      next(err);
    }
  },
);

// Paramètres globaux de l'application (table singleton FSASETTINGS) — cf.
// SettingsPage.tsx (onglet "Général") / entities/fsa/FsaAppSettings.class.ts.
router.get(
  "/settings",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getSettings());
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/status",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getStatus());
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/types",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getTypes());
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/services",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getServices());
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/validation/types",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getValTypes());
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/validation/delays",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getValDelays());
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/candel/gestionnaires",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getCanDelGests());
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/valideurs/emails",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getValEmails());
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/condition/operators",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getConditionOperators());
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/view/fields",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getViewFields());
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/gestionnaire/conditions",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getGestConditions());
    } catch (err) {
      next(err);
    }
  },
);

/* -------------------------------------------------------------------------- */
/*                                   POSTS                                    */
/* -------------------------------------------------------------------------- */

router.post(
  "/",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.status(201).json(await controllers.postFsa(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/duplicate",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.status(201).json(await controllers.duplicateFsa(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/validation",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.status(201).json(await controllers.postValidation(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/gestionnaire",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.status(201).json(await controllers.postGestionnaire(req));
    } catch (err) {
      next(err);
    }
  },
);

/* -------------------------------------------------------------------------- */
/*                                 PATCHS                                     */
/* -------------------------------------------------------------------------- */

// Paramètres globaux de l'application (table singleton FSASETTINGS) — cf.
// GET /settings ci-dessus et SettingsPage.tsx (onglet "Général").
router.patch(
  "/settings",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.patchSettings(req));
    } catch (err) {
      next(err);
    }
  },
);

router.patch(
  "/",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.patchFsa(req));
    } catch (err) {
      next(err);
    }
  },
);

router.patch(
  "/folder-notes",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.patchFsaNotes(req));
    } catch (err) {
      next(err);
    }
  },
);

router.patch(
  "/gestionnaires",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.patchGestionnaires(req));
    } catch (err) {
      next(err);
    }
  },
);

router.patch(
  "/gestionnaire",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.patchGestionnaire(req));
    } catch (err) {
      next(err);
    }
  },
);

/* -------------------------------------------------------------------------- */
/*                                 DELETES                                    */
/* -------------------------------------------------------------------------- */

router.delete(
  "/",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.deleteFsa(req));
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  "/validation",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.deleteValidation(req));
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  "/gestionnaire",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.deleteGestionnaire(req));
    } catch (err) {
      next(err);
    }
  },
);

export default router;
