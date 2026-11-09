#!/usr/bin/env node
/**
 * Déploie l'API sur le serveur de test ou de prod, sans monter la version
 * (même principe que scripts/deploy.mjs des fronts UNIS).
 *
 *   1. Vérifie qu'il n'y a pas de modifications non commitées
 *      (et, pour la prod, qu'on est sur main).
 *   2. Pousse la branche courante sur GitHub.
 *   3. Lance le workflow deploy.yml avec la cible et la branche : le runner
 *      auto-hébergé portant le label <cible> met à jour le dossier de l'API,
 *      fait npm install si besoin et redémarre l'API (PM2).
 *   4. Suit son exécution jusqu'à ce que l'API réponde avec un process neuf.
 *
 * Prérequis : GitHub CLI installée et connectée (gh auth login).
 *
 * Utilisation :
 *   npm run deploy        → node scripts/deploy.mjs prod   (depuis main uniquement)
 *   npm run deploy:test   → node scripts/deploy.mjs test   (branche courante)
 *   npm run deploy:all    → prod puis test
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const TARGETS = ['test', 'prod'];
const WORKFLOW = 'deploy.yml';
const WORKFLOW_REF = 'main'; // branche qui porte .github/workflows/deploy.yml
const TOTAL_STEPS = 4;

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectName = basename(projectDir);
const startedAt = Date.now();

// ── Mise en forme console ────────────────────────────────────
// Couleurs ANSI désactivées si la sortie n'est pas un terminal ou si NO_COLOR est défini.
const isTTY = Boolean(process.stdout.isTTY);
const useColor = isTTY && !process.env.NO_COLOR;
const sgr = (open, close) => (text) => (useColor ? `\x1b[${open}m${text}\x1b[${close}m` : String(text));
const c = {
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  red: sgr(31, 39),
  green: sgr(32, 39),
  yellow: sgr(33, 39),
  blue: sgr(34, 39),
  magenta: sgr(35, 39),
  cyan: sgr(36, 39),
  gray: sgr(90, 39),
  bgRed: sgr('41;97;1', '49;39;22'),
  bgGreen: sgr('42;30;1', '49;39;22'),
  bgYellow: sgr('43;30;1', '49;39;22'),
};

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const formatDuration = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
};

/** Encadré : lignes déjà colorées, bordure dans la couleur donnée. */
function box(lines, color = c.cyan) {
  const width = Math.max(...lines.map((l) => stripAnsi(l).length)) + 2;
  const pad = (l) => l + ' '.repeat(width - 1 - stripAnsi(l).length);
  console.log(color(`╭${'─'.repeat(width + 1)}╮`));
  for (const l of lines) console.log(`${color('│')} ${pad(l)} ${color('│')}`);
  console.log(color(`╰${'─'.repeat(width + 1)}╯`));
}

const targetBadge = (t) => (t === 'test' ? c.bgYellow(` ${t.toUpperCase()} `) : c.bgRed(` ${t.toUpperCase()} `));

// Spinner (terminal uniquement) : une ligne réécrite en place.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinner = null;
function startSpinner(text) {
  if (!isTTY) {
    console.log(c.gray(`    … ${text}`));
    return;
  }
  if (spinner) {
    spinner.text = text;
    return;
  }
  spinner = { text, frame: 0, since: Date.now() };
  spinner.timer = setInterval(() => {
    const f = SPINNER_FRAMES[spinner.frame++ % SPINNER_FRAMES.length];
    process.stdout.write(`\r\x1b[2K    ${c.cyan(f)} ${spinner.text} ${c.gray(formatDuration(Date.now() - spinner.since))}`);
  }, 80);
}
function setSpinnerText(text) {
  if (spinner) {
    if (spinner.text !== text) spinner.since = Date.now();
    spinner.text = text;
  } else startSpinner(text);
}
function stopSpinner() {
  if (!spinner) return;
  clearInterval(spinner.timer);
  process.stdout.write('\r\x1b[2K');
  spinner = null;
}
/** Affiche une ligne sans casser le spinner en cours. */
function println(line) {
  if (spinner) process.stdout.write('\r\x1b[2K');
  console.log(line);
}

let stepNumber = 0;
let stepStartedAt = 0;
function step(message) {
  stepNumber += 1;
  stepStartedAt = Date.now();
  console.log(`\n${c.cyan(c.bold(`[${stepNumber}/${TOTAL_STEPS}]`))} ${c.bold(message)}`);
}
const ok = (message) =>
  println(`    ${c.green('✔')} ${message} ${c.gray(`(${formatDuration(Date.now() - stepStartedAt)})`)}`);
const info = (message) => println(`    ${c.gray(message)}`);

function fail(message, details = []) {
  stopSpinner();
  console.error('');
  box(
    [`${c.bgRed(' ÉCHEC ')} ${c.red(c.bold(message))}`, ...(details.length ? ['', ...details] : [])],
    c.red,
  );
  console.error('');
  process.exit(1);
}

/** git dans le dossier du projet ; sortie renvoyée (pipe) ou affichée (inherit). */
const git = (args, { inherit = false } = {}) => {
  const out = execFileSync('git', args, { cwd: projectDir, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
  return out ? out.toString().trim() : '';
};

/** gh avec sortie texte ou JSON parsée. */
const gh = (args) => execFileSync('gh', args, { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const ghJson = (args) => JSON.parse(gh(args));

// ── Cible ────────────────────────────────────────────────────
const target = process.argv[2];
if (!TARGETS.includes(target)) fail(`Cible attendue : ${TARGETS.join(' ou ')} (reçu : ${target ?? 'rien'})`);

// ── Vérifications ────────────────────────────────────────────
if (!existsSync(join(projectDir, '.git'))) fail(`${projectDir} n'est pas un dépôt Git`);
if (!existsSync(join(projectDir, '.github', 'workflows', WORKFLOW))) fail(`.github/workflows/${WORKFLOW} introuvable`);

const { version } = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));

const dirty = git(['status', '--porcelain'])
  .split('\n')
  .filter((line) => line && !basename(line.slice(3).replace(/^"|"$/g, '')).startsWith('~$'));
if (dirty.length) {
  fail('Modifications non commitées', [
    ...dirty.map((l) => c.yellow(l)),
    '',
    c.gray('Commite-les (ou mets-les de côté) avant de déployer.'),
  ]);
}

const branch = git(['branch', '--show-current']);
if (!branch) fail('HEAD détachée : place-toi sur une branche avant de déployer.');
if (target === 'prod' && branch !== 'main') {
  fail(`La prod ne se déploie que depuis main (branche courante : ${branch}).`, [
    c.gray('Fusionne ta branche dans main, puis relance « npm run deploy » depuis main.'),
    c.gray('Pour tester ta branche : « npm run deploy:test ».'),
  ]);
}
const sha = git(['rev-parse', '--short', 'HEAD']);

console.log('');
box([
  `${c.bold('🚀 Déploiement API')}  ${targetBadge(target)}`,
  '',
  `${c.gray('Projet ')}  ${c.bold(projectName)} ${c.magenta(`v${version}`)}`,
  `${c.gray('Branche')}  ${c.blue(branch)} ${c.gray('@')} ${c.yellow(sha)}`,
]);

// ── 1. Contrôle de l'état local ──────────────────────────────
step('Vérification de la branche');
try {
  git(['fetch', 'origin', branch]);
  const behind = Number(git(['rev-list', '--count', `HEAD..origin/${branch}`]) || 0);
  if (behind > 0) {
    fail(`${branch} a ${behind} commit(s) de retard sur GitHub.`, [
      c.gray(`Récupère-les d'abord : git pull origin ${branch}`),
    ]);
  }
} catch {
  info(`Branche ${branch} absente de GitHub : elle sera créée.`);
}
ok(`${c.blue(branch)} à jour`);

// ── 2. Push des sources ──────────────────────────────────────
step(`Push de ${c.blue(branch)} sur GitHub`);
try {
  git(['push', 'origin', branch], { inherit: true });
} catch {
  fail(`Le push de ${branch} a échoué : rien n'a été déployé.`);
}
ok('Sources poussées');

// ── 3. Lancement du workflow ─────────────────────────────────
step(`Lancement du workflow ${c.gray(WORKFLOW)}`);

const listRuns = () =>
  ghJson(['run', 'list', '--workflow', WORKFLOW, '--event', 'workflow_dispatch', '--limit', '20', '--json', 'databaseId']);

// Runs déjà existants : le nouveau sera celui qui n'est pas dans cette liste.
let knownRunIds = null;
try {
  knownRunIds = new Set(listRuns().map((r) => r.databaseId));
} catch {
  // Le suivi sera simplement désactivé si gh ne répond pas ici.
}

try {
  gh(['workflow', 'run', WORKFLOW, '--ref', WORKFLOW_REF, '-f', `target=${target}`, '-f', `branch=${branch}`]);
} catch {
  fail('Impossible de lancer le workflow avec gh', [
    c.gray('gh est-elle installée et connectée ? « gh auth login »'),
    `Le code est poussé : lance-le à la main depuis`,
    c.cyan(`GitHub > Actions > Deploy > Run workflow (cible : ${target}, branche : ${branch})`),
  ]);
}
ok('Workflow déclenché');

// ── 4. Suivi jusqu'au redémarrage de l'API ───────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 3000;
const FIND_TIMEOUT_MS = 60_000; // délai max pour que GitHub crée le run
const RUN_TIMEOUT_MS = 20 * 60_000; // le job a un timeout de 15 min (+ attente du runner)

const STATUS_LABELS = {
  queued: 'En file d\'attente (runner disponible ?)',
  waiting: 'En attente',
  pending: 'En attente',
  requested: 'Demandé',
  in_progress: 'Démarrage du job',
};

// Étapes techniques de GitHub qu'on n'affiche pas.
const isNoiseStep = (name) => name === 'Set up job' || name === 'Complete job' || name.startsWith('Post ');

/** Lignes utiles du log du run (✅ et avertissements), sans l'horodatage GitHub. */
function runHighlights(runId) {
  try {
    return gh(['run', 'view', runId, '--log'])
      .split('\n')
      .map((l) => l.split('\t').slice(2).join('\t').replace(/^﻿?\S+Z /, '').trim())
      .filter((l) => !l.includes('Write-Host') && !l.includes('$'))
      .filter((l) => l.startsWith('✅') || l.startsWith('##[warning]') || l.startsWith('##[error]'))
      .map((l) => l.replace('##[warning]', '⚠ ').replace('##[error]', '✖ '));
  } catch {
    return [];
  }
}

async function followRun() {
  step(`Mise à jour sur le serveur ${targetBadge(target)}`);

  if (!knownRunIds) {
    info('Suivi impossible (gh ne répond pas). Voir : gh run watch  (ou l\'onglet Actions sur GitHub)');
    return;
  }

  startSpinner('Attente du démarrage du workflow');
  let run = null;
  const findDeadline = Date.now() + FIND_TIMEOUT_MS;
  while (!run && Date.now() < findDeadline) {
    await sleep(POLL_MS);
    try {
      const fresh = listRuns().find((r) => !knownRunIds.has(r.databaseId));
      if (fresh) run = fresh;
    } catch {
      /* nouvel essai */
    }
  }
  if (!run) fail(`Run introuvable après ${FIND_TIMEOUT_MS / 1000} s.`, [c.gray('Vérifie l\'onglet Actions sur GitHub.')]);

  const runId = String(run.databaseId);
  let runInfo = ghJson(['run', 'view', runId, '--json', 'url']);
  println(`    ${c.gray('↳')} ${c.cyan(c.dim(runInfo.url))}`);

  const printed = new Set(); // étapes déjà affichées comme terminées
  const runDeadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < runDeadline) {
    try {
      runInfo = ghJson(['run', 'view', runId, '--json', 'status,conclusion,jobs,url']);
    } catch {
      await sleep(POLL_MS);
      continue;
    }

    const steps = (runInfo.jobs?.[0]?.steps ?? []).filter((s) => !isNoiseStep(s.name));
    for (const s of steps) {
      if (s.status !== 'completed' || printed.has(s.number ?? s.name)) continue;
      printed.add(s.number ?? s.name);
      const icon =
        s.conclusion === 'success' ? c.green('✔') : s.conclusion === 'skipped' ? c.gray('○') : c.red('✖');
      println(`    ${icon} ${s.conclusion === 'skipped' ? c.gray(s.name) : s.name}`);
    }

    if (runInfo.status === 'completed') break;

    const current = steps.find((s) => s.status === 'in_progress');
    setSpinnerText(current ? current.name : STATUS_LABELS[runInfo.status] ?? runInfo.status);
    await sleep(POLL_MS);
  }
  stopSpinner();

  if (runInfo.status !== 'completed') {
    fail(`Toujours pas terminé après ${RUN_TIMEOUT_MS / 60_000} min.`, [c.cyan(runInfo.url)]);
  }

  const highlights = runHighlights(runId);
  const time = new Date().toLocaleTimeString('fr-FR');
  const total = formatDuration(Date.now() - startedAt);
  if (runInfo.conclusion === 'success') {
    process.stdout.write('\x07'); // bip sonore du terminal
    console.log('');
    box(
      [
        `${c.bgGreen(' EN LIGNE ')} ${c.green(c.bold(`API redémarrée sur le serveur ${target}`))}`,
        '',
        ...highlights.map((l) => (l.startsWith('⚠') ? c.yellow(l) : l)),
        ...(highlights.length ? [''] : []),
        `${c.gray('Heure')}  ${time}  ${c.gray(`(durée totale : ${total})`)}`,
      ],
      c.green,
    );
    console.log('');
  } else {
    const failedStep = runInfo.jobs?.flatMap((j) => j.steps ?? []).find((s) => s.conclusion === 'failure');
    process.stdout.write('\x07');
    fail(`Déploiement ${target} en échec (${runInfo.conclusion}) à ${time}`, [
      ...highlights.filter((l) => !l.startsWith('✅')).map((l) => c.red(l)),
      ...(failedStep ? [`${c.gray('Étape  ')}  ${c.red(failedStep.name)}`] : []),
      `${c.gray('Détails')}  ${c.cyan(runInfo.url)}`,
      `${c.gray('Logs   ')}  gh run view ${runId} --log-failed`,
    ]);
  }
}

await followRun();
