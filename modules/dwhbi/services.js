import sql from "mssql";
import { runQuery } from "../../core/utils/db.utils.js";

export async function getClients(DEMA) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    DECLARE @DEMA NVARCHAR(15) = @DEMA_VAL;

    IF EXISTS (
      SELECT
        1
      FROM
        DB_CLIENTS c
      WHERE
        c.COD_GESTIONNAIRE <> ''
        AND c.RAIS_SOC_CLIENT <> ''
        AND c.COD_GESTIONNAIRE = @DEMA
    ) BEGIN
    SELECT
      c.COD_CLIENT AS BPCNUM,
      c.RAIS_SOC_CLIENT AS BPCNAM,
      c.ACTIVITE AS NOMACT,
      c.COD_ACTIVITE AS CODACT,
      c.COD_PAYS_CLIENT AS CLIPAY,
      c.PAYS_CLIENT AS CLIPAYN,
      c.COD_GESTIONNAIRE AS GESCOD,
      tc.CLE_ADRESSE AS CLICCON,
      tc.INTITULE_ADRESSE AS CLINAM,
      tc.MAIL_1 AS CLIMAIL,
      tc.TELEPHONE_1 AS CLITEL
    FROM
      DB_CLIENTS AS c
      LEFT JOIN DB_ADRESSES_TIERS AS tc ON tc.COD_TIERS = c.COD_CLIENT
    WHERE
      c.COD_GESTIONNAIRE <> ''
      AND c.RAIS_SOC_CLIENT <> ''
      AND tc.INTITULE_ADRESSE <> ''
      AND c.COD_GESTIONNAIRE = @DEMA
    ORDER BY
      BPCNAM;

    END
    ELSE BEGIN
    SELECT
      c.COD_CLIENT AS BPCNUM,
      c.RAIS_SOC_CLIENT AS BPCNAM,
      c.ACTIVITE AS NOMACT,
      c.COD_ACTIVITE AS CODACT,
      c.COD_PAYS_CLIENT AS CLIPAY,
      c.PAYS_CLIENT AS CLIPAYN,
      c.COD_GESTIONNAIRE AS GESCOD,
      tc.CLE_ADRESSE AS CLICCON,
      tc.INTITULE_ADRESSE AS CLINAM,
      tc.MAIL_1 AS CLIMAIL,
      tc.TELEPHONE_1 AS CLITEL
    FROM
      DB_CLIENTS AS c
      LEFT JOIN DB_ADRESSES_TIERS AS tc ON tc.COD_TIERS = c.COD_CLIENT
    WHERE
      c.COD_GESTIONNAIRE <> ''
      AND c.RAIS_SOC_CLIENT <> ''
      AND tc.INTITULE_ADRESSE <> ''
    ORDER BY
      BPCNAM;

    END
    `,
    inputs: { DEMA_VAL: { type: sql.NVarChar, value: DEMA } },
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

/** Motif LIKE « contient » avec échappement des jokers saisis (%, _, [). */
function toLike(SEARCH) {
  const s = String(SEARCH ?? "").trim();
  return s ? `%${s.replace(/[[%_]/g, "[$&]")}%` : null;
}

/**
 * Recherche de clients (select à chargement distant) : les LIMIT premiers
 * clients dont le code ou la raison sociale contient SEARCH, ou le client
 * BPCNUM (valeur déjà choisie). Même périmètre que getClients : les clients
 * du gestionnaire DEMA s'il en a, sinon tous. Une ligne par contact.
 */
export async function searchClients({ DEMA, SEARCH, BPCNUM, LIMIT = 30 }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    DECLARE @HASDEMA BIT = CASE WHEN EXISTS (
      SELECT 1 FROM DB_CLIENTS c
      WHERE c.COD_GESTIONNAIRE <> '' AND c.RAIS_SOC_CLIENT <> ''
        AND c.COD_GESTIONNAIRE = @DEMA
    ) THEN 1 ELSE 0 END;

    WITH found AS (
      SELECT TOP (@LIMIT) c.COD_CLIENT, c.RAIS_SOC_CLIENT
      FROM DB_CLIENTS AS c
      WHERE
        c.COD_GESTIONNAIRE <> ''
        AND c.RAIS_SOC_CLIENT <> ''
        AND (@BPCNUM IS NOT NULL OR @HASDEMA = 0 OR c.COD_GESTIONNAIRE = @DEMA)
        AND (@BPCNUM IS NULL OR c.COD_CLIENT = @BPCNUM)
        AND (@SEARCH IS NULL OR c.COD_CLIENT LIKE @SEARCH OR c.RAIS_SOC_CLIENT LIKE @SEARCH)
        AND EXISTS (
          SELECT 1 FROM DB_ADRESSES_TIERS AS t
          WHERE t.COD_TIERS = c.COD_CLIENT AND t.INTITULE_ADRESSE <> ''
        )
      ORDER BY c.RAIS_SOC_CLIENT
    )
    SELECT
      c.COD_CLIENT AS BPCNUM,
      c.RAIS_SOC_CLIENT AS BPCNAM,
      c.ACTIVITE AS NOMACT,
      c.COD_ACTIVITE AS CODACT,
      c.COD_PAYS_CLIENT AS CLIPAY,
      c.PAYS_CLIENT AS CLIPAYN,
      c.COD_GESTIONNAIRE AS GESCOD,
      tc.CLE_ADRESSE AS CLICCON,
      tc.INTITULE_ADRESSE AS CLINAM,
      tc.MAIL_1 AS CLIMAIL,
      tc.TELEPHONE_1 AS CLITEL
    FROM
      found AS f
      INNER JOIN DB_CLIENTS AS c ON c.COD_CLIENT = f.COD_CLIENT
      INNER JOIN DB_ADRESSES_TIERS AS tc ON tc.COD_TIERS = c.COD_CLIENT
    WHERE
      tc.INTITULE_ADRESSE <> ''
    ORDER BY
      BPCNAM, CLINAM;
    `,
    inputs: {
      DEMA: { type: sql.NVarChar, value: DEMA ?? "" },
      SEARCH: { type: sql.NVarChar, value: toLike(SEARCH) },
      BPCNUM: { type: sql.NVarChar, value: BPCNUM || null },
      LIMIT: { type: sql.Int, value: LIMIT },
    },
  });

  return result.recordset;
}

export async function getPays() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT
        DISTINCT(COD_PAYS) as CLIPAY,
        NOM_PAYS as CLIPAYN
    FROM DB_PAYS
    WHERE
      COD_PAYS <> ''
      AND
      COD_PAYS <> '888'
    ORDER BY CLIPAYN
    `,
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

export async function getVrac() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT
        a.COD_ARTICLE AS ITMREF,
        a.COD_CATEG AS CODCAT,
        a.CATEGORIE_ARTICLE AS LCAT,
        a.BV_COD_APPELL AS CODAPP,
        a.BV_APPELLATION AS LAPP,
        a.COEF_FORMAT AS COEF,
        a.BV_COD_FORMAT AS CODFMT,
        a.BV_FORMAT_XL AS LFMT,
        a.BV_COD_CEP AS CODCEP,
        a.BV_CEPAGE AS LCEP,
        a.BV_COD_COUL AS CODCOU,
        a.BV_COULEUR AS LCOU,
        a.BV_COD_QUAL_VRAC AS CODQAL,
        a.BV_QUALITE_VRAC AS LQAL,
        a.BV_COD_TYPO AS CODTYPO,
        a.BV_TYPOLOGIE AS LTYPO,
        a.BV_COD_SPEC_TYPO AS CODSPTY,
        a.BV_SPEC_TYPOLOGIE AS LSPTY,
        a.STATUT_ARTICLE AS STA,
        a.MILLESIME AS MILL,
        a.BV_COD_MARQUE AS CODMRQ,
        a.BV_MARQUE AS LMRQ,
        a.BV_COD_GAM_DOM AS CODGAM,
        a.BV_GAMME_DOMAINE AS LGAM
    FROM
        DB_ARTICLES AS a
    WHERE
        a.STATUT_ARTICLE = 'Actif'
        AND (
            a.COD_ARTICLE LIKE 'PFI%'
            OR a.COD_ARTICLE LIKE 'BIB%'
            or a.COD_ARTICLE LIKE 'TBO%'
        )
    `,
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

/**
 * Champs de DB_ARTICLES interrogeables par searchVrac : colonnes code /
 * libellé et filtre propre au champ. Liste blanche : FIELD n'est jamais
 * injecté tel quel dans la requête.
 */
const VRAC_FIELDS = {
  MRQ: { code: "a.BV_COD_MARQUE", label: "a.BV_MARQUE" },
  GAM: { code: "a.BV_COD_GAM_DOM", label: "a.BV_GAMME_DOMAINE" },
  APP: { code: "a.BV_COD_APPELL", label: "a.BV_APPELLATION" },
  COU: { code: "a.BV_COD_COUL", label: "a.BV_COULEUR" },
  CEP: { code: "a.BV_COD_CEP", label: "a.BV_CEPAGE" },
  // Château / Domaine sont proposés à part (CODCHADOM côté front).
  QAL: {
    code: "a.BV_COD_QUAL_VRAC",
    label: "a.BV_QUALITE_VRAC",
    where: "a.BV_QUALITE_VRAC NOT IN (N'Sans', N'Domaine', N'Château')",
  },
  TYPO: { code: "a.BV_COD_TYPO", label: "a.BV_TYPOLOGIE" },
  SPTY: { code: "a.BV_COD_SPEC_TYPO", label: "a.BV_SPEC_TYPOLOGIE" },
  MILL: {
    code: "CAST(a.MILLESIME AS NVARCHAR(10))",
    label: "CAST(a.MILLESIME AS NVARCHAR(10))",
    where: "a.MILLESIME > 2000",
    desc: true,
  },
};

export const VRAC_FIELD_NAMES = Object.keys(VRAC_FIELDS);

/**
 * Recherche des valeurs distinctes d'un champ des articles vrac actifs
 * (select à chargement distant) : les LIMIT premières valeurs dont le code
 * ou le libellé contient SEARCH, ou la valeur CODE (déjà choisie).
 */
export async function searchVrac({ FIELD, SEARCH, CODE, LIMIT = 50 }) {
  const f = VRAC_FIELDS[FIELD];
  if (!f) throw new Error(`Champ vrac inconnu : ${FIELD}`);

  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT TOP (@LIMIT)
        ${f.code} AS CODE,
        MIN(${f.label}) AS LABEL
    FROM
        DB_ARTICLES AS a
    WHERE
        a.STATUT_ARTICLE = 'Actif'
        AND (
            a.COD_ARTICLE LIKE 'PFI%'
            OR a.COD_ARTICLE LIKE 'BIB%'
            OR a.COD_ARTICLE LIKE 'TBO%'
        )
        AND ${f.code} IS NOT NULL
        AND ${f.code} <> ''
        ${f.where ? `AND ${f.where}` : ""}
        AND (@CODE IS NULL OR ${f.code} = @CODE)
        AND (@SEARCH IS NULL OR ${f.code} LIKE @SEARCH OR ${f.label} LIKE @SEARCH)
    GROUP BY ${f.code}
    ORDER BY ${f.desc ? "CODE DESC" : "LABEL"}
    `,
    inputs: {
      SEARCH: { type: sql.NVarChar, value: toLike(SEARCH) },
      CODE: { type: sql.NVarChar, value: CODE || null },
      LIMIT: { type: sql.Int, value: LIMIT },
    },
  });

  return result.recordset;
}

export async function getMsContainers() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    WITH src AS
    (
        SELECT
            a.BV_COD_FORMAT AS CODFMT,
            CASE
                WHEN a.BV_COD_FORMAT LIKE 'B%' THEN 'BIB'
                ELSE 'PFI'
            END AS CODCAT,
            CASE
                WHEN a.BV_COD_FORMAT LIKE 'B%' THEN 'PRODUITS FINIS BIB'
                ELSE 'PRODUITS FINIS BOUTEILLES'
            END AS LCAT,
            a.CAPACITE AS COEF,
            a.BV_FORMAT_XL AS LFMT,
            ROW_NUMBER() OVER
            (
                PARTITION BY a.BV_COD_FORMAT
                ORDER BY a.CATEGORIE_ARTICLE, a.BV_FORMAT_XL, a.CAPACITE
            ) AS rn
        FROM DB_ARTICLES AS a
        WHERE
            a.STATUT_ARTICLE = 'Actif'
            AND (
                a.COD_ARTICLE LIKE 'PFI%'
                OR a.COD_ARTICLE LIKE 'BIB%'
                OR a.COD_ARTICLE LIKE 'TBO%'
                OR a.COD_ARTICLE LIKE 'MAF%'
            )
    )
    SELECT
        CODFMT,
        CODCAT,
        LCAT,
        COEF,
        LFMT
    FROM src
    WHERE rn = 1
    ORDER BY LCAT, CODFMT;
    `,
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

export async function getMsNomenclature(CODCATCOM, FMT, BASQTY) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SELECT
          DISTINCT
          a1.COD_ARTICLE AS ITMREF,
          a1.DES_ARTICLE_2 AS LITM,
          nom.L_CATEG_COMPOSANT AS CODCAT,
          c1.DESIGN_CATEG_X3 AS LCAT
      FROM
          DB_ARTICLES_NOMENCLATURE AS nom
          INNER JOIN DB_ARTICLES AS a1 ON a1.COD_ARTICLE = nom.L_ARTICLE_COMPOSANT
          INNER JOIN DB_ARTICLES AS a2 ON a2.COD_ARTICLE = nom.L_ARTICLE_COMPOSE
          INNER JOIN DB_CATEG_ARTICLES c1 on c1.COD_CATEG = a1.COD_CATEG
      WHERE
          nom.L_CATEG_COMPOSANT IS NOT NULL
          AND (
              nom.L_CATEG_COMPOSE = @CODCATCOM
              OR (
                  @CODCATCOM = 'PFI'
                  AND nom.L_CATEG_COMPOSE IN ('TBO', 'MAF')
              )
          )
          AND a2.BV_COD_FORMAT = @FMT
          AND a2.COEF_CARTON = @BASQTY
          AND a1.STATUT_ARTICLE = 'Actif'
          AND c1.CATEGORIE_NIV1 = 'MATIERES SECHES'
      ORDER BY
          nom.L_CATEG_COMPOSANT
    `,
    inputs: {
      CODCATCOM: { type: sql.NVarChar, value: CODCATCOM },
      FMT: { type: sql.NVarChar, value: FMT },
      BASQTY: { type: sql.Int, value: BASQTY },
    },
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

/** Composants matières sèches possibles pour une catégorie / format / coef. */
const MS_NOMENCLATURE_FROM = `
      FROM
          DB_ARTICLES_NOMENCLATURE AS nom
          INNER JOIN DB_ARTICLES AS a1 ON a1.COD_ARTICLE = nom.L_ARTICLE_COMPOSANT
          INNER JOIN DB_ARTICLES AS a2 ON a2.COD_ARTICLE = nom.L_ARTICLE_COMPOSE
          INNER JOIN DB_CATEG_ARTICLES c1 on c1.COD_CATEG = a1.COD_CATEG
      WHERE
          nom.L_CATEG_COMPOSANT IS NOT NULL
          AND (
              nom.L_CATEG_COMPOSE = @CODCATCOM
              OR (
                  @CODCATCOM = 'PFI'
                  AND nom.L_CATEG_COMPOSE IN ('TBO', 'MAF')
              )
          )
          AND a2.BV_COD_FORMAT = @FMT
          AND a2.COEF_CARTON = @BASQTY
          AND a1.STATUT_ARTICLE = 'Actif'
          AND c1.CATEGORIE_NIV1 = 'MATIERES SECHES'
`;

/** Catégories d'articles proposées pour une catégorie / format / coef. */
export async function getMsNomenclatureCategories(CODCATCOM, FMT, BASQTY) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SELECT
          DISTINCT
          nom.L_CATEG_COMPOSANT AS CODCAT,
          c1.DESIGN_CATEG_X3 AS LCAT
      ${MS_NOMENCLATURE_FROM}
      ORDER BY
          CODCAT
    `,
    inputs: {
      CODCATCOM: { type: sql.NVarChar, value: CODCATCOM },
      FMT: { type: sql.NVarChar, value: FMT },
      BASQTY: { type: sql.Int, value: BASQTY },
    },
  });

  return result.recordset;
}

/**
 * Recherche d'articles d'une catégorie CODCAT (select à chargement distant) :
 * les LIMIT premiers dont le code ou la désignation contient SEARCH, ou
 * l'article ITMREF (valeur déjà choisie).
 */
export async function searchMsNomenclature({
  CODCATCOM,
  FMT,
  BASQTY,
  CODCAT,
  SEARCH,
  ITMREF,
  LIMIT = 50,
}) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SELECT
          DISTINCT TOP (@LIMIT)
          a1.COD_ARTICLE AS ITMREF,
          a1.DES_ARTICLE_2 AS LITM,
          nom.L_CATEG_COMPOSANT AS CODCAT,
          c1.DESIGN_CATEG_X3 AS LCAT
      ${MS_NOMENCLATURE_FROM}
          AND nom.L_CATEG_COMPOSANT = @CODCAT
          AND (@ITMREF IS NULL OR a1.COD_ARTICLE = @ITMREF)
          AND (@SEARCH IS NULL OR a1.COD_ARTICLE LIKE @SEARCH OR a1.DES_ARTICLE_2 LIKE @SEARCH)
      ORDER BY
          LITM
    `,
    inputs: {
      CODCATCOM: { type: sql.NVarChar, value: CODCATCOM },
      FMT: { type: sql.NVarChar, value: FMT },
      BASQTY: { type: sql.Int, value: BASQTY },
      CODCAT: { type: sql.NVarChar, value: CODCAT },
      SEARCH: { type: sql.NVarChar, value: toLike(SEARCH) },
      ITMREF: { type: sql.NVarChar, value: ITMREF || null },
      LIMIT: { type: sql.Int, value: LIMIT },
    },
  });

  return result.recordset;
}

export async function getNomenclatureByPFI(PFI) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT
      a.COD_ARTICLE AS ITMREF,
      a.DES_ARTICLE_COURT AS ITMDES,
      n.E_QTY_BASE AS BASQTY,
      ab.COD_ARTICLE AS CPNITMREF,
      ab.DES_ARTICLE_COURT AS CPNITMDES,
      n.L_UNITE_UOM AS BOMUOM,
      1 AS BOMSTUCOE,
      n.L_QTY_LIEN_US AS BOMQTY,
      n.L_QTY_LIEN_US AS LIKQTY,
      n.L_UNITE_UOM AS STU,
      n.L_CATEG_COMPOSANT AS ITMCAT,
      n.L_ARTICLE_COMPOSANT AS DESCAT,
      a.MILLESIME AS ITMMIL,
      a.BV_COD_FORMAT AS CODFMT,
      a.BV_FORMAT_A AS LFMT,
      a.BV_FORMAT_L AS LLFMT,
      a.COEF_FORMAT AS COEFFMT,
      a.COD_CATEG AS CODCAT,
      a.CATEGORIE_TYP_PRODUIT_FINI AS LCAT,
      a.CATEGORIE_ARTICLE AS LLCAT,
      NULL AS ITMMILN,
      NULL AS NOTLINC,
      NULL AS NOTDOS
    FROM
      DB_ARTICLES AS a
    LEFT JOIN DB_ARTICLES_NOMENCLATURE AS n ON n.L_ARTICLE_COMPOSE = a.COD_ARTICLE
    LEFT JOIN DB_ARTICLES AS ab ON ab.COD_ARTICLE = n.L_ARTICLE_COMPOSANT
    WHERE
      n.L_CATEG_COMPOSANT <> 'VHL'
      AND
      a.COD_ARTICLE = @PFI
    `,
    inputs: { PFI: { type: sql.NVarChar, value: PFI } },
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

export async function getMrvComplement(NUMS) {
  if (!Array.isArray(NUMS) || NUMS.length === 0) return [];

  const inputs = {};
  const placeholders = NUMS.map((num, i) => {
    inputs[`NUM${i}`] = { type: sql.NVarChar, value: num };
    return `@NUM${i}`;
  });

  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SELECT 
        ac.[NUM_MARCHE] AS REFMAR
        ,CAST(CASE WHEN ac.[MARCHE_SOLDE] = 'Oui' THEN 1 ELSE 0 END AS BIT) AS SOLD
        ,ac.[QTY_RESTANT] AS QTYRST
        ,a.BV_COULEUR as COUL
        ,a.BV_APPELLATION AS APP
        ,a.BV_QUALITE_VRAC AS QUAL
        ,a.BV_CEPAGE AS CEP
        ,a.BV_TYPOLOGIE AS TYPO
        ,a.BV_SPEC_TYPOLOGIE AS SPECTYPO
        ,a.MILLESIME AS MILL
      FROM [DWH_BI_2025].[dbo].[ACH_COMMANDES_MARCHES] as ac
      INNER JOIN DB_ARTICLES as a ON a.COD_ARTICLE = ac.COD_ARTICLE AND a.COD_CATEG = 'VHL'
      WHERE ac.[VERSION X3] = 'V12'
        AND NUM_MARCHE IN (${placeholders.join(", ")})
    `,
    inputs,
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}
