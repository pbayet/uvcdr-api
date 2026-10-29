/**
 * Global Error Registry
 * -----------------------------------------
 * Chaque erreur suit la structure :
 * {
 *   CODE: number,
 *   MESSAGE: { en: string, fr: string },
 *   DESCRIPTION: { en: string, fr: string },
 *   HTTP_RESPONSE_CODE: number
 * }
 *
 * Familles : 1100 auth/utilisateur, 1200 LDAP, 1300 base de données,
 * 1400 Outlook/Calendrier (Microsoft Graph), 1500 mailing/relances,
 * 1600 FAQ, 1700 VINIDOC, 9999 fallback.
 */
export const ERROR_REGISTRY = {
  ACCESS_DENIED: {
    CODE: 1103,
    MESSAGE: { en: "Access denied", fr: "Accès refusé" },
    DESCRIPTION: {
      en: "The user does not have sufficient permissions to perform this action.",
      fr: "L'utilisateur ne dispose pas des autorisations nécessaires pour effectuer cette action.",
    },
    HTTP_RESPONSE_CODE: 403,
  },

  ACCESS_DENIED_WO_LOGOUT: {
    CODE: 1111,
    MESSAGE: { en: "Access denied", fr: "Accès refusé" },
    DESCRIPTION: {
      en: "The user does not have sufficient permissions to perform this action.",
      fr: "L'utilisateur ne dispose pas des autorisations nécessaires pour effectuer cette action.",
    },
    // 460 (et non 403) : le front redirige vers /login sur un 403 exact.
    // On garde donc un statut 4xx distinct pour signaler un refus de permission
    // "silencieux", sans provoquer la déconnexion automatique côté front.
    HTTP_RESPONSE_CODE: 460,
  },

  INVALID_CREDENTIALS: {
    CODE: 1104,
    MESSAGE: { en: "Invalid credentials", fr: "Identifiants incorrects" },
    DESCRIPTION: {
      en: "The provided email address or password is incorrect.",
      fr: "L'adresse e-mail ou le mot de passe fourni est incorrect.",
    },
    HTTP_RESPONSE_CODE: 401,
  },

  USER_NOT_FOUND: {
    CODE: 1105,
    MESSAGE: { en: "User not found", fr: "Utilisateur introuvable" },
    DESCRIPTION: {
      en: "No user account matches the provided information.",
      fr: "Aucun compte utilisateur ne correspond aux informations fournies.",
    },
    HTTP_RESPONSE_CODE: 404,
  },

  MISSING_PARAMETERS: {
    CODE: 1106,
    MESSAGE: { en: "Missing parameters", fr: "Paramètres manquants" },
    DESCRIPTION: {
      en: "One or more required parameters are missing from the request.",
      fr: "Un ou plusieurs paramètres requis sont manquants dans la requête.",
    },
    HTTP_RESPONSE_CODE: 400,
  },

  ACCOUNT_TEMPORARILY_BLOCKED: {
    CODE: 1107,
    MESSAGE: {
      en: "Account temporarily blocked",
      fr: "Compte temporairement bloqué",
    },
    DESCRIPTION: {
      en: "Too many failed login attempts. Please wait before trying again.",
      fr: "Trop de tentatives de connexion ont échoué. Veuillez patienter avant de réessayer.",
    },
    HTTP_RESPONSE_CODE: 429,
  },

  "ACCOUNT_LOCKED_[TIME]": {
    CODE: 1108,
    MESSAGE: {
      en: "Account blocked for [TIME]",
      fr: "Compte bloqué pendant [TIME]",
    },
    DESCRIPTION: {
      en: "Too many failed login attempts. Please wait until the cooldown expires ([TIME]).",
      fr: "Trop de tentatives de connexion ont échoué. Veuillez attendre la fin du délai de blocage ([TIME]).",
    },
    HTTP_RESPONSE_CODE: 429,
  },

  INVALID_TOKEN: {
    CODE: 1109,
    MESSAGE: {
      en: "Authentication token invalid",
      fr: "Jeton d'authentification invalide",
    },
    DESCRIPTION: {
      en: "The provided authentication token is invalid.",
      fr: "Le jeton d'authentification fourni est invalide.",
    },
    HTTP_RESPONSE_CODE: 401,
  },

  TOKEN_EXPIRED: {
    CODE: 1110,
    MESSAGE: { en: "Session expired", fr: "Session expirée" },
    DESCRIPTION: {
      en: "The session has expired due to inactivity.",
      fr: "La session a expiré en raison de l'inactivité.",
    },
    HTTP_RESPONSE_CODE: 401,
  },

  LDAP_CONFIGURATION_ERROR: {
    CODE: 1201,
    MESSAGE: {
      en: "LDAP configuration error",
      fr: "Erreur de configuration LDAP",
    },
    DESCRIPTION: {
      en: "LDAP environment variables are missing or incorrectly configured.",
      fr: "Les variables d'environnement LDAP sont manquantes ou mal configurées.",
    },
    HTTP_RESPONSE_CODE: 500,
  },

  LDAP_SERVICE_BIND_FAILED: {
    CODE: 1202,
    MESSAGE: {
      en: "LDAP service connection failed",
      fr: "Échec de la connexion au service LDAP",
    },
    DESCRIPTION: {
      en: "The service account could not authenticate to the LDAP directory.",
      fr: "Le compte de service n'a pas pu s'authentifier auprès de l'annuaire LDAP.",
    },
    HTTP_RESPONSE_CODE: 500,
  },

  LDAP_SEARCH_FAILED: {
    CODE: 1203,
    MESSAGE: { en: "LDAP search failed", fr: "Échec de la recherche LDAP" },
    DESCRIPTION: {
      en: "An error occurred while executing an LDAP search request.",
      fr: "Une erreur s'est produite lors de l'exécution d'une requête de recherche LDAP.",
    },
    HTTP_RESPONSE_CODE: 500,
  },

  LDAP_SEARCH_ERROR: {
    CODE: 1204,
    MESSAGE: { en: "LDAP search error", fr: "Erreur de recherche LDAP" },
    DESCRIPTION: {
      en: "An unexpected error occurred during the LDAP search process.",
      fr: "Une erreur inattendue s'est produite lors du processus de recherche LDAP.",
    },
    HTTP_RESPONSE_CODE: 500,
  },

  LDAP_ATTRIBUTE_NOT_READABLE: {
    CODE: 1205,
    MESSAGE: {
      en: "LDAP attribute not readable",
      fr: "Attribut LDAP illisible",
    },
    DESCRIPTION: {
      en: "The LDAP service account is not allowed to read a required attribute (e.g. pwdLastSet).",
      fr: "Le compte de service LDAP n'a pas le droit de lire un attribut requis (ex. pwdLastSet).",
    },
    HTTP_RESPONSE_CODE: 500,
  },

  DB_CONFIGURATION_ERROR: {
    CODE: 1301,
    MESSAGE: {
      en: "Database configuration error",
      fr: "Erreur de configuration de la base de données",
    },
    DESCRIPTION: {
      en: "Database environment variables are missing or invalid.",
      fr: "Les variables d'environnement de la base de données sont manquantes ou invalides.",
    },
    HTTP_RESPONSE_CODE: 500,
  },

  DB_CONNECTION_FAILED: {
    CODE: 1302,
    MESSAGE: {
      en: "Database connection failed",
      fr: "Échec de la connexion à la base de données",
    },
    DESCRIPTION: {
      en: "Unable to establish a connection with the database server.",
      fr: "Impossible d'établir une connexion avec le serveur de base de données.",
    },
    HTTP_RESPONSE_CODE: 503,
  },

  DB_LOGIN_FAILED: {
    CODE: 1303,
    MESSAGE: {
      en: "Database login failed",
      fr: "Échec de l'authentification SQL",
    },
    DESCRIPTION: {
      en: "The database rejected the provided login credentials.",
      fr: "La base de données a rejeté les identifiants de connexion fournis.",
    },
    HTTP_RESPONSE_CODE: 401,
  },

  DB_NOT_FOUND: {
    CODE: 1304,
    MESSAGE: { en: "Database not found", fr: "Base de données introuvable" },
    DESCRIPTION: {
      en: "The specified database could not be located on the server.",
      fr: "La base de données spécifiée est introuvable sur le serveur.",
    },
    HTTP_RESPONSE_CODE: 404,
  },

  DB_QUERY_ERROR: {
    CODE: 1305,
    MESSAGE: {
      en: "Database query error",
      fr: "Erreur lors de l'exécution de la requête SQL",
    },
    DESCRIPTION: {
      en: "An unexpected error occurred while executing an SQL query.",
      fr: "Une erreur inattendue s'est produite lors de l'exécution d'une requête SQL.",
    },
    HTTP_RESPONSE_CODE: 500,
  },

  DB_POOL_ERROR: {
    CODE: 1306,
    MESSAGE: {
      en: "Database connection pool error",
      fr: "Erreur du pool de connexions",
    },
    DESCRIPTION: {
      en: "The SQL connection pool encountered a failure or timeout.",
      fr: "Le pool de connexions SQL a rencontré une défaillance ou un délai d'attente.",
    },
    HTTP_RESPONSE_CODE: 500,
  },

  DB_UNAVAILABLE: {
    CODE: 1307,
    MESSAGE: { en: "Database unavailable", fr: "Base de données indisponible" },
    DESCRIPTION: {
      en: "The database service is temporarily unavailable or under maintenance.",
      fr: "Le service de base de données est temporairement indisponible ou en maintenance.",
    },
    HTTP_RESPONSE_CODE: 503,
  },

  DATA_NOT_FOUND: {
    CODE: 1308,
    MESSAGE: { en: "Data not found", fr: "Données introuvables" },
    DESCRIPTION: {
      en: "No data matches the provided information.",
      fr: "Aucune donnée ne correspond aux informations fournies.",
    },
    HTTP_RESPONSE_CODE: 404,
  },

  // Levée par modules/faq/services.js (createPost/updatePost) : APPID ne
  // référence aucune application active dans USERSMANAGER.dbo.APPLICATIONS.
  // Vérification explicite côté application faute de contrainte FK
  // possible entre les deux bases (cf. en-tête sql/FAQPOSTS.table.sql).
  APPLICATION_NOT_FOUND: {
    CODE: 1309,
    MESSAGE: { en: "Application not found", fr: "Application introuvable" },
    DESCRIPTION: {
      en: "No active application matches the provided APPID.",
      fr: "Aucune application active ne correspond à l'APPID fourni.",
    },
    HTTP_RESPONSE_CODE: 404,
  },

  OUTLOOK_NOT_CONFIGURED: {
    CODE: 1401,
    MESSAGE: {
      en: "Outlook integration not configured",
      fr: "Intégration Outlook non configurée",
    },
    DESCRIPTION: {
      en: "Azure AD environment variables (AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET) are missing.",
      fr: "Les variables d'environnement Azure AD (AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET) sont manquantes.",
    },
    HTTP_RESPONSE_CODE: 500,
  },

  OUTLOOK_AUTH_FAILED: {
    CODE: 1402,
    MESSAGE: {
      en: "Outlook authentication failed",
      fr: "Échec d'authentification Outlook",
    },
    DESCRIPTION: {
      en: "Unable to obtain an access token from Azure AD for Microsoft Graph.",
      fr: "Impossible d'obtenir un jeton d'accès Azure AD pour Microsoft Graph.",
    },
    HTTP_RESPONSE_CODE: 502,
  },

  OUTLOOK_GRAPH_ERROR: {
    CODE: 1403,
    MESSAGE: {
      en: "Microsoft Graph request failed",
      fr: "Échec de la requête Microsoft Graph",
    },
    DESCRIPTION: {
      en: "Microsoft Graph rejected the calendar request (invalid mailbox, insufficient permissions...).",
      fr: "Microsoft Graph a rejeté la requête calendrier (boîte invalide, permissions insuffisantes...).",
    },
    HTTP_RESPONSE_CODE: 502,
  },

  OUTLOOK_MISSING_MAILBOX: {
    CODE: 1404,
    MESSAGE: {
      en: "No target mailbox for the calendar event",
      fr: "Aucune boîte cible pour l'événement calendrier",
    },
    DESCRIPTION: {
      en: "Neither `mailbox` was provided nor OUTLOOK_DEFAULT_MAILBOX is configured.",
      fr: "Ni `mailbox` n'a été fourni, ni OUTLOOK_DEFAULT_MAILBOX n'est configuré.",
    },
    HTTP_RESPONSE_CODE: 500,
  },

  OUTLOOK_MISSING_SUBJECT: {
    CODE: 1405,
    MESSAGE: {
      en: "Event subject is required",
      fr: "Le sujet de l'événement est obligatoire",
    },
    DESCRIPTION: {
      en: "The `subject` field is required to create a calendar event.",
      fr: "Le champ `subject` est obligatoire pour créer un événement calendrier.",
    },
    HTTP_RESPONSE_CODE: 400,
  },

  OUTLOOK_MISSING_START: {
    CODE: 1406,
    MESSAGE: {
      en: "Event start date is required",
      fr: "La date de début de l'événement est obligatoire",
    },
    DESCRIPTION: {
      en: "The `start` field is required to create a calendar event.",
      fr: "Le champ `start` est obligatoire pour créer un événement calendrier.",
    },
    HTTP_RESPONSE_CODE: 400,
  },

  OUTLOOK_MISSING_END: {
    CODE: 1407,
    MESSAGE: {
      en: "Event end date is required",
      fr: "La date de fin de l'événement est obligatoire",
    },
    DESCRIPTION: {
      en: "The `end` field is required to create a calendar event.",
      fr: "Le champ `end` est obligatoire pour créer un événement calendrier.",
    },
    HTTP_RESPONSE_CODE: 400,
  },

  OUTLOOK_MISSING_EVENT_ID: {
    CODE: 1408,
    MESSAGE: {
      en: "Event id is required",
      fr: "L'identifiant de l'événement est obligatoire",
    },
    DESCRIPTION: {
      en: "The `eventId` field is required to update, delete or fetch a calendar event.",
      fr: "Le champ `eventId` est obligatoire pour mettre à jour, supprimer ou récupérer un événement calendrier.",
    },
    HTTP_RESPONSE_CODE: 400,
  },

  OUTLOOK_MISSING_ATTENDEES: {
    CODE: 1409,
    MESSAGE: {
      en: "Meeting attendees are required",
      fr: "Les participants de la réunion sont obligatoires",
    },
    DESCRIPTION: {
      en: "createMeeting() requires at least one attendee.",
      fr: "createMeeting() requiert au moins un participant.",
    },
    HTTP_RESPONSE_CODE: 400,
  },

  OUTLOOK_INVALID_ATTENDEE: {
    CODE: 1410,
    MESSAGE: { en: "Invalid attendee", fr: "Participant invalide" },
    DESCRIPTION: {
      en: "Each attendee must include a valid `email` field.",
      fr: "Chaque participant doit comporter un champ `email` valide.",
    },
    HTTP_RESPONSE_CODE: 400,
  },

  // ---------------------------------------------------------------------
  // 1500 — Mailing / relances (modules/passwords)
  // ---------------------------------------------------------------------

  MAIL_NOT_CONFIGURED: {
    CODE: 1501,
    MESSAGE: { en: "Mail service not configured", fr: "Service mail non configuré" },
    DESCRIPTION: {
      en: "The SMTP relay is not configured on the server (HOST variable missing).",
      fr: "Le relais SMTP n'est pas configuré sur le serveur (variable HOST manquante).",
    },
    HTTP_RESPONSE_CODE: 503,
  },

  MISSING_RECIPIENT: {
    CODE: 1502,
    MESSAGE: { en: "No recipient", fr: "Aucun destinataire" },
    DESCRIPTION: {
      en: "No recipient could be resolved for this email (check BASE_RECIPIENT_EMAIL outside production).",
      fr: "Aucun destinataire n'a pu être déterminé pour cet email (vérifier BASE_RECIPIENT_EMAIL hors production).",
    },
    HTTP_RESPONSE_CODE: 500,
  },

  PWD_REMINDER_AD_ACCOUNT_NOT_FOUND: {
    CODE: 1503,
    MESSAGE: { en: "Active Directory account not found", fr: "Compte Active Directory introuvable" },
    DESCRIPTION: {
      en: "No enabled Active Directory account matches this email.",
      fr: "Aucun compte Active Directory actif ne correspond à cet email.",
    },
    HTTP_RESPONSE_CODE: 404,
  },

  PWD_REMINDER_NOT_APPLICABLE: {
    CODE: 1504,
    MESSAGE: { en: "Reminder not applicable", fr: "Relance sans objet" },
    DESCRIPTION: {
      en: "This account's password never expires.",
      fr: "Le mot de passe de ce compte n'expire jamais.",
    },
    HTTP_RESPONSE_CODE: 422,
  },

  "PWD_REMINDER_TOO_RECENT_[TIME]": {
    CODE: 1505,
    MESSAGE: { en: "Reminder already sent", fr: "Relance déjà envoyée" },
    DESCRIPTION: {
      en: "A reminder was sent to this user recently. Try again in [TIME].",
      fr: "Une relance a déjà été envoyée récemment à cet utilisateur. Réessayez dans [TIME].",
    },
    HTTP_RESPONSE_CODE: 429,
  },

  // modules/faq/controllers.validateAnswer : la notion de "bonne réponse"
  // est réservée aux QUESTIONS (base de connaissance) ; une suggestion se
  // transforme en ticket à la place (cf. FAQ_TICKET_*).
  FAQ_VALIDATION_NOT_ALLOWED: {
    CODE: 1601,
    MESSAGE: {
      en: "Validation not allowed",
      fr: "Validation non autorisée",
    },
    DESCRIPTION: {
      en: "Only answers to a question can be marked as the right answer.",
      fr: "Seules les réponses à une question peuvent être marquées comme bonne réponse.",
    },
    HTTP_RESPONSE_CODE: 422,
  },

  // modules/faq/controllers.createTicketFromSuggestion : seul un post de
  // type SUGGESTION (ou une de ses réponses) peut devenir un ticket.
  FAQ_TICKET_NOT_SUGGESTION: {
    CODE: 1602,
    MESSAGE: {
      en: "Not a suggestion",
      fr: "Ce n'est pas une suggestion",
    },
    DESCRIPTION: {
      en: "Only a suggestion or one of its answers can be turned into a ticket.",
      fr: "Seule une suggestion ou l'une de ses réponses peut être transformée en ticket.",
    },
    HTTP_RESPONSE_CODE: 422,
  },

  // Un ticket existe déjà (ou est en cours de création) pour cet élément —
  // cf. sql/FAQTICKETS.table.sql (UQ_FAQTICKETS_PSTID_ANSID).
  FAQ_TICKET_ALREADY_EXISTS: {
    CODE: 1603,
    MESSAGE: {
      en: "Ticket already exists",
      fr: "Ticket déjà créé",
    },
    DESCRIPTION: {
      en: "A ticket has already been created from this item.",
      fr: "Un ticket a déjà été créé à partir de cet élément.",
    },
    HTTP_RESPONSE_CODE: 409,
  },

  // modules/faq/controllers.convertPost : une suggestion transformée en
  // ticket (elle-même ou l'une de ses réponses) ne peut plus devenir une
  // question — cf. sql/FAQTICKETS.table.sql.
  FAQ_CONVERSION_TICKET_LINKED: {
    CODE: 1604,
    MESSAGE: {
      en: "Conversion not allowed",
      fr: "Conversion impossible",
    },
    DESCRIPTION: {
      en: "A ticket has been created from this suggestion or one of its answers: it can no longer be turned into a question.",
      fr: "Un ticket a été créé à partir de cette suggestion ou de l'une de ses réponses : elle ne peut plus être convertie en question.",
    },
    HTTP_RESPONSE_CODE: 409,
  },

  // modules/faq/controllers.convertPost : l'auteur (non modérateur) ne peut
  // pas convertir en suggestion une question qui a déjà une bonne réponse
  // retenue par un modérateur (base de connaissance).
  FAQ_CONVERSION_VALIDATED_ANSWERS: {
    CODE: 1605,
    MESSAGE: {
      en: "Conversion not allowed",
      fr: "Conversion impossible",
    },
    DESCRIPTION: {
      en: "This question already has a validated answer: only a moderator can turn it into a suggestion.",
      fr: "Cette question a déjà une bonne réponse validée : seul un modérateur peut la convertir en suggestion.",
    },
    HTTP_RESPONSE_CODE: 409,
  },

  // ── 1700 VINIDOC (modules/vinidoc) ──
  VINIDOC_SHEET_NOT_FOUND: {
    CODE: 1701,
    MESSAGE: { en: "Sheet not found", fr: "Fiche introuvable" },
    DESCRIPTION: {
      en: "The oenological sheet does not exist or has been deleted.",
      fr: "La fiche œnologique n'existe pas ou a été supprimée.",
    },
    HTTP_RESPONSE_CODE: 404,
  },

  VINIDOC_SHEET_ALREADY_EXISTS: {
    CODE: 1702,
    MESSAGE: { en: "Sheet already exists", fr: "Fiche déjà existante" },
    DESCRIPTION: {
      en: "A sheet already exists for this bulk code and vintage.",
      fr: "Une fiche existe déjà pour ce code vrac et ce millésime.",
    },
    HTTP_RESPONSE_CODE: 409,
  },

  VINIDOC_CONCURRENT_UPDATE: {
    CODE: 1703,
    MESSAGE: { en: "Concurrent update", fr: "Modification concurrente" },
    DESCRIPTION: {
      en: "The data has been modified by another user in the meantime. Reload it before trying again.",
      fr: "Les données ont été modifiées par un autre utilisateur entre-temps. Rechargez-les avant de réessayer.",
    },
    HTTP_RESPONSE_CODE: 409,
  },

  VINIDOC_INVALID_STATUS_TRANSITION: {
    CODE: 1704,
    MESSAGE: { en: "Action not allowed", fr: "Action impossible" },
    DESCRIPTION: {
      en: "This action is not allowed in the current status of the sheet.",
      fr: "Cette action n'est pas possible dans le statut actuel de la fiche.",
    },
    HTTP_RESPONSE_CODE: 409,
  },

  VINIDOC_DEFAULT_TRANSLATION_REQUIRED: {
    CODE: 1705,
    MESSAGE: { en: "Default language required", fr: "Langue par défaut obligatoire" },
    DESCRIPTION: {
      en: "The text in the default language is mandatory and cannot be deleted.",
      fr: "Le texte dans la langue par défaut est obligatoire et ne peut pas être supprimé.",
    },
    HTTP_RESPONSE_CODE: 422,
  },

  VINIDOC_SHEET_NOT_VALIDATED: {
    CODE: 1706,
    MESSAGE: { en: "Sheet not validated", fr: "Fiche non validée" },
    DESCRIPTION: {
      en: "This sheet has never been validated by marketing: it cannot be used yet.",
      fr: "Cette fiche n'a jamais été validée par le marketing : elle ne peut pas encore être utilisée.",
    },
    HTTP_RESPONSE_CODE: 409,
  },

  VINIDOC_VERSION_NOT_FOUND: {
    CODE: 1707,
    MESSAGE: { en: "Version not found", fr: "Version introuvable" },
    DESCRIPTION: {
      en: "This validated version does not exist.",
      fr: "Cette version validée n'existe pas.",
    },
    HTTP_RESPONSE_CODE: 404,
  },

  "VINIDOC_TRANSLATION_MISSING_[LNGCOD]": {
    CODE: 1708,
    MESSAGE: { en: "Translation missing", fr: "Traduction manquante" },
    DESCRIPTION: {
      en: "The last validated version has no text in language \"[LNGCOD]\".",
      fr: "La dernière version validée ne contient pas de texte dans la langue « [LNGCOD] ».",
    },
    HTTP_RESPONSE_CODE: 422,
  },

  VINIDOC_UNKNOWN_REFERENCE: {
    CODE: 1709,
    MESSAGE: { en: "Unknown reference", fr: "Référence inconnue" },
    DESCRIPTION: {
      en: "Unknown or inactive language or colour.",
      fr: "Langue ou couleur inconnue ou inactive.",
    },
    HTTP_RESPONSE_CODE: 400,
  },

  VINIDOC_TEMPLATE_NOT_FOUND: {
    CODE: 1710,
    MESSAGE: { en: "Template not found", fr: "Modèle introuvable" },
    DESCRIPTION: {
      en: "The template does not exist, is inactive or has been deleted.",
      fr: "Le modèle n'existe pas, est inactif ou a été supprimé.",
    },
    HTTP_RESPONSE_CODE: 404,
  },

  VINIDOC_TEMPLATE_NAME_EXISTS: {
    CODE: 1711,
    MESSAGE: { en: "Template name already used", fr: "Nom de modèle déjà utilisé" },
    DESCRIPTION: {
      en: "Another template already has this name.",
      fr: "Un autre modèle porte déjà ce nom.",
    },
    HTTP_RESPONSE_CODE: 409,
  },

  VINIDOC_TEMPLATE_INVALID: {
    CODE: 1712,
    MESSAGE: { en: "Invalid template", fr: "Modèle invalide" },
    DESCRIPTION: {
      en: "The file is not a valid PowerPoint presentation (.pptx) or contains no slide.",
      fr: "Le fichier n'est pas une présentation PowerPoint (.pptx) valide ou ne contient aucune diapositive.",
    },
    HTTP_RESPONSE_CODE: 400,
  },

  VINIDOC_TEMPLATE_FILE_REQUIRED: {
    CODE: 1713,
    MESSAGE: { en: "File required", fr: "Fichier obligatoire" },
    DESCRIPTION: {
      en: "A .pptx file must be sent in the \"file\" field.",
      fr: "Un fichier .pptx doit être envoyé dans le champ « file ».",
    },
    HTTP_RESPONSE_CODE: 400,
  },

  VINIDOC_TEMPLATE_FILE_MISSING: {
    CODE: 1714,
    MESSAGE: { en: "Template file missing", fr: "Fichier du modèle introuvable" },
    DESCRIPTION: {
      en: "The template file cannot be found on the server.",
      fr: "Le fichier du modèle est introuvable sur le serveur.",
    },
    HTTP_RESPONSE_CODE: 500,
  },

  "VINIDOC_TEMPLATE_LANGUAGE_MISMATCH_[LNGCOD]": {
    CODE: 1715,
    MESSAGE: { en: "Language not supported by template", fr: "Langue non prise en charge par le modèle" },
    DESCRIPTION: {
      en: "This template can only be used in language \"[LNGCOD]\".",
      fr: "Ce modèle n'est utilisable que dans la langue « [LNGCOD] ».",
    },
    HTTP_RESPONSE_CODE: 422,
  },

  VINIDOC_UNKNOWN_TEMPLATE_TAG: {
    CODE: 1716,
    MESSAGE: { en: "Unknown tag", fr: "Balise inconnue" },
    DESCRIPTION: {
      en: "At least one tag is not present in the template.",
      fr: "Au moins une balise n'est pas présente dans le modèle.",
    },
    HTTP_RESPONSE_CODE: 400,
  },

  "VINIDOC_TAG_CONSTRAINTS_[DETAILS]": {
    CODE: 1717,
    MESSAGE: { en: "Template constraints not met", fr: "Contraintes du modèle non respectées" },
    DESCRIPTION: {
      en: "Texts too long or missing for this template: [DETAILS]. Correct the sheet and have it validated again.",
      fr: "Textes trop longs ou manquants pour ce modèle : [DETAILS]. Corrigez la fiche puis faites-la valider de nouveau.",
    },
    HTTP_RESPONSE_CODE: 422,
  },

  VINIDOC_PDF_CONVERSION_FAILED: {
    CODE: 1718,
    MESSAGE: { en: "PDF conversion failed", fr: "Échec de la conversion PDF" },
    DESCRIPTION: {
      en: "The PDF could not be produced. Try the PowerPoint format or contact IT.",
      fr: "Le PDF n'a pas pu être produit. Essayez le format PowerPoint ou contactez l'informatique.",
    },
    HTTP_RESPONSE_CODE: 500,
  },

  VINIDOC_DEFAULT_LANGUAGE_MISSING: {
    CODE: 1719,
    MESSAGE: { en: "Configuration error", fr: "Erreur de configuration" },
    DESCRIPTION: {
      en: "No default language is configured (LANGUAGES table).",
      fr: "Aucune langue par défaut n'est configurée (table LANGUAGES).",
    },
    HTTP_RESPONSE_CODE: 500,
  },

  VINIDOC_ARTICLE_NOT_FOUND: {
    CODE: 1720,
    MESSAGE: { en: "Article not found", fr: "Article introuvable" },
    DESCRIPTION: {
      en: "This finished-product article (PFI) does not exist in the data warehouse.",
      fr: "Cet article produit fini (PFI) n'existe pas dans l'entrepôt de données.",
    },
    HTTP_RESPONSE_CODE: 404,
  },

  "VINIDOC_ARTICLE_SHEET_MISMATCH_[CODVRAC]": {
    CODE: 1721,
    MESSAGE: { en: "Article and sheet do not match", fr: "Article et fiche incompatibles" },
    DESCRIPTION: {
      en: "The bulk wine code of the sheet (\"[CODVRAC]\") is not a component of this article.",
      fr: "Le code vrac de la fiche (« [CODVRAC] ») n'est pas un composant de cet article.",
    },
    HTTP_RESPONSE_CODE: 400,
  },

  VINIDOC_SHEET_RESERVED: {
    CODE: 1722,
    MESSAGE: { en: "Sheet being edited", fr: "Fiche en cours de modification" },
    DESCRIPTION: {
      en: "Another user is editing this sheet: it is read-only until the sheet is saved or closed.",
      fr: "Un autre utilisateur modifie cette fiche : elle reste en lecture seule jusqu'à son enregistrement ou sa fermeture.",
    },
    HTTP_RESPONSE_CODE: 423,
  },

  "VINIDOC_SHEET_RESERVED_[USRNAME]_[SINCE]": {
    CODE: 1722,
    MESSAGE: { en: "Sheet being edited", fr: "Fiche en cours de modification" },
    DESCRIPTION: {
      en: "[USRNAME] has been editing this sheet since [SINCE]: it is read-only until the sheet is saved or closed.",
      fr: "[USRNAME] modifie cette fiche depuis le [SINCE] : elle reste en lecture seule jusqu'à son enregistrement ou sa fermeture.",
    },
    HTTP_RESPONSE_CODE: 423,
  },

  INTERNAL_ERROR: {
    CODE: 9999,
    MESSAGE: { en: "Internal server error", fr: "Erreur interne du serveur" },
    DESCRIPTION: {
      en: "An unexpected error occurred while processing the request.",
      fr: "Une erreur inattendue s'est produite lors du traitement de la requête.",
    },
    HTTP_RESPONSE_CODE: 500,
  },
};
