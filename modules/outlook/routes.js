import express from "express";
import * as authMiddlewares from "../../core/middlewares/auth.middleware.js";
import * as controllers from "./controllers.js";

/**
 * Module outlook — route HTTP générique au-dessus de
 * core/services/outlook.service.js (cf. ce fichier pour le détail de
 * l'intégration Microsoft Graph). Monté automatiquement par
 * modules/index.js sur /api/outlook.
 *
 * Contrairement au service mail (jamais exposé en HTTP suite à l'audit
 * sécurité V1.0.0 — un envoi de mail arbitraire non authentifié), exposer
 * la création de calendrier ici a du sens : c'est le point d'entrée générique
 * "commun à toutes les applis" demandé, chaque appli (ticketing, declcav...)
 * l'appelle depuis son propre front avec le token de l'utilisateur connecté.
 * Seule contrainte imposée ici : authVerifyMiddleware (utilisateur
 * authentifié) — pas de permission métier spécifique, la donnée créée
 * (un événement calendrier) n'a pas d'impact destructif et l'utilisateur ne
 * peut agir que dans les limites permises par l'App Registration Graph
 * (boîte organisatrice résolue côté service, cf. resolveMailbox()).
 */

const router = express.Router();

router.post(
  "/events",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.status(201).json(await controllers.createEvent(req));
    } catch (err) {
      next(err);
    }
  },
);

export default router;
