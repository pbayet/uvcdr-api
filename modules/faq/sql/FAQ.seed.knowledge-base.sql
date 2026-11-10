/* ═══════════════════════════════════════════════════════════════
   FAQ — Nettoyage + jeu de questions / réponses « base de connaissance »

   1. Vide les données de contenu de la FAQ (publications, réponses,
      likes, mots-clés, liens tickets, épinglages) et remet les compteurs
      IDENTITY à zéro.
      La configuration est CONSERVÉE : FAQSTATUSES, FAQCATEGORIES,
      FAQMODERATORS.
   2. Insère des questions créées par l'utilisateur USRID = 1, au statut
      RESOLVED, chacune avec une réponse retenue (VALIDATED = 1, validée
      par l'utilisateur 1) : elles apparaissent donc dans la base de
      connaissance.

   Applications couvertes (USERSMANAGER.dbo.APPLICATIONS.APPCOD) :
     DCLING, FSA, TCK, USRMAN, VINDOC

   Prérequis : FAQ.seed.statuses.sql déjà joué (statut RESOLVED et
   catégories de départ).

   ⚠ TRUNCATE TABLE est refusé par SQL Server sur une table référencée
   par une clé étrangère (FAQPOSTS, FAQANSWERS), même vide : ces deux
   tables sont vidées par DELETE + DBCC CHECKIDENT, les autres par
   TRUNCATE.

   ⚠ Les pièces jointes FAQ (base « attachments », table ATTACHMENTS,
   APPCODE = 'FAQ') ne sont pas dans la base FAQ : voir le bloc commenté
   en fin d'étape 1 pour les retirer aussi.

   Tout s'exécute dans une transaction : en cas d'erreur, rien n'est
   modifié.
═══════════════════════════════════════════════════════════════ */

USE [FAQ];
GO

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
SET NOCOUNT ON;
SET XACT_ABORT ON;
GO

BEGIN TRY
  BEGIN TRAN;

  /* ─────────────────────────────────────────────────────────────
     1. Nettoyage
  ───────────────────────────────────────────────────────────── */

  -- Tables « feuilles » (personne ne les référence) : TRUNCATE.
  TRUNCATE TABLE dbo.FAQANSWERLIKES;
  TRUNCATE TABLE dbo.FAQTICKETS;
  TRUNCATE TABLE dbo.FAQKEYWORDS;
  IF OBJECT_ID(N'dbo.FAQPOSTLIKES', N'U') IS NOT NULL TRUNCATE TABLE dbo.FAQPOSTLIKES;
  IF OBJECT_ID(N'dbo.FAQUSERPINS',  N'U') IS NOT NULL TRUNCATE TABLE dbo.FAQUSERPINS;

  -- Tables référencées par des FK : DELETE puis remise à zéro IDENTITY
  -- (le prochain ID inséré sera 1).
  -- (RESEED 0 seulement si la table a déjà servi : sur une table jamais
  -- alimentée, RESEED 0 ferait démarrer les ID à 0.)
  DELETE FROM dbo.FAQANSWERS;
  DELETE FROM dbo.FAQPOSTS;
  IF IDENT_CURRENT(N'dbo.FAQANSWERS') > 1 OR EXISTS (SELECT 1 FROM sys.identity_columns
       WHERE object_id = OBJECT_ID(N'dbo.FAQANSWERS') AND last_value IS NOT NULL)
    DBCC CHECKIDENT (N'dbo.FAQANSWERS', RESEED, 0) WITH NO_INFOMSGS;
  IF IDENT_CURRENT(N'dbo.FAQPOSTS') > 1 OR EXISTS (SELECT 1 FROM sys.identity_columns
       WHERE object_id = OBJECT_ID(N'dbo.FAQPOSTS') AND last_value IS NOT NULL)
    DBCC CHECKIDENT (N'dbo.FAQPOSTS', RESEED, 0) WITH NO_INFOMSGS;

  -- Pièces jointes FAQ (autre base) — décommenter et adapter le nom de
  -- la base « attachments » si nécessaire :
  -- UPDATE [ATTACHMENTS_DB].dbo.ATTACHMENTS
  --    SET DELETEDAT = SYSDATETIME()
  --  WHERE APPCODE = 'FAQ' AND DELETEDAT IS NULL;

  /* ─────────────────────────────────────────────────────────────
     2. Jeu de données
  ───────────────────────────────────────────────────────────── */

  DECLARE @USRID INT = 1;
  DECLARE @NOW   DATETIME2(7) = SYSUTCDATETIME();
  DECLARE @STSID INT = (SELECT STSID FROM dbo.FAQSTATUSES
                         WHERE CODE = N'RESOLVED' AND TYPE = N'QUESTION');

  IF @STSID IS NULL
    THROW 50001, N'Statut RESOLVED introuvable : jouer FAQ.seed.statuses.sql d''abord.', 1;

  DECLARE @QA TABLE (
    ORD      INT            NOT NULL PRIMARY KEY,
    APPCOD   NVARCHAR(20)   NOT NULL,
    CATNAM   NVARCHAR(100)  NULL,
    TITLE    NVARCHAR(255)  NOT NULL,
    BODY     NVARCHAR(4000) NOT NULL,
    ANSWER   NVARCHAR(4000) NOT NULL,
    KEYWORDS NVARCHAR(1000) NULL,     -- séparés par « | »
    DAYSAGO  INT            NOT NULL  -- ancienneté de la question
  );

  INSERT INTO @QA (ORD, APPCOD, CATNAM, TITLE, BODY, ANSWER, KEYWORDS, DAYSAGO)
  VALUES

  /* ═════════════ DÉCLARATION D'INGRÉDIENTS — DCLING ═════════════ */

  (101, N'DCLING', N'Utilisation',
   N'Comment déclarer les ingrédients et les cépages d''un dossier ?',
   N'Je dois renseigner la déclaration d''un dossier qui apparaît dans « Dossiers en cours ». Quelles sont les étapes jusqu''à l''envoi ?',
   N'Depuis « Dossiers en cours », ouvrez le dossier puis :
1. « Renseigner la déclaration » : ajoutez les ingrédients (« Rechercher un ingrédient… ») avec leur « Quantité déclarée », puis les cépages (« Rechercher un cépage… »).
2. Vérifiez le « Récapitulatif ».
3. « Générer la déclaration » : un PDF est produit.
4. « Signer et envoyer la déclaration », puis « Confirmer la signature électronique ».
Si un questionnaire de traçabilité est attendu, le bouton s''intitule « Envoyer la déclaration (un questionnaire de traçabilité y sera associé) ».',
   N'déclaration|ingrédients|cépages|signature|envoi', 60),

  (102, N'DCLING', N'Anomalie',
   N'Le bouton « Suivant » reste grisé sur l''étape des cépages',
   N'J''ai sélectionné mes cépages mais impossible de passer à l''étape suivante, un message parle de 100 %.',
   N'La somme des pourcentages des cépages sélectionnés doit être strictement égale à 100 %. Le message « Le pourcentage de cépage sélectionnés doit être strictement égal à 100% pour continuer » s''affiche tant que ce n''est pas le cas (99,9 % ou 100,1 % bloquent aussi).
Vérifiez également que le numéro de marché est renseigné : il est obligatoire.',
   N'cépages|pourcentage|100%|suivant|numéro de marché', 55),

  (103, N'DCLING', N'Utilisation',
   N'Comment corriger une déclaration déjà envoyée ?',
   N'J''ai fait une erreur sur une quantité après avoir signé et envoyé ma déclaration. Puis-je la modifier ?',
   N'Une déclaration envoyée ne se modifie pas directement : il faut faire une rectification. Le dossier affiche alors « Rectification N°x ».
Corrigez les informations, puis « Signer la rectification de déclaration » et « Envoyer la rectification ». Le service Œnologie reçoit un e-mail « Déclaration {N° dossier} rectifiée ».',
   N'rectification|correction|déclaration envoyée', 50),

  (104, N'DCLING', N'Utilisation',
   N'Combien de temps un questionnaire de traçabilité validé reste-t-il valable ?',
   N'Une cave me demande si elle doit remplir le questionnaire de traçabilité à chaque dossier.',
   N'Un questionnaire validé par le service Qualité est valable 3 ans.
- 90 jours avant l''échéance, il passe en « Expire bientôt » (« Expire dans N jour(s) »).
- Une fois l''échéance passée, il est « Expiré » (« Expiré depuis N jour(s) ») et doit être refait.
Statuts côté cave : « Brouillon - En attente de saisie », « Soumis - En attente de validation par le service Qualité », « Validé », « À corriger - En attente de vos modifications ».',
   N'questionnaire|traçabilité|validité|expiration|3 ans', 45),

  (105, N'DCLING', N'Anomalie',
   N'Impossible de valider l''étape « Certifications » du questionnaire',
   N'Je suis bloqué sur la première étape du questionnaire, « Terminer et Suivant » ne fonctionne pas.',
   N'L''étape Certifications exige :
- au moins une case cochée (IFS, BRC, FSSC22000, HVE, BIO, Autre… ou « Aucune ») ;
- pour chaque certification cochée, une date de validité correcte et non dépassée (« La date de validité est obligatoire ») ;
- au moins une pièce jointe (« Une pièce jointe au moins est obligatoire »), typiquement le certificat.
Pour les questions suivantes : une réponse « Oui » impose de remplir le détail ; à la question 1, « Oui » demande une pièce jointe. À l''étape traçabilité, tous les champs texte sont obligatoires.',
   N'questionnaire|certifications|pièce jointe|date de validité', 40),

  (106, N'DCLING', N'Utilisation',
   N'Pourquoi aucune retiraison n''est possible sur mon dossier ?',
   N'Le transport ne peut pas enlever le vin, on me dit que le dossier n''est pas validé.',
   N'Aucune retiraison n''est possible tant que le dossier n''a pas été validé dans son intégralité : la déclaration d''ingrédients ET le questionnaire de traçabilité associé.
Vérifiez dans le dossier que la déclaration est signée et envoyée, et que le questionnaire n''est pas en « Brouillon » ou « À corriger ». S''il est en attente de validation, c''est au service Qualité de le valider.',
   N'retiraison|validation|dossier bloqué|questionnaire', 35),

  (107, N'DCLING', N'Utilisation',
   N'Quels fichiers peut-on déposer sur un audit ?',
   N'L''envoi de mes documents d''audit est refusé.',
   N'Formats acceptés : pdf, doc, docx, xls, xlsx, odt, ods, csv, txt, png, jpg, jpeg, zip.
Limites : 20 Mo par fichier et 10 fichiers maximum par envoi.
Messages correspondants : « Format de fichier non autorisé (.ext)… », « Fichier trop volumineux (20 Mo max). », « 10 fichiers maximum par envoi. ».
Un document refusé par le service Qualité passe en « Refusé — corrections demandées » côté cave : redéposez la version corrigée.',
   N'audit|pièces jointes|format|taille|20 mo', 28),

  (108, N'DCLING', N'Accès & comptes',
   N'Une cave a perdu son mot de passe, comment le réinitialiser ?',
   N'Une cave n''arrive plus à se connecter à son espace de déclaration.',
   N'Les caves ont leurs propres identifiants (distincts des comptes UNIS). Dans la version Administration : Paramètres › onglet caves, ouvrez la cave et utilisez « Réinitialiser le mot de passe de la cave ».
La cave reçoit un e-mail « Mot de passe cave réinitialisé ». Vérifiez au passage que ses e-mails de destination sont corrects (un même e-mail ne peut pas apparaître deux fois).',
   N'mot de passe|cave|réinitialisation|connexion', 20),

  /* ═════════════════════════ FSA — FSA ══════════════════════════ */

  (201, N'FSA', N'Utilisation',
   N'Comment créer un nouveau dossier FSA ?',
   N'Je dois lancer une fiche de suivi d''article pour un nouveau client. Par où commencer ?',
   N'Menu « Nouveau dossier » : choisissez le « Type de demande » et le demandeur (« Sélectionnez un demandeur… »), cochez « À cocher si votre FSA est une innovation » le cas échéant. Le message « Dossier créé avec succès ! » confirme la création.
Complétez ensuite les onglets « Client », « Vrac », « Nomenclature », « Informations » et « Pièces jointes » ; le « Récapitulatif » permet de tout relire.
Astuce : « Dupliquer un dossier » repart d''un dossier existant proche.',
   N'nouveau dossier|création|fsa|dupliquer', 58),

  (202, N'FSA', N'Anomalie',
   N'« Veuillez remplir tous les champs obligatoires » à l''envoi pour validation',
   N'Quand je clique sur « Envoyer le dossier pour validation », j''ai un message d''erreur.',
   N'Le dossier ne peut être envoyé que lorsque tous les champs obligatoires sont remplis. La barre de progression de saisie indique ce qui manque. Les oublis fréquents :
- client : e-mail et téléphone du nouveau contact ;
- produit : appellation, couleur, qualité, typologie, gamme, marque ;
- commercial : volumes (Année N / N+1 / N+2) et prix.
Il faut aussi au moins une pièce jointe (fichier ou lien) : « Au moins une pièce jointe (fichier ou lien) est requise pour ce dossier. »',
   N'champs obligatoires|envoi|validation|pièce jointe', 52),

  (203, N'FSA', N'Utilisation',
   N'Mes saisies sont-elles enregistrées automatiquement ?',
   N'J''ai peur de perdre mon travail si je ferme l''onglet.',
   N'Oui, le dossier est sauvegardé automatiquement pendant la saisie. Vous pouvez aussi forcer l''enregistrement avec « Enregistrer » ou Ctrl+S.
Si le message « Échec de la sauvegarde automatique » apparaît, enregistrez manuellement avant de quitter ; en cas de modifications non enregistrées, le navigateur demande « Quitter le site ? ».',
   N'sauvegarde automatique|enregistrer|ctrl+s', 47),

  (204, N'FSA', N'Utilisation',
   N'Quels liens peut-on ajouter comme pièce jointe ?',
   N'Mon lien vers un fichier du réseau est refusé.',
   N'Un lien doit commencer par http://, https:// ou file:// et ne pas dépasser 2000 caractères. Pour un fichier sur un partage réseau, utilisez la forme file://serveur/partage/fichier.
Un même lien ne peut être ajouté qu''une fois (« Ce lien est déjà dans la liste. »).',
   N'lien|pièce jointe|file://|réseau', 41),

  (205, N'FSA', N'Utilisation',
   N'Comment valider ou refuser un dossier en tant que gestionnaire ?',
   N'Je suis gestionnaire d''un service et j''ai reçu un e-mail « Nouveau dossier FSA ». Comment donner mon avis ?',
   N'Ouvrez le dossier, onglet de validation, et choisissez le type : validation, refus ou « Validation à titre informatif ». En cas de refus, une note expliquant le motif est attendue.
Vous pouvez revenir sur votre choix avec « Supprimer la validation ».
Le filtre « Mes validations » (« Non validé », « En attente de ma seule validation », « Validé », « Refusé ») permet de retrouver les dossiers qui vous attendent.',
   N'validation|refus|gestionnaire|mes validations', 33),

  (206, N'FSA', N'Utilisation',
   N'Pourquoi un service apparaît « en retard » sur un dossier ?',
   N'Sur mon dossier je vois la mention « Service en retard ».',
   N'Chaque service dispose d''un délai de validation (« Temps max de validation toléré (jours) », dans Paramètres). Au-delà, le service est signalé « Service en retard » / « N''a toujours pas validé, le délai est dépassé ».
Un e-mail quotidien « Relance dossier(s) FSA en attente de validation » est envoyé aux gestionnaires concernés.',
   N'retard|délai|relance|validation', 26),

  (207, N'FSA', N'Utilisation',
   N'Un dossier supprimé peut-il être récupéré ?',
   N'J''ai supprimé un dossier FSA par erreur.',
   N'Oui, tant qu''il est dans la « Corbeille » : ouvrez-le et cliquez sur « Restaurer le dossier ».
Attention, la corbeille est vidée automatiquement après le délai « Conservation en corbeille avant suppression définitive (jours) » défini dans Paramètres. Les dossiers validés partent eux aussi automatiquement en « Archives » après le délai « Temps avant mise en archive (jours) ».',
   N'corbeille|restaurer|suppression|archives', 18),

  /* ═══════════════════════ TICKETING — TCK ══════════════════════ */

  (301, N'TCK', N'Utilisation',
   N'Comment créer un ticket ?',
   N'J''ai besoin d''une intervention du service informatique. Quels champs dois-je remplir ?',
   N'Cliquez sur « Nouveau ticket ». Champs obligatoires :
- titre (« Donnez un titre court et explicite ») ;
- description ;
- service destinataire ;
- priorité, statut ;
- catégorie et « Sous-catégorie 1 » (les sous-catégories 2 et 3 sont facultatives).
Facultatif : « Projet concerné », « Services associés », pièces jointes. Validez avec « Créer le ticket » : les membres du service reçoivent un e-mail « Nouveau ticket ».',
   N'nouveau ticket|création|champs obligatoires|catégorie', 57),

  (302, N'TCK', N'Utilisation',
   N'À quoi correspondent les colonnes du tableau de bord ?',
   N'Quelle est la différence entre « Résolu » et « Clôturé » ?',
   N'Les colonnes du « Tableau de bord » sont les statuts : Nouveau, En cours, En attente, Résolu, Clôturé, Annulé.
- Résolu : le service estime avoir traité la demande ; le demandeur reçoit un e-mail l''invitant à passer le ticket en « Clôturé » si la solution lui convient, ou à ajouter un commentaire sinon.
- Clôturé : la demande est terminée. La « clôture définitive » (« Clôturer définitivement ») range le ticket, en lecture seule, dans « Tickets clôturés ».
Le passage en « En attente » demande un motif (« Motif de mise en attente »).',
   N'statuts|kanban|résolu|clôturé|en attente', 50),

  (303, N'TCK', N'Accès & comptes',
   N'Je ne peux pas déplacer mon ticket dans une autre colonne',
   N'J''ai créé un ticket, mais je ne peux le mettre ni en « En cours » ni en « En attente ».',
   N'C''est normal : seuls les membres du service qui traite le ticket peuvent le déplacer dans toutes les colonnes. Le demandeur peut uniquement basculer son ticket entre « Résolu » et « Clôturé ».
De même, seul le service principal du ticket peut modifier le service ou la catégorisation.',
   N'droits|déplacer|demandeur|service principal', 44),

  (304, N'TCK', N'Utilisation',
   N'Quelle différence entre commentaire public et commentaire privé ?',
   N'Je veux ajouter une note technique sans que le demandeur la voie.',
   N'Un « Commentaire public » est visible par le demandeur et lui est notifié par e-mail (« Nouvelle note sur le ticket »). Un « Commentaire privé » reste interne aux services qui traitent le ticket.
Les tâches (« Ajouter des tâches ») peuvent elles aussi être privées ou publiques, et se cochent avec « Marquer comme fait ».',
   N'commentaire|privé|public|note|tâches', 38),

  (305, N'TCK', N'Utilisation',
   N'Pourquoi je ne reçois pas d''e-mail pour certaines actions sur un ticket ?',
   N'J''ai changé le statut d''un ticket et je n''ai reçu aucun e-mail.',
   N'Vous ne recevez jamais d''e-mail pour vos propres actions. Par ailleurs, les changements de statut ou notes rapprochés sont regroupés dans un seul e-mail.
Pour les tickets où vous êtes en copie ou rattachés à vos projets, vérifiez vos préférences : « Recevoir les emails des tickets où je suis en copie / rattachés à mes projets ».',
   N'e-mail|notification|préférences|copie', 30),

  (306, N'TCK', N'Utilisation',
   N'Comment regrouper deux tickets qui concernent le même problème ?',
   N'Deux personnes ont ouvert un ticket pour la même panne.',
   N'Deux possibilités :
- lier les tickets : ils restent distincts mais se référencent (annulable avec « Délier ce ticket ») ;
- fusionner les tickets : sélectionnez au moins un autre ticket à fusionner (annulable avec « Défusionner ce ticket »).
Un ticket ne peut pas être lié à lui-même.',
   N'fusion|lier|doublon|ticket', 22),

  (307, N'TCK', N'Anomalie',
   N'« La fin ne peut pas être antérieure au début » lors de la planification',
   N'Je n''arrive pas à saisir le temps prévisionnel de mon ticket.',
   N'La « Fin prévisionnelle » doit être postérieure ou égale au « Début prévisionnel ». Les temps prévisionnel et réel se saisissent en nombre entier de minutes (« Doit être un nombre entier de minutes. »).
Pour convertir des heures ou des jours, utilisez le « Convertisseur de durée » proposé à côté du champ.',
   N'planification|durée|minutes|convertisseur', 15),

  /* ═════════════════════ USERS-MANAGER — USRMAN ═════════════════ */

  (401, N'USRMAN', N'Accès & comptes',
   N'Comment créer un nouvel utilisateur ?',
   N'Un collaborateur arrive lundi, comment lui ouvrir ses accès aux applications ?',
   N'Menu « Utilisateurs » › « Nouvel utilisateur ». Onglet « Données de bases » : nom, prénom, e-mail et poste de travail sont obligatoires (cochez « Externe à l''UVCDR » si besoin).
Onglet « Permissions » : attribuez un niveau d''autorisation par application, ou ajoutez l''utilisateur à des groupes. Terminez par « Enregistrer et quitter ».
Il se connectera ensuite avec son e-mail professionnel et le mot de passe de son PC.',
   N'nouvel utilisateur|création|permissions|accès', 59),

  (402, N'USRMAN', N'Accès & comptes',
   N'Un utilisateur a une permission par son groupe et une autre en direct : laquelle s''applique ?',
   N'Un utilisateur est en lecture dans ses permissions directes mais son groupe lui donne plus de droits.',
   N'Les permissions des groupes s''ajoutent aux permissions directes : c''est la plus élevée qui s''applique.
Pour restreindre un utilisateur, il faut donc aussi vérifier ses groupes. Rappel : le « Groupe de base » est attribué d''office à tous les utilisateurs et son statut est figé.',
   N'permissions|groupes|niveau d''autorisation|droits', 49),

  (403, N'USRMAN', N'Utilisation',
   N'Pourquoi une application n''apparaît pas dans la liste des permissions ?',
   N'Je veux donner accès à une application mais elle n''est pas proposée.',
   N'Une application inactive n''est plus proposée dans les permissions. Dans « Applications », ouvrez la fiche de l''application et vérifiez qu''elle est active.',
   N'application inactive|permissions|applications', 39),

  (404, N'USRMAN', N'Utilisation',
   N'Comment publier les nouveautés d''une nouvelle version d''application ?',
   N'Je viens de livrer une version et je veux que les utilisateurs voient les nouveautés.',
   N'Dans « Applications », ouvrez l''application, onglet « Versions », puis « Nouvelle version » et rédigez les nouveautés. Le numéro doit être unique pour l''application (« Ce numéro de version existe déjà pour cette application. »).
C''est la version la plus récente par date qui est affichée aux utilisateurs, via le bouton « Voir les nouveautés ».',
   N'versions|nouveautés|release notes|applications', 31),

  (405, N'USRMAN', N'Accès & comptes',
   N'Comment suivre et relancer les mots de passe Windows qui expirent ?',
   N'Plusieurs collaborateurs se retrouvent bloqués avec un mot de passe expiré.',
   N'Le suivi des mots de passe Active Directory classe les comptes en « Expire bientôt », « Expirés / à changer », « N''expire jamais », « Compte désactivé » et « Non référencé ».
- « Relance mot de passe » envoie un e-mail à un utilisateur ;
- « Relance générale » affiche le récapitulatif des destinataires avant envoi (réservée aux gestionnaires).
Une relance automatique planifiée existe aussi. Le seuil « expire bientôt » est paramétrable.',
   N'mot de passe|active directory|expiration|relance', 24),

  (406, N'USRMAN', N'Utilisation',
   N'Comment changer le thème d''affichage de toutes mes applications ?',
   N'Je voudrais le mode sombre partout sans le régler application par application.',
   N'Dans les Paramètres d''une application, section « Thème d''affichage », choisissez Clair, Sombre, Système ou Par défaut. Le bouton « Modifier mon thème par défaut » applique votre choix à toutes les applications.
Les administrateurs définissent le « Thème par défaut » et le « Thème par application » dans les Paramètres de Users-Manager.',
   N'thème|mode sombre|affichage|paramètres', 12),

  /* ═════════════════════════ VINIDOC — VINDOC ═══════════════════ */

  (501, N'VINDOC', N'Utilisation',
   N'Quel est le circuit de validation d''une fiche œnologique ?',
   N'Qui saisit et qui valide les fiches œnologiques ?',
   N'1. L''Œnologie saisit la fiche (une par code vrac + millésime) : statut « Brouillon ».
2. « Soumettre au marketing » : la fiche passe « À valider » et le marketing est prévenu par e-mail. La soumission exige le texte dans la langue par défaut (français).
3. Le marketing, dans « Fiches à valider », clique sur « Valider la fiche » ou « Refuser la fiche » (le « Motif du refus » est obligatoire et transmis à l''Œnologie).
« Tout soumettre au marketing » soumet en masse ; les fiches incomplètes (traduction absente, texte trop long, balise obligatoire vide) sont ignorées.',
   N'validation|marketing|œnologie|soumettre|statut', 56),

  (502, N'VINDOC', N'Utilisation',
   N'Modifier une fiche validée la remet-elle en brouillon ?',
   N'Je dois corriger une faute sur une fiche déjà validée par le marketing.',
   N'Non. La validation fige une version pour toutes les langues. Modifier une fiche validée crée une nouvelle version validée (« Enregistrer une nouvelle version validée ») : la fiche ne repasse pas en brouillon.
Les fiches techniques sont toujours générées à partir de la dernière version validée.',
   N'version|fiche validée|modification|brouillon', 46),

  (503, N'VINDOC', N'Anomalie',
   N'La fiche est en lecture seule : « réservée » par un autre utilisateur',
   N'Je ne peux pas modifier une fiche, un message indique qu''elle est réservée.',
   N'Pour éviter les modifications simultanées, il faut « Réserver la fiche pour la modifier ». Si un collègue la détient, elle reste en lecture seule et le message indique qui la détient.
La réservation expire automatiquement après un délai d''inactivité (défini dans Paramètres). Si quelqu''un a enregistré la fiche pendant que vous la consultiez, un bandeau vous propose de recharger.',
   N'réservation|verrou|lecture seule|concurrence', 37),

  (504, N'VINDOC', N'Anomalie',
   N'Génération bloquée : texte trop long ou balise obligatoire vide',
   N'La génération de la fiche technique échoue avec un message du type « DEGUST 412/350 ».',
   N'Le modèle PowerPoint impose une longueur maximale par balise (ici 350 caractères pour la dégustation, le texte en fait 412), et certaines balises sont obligatoires. VINIDOC ne coupe jamais un texte automatiquement.
Raccourcissez ou complétez le texte dans la fiche œnologique (les compteurs de caractères se basent sur le modèle actif le plus strict), puis faites valider la fiche à nouveau.',
   N'génération|texte trop long|balise|modèle', 29),

  (505, N'VINDOC', N'Utilisation',
   N'Comment générer une fiche technique PDF ou PowerPoint ?',
   N'Le commercial me demande la fiche technique d''un article.',
   N'Menu « Fiches techniques » : choisissez l''article (PFI), qui apporte les données logistiques, puis la langue, le modèle, le format PDF ou PPTX, les logos HVE / BIO, le conditionnement (bouteille, BIB, canette), les champs libres et éventuellement une photo produit (png, jpg, jpeg ou webp, 15 Mo max).
Les données logistiques (poids, EAN, palette) peuvent être corrigées pour cette génération uniquement.
Si le vrac n''a pas de fiche œnologique : « créez-la dans Œnologie ». Une fiche jamais validée génère depuis la saisie en cours, avec l''avertissement « non validée par le marketing ».',
   N'fiche technique|génération|pdf|pptx|pfi', 21),

  (506, N'VINDOC', N'Utilisation',
   N'Comment importer des fiches œnologiques depuis un fichier CSV ?',
   N'J''ai une centaine de fiches dans un tableur à reprendre.',
   N'Utilisez « Importer des fiches depuis un CSV ». Le fichier est séparé par des points-virgules (;) avec une ligne d''en-tête (CODVRAC;MILLESIME;APPELL;COLCOD;…;LNGCOD;LIBELLE;…). Les colonnes CODVRAC, APPELL et COLCOD sont obligatoires.
Une fiche existant déjà pour le même code vrac + millésime est rejetée (« Fiche déjà existante. ») sauf si vous cochez « Mettre à jour les fiches existantes ». Les lignes en erreur sont listées après l''import.',
   N'import|csv|fiches œnologiques|reprise', 10);

  -- Contrôle : toutes les applications doivent exister.
  IF EXISTS (
    SELECT 1 FROM @QA q
     WHERE NOT EXISTS (SELECT 1 FROM USERSMANAGER.dbo.APPLICATIONS a WHERE a.APPCOD = q.APPCOD)
  )
  BEGIN
    DECLARE @MISSING NVARCHAR(400) = (
      SELECT STRING_AGG(APPCOD, N', ') FROM (
        SELECT DISTINCT q.APPCOD FROM @QA q
         WHERE NOT EXISTS (SELECT 1 FROM USERSMANAGER.dbo.APPLICATIONS a WHERE a.APPCOD = q.APPCOD)
      ) m);
    DECLARE @MSG NVARCHAR(2048) = N'Application(s) introuvable(s) dans USERSMANAGER.dbo.APPLICATIONS : ' + @MISSING;
    THROW 50002, @MSG, 1;
  END;

  /* Publications (ordre de PSTID = ordre de ORD) */
  INSERT INTO dbo.FAQPOSTS (TYPE, TITLE, BODY, CATID, STSID, CREUSR, CREDAT, UPDDAT, PINNED, VIEWS, DLTD, APPID)
  SELECT N'QUESTION', q.TITLE, q.BODY,
         (SELECT TOP 1 c.CATID FROM dbo.FAQCATEGORIES c WHERE c.NAME = q.CATNAM AND c.ACTIVE = 1),
         @STSID, @USRID,
         DATEADD(DAY, -q.DAYSAGO, @NOW), NULL, 0, 0, 0,
         (SELECT TOP 1 a.APPID FROM USERSMANAGER.dbo.APPLICATIONS a WHERE a.APPCOD = q.APPCOD)
    FROM @QA q
   ORDER BY q.ORD;

  /* Réponses retenues (base de connaissance) — jointure sur le titre,
     unique dans ce jeu de données. */
  INSERT INTO dbo.FAQANSWERS (PSTID, BODY, CREUSR, CREDAT, UPDDAT, VALIDATED, VALDBY, VALDAT, DLTD)
  SELECT p.PSTID, q.ANSWER, @USRID,
         DATEADD(HOUR, 2, p.CREDAT), NULL,
         1, @USRID, DATEADD(HOUR, 4, p.CREDAT), 0
    FROM @QA q
    INNER JOIN dbo.FAQPOSTS p ON p.TITLE = q.TITLE AND p.DLTD = 0
   ORDER BY q.ORD;

  /* Mots-clés */
  INSERT INTO dbo.FAQKEYWORDS (PSTID, KEYWORD, CREUSR, CREDAT)
  SELECT DISTINCT p.PSTID, LEFT(LTRIM(RTRIM(s.value)), 50), @USRID, p.CREDAT
    FROM @QA q
    INNER JOIN dbo.FAQPOSTS p ON p.TITLE = q.TITLE
    CROSS APPLY STRING_SPLIT(q.KEYWORDS, N'|') s
   WHERE LTRIM(RTRIM(s.value)) <> N'';

  COMMIT TRAN;

  /* Bilan */
  SELECT a.APPCOD, a.APPNAM,
         COUNT(DISTINCT p.PSTID) AS QUESTIONS,
         SUM(CASE WHEN an.VALIDATED = 1 THEN 1 ELSE 0 END) AS REPONSES_RETENUES
    FROM dbo.FAQPOSTS p
    INNER JOIN USERSMANAGER.dbo.APPLICATIONS a ON a.APPID = p.APPID
    LEFT JOIN dbo.FAQANSWERS an ON an.PSTID = p.PSTID
   GROUP BY a.APPCOD, a.APPNAM
   ORDER BY a.APPCOD;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRAN;
  THROW;
END CATCH;
GO
