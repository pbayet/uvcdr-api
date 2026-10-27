import sql from "mssql";
import crypto from "crypto";
import { runQuery, getDbConnexion } from "../../core/utils/db.utils.js";

/* ═══════════════════════════════════════════════════════════════
   FSA — Services (Fiches Suivi Affaires)

   REFONTE BDD (FSA_BIS) — ce fichier remplace les appels à
   usp_GetFolders_JSON / usp_GetFoldersList_JSON / vw_FsaGests /
   vw_ServicesMustValidate / vw_FolderCurrentStatuses /
   vw_FolderValidationsWithDelay / vw_FsaCanDeleteGest par des requêtes
   directes (ou de petites vues ciblées, cf. sql/02_views.sql) — décision
   produit : pas de vue/procédure "par défaut", uniquement là où la même
   logique est réellement réutilisée à plusieurs endroits.

   Tables réelles utilisées (FSA_BIS) :
     FSAENT, FSAENTSTA, FSAGES, FSAGES_UTILISATEURS, FSAVALID, FSAVALTYP,
     FSASTA, FSATYP, FSAPRODUITS, FSACLIENTS, FSAPAYS, FSAVENTES, FSAPJ,
     FSANOMENCLATURES, FSAVALCNDSET, FSAVALCNDRESULT, FSAVALCNDOPR

   Vues utilisées (sql/02_views.sql, à exécuter avant ce déploiement) :
     dbo.vw_FsaCurrentStatus        (remplace vw_FolderCurrentStatuses)
     dbo.vw_FsaServicesMustValidate (remplace vw_ServicesMustValidate)
     dbo.vw_FsaValidations          (remplace vw_FsaValidations)
     dbo.vw_FolderFiles             (fournie par toi — pont FSAPJ/ATTACHMENTS)

   Procédure conservée telle quelle (fournie par toi, inchangée) :
     dbo.usp_UpdateFsaConditionResults

   Autres bases :
     USERSMANAGER.dbo.POSITIONS, USERSMANAGER.dbo.USERS, USERSMANAGER.dbo.V_Users

   Typage des paramètres : les colonnes "codes" (NUMDOS, NUMGES, TYPDOS,
   CODETA, CLIPAY, SERVGES, VALTYPCOD, NUMDOSBAS) sont passées en VARCHAR
   dans FSA_BIS (contre NVARCHAR avant). On aligne les bindings mssql en
   conséquence (sql.VarChar au lieu de sql.NVarChar) : un paramètre NVARCHAR
   comparé à une colonne VARCHAR force SQL Server à convertir la colonne
   (perd l'index / empêche le seek), donc le mauvais type ici annule une
   bonne partie du gain des nouveaux index (cf. sql/01_indexes.sql).

   Comme pour declcav/ticketing (cf. audit dette technique 4.2), chaque
   fonction utilise runQuery() (core/utils/db.utils.js) au lieu du motif
   manuel getDbConnexion → generateAutoKey → getPreparedStatement →
   execute. Les transactions multi-requêtes (delsertPjs, delsertNomenclature,
   postGestionnaire, patchGestionnaire) conservent une gestion explicite de
   transaction (sql.Transaction) car runQuery() ne gère qu'une requête à la fois.
═══════════════════════════════════════════════════════════════ */

function getTypeFilter(type) {
  switch (type) {
    case "archive":
      return { CODETA_VAL: "ARC", INVERT_CODETA_VAL: false, DELETED_VAL: 0 };

    case "delete":
      return { CODETA_VAL: null, INVERT_CODETA_VAL: false, DELETED_VAL: 1 };

    case "all":
      return { CODETA_VAL: null, INVERT_CODETA_VAL: false, DELETED_VAL: null };

    default: // "default"
      return { CODETA_VAL: "ARC", INVERT_CODETA_VAL: true, DELETED_VAL: 0 };
  }
}

/* -------------------------------------------------------------------------- */
/*                    DOSSIERS — Requête "liste" (allégée)                    */
/* -------------------------------------------------------------------------- */

/**
 * Bloc SELECT/FROM partagé par getFsas / getReadOnlyFsas / getMyFsas.
 * Une seule ligne par dossier (pas de fan-out), avec les agrégats calculés
 * via OUTER APPLY (seek-able grâce aux index de sql/01_indexes.sql) plutôt
 * que par LEFT JOIN + GROUP BY sur des ensembles potentiellement larges —
 * c'est très probablement la principale source de lenteur de l'ancienne
 * usp_GetFoldersList_JSON.
 *
 * ENT_MY_VALIDATION_CODE : dernier VALTYPCOD posé par un service dont
 * @USRID_VAL fait partie (FSAGES_UTILISATEURS) sur ce dossier. NULL si
 * @USRID_VAL n'est pas fourni (cas getReadOnlyFsas) ou si aucune validation.
 *
 * @param {string} extraWhere - condition additionnelle déjà écrite en SQL
 *   (ex: "e.NUMGES = @NUMGES_VAL"), ajoutée en ET à la clause WHERE.
 */
function buildFolderListQuery(extraWhere = "") {
  return `
    SELECT
        e.NUMDOS      AS ENT_NUMDOS,
        e.NOMDOS      AS ENT_NOMDOS,
        e.NOTDOS      AS ENT_NOTDOS,
        cs.CODETA     AS ENT_CODETA,
        cs.DESETA     AS ENT_DESETA,
        e.DELETED     AS ENT_DELETED,
        e.CREDAT      AS ENT_CREDAT,
        cs.EAVDAT     AS ENT_EAVDAT,

        CONCAT(uges.LSTNAM, ' ', uges.FSTNAM) AS ENT_GES_GESNAM,
        ges.NOMGES    AS ENT_GES_NOMGES,

        e.NUMDEM      AS ENT_DEM_NUMDEM,
        CONCAT(udem.LSTNAM, ' ', udem.FSTNAM) AS ENT_DEM_GESNAM,
        dem.NOMGES    AS ENT_DEM_NOMGES,

        c.BPCNUM      AS CLI_BPCNUM,
        c.BPCNAM      AS CLI_BPCNAM,
        c.CLINAM      AS CLI_CLINAM,
        c.CLIACT      AS CLI_CLIACT,
        c.NOMACT      AS CLI_NOMACT,

        myval.VALTYPCOD              AS ENT_MY_VALIDATION_CODE,
        ISNULL(pj.PJ_COUNT, 0)       AS ENT_PJ_COUNT,
        ISNULL(valserv.SERVICES, '') AS ENT_VALIDATED_SERVICES,
        CAST(CASE WHEN refval.NUMDOS IS NOT NULL THEN 1 ELSE 0 END AS BIT) AS ENT_IS_REF

    FROM dbo.FSAENT e
    INNER JOIN dbo.vw_FsaCurrentStatus cs ON cs.NUMDOS = e.NUMDOS
    LEFT JOIN dbo.FSAGES ges ON ges.NUMGES = e.NUMGES
    LEFT JOIN USERSMANAGER.dbo.USERS uges ON uges.USRID = e.GESUSRID
    LEFT JOIN dbo.FSAGES dem ON dem.NUMGES = e.NUMDEM
    LEFT JOIN USERSMANAGER.dbo.POSITIONS posdem ON posdem.POSCOD = e.NUMDEM
    LEFT JOIN USERSMANAGER.dbo.USERS udem ON udem.POSID = posdem.POSID
    LEFT JOIN dbo.FSACLIENTS c ON c.NUMDOS = e.NUMDOS
    OUTER APPLY (
        SELECT TOP 1 v.VALTYPCOD
        FROM dbo.FSAVALID v
        INNER JOIN dbo.FSAGES g2 ON g2.NUMGES = v.NUMGES
        INNER JOIN dbo.FSAGES_UTILISATEURS gu ON gu.GESID = g2.GESID
        WHERE v.NUMDOS = e.NUMDOS AND gu.USRID = @USRID_VAL
        ORDER BY v.CREDAT DESC
    ) myval
    OUTER APPLY (
        SELECT COUNT(*) AS PJ_COUNT FROM dbo.vw_FolderFiles f WHERE f.NUMDOS = e.NUMDOS
    ) pj
    OUTER APPLY (
        SELECT STRING_AGG(g3.SERVGES, ',') AS SERVICES
        FROM dbo.vw_FsaValidations v3
        INNER JOIN dbo.FSAGES g3 ON g3.NUMGES = v3.GES_NUMGES
        WHERE v3.NUMDOS = e.NUMDOS AND v3.VALTYPCOD <> 'DEL'
    ) valserv
    OUTER APPLY (
        SELECT TOP 1 v4.NUMDOS
        FROM dbo.FSAVALID v4
        WHERE v4.NUMDOS = e.NUMDOS AND v4.VALTYPCOD = 'REF'
    ) refval
    WHERE (@DELETED_VAL IS NULL OR e.DELETED = @DELETED_VAL)
      AND (
            @CODETA_VAL IS NULL
            OR (@INVERT_CODETA_VAL = 1 AND cs.CODETA <> @CODETA_VAL)
            OR (@INVERT_CODETA_VAL = 0 AND cs.CODETA = @CODETA_VAL)
          )
      ${extraWhere ? `AND (${extraWhere})` : ""}
    ORDER BY e.CREDAT DESC;
  `;
}

export async function getFsas(USRID, type = "default") {
  const filter = getTypeFilter(type);

  const result = await runQuery({
    moduleUrl: import.meta.url,
    key: `fsa.getFsas.${type}`,
    query: buildFolderListQuery(),
    inputs: {
      CODETA_VAL: { type: sql.VarChar(15), value: filter.CODETA_VAL },
      INVERT_CODETA_VAL: { type: sql.Bit, value: filter.INVERT_CODETA_VAL },
      DELETED_VAL: { type: sql.Bit, value: filter.DELETED_VAL },
      USRID_VAL: { type: sql.Int, value: USRID },
    },
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

export async function getReadOnlyFsas(type = "default") {
  const filter = getTypeFilter(type);

  const result = await runQuery({
    moduleUrl: import.meta.url,
    key: `fsa.getReadOnlyFsas.${type}`,
    query: buildFolderListQuery(),
    inputs: {
      CODETA_VAL: { type: sql.VarChar(15), value: filter.CODETA_VAL },
      INVERT_CODETA_VAL: { type: sql.Bit, value: filter.INVERT_CODETA_VAL },
      DELETED_VAL: { type: sql.Bit, value: filter.DELETED_VAL },
      // Pas d'utilisateur associé à ce mode lecture-seule (comportement
      // identique à l'ancien appel, qui ne passait pas non plus @USRID) :
      // ENT_MY_VALIDATION_CODE ressort systématiquement à NULL.
      USRID_VAL: { type: sql.Int, value: null },
    },
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

/**
 * Dossiers "à moi" pour un gestionnaire (NUMGES) donné.
 *
 * Reprend la logique portée par les anciens paramètres @NUMGES/@VALGES de
 * usp_GetFolders_JSON : un service "validateur" (VALGES=1) voit les
 * dossiers qu'il doit encore valider (vw_FsaServicesMustValidate) ; un
 * service non-validateur voit les dossiers dont il est le gestionnaire
 * (FSAENT.NUMGES). Ce point n'a pas pu être vérifié contre l'implémentation
 * d'origine (non fournie) — à confirmer.
 *
 * Optimisation vs V1.1.0 : l'ancien code appelait ICI usp_GetFolders_JSON
 * (la version DÉTAIL, avec nomenclatures/pj/validations en JSON par ligne)
 * alors que seul le format "liste" (formatFsasJsonList) est utilisé par le
 * contrôleur en sortie — tout le luxe du détail était calculé puis jeté.
 * On appelle désormais directement la requête liste, comme les deux autres
 * fonctions de ce bloc.
 */
export async function getMyFsas(NUMGES, type = "default") {
  const gest = await getGestionnaire(NUMGES);
  if (!gest) throw new Error("DATA_NOT_FOUND");

  const filter = getTypeFilter(type);

  const extraWhere = gest.VALGES
    ? `EXISTS (
         SELECT 1 FROM dbo.vw_FsaServicesMustValidate mv
         WHERE mv.NUMDOS = e.NUMDOS AND mv.NUMGES = @NUMGES_VAL
       )`
    : `e.NUMGES = @NUMGES_VAL`;

  const result = await runQuery({
    moduleUrl: import.meta.url,
    key: `fsa.getMyFsas.${type}.${gest.VALGES ? "val" : "own"}`,
    query: buildFolderListQuery(extraWhere),
    inputs: {
      CODETA_VAL: { type: sql.VarChar(15), value: filter.CODETA_VAL },
      INVERT_CODETA_VAL: { type: sql.Bit, value: filter.INVERT_CODETA_VAL },
      DELETED_VAL: { type: sql.Bit, value: filter.DELETED_VAL },
      NUMGES_VAL: { type: sql.VarChar(15), value: NUMGES },
      USRID_VAL: { type: sql.Int, value: null },
    },
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

/* -------------------------------------------------------------------------- */
/*                     DOSSIER — Requête "détail" (un NUMDOS)                 */
/* -------------------------------------------------------------------------- */

const FOLDER_HEADER_QUERY = `
    SELECT
        e.ENTID           AS ENT_ENTID,
        e.APPVRS          AS ENT_APPVRS,
        e.NUMDOS          AS ENT_NUMDOS,
        e.NUMDOSBAS       AS ENT_NUMDOSBAS,
        e.NOMDOS          AS ENT_NOMDOS,

        t.TYPID           AS ENT_TYPDOSID,
        e.TYPDOS          AS ENT_TYPDOS,
        t.TYDOSN          AS ENT_TYPDOSN,

        e.GESUSRID        AS ENT_GESUSRID,

        e.GESUSRID                              AS ENT_GES_USRID,
        ges.GESID                                AS ENT_GES_GESID,
        ges.NUMGES                               AS ENT_GES_NUMGES,
        ges.NOMGES                               AS ENT_GES_NOMGES,
        ges.VALGES                               AS ENT_GES_VALGES,
        ges.CREGES                               AS ENT_GES_CREGES,
        ges.SERVGES                              AS ENT_GES_SERVGES,
        CONCAT(uges.LSTNAM, ' ', uges.FSTNAM)    AS ENT_GES_GESNAM,
        ges.CREUSR                               AS ENT_GES_CREUSR,
        ges.CREDAT                               AS ENT_GES_CREDAT,
        ges.MODUSR                               AS ENT_GES_MODUSR,
        ges.MODDAT                               AS ENT_GES_MODDAT,

        udem.USRID                               AS ENT_DEM_USRID,
        dem.GESID                                AS ENT_DEM_GESID,
        dem.NUMGES                                AS ENT_DEM_NUMGES,
        e.NUMDEM                                 AS ENT_DEM_NUMDEM,
        dem.NOMGES                               AS ENT_DEM_NOMGES,
        dem.VALGES                               AS ENT_DEM_VALGES,
        dem.CREGES                               AS ENT_DEM_CREGES,
        dem.SERVGES                              AS ENT_DEM_SERVGES,
        CONCAT(udem.LSTNAM, ' ', udem.FSTNAM)    AS ENT_DEM_GESNAM,
        dem.CREUSR                               AS ENT_DEM_CREUSR,
        dem.CREDAT                               AS ENT_DEM_CREDAT,
        dem.MODUSR                               AS ENT_DEM_MODUSR,
        dem.MODDAT                               AS ENT_DEM_MODDAT,

        cs.STAID          AS ENT_STAID,
        cs.CODETA         AS ENT_CODETA,
        cs.DESETA         AS ENT_DESETA,

        e.NOTDOS          AS ENT_NOTDOS,
        e.CREUSR          AS ENT_CREUSR,
        e.CREDAT          AS ENT_CREDAT,
        cs.EAVDAT         AS ENT_EAVDAT,
        e.MODUSR          AS ENT_MODUSR,
        e.MODDAT          AS ENT_MODDAT,
        e.DELETED         AS ENT_DELETED,
        e.INNO            AS ENT_INNO,

        c.CLIENTID        AS CLI_CLIENTID,
        c.NUMDOS          AS CLI_NUMDOS,
        c.CLIEXI          AS CLI_CLIEXI,
        c.BPCNUM          AS CLI_BPCNUM,
        c.BPCNAM          AS CLI_BPCNAM,
        pay.PAYSID                    AS CLI_PAY_PAYSID,
        CAST(NULL AS VARCHAR(50))     AS CLI_PAY_NUMDOS,
        pay.CLIPAY                    AS CLI_PAY_CLIPAY,
        pay.CLIPAYN                   AS CLI_PAY_CLIPAYN,
        c.CLIACT          AS CLI_CLIACT,
        c.NOMACT          AS CLI_NOMACT,
        c.CLICCON         AS CLI_CLICCON,
        c.CLINAM          AS CLI_CLINAM,
        c.CLIMAIL         AS CLI_CLIMAIL,
        c.CLITEL          AS CLI_CLITEL,
        c.CLINOT          AS CLI_CLINOT,

        pr.PRODUITID      AS NOMS_PRODUITID,
        pr.NUMDOS         AS NOMS_NUMDOS,
        pr.TCLCOD         AS NOMS_TCLCOD,
        pr.CATNOM         AS NOMS_CATNOM,
        pr.ITMREF         AS NOMS_ITMREF,
        pr.ITMDES         AS NOMS_ITMDES,
        pr.ITMFMT         AS NOMS_ITMFMT,
        pr.DESFMT         AS NOMS_DESFMT,
        pr.CENTFMT        AS NOMS_CENTFMT,
        pr.ITMMAR         AS NOMS_ITMMAR,
        pr.DESMAR         AS NOMS_DESMAR,
        pr.ITMGAM         AS NOMS_ITMGAM,
        pr.DESGAM         AS NOMS_DESGAM,
        pr.ITMAPP         AS NOMS_ITMAPP,
        pr.DESAPP         AS NOMS_DESAPP,
        pr.ITMCEP         AS NOMS_ITMCEP,
        pr.DESCEP         AS NOMS_DESCEP,
        pr.ITMCOU         AS NOMS_ITMCOU,
        pr.DESCOU         AS NOMS_DESCOU,
        pr.ITMQUA         AS NOMS_ITMQUA,
        pr.DESQUA         AS NOMS_DESQUA,
        pr.ITMTYP         AS NOMS_ITMTYP,
        pr.DESTYP         AS NOMS_DESTYP,
        pr.ITMSPT         AS NOMS_ITMSPT,
        pr.DESSPT         AS NOMS_DESSPT,
        pr.ITMMIL         AS NOMS_ITMMIL,
        pr.CODCHADOM      AS NOMS_CODCHADOM,
        pr.CHADOM         AS NOMS_CHADOM,
        pr.CODDESALC      AS NOMS_CODDESALC,
        pr.CODBOIS        AS NOMS_CODBOIS,
        pr.MEDAIL         AS NOMS_MEDAIL,
        pr.ITMCON         AS NOMS_ITMCON,
        pr.ITMNOT         AS NOMS_ITMNOT,

        ve.VENTEID        AS VEN_VENTEID,
        ve.DATMAD         AS VEN_DATMAD,
        ve.ONESHO         AS VEN_ONESHO,
        ve.VOLANN         AS VEN_VOLANN,
        ve.VOLANN1        AS VEN_VOLANN1,
        ve.VOLANN2        AS VEN_VOLANN2,
        ve.VOLTIR         AS VEN_VOLTIR,
        ve.PRIANN         AS VEN_PRIANN,
        ve.PRIANN1        AS VEN_PRIANN1,
        ve.PRIANN2        AS VEN_PRIANN2,
        ve.PVC            AS VEN_PVC,
        ve.VENNOT         AS VEN_VENNOT,
        ve.FRANCO         AS VEN_FRANCO,
        ve.FDC            AS VEN_FDC,
        ve.AFA            AS VEN_AFA,
        ve.AFANOT         AS VEN_AFANOT

    FROM dbo.FSAENT e
    INNER JOIN dbo.vw_FsaCurrentStatus cs ON cs.NUMDOS = e.NUMDOS
    LEFT JOIN dbo.FSATYP t ON t.TYPDOS = e.TYPDOS
    LEFT JOIN dbo.FSAGES ges ON ges.NUMGES = e.NUMGES
    LEFT JOIN USERSMANAGER.dbo.USERS uges ON uges.USRID = e.GESUSRID
    LEFT JOIN dbo.FSAGES dem ON dem.NUMGES = e.NUMDEM
    LEFT JOIN USERSMANAGER.dbo.POSITIONS posdem ON posdem.POSCOD = e.NUMDEM
    LEFT JOIN USERSMANAGER.dbo.USERS udem ON udem.POSID = posdem.POSID
    LEFT JOIN dbo.FSACLIENTS c ON c.NUMDOS = e.NUMDOS
    LEFT JOIN dbo.FSAPAYS pay ON pay.CLIPAY = c.CLIPAY
    LEFT JOIN dbo.FSAPRODUITS pr ON pr.NUMDOS = e.NUMDOS
    LEFT JOIN dbo.FSAVENTES ve ON ve.NUMDOS = e.NUMDOS
    WHERE e.NUMDOS = @NUMDOS;
`;

const FOLDER_NOMENCLATURES_QUERY = `
    SELECT
        NOMENCLATUREID AS NOMS_NOM_NOMENCLATUREID,
        NUMDOS         AS NOMS_NOM_NUMDOS,
        LINDOS         AS NOMS_NOM_LINDOS,
        CLEDOS         AS NOMS_NOM_CLEDOS,
        ITMCAT         AS NOMS_NOM_ITMCAT,
        DESCAT         AS NOMS_NOM_DESCAT,
        ITMREF         AS NOMS_NOM_ITMREF,
        ITMDES         AS NOMS_NOM_ITMDES,
        BASQTY         AS NOMS_NOM_BASQTY,
        CPNITMREF      AS NOMS_NOM_CPNITMREF,
        CPNITMDES      AS NOMS_NOM_CPNITMDES,
        BOMUOM         AS NOMS_NOM_BOMUOM,
        BOMSTUCOE      AS NOMS_NOM_BOMSTUCOE,
        BOMQTY         AS NOMS_NOM_BOMQTY,
        LIKQTY         AS NOMS_NOM_LIKQTY,
        STU            AS NOMS_NOM_STU,
        ITMMIL         AS NOMS_NOM_ITMMIL,
        ITMMILN        AS NOMS_NOM_ITMMILN,
        NOTLINC        AS NOMS_NOM_NOTLINC,
        NOTDOS         AS NOMS_NOM_NOTDOS
    FROM dbo.FSANOMENCLATURES
    WHERE NUMDOS = @NUMDOS
    ORDER BY NOMENCLATUREID;
`;

// dbo.vw_FolderFiles unifie déjà FSAPJ (ancien système) et la table
// ATTACHMENTS partagée (nouveau système, non utilisé pour l'écriture FSA
// pour l'instant, cf. décision produit) — on la réutilise telle quelle pour
// la lecture, sans rien avoir à ajouter.
const FOLDER_PJS_QUERY = `
    SELECT
        ID, FILECODE, APPCODE, ENTITYTYPE, ENTITYID, ORIGINALNAME, STOREDNAME,
        RELATIVEPATH, MIMETYPE, EXTENSION, COMPRESSED, ORIGINALSIZEBYTES,
        SIZEBYTES, STATUS, UPLOADEDBY, CREATEDAT, DELETEDAT
    FROM dbo.vw_FolderFiles
    WHERE NUMDOS = @NUMDOS;
`;

const FOLDER_VALIDATIONS_QUERY = `
    SELECT
        VALIDID     AS VAL_VALIDID,
        NUMDOS      AS VAL_NUMDOS,
        GES_GESID   AS VAL_GES_GESID,
        GES_NUMGES  AS VAL_GES_NUMGES,
        GES_NOMGES  AS VAL_GES_NOMGES,
        GES_VALGES  AS VAL_GES_VALGES,
        GES_CREGES  AS VAL_GES_CREGES,
        GES_SERVGES AS VAL_GES_SERVGES,
        GES_GESNAM  AS VAL_GES_GESNAM,
        CREUSR      AS VAL_GES_CREUSR,
        CREDAT      AS VAL_GES_CREDAT,
        VALTYPID    AS VAL_TYP_VALTYPID,
        VALTYPCOD   AS VAL_TYP_VALTYPCOD,
        VALTYPNOM   AS VAL_TYP_VALTYPNOM,
        VALNOT      AS VAL_VALNOT,
        CREDAT      AS VAL_CREDAT,
        CREUSR      AS VAL_CREUSR
    FROM dbo.vw_FsaValidations
    WHERE NUMDOS = @NUMDOS
    ORDER BY CREDAT;
`;

const FOLDER_VALIDATIONS_FILES_QUERY = `
    SELECT
        ID,
        FILECODE,
        APPCODE,
        ENTITYTYPE,
        ENTITYID,
        ORIGINALNAME,
        STOREDNAME,
        RELATIVEPATH,
        MIMETYPE,
        EXTENSION,
        COMPRESSED,
        ORIGINALSIZEBYTES,
        SIZEBYTES,
        CHECKSUMSHA256,
        STATUS,
        UPLOADEDBY,
        CREATEDAT,
        DELETEDAT
    FROM dbo.vw_ValidationFiles
    WHERE NUMDOS = @NUMDOS;
`;

/**
 * Détail complet d'un dossier. Remplace `EXEC usp_GetFolders_JSON`.
 *
 * Optimisation vs l'ancienne procédure : 4 requêtes simples et indexées
 * (header 1 ligne + 3 listes filles) plutôt qu'une seule requête à base de
 * sous-requêtes corrélées FOR JSON par ligne — un dossier avec beaucoup de
 * nomenclatures/PJ/validations ne fait plus exploser le travail du moteur
 * SQL sur la ligne d'en-tête. modules/fsa/utils.js recompose exactement la
 * même forme de JSON qu'avant à partir de ces 4 recordsets.
 *
 * NB (limite connue, cf. sql/02_views.sql) : les validations renvoient
 * toujours PJS: [] — FSAPJ n'a pas de colonne pour rattacher une pièce
 * jointe à une validation précise dans le schéma fourni.
 */
export async function getFsa(NUMDOS) {
  const inputs = { NUMDOS: { type: sql.VarChar(50), value: NUMDOS } };

  const [header, nomenclatures, pjs, validations, validationsPjs] =
    await Promise.all([
      runQuery({
        moduleUrl: import.meta.url,
        key: "fsa.getFsa.header",
        query: FOLDER_HEADER_QUERY,
        inputs,
        errorIfEmpty: "DATA_NOT_FOUND",
      }),
      runQuery({
        moduleUrl: import.meta.url,
        key: "fsa.getFsa.nomenclatures",
        query: FOLDER_NOMENCLATURES_QUERY,
        inputs,
      }),
      runQuery({
        moduleUrl: import.meta.url,
        key: "fsa.getFsa.pjs",
        query: FOLDER_PJS_QUERY,
        inputs,
      }),
      runQuery({
        moduleUrl: import.meta.url,
        key: "fsa.getFsa.validations",
        query: FOLDER_VALIDATIONS_QUERY,
        inputs,
      }),
      runQuery({
        moduleUrl: import.meta.url,
        key: "fsa.getFsa.validations.files",
        query: FOLDER_VALIDATIONS_FILES_QUERY,
        inputs,
      }),
    ]);

  return {
    header: header.recordset,
    nomenclatures: nomenclatures.recordset,
    pjs: pjs.recordset,
    validations: validations.recordset,
    validationsPjs: validationsPjs.recordset,
  };
}

/* -------------------------------------------------------------------------- */
/*                                GESTIONNAIRES                               */
/* -------------------------------------------------------------------------- */

// Une ligne par (service, utilisateur habilité) — remplace vw_FsaGests.
// INNER JOIN volontaire sur FSAGES_UTILISATEURS/USERS : un service sans
// aucun utilisateur habilité ne ressortait déjà pas de l'ancienne vue
// (formatGestionnaires regroupe par USRID), on garde ce comportement.
function gestionnairesQuery(extraWhere = "") {
  return `
    SELECT
        g.GESID,
        g.NUMGES,
        g.NOMGES,
        g.VALGES,
        g.CREGES,
        g.SERVGES,
        g.CREUSR,
        g.CREDAT,
        g.MODUSR,
        g.MODDAT,
        gu.USRID,
        CONCAT(u.LSTNAM, ' ', u.FSTNAM) AS GESNAM
    FROM dbo.FSAGES g
    INNER JOIN dbo.FSAGES_UTILISATEURS gu ON gu.GESID = g.GESID
    INNER JOIN USERSMANAGER.dbo.USERS u ON u.USRID = gu.USRID
    ${extraWhere ? `WHERE ${extraWhere}` : ""}
    ORDER BY g.NOMGES;
  `;
}

export async function getGestionnaire(NUMGES) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: gestionnairesQuery("g.NUMGES = @NUMGES"),
    inputs: { NUMGES: { type: sql.VarChar(15), value: NUMGES } },
  });

  return result.recordset[0];
}

export async function getGestionnaires() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: gestionnairesQuery(),
  });

  return result.recordset;
}

export async function getStatusGest(USRID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: gestionnairesQuery("gu.USRID = @USRID"),
    inputs: { USRID: { type: sql.Int, value: USRID } },
  });

  return result.recordset;
}

export async function getGestionnairesByPosCod(NUMGES) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SELECT
        CONCAT(umu.LSTNAM, ' ', umu.FSTNAM) AS GESNAM
        FROM [dbo].[FSAGES] AS g
        LEFT JOIN [USERSMANAGER].dbo.POSITIONS ump
        ON ump.POSCOD = g.NUMGES
        LEFT JOIN [USERSMANAGER].dbo.USERS umu
        ON umu.POSID = ump.POSID
        WHERE umu.USRID IS NOT NULL AND NUMGES = @NUMGES
        ORDER BY g.NOMGES
    `,
    inputs: { NUMGES: { type: sql.VarChar(15), value: NUMGES } },
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

export async function getServices() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SELECT
        [GESID],
        [NUMGES],
        [NOMGES],
        [VALGES],
        [CREGES],
        [SERVGES],
        CONCAT(umu.LSTNAM, ' ', umu.FSTNAM) AS GESNAM,
        g.[CREUSR] AS CREUSR,
        g.[CREDAT] AS CREDAT,
        [MODUSR],
        [MODDAT]
        FROM [dbo].[FSAGES] AS g
        LEFT JOIN [USERSMANAGER].dbo.Positions ump
        ON ump.POSCOD = g.NUMGES
        LEFT JOIN [USERSMANAGER].dbo.Users umu
        ON umu.POSID = ump.POSID
        WHERE g.VALGES = 1 AND umu.USRID IS NOT NULL;
    `,
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

/**
 * Remplace vw_FsaCanDeleteGest.
 * Hypothèse (à confirmer) : un service est supprimable s'il n'a aucun
 * dossier rattaché, aucune validation enregistrée, et aucune condition de
 * validation définie.
 */
export async function getCanDelGests() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SELECT
        g.GESID, g.NUMGES, g.NOMGES, g.VALGES, g.CREGES, g.SERVGES,
        g.CREUSR, g.CREDAT, g.MODUSR, g.MODDAT,
        gu.USRID,
        CONCAT(u.LSTNAM, ' ', u.FSTNAM) AS GESNAM,
        CAST(CASE WHEN
            NOT EXISTS (SELECT 1 FROM dbo.FSAENT e WHERE e.NUMGES = g.NUMGES)
            AND NOT EXISTS (SELECT 1 FROM dbo.FSAVALID v WHERE v.NUMGES = g.NUMGES)
            AND NOT EXISTS (SELECT 1 FROM dbo.FSAVALCNDSET c WHERE c.NUMGES = g.NUMGES)
          THEN 1 ELSE 0 END AS BIT) AS CanDelete
      FROM dbo.FSAGES g
      INNER JOIN dbo.FSAGES_UTILISATEURS gu ON gu.GESID = g.GESID
      INNER JOIN USERSMANAGER.dbo.USERS u ON u.USRID = gu.USRID
      ORDER BY g.NOMGES;
    `,
  });

  return result.recordset;
}

/* -------------------------------------------------------------------------- */
/*                              MUST-VALIDATE / EMAILS                        */
/* -------------------------------------------------------------------------- */

export async function getGestsMustValidate() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      EXEC usp_UpdateFsaConditionResults;

      -- LATE identique pour toutes les lignes NUMGES d'un même (NUMDOS, SERVGES)
      -- (cf. vw_FsaServicesMustValidate : ne dépend que du service, pas du
      -- gestionnaire précis) — le DISTINCT sur les 3 colonnes ne réintroduit
      -- donc pas de doublons.
      SELECT DISTINCT NUMDOS, SERVGES, LATE
      FROM dbo.vw_FsaServicesMustValidate
      ORDER BY NUMDOS, SERVGES;
    `,
  });

  return result.recordset ?? [];
}

export async function getGestsMustValidateByNumDos(NUMDOS) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      EXEC usp_UpdateFsaConditionResults;

      SELECT DISTINCT NUMDOS, SERVGES, LATE
      FROM dbo.vw_FsaServicesMustValidate
      WHERE NUMDOS = @NUMDOS
      ORDER BY NUMDOS, SERVGES;
    `,
    inputs: { NUMDOS: { type: sql.VarChar(50), value: NUMDOS } },
  });

  return result.recordset ?? [];
}

export async function getValEmails(NUMDOS = null, NUMGES = null) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      EXEC usp_UpdateFsaConditionResults;

      SELECT DISTINCT
          u.EMAIL,
          CONCAT(u.LSTNAM, ' ', u.FSTNAM) AS GESNAM,
          r.NUMDOS
      FROM (
          SELECT DISTINCT
              s.NUMGES,
              s.NUMDOS
          FROM dbo.vw_FsaServicesMustValidate AS s
          LEFT JOIN dbo.vw_FsaValidations AS v
              ON v.GES_SERVGES = s.SERVGES
              AND v.NUMDOS = s.NUMDOS
          INNER JOIN dbo.FSAENT e
              ON e.NUMDOS = s.NUMDOS
          INNER JOIN dbo.vw_FsaCurrentStatus cs
              ON cs.NUMDOS = e.NUMDOS
          WHERE v.GES_NUMGES IS NULL
            AND e.DELETED = 0
            AND cs.CODETA = 'EAV'
            AND (@NUMDOS IS NULL OR s.NUMDOS = @NUMDOS)
            AND (@NUMGES IS NULL OR s.NUMGES = @NUMGES)
            -- Direction (NUMGES = 'DG') : relancée uniquement quand c'est la
            -- dernière validation obligatoire restante, i.e. aucun autre
            -- service obligatoire n'est encore en attente sur le dossier.
            AND (
              s.NUMGES <> 'DG'
              OR NOT EXISTS (
                SELECT 1
                FROM dbo.vw_FsaServicesMustValidate AS o
                LEFT JOIN dbo.vw_FsaValidations AS ov
                    ON ov.GES_SERVGES = o.SERVGES
                    AND ov.NUMDOS = o.NUMDOS
                WHERE o.NUMDOS = s.NUMDOS
                  AND o.SERVGES <> s.SERVGES
                  AND ov.GES_NUMGES IS NULL
              )
            )
      ) AS r
      INNER JOIN dbo.FSAGES g ON g.NUMGES = r.NUMGES
      INNER JOIN dbo.FSAGES_UTILISATEURS gu ON gu.GESID = g.GESID
      -- V_Users (et non USERS) : même source que l'ancienne requête d'origine
      -- (non reconstruite ici, c'était déjà une jointure explicite) — a
      -- priori une vue qui ne garde que les utilisateurs actifs/éligibles
      -- à recevoir des notifications.
      INNER JOIN USERSMANAGER.dbo.V_Users u ON u.USRID = gu.USRID
      ORDER BY r.NUMDOS;
    `,
    inputs: {
      NUMDOS: { type: sql.VarChar(50), value: NUMDOS },
      NUMGES: { type: sql.VarChar(15), value: NUMGES },
    },
  });

  return result.recordset;
}

/* -------------------------------------------------------------------------- */
/*                              RÉFÉRENTIELS SIMPLES                          */
/* -------------------------------------------------------------------------- */

export async function getStatus() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT STAID, CODETA, DESETA FROM dbo.FSASTA`,
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

export async function getTypes() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT TYPID, TYPDOS, TYDOSN FROM dbo.FSATYP`,
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

export async function getValTypes() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SELECT VALTYPID, VALTYPCOD, VALTYPNOM
      FROM dbo.FSAVALTYP
      WHERE VALTYPCOD <> 'DEL'
    `,
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

/**
 * Remplace vw_FolderValidationsWithDelay.
 *
 * Une ligne par validation réellement enregistrée (dbo.FSAVALID, hors
 * VALTYPCOD = 'DEL'), aplatie avec les infos du dossier, du service
 * gestionnaire qui a validé (GES_*) et du type de décision (TYP_*) — c'est
 * le format attendu par entities/fsa/FsaVALDELAY.class.ts (FsaVALDELAYRaw)
 * côté front (StatisticsPage : délai moyen par service, export CSV
 * "STAT_FSA" via buildValidationDelayCsv).
 *
 * - DATETA = date de création du dossier (FSAENT.CREDAT), PAS la date de la
 *   validation elle-même (cf. VALDAT plus bas).
 * - CODETA/DESETA = statut *actuel* du dossier (dbo.vw_FsaCurrentStatus),
 *   pas le statut au moment de la validation.
 * - DEM = demandeur du dossier, résolu depuis FSAENT.NUMDEM (même montage
 *   que ENT_DEM_GESNAM dans getFsas()/getFsa() ci-dessus).
 * - GES_* = le service gestionnaire qui a émis CETTE validation
 *   (FSAVALID.NUMGES), pas le gestionnaire du dossier.
 * - VALDLY = délai de validation en jours = nombre de jours entre la mise
 *   en attente de validation du dossier (EAVDAT, cf. vw_FsaCurrentStatus)
 *   et la date de cette validation (FSAVALID.CREDAT) ; NULL si le dossier
 *   n'est jamais passé par le statut EAV.
 */
export async function getValDelays() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SELECT
          e.NUMDOS                              AS NUMDOS,
          e.CREDAT                              AS DATETA,
          cs.CODETA                             AS CODETA,
          cs.DESETA                              AS DESETA,
          e.NOMDOS                              AS NOMDOS,
          CONCAT(udem.LSTNAM, ' ', udem.FSTNAM)  AS DEM,
          c.BPCNAM                              AS CLIENT,
          pr.DESMAR                             AS DESMAR,
          ve.VOLANN                             AS VOLANN,
          vl.VALIDID                            AS VALIDID,
          uval.USRID                            AS GES_USRID,
          g.GESID                               AS GES_GESID,
          g.NUMGES                              AS GES_NUMGES,
          g.NOMGES                              AS GES_NOMGES,
          g.SERVGES                             AS GES_SERVGES,
          CONCAT(uval.LSTNAM, ' ', uval.FSTNAM)  AS GES_GESNAM,
          vt.VALTYPID                           AS TYP_VALTYPID,
          vt.VALTYPCOD                          AS TYP_VALTYPCOD,
          vt.VALTYPNOM                          AS TYP_VALTYPNOM,
          vl.VALNOT                             AS VALNOT,
          vl.CREDAT                             AS VALDAT,
          vl.CREUSR                             AS VALUSR,
          DATEDIFF(DAY, cs.EAVDAT, vl.CREDAT)    AS VALDLY
      FROM dbo.FSAVALID AS vl
      INNER JOIN dbo.FSAENT AS e
          ON e.NUMDOS = vl.NUMDOS
      INNER JOIN dbo.FSAGES AS g
          ON g.NUMGES = vl.NUMGES
      LEFT JOIN dbo.FSAVALTYP AS vt
          ON vt.VALTYPCOD = vl.VALTYPCOD
      LEFT JOIN dbo.vw_FsaCurrentStatus AS cs
          ON cs.NUMDOS = e.NUMDOS
      LEFT JOIN dbo.FSACLIENTS AS c
          ON c.NUMDOS = e.NUMDOS
      LEFT JOIN dbo.FSAPRODUITS AS pr
          ON pr.NUMDOS = e.NUMDOS
      LEFT JOIN dbo.FSAVENTES AS ve
          ON ve.NUMDOS = e.NUMDOS
      -- Demandeur du dossier : FSAENT.NUMDEM -> FSAGES -> POSITIONS -> USERS
      -- (même montage que ENT_DEM_GESNAM dans getFsas()/getFsa()).
      LEFT JOIN dbo.FSAGES AS dem
          ON dem.NUMGES = e.NUMDEM
      LEFT JOIN USERSMANAGER.dbo.POSITIONS AS posdem
          ON posdem.POSCOD = e.NUMDEM
      LEFT JOIN USERSMANAGER.dbo.USERS AS udem
          ON udem.POSID = posdem.POSID
      -- Utilisateur rattaché au service qui a validé : FSAGES.NUMGES ->
      -- POSITIONS -> USERS (même montage que GES_GESNAM dans
      -- dbo.vw_FsaValidations, complété ici avec le USRID brut).
      LEFT JOIN USERSMANAGER.dbo.POSITIONS AS posval
          ON posval.POSCOD = g.NUMGES
      LEFT JOIN USERSMANAGER.dbo.USERS AS uval
          ON uval.POSID = posval.POSID
      WHERE e.DELETED = 0
        AND vl.VALTYPCOD <> 'DEL'
      ORDER BY e.NUMDOS, vl.CREDAT ASC;
    `,
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

export async function getConditionOperators() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SELECT OPRID
          ,OPRCOD
          ,OPRLIB
          ,OPRDESC
      FROM FSAVALCNDOPR
    `,
    ttl: false,
  });

  return result.recordset;
}

export async function getViewFields() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SELECT
          t.name AS TableName,
          CAST(ep_t.value AS nvarchar(4000)) AS TableDescription,
          c.name AS ColumnName,
          CAST(ep_c.value AS nvarchar(4000)) AS ColumnDescription
      FROM sys.tables AS t
      INNER JOIN sys.columns AS c
          ON c.object_id = t.object_id
      LEFT JOIN sys.extended_properties AS ep_t
          ON ep_t.major_id = t.object_id
          AND ep_t.minor_id = 0
          AND ep_t.name = N'MS_Description'
      LEFT JOIN sys.extended_properties AS ep_c
          ON ep_c.major_id = t.object_id
          AND ep_c.minor_id = c.column_id
          AND ep_c.name = N'MS_Description'
      WHERE t.schema_id = SCHEMA_ID(N'dbo')
      AND EXISTS (
          SELECT 1
          FROM sys.columns sc
          WHERE sc.object_id = t.object_id
          AND sc.name = 'NUMDOS'
      )
      ORDER BY
          t.name,
          c.column_id;
    `,
    ttl: false,
  });

  return result.recordset;
}

export async function getGestConditions() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SELECT CNDID
          ,NUMGES
          ,COLNAM
          ,OPRT
          ,VALTEST
      FROM FSAVALCNDSET
    `,
    ttl: false,
  });

  return result.recordset;
}

/* -------------------------------------------------------------------------- */
/*                             PARAMÈTRES APPLICATIFS                        */
/*                    (table "singleton" [dbo].[FSASETTINGS])                */
/* -------------------------------------------------------------------------- */

/**
 * FSASETTINGS ne contient qu'une seule ligne (SETID = 1, cf. contrainte
 * CK_FSASETTINGS_SINGLETON du script de création). Cette ligne est toujours
 * présente (insérée par le script de création de la table avec les mêmes
 * valeurs par défaut que DEFAULT_APP_SETTINGS côté front), mais on garde
 * errorIfEmpty par cohérence avec le reste du module (cf. getStatus/getTypes)
 * et par défense en profondeur si la ligne était un jour supprimée.
 */
export async function getSettings() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SELECT SETID, VALDELAY, ARCDELAY, DELDELAY, PURDELAY,
             CREUSR, CREDAT, MODUSR, MODDAT
      FROM dbo.FSASETTINGS
      WHERE SETID = 1
    `,
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

/**
 * Mise à jour partielle de la ligne singleton (SETID = 1) : seuls les délais
 * effectivement fournis sont modifiés (COALESCE conserve la valeur en base
 * pour les autres). Chaque paramètre non fourni arrive ici à `undefined` ;
 * runQuery() le convertit en `null` (cf. core/utils/db.utils.js), ce qui
 * neutralise le COALESCE côté SQL — pas besoin de le faire à la main ici.
 * OUTPUT INSERTED.* renvoie directement la ligne à jour, en un aller-retour,
 * même pattern que patchGestionnaire (OUTPUT INSERTED.GESID) plus haut.
 */
export async function patchSettings(
  VALDELAY,
  ARCDELAY,
  DELDELAY,
  PURDELAY,
  MODUSR,
) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      UPDATE dbo.FSASETTINGS
      SET
          VALDELAY = COALESCE(@VALDELAY, VALDELAY),
          ARCDELAY = COALESCE(@ARCDELAY, ARCDELAY),
          DELDELAY = COALESCE(@DELDELAY, DELDELAY),
          PURDELAY = COALESCE(@PURDELAY, PURDELAY),
          MODUSR   = @MODUSR,
          MODDAT   = SYSDATETIME()
      OUTPUT
          INSERTED.SETID, INSERTED.VALDELAY, INSERTED.ARCDELAY, INSERTED.DELDELAY, INSERTED.PURDELAY,
          INSERTED.CREUSR, INSERTED.CREDAT, INSERTED.MODUSR, INSERTED.MODDAT
      WHERE SETID = 1
    `,
    inputs: {
      VALDELAY: { type: sql.Int, value: VALDELAY },
      ARCDELAY: { type: sql.Int, value: ARCDELAY },
      DELDELAY: { type: sql.Int, value: DELDELAY },
      PURDELAY: { type: sql.Int, value: PURDELAY },
      MODUSR: { type: sql.NVarChar(250), value: MODUSR },
    },
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

/* -------------------------------------------------------------------------- */
/*                                   POSTS                                    */
/* -------------------------------------------------------------------------- */

export async function postFsa(
  NUMDOSBAS,
  NOMDOS,
  TYPDOS,
  GESUSRID,
  NUMGES,
  NUMDEM,
  INNO,
  NOTDOS,
  CREUSR,
) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      BEGIN TRANSACTION;

        -- Définition des variables pour TYPDOS et NUMGES
        DECLARE @TYPDOS VARCHAR(15) = @TYPDOS_VAL;
        DECLARE @NUMGES VARCHAR(15) = @NUMGES_VAL;

        -- Création de la partie date au format yyMMddss (ex : 23032525 pour le 25 mars 2023 et 25 secondes)
        DECLARE @DatePart VARCHAR(8) = FORMAT(SYSUTCDATETIME(), 'yyMMddss');

        -- Insertion dans la table avec une valeur provisoire pour NUMDOS (ici une chaîne vide)
        INSERT INTO FSAENT (
            APPVRS,
            NUMDOS,
            NUMDOSBAS,
            NOMDOS,
            TYPDOS,
            GESUSRID,
            NUMGES,
            NUMDEM,
            INNO,
            NOTDOS,
            CREUSR,
            CREDAT,
            MODUSR,
            MODDAT
        )
        VALUES (
            @APPVRS,
            '',                             -- Valeur provisoire pour NUMDOS
            @NUMDOSBAS_VAL,
            @NOMDOS_VAL,
            @TYPDOS_VAL,
            @GESUSRID_VAL,
            @NUMGES_VAL,
            @NUMDEM_VAL,
            @INNO_VAL,
            @NOTDOS_VAL,
            @CREUSR_VAL,
            SYSUTCDATETIME(),
            @MODUSR_VAL,
            SYSUTCDATETIME()
        );

        -- Récupération de la valeur auto-incrémentée (ENTID)
        DECLARE @NewID INT = SCOPE_IDENTITY();

        -- Formattage du compteur sur 5 chiffres
        DECLARE @NewCounter VARCHAR(5) = RIGHT('00000' + CAST(@NewID AS VARCHAR(5)), 5);

        -- Assemblage du NUMDOS complet avec le compteur auto-incrémenté
        DECLARE @NUMDOS VARCHAR(50) = @TYPDOS + '/' + @NUMGES + '/' + @DatePart + '/' + @NewCounter;

        -- Mise à jour de l'enregistrement inséré avec le NUMDOS généré
        UPDATE FSAENT
        SET NUMDOS = @NUMDOS
        WHERE ENTID = @NewID;

        INSERT INTO FSAENTSTA (NUMDOS, CODETA, CREDAT) VALUES (@NUMDOS, 'BRO', SYSUTCDATETIME())

        COMMIT TRANSACTION;

        -- Retourne le NUMDOS généré
        SELECT @NUMDOS AS NUMDOS;
    `,
    inputs: {
      APPVRS: { type: sql.NVarChar(50), value: "1.0.2" },
      NUMDOSBAS_VAL: { type: sql.VarChar(50), value: NUMDOSBAS },
      NOMDOS_VAL: { type: sql.NVarChar(80), value: NOMDOS },
      TYPDOS_VAL: { type: sql.VarChar(15), value: TYPDOS },
      GESUSRID_VAL: { type: sql.Int, value: GESUSRID },
      NUMGES_VAL: { type: sql.VarChar(15), value: NUMGES },
      NUMDEM_VAL: { type: sql.NVarChar(15), value: NUMDEM },
      INNO_VAL: { type: sql.Bit, value: INNO },
      NOTDOS_VAL: { type: sql.NVarChar(250), value: NOTDOS },
      CREUSR_VAL: { type: sql.NVarChar(250), value: CREUSR },
      MODUSR_VAL: { type: sql.NVarChar(250), value: CREUSR },
    },
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

export async function postValidation(
  NUMDOS,
  VALTYPCOD,
  VALNOT,
  NUMGES,
  CREUSR,
) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
      INSERT INTO FSAVALID
      (
        NUMDOS,
        NUMGES,
        VALTYPCOD,
        VALNOT,
        CREDAT,
        CREUSR
      )
      VALUES
      (
        @NUMDOS,
        @NUMGES,
        @VALTYPCOD,
        @VALNOT,
        SYSUTCDATETIME(),
        @CREUSR
      )
    `,
    inputs: {
      NUMDOS: { type: sql.VarChar(50), value: NUMDOS },
      VALTYPCOD: { type: sql.VarChar(15), value: VALTYPCOD },
      VALNOT: { type: sql.NVarChar(4000), value: VALNOT },
      NUMGES: { type: sql.VarChar(15), value: NUMGES },
      CREUSR: { type: sql.NVarChar(250), value: CREUSR },
    },
  });

  return true;
}

/**
 * Crée un service (FSAGES) + ses utilisateurs habilités
 * (FSAGES_UTILISATEURS, remplace FSAGES.ENBUSRS). ENBUSRS reste accepté en
 * entrée au même format qu'avant ("1;2;3") pour ne rien changer côté front
 * — c'est cette fonction qui absorbe la conversion vers la table de
 * jointure.
 */
export async function postGestionnaire(
  NUMGES,
  NOMGES,
  VALGES,
  CREGES,
  SERVGES,
  ENBUSRS,
  CREUSR,
) {
  const usrIds = parseEnbusrs(ENBUSRS);

  const db = getDbConnexion(import.meta.url);
  const transaction = new sql.Transaction(db);

  try {
    await transaction.begin();

    const requestInsert = new sql.Request(transaction);
    requestInsert.input("NUMGES", sql.VarChar(15), NUMGES);
    requestInsert.input("NOMGES", sql.NVarChar(50), NOMGES);
    requestInsert.input("VALGES", sql.Bit, VALGES);
    requestInsert.input("CREGES", sql.Bit, CREGES);
    requestInsert.input("SERVGES", sql.VarChar(50), SERVGES);
    requestInsert.input("CREUSR", sql.NVarChar(250), CREUSR);

    const insertGesResult = await requestInsert.query(`
      INSERT INTO FSAGES
        (NUMGES, NOMGES, VALGES, CREGES, SERVGES, CREUSR, CREDAT, MODUSR, MODDAT)
      OUTPUT INSERTED.GESID AS GESID
      VALUES
        (@NUMGES, @NOMGES, @VALGES, @CREGES, @SERVGES, @CREUSR, SYSUTCDATETIME(), @CREUSR, SYSUTCDATETIME())
    `);

    const GESID = insertGesResult.recordset[0]?.GESID;

    if (GESID && usrIds.length) {
      const requestUsers = new sql.Request(transaction);
      requestUsers.input("GESID", sql.Int, GESID);

      const values = usrIds.map((_, i) => `(@GESID, @USRID${i})`).join(",");

      usrIds.forEach((usrId, i) => {
        requestUsers.input(`USRID${i}`, sql.Int, usrId);
      });

      await requestUsers.query(`
        INSERT INTO FSAGES_UTILISATEURS (GESID, USRID) VALUES ${values};
      `);
    }

    await transaction.commit();
    return true;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*                                 PATCHS                                     */
/* -------------------------------------------------------------------------- */

export async function patchFsaEnt(NUMDOS, NOMDOS, NOTDOS, EAV) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
      UPDATE FSAENT
      SET NOTDOS = @NOTDOS, NOMDOS = @NOMDOS
      WHERE NUMDOS = @NUMDOS;

      IF @EAV = 1
      BEGIN
          INSERT INTO FSAENTSTA (NUMDOS, CODETA, CREDAT)
          VALUES (@NUMDOS, 'EAV', SYSUTCDATETIME());
      END
    `,
    inputs: {
      NOMDOS: { type: sql.NVarChar(80), value: NOMDOS },
      NOTDOS: { type: sql.NVarChar(250), value: NOTDOS },
      NUMDOS: { type: sql.VarChar(50), value: NUMDOS },
      EAV: { type: sql.Bit, value: EAV },
    },
  });

  return true;
}

/* -------------------------------------------------------------------------- */
/*                                 DELETES                                    */
/* -------------------------------------------------------------------------- */

export async function deleteFsa(NUMDOS, DELETED) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
      UPDATE FSAENT
      SET DELETED = @DELETED
      WHERE NUMDOS = @NUMDOS
    `,
    inputs: {
      NUMDOS: { type: sql.VarChar(50), value: NUMDOS },
      DELETED: { type: sql.Bit, value: DELETED },
    },
  });

  return true;
}

/* -------------------------------------------------------------------------- */
/*                                  UPSERT                                    */
/* -------------------------------------------------------------------------- */

/**
 * Effectue un UPSERT (update si existe, sinon insert) sur FSAPRODUITS.
 * @param {string} NUMDOS - Numéro du dossier
 * @param {object} PRODUCT - Données du produit
 * @returns {Promise<boolean>} True si succès
 */
export async function upsertProduct(NUMDOS, PRODUCT) {
  if (!NUMDOS) throw new Error("MISSING_PARAMETERS");
  if (!PRODUCT || typeof PRODUCT !== "object")
    throw new Error("MISSING_PARAMETERS");

  await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SET NOCOUNT ON;

      -- UPSERT sur FSAPRODUITS
      IF EXISTS (
          SELECT 1 FROM [dbo].[FSAPRODUITS] WHERE NUMDOS = @NUMDOS
      )
      BEGIN
          UPDATE [dbo].[FSAPRODUITS]
             SET [TCLCOD]  = @TCLCOD,
                 [CATNOM]  = @CATNOM,
                 [ITMREF]  = @ITMREF,
                 [ITMDES]  = @ITMDES,
                 [ITMFMT]  = @ITMFMT,
                 [DESFMT]  = @DESFMT,
                 [CENTFMT] = @CENTFMT,
                 [ITMMAR]  = @ITMMAR,
                 [DESMAR]  = @DESMAR,
                 [ITMGAM]  = @ITMGAM,
                 [DESGAM]  = @DESGAM,
                 [ITMAPP]  = @ITMAPP,
                 [DESAPP]  = @DESAPP,
                 [ITMCEP]  = @ITMCEP,
                 [DESCEP]  = @DESCEP,
                 [ITMCOU]  = @ITMCOU,
                 [DESCOU]  = @DESCOU,
                 [ITMQUA]  = @ITMQUA,
                 [DESQUA]  = @DESQUA,
                 [ITMTYP]  = @ITMTYP,
                 [DESTYP]  = @DESTYP,
                 [ITMSPT]  = @ITMSPT,
                 [DESSPT]  = @DESSPT,
                 [ITMMIL]  = @ITMMIL,
                 [CODCHADOM]  = @CODCHADOM,
                 [CHADOM]  = @CHADOM,
                 [CODDESALC]  = @CODDESALC,
                 [CODBOIS]  = @CODBOIS,
                 [MEDAIL]  = @MEDAIL,
                 [ITMCON]  = @ITMCON,
                 [ITMNOT]  = @ITMNOT
          OUTPUT INSERTED.PRODUITID AS PRODUITID
           WHERE NUMDOS = @NUMDOS;
      END
      ELSE
      BEGIN
          INSERT INTO [dbo].[FSAPRODUITS]
                     ([NUMDOS],[TCLCOD],[CATNOM],[ITMREF],[ITMDES],[ITMFMT],[DESFMT],
                      [CENTFMT],[ITMMAR],[DESMAR],[ITMGAM],[DESGAM],[ITMAPP],[DESAPP],
                      [ITMCEP],[DESCEP],[ITMCOU],[DESCOU],[ITMQUA],[DESQUA],[ITMTYP],
                      [DESTYP],[ITMMIL],[ITMCON],[ITMNOT])
          OUTPUT INSERTED.PRODUITID AS PRODUITID
          VALUES
                     (@NUMDOS,@TCLCOD,@CATNOM,@ITMREF,@ITMDES,@ITMFMT,@DESFMT,
                      @CENTFMT,@ITMMAR,@DESMAR,@ITMGAM,@DESGAM,@ITMAPP,@DESAPP,
                      @ITMCEP,@DESCEP,@ITMCOU,@DESCOU,@ITMQUA,@DESQUA,@ITMTYP,
                      @DESTYP,@ITMMIL,@ITMCON,@ITMNOT);
      END
    `,
    inputs: {
      NUMDOS: { type: sql.VarChar(50), value: NUMDOS },
      TCLCOD: { type: sql.NVarChar(15), value: PRODUCT.TCLCOD ?? null },
      CATNOM: { type: sql.NVarChar(50), value: PRODUCT.CATNOM ?? null },
      ITMREF: { type: sql.NVarChar(15), value: PRODUCT.ITMREF ?? null },
      ITMDES: { type: sql.NVarChar(255), value: PRODUCT.ITMDES ?? null },
      ITMFMT: { type: sql.NVarChar(15), value: PRODUCT.ITMFMT ?? null },
      DESFMT: { type: sql.NVarChar(50), value: PRODUCT.DESFMT ?? null },
      CENTFMT: { type: sql.Decimal(18, 6), value: PRODUCT.CENTFMT ?? null },
      ITMMAR: { type: sql.NVarChar(15), value: PRODUCT.ITMMAR ?? null },
      DESMAR: { type: sql.NVarChar(50), value: PRODUCT.DESMAR ?? null },
      ITMGAM: { type: sql.NVarChar(15), value: PRODUCT.ITMGAM ?? null },
      DESGAM: { type: sql.NVarChar(50), value: PRODUCT.DESGAM ?? null },
      ITMAPP: { type: sql.NVarChar(15), value: PRODUCT.ITMAPP ?? null },
      DESAPP: { type: sql.NVarChar(50), value: PRODUCT.DESAPP ?? null },
      ITMCEP: { type: sql.NVarChar(15), value: PRODUCT.ITMCEP ?? null },
      DESCEP: { type: sql.NVarChar(50), value: PRODUCT.DESCEP ?? null },
      ITMCOU: { type: sql.NVarChar(15), value: PRODUCT.ITMCOU ?? null },
      DESCOU: { type: sql.NVarChar(50), value: PRODUCT.DESCOU ?? null },
      ITMQUA: { type: sql.NVarChar(15), value: PRODUCT.ITMQUA ?? null },
      DESQUA: { type: sql.NVarChar(50), value: PRODUCT.DESQUA ?? null },
      ITMTYP: { type: sql.NVarChar(15), value: PRODUCT.ITMTYP ?? null },
      DESTYP: { type: sql.NVarChar(50), value: PRODUCT.DESTYP ?? null },
      ITMSPT: { type: sql.NVarChar(15), value: PRODUCT.ITMSPT ?? null },
      DESSPT: { type: sql.NVarChar(50), value: PRODUCT.DESSPT ?? null },
      ITMMIL: { type: sql.Int, value: PRODUCT.ITMMIL ?? null },
      CODCHADOM: { type: sql.NVarChar(15), value: PRODUCT.CODCHADOM ?? null },
      CHADOM: { type: sql.NVarChar(255), value: PRODUCT.CHADOM ?? null },
      CODDESALC: {
        type: sql.NVarChar(15),
        value: PRODUCT.CODDESALC ? "1" : "0",
      },
      CODBOIS: { type: sql.NVarChar(15), value: PRODUCT.CODBOIS ? "1" : "0" },
      MEDAIL: { type: sql.Bit, value: PRODUCT.MEDAIL ?? 0 },
      ITMCON: { type: sql.Decimal(18, 6), value: PRODUCT.ITMCON ?? null },
      ITMNOT: { type: sql.NVarChar(250), value: PRODUCT.ITMNOT ?? null },
    },
    errorIfEmpty: "DB_QUERY_ERROR",
  });

  return true;
}

/**
 * Effectue un UPSERT (update si existe, sinon insert) sur FSACLIENTS.
 * @param {string} NUMDOS - Numéro du dossier
 * @param {object} FSACLIENT - Données du client
 * @returns {Promise<boolean>} True si succès
 */
export async function upsertClient(NUMDOS, FSACLIENT) {
  if (!NUMDOS) throw new Error("MISSING_PARAMETERS");
  if (!FSACLIENT || typeof FSACLIENT !== "object")
    throw new Error("MISSING_PARAMETERS");

  await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SET NOCOUNT ON;

      -- UPSERT sur FSACLIENTS
      IF EXISTS (
          SELECT 1 FROM [dbo].[FSACLIENTS] WHERE NUMDOS = @NUMDOS
      )
      BEGIN
          UPDATE [dbo].[FSACLIENTS]
             SET [CLIEXI]  = @CLIEXI,
                 [BPCNUM]  = @BPCNUM,
                 [BPCNAM]  = @BPCNAM,
                 [CLIPAY]  = @CLIPAY,
                 [CLIACT]  = @CLIACT,
                 [NOMACT]  = @NOMACT,
                 [CLICCON] = @CLICCON,
                 [CLINAM]  = @CLINAM,
                 [CLIMAIL] = @CLIMAIL,
                 [CLITEL]  = @CLITEL,
                 [CLINOT]  = @CLINOT
          OUTPUT INSERTED.CLIENTID AS CLIENTID
           WHERE NUMDOS = @NUMDOS;
      END
      ELSE
      BEGIN
          INSERT INTO [dbo].[FSACLIENTS]
                     ([NUMDOS],[CLIEXI],[BPCNUM],[BPCNAM],[CLIPAY],[CLIACT],
                      [NOMACT],[CLICCON],[CLINAM],[CLIMAIL],[CLITEL],[CLINOT])
          OUTPUT INSERTED.CLIENTID AS CLIENTID
          VALUES
                     (@NUMDOS,@CLIEXI,@BPCNUM,@BPCNAM,@CLIPAY,@CLIACT,
                      @NOMACT,@CLICCON,@CLINAM,@CLIMAIL,@CLITEL,@CLINOT);
      END
    `,
    inputs: {
      NUMDOS: { type: sql.VarChar(50), value: NUMDOS },
      CLIEXI: { type: sql.Bit, value: FSACLIENT.CLIEXI ?? 0 },
      BPCNUM: { type: sql.NVarChar(255), value: FSACLIENT.BPCNUM ?? null },
      BPCNAM: { type: sql.NVarChar(50), value: FSACLIENT.BPCNAM ?? null },
      // NB (bug V1.0.0) : la valeur persistée était déjà `CLIPAY.CLIPAY`
      // (objet imbriqué en entrée) — conservé à l'identique côté service,
      // le contrat d'entrée est documenté dans validators.js.
      CLIPAY: {
        type: sql.VarChar(15),
        value: FSACLIENT.CLIPAY?.CLIPAY ?? null,
      },
      CLIACT: { type: sql.NVarChar(15), value: FSACLIENT.CLIACT ?? null },
      NOMACT: { type: sql.NVarChar(200), value: FSACLIENT.NOMACT ?? null },
      CLICCON: { type: sql.NVarChar(255), value: FSACLIENT.CLICCON ?? null },
      CLINAM: { type: sql.NVarChar(250), value: FSACLIENT.CLINAM ?? null },
      CLIMAIL: { type: sql.NVarChar(250), value: FSACLIENT.CLIMAIL ?? null },
      CLITEL: { type: sql.NVarChar(50), value: FSACLIENT.CLITEL ?? null },
      CLINOT: { type: sql.NVarChar(250), value: FSACLIENT.CLINOT ?? null },
    },
    errorIfEmpty: "DB_QUERY_ERROR",
  });

  return true;
}

/**
 * Effectue un UPSERT (update si existe, sinon insert) sur FSAVENTES.
 * @param {string} NUMDOS - Numéro du dossier
 * @param {object} FSAVENTE - Données de la vente
 * @returns {Promise<boolean>} True si succès
 */
export async function upsertVente(NUMDOS, FSAVENTE) {
  if (!NUMDOS) throw new Error("MISSING_PARAMETERS");
  if (!FSAVENTE || typeof FSAVENTE !== "object")
    throw new Error("MISSING_PARAMETERS");

  await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SET NOCOUNT ON;

      -- UPSERT sur FSAVENTES
      IF EXISTS (
          SELECT 1 FROM [dbo].[FSAVENTES] WHERE NUMDOS = @NUMDOS
      )
      BEGIN
          UPDATE [dbo].[FSAVENTES]
             SET [DATMAD] = @DATMAD,
                 [ONESHO] = @ONESHO,
                 [VOLANN] = @VOLANN,
                 [VOLANN1] = @VOLANN1,
                 [VOLANN2] = @VOLANN2,
                 [PRIANN] = @PRIANN,
                 [PRIANN1] = @PRIANN1,
                 [PRIANN2] = @PRIANN2,
                 [PVC] = @PVC,
                 [VENNOT] = @VENNOT,
                 [FRANCO] = @FRANCO,
                 [FDC] = @FDC,
                 [AFA] = @AFA,
                 [AFANOT] = @AFANOT,
                 [VOLTIR] = @VOLTIR
          OUTPUT INSERTED.VENTEID AS VENTEID
           WHERE NUMDOS = @NUMDOS;
      END
      ELSE
      BEGIN
          INSERT INTO [dbo].[FSAVENTES]
                     ([NUMDOS],[DATMAD],[ONESHO],[VOLANN],[VOLANN1],[VOLANN2],
                      [PRIANN],[PRIANN1],[PRIANN2],[PVC],[VENNOT],[FRANCO],
                      [FDC],[AFA],[AFANOT],[VOLTIR])
          OUTPUT INSERTED.VENTEID AS VENTEID
          VALUES
                     (@NUMDOS,@DATMAD,@ONESHO,@VOLANN,@VOLANN1,@VOLANN2,
                      @PRIANN,@PRIANN1,@PRIANN2,@PVC,@VENNOT,@FRANCO,
                      @FDC,@AFA,@AFANOT,@VOLTIR);
      END
    `,
    inputs: {
      NUMDOS: { type: sql.VarChar(50), value: NUMDOS },
      DATMAD: { type: sql.DateTime, value: FSAVENTE.DATMAD ?? null },
      ONESHO: { type: sql.Bit, value: FSAVENTE.ONESHO ? 1 : 0 },
      VOLANN: { type: sql.Decimal(18, 6), value: FSAVENTE.VOLANN ?? null },
      VOLANN1: { type: sql.Decimal(18, 6), value: FSAVENTE.VOLANN1 ?? null },
      VOLANN2: { type: sql.Decimal(18, 6), value: FSAVENTE.VOLANN2 ?? null },
      PRIANN: { type: sql.Decimal(18, 6), value: FSAVENTE.PRIANN ?? null },
      PRIANN1: { type: sql.Decimal(18, 6), value: FSAVENTE.PRIANN1 ?? null },
      PRIANN2: { type: sql.Decimal(18, 6), value: FSAVENTE.PRIANN2 ?? null },
      PVC: { type: sql.Decimal(18, 6), value: FSAVENTE.PVC ?? null },
      VENNOT: { type: sql.NVarChar(250), value: FSAVENTE.VENNOT ?? null },
      FRANCO: { type: sql.Bit, value: FSAVENTE.FRANCO ? 1 : 0 },
      FDC: { type: sql.Bit, value: FSAVENTE.FDC ? 1 : 0 },
      AFA: { type: sql.Bit, value: FSAVENTE.AFA ? 1 : 0 },
      AFANOT: { type: sql.NVarChar(250), value: FSAVENTE.AFANOT ?? null },
      VOLTIR: { type: sql.Decimal(18, 6), value: FSAVENTE.VOLTIR ?? null },
    },
    errorIfEmpty: "DB_QUERY_ERROR",
  });

  return true;
}

/**
 * Supprime toutes les pièces jointes d'un NUMDOS puis insère les nouvelles,
 * dans une seule transaction. Conserve une gestion explicite de transaction
 * (sql.Transaction) car runQuery() ne couvre qu'une seule requête à la fois.
 *
 * NB (décision produit) : reste sur FSAPJ pour l'instant — pas de bascule
 * vers la table ATTACHMENTS partagée dans cette passe.
 *
 * @param {string} NUMDOS
 * @param {Array} FSAPJS
 * @returns {Promise<boolean>}
 */
export async function delsertPjs(NUMDOS, FSAPJS = []) {
  if (!NUMDOS) throw new Error("MISSING_PARAMETERS");
  if (!Array.isArray(FSAPJS)) throw new Error("MISSING_PARAMETERS");

  const db = getDbConnexion(import.meta.url);
  const transaction = new sql.Transaction(db);

  try {
    await transaction.begin();

    const requestDelete = new sql.Request(transaction);
    requestDelete.input("NUMDOS", sql.VarChar(50), NUMDOS);
    await requestDelete.query(
      `DELETE FROM [dbo].[FSAPJ] WHERE [NUMDOS] = @NUMDOS;`,
    );

    if (FSAPJS.length === 0) {
      await transaction.commit();
      return true;
    }

    const requestInsert = new sql.Request(transaction);
    requestInsert.input("NUMDOS", sql.VarChar(50), NUMDOS);

    const insertQuery = `
      INSERT INTO [dbo].[FSAPJ] (
        [NUMDOS],
        [PJC],
        [PJN],
        [PJL]
      ) VALUES
      ${FSAPJS.map((_, i) => `(@NUMDOS, @PJC${i}, @PJN${i}, @PJL${i})`).join(",")}
    ;`;

    FSAPJS.forEach((pj, i) => {
      requestInsert.input(`PJC${i}`, sql.NVarChar(50), generatePjc());
      requestInsert.input(`PJN${i}`, sql.NVarChar(255), pj.PJN ?? null);
      requestInsert.input(`PJL${i}`, sql.NVarChar(4000), pj.PJL ?? null);
    });

    await requestInsert.query(insertQuery);

    await transaction.commit();
    return true;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

function generatePjc(length = 30) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const array = new Uint32Array(length);

  crypto.getRandomValues(array);

  for (let i = 0; i < length; i++) {
    result += chars[array[i] % chars.length];
  }

  return result;
}

/**
 * Effectue un UPSERT sur les notes de dossier (FSAENT.NOTDOS).
 * @param {string} NUMDOS - Numéro du dossier
 * @param {string} NOTDOS - Note du dossier
 * @returns {Promise<boolean>} True si succès
 */
export async function upsertFsaNotes(NUMDOS, NOTDOS) {
  if (!NUMDOS) throw new Error("MISSING_PARAMETERS");

  await runQuery({
    moduleUrl: import.meta.url,
    query: `
      UPDATE FSAENT
        SET NOTDOS = @NOTDOS
      WHERE NUMDOS = @NUMDOS
    `,
    inputs: {
      NUMDOS: { type: sql.VarChar(50), value: NUMDOS },
      NOTDOS: { type: sql.NVarChar(250), value: NOTDOS },
    },
  });

  return true;
}

/**
 * Met à jour un service (FSAGES) + remplace intégralement la liste de ses
 * utilisateurs habilités (FSAGES_UTILISATEURS). Même contrat d'entrée
 * qu'avant : ENBUSRS en chaîne "1;2;3".
 */
export async function patchGestionnaire(
  NUMGES,
  VALGES,
  CREGES,
  ENBUSRS,
  CREUSR,
) {
  if (!NUMGES) throw new Error("MISSING_PARAMETERS");

  const usrIds = parseEnbusrs(ENBUSRS);

  const db = getDbConnexion(import.meta.url);
  const transaction = new sql.Transaction(db);

  try {
    await transaction.begin();

    const requestUpdate = new sql.Request(transaction);
    requestUpdate.input("NUMGES", sql.VarChar(15), NUMGES);
    requestUpdate.input("VALGES", sql.Bit, VALGES);
    requestUpdate.input("CREGES", sql.Bit, CREGES);
    requestUpdate.input("CREUSR", sql.NVarChar(250), CREUSR);

    const updateResult = await requestUpdate.query(`
      UPDATE FSAGES
      SET
        [VALGES] = @VALGES,
        [CREGES] = @CREGES,
        [MODUSR] = @CREUSR,
        [MODDAT] = SYSUTCDATETIME()
      OUTPUT INSERTED.GESID AS GESID
      WHERE [NUMGES] = @NUMGES
    `);

    const GESID = updateResult.recordset[0]?.GESID;
    if (!GESID) {
      await transaction.commit();
      return true;
    }

    const requestDeleteUsers = new sql.Request(transaction);
    requestDeleteUsers.input("GESID", sql.Int, GESID);
    await requestDeleteUsers.query(
      `DELETE FROM FSAGES_UTILISATEURS WHERE GESID = @GESID;`,
    );

    if (usrIds.length) {
      const requestInsertUsers = new sql.Request(transaction);
      requestInsertUsers.input("GESID", sql.Int, GESID);

      const values = usrIds.map((_, i) => `(@GESID, @USRID${i})`).join(",");
      usrIds.forEach((usrId, i) => {
        requestInsertUsers.input(`USRID${i}`, sql.Int, usrId);
      });

      await requestInsertUsers.query(
        `INSERT INTO FSAGES_UTILISATEURS (GESID, USRID) VALUES ${values};`,
      );
    }

    await transaction.commit();
    return true;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*                                 DELSERT                                    */
/* -------------------------------------------------------------------------- */

/**
 * Supprime toutes les nomenclatures liées à un NUMDOS puis insère les
 * nouvelles, dans une seule transaction (même remarque que delsertPjs).
 * @param {string} NUMDOS - Numéro du dossier
 * @param {Array} NOMENCLATURE - Tableau des objets nomenclature
 * @returns {Promise<boolean>}
 */
export async function delsertNomenclature(NUMDOS, NOMENCLATURE = []) {
  if (!NUMDOS) throw new Error("MISSING_PARAMETERS");
  if (!Array.isArray(NOMENCLATURE)) throw new Error("MISSING_PARAMETERS");

  const db = getDbConnexion(import.meta.url);
  const transaction = new sql.Transaction(db);

  try {
    await transaction.begin();

    const requestDelete = new sql.Request(transaction);
    requestDelete.input("NUMDOS", sql.VarChar(50), NUMDOS);
    await requestDelete.query(
      `DELETE FROM [dbo].[FSANOMENCLATURES] WHERE [NUMDOS] = @NUMDOS;`,
    );

    if (NOMENCLATURE.length === 0) {
      await transaction.commit();
      return true;
    }

    const requestInsert = new sql.Request(transaction);
    requestInsert.input("NUMDOS", sql.VarChar(50), NUMDOS);

    const insertQuery = `
      INSERT INTO [dbo].[FSANOMENCLATURES] (
        [NUMDOS],
        [ITMCAT],
        [DESCAT],
        [ITMREF],
        [ITMDES],
        [BASQTY],
        [CPNITMREF],
        [CPNITMDES],
        [BOMUOM],
        [BOMSTUCOE],
        [BOMQTY],
        [LIKQTY],
        [STU],
        [ITMMIL],
        [ITMMILN],
        [NOTLINC],
        [NOTDOS]
      ) VALUES
      ${NOMENCLATURE.map(
        (_, i) => `
        (@NUMDOS,
         @ITMCAT${i}, @DESCAT${i}, @ITMREF${i}, @ITMDES${i},
         @BASQTY${i}, @CPNITMREF${i}, @CPNITMDES${i}, @BOMUOM${i},
         @BOMSTUCOE${i}, @BOMQTY${i}, @LIKQTY${i}, @STU${i},
         @ITMMIL${i}, @ITMMILN${i}, @NOTLINC${i}, @NOTDOS${i})`,
      ).join(",\n")}
      ;
    `;

    NOMENCLATURE.forEach((n, i) => {
      requestInsert.input(`ITMCAT${i}`, sql.NVarChar(255), n.ITMCAT ?? null);
      requestInsert.input(`DESCAT${i}`, sql.NVarChar(255), n.DESCAT ?? null);
      requestInsert.input(`ITMREF${i}`, sql.NVarChar(15), n.ITMREF ?? null);
      requestInsert.input(`ITMDES${i}`, sql.NVarChar(255), n.ITMDES ?? null);
      requestInsert.input(`BASQTY${i}`, sql.Decimal(18, 6), n.BASQTY ?? null);
      requestInsert.input(
        `CPNITMREF${i}`,
        sql.NVarChar(255),
        n.CPNITMREF ?? null,
      );
      requestInsert.input(
        `CPNITMDES${i}`,
        sql.NVarChar(255),
        n.CPNITMDES ?? null,
      );
      requestInsert.input(`BOMUOM${i}`, sql.NVarChar(10), n.BOMUOM ?? null);
      requestInsert.input(
        `BOMSTUCOE${i}`,
        sql.Decimal(18, 6),
        n.BOMSTUCOE ?? null,
      );
      requestInsert.input(`BOMQTY${i}`, sql.Decimal(18, 6), n.BOMQTY ?? null);
      requestInsert.input(`LIKQTY${i}`, sql.Decimal(18, 6), n.LIKQTY ?? null);
      requestInsert.input(`STU${i}`, sql.NVarChar(10), n.STU ?? null);
      requestInsert.input(`ITMMIL${i}`, sql.Int, n.ITMMIL ?? null);
      requestInsert.input(`ITMMILN${i}`, sql.Int, n.ITMMILN ?? null);
      requestInsert.input(`NOTLINC${i}`, sql.NVarChar(250), n.NOTLINC ?? null);
      requestInsert.input(`NOTDOS${i}`, sql.NVarChar(250), n.NOTDOS ?? null);
    });

    await requestInsert.query(insertQuery);

    await transaction.commit();
    return true;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

/**
 * Supprime un service (FSAGES) et ses utilisateurs habilités
 * (FSAGES_UTILISATEURS). Contrairement à FSAENT/FSACLIENTS/etc., la FK
 * FSAGES_UTILISATEURS → FSAGES n'a pas de ON DELETE CASCADE dans le script
 * fourni : on supprime explicitement les lignes filles d'abord.
 */
export async function deleteGestionnaire(NUMGES) {
  if (!NUMGES) throw new Error("MISSING_PARAMETERS");

  await runQuery({
    moduleUrl: import.meta.url,
    query: `
      DELETE gu
      FROM FSAGES_UTILISATEURS gu
      INNER JOIN FSAGES g ON g.GESID = gu.GESID
      WHERE g.NUMGES = @NUMGES;

      DELETE FROM FSAGES
      WHERE [NUMGES] = @NUMGES
    `,
    inputs: { NUMGES: { type: sql.VarChar(15), value: NUMGES } },
  });

  return true;
}

/**
 * "1;2;3" -> [1, 2, 3] (mêmes règles que le parsing front historique côté
 * modules/fsa/utils.js#formatGestionnaires : entiers positifs uniquement).
 */
function parseEnbusrs(str) {
  return (str ?? "")
    .split(";")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}
