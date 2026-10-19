import express from "express";
import * as authMiddlewares from "../../core/middlewares/auth.middleware.js";
import * as controllers from "./controllers.js";
import auditsRouter from "./audits/routes.js";

const router = express.Router();

const IS_PROD = process.env.NODE_ENV === "production";

/* ─────────────────────────────────────────────
   DEV — Test des templates d'email (envoie un exemplaire de chaque
   variante à BASE_RECIPIENT_EMAIL, cf. controllers.testDeclcavMailTemplates).
   Même principe que GET /fsa/mail-templates/test et
   GET /ticketing/mail-templates/test.
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
    res.json(await controllers.testDeclcavMailTemplates(req));
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------------------- */
/*                                   AUDITS                                   */
/*   Audits qualité par cave (cf. ./audits/routes.js, ./sql/AUDITS.table.sql) */
/* -------------------------------------------------------------------------- */

router.use("/audits", auditsRouter);

/* -------------------------------------------------------------------------- */
/*                                    GETS                                    */
/* -------------------------------------------------------------------------- */

router.get(
  "/",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getFolders(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/folder/mrv",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getFolderByMrv(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/ingredients",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getIngredients(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/types/caves",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getTypesCaves(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/caves",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getCaves(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/responses",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getResponses(req));
    } catch (err) {
      next(err);
    }
  },
);

/* -------------------------------------------------------------------------- */
/*                                    POST                                    */
/* -------------------------------------------------------------------------- */

router.post(
  "/",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.status(201).json(await controllers.setDeclaration(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/relaunch",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.relaunchDecl(req));
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Relance des questionnaires de traçabilité en attente (DECLQST +
 * DECLQSTSTA DRAFT/INVALID), appelée par le front pour les utilisateurs du
 * service Qualité (voir declcav/relaunch ci-dessus pour Œnologie /
 * déclarations — cf. DecentViewRowClass.canRelaunch côté front).
 */
router.post(
  "/relaunch/quest",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.relaunchQuest(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/rectification",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.status(201).json(await controllers.setRectification(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/mrv/ingredients",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.setMrvIngredients(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/cave",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.upsertCave(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/responses",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.upsertResponses(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/reset-password",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.setCavePassword(req));
    } catch (err) {
      next(err);
    }
  },
);

/* -------------------------------------------------------------------------- */
/*                                    PATCH                                   */
/* -------------------------------------------------------------------------- */

router.patch(
  "/",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.patchDeclaration(req));
    } catch (err) {
      next(err);
    }
  },
);

router.patch(
  "/ingredient",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.patchIngredient(req));
    } catch (err) {
      next(err);
    }
  },
);

/* -------------------------------------------------------------------------- */
/*                                    DELETE                                  */
/* -------------------------------------------------------------------------- */

router.delete(
  "/",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.deleteDecl(req));
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  "/cave",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.deleteCave(req));
    } catch (err) {
      next(err);
    }
  },
);

export default router;
