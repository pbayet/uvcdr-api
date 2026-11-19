# Module `procs` — Procédures UVCDR

API de l'application **Procédures UVCDR** (code `PROCS`, front
`UNIS/procedures`, URL `[DOMAIN]/procedures`) : centralisation des
procédures / modes opératoires (documents Word et PDF), classement par
catégories, recherche plein texte (y compris dans le texte des documents),
versions et traçabilité.

## Installation

1. Jouer `sql/PROCS.tables.sql` (crée la base `PROCS`, ses tables, quelques
   catégories de départ et déclare l'application `PROCS` dans
   `USERSMANAGER.dbo.APPLICATIONS`). Script idempotent.
2. Variables d'env (`config/env/*.env`) : `DB_APP_CODE_PROCS="PROCS"`,
   `DB_NAME_PROCS="PROCS"`. Optionnelles (`.env`) : `PROCS_EDITOR_PERMS`,
   `PROCS_MAX_FILE_MB`, `PROCS_PREVIEW`, `PROCS_SOFFICE_TIMEOUT_MS`,
   `SOFFICE_PATH` (cf. `.env.example`).
3. Dans users-manager, donner une permission sur l'application `PROCS` :
   - `DEV`, `SUPERADMIN`, `ADMIN` (= `MODIFY_PERMS`, ou `PROCS_EDITOR_PERMS`)
     → **rédacteurs** : ajout, modification, versions, publication,
     archivage, suppression, catégories, traçabilité ;
   - toute autre permission → **lecteurs** : recherche et lecture des
     procédures publiées, accusé de lecture. Une procédure rangée dans
     une catégorie désactivée (elle-même ou un de ses parents) leur est
     masquée ; les rédacteurs la voient (`CAT.ACTIVE = false`,
     `CAT.INACTIVENAME`).
4. (Recommandé) LibreOffice sur le serveur : aperçu PDF des documents Word
   dans le navigateur et extraction du texte des `.doc` / `.rtf`. Sans
   LibreOffice, les `.docx` / `.odt` / `.pdf` restent indexés ; les Word
   sont alors proposés en téléchargement + affichage du texte extrait.

Le jeton doit avoir été émis **pour l'application PROCS** : un ADMIN d'une
autre application UNIS n'est pas rédacteur ici (460 sinon).

## Modèle

| Table | Rôle |
|---|---|
| `PROCCATEGORIES` | catégories (3 niveaux max, ex. Informatique › Réseau › Serveur EXT), couleur, icône, ordre, active |
| `PROCEDURES` | fiche : référence (unique), titre, résumé, catégorie, responsable, statut `DRAFT`/`PUBLISHED`/`ARCHIVED`, version courante, prochaine révision, suppression logique |
| `PROCKEYWORDS` | mots-clés |
| `PROCVERSIONS` | versions du document : n°, motif, fichier (`FILECODE` → `APPATTACHMENTS.ATTACHMENTS`), aperçu PDF (`PREVIEWCODE`), SHA-256, **texte extrait** (`CONTENTTEXT`) et état de l'extraction (`TEXTSTATUS`) |
| `PROCHISTORY` | journal : action, détail JSON (avant/après champ par champ, fichier, empreinte, motif), auteur, dev en simulation (`DEVEMAIL`), date |
| `PROCCONSULTS` | consultations (`VIEW`) et téléchargements (`DOWNLOAD`), dédoublonnés sur 10 min |
| `PROCACKS` | accusés de lecture (« J'ai lu et compris ») par version |

Fichiers : `UPLOAD_PATH/PROCS/AAAA/MM/JJ/…` via `StorageService`, table
`ATTACHMENTS` (`APPCODE='PROCS'`, `ENTITYTYPE` `PROCVER` = document,
`PROCPRV` = aperçu PDF, `ENTITYID` = `VERID`). Le document est servi par
`GET /versions/:verid/file` (authentifié, consultation tracée) — le front
n'utilise pas l'URL statique `/api/uploads`.

## Recherche

`GET /procedures?SEARCH=…` : chaque terme (accents/casse ignorés,
`French_CI_AI` ; expressions entre guillemets groupées) doit figurer dans
la référence, le titre, le résumé, le responsable, la catégorie, les
mots-clés **ou le texte de la version courante**. Tri par pertinence ;
`SNIPPET` = extrait du document autour de la première occurrence.

Extraction (`extract.js`, en arrière-plan après l'envoi, évènement
`procs.procedure.updated` à la fin) : PDF via `unpdf`, DOCX/ODT en lecture
XML directe, DOC/RTF via LibreOffice. Un PDF scanné sans couche texte donne
`TEXTSTATUS = EMPTY` (seules ses métadonnées sont cherchables).
`PUT /versions/:verid/reindex` relance l'extraction.

## Routes (`/api/procs`)

| Méthode | Route | Droits |
|---|---|---|
| GET | `/me` | tous |
| GET | `/categories` (`?ALL=true` rédacteurs) | tous |
| POST / PUT | `/categories`, `/categories/:catid` | rédacteurs |
| DELETE | `/categories/:catid` (inutilisée seulement : ni procédure, corbeille comprise, ni sous-catégorie ; sinon 409 — `CANDELETE` dans `GET /categories`) | rédacteurs |
| GET | `/procedures` (`SEARCH`, `CATID`, + `STATUS`, `OVERDUE`, `DLTD` rédacteurs) | tous |
| POST | `/procedures` (multipart : champs + `file`) | rédacteurs |
| GET | `/procedures/:prcid` | tous (publiées) |
| PUT | `/procedures/:prcid` | rédacteurs |
| DELETE | `/procedures/:prcid` (`DLTD=false` = restaurer) | rédacteurs |
| PUT | `/procedures/:prcid/status` | rédacteurs |
| GET | `/procedures/:prcid/text` (`VERID` rédacteurs) | tous |
| GET | `/procedures/:prcid/history`, `/procedures/:prcid/readers` | rédacteurs |
| PUT | `/procedures/:prcid/acknowledge` | tous |
| POST | `/procedures/:prcid/versions` (multipart `file`, `COMMENT`, `PUBLISH`) | rédacteurs |
| PUT | `/versions/:verid/restore`, `/versions/:verid/reindex` | rédacteurs |
| GET | `/versions/:verid/file` (`KIND=original|preview`, `DISPOSITION=inline|attachment`) | tous (version courante) / rédacteurs (toutes) |
| GET | `/history`, `/stats` | rédacteurs |

Temps réel : `procs.procedure.created|updated|deleted|acknowledged`,
`procs.categories.updated` (préfixe `procs` → application `PROCS`).

Tests : `tests/unit/modules/procs/extract.test.js`,
`tests/integration/procs.routes.test.js`.
