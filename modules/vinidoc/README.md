# Module VINIDOC — fiches œnologiques et fiches techniques

Backend de l'application VINIDOC (front : `FRONTs/REACT/vinidoc`, appcode
`VINDOC`). Il industrialise le POC `technical-data-sheet-tests/webapp` :

1. l'**œnologie** saisit les données œnologiques d'un vin (une fiche par
   **code vrac + millésime**), dans une ou plusieurs langues ;
2. le **marketing** valide (ou refuse) la fiche — **la fiche entière, toutes
   langues confondues** ;
3. les utilisateurs génèrent une **fiche technique PPTX ou PDF** à partir d'un
   **modèle PowerPoint** dont chaque balise peut avoir une **longueur max**.

Monté automatiquement sous `/api/vinidoc` (cf. `modules/index.js`).

---

## Installation

1. Créer la base : exécuter `sql/VINIDOC.tables.sql` (crée la base `VINIDOC`,
   les tables et les référentiels langues/couleurs ; idempotent), puis donner
   au compte applicatif (`DB_USER`) les droits lecture/écriture sur `dbo`.
2. Variables d'environnement :
   - `config/env/<env>.env` : `DB_APP_CODE_VINIDOC="VINDOC"`, `DB_NAME_VINIDOC="VINIDOC"`
   - `.env` : section **VINIDOC** de `.env.example` (services autorisés,
     email marketing, moteur PDF).
3. `npm install` (nouvelles dépendances : `jszip`, `fast-xml-parser`).
4. PDF : LibreOffice installé sur le serveur (`SOFFICE_PATH` si absent du
   PATH) **et les polices des modèles installées "pour tous les
   utilisateurs"** — sinon LibreOffice les remplace silencieusement (cf.
   README du POC). Alternative fidèle à 100 % : `VINIDOC_PDF_ENGINE=powerpoint`
   (Windows + PowerPoint sous licence + session interactive).
5. Côté USERSMANAGER : déclarer l'application `VINDOC` et les permissions
   des utilisateurs (le module exige un token émis pour `VINDOC`, cf. `/auth/app`).

## Modèle de données

| Table | Rôle |
|---|---|
| `LANGUAGES` | Langues disponibles ; **une** langue par défaut (`fr`) obligatoire sur chaque fiche |
| `COLORS` / `COLORTRANS` | Couleurs (ROUGE/ROSE/BLANC) + libellés traduits, dont les extrémités de l'échelle bouche (léger↔puissant, sec↔doux, sec↔moelleux) |
| `SHEETS` | Données communes à toutes les langues : code vrac, millésime (NULL = non millésimé), appellation, couleur, description vrac, échelles 1-5, température min/max, statut, `ROWVER` |
| `SHEETTRANS` | Textes traduisibles, 1 ligne par langue : intitulé, cépages, terroir et sol, vendanges et vinification, dégustation, garde, accords, explication des accords |
| `SHEETVERS` | Versions **validées** (instantané JSON complet, insert-only) |
| `SHEETEVTS` | Journal des actions (création, modifications, traductions, soumission, validation, refus, suppression) |
| `TEMPLATES` / `TEMPLATETAGS` | Modèles PowerPoint (fichier dans `APPATTACHMENTS`) et leurs balises : longueur max, obligatoire, connue du catalogue |
| `GENERATIONS` | Traçabilité : quelle version validée, quel fichier modèle, quelle langue, qui, quand |

Correspondance avec le tableau Excel de l'œnologie :

| Colonne Excel | Champ API |
|---|---|
| CODE VRAC / APPELATION / COULEUR / DESCRIPTION VRAC / MILLESIME | `CODVRAC` / `APPELL` / `COLCOD` / `DESCVRAC` / `MILLESIME` |
| CEPAGES SI POSSIBLE | traduction : `CEPAGES` (texte libre, ex. « Grenache 60 %, Syrah 40 % » ; vide si "NON") |
| ÉCHELLES intensité aromatique / bouche / fruit | `INTARO` / `INTBOU` / `ECHFRU` (1-5) |
| TEMPÉRATURE DE DÉGUSTATION ("8-10°C") | `TEMPMIN` / `TEMPMAX` (°C, pas de 0,5) |
| TERROIR ET SOL / VENDANGES ET VINIFICATION / DÉGUSTATION | traduction : `TERROIR` / `VINIF` / `DEGUST` |
| POTENTIEL DE GARDE / ACCORD METS ET VINS / EXPLICATION | traduction : `GARDE` / `ACCORDS` / `ACCEXPL` |

## Workflow de validation

```
DRAFT ──submit──▶ SUBMITTED ──validate──▶ VALIDATED ──modifier──▶ VALIDATED (version n+1)
  ▲                   └──reject (motif)──▶ REJECTED ──submit──▶ SUBMITTED
  └── modification par l'œnologie d'une fiche DRAFT / SUBMITTED / REJECTED ⇒ DRAFT
```

- **Fiche validée (RG-01)** : elle ne repasse jamais en `DRAFT`. Sa
  modification passe par `PUT /sheets/:SHTID/validated` (œnologie ou
  marketing) : la fiche reste `VALIDATED` et l'enregistrement crée
  directement la version suivante dans `SHEETVERS` (évènement
  `VALIDATED_UPDATED`, commentaire facultatif). Les écritures « brouillon »
  (`PUT /sheets/:SHTID`, traductions) sont refusées sur une fiche validée.

- **Relecture marketing** : un valideur peut modifier une fiche `SUBMITTED`
  (champs, cépages, traductions) ; elle **reste `SUBMITTED`** — pas de
  resoumission, il valide ensuite le contenu qu'il a lui-même corrigé.
  L'évènement est tracé (`UPDATED` / `TRANSLATION_*`, `SUBMITTED → SUBMITTED`).
  Hors `SUBMITTED`, un valideur sans droit de saisie reçoit
  `VINIDOC_INVALID_STATUS_TRANSITION`. Le statut résultant est décidé en base,
  sous verrou (`RESOLVE_EDIT_STATUS`).

- La soumission exige le texte dans la langue par défaut.
- La validation **fige** le contenu (toutes les langues) dans `SHEETVERS`.
- **Une fiche validée est générée depuis sa dernière version validée** :
  une modification en cours n'est utilisée qu'une fois enregistrée (RG-03).
- Notifications mail : soumission → `VINIDOC_MARKETING_EMAIL` ; validation /
  refus → soumissionnaire. Hors production, tout part vers `BASE_RECIPIENT_EMAIL`.

### Réservation des fiches (RG-04, `SHEETLOCKS`)

Avant toute saisie, le front réserve la fiche (`POST /sheets/:SHTID/lock`) ;
si un autre utilisateur la détient, la réponse le nomme (`MINE: false`) et la
fiche reste en lecture seule. Le titulaire prolonge sa réservation par le
même appel tant qu'il est actif ; elle expire après
`PARAMS.LOCK_TIMEOUT_MIN` minutes d'inactivité et est libérée à
l'enregistrement d'une fiche validée, par `DELETE /sheets/:SHTID/lock` ou à
la fermeture de la fiche. Toute écriture d'un autre utilisateur sur une fiche
réservée est refusée : **423 `VINIDOC_SHEET_RESERVED_[nom]_[date]`**.
Websocket : `vinidoc.sheet.locked` / `vinidoc.sheet.unlocked`.

### Paramètres (`PARAMS`)

Valeurs modifiables sans développement (`GET` / `PUT /params`, droit
`VINIDOC_PARAM_SERVICES`, défaut `INFORMATIQUE`) : durée de réservation,
masse volumique du vin, poids et hauteur du support palette (utilisés si le
composant `PAL` de la nomenclature ne les renseigne pas).

### Données logistiques calculées (EF-16 / EF-17)

`utils.computeLogistics`, à partir des poids à vide des matières sèches
(`DB_ARTICLES_MATIERES_SECHES.NUM_POIDS_MS`, nomenclature principale) :
bouteille pleine = bouteille habillée vide + contenance × masse volumique ;
carton plein = bouteilles/carton × (bouteille pleine + emballage carton par
bouteille) ; palette chargée = support + cartons/palette × carton plein ;
hauteur = hauteur du support + couches × hauteur du carton. Donnée manquante
⇒ balise vide, avec la raison (`LOGISTICS[].DETAIL`). Unités constatées dans
le DWH : grammes pour les matières sèches, kilogrammes pour les palettes — à
valider avec le référent Sage X3.

### Verrouillage optimiste (`ROWVER`)

Chaque lecture de fiche renvoie `ROWVER` (`"0x…"`), à renvoyer dans toute
écriture (`PUT`, traductions, `submit`, `validate`, `reject`, `DELETE`).
Chaque écriture renvoie le nouveau `ROWVER`. Si la fiche a changé entre-temps
→ **409 `VINIDOC_CONCURRENT_UPDATE`** (recharger). Pour `validate`, cela
garantit que le marketing valide exactement le contenu qu'il a relu.

## Droits

| Action | Qui |
|---|---|
| Lecture, contrôle, génération | tout utilisateur avec un token `VINDOC` |
| Saisie, traduction, soumission, suppression | services `VINIDOC_EDITOR_SERVICES` (défaut `OENOLOGIE`) |
| Validation / refus | services `VINIDOC_VALIDATOR_SERVICES` (défaut `MARKETING`) |
| Correction pendant la relecture (fiche `SUBMITTED`) | services `VINIDOC_VALIDATOR_SERVICES` |
| Modèles PowerPoint | services `VINIDOC_TEMPLATE_SERVICES` (défaut : aucun) |

Les profils `MODIFY_PERMS` ont tous les droits. Comparaison sur
`payload.data.service.name`, insensible à la casse et aux accents.
`GET /me` renvoie ces droits au front (`RIGHTS`).

## Modèles PowerPoint et balises

Conventions dans le `.pptx` (Volet Sélection pour nommer les formes) :

- **Texte** : `{{DEGUST}}` tapé dans une zone de texte (insensible à la
  casse ; une balise fragmentée par la correction automatique est gérée).
  Longueur max facultative en suffixe : `{{DEGUST-250}}` — c'est la **même
  balise** que `{{DEGUST}}` (fusion et catalogue identiques). À l'import, la
  longueur est reprise dans `TEMPLATETAGS.MAXLEN` (1 à 10000 ; la plus
  stricte si la balise apparaît plusieurs fois avec des valeurs différentes ;
  valeur hors bornes ignorée avec avertissement). Au remplacement du fichier,
  une longueur présente dans la balise écrase la valeur enregistrée ; sans
  suffixe, la valeur enregistrée est conservée. Elle reste modifiable ensuite
  via `PUT /templates/:TPLID/tags`.
- **Image** : forme image nommée `img:BOTTLEPHOTO` (photo fournie à la génération),
  ajustée entière au cadre (jamais rognée, posée en bas). Pour plusieurs
  conditionnements, placer chaque cadre dans un groupe `badge:PHOTO_BOUTEILLE`,
  `badge:PHOTO_BIB` ou `badge:PHOTO_CANETTE` : seul celui choisi à la
  génération (`PACKAGING`, défaut `BOUTEILLE`) est conservé.
- **Bloc conditionnel** : forme/groupe nommé `badge:<TAG>`, retiré si faux :
  `COULEUR_ROUGE|ROSE|BLANC`, jauges `INTENSITE_AROMATIQUE_1..5` (affiché si
  valeur ≥ n), valeur exacte `INTENSITE_AROMATIQUE_EQ_0..5` (`EQ_0` = non renseignée) ; idem
  `INTENSITE_BOUCHE_*` et `ECHELLE_FRUIT_*` ; logos de certification
  `HVE` et `BIO` (affichés si l'option est cochée à la génération) ; si les
  deux sont cochées et que le modèle contient `badge:BIOHVE`, seul ce logo
  combiné est affiché.

Balises texte (alignées sur le modèle du POC `fiche-template.pptx`) :

| Balise | Contenu |
|---|---|
| `{{APPELLATION}}` | Intitulé commercial (traduit) ; à défaut « APPELLATION - COULEUR » |
| `{{TEMP}}` | Température de dégustation (`8-10°C`) |
| `{{DEGUST}}` | Dégustation (œil, nez, bouche) — traduit |
| `{{TERROIR}}` | Terroir et sol — traduit |
| `{{VINIF}}` | Vendanges et vinification — traduit |
| `{{CEPAGES}}`, `{{GARDE}}`, `{{ACCORDS}}`, `{{ACCEXPL}}` | Cépages, potentiel de garde, accords mets et vins et leur explication — traduits, facultatifs (`OPTIONAL` : jamais signalés absents d'un modèle) |
| `{{APPELL}}`, `{{COULEUR}}`, `{{MILLESIME}}`, `{{CODVRAC}}`, `{{DESCVRAC}}` | Appellation seule, couleur (libellé traduit), millésime (vide si non millésimé), code vrac, description vrac — facultatifs |
| `{{LOG.*}}` | `BTLDIM, BTLWGT, CASEDIM, CASEPAL, CASEWGT, EANBTL, EANCASE, LVLPAL, PALHGT, PALWGT, UNITCASE, UNITPAL` — alimentées par l'article PFI choisi à la génération (`AVAILABLE: false` : pas de donnée sur la fiche), corrigeables à la génération (`LOGISTICS`) |
| `{{FREE.*}}` | Champs libres (`{{FREE.PRIX}}`, `{{FREE.MENTION_PROMO-130}}`…) : un champ par balise du modèle dans le formulaire de génération (`FREE`), longueur max et caractère obligatoire réglés comme les autres balises ; ignorés par le contrôle des fiches, non tracés |

Catalogue complet via `GET /merge-fields` : balises texte, images, et blocs
conditionnels avec la liste exhaustive de leurs noms (`NAMES`, regroupés par
`GROUP` ; `COULEUR_*` d'après les couleurs paramétrées).

Au dépôt d'un modèle, ses balises sont **détectées automatiquement**
(`TEMPLATETAGS`), puis l'administrateur règle pour chaque balise texte
`MAXLEN` (nb max de caractères, retours à la ligne comptés 1) et `REQUIRED`.
Au remplacement du fichier, les réglages des balises toujours présentes sont
conservés. Les anciens fichiers restent stockés (traçabilité des générations).

## Endpoints (`/api/vinidoc`)

Réponses au format standard `{ success, data }` ; erreurs `{ success:false, error:{ code, key, message, description, values } }`.

### Référentiels
| Méthode | Route | Description |
|---|---|---|
| GET | `/me` | `{ RIGHTS, DEFAULT_LNGCOD, LANGUAGES, COLORS }` |
| GET | `/merge-fields?LNGCOD=` | Catalogue des balises + `MAXLEN` le plus strict des modèles actifs + détail `LIMITS` par modèle (compteurs de saisie) |

### Fiches
| Méthode | Route | Corps | Succès |
|---|---|---|---|
| GET | `/sheets?SEARCH&STATUS&COLCOD&MILLESIME&GENERABLE&PAGE&PAGESIZE` | — | 200 `{ TOTAL, PAGE, PAGESIZE, ITEMS }` — chaque fiche porte `ISSUES` (anomalies de saisie, messages) |
| POST | `/sheets` | champs communs + `TRANSLATION?` (langue par défaut) | 201 `{ SHTID, STATUS, LASTVER, ROWVER }` |
| GET | `/sheets/:SHTID` | — | 200 fiche + `TRANSLATIONS` + `EVENTS` + `VERSIONS` |
| PUT | `/sheets/:SHTID` | champs communs + `ROWVER` | 200 état |
| DELETE | `/sheets/:SHTID` | `ROWVER`, `COMMENT?` | 200 |
| PUT | `/sheets/:SHTID/default-template` | `DEFTPLID` (null = aucun), `ROWVER` — statut inchangé, hors instantanés validés | 200 état |
| PUT | `/sheets/:SHTID/validated` | `ROWVER`, `COMMENT?`, `SHEET?` (champs communs complets), `TRANSLATIONS?` (`{ lng: champs modifiés \| null }`) — fiche `VALIDATED` uniquement | 200 état (nouvelle version, statut inchangé) |
| POST | `/sheets/:SHTID/lock` | — | 200 réservation `{ USR, USRNAME, LOCKDAT, LASTSEEN, MINE }` |
| DELETE | `/sheets/:SHTID/lock` | — | 200 `{ SHTID, RELEASED }` |
| GET | `/params` | — | 200 paramètres |
| PUT | `/params` | `PARAMS: [{ PRMKEY, PRMVAL }]` (bornes MINVAL / MAXVAL) | 200 paramètres |
| PUT | `/sheets/:SHTID/translations/:LNGCOD` | `LIBELLE, TERROIR, VINIF, DEGUST, GARDE, CEPAGES, ACCORDS, ACCEXPL, ROWVER` | 200 état |
| DELETE | `/sheets/:SHTID/translations/:LNGCOD` | `ROWVER` | 200 état |
| POST | `/sheets/:SHTID/submit` | `ROWVER`, `COMMENT?` | 200 état |
| POST | `/sheets/submit-all` | `SEARCH?`, `COLCOD?`, `MILLESIME?`, `COMMENT?` | 200 `{ SUBMITTED, ERRORS }` — soumet les fiches DRAFT/REJECTED filtrées ; celles en anomalie (traduction par défaut absente, texte trop long, balise obligatoire vide) sont écartées avec le détail. Un seul mail récapitulatif. |
| POST | `/sheets/:SHTID/validate` | `ROWVER`, `COMMENT?` | 200 état (`LASTVER` = n° de version) |
| POST | `/sheets/:SHTID/reject` | `ROWVER`, `COMMENT` (obligatoire) | 200 état |
| GET | `/sheets/:SHTID/versions` | — | 200 liste |
| GET | `/sheets/:SHTID/versions/:VERNUM` | — | 200 `{ VERNUM, SNAPSHOT, ... }` |
| POST | `/sheets/:SHTID/check` | `LNGCOD`, `TPLID?`, `SOURCE` = `CURRENT` (défaut) \| `VALIDATED` | 200 rapport par modèle : `LENGTH`/`MAXLEN`/`ISSUE` par balise |

Exemple de création (fiche du cahier des charges) :

```json
POST /api/vinidoc/sheets
{
  "CODVRAC": "VHL09393", "MILLESIME": 2025, "APPELL": "CDR", "COLCOD": "BLANC",
  "DESCVRAC": "STANDARD", "INTARO": 3, "INTBOU": 1, "ECHFRU": 3,
  "TEMPMIN": 8, "TEMPMAX": 10,
  "TRANSLATION": {
    "TERROIR": "Climat Méditerranéen lumineux…",
    "VINIF": "La qualité de nos vins réside…",
    "DEGUST": "Sous sa robe jaune pâle brillante…",
    "GARDE": "2 ans",
    "ACCORDS": "Viande blanche, dorade à la plancha, salade paysanne",
    "ACCEXPL": "Il faut des plats plutôt légers mais pas acides…"
  }
}
```

### Modèles
| Méthode | Route | Corps | Succès |
|---|---|---|---|
| GET | `/templates?ACTIVE&LNGCOD` | — | 200 (actifs uniquement pour les non-administrateurs) |
| POST | `/templates` | multipart : `file` (.pptx), `TPLNAM`, `DESCR?`, `LNGCOD?` (vide = toutes langues) | 201 modèle + `TAGS` + `WARNINGS` |
| POST | `/templates/inspect` | multipart : `file` (.pptx) — rien n'est enregistré | 200 `TAGS`, `UNKNOWN` (inconnues du catalogue), `MISSING` (balises du catalogue absentes), `WARNINGS` |
| GET | `/templates/:TPLID` | — | 200 modèle + `TAGS` + `FILEURL` |
| PUT | `/templates/:TPLID` | `TPLNAM, DESCR, LNGCOD, ACTIVE, ROWVER` | 200 |
| PUT | `/templates/:TPLID/file` | multipart : `file` | 200 + `ADDEDTAGS` / `REMOVEDTAGS` |
| PUT | `/templates/:TPLID/tags` | `{ TAGS: [{ TAGNAM, TAGTYP?, MAXLEN?, REQUIRED? }] }` | 200 |
| GET | `/templates/:TPLID/preview` | — | 200 `{ TPLID, URL, ORIGINALNAME, CACHED }` : PDF du modèle rempli de faux texte (longueur max de chaque balise), mis en cache dans `uploads/<APP_CODE>/previews` tant que le fichier et les longueurs max sont inchangés |
| GET | `/articles` | `SEARCH?`, `LIMIT?` (≤ 50) | 200 articles PFI du DWH : sans `SEARCH`, uniquement ceux **ayant une fiche œnologique** (un de leurs codes vrac VHL) ; avec `SEARCH`, tous les PFI correspondants, ceux avec fiche d'abord. `HASSHEET` = une fiche existe pour l'un de ses codes vrac ; `SHEETSTATUS` = statut de la fiche utilisée (même millésime d'abord ; `VALIDATED` = validée par le marketing, null sans fiche) |
| GET | `/articles/:COD_ARTICLE` | — | 200 article + `SHEETS` (fiches de ses codes vrac, même millésime d'abord) + `LOGISTICS` (balises `{{LOG.*}}` ; `CALCULATED` + `DETAIL` pour les poids pleins et la hauteur palette) |
| DELETE | `/templates/:TPLID` | — | 200 (suppression logique) |

### Génération
| Méthode | Route | Corps | Succès |
|---|---|---|---|
| POST | `/generate` | JSON ou multipart : `SHTID, TPLID, LNGCOD, COD_ARTICLE` (obligatoire : données logistiques), `FORMAT` (`pdf` défaut \| `pptx`), `HVE?`, `BIO?` (booléens, défaut `false`), `PACKAGING?` (`BOUTEILLE` défaut \| `BIB` \| `CANETTE`), `FREE?` (`{ "FREE.PRIX": "…" }`, chaîne JSON en multipart), `LOGISTICS?` (corrections `{ "LOG.BTLWGT": "1,35 kg" }` prioritaires sur l'article, non enregistrées ; idem), `SHEET?`, `TRANSLATION?` (fiche ajustée pour cette génération, non enregistrée : caractéristiques complètes hors code vrac, textes de `LNGCOD` ; acceptés aussi par `POST /sheets/:SHTID/check` ; idem), `photo?` | 201 `{ GENID, VERNUM, SOURCE, HVE, BIO, FILECODE, ORIGINALNAME, URL, WARNINGS }` |
| GET | `/generations?SHTID&TPLID&LIMIT` | — | 200 historique avec `URL` |

Contenu utilisé : fiche au statut `VALIDATED` → dernière version validée
(`SOURCE: "VALIDATED"`, `VERNUM`) ; sinon → **saisie en cours**
(`SOURCE: "CURRENT"`, `VERNUM: null`), contenu non validé par le marketing
(non bloquant, le front l'indique). L'historique (`/generations`) expose le
même champ `SOURCE`.

Avant de générer, le contenu est contrôlé face aux balises du modèle :
texte trop long ou obligatoire vide → **422 `VINIDOC_TAG_CONSTRAINTS`**
(`values.DETAILS` = `"DEGUST 412/350, TERROIR vide"`). Le texte n'est
**jamais tronqué** automatiquement : il faut corriger la fiche et la faire
revalider (une troncature produirait un contenu non validé par le marketing).

### Temps réel (WebSocket)

`vinidoc.sheet.created|updated|submitted|validated|rejected|deleted`,
`vinidoc.template.created|updated|deleted` — événements légers (IDs + statut),
le front re-fetch.

## Nettoyage des textes œnologiques

À chaque enregistrement (création, champs communs, traductions, import), les
textes œnologiques sont nettoyés par les schémas zod (`utils.cleanText`) :
retours à la ligne et tabulations → espace, espaces multiples / insécables
ramenées à une espace, caractères invisibles supprimés (espace de largeur
nulle, BOM, tiret conditionnel, contrôle), espaces retirées avant `, . )` et
après `(` (conservées devant `; : ! ?`), début et fin rognés ; vide → `null`.
Champs : `APPELL`, `DESCVRAC` et les 8 champs traduits (`LIBELLE`, `TERROIR`,
`VINIF`, `DEGUST`, `GARDE`, `CEPAGES`, `ACCORDS`, `ACCEXPL`). Les commentaires
(workflow, modèles) ne sont pas concernés.

Données saisies avant ce nettoyage : script ponctuel (fiches, traductions et
instantanés des versions validées), simulation par défaut :

```bash
node modules/vinidoc/scripts/clean-oenology-texts.js            # simulation
node modules/vinidoc/scripts/clean-oenology-texts.js --apply    # écriture (sauvegarde JSON dans tmp/, une transaction)
```

Option `--sans-versions` : ne pas modifier les versions validées.

## Erreurs (famille 1700)

| Code | Clé | HTTP |
|---|---|---|
| 1701 | `VINIDOC_SHEET_NOT_FOUND` | 404 |
| 1702 | `VINIDOC_SHEET_ALREADY_EXISTS` (code vrac + millésime) | 409 |
| 1703 | `VINIDOC_CONCURRENT_UPDATE` | 409 |
| 1704 | `VINIDOC_INVALID_STATUS_TRANSITION` | 409 |
| 1705 | `VINIDOC_DEFAULT_TRANSLATION_REQUIRED` | 422 |
| 1706 | `VINIDOC_SHEET_NOT_VALIDATED` | 409 |
| 1707 | `VINIDOC_VERSION_NOT_FOUND` | 404 |
| 1708 | `VINIDOC_TRANSLATION_MISSING_[LNGCOD]` | 422 |
| 1709 | `VINIDOC_UNKNOWN_REFERENCE` (langue/couleur) | 400 |
| 1710 | `VINIDOC_TEMPLATE_NOT_FOUND` | 404 |
| 1711 | `VINIDOC_TEMPLATE_NAME_EXISTS` | 409 |
| 1712 | `VINIDOC_TEMPLATE_INVALID` | 400 |
| 1713 | `VINIDOC_TEMPLATE_FILE_REQUIRED` | 400 |
| 1714 | `VINIDOC_TEMPLATE_FILE_MISSING` | 500 |
| 1715 | `VINIDOC_TEMPLATE_LANGUAGE_MISMATCH_[LNGCOD]` | 422 |
| 1716 | `VINIDOC_UNKNOWN_TEMPLATE_TAG` | 400 |
| 1717 | `VINIDOC_TAG_CONSTRAINTS_[DETAILS]` | 422 |
| 1718 | `VINIDOC_PDF_CONVERSION_FAILED` | 500 |
| 1719 | `VINIDOC_DEFAULT_LANGUAGE_MISSING` | 500 |

Droits insuffisants : `ACCESS_DENIED_WO_LOGOUT` (460, sans déconnexion du front).

## Fichiers du module

```
modules/vinidoc/
  routes.js          déclaration des routes (handle + nettoyage des fichiers tmp)
  controllers.js     droits, validation, orchestration, génération
  services.js        accès SQL (batchs transactionnels, THROW 5017x → registre)
  validators.js      schémas zod
  utils.js           droits, catalogue des balises, données de fusion, contrôles
  notifications.js   mails du workflow
  upload.js          multer (.pptx / photo)
  engine/            moteur OOXML + conversion PDF (LibreOffice / PowerPoint)
  sql/               schéma de la base
```

Tests : `tests/unit/modules/vinidoc/*`, `tests/integration/vinidoc.routes.test.js`.

## Limites connues / suites possibles

- Conversion PDF dans le process de l'API (file en mémoire, concurrence
  `VINIDOC_PDF_CONCURRENCY`) : au-delà d'une instance PM2, passer à une vraie
  file de jobs.
- Les fichiers `/api/uploads` (modèles, fiches générées) sont servis
  statiquement sans authentification, comme le reste de l'API.
- Pas de règle "4 yeux" (un profil MODIFY_PERMS peut soumettre puis valider).
- Photo bouteille : fournie à chaque génération, non stockée sur la fiche.
