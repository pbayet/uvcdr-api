#!/usr/bin/env node
/**
 * Monte la version de l'API.
 *
 *   1. Vérifie l'état Git (pas de modifications en attente, pas de retard sur GitHub).
 *   2. Archive la version actuelle (npm run archive).
 *   3. Propose un nouveau numéro, à accepter ou modifier.
 *   4. Met à jour le numéro dans :
 *        - package.json et package-lock.json
 *        - le titre du README.md (« V1.1.0 » ou « (v1.1.0) »)
 *   5. Commit « chore(release): vX.Y.Z », tag vX.Y.Z, push sur GitHub.
 *
 * Pas de publication sur l'API : c'est l'API elle-même.
 *
 * Utilisation : npm run release
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectName = basename(projectDir);
const rl = createInterface({ input: process.stdin, output: process.stdout });

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  rl.close();
  process.exit(1);
}

const run = (cmd, opts = {}) =>
  execSync(cmd, { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'], ...opts })?.toString().trim();
const tryRun = (cmd) => {
  try {
    return run(cmd);
  } catch {
    return null;
  }
};
const isYes = (answer, defYes) => (answer.trim() === '' ? defYes : /^(o|oui|y|yes)$/i.test(answer.trim()));

// ── Version actuelle ─────────────────────────────────────────
const current = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')).version;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
if (!SEMVER.test(current ?? '')) fail(`Version actuelle invalide dans package.json : "${current}"`);

// ── 1. État Git ──────────────────────────────────────────────
if (!existsSync(join(projectDir, '.git'))) fail('Pas de dépôt Git dans le projet.');
const branch = run('git branch --show-current');
const hasRemote = !!tryRun('git remote get-url origin');

const pending = run('git status --porcelain')
  .split('\n')
  .filter(Boolean)
  .filter((line) => !basename(line.slice(3).replace(/^"|"$/g, '')).startsWith('~$'));
if (pending.length) {
  fail(`Modifications non commitées — commite-les avant de monter la version :\n  ${pending.join('\n  ')}`);
}

if (hasRemote) {
  tryRun('git fetch -q origin');
  const behind = tryRun(`git rev-list --count HEAD..origin/${branch}`);
  if (behind && behind !== '0') fail(`La branche ${branch} a ${behind} commit(s) de retard sur GitHub : fais un git pull d'abord.`);
}

if (branch !== 'main') {
  const ok = await rl.question(`⚠ Tu es sur la branche "${branch}" et non "main". Continuer ? (o/N) `);
  if (!isYes(ok, false)) fail('Annulé.');
}

// ── 2. Archive de la version actuelle ────────────────────────
console.log(`\n${projectName} — version actuelle : ${current}`);
try {
  execSync('npm run archive --silent', { cwd: projectDir, stdio: 'inherit' });
} catch {
  fail("L'archivage a échoué : version non modifiée.");
}

// ── 3. Choix de la nouvelle version ──────────────────────────
const [maj, min, pat] = current.match(SEMVER).slice(1).map(Number);
const proposals = {
  patch: `${maj}.${min}.${pat + 1}`,
  minor: `${maj}.${min + 1}.0`,
  major: `${maj + 1}.0.0`,
};
const isGreater = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

console.log(`\n  patch → ${proposals.patch}   (correctifs)`);
console.log(`  minor → ${proposals.minor}   (nouvelles fonctionnalités)`);
console.log(`  major → ${proposals.major}   (changements majeurs)\n`);

let next;
for (;;) {
  const answer = (await rl.question(`Nouvelle version [${proposals.patch}] : `)).trim().replace(/^v/i, '');
  next = answer === '' ? proposals.patch : proposals[answer.toLowerCase()] ?? answer;
  if (!SEMVER.test(next)) {
    console.log('  Format attendu : X.Y.Z, ou patch / minor / major.');
    continue;
  }
  if (!isGreater(next, current)) {
    console.log(`  La nouvelle version doit être supérieure à ${current}.`);
    continue;
  }
  if (tryRun(`git rev-parse -q --verify refs/tags/v${next}`)) {
    console.log(`  Le tag v${next} existe déjà.`);
    continue;
  }
  break;
}

// ── 4. Mise à jour des fichiers ──────────────────────────────
const changed = [];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oldEsc = escape(current);

function update(file, transform) {
  const path = join(projectDir, file);
  if (!existsSync(path)) return;
  const before = readFileSync(path, 'utf8');
  const after = transform(before);
  if (after !== before) {
    writeFileSync(path, after);
    changed.push(file);
  }
}

update('package.json', (t) => t.replace(new RegExp(`("version"\\s*:\\s*")${oldEsc}(")`), `$1${next}$2`));

update('package-lock.json', (t) => {
  let n = 0;
  const out = t.replace(new RegExp(`("version"\\s*:\\s*")${oldEsc}(")`, 'g'), (m, a, b) =>
    ++n <= 2 ? `${a}${next}${b}` : m,
  );
  const lock = JSON.parse(out);
  if (lock.version !== next || lock.packages?.['']?.version !== next) {
    fail('package-lock.json : structure inattendue. Arrêt (package.json est peut-être déjà modifié : vérifie avec git status).');
  }
  return out;
});

// README.md : uniquement la ligne de titre (les mentions historiques restent).
update('README.md', (t) => {
  const eol = t.indexOf('\n');
  const title = eol === -1 ? t : t.slice(0, eol);
  const newTitle = title.replace(new RegExp(`\\b([vV])${oldEsc}\\b`), `$1${next}`);
  return newTitle + (eol === -1 ? '' : t.slice(eol));
});

const tracked = changed.filter((f) => tryRun(`git ls-files -- "${f}"`));
console.log(`\n${current} → ${next}`);
for (const f of changed) console.log(`  ✎ ${f}${tracked.includes(f) ? '' : '  (ignoré par Git, non commité)'}`);

// ── 5. Commit, tag, push ─────────────────────────────────────
const steps = [`commit + tag v${next}`];
if (hasRemote) steps.push(`push sur GitHub (${branch})`);
const confirm = await rl.question(`\nValider : ${steps.join(' + ')} ? (O/n) `);
rl.close();
if (!isYes(confirm, true)) {
  console.log("\nArrêté avant le commit : les fichiers sont modifiés mais rien n'est commité.\n");
  process.exit(0);
}

if (!tracked.length) fail('Aucun fichier suivi par Git ne contient la version : rien à commiter.');
const paths = tracked.map((f) => `"${f}"`).join(' ');
run(`git add -- ${paths}`);
run(`git commit -q -m "chore(release): v${next}" -- ${paths}`);
run(`git tag -a v${next} -m "${projectName} v${next}"`);
console.log(`✔ Commit et tag v${next} créés`);

if (hasRemote) {
  try {
    run(`git push -q origin ${branch} --follow-tags`);
    console.log('✔ Poussé sur GitHub');
  } catch (e) {
    fail(`Le push a échoué (commit et tag sont en local) :\n${e.stderr?.toString() ?? e.message}\nRelance : git push origin ${branch} --follow-tags`);
  }
}
console.log(`\n🎉 ${projectName} est en v${next}\n`);
