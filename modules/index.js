import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

import { logger } from "../config/logger.config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Charge automatiquement les routes de chaque module dans /modules
 * Exemple : /modules/ticketing/routes.js → /api/ticketing/
 */
export const loadModules = async (app) => {
  const modules = fs
    .readdirSync(__dirname, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const dirent of modules) {
    const moduleName = dirent.name;
    const modulePath = path.join(__dirname, moduleName);
    const routeFile = path.join(modulePath, "routes.js");

    if (!fs.existsSync(routeFile)) continue;

    logger.info(
      `[START] [LOADING ROUTE] | ${moduleName} | /${process.env.API_BASE_ROUTE}/${moduleName}`,
    );

    const fileUrl = pathToFileURL(routeFile).href;

    try {
      const route = await import(fileUrl);

      if (!route?.default) {
        logger.error(
          `[ERROR] [LOADING ROUTE] | ${moduleName} | routes.js ne contient pas d'export default.`,
        );
        continue;
      }

      app.use(`/${process.env.API_BASE_ROUTE}/${moduleName}`, route.default);
      logger.info(
        `[COMPLETE] [LOADING ROUTE] | ${moduleName} | /${process.env.API_BASE_ROUTE}/${moduleName}`,
      );
    } catch (err) {
      logger.error(`[ERROR] [LOADING ROUTE] ${moduleName} | ${err.message}`);
    }
  }
};
