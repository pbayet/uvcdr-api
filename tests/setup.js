// tests/setup.js
// Setup global exécuté une fois par fichier de test (cf. vitest.config.js →
// test.setupFiles), APRÈS l'injection des variables d'env (test.env) mais
// AVANT l'import du fichier de test lui-même.
import { mkdirSync } from "node:fs";

// Répertoires utilisés par les tests d'intégration "files" (multer /
// StorageService écrivent réellement sur disque, cf. tests/integration/files.routes.test.js).
// Créés ici plutôt que dans tmp/uploads pour rester isolés du dossier
// tmp/uploads réel du projet (déjà couvert par le motif `.tmp/` de .gitignore).
//
// Pas de suppression dans un afterAll ici : plusieurs fichiers de test
// tournent en parallèle (workers Vitest) et partagent ce même dossier — le
// supprimer depuis un seul fichier casserait les autres en cours d'exécution.
// Le dossier reste sur disque entre deux runs, sans conséquence (contenu de
// test uniquement, jamais committé).
mkdirSync("./tests/.tmp/uploads", { recursive: true });
mkdirSync("./tests/.tmp/tmp", { recursive: true });
