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
- Dans `ecosystem.prod.config.cjs`, `watch` vaut **`false`**. Sinon, PM2 redémarre l'API en plein `git pull`.

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

### Sur le serveur de prod

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
