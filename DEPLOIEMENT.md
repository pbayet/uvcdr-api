# Procédure de mise en production — API UVCDR

Ce document décrit comment faire évoluer l'API, du développement en local jusqu'à la mise en production.

- **Code** : dépôt Git `https://github.com/pbayet/uvcdr-api.git`
- **Branche `main`** : ce qui est en prod ou prêt à y partir
- **Branches `feat/...`** : travail en cours
- **Versions** : chaque mise en prod correspond à un tag `vX.Y.Z` créé par `npm run release`

---

## Mise en place initiale du serveur de prod (une seule fois)

### Dossier de prod vide

```bash
git clone https://github.com/pbayet/uvcdr-api.git .
```

Le `.` final clone dans le dossier courant, sans créer de sous-dossier `uvcdr-api`.

### Dossier de prod existant (ancienne API copiée à la main)

> ⚠️ Fais d'abord une **copie complète du dossier**. `git reset --hard` écrase les fichiers suivis par Git.

```bash
git init
git remote add origin https://github.com/pbayet/uvcdr-api.git
git fetch origin --tags
git reset --hard origin/main
```

Les fichiers ignorés par Git ne sont pas touchés : `.env`, `uploads/`, `logs/`, `node_modules/`.

### Vérifications

- Le `.env` de prod est présent à la racine.
- `git status` affiche « nothing to commit ».
- Dans `ecosystem.prod.config.cjs`, `watch` vaut **`["restart.trigger"]`** et jamais `true`. Sinon, PM2 redémarre l'API en plein `git pull`.

---

## Mise à jour de la prod (à chaque modification)

### En local (VS Code)

**1. Crée une branche pour la modification :**

```bash
git checkout -b feat/ma-modif
```

Développe et teste contre la base de dev, puis commite :

```bash
git add .
git commit -m "feat: description de la modif"
```

**2. Si la modification touche la base de données**, écris le script SQL dans un fichier daté et commite-le avec le code :

```
scripts/sql/AAAA-MM-JJ_description.sql
```

Si possible, écris des scripts qui peuvent être relancés sans erreur (`IF NOT EXISTS`, `IF COL_LENGTH(...) IS NULL`, etc.).

**3. Fusionne dans `main` quand c'est prêt pour la prod :**

```bash
git checkout main
git pull origin main
git merge feat/ma-modif
```

**4. Crée la version** (numéro, tag, push sur GitHub) :

```bash
npm run release
```

**5. Déploie** :

```bash
npm run deploy
```

Le script pousse `main`, lance le workflow GitHub et suit son exécution jusqu'au redémarrage de l'API (voir « Déploiement (npm run deploy) » plus bas). Pour tester une branche sur le serveur de test avant de la fusionner : `npm run deploy:test` depuis cette branche.

### Sur le serveur de prod

> Les étapes ci-dessous sont faites par `npm run deploy`. Seule l'étape 7 (scripts SQL) reste manuelle : le déploiement affiche un avertissement listant les scripts à appliquer.
>
> Procédure manuelle, si le runner est arrêté :

**5. Récupère le code :**

```bash
git pull origin main
```

**6. Installe les dépendances :**

```bash
npm ci
```

Utilise `npm install` si `package-lock.json` n'est pas suivi par Git.

**7. Applique les scripts SQL de la version** sur la base de prod. Pour lister ceux ajoutés depuis la version précédente (remplace `vA.B.C` par celle qui tournait avant) :

```bash
git diff vA.B.C..HEAD --stat -- scripts/sql
```

**8. Redémarre l'API :**

```bash
pm2 reload "UVCDR API PROD"
```

**9. Contrôle :**

```bash
pm2 logs "UVCDR API PROD"
```

Vérifie que l'API démarre sans erreur et teste un ou deux appels.

---

## Déploiement (npm run deploy)

Rien n'est déployé automatiquement sur push : comme pour les fronts, le déploiement se lance depuis le PC de dev.

| Commande | Cible | Branche déployée |
|---|---|---|
| `npm run deploy` | prod (VM-APPS, runner `prod`) | `main` uniquement |
| `npm run deploy:test` | test (VM-DEV, runner `test`) | branche courante |
| `npm run deploy:all` | prod puis test | `main` |

[scripts/deploy.mjs](scripts/deploy.mjs) vérifie qu'il n'y a pas de modifications non commitées, pousse la branche, lance le workflow [.github/workflows/deploy.yml](.github/workflows/deploy.yml) (`gh workflow run`) et suit son exécution. Prérequis : GitHub CLI connectée (`gh auth login`). Le workflow peut aussi être lancé à la main : **Actions > Deploy > Run workflow**.

Sur le serveur, le runner auto-hébergé de la cible met à jour le dossier de l'API (prod : `main` en fast-forward ; test : la branche demandée), lance `npm install` si `package.json` a changé, puis réécrit `restart.trigger`. PM2 surveille ce seul fichier (`watch` dans `ecosystem.<cible>.config.cjs`) et redémarre l'API. Le runner attend ensuite que `/api/test` réponde avec un **process neuf**. Il n'appelle jamais `pm2` : il tourne sous SERVICE RÉSEAU, sans mot de passe. La console affiche à la fin :

```
✅ API redémarrée (PID 1234 → 5678)
✅ API à jour et en ligne : v1.1.3 [production] — main @ ae8dac7
```

En cas d'échec, le run passe au rouge et affiche les dernières lignes des fichiers de `logs/errors` et `logs/success`.

### Installation du runner (une seule fois, sur chaque serveur)

Le script [scripts/install-runner.ps1](scripts/install-runner.ps1) fait tout (même principe que pour les fronts).

1. Sur GitHub : **Settings > Actions > Runners > New self-hosted runner > Windows x64**. Note le **jeton**, la **version** et le **SHA-256** affichés.
2. Sur le serveur, ouvre PowerShell **en tant qu'administrateur** (n'importe quel compte admin).
3. Renseigne le haut du script (`$apiDir`, `$label` = `prod` sur VM-APPS ou `test` sur VM-DEV, `$token`, `$version`, `$sha256`), puis colle-le dans la console ou lance-le. Il installe le service sous SERVICE RÉSEAU, donne à ce compte le droit de modifier le dossier de l'API (`icacls`) et l'autorise dans Git (`safe.directory`). `git`, `node` et `npm` doivent être dans le PATH **système** : le script le vérifie.
4. Le chemin de l'API est écrit dans `C:\actions-runners\uvcdr-api\.env` (`API_DIR=...`) : rien à configurer côté GitHub.
5. Le dépôt est **public** : dans **Settings > Actions > General**, choisis *Require approval for all external contributors* pour qu'une pull request venant d'un fork ne puisse pas exécuter de code sur le serveur. Le plus sûr reste de passer le dépôt en **privé**.
6. Avec le compte qui fait tourner PM2, recharge PM2 depuis le fichier de config pour qu'il surveille `restart.trigger` (un `pm2 reload` seul garde l'ancienne config) :

```bash
pm2 delete "UVCDR API PROD"
pm2 start ecosystem.prod.config.cjs
pm2 save
```

Sur le serveur de test, même chose avec `ecosystem.test.config.cjs` (process « UVCDR API TEST », `NODE_ENV=development`), après avoir arrêté l'ancien process de l'API.

7. Teste depuis le PC de dev : `npm run deploy` (prod) ou `npm run deploy:test` (test).

### Supprimer le runner

Dans PowerShell administrateur, avec un jeton de suppression (**Settings > Actions > Runners > le runner > Remove**) :

```powershell
cd C:\actions-runners\uvcdr-api
.\config.cmd remove --token XXXXXXXXXXXXXXXXXXXX
```

---

## Retour arrière (rollback)

En cas de problème après une mise en prod, reviens à la version précédente :

```bash
git checkout vA.B.C
npm ci
pm2 reload "UVCDR API PROD"
```

> Les scripts SQL déjà appliqués **ne sont pas annulés** par ce retour arrière : défais-les à la main si nécessaire.

Pour revenir ensuite sur la dernière version :

```bash
git checkout main
git pull origin main
```

---

## Commandes utiles

| Besoin | Commande |
|---|---|
| Voir les fichiers modifiés depuis une version | `git diff vA.B.C..HEAD --stat` |
| Voir les commits depuis une version | `git log vA.B.C..HEAD --oneline` |
| Voir la version actuellement en prod | `git describe --tags` |
| Lister les versions | `git tag --sort=-v:refname` |
| Annuler une modif locale de fichier en prod | `git checkout -- <fichier>` |

---

## Règles à respecter

- **Ne jamais modifier de code directement sur la prod.** Toute modification passe par le local, puis Git.
- **Ne jamais commiter `.env`**, `uploads/` ou `logs/`. Ils sont déjà dans le `.gitignore`.
- **Un script SQL de prod est toujours commité** avec le code qui en dépend.
- **Toujours déployer depuis `main`**, après `npm run release`.
