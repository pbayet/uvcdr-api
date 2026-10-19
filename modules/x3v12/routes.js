import express from "express";
import * as authMiddlewares from "../../core/middlewares/auth.middleware.js";
import * as controllers from "./controllers.js";

const router = express.Router();

/**
 * Repris de V1.0.0 (modules/x3v12/routes.js), où authMiddlewares n'était
 * pas importé et la route n'était donc pas protégée. Corrigé ici pour
 * rester cohérent avec les autres modules V1.1.0 (dwhbi, ticketing, fsa,
 * declcav), qui protègent systématiquement leurs routes avec
 * authVerifyMiddleware.
 */

router.get("/ingredients/mrv", authMiddlewares.authVerifyMiddleware, async (req, res, next) => {
  try {
    res.json(await controllers.getIngresMrv(req));
  } catch (err) {
    next(err);
  }
});

export default router;
