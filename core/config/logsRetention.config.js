/**
 * Durée de rétention des logs, partagée par :
 *   - config/logger.config.js (maxFiles des fichiers rotatifs winston) ;
 *   - core/services/logsPurge.service.js (purge planifiée de logs/ et des
 *     tables GENERALACTIVITY.USERSACTIVITY / USERSMANAGER.LOGINHISTORY).
 *
 * Par défaut : 1 an (365 j) en production, 2 mois (60 j) ailleurs (dev/test).
 * Surchargeable via LOGS_RETENTION_DAYS (entier > 0).
 *
 * Fichier volontairement sans import : il est chargé par logger.config.js,
 * lui-même importé par quasiment tout le reste.
 */
export const PROD_LOGS_RETENTION_DAYS = 365;
export const DEV_LOGS_RETENTION_DAYS = 60;

export function getLogsRetentionDays(env = process.env) {
  const override = Number(env.LOGS_RETENTION_DAYS);
  if (Number.isInteger(override) && override > 0) return override;

  return env.NODE_ENV === "production"
    ? PROD_LOGS_RETENTION_DAYS
    : DEV_LOGS_RETENTION_DAYS;
}
