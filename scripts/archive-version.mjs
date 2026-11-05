#!/usr/bin/env node
/**
 * Archive la version en cours de l'API.
 *
 * Copie le projet vers :
 *   <dossier parent>/_archives/<nom du dossier>/V<version du package.json>
 *   (ex. BACKs/APIs/_archives/UNIS API/V1.1.0)
 * Si cette archive existe déjà, elle est supprimée puis recréée (écrasement).
 *
 * Exclus : node_modules, .git, package-lock.json, logs, tmp, uploads (fichiers des utilisateurs),
 * coverage, loadtest/reports et fichiers verrous Office (~$*).
 *
 * Utilisation : npm run archive
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectName = basename(projectDir);
const archivesRoot = join(dirname(projectDir), '_archives');

// Chemins exclus, relatifs à la racine du projet.
const EXCLUDED_PATHS = new Set([
  'node_modules',
  '.git',
  'package-lock.json',
  'logs',
  'tmp',
  '.tmp',
  '.temp',
  'uploads',
  'coverage',
  join('loadtest', 'reports'),
]);
const isExcluded = (src) => {
  const rel = relative(projectDir, src);
  return EXCLUDED_PATHS.has(rel) || basename(src) === 'node_modules' || basename(src).startsWith('~$');
};

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
if (!version) fail('Pas de champ "version" dans package.json');

const target = join(archivesRoot, projectName, `V${version}`);
if (!target.startsWith(archivesRoot + sep)) fail(`Chemin d'archive invalide : ${target}`);

// Avertissements Git (non bloquants)
const git = (cmd) => {
  try {
    return execSync(`git ${cmd}`, { cwd: projectDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
};
if (existsSync(join(projectDir, '.git'))) {
  const dirty = (git('status --porcelain') ?? '')
    .split('\n')
    .filter((line) => line && !basename(line.slice(3).replace(/^"|"$/g, '')).startsWith('~$'));
  if (dirty.length) console.warn('⚠ Modifications non commitées : elles seront archivées telles quelles.');
  if (!git(`rev-parse -q --verify refs/tags/v${version}`)) {
    console.warn(`⚠ Le tag v${version} n'existe pas (les prochaines versions seront taguées par "npm run release").`);
  }
}

console.log(`\n${projectName} v${version}`);
console.log(`→ ${relative(dirname(projectDir), target)}`);

if (existsSync(target)) {
  console.log('  Archive existante : écrasement…');
  rmSync(target, { recursive: true, force: true });
}
mkdirSync(target, { recursive: true });

const started = Date.now();
cpSync(projectDir, target, { recursive: true, filter: (src) => src === projectDir || !isExcluded(src) });
console.log(`✔ Archivé en ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
