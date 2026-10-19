import winston from "winston";
import "winston-daily-rotate-file";
import path from "path";
import fs from "fs";

const production = process.env.NODE_ENV === "production";

// NODE_ENV=test (suite Vitest) : ni fichiers de logs rotatifs, ni sortie
// console — la suite de tests ne doit ni polluer stdout ni écrire sur disque
// (utile aussi sur les montages réseau où la rotation/suppression de fichiers
// peut échouer). Comportement dev/prod inchangé.
const isTest = process.env.NODE_ENV === "test";

const logDir = path.resolve("logs");
const errorDir = path.join(logDir, "errors");
const successDir = path.join(logDir, "success");

if (!isTest) {
  for (const dir of [logDir, errorDir, successDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  // Retire les codes ANSI (cf. core/utils/logs.utils.js `ansi`/`colorize`/`banner`,
  // utilisés notamment pour les logs d'initialisation DB) : sans ça, les
  // fichiers de logs contiendraient des séquences d'échappement illisibles.
  winston.format.uncolorize(),
  winston.format.printf(
    ({ level, message, timestamp }) =>
      `${timestamp} [${level.toUpperCase()}] ${message}`,
  ),
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf(
    ({ level, message, timestamp }) => `${timestamp} [${level}] ${message}`,
  ),
);

// Rotation quotidienne + limite de taille + rétention (cf. audit poids/disque 2.2) :
// remplace l'ancien winston.transports.File sans maxsize/maxFiles qui grossissait indéfiniment.
const transports = isTest
  ? [new winston.transports.Console({ format: consoleFormat, silent: true })]
  : [
      new winston.transports.DailyRotateFile({
        dirname: errorDir,
        filename: "errors_%DATE%.log",
        datePattern: "YYYY-MM-DD",
        level: "error",
        maxSize: "20m",
        maxFiles: "14d",
        format: fileFormat,
      }),
      new winston.transports.DailyRotateFile({
        dirname: successDir,
        filename: "output_%DATE%.log",
        datePattern: "YYYY-MM-DD",
        level: "info",
        maxSize: "20m",
        maxFiles: "14d",
        format: fileFormat,
      }),
    ];

transports.push(new winston.transports.Console({ format: consoleFormat }));

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (production ? "warn" : "debug"),
  exitOnError: false,
  transports,
});
