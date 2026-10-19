# API UVCDR — V1.1.0 (reconstruction ciblée : ticketing + declcav)

Reconstruction de l'API sur la base de l'audit technique du 02/07/2026
(`Audit_API_UVCDR.docx`). Cette itération couvre les applications
**ticketing** et **declcav** (déclarations de cave), ainsi que le socle
strictement nécessaire à leur fonctionnement, pour éviter de tout
reconstruire d'un coup. Les autres applications (fsa, dwhbi, journal,
x3v12) resteront sur V1.0.0 jusqu'à leur propre reconstruction.

## Périmètre inclus

- **ticketing** : tickets, catégories/sous-catégories, services et
  affectations, statuts, priorités, notes. Temps réel via WebSocket
  (événements légers, cf. plus bas).
- **usersmanager (minimal)** : uniquement le lookup utilisateur/permissions
  nécessaire à l'authentification (`GET /api/usersmanager/me`). Les écrans
  d'admin RH (groupes, positions, applications, upserts...) ne sont pas
  reconstruits.
- **files (attachments)** : upload/suppression de pièces jointes, utilisées
  par les tickets et leurs notes. Signature numérique HMAC-SHA256
  (`POST /api/files/:filecode/sign`, `GET /api/files/:filecode/signatures`,
  `GET /api/files/signatures/:sigid/verify`,
  `DELETE /api/files/signatures/:sigid`) — cf.
  `modules/files/sql/ATTACHMENTSIGNATURES.table.sql` et
  `core/services/attachmentSigning.service.js`.
- **auth** : login LDAP (`POST /api/auth`) et login "cave" (même route,
  `appcode: "DCLING"` — cf. juste en dessous), vérification de session
  (`GET /api/auth/verify`).
- **declcav** : déclarations de cave (MRV), rectifications, caves et leurs
  emails de contact, ingrédients/cépages, types de cave, questionnaires
  (soumission/validation/refus), relances. Notifications par mail via le
  service générique `core/services/mail.service.js` (mêmes templates HTML
  que ticketing — voir "Correctifs" ci-dessous). L'authentification "cave"
  (login direct avec `CAVE.PASSHSH`, sans passer par LDAP/usersmanager) a été
  réintroduite dans `core/middlewares/auth.middleware.js` : `POST /api/auth`
  avec `{ email, password, appcode: "DCLING" }` vérifie le mot de passe via
  `getCavesPW` (`modules/declcav/services.js`) et `verifyPassword` (Argon2),
  puis émet un JWT (permission `USER`, `PRMLVL 4`). `authVerifyMiddleware`
  reconnaît ce token (`payload.application === "DCLING"`) et re-vérifie que
  la cave existe toujours en base plutôt que de la chercher dans
  `USERSMANAGER` (où elle n'existe pas).
- **dwhbi** : lecture seule sur l'entrepôt de données Power BI (clients,
  pays, vrac, contenants/nomenclature Matières Sèches). Repris à l'identique
  de V1.0.0 (`services.js`/`utils.js` inchangés), à une différence près :
  toutes les routes sont désormais protégées par `authVerifyMiddleware` (en
  V1.0.0, `authMiddlewares` était importé dans `routes.js` mais jamais
  appliqué — les endpoints étaient accessibles sans authentification).

- **vinidoc** : fiches œnologiques multilingues (code vrac + millésime),
  workflow de validation marketing, modèles PowerPoint avec longueur max par
  balise, génération des fiches techniques PPTX/PDF (LibreOffice ou
  PowerPoint). Base `VINIDOC` (`modules/vinidoc/sql/VINIDOC.tables.sql`) —
  documentation complète : `modules/vinidoc/README.md`.

## Périmètre volontairement exclu (à reconstruire plus tard si besoin)

- Émails (`modules/emails`), FSA, journal, x3v12.
- `loginDevMiddleware` / `loginAppMiddleware` (impersonation / échange de
  token multi-application) — spécifiques à un portail multi-app, hors
  périmètre "ticketing only".
- Les endpoints `/logs`, `/flatten/logs` de V1.0.0 (qui référençaient en dur
  des chemins Windows `E:/API/logs/...`). La journalisation d'activité en
  base (table `USERSACTIVITY`), elle, est bien reconstruite — voir
  "Journalisation d'activité" ci-dessous.
- Le module `base` (gabarit de génération de nouveau module) et
  `create-app.js`.

## Journalisation d'activité

Chaque requête mutante (POST/PUT/PATCH/DELETE) jugée pertinente est
journalisée dans la table `USERSACTIVITY` de la base `generalactivity`
(succès **et** échec), en plus des logs winston rotatifs :

- `core/config/activityLog.config.js` liste les routes suivies
  (`ROUTES_TO_SAVE_IN_BASE` : méthode, chemin monté, code applicatif,
  libellé). Ajouter une route à journaliser ne demande qu'une entrée ici.
- `core/middlewares/log.middleware.js` (`saveLogInBase`) fait le matching
  (méthode + pathname, query string ignorée — `generateRoutePattern()` dans
  `core/utils/logs.utils.js`) et appelle `postActivityStats`
  (`modules/usersmanager/services.js`) en cas de succès ; en cas d'échec,
  c'est `core/middlewares/error.middleware.js` qui l'appelle avec le détail
  de l'erreur.
- Cet appel est volontairement fire-and-forget (jamais `await`é par le
  gestionnaire de requête, pour ne jamais retarder la réponse HTTP) et ne
  lève jamais : toute erreur d'écriture (base indisponible, etc.) est
  uniquement loguée via winston.
- `getGeneralActivity`/`getUserActivity` (exposées via
  `GET /api/usersmanager/global/activity` et `.../user/activity`)
  permettent de relire cette activité.

## Correctifs de l'audit appliqués dans cette reconstruction

**Sécurité**
- Plus aucun `console.log` d'identifiants (SQL, mots de passe cave). En
  particulier, `declcav/controllers.js` loguait en clair (mot de passe cave
  généré, listes de destinataires, indicateur `IS_PROD`) à chaque
  régénération de mot de passe ou envoi de notification — supprimé. La
  branche de login "cave" réintroduite dans `auth.middleware.js` (voir
  ci-dessus) suit la même règle : ni email ni mot de passe cave ne sont
  jamais journalisés, y compris en cas d'échec.
- L'ancien mécanisme `BYPASS_EMAILS` de V1.0.0 (identifiants de test en
  clair dans le code source de `auth.middleware.js`, contournant
  entièrement LDAP) n'a volontairement PAS été repris ici : c'est une porte
  dérobée permanente tant que le code n'est pas retiré avant mise en
  production. À proscrire définitivement.
- `authVerifyMiddleware` re-vérifie désormais la permission de l'utilisateur
  contre l'état actuel en base à chaque requête (mise en cache 5 min pour
  limiter le coût), au lieu de faire uniquement confiance au contenu du JWT
  jusqu'à son expiration naturelle.
- `express-rate-limit` est branché (`config/rateLimit.config.js`) : limiteur
  général sur `/api` + limiteur renforcé sur `/api/auth`.
- Login passé en `POST` (les identifiants ne circulent plus en query string).
- Les destinataires des notifications mail liées à une cave (`declcav`)
  viennent désormais uniquement de `CAVEMAIL` en base, plus jamais d'un
  champ fourni par le client dans le corps de la requête.

**Poids / disque**
- Le cron de purge de `tmp/` (déjà planifié en V1.0.0 mais avec un callback
  vide) supprime réellement les fichiers de plus de `TMP_RETENTION_DAYS`
  jours (`modules/files/config/module.config.js`).
- Logs rotatifs via `winston-daily-rotate-file` (20 Mo / 14 jours), console
  désactivée en production.
- Dépendances npm inutilisées supprimées (`axios`, `bcrypt`, `bcryptjs`,
  `commander`, `formidable`, `fs-extra`, `morgan`, `natural`,
  `accept-language-parser`, toute la chaîne TypeScript non utilisée,
  `nodemailer` — module emails non reconstruit).
- `.gitignore` corrigé pour couvrir `tmp/` (sans le point).

**Performance**
- Les pools SQL sont mutualisés par `(host + base)` au lieu d'un pool par
  fichier de config (`config/db/index.js`) — `max` réduit de 30 à 10 par
  pool physique.
- Le N+1 identifié dans `ticketing/controllers.js` (recalcul du ticket par
  destinataire pour le WebSocket) est éliminé : le temps réel diffuse
  désormais un événement léger (IDs uniquement) à tous les clients connectés,
  qui re-fetchent eux-mêmes si besoin.
- Chemins portables (plus de `E:/API/...` en dur).

**Dette technique**
- Le motif répété "connexion → prepared statement → execute → check vide"
  est remplacé par un helper unique `runQuery()`
  (`core/utils/db.utils.js`), utilisé par tous les services.
- Les fichiers `config/db/*.db.config.js` sont réduits à un appel de
  `makeConnectionConfigGetter()` (`core/utils/dbConfigFactory.js`) au lieu
  de dupliquer ~30 lignes par module.
- `models.js` (vide dans les 10 modules de V1.0.0) n'a pas été recréé.
- Validation d'entrée via `zod` (`modules/ticketing/validators.js`,
  `modules/files/utils.js`) au lieu des `if (!x) throw new Error(...)`
  manuels répétés.
- Bug corrigé : une pièce jointe de note perdait son `ID` (`row.NNATTID` au
  lieu de `row.NATTID`) dans `ticketing/utils.js`.
- Bug corrigé : une erreur avec `err.status` explicite (ex: ticket 404)
  retombait à tort en 500 générique côté `error.middleware.js`, faute de
  correspondance dans le registre d'erreurs.
- Bug corrigé (`declcav`) : `setRectification`/`setMrvIngredients`
  enregistraient systématiquement `CREUSR`/`MLOPER` codés en dur (`"BAYET
  Paul"` / `"p.bayet@union-vignerons.com"`) dans le SQL, quel que soit
  l'utilisateur réellement connecté — toute rectification/MRV était donc
  tracée en base comme faite par un seul et même compte. Ces valeurs sont
  désormais fournies par le contrôleur à partir de l'identité JWT
  (`req.payload.data`), comme le faisait déjà correctement `setDeclaration`.
- Bug corrigé (`declcav`) : `delsertMails(CAVEID, MAILS, CREUSR)` était
  appelée sans son 3ᵉ argument par le contrôleur `upsertCave` — `CREUSR`
  valait `undefined` et était silencieusement inséré `NULL` en base.
- Bug corrigé (`declcav`) : la condition `badIngres.length >= 0` (toujours
  vraie, y compris à 0) déclenchait l'alerte mail "ingrédient à surveiller"
  à chaque déclaration MRV, avec ou sans ingrédient réellement concerné.
  Corrigée en `> 0`.
- Bugs corrigés (journalisation d'activité) : `log.middleware.js`
  référençait `ROUTES_TO_SAVE_IN_BASE`/`generateRoutePattern` sans jamais
  les définir ni les importer (ni `requestUtils`, également non importé) —
  chaque requête déclenchait une `ReferenceError` en boucle (visible en
  "unhandled rejection" dans les logs) et aucune activité n'était jamais
  journalisée. `postActivityStats` contenait par ailleurs un caractère
  parasite (`@USEREMAIL,w`) qui aurait de toute façon fait échouer le
  `INSERT`. Tout est désormais défini dans
  `core/config/activityLog.config.js` (cf. section dédiée ci-dessus), et
  `postActivityStats` tronque les champs à longueur fixe avant insertion.
- Bug corrigé (`error.middleware.js`) : dans les branches "erreur avec
  `err.status` explicite" et "erreur 500 inconnue", le message loggué en
  base référençait des variables (`registered`/`message`) définies dans un
  bloc `if` précédent et hors de portée — une `ReferenceError` synchrone
  empêchait `res.status(...).json(...)` d'être atteint, donc ces réponses
  d'erreur ne partaient jamais correctement vers le client.

## Démarrage

```bash
npm install
cp .env.example .env                                  # puis renseigner les vraies valeurs
cp config/env/.env.dev.example config/env/development.env   # idem
npm run dev
```

Variables sensibles à renseigner (voir les fichiers `.example`) :
`JWT_SECRET`, `LDAP_URL` / `LDAP_DN` / `LDAP_PASSWORD`, `DB_HOST`,
`DB_USER` / `DB_PASS`. **Aucun secret réel n'a été copié depuis V1.0.0** —
il faut les ressaisir depuis votre gestionnaire de secrets habituel.

## Bases de données requises

`USERSMANAGER`, `TICKETING`, `APPATTACHMENTS`, `DECLCAV`, `VINIDOC` (à créer
avec `modules/vinidoc/sql/VINIDOC.tables.sql`) — sur le même
serveur SQL que V1.0.0. Le schéma des tables n'a pas changé, cette
reconstruction ne modifie que la couche applicative. Vérifier/ajuster
`DB_NAME_DECLCAV` / `DB_APP_CODE_DECLCAV` (`config/env/*.env`) : les valeurs
par défaut ont été reprises de l'appCode `DCLING` utilisé par
`modules/emails` en V1.0.0, à confirmer.

## Tests

Suite de tests [Vitest](https://vitest.dev) + [supertest](https://github.com/ladjs/supertest),
sans dépendance à une vraie base SQL Server / LDAP / SMTP : toutes les
« feuilles » qui y accèdent (`core/utils/db.utils.js#runQuery`,
`core/services/ldap.service.js`, `core/services/mail.service.js`) sont
mockées via `vi.mock()`. Le reste (routes, controllers, validators zod,
formatage, middlewares) tourne en conditions réelles.

```bash
npm test              # exécute toute la suite une fois (CI)
npm run test:watch    # mode watch, pratique en développement
npm run test:coverage # exécute la suite + rapport de couverture (./coverage)
```

Organisation :

- `tests/unit/core/` — utilitaires et middlewares transverses (JWT, mots de
  passe, dates, cache, gestion d'erreurs, prepared statements...).
- `tests/unit/modules/<module>/` — validators (zod), utils (formatage),
  services (mock de `runQuery`), controllers (mock des services) de chaque
  module (`ticketing`, `usersmanager`, `files`). **`declcav` n'a pas encore
  de suite de tests** (reconstruction très récente) — à écrire en suivant
  le même modèle que `ticketing`.
- `tests/integration/` — tests de bout en bout par module via `supertest`
  (routing réel + auth JWT réelle + validation + formatage de réponse +
  gestion d'erreurs), seuls les appels base/LDAP/mail étant mockés.
- `tests/helpers/` — fabriques de données (`fixtures.js`, utilisateur/ticket
  de test cohérents avec les vraies fonctions de formatage) et construction
  d'une app Express de test (`buildTestApp.js`).

`NODE_ENV=test` désactive aussi les logs winston (ni fichier, ni console) —
cf. `config/logger.config.js`.

Un point relevé pendant l'écriture des tests et documenté directement dans
`tests/unit/middlewares/auth.middleware.test.js` : la comparaison de niveau
de permission dans `authVerifyMiddleware` (`currentPermission.PRMLVL <
payload.permissionLevel`) semble inversée par rapport à l'objectif décrit en
commentaire juste au-dessus (bloquer un utilisateur dont les droits ont été
révoqués depuis l'émission du token). À valider avec l'équipe.

## Tests de charge

Scripts [autocannon](https://github.com/mcollina/autocannon) dans `loadtest/`,
à lancer contre une instance **réellement démarrée** de l'API (`npm run dev`
ou un environnement de dev/staging dédié) — jamais contre `npm test`, qui ne
démarre aucun serveur.

```bash
node loadtest/run.js --list      # liste les scénarios disponibles
npm run load-test -- smoke       # santé de l'API, sans authentification
npm run load-test -- tickets-read
```

Variables d'environnement (aucune valeur par défaut sensible n'est committée) :

| Variable | Rôle |
| --- | --- |
| `LOADTEST_BASE_URL` | URL de base de l'API (défaut `http://localhost:3001/api`) |
| `LOADTEST_AUTH_TOKEN` | Token JWT déjà valide (évite de repasser par `/auth`) |
| `LOADTEST_EMAIL` / `LOADTEST_PASSWORD` / `LOADTEST_APPCODE` | Identifiants pour un login automatique avant le scénario |
| `LOADTEST_CONNECTIONS` / `LOADTEST_DURATION` | Concurrence / durée (défaut 10 connexions, 15s) |

### Rate limiting et `LOADTEST_MODE`

Depuis l'audit sécurité 1.5, l'API applique `generalLimiter` (300 req/15min)
et `authLimiter` (20 req/15min) par IP (`config/rateLimit.config.js`).
Autocannon envoie depuis une seule IP à haut débit : sans précaution, ces
limiteurs saturent en quelques secondes et le rapport ne mesure alors que la
politique de rate limiting, pas la capacité réelle de l'API (beaucoup de
`429`, latence très faible).

Pour une mesure de capacité réelle, définir `LOADTEST_MODE=true` **dans
l'environnement qui démarre l'API** (pas dans celui qui lance le script
`loadtest/`) avant `npm run dev` / `npm start` :

```bash
LOADTEST_MODE=true npm run dev
```

- Sans effet si `NODE_ENV=production` (garde de sécurité en dur dans
  `config/rateLimit.config.js`) — impossible à activer par erreur en
  production.
- À utiliser uniquement le temps d'une campagne de test sur un environnement
  de dev/staging dédié ; ne jamais le committer dans
  `config/env/production.env`.
- Ne désactive **pas** l'anti-bruteforce maison de `auth-login` (voir
  ci-dessous), qui est indépendant d'`express-rate-limit`.

**Avertissements** :

- `tickets-write` crée réellement des lignes en base à chaque requête —
  utiliser un `LOADTEST_SRVID` de test dédié, jamais un environnement de
  production sans plan de nettoyage.
- `auth-login` passe par le vrai LDAP et par l'anti-bruteforce maison
  (`core/middlewares/auth.middleware.js`, 5 échecs → blocage 15 min) : la
  concurrence est plafonnée automatiquement à 2 connexions / 10s pour ce
  scénario, à ne pas augmenter sans compte de test dédié. `LOADTEST_MODE`
  n'a aucun effet sur ce mécanisme.
- Chaque run écrit un rapport JSON complet dans `loadtest/reports/` (ignoré
  par git) et affiche latence moyenne/p99, débit et taux d'erreur, avec un
  avertissement si les seuils indicatifs (`LOADTEST_P99_THRESHOLD_MS`,
  `LOADTEST_MAX_ERROR_RATE`) sont dépassés.

## Ajouter un futur module (journal, x3v12...)

1. Créer `modules/<nom>/{services,controllers,utils,routes}.js`.
2. Créer `config/db/<nom>.db.config.js` avec
   `export const getConnectionConfig = makeConnectionConfigGetter("<nom>")`.
3. Ajouter les variables d'env `DB_NAME_<NOM>` / `DB_APP_CODE_<NOM>`
   correspondantes.

Le loader (`modules/index.js`) monte automatiquement toute nouvelle route
sur `/api/<nom>`.
