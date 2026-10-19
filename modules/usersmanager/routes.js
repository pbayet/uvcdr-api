import express from "express";
import * as authMiddlewares from "../../core/middlewares/auth.middleware.js";
import * as controllers from "./controllers.js";

const router = express.Router();

router.get("/me", authMiddlewares.authVerifyMiddleware, (req, res) => {
  res.json(controllers.getMe(req));
});

/* ─────────────────────────────────────────────
   USERS
───────────────────────────────────────────── */
router.get(
  "/",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getUsers(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.upsertUser(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/user",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getUser(req));
    } catch (err) {
      next(err);
    }
  },
);

/* ─────────────────────────────────────────────
   APPLICATIONS
───────────────────────────────────────────── */
router.get(
  "/applications",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getApplications(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/application",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.upsertApplication(req));
    } catch (err) {
      next(err);
    }
  },
);

// Public (comme en V1.0.0) : consultée avant authentification par les clients
// pour détecter une mise à jour disponible.
router.get("/application/current/version", async (req, res, next) => {
  try {
    res.json(await controllers.getApplicationCurrentVersion(req));
  } catch (err) {
    next(err);
  }
});

router.get(
  "/home/applications",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getHomeApplications(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/global/activity",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      const user = await controllers.getGeneralActivity(req);
      res.json(user);
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/user/activity",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      const user = await controllers.getUserActivity(req);
      res.json(user);
    } catch (err) {
      next(err);
    }
  },
);

/* ─────────────────────────────────────────────
   PERMISSIONS
───────────────────────────────────────────── */
router.get(
  "/permissions",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getPermissions());
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/permission",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getPermission(req));
    } catch (err) {
      next(err);
    }
  },
);

/* ─────────────────────────────────────────────
   SERVICES & POSITIONS
───────────────────────────────────────────── */
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
  "/services/all",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getServicesAll());
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/service",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.upsertService(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/positions",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getPositions());
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/position",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.upsertPosition(req));
    } catch (err) {
      next(err);
    }
  },
);

router.patch(
  "/service/position",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.patchServicePosition(req));
    } catch (err) {
      next(err);
    }
  },
);

/* ─────────────────────────────────────────────
   GROUPS
───────────────────────────────────────────── */
router.get(
  "/groups",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getGroups());
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/group",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.upsertGroup(req));
    } catch (err) {
      next(err);
    }
  },
);

/* ─────────────────────────────────────────────
   THÈMES (préférences de l'utilisateur connecté)
───────────────────────────────────────────── */
router.get(
  "/themes",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getThemes(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/theme",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getTheme(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/theme",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.setTheme(req));
    } catch (err) {
      next(err);
    }
  },
);

/* ─────────────────────────────────────────────
   VERSIONS APPLICATIVES (changelog / notifs)
───────────────────────────────────────────── */
router.get("/last-version-details", async (req, res, next) => {
  try {
    res.json(await controllers.getLastVersionDetails(req));
  } catch (err) {
    next(err);
  }
});

router.post(
  "/last-version-details/opened",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.setLastVersionDetailsOpened(req));
    } catch (err) {
      next(err);
    }
  },
);

export default router;
