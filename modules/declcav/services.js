import sql from "mssql";
import { runQuery } from "../../core/utils/db.utils.js";

/* ═══════════════════════════════════════════════════════════════
   DECLCAV — Services
   Tables réelles utilisées :
     DECENT, DECLIGING, DECLIGCEP, CAVE, CAVEMAIL,
     TYPCAVELIST, INGLIST, CEPLIST, QUESTSUBMIT, QUESTANSWER

   Vues utilisées :
     V_DECFOLDERS, V_DECFOLDERS_LATEST, V_CAVES, V_CAVE_RELAUNCH,
     V_INGREDIENTS, V_QUESTANSWERS

   Comme pour ticketing (cf. audit dette technique 4.2), chaque fonction
   utilise désormais runQuery() (core/utils/db.utils.js) au lieu du motif
   manuel getDbConnexion → generateAutoKey → getPreparedStatement → execute
   répété en V1.0.0, avec `destroyImmediately: true` sur chaque appel — ce
   qui recréait un nouveau PreparedStatement à chaque requête au lieu de
   réutiliser le cache TTL par défaut de runQuery().

   NB : `getCavesPW` (lookup CAVE.PASSHSH par email) réintroduit pour la
   branche d'authentification "cave" de auth.middleware.js (POST /api/auth
   avec appcode "DCLING") — cf. commentaire dans ce middleware. Ne renvoie
   volontairement que ID + PASSHSH (jamais utilisée en dehors de la
   vérification du mot de passe).
═══════════════════════════════════════════════════════════════ */

/* ─────────────────────────────────────────────
   FOLDERS (DECENT)
───────────────────────────────────────────── */

export async function getFolders(
  CAVID = null,
  NUMDOS = null,
  TYPE = "default",
) {
  const viewName = NUMDOS ? "V_DECFOLDERS" : "V_DECFOLDERS_LATEST";

  const where = [];
  if (NUMDOS) where.push("(NUMDOS = @NUMDOS OR OLDNUMDOS = @NUMDOS)");
  if (CAVID) where.push("CAVEID = @CAVID");
  if (TYPE === "archives") where.push("STAT = 'ARC'");
  if (TYPE === "deletes") where.push("IS_DEL = 1");
  if (TYPE !== "deletes") where.push("IS_DEL = 0");

  const result = await runQuery({
    moduleUrl: import.meta.url,
    // La clé doit encoder CHAQUE variante de texte SQL (pas seulement les
    // valeurs des paramètres) : le WHERE change selon la vue choisie, le
    // TYPE et la présence de CAVID. Un PreparedStatement mis en cache (TTL
    // par défaut de runQuery) est réutilisé tel quel pour toute clé
    // identique — une clé trop générique renverrait un résultat basé sur
    // le premier texte SQL préparé, quels que soient les paramètres reçus
    // ensuite.
    key: `declcav.getFolders.${viewName}.${TYPE}.${!!CAVID}`,
    query: `
      SELECT *
      FROM ${viewName}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    `,
    inputs: {
      NUMDOS: { type: sql.NVarChar(30), value: NUMDOS },
      CAVID: { type: sql.Int, value: CAVID },
    },
  });

  return result.recordset;
}

export async function getFolderByMrv(MRVCOD, DEL = null) {
  let where = "";
  if (DEL === null) where = "IS_DEL = 0";
  if (DEL === false) where = "IS_DEL = 0";
  if (DEL === true) where = "IS_DEL = 1";

  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SELECT *
      FROM V_DECFOLDERS
      WHERE REFMAR = @MRVCOD AND ${where}
    `,
    inputs: {
      MRVCOD: { type: sql.NVarChar, value: MRVCOD },
    },
  });

  return result.recordset;
}

/* ─────────────────────────────────────────────
   RÉFÉRENTIELS
───────────────────────────────────────────── */

export async function getIngredients() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT * FROM V_INGREDIENTS`,
  });

  return result.recordset;
}

export async function getTypesCaves() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SELECT
        ID,
        CODE,
        LIBELLE AS LIBEL,
        REMARQ AS REMARK,
        ACTIF
      FROM TYPCAVELIST
    `,
  });

  return result.recordset;
}

/* ─────────────────────────────────────────────
   CAVES
───────────────────────────────────────────── */

export async function getCaves(ASCCI, NUMFOURN) {
  const filtered = !!ASCCI && !!NUMFOURN;

  const result = await runQuery({
    moduleUrl: import.meta.url,
    key: `declcav.getCaves.${filtered}`,
    query: filtered
      ? `
      SELECT *
      FROM V_CAVES
      WHERE ACCIID = CONCAT(@ASCCI, @NUMFOURN) OR CODACCI = @ASCCI
      `
      : `
      SELECT *
      FROM V_CAVES
      `,
    inputs: {
      ASCCI: { type: sql.NVarChar, value: ASCCI },
      NUMFOURN: { type: sql.NVarChar, value: NUMFOURN },
    },
  });

  return result.recordset;
}

export async function getCave(CAVEID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SELECT *
      FROM V_CAVES
      WHERE CAVEID = @CAVEID
    `,
    inputs: {
      CAVEID: { type: sql.Int, value: CAVEID },
    },
  });

  return result.recordset;
}

/**
 * Recherche une cave par l'email de contact déclaré dans CAVEMAIL et
 * renvoie uniquement son ID et son hash de mot de passe (PASSHSH), pour
 * vérification par `verifyPassword` (core/utils/passwords.utils.js) dans
 * auth.middleware.js. Ne jamais élargir cette fonction à d'autres colonnes :
 * elle n'a qu'un seul appelant, l'authentification, et ne doit exposer que
 * le strict nécessaire.
 */
export async function getCavesPW(EMAIL) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SELECT TOP 1 c.ID, c.PASSHSH
      FROM CAVE AS c
      LEFT JOIN CAVEMAIL AS cm ON cm.CAVEID = c.ID
      WHERE cm.MAILADR = @EMAIL
    `,
    inputs: {
      EMAIL: { type: sql.NVarChar, value: EMAIL },
    },
  });

  return result.recordset;
}

export async function upsertCave({
  CAVEID,
  CAVENOM,
  TYPID,
  CDFRX3,
  SIRET,
  CODACCI,
  CREUSR,
  PASSHSH,
}) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;

    DECLARE @Output TABLE (ID INT);

    IF @CAVEID IS NOT NULL
    AND EXISTS (SELECT 1 FROM CAVE WHERE ID = @CAVEID)
    BEGIN
        UPDATE CAVE
        SET
            CAVENOM = @CAVENOM,
            TYPID   = @TYPID,
            CDFRX3  = @CDFRX3,
            SIRET   = @SIRET,
            CODACCI = @CODACCI,
            UPDDAT  = SYSUTCDATETIME(),
            UPDUSR  = @CREUSR
        OUTPUT inserted.ID INTO @Output
        WHERE ID = @CAVEID;
    END
    ELSE
    BEGIN
        INSERT INTO CAVE (
            SIRET,
            CAVENOM,
            PASSHSH,
            TYPID,
            CDFRX3,
            CODACCI,
            CREDAT,
            CREUSR
        )
        OUTPUT inserted.ID INTO @Output
        VALUES (
            @SIRET,
            @CAVENOM,
            @PASSHSH,
            @TYPID,
            @CDFRX3,
            @CODACCI,
            SYSUTCDATETIME(),
            @CREUSR
        );
    END

    SELECT ID FROM @Output;
    `,
    inputs: {
      CAVEID: { type: sql.Int, value: CAVEID ?? null },
      CAVENOM: { type: sql.NVarChar, value: CAVENOM },
      PASSHSH: { type: sql.NVarChar, value: PASSHSH },
      TYPID: { type: sql.Int, value: TYPID },
      CDFRX3: { type: sql.NVarChar, value: CDFRX3 ?? null },
      SIRET: { type: sql.NVarChar, value: SIRET ?? null },
      CODACCI: { type: sql.NVarChar, value: CODACCI ?? null },
      CREUSR: { type: sql.NVarChar, value: CREUSR },
    },
  });

  return result.recordset[0]?.ID;
}

/**
 * Remplace intégralement les emails d'une cave (delete + insert).
 * CREUSR est désormais obligatoire et propagé par le contrôleur (identité
 * réelle de l'utilisateur connecté) — en V1.0.0 la fonction attendait déjà
 * ce paramètre mais le contrôleur ne le passait jamais (CREUSR valait donc
 * `undefined`, silencieusement inséré en NULL en base).
 */
export async function delsertMails(CAVEID, MAILS, CREUSR) {
  const mailsPayload = (MAILS ?? []).map((m) => ({
    MAIL: m.MAIL,
    PRIMAIL: Boolean(m.PRIMAIL),
    ACTIF: m.ACTIF === undefined ? true : Boolean(m.ACTIF),
  }));

  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;

    BEGIN TRY
        BEGIN TRAN;

        DELETE FROM CAVEMAIL
        WHERE CAVEID = @CAVEID;

        INSERT INTO CAVEMAIL
        (
            CAVEID,
            MAILADR,
            PRIMAIL,
            ACTIF,
            CREUSR,
            CREDAT
        )
        SELECT
            @CAVEID,
            j.MAIL,
            j.PRIMAIL,
            j.ACTIF,
            @CREUSR,
            SYSUTCDATETIME()
        FROM OPENJSON(@MAILS)
        WITH
        (
            MAIL    NVARCHAR(255) '$.MAIL',
            PRIMAIL BIT           '$.PRIMAIL',
            ACTIF   BIT           '$.ACTIF'
        ) AS j
        WHERE j.MAIL IS NOT NULL
          AND LTRIM(RTRIM(j.MAIL)) <> '';

        COMMIT;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        THROW;
    END CATCH;
    `,
    inputs: {
      CAVEID: { type: sql.Int, value: CAVEID },
      CREUSR: { type: sql.NVarChar, value: CREUSR },
      MAILS: {
        type: sql.NVarChar(sql.MAX),
        value: JSON.stringify(mailsPayload),
      },
    },
  });
}

export async function setCavePassword(CAVEID, PASSHSH) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE CAVE
    SET PASSHSH = @PASSHSH
    WHERE ID = @CAVEID;

    SELECT TOP 1 MAILADR
    FROM CAVEMAIL
    WHERE CAVEID = @CAVEID AND PRIMAIL = 1;
    `,
    inputs: {
      CAVEID: { type: sql.Int, value: CAVEID },
      PASSHSH: { type: sql.NVarChar(2000), value: PASSHSH },
    },
  });

  return result.recordset[0]?.MAILADR;
}

/**
 * Supprime une cave. Refuse (erreur métier 409) si des dossiers y sont
 * encore rattachés — la règle vit en base (THROW 50001) pour rester valide
 * même en cas d'accès direct SQL ; on la traduit ici en erreur HTTP.
 */
export async function deleteCave(CAVEID) {
  try {
    await runQuery({
      moduleUrl: import.meta.url,
      query: `
      SET NOCOUNT ON;

      BEGIN TRY
          BEGIN TRAN;

          IF EXISTS (
              SELECT 1
              FROM V_CAVES
              WHERE CAVEID = @CAVEID
                AND NB_DOS > 0
          )
          BEGIN
              THROW 50001, 'Suppression impossible : des dossiers sont liés à cette cave.', 1;
          END

          DELETE FROM CAVEMAIL
          WHERE CAVEID = @CAVEID;

          DELETE FROM CAVE
          WHERE ID = @CAVEID;

          COMMIT;
      END TRY
      BEGIN CATCH
          IF @@TRANCOUNT > 0
              ROLLBACK;

          THROW;
      END CATCH;
      `,
      inputs: { CAVEID: { type: sql.Int, value: CAVEID } },
    });
  } catch (err) {
    if (
      err?.number === 50001 ||
      /dossiers sont liés/.test(err?.message ?? "")
    ) {
      const businessErr = new Error(err.message);
      businessErr.status = 409;
      throw businessErr;
    }
    throw err;
  }
}

/* ─────────────────────────────────────────────
   DÉCLARATIONS (DECENT) — Écriture
───────────────────────────────────────────── */

export async function setDeclaration({
  REFMAR,
  REFINTR,
  DATMRC,
  DEBMRV,
  FINMRV,
  REMARQ,
  CAVEID,
  REFVRAC,
  DESA1,
  DESA2,
  APPL,
  COUL,
  QTEMRV,
  TYPO,
  SPECTYPO,
  QAL,
  DECLQST,
  CREUSR,
  MLOPER,
}) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    // Un même REFMAR ne doit porter qu'un seul dossier "vivant" : si une
    // déclaration existait déjà pour ce marché (une erreur de saisie
    // rejouée, un re-import...), on la soft-delete (DEL = 1, toutes
    // versions VRSDEC confondues, cf. deleteDecl) et on purge tout ce qui
    // lui était rattaché — ingrédients/cépages (DECLIGING/DECLIGCEP, même
    // motif que setMrvIngredients : ni FK ni colonne de soft-delete),
    // questionnaire de traçabilité (QUESTSUBMIT/QUESTANSWER, rattaché via
    // REFEXT = NUMDOS) et pièces jointes (APPATTACHMENTS.dbo.ATTACHMENTS,
    // ENTITYTYPE IN ('NUMDOS', 'NUMDOSDECL') — respectivement les PJ
    // déposées à la création du dossier et celles déposées par la cave
    // lors de sa déclaration, cf. ENTITYTYPE_FOLDER/ENTITYTYPE_DECLARATION
    // dans Attachment.class.ts côté front — soft-delete via DELETEDAT,
    // même convention que deleteFileByEntity dans
    // modules/files/services.js) — avant de
    // réinsérer la nouvelle déclaration. Le tout dans une seule
    // transaction : soit la purge + la réinsertion réussissent ensemble,
    // soit rien n'est modifié.
    query: `
    SET NOCOUNT ON;

    DECLARE @Now DATETIME2 = SYSUTCDATETIME();
    DECLARE @OldNumdos TABLE (NUMDOS NVARCHAR(50) PRIMARY KEY);

    BEGIN TRY
        BEGIN TRAN;

        INSERT INTO @OldNumdos (NUMDOS)
        SELECT NUMDOS FROM dbo.DECENT WHERE REFMAR = @REFMAR;

        IF EXISTS (SELECT 1 FROM @OldNumdos)
        BEGIN
            -- Questionnaire de traçabilité des anciens dossiers
            DELETE qa
            FROM dbo.QUESTANSWER AS qa
            INNER JOIN dbo.QUESTSUBMIT AS qs ON qs.SUBID = qa.SUBID
            WHERE qs.REFEXT IN (SELECT NUMDOS FROM @OldNumdos);

            DELETE FROM dbo.QUESTSUBMIT
            WHERE REFEXT IN (SELECT NUMDOS FROM @OldNumdos);

            -- Ingrédients / cépages des anciens dossiers
            DELETE FROM dbo.DECLIGING
            WHERE NUMDOS IN (SELECT NUMDOS FROM @OldNumdos);

            DELETE FROM dbo.DECLIGCEP
            WHERE NUMDOS IN (SELECT NUMDOS FROM @OldNumdos);

            -- Pièces jointes des anciens dossiers (soft-delete)
            UPDATE APPATTACHMENTS.dbo.ATTACHMENTS
            SET DELETEDAT = @Now
            WHERE ENTITYTYPE IN ('NUMDOS', 'NUMDOSDECL')
              AND ENTITYID IN (SELECT NUMDOS FROM @OldNumdos)
              AND DELETEDAT IS NULL;

            -- Dossier(s) existant(s) pour ce REFMAR (toutes versions)
            UPDATE dbo.DECENT
            SET DEL = 1
            WHERE REFMAR = @REFMAR;
        END;

        INSERT INTO DECENT (
            REFMAR, REFINTR, DATMRC, DEBMRV, FINMRV, REMARQ, CAVEID, REFVRAC,
            DESA1, DESA2, APPL, COUL, QTEMRV, TYPO, SPECTYPO, QAL, DECLQST,
            DERREL, MLOPER, CREUSR, CREDAT
        )
        VALUES (
            @REFMAR, @REFINTR, @DATMRC, @DEBMRV, @FINMRV, @REMARQ, @CAVEID, @REFVRAC,
            @DESA1, @DESA2, @APPL, @COUL, @QTEMRV, @TYPO, @SPECTYPO, @QAL, @DECLQST,
            @Now, @MLOPER, @CREUSR, @Now
        );

        COMMIT;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        DECLARE @Msg NVARCHAR(4000) = ERROR_MESSAGE();
        RAISERROR (@Msg, 16, 1);
    END CATCH;

    -- Le NUMDOS est généré par un trigger INSTEAD OF sur DECENT (cf.
    -- setRectification) : impossible d'utiliser OUTPUT sur l'INSERT
    -- ci-dessus, on relit donc la ligne "vivante" (DEL = 0) pour ce REFMAR,
    -- désormais unique puisque les éventuelles anciennes versions ont été
    -- soft-deletées plus haut.
    SELECT TOP (1) NUMDOS
    FROM DECENT
    WHERE REFMAR = @REFMAR
      AND (DEL = 0 OR DEL IS NULL)
    ORDER BY CREDAT DESC;
    `,
    inputs: {
      REFMAR: { type: sql.NVarChar(20), value: REFMAR },
      REFINTR: { type: sql.NVarChar(15), value: REFINTR ?? null },
      DATMRC: { type: sql.DateTime, value: DATMRC ?? null },
      DEBMRV: { type: sql.DateTime, value: DEBMRV ?? null },
      FINMRV: { type: sql.DateTime, value: FINMRV ?? null },
      REMARQ: { type: sql.NVarChar(255), value: REMARQ ?? null },
      CAVEID: { type: sql.Int, value: CAVEID },
      REFVRAC: { type: sql.NVarChar(10), value: REFVRAC ?? null },
      DESA1: { type: sql.NVarChar(120), value: DESA1 ?? null },
      DESA2: { type: sql.NVarChar(120), value: DESA2 },
      APPL: { type: sql.NVarChar(50), value: APPL ?? null },
      COUL: { type: sql.NVarChar(50), value: COUL ?? null },
      QTEMRV: { type: sql.Decimal(12, 3), value: QTEMRV },
      TYPO: { type: sql.NVarChar(50), value: TYPO ?? null },
      SPECTYPO: { type: sql.NVarChar(50), value: SPECTYPO ?? null },
      QAL: { type: sql.Int, value: QAL ?? null },
      DECLQST: { type: sql.Bit, value: DECLQST ?? false },
      CREUSR: { type: sql.NVarChar(120), value: CREUSR },
      MLOPER: { type: sql.NVarChar(100), value: MLOPER },
    },
  });

  return result.recordset[0]?.NUMDOS ?? null;
}

/**
 * Duplique un dossier (nouvelle VRSDEC générée par le trigger INSTEAD OF sur
 * DECENT) puis (re)insère ses ingrédients/cépages.
 *
 * Correctif (cf. audit) : CREUSR/MLOPER étaient codés en dur en V1.0.0
 * (N'BAYET Paul' / N'p.bayet@union-vignerons.com') — toute rectification,
 * peu importe qui la faisait, était donc tracée comme faite par un seul
 * compte. On propage désormais l'identité réelle de l'utilisateur connecté.
 */
export async function setRectification({
  NUMDOS,
  INGRES,
  CEPAGES,
  CREUSR,
  MLOPER,
}) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      DECLARE @SourceNUMDOS NVARCHAR(50) = @NUMDOS;
      DECLARE @SourcePrefixNUMDOS NVARCHAR(50);
      DECLARE @JsonIngredients NVARCHAR(MAX) = @INGRES;
      DECLARE @JsonCepage NVARCHAR(MAX) = @CEPAGES;
      DECLARE @newNUMDOS NVARCHAR(50);

      -- Supprime la dernière partie après le dernier "/"
      SET @SourcePrefixNUMDOS = LEFT(
          @SourceNUMDOS,
          LEN(@SourceNUMDOS) - CHARINDEX(N'/', REVERSE(@SourceNUMDOS))
      );

      BEGIN TRY
          BEGIN TRAN;

          IF NOT EXISTS (SELECT 1 FROM dbo.DECENT WHERE NUMDOS = @SourceNUMDOS)
          BEGIN
              RAISERROR (N'NUMDOS source introuvable.', 16, 1);
          END;

          -- Duplique (déclenche le trigger INSTEAD OF qui génère une nouvelle VRSDEC / NUMDOS)
          INSERT INTO dbo.DECENT (
              NUMDOS, VRSDEC, REFMAR, REFINTR, DATMRC, DEBMRV, FINMRV, REMARQ,
              CAVEID, REFVRAC, DESA1, DESA2, APPL, COUL, QTEMRV, TYPO, SPECTYPO,
              QAL, DECLQST, VALID, MLOPER, DERREL, BADIMLS, VALDAT, CREUSR,
              CREDAT, UPDUSR, UPDDAT
          )
          SELECT
              @SourceNUMDOS, VRSDEC, REFMAR, REFINTR, DATMRC, DEBMRV, FINMRV, REMARQ,
              CAVEID, REFVRAC, DESA1, DESA2, APPL, COUL, QTEMRV, TYPO, SPECTYPO,
              QAL, DECLQST, VALID, @MLOPER, DERREL, BADIMLS, NULL, @CREUSR,
              SYSUTCDATETIME(), NULL, NULL
          FROM dbo.DECENT
          WHERE NUMDOS = @SourceNUMDOS;

          -- Récupère le NUMDOS créé (dernière version sur ce préfixe)
          SELECT TOP (1) @newNUMDOS = v.NUMDOS
          FROM dbo.V_DECFOLDERS_LATEST AS v
          WHERE v.NUMDOS LIKE @SourcePrefixNUMDOS + N'/%'
          ORDER BY v.VRSDEC DESC, v.NUMDOS DESC;

          IF @newNUMDOS IS NULL
          BEGIN
              RAISERROR (N'Impossible de retrouver le nouveau NUMDOS après duplication.', 16, 1);
          END;

          -- INGRÉDIENTS (DECLIGING)
          IF NULLIF(LTRIM(RTRIM(@JsonIngredients)), N'') IS NOT NULL
          BEGIN
              ;WITH J AS (
                  SELECT Code = j.Code, Remarque = j.Remarque
                  FROM OPENJSON(@JsonIngredients)
                  WITH (
                      Code NVARCHAR(50) N'$.CODE',
                      Remarque NVARCHAR(255) N'$.REMARK'
                  ) AS j
              )
              INSERT dbo.DECLIGING (NUMDOS, CODING, REMARQ, CREUSR, CREDAT, UPDUSR, UPDDAT)
              SELECT @newNUMDOS, J.Code, NULLIF(J.Remarque, N''), @CREUSR, SYSUTCDATETIME(), NULL, NULL
              FROM J;
          END;

          -- CÉPAGES (DECLIGCEP)
          IF NULLIF(LTRIM(RTRIM(@JsonCepage)), N'') IS NOT NULL
          BEGIN
              ;WITH J AS (
                  SELECT Code = j.Code, Pourc = j.Pourc, Remarque = j.Remarque
                  FROM OPENJSON(@JsonCepage)
                  WITH (
                      Code NVARCHAR(50) N'$.CODE',
                      Pourc DECIMAL(9, 2) N'$.POURC',
                      Remarque NVARCHAR(255) N'$.REMARK'
                  ) AS j
              )
              INSERT dbo.DECLIGCEP (NUMDOS, CODCEP, POURC, REMARQ, CREUSR, CREDAT, UPDUSR, UPDDAT)
              SELECT @newNUMDOS, J.Code, J.Pourc, NULLIF(J.Remarque, N''), @CREUSR, SYSUTCDATETIME(), NULL, NULL
              FROM J;
          END;

          COMMIT;

          SELECT * FROM dbo.V_DECFOLDERS_LATEST WHERE NUMDOS = @newNUMDOS;
      END TRY
      BEGIN CATCH
          IF @@TRANCOUNT > 0 ROLLBACK;
          DECLARE @Msg NVARCHAR(4000) = ERROR_MESSAGE();
          RAISERROR (@Msg, 16, 1);
      END CATCH;
    `,
    inputs: {
      NUMDOS: { type: sql.NVarChar, value: NUMDOS },
      INGRES: {
        type: sql.NVarChar(sql.MAX),
        value: JSON.stringify(INGRES ?? []),
      },
      CEPAGES: {
        type: sql.NVarChar(sql.MAX),
        value: JSON.stringify(CEPAGES ?? []),
      },
      CREUSR: { type: sql.NVarChar(120), value: CREUSR },
      MLOPER: { type: sql.NVarChar(100), value: MLOPER },
    },
  });

  return result.recordset;
}

export async function getRelaunchData(NUMDOS = null) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SELECT *
      FROM V_CAVE_RELAUNCH
      WHERE @NUMDOS IS NULL OR @NUMDOS = NUMDOS
    `,
    inputs: {
      NUMDOS: { type: sql.NVarChar, value: NUMDOS },
    },
  });

  return result.recordset;
}

export async function setRelaunch(NUMDOS) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
      UPDATE DECENT
      SET DERREL = SYSUTCDATETIME()
      WHERE NUMDOS = @NUMDOS
    `,
    inputs: {
      NUMDOS: { type: sql.NVarChar, value: NUMDOS },
    },
  });
}

/**
 * Dossiers (dernière version) dont le questionnaire de traçabilité est en
 * attente : DECLQST = 1 et DECLQSTSTA parmi ('DRAFT', 'INVALID'). Alimente
 * /relaunch/quest (relance côté service Qualité), pendant de
 * getRelaunchData/V_CAVE_RELAUNCH utilisé par /relaunch (Œnologie).
 * NUMDOS optionnel : relance d'un seul dossier si fourni, sinon tous les
 * dossiers éligibles (bouton "Tout relancer").
 */
export async function getQuestRelaunchData(NUMDOS = null) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
      SELECT *
      FROM V_DECFOLDERS_LATEST
      WHERE DECLQST = 1
        AND DECLQSTSTA IN ('DRAFT', 'INVALID')
        AND (@NUMDOS IS NULL OR @NUMDOS = NUMDOS)
    `,
    inputs: {
      NUMDOS: { type: sql.NVarChar, value: NUMDOS },
    },
  });

  return result.recordset;
}

/**
 * Trace la dernière relance de questionnaire sur DECENT.DERRELQST, en
 * parallèle de DERREL (relance de déclaration) — colonne dédiée pour ne
 * pas interférer avec le calcul de CANREL (V_CAVE_RELAUNCH) utilisé par la
 * relance de déclaration côté Œnologie.
 */
export async function setRelaunchQuest(NUMDOS) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
      UPDATE DECENT
      SET DERRELQST = SYSUTCDATETIME()
      WHERE NUMDOS = @NUMDOS
    `,
    inputs: {
      NUMDOS: { type: sql.NVarChar, value: NUMDOS },
    },
  });
}

/**
 * Insère les ingrédients/cépages d'un dossier existant (sans dupliquer,
 * contrairement à setRectification) puis marque le dossier comme validé.
 * Même correctif CREUSR que setRectification (plus de valeur codée en dur).
 */
export async function setMrvIngredients({
  NUMDOS,
  INGRES,
  CEPAGES,
  CREUSR,
  VALDDATE,
}) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
      DECLARE @SourceNUMDOS NVARCHAR(50) = @NUMDOS;
      DECLARE @JsonIngredients NVARCHAR(MAX) = @INGRES;
      DECLARE @JsonCepage      NVARCHAR(MAX) = @CEPAGES;

      BEGIN TRY
          BEGIN TRAN;

          IF NOT EXISTS (
              SELECT 1
              FROM dbo.DECENT
              WHERE NUMDOS = @SourceNUMDOS
          )
          BEGIN
              RAISERROR (N'NUMDOS introuvable.', 16, 1);
          END;

          /* =========================================
            SUPPRESSION DES DONNÉES EXISTANTES
            ========================================= */

          DELETE FROM dbo.DECLIGING
          WHERE NUMDOS = @SourceNUMDOS;

          DELETE FROM dbo.DECLIGCEP
          WHERE NUMDOS = @SourceNUMDOS;


          /* =========================================
            INSERT INGREDIENTS
            ========================================= */

          IF NULLIF(LTRIM(RTRIM(@JsonIngredients)), N'') IS NOT NULL
          BEGIN
              ;WITH J AS
              (
                  SELECT
                      Code     = j.Code,
                      Remarque = j.Remarque
                  FROM OPENJSON(@JsonIngredients)
                  WITH
                  (
                      Code     NVARCHAR(50)  N'$.CODE',
                      Remarque NVARCHAR(255) N'$.REMARK'
                  ) AS j
              )
              INSERT INTO dbo.DECLIGING
              (
                  NUMDOS,
                  CODING,
                  REMARQ,
                  CREUSR,
                  CREDAT,
                  UPDUSR,
                  UPDDAT
              )
              SELECT
                  @SourceNUMDOS,
                  J.Code,
                  NULLIF(J.Remarque, N''),
                  @CREUSR,
                  SYSUTCDATETIME(),
                  NULL,
                  NULL
              FROM J;
          END;


          /* =========================================
            INSERT CEPAGES
            ========================================= */

          IF NULLIF(LTRIM(RTRIM(@JsonCepage)), N'') IS NOT NULL
          BEGIN
              ;WITH J AS
              (
                  SELECT
                      Code     = j.Code,
                      Pourc    = j.Pourc,
                      Remarque = j.Remarque
                  FROM OPENJSON(@JsonCepage)
                  WITH
                  (
                      Code     NVARCHAR(50)  N'$.CODE',
                      Pourc    DECIMAL(9,2)  N'$.POURC',
                      Remarque NVARCHAR(255) N'$.REMARK'
                  ) AS j
              )
              INSERT INTO dbo.DECLIGCEP
              (
                  NUMDOS,
                  CODCEP,
                  POURC,
                  REMARQ,
                  CREUSR,
                  CREDAT,
                  UPDUSR,
                  UPDDAT
              )
              SELECT
                  @SourceNUMDOS,
                  J.Code,
                  J.Pourc,
                  NULLIF(J.Remarque, N''),
                  @CREUSR,
                  SYSUTCDATETIME(),
                  NULL,
                  NULL
              FROM J;
          END;


          /* =========================================
            MISE À JOUR DU DOSSIER
            ========================================= */

          UPDATE dbo.DECENT
          SET VALDDATE = @VALDDATE
          WHERE NUMDOS = @SourceNUMDOS;


          COMMIT;

      END TRY
      BEGIN CATCH

          IF @@TRANCOUNT > 0
              ROLLBACK;

          DECLARE @Msg NVARCHAR(4000) = ERROR_MESSAGE();
          RAISERROR (@Msg, 16, 1);

      END CATCH;
    `,
    inputs: {
      NUMDOS: { type: sql.NVarChar, value: NUMDOS },
      INGRES: {
        type: sql.NVarChar(sql.MAX),
        value: JSON.stringify(INGRES ?? []),
      },
      CEPAGES: {
        type: sql.NVarChar(sql.MAX),
        value: JSON.stringify(CEPAGES ?? []),
      },
      CREUSR: { type: sql.NVarChar(120), value: CREUSR },
      VALDDATE: { type: sql.DateTime2, value: VALDDATE },
    },
  });
}

/**
 * Resynchronise les champs DECENT issus de la MRV (ERP X3) sur un dossier
 * déjà existant, sans dupliquer de version (contrairement à
 * setRectification) ni toucher aux champs propres à l'application :
 * CAVEID (rattachement cave), REMARQ (remarque libre), DATMRC (date de
 * création du dossier, pas la date de commande ERP — cf. setDeclaration),
 * VALID/VALDAT/VALDDATE (cycle de validation) et DECLQST restent inchangés.
 * Utilisé par le bouton "Actualiser depuis l'ERP" (PATCH /).
 */
export async function refreshDeclarationFromErp({
  NUMDOS,
  REFINTR,
  DEBMRV,
  FINMRV,
  REFVRAC,
  DESA1,
  DESA2,
  APPL,
  COUL,
  QTEMRV,
  TYPO,
  SPECTYPO,
  QAL,
  UPDUSR,
}) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
      UPDATE DECENT
      SET
        REFINTR  = @REFINTR,
        DEBMRV   = @DEBMRV,
        FINMRV   = @FINMRV,
        REFVRAC  = @REFVRAC,
        DESA1    = @DESA1,
        DESA2    = @DESA2,
        APPL     = @APPL,
        COUL     = @COUL,
        QTEMRV   = @QTEMRV,
        TYPO     = @TYPO,
        SPECTYPO = @SPECTYPO,
        QAL      = @QAL,
        UPDUSR   = @UPDUSR,
        UPDDAT   = SYSUTCDATETIME()
      WHERE NUMDOS = @NUMDOS
    `,
    inputs: {
      NUMDOS: { type: sql.NVarChar, value: NUMDOS },
      REFINTR: { type: sql.NVarChar(15), value: REFINTR ?? null },
      DEBMRV: { type: sql.DateTime, value: DEBMRV ?? null },
      FINMRV: { type: sql.DateTime, value: FINMRV ?? null },
      REFVRAC: { type: sql.NVarChar(10), value: REFVRAC ?? null },
      DESA1: { type: sql.NVarChar(120), value: DESA1 ?? null },
      DESA2: { type: sql.NVarChar(120), value: DESA2 ?? null },
      APPL: { type: sql.NVarChar(50), value: APPL ?? null },
      COUL: { type: sql.NVarChar(50), value: COUL ?? null },
      QTEMRV: { type: sql.Decimal(12, 3), value: QTEMRV ?? null },
      TYPO: { type: sql.NVarChar(50), value: TYPO ?? null },
      SPECTYPO: { type: sql.NVarChar(50), value: SPECTYPO ?? null },
      QAL: { type: sql.Int, value: QAL ?? null },
      UPDUSR: { type: sql.NVarChar(120), value: UPDUSR ?? null },
    },
  });
}

export async function validDeclaration(NUMDOS) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
      UPDATE DECENT
      SET VALDAT = SYSUTCDATETIME()
      WHERE NUMDOS = @NUMDOS
    `,
    inputs: {
      NUMDOS: { type: sql.NVarChar, value: NUMDOS },
    },
  });
}

export async function deleteDecl(NUMDOS) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
      UPDATE DECENT
      SET DEL = ~DEL
      WHERE NUMDOS = @NUMDOS
    `,
    inputs: {
      NUMDOS: { type: sql.NVarChar, value: NUMDOS },
    },
  });
}

/* ─────────────────────────────────────────────
   QUESTIONNAIRES
───────────────────────────────────────────── */

export async function getResponses(REFEXT) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    key: `declcav.getResponses.${!!REFEXT}`,
    query: REFEXT
      ? `SELECT * FROM V_QUESTANSWERS WHERE REFEXT = @REFEXT`
      : `SELECT * FROM V_QUESTANSWERS`,
    inputs: {
      REFEXT: { type: sql.NVarChar(100), value: REFEXT },
    },
  });

  return result.recordset;
}

export async function upsertResponsesSubmit({ SUBID, REFEXT, STATUS }) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;

    DECLARE @Output TABLE (SUBID INT);

    IF @SUBID IS NOT NULL OR @REFEXT IS NOT NULL
    AND EXISTS (SELECT 1 FROM QUESTSUBMIT WHERE SUBID = @SUBID OR REFEXT = @REFEXT)
    BEGIN
        UPDATE QUESTSUBMIT
        SET REFEXT = @REFEXT, SUBDAT = SYSUTCDATETIME(), STATUS = @STATUS
        OUTPUT inserted.SUBID INTO @Output
        WHERE SUBID = @SUBID OR REFEXT = @REFEXT;
    END
    ELSE
    BEGIN
        INSERT INTO QUESTSUBMIT (REFEXT, SUBDAT, STATUS)
        OUTPUT inserted.SUBID INTO @Output
        VALUES (@REFEXT, SYSUTCDATETIME(), @STATUS);
    END

    SELECT SUBID FROM @Output;
    `,
    inputs: {
      SUBID: { type: sql.Int, value: SUBID ?? null },
      REFEXT: { type: sql.NVarChar(100), value: REFEXT },
      STATUS: { type: sql.NVarChar(20), value: STATUS },
    },
  });

  return result.recordset[0]?.SUBID;
}

/**
 * Remplace intégralement les réponses d'un questionnaire (delete + insert),
 * dans une seule transaction. Le front renvoie toujours l'ensemble des
 * réponses : une valeur vidée (ex. certification décochée via « AUCUNE »)
 * disparaît ainsi de la base au lieu d'y rester comme avec un upsert.
 */
export async function delsertResponses(SUBID, answers) {
  const answersPayload = (answers ?? []).map((a) => ({
    QSTCOD: a.QSTCOD,
    PRTQSTCOD: a.PRTQSTCOD ?? null,
    ROWCOD: a.ROWCOD ?? null,
    ASWRTYP: a.ASWRTYP ?? null,
    VALTXT: a.VALTXT ?? null,
    VALBIT: a.VALBIT ?? null,
    VALNUM: a.VALNUM ?? null,
    VALJSON:
      typeof a.VALJSON === "string" || a.VALJSON == null
        ? (a.VALJSON ?? null)
        : JSON.stringify(a.VALJSON),
  }));

  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;

    BEGIN TRY
        BEGIN TRAN;

        DELETE FROM QUESTANSWER
        WHERE SUBID = @SUBID;

        INSERT INTO QUESTANSWER (
            SUBID, QSTCOD, PRTQSTCOD, ROWCOD, ASWRTYP, VALTXT, VALBIT,
            VALNUM, VALDAT, VALJSON, CREDAT
        )
        SELECT
            @SUBID, j.QSTCOD, j.PRTQSTCOD, j.ROWCOD, j.ASWRTYP, j.VALTXT,
            j.VALBIT, j.VALNUM, NULL, j.VALJSON, SYSUTCDATETIME()
        FROM OPENJSON(@ANSWERS)
        WITH
        (
            QSTCOD    NVARCHAR(150)  '$.QSTCOD',
            PRTQSTCOD NVARCHAR(150)  '$.PRTQSTCOD',
            ROWCOD    NVARCHAR(150)  '$.ROWCOD',
            ASWRTYP   NVARCHAR(30)   '$.ASWRTYP',
            VALTXT    NVARCHAR(2000) '$.VALTXT',
            VALBIT    BIT            '$.VALBIT',
            VALNUM    DECIMAL(18, 4) '$.VALNUM',
            VALJSON   NVARCHAR(MAX)  '$.VALJSON'
        ) AS j;

        COMMIT;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        THROW;
    END CATCH;
    `,
    inputs: {
      SUBID: { type: sql.BigInt, value: SUBID },
      ANSWERS: {
        type: sql.NVarChar(sql.MAX),
        value: JSON.stringify(answersPayload),
      },
    },
  });
}

/* ─────────────────────────────────────────────
   INGRÉDIENTS
───────────────────────────────────────────── */

export async function patchIngredient({
  IS_CEP,
  CODE,
  LIBEL,
  AVISUV1,
  AVISUV2,
  ACTIF,
  REMARK,
}) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    key: `declcav.patchIngredient.${IS_CEP}`,
    query: IS_CEP
      ? `
        UPDATE CEPLIST
        SET CEPAGE = @LIBEL, REMARQ = @REMARK, AVISUV1 = @AVISUV1,
            AVISUV2 = @AVISUV2, ACTIF = @ACTIF, UPDDAT = SYSUTCDATETIME()
        WHERE CODE = @CODE;

        SELECT * FROM V_INGREDIENTS WHERE CODE = @CODE;
      `
      : `
        UPDATE INGLIST
        SET INGRED = @LIBEL, REMARQ = @REMARK, AVISUV1 = @AVISUV1,
            AVISUV2 = @AVISUV2, ACTIF = @ACTIF, UPDDAT = SYSUTCDATETIME()
        WHERE CODE = @CODE;

        SELECT * FROM V_INGREDIENTS WHERE CODE = @CODE;
      `,
    inputs: {
      CODE: { type: sql.NVarChar(10), value: CODE },
      LIBEL: { type: sql.NVarChar(120), value: LIBEL },
      REMARK: { type: sql.NVarChar(255), value: REMARK ?? null },
      AVISUV1: { type: sql.TinyInt, value: AVISUV1 ?? null },
      AVISUV2: { type: sql.TinyInt, value: AVISUV2 ?? null },
      ACTIF: { type: sql.Bit, value: ACTIF },
    },
  });

  return result.recordset;
}
