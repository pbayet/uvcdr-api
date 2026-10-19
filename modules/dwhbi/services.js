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
