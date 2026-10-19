import express from "express";
import * as authMiddlewares from "../../core/middlewares/auth.middleware.js";
import * as controllers from "./controllers.js";

const router = express.Router();

const IS_PROD = process.env.NODE_ENV === "production";

/* ─────────────────────────────────────────────
   DEV — Test des templates d'email (envoie un exemplaire de chaque
   variante à BASE_RECIPIENT_EMAIL, cf. controllers.testTicketMailTemplates).
   Authentifiée comme le reste du module, mais désactivée en production :
   c'est un outil de développement pour prévisualiser le rendu réel des
   templates après modification, pas une fonctionnalité produit — et on ne
   veut pas reproduire l'incident V1.0.0 d'une route mail exploitable en
   prod (cf. commentaire d'en-tête de controllers.js).
───────────────────────────────────────────── */
router.get("/mail-templates/test", async (req, res, next) => {
  if (IS_PROD) {
    const err = new Error("Route de test désactivée en production.");
    err.status = 403;
    return next(err);
  }
  try {
    res.json(await controllers.testTicketMailTemplates(req));
  } catch (err) {
    next(err);
  }
});

/* ─────────────────────────────────────────────
   TICKETS
───────────────────────────────────────────── */
router.get(
  "/",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getTickets(req));
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
      res.status(201).json(await controllers.createTicket(req));
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  "/",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.updateTicket(req));
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  "/",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.deleteTicket(req));
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  "/closing",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.closeTicket(req));
    } catch (err) {
      next(err);
    }
  },
);

/* ─────────────────────────────────────────────
   VUES — Marquer un ticket comme consulté (puce "non vu")
───────────────────────────────────────────── */
router.put(
  "/seen",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.markTicketSeen(req));
    } catch (err) {
      next(err);
    }
  },
);

/* ─────────────────────────────────────────────
   CC — Destinataires en copie
───────────────────────────────────────────── */
router.get(
  "/cc",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getTicketCc(req));
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  "/cc",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.setTicketCc(req));
    } catch (err) {
      next(err);
    }
  },
);

/* ─────────────────────────────────────────────
   LIAISONS — Tickets liés
───────────────────────────────────────────── */
router.get(
  "/links",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getTicketLinks(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/links",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.status(201).json(await controllers.addTicketLink(req));
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  "/links",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.removeTicketLink(req));
    } catch (err) {
      next(err);
    }
  },
);

/* ─────────────────────────────────────────────
   FUSION — Tickets fusionnés
───────────────────────────────────────────── */
router.get(
  "/merged",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getMergedTickets(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/merge",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.status(201).json(await controllers.mergeTickets(req));
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  "/unmerge",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.unmergeTicket(req));
    } catch (err) {
      next(err);
    }
  },
);

/* ─────────────────────────────────────────────
   PROJECTS
───────────────────────────────────────────── */
router.get(
  "/projects",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getProjects(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/projects/mine",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getMyProjects(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/projects",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.status(201).json(await controllers.createProject(req));
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  "/projects/:prjid",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.updateProject(req));
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  "/projects/:prjid",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.deleteProject(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/projects/:prjid/users",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getProjectUsers(req));
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  "/projects/:prjid/users",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.setProjectUsers(req));
    } catch (err) {
      next(err);
    }
  },
);

/* ─────────────────────────────────────────────
   CATEGORIES & SOUS-CATÉGORIES
───────────────────────────────────────────── */
router.get(
  "/categories",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getCategories(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/categories/my",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getMyCategoriesByServices(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/categories",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.status(201).json(await controllers.createCategory(req));
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  "/categories/:catid",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.updateCategory(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/categories/:catid/sc1",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getSC1(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/categories/:catid/sc1",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.status(201).json(await controllers.createSC1(req));
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  "/categories/:catid/sc1/:sc1id",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.updateSC1(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/categories/sc1/:sc1id/sc2",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getSC2(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/categories/sc1/:sc1id/sc2",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.status(201).json(await controllers.createSC2(req));
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  "/categories/sc1/:sc1id/sc2/:sc2id",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.updateSC2(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/categories/sc2/:sc2id/sc3",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getSC3(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/categories/sc2/:sc2id/sc3",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.status(201).json(await controllers.createSC3(req));
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  "/categories/sc2/:sc2id/sc3/:sc3id",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.updateSC3(req));
    } catch (err) {
      next(err);
    }
  },
);

/* ─────────────────────────────────────────────
   SERVICES & ASSIGNMENTS
───────────────────────────────────────────── */
router.get(
  "/services",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getServices(req));
    } catch (err) {
      next(err);
    }
  },
);

// Gestion des services/membres (paramètres) : réservé aux profils
// gestionnaires (PRMNAM ∈ MODIFY_PERMS, cf. auth.middleware.js) — les
// consultations ci-dessus (services actifs, membres d'un service) restent
// ouvertes à tout utilisateur connecté (utilisées par le formulaire de
// ticket), seules la liste "administration" et les écritures sont
// restreintes.
router.get(
  "/services/all",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getAllServices(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/manager",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getManager(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/services",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.status(201).json(await controllers.createService(req));
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  "/services/:srvid",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.updateService(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/services/:srvid/members",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getServiceMembers(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/services/:srvid/members",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.status(201).json(await controllers.addServiceMember(req));
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  "/services/:srvid/members/:usrid",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.updateServiceMember(req));
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  "/services/:srvid/members/:usrid",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.removeServiceMember(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/statuses",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getStatuses(req));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/priorities",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getPriorities(req));
    } catch (err) {
      next(err);
    }
  },
);

/* ─────────────────────────────────────────────
   NOTES
───────────────────────────────────────────── */
router.post(
  "/note",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.status(201).json(await controllers.createNote(req));
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  "/note",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.updateNote(req));
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  "/note",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.deleteNote(req));
    } catch (err) {
      next(err);
    }
  },
);

/* ─────────────────────────────────────────────
   TODOS
───────────────────────────────────────────── */
router.get(
  "/todo",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getTodos(req));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/todo",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.status(201).json(await controllers.createTodo(req));
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  "/todo",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.updateTodo(req));
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  "/todo",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.deleteTodo(req));
    } catch (err) {
      next(err);
    }
  },
);

/* ─────────────────────────────────────────────
   SETTINGS — Préférences utilisateur (ticket + notifications mail)
───────────────────────────────────────────── */
router.get(
  "/settings",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.getMyUserSettings(req));
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  "/settings",
  authMiddlewares.authVerifyMiddleware,
  async (req, res, next) => {
    try {
      res.json(await controllers.updateMyUserSettings(req));
    } catch (err) {
      next(err);
    }
  },
);

export default router;
