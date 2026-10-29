import express from "express";
import * as authMiddlewares from "../../core/middlewares/auth.middleware.js";
import * as controllers from "./controllers.js";

const router = express.Router();

/**
 * Repris de V1.0.0 (modules/dwhbi/routes.js), où authMiddlewares était
 * importé mais jamais appliqué sur les routes (import mort) : ces endpoints
 * étaient donc accessibles sans authentification. Corrigé ici pour rester
 * cohérent avec les autres modules V1.1.0 (ticketing, fsa, declcav), qui
 * protègent systématiquement leurs routes avec authVerifyMiddleware.
 */

router.get(
  "/clients",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getClients(req));
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Routes « /search » : recherche côté serveur pour les selects à
 * chargement distant (seuls les LIMIT premiers résultats sont renvoyés),
 * à côté des routes historiques qui chargent toute la liste.
 */
router.get(
  "/clients/search",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.searchClients(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/pays",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getPays(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/vrac",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getVrac(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/vrac/search",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.searchVrac(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/ms/containers",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getMsContainers(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/ms/nomenclature",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getMsNomenclature(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/ms/nomenclature/categories",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getMsNomenclatureCategories(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/ms/nomenclature/search",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.searchMsNomenclature(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/nommenclature/pfi",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getNomenclatureByPFI(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/mrv/complement",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getMrvComplement(req));
    } catch (err) {
      next(err);
    }
  },
);

export default router;
