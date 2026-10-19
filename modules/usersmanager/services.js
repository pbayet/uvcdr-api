import sql from "mssql";
import { runQuery } from "../../core/utils/db.utils.js";
import { truncate } from "../../core/utils/functions.utils.js";

/**
 * Périmètre étendu par rapport à la version initiale de V1.1.0 : les écrans
 * d'admin RH de V1.0.0 (users CRUD, services, positions, groupes,
 * applications, permissions) sont désormais reconstruits ici.
 *
 * NB : chaque fonction utilise le helper runQuery() (core/utils/db.utils.js)
 * qui remplace le motif répété getDbConnexion → generateAutoKey →
 * getPreparedStatement → execute de V1.0.0 (cf. audit dette technique 4.2).
 *
 * getGeneralActivity/getUserActivity/postActivityStats interrogent la base
 * "generalactivity" (config/db/generalactivity.db.config.js) et alimentent/
 * lisent la table USERSACTIVITY : journalisation d'activité applicative,
 * consommée par core/middlewares/log.middleware.js et error.middleware.js
 * (liste des routes journalisées : core/config/activityLog.config.js).
 */

/* -------------------------------------------------------------------------- */
/*                                    GETS                                    */
/* -------------------------------------------------------------------------- */

export async function getUsers() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `EXEC sp_GetUsers_JSON`,
    errorIfEmpty: "USER_NOT_FOUND",
  });

  return result.recordset;
}

export async function getUserByEmail(EMAIL) {
  return (
    await runQuery({
      moduleUrl: import.meta.url,
      query: `EXEC sp_GetUsers_JSON @EMAIL = @EML`,
      inputs: { EML: { type: sql.NVarChar, value: EMAIL } },
      errorIfEmpty: "USER_NOT_FOUND",
    })
  ).recordset;
}

export async function getUserById(USRID) {
  return (
    await runQuery({
      moduleUrl: import.meta.url,
      query: `EXEC sp_GetUsers_JSON @USRID = @ID`,
      inputs: { ID: { type: sql.Int, value: USRID } },
      errorIfEmpty: "USER_NOT_FOUND",
    })
  ).recordset;
}

export async function getUserByPosCod(POSCOD) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `EXEC sp_GetUsers_JSON @POSCOD = @PSC`,
    inputs: { PSC: { type: sql.NVarChar, value: POSCOD } },
    errorIfEmpty: "USER_NOT_FOUND",
  });

  return result.recordset;
}

export async function getApplications(APPID = undefined) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: APPID
      ? `
    SELECT
      APPID, APPNAM, APPDES, LOGLNK, APPLNK, ACTIVE,
      CREDAT, UPDDAT, CREUSR, UPDUSR, DOCLNK, IMGLNK, APPCOD, MNTCE
    FROM APPLICATIONS
    WHERE APPID = @APPID
    `
      : `
    SELECT
      APPID, APPNAM, APPDES, LOGLNK, APPLNK, ACTIVE,
      CREDAT, UPDDAT, CREUSR, UPDUSR, DOCLNK, IMGLNK, APPCOD, MNTCE
    FROM APPLICATIONS
    `,
    inputs: { APPID: { type: sql.Int, value: APPID } },
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

export async function getApplicationCurrentVersion(APPCOD) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT DISTINCT VNUM AS version
    FROM V_App_Last_Version_Details
    WHERE APPCOD = @APPCOD
    ORDER BY VNUM DESC
    `,
    inputs: { APPCOD: { type: sql.NVarChar, value: APPCOD } },
  });

  return result.recordset;
}

/**
 * Ne fait aucun accès BDD : dérive, à partir des permissions déjà chargées
 * de l'utilisateur, la meilleure (plus haut niveau) permission par
 * application. Porté tel quel depuis V1.0.0.
 */
export async function getHomeApplications(user) {
  if (!user) throw new Error("USER_NOT_FOUND");

  const permissions = Array.isArray(user.PERMISSIONS) ? user.PERMISSIONS : [];

  const appMap = new Map();

  for (const perm of permissions) {
    const appCode = perm.APPCOD ?? perm.APPID ?? perm.APPNAME;
    if (!appCode) continue;

    const levelRaw = perm.PRMLVL ?? perm.PERMISSION?.PRMLVL;
    const level = Number(levelRaw);

    if (!Number.isFinite(level) || level <= 0) continue;

    const existing = appMap.get(appCode);
    const existingLevel = Number(
      existing?.PRMLVL ?? existing?.PERMISSION?.PRMLVL,
    );

    if (!existing || level < existingLevel) {
      appMap.set(appCode, perm);
    }
  }

  return Array.from(appMap.values()).sort((a, b) => {
    const A = (a.APPCOD ?? "").toString();
    const B = (b.APPCOD ?? "").toString();
    return A.localeCompare(B);
  });
}

export async function getGeneralActivity() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    dbConnectionName: "generalactivity",
    query: `SELECT TOP 5000 * FROM GLOBALACTIVITY ORDER BY [EVENT_DATE] DESC`,
  });

  return result.recordset;
}

export async function getUserActivity(EMAIL, SOURCE) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    dbConnectionName: "generalactivity",
    query: SOURCE
      ? `SELECT
            LOG_ID,
            EVENT_DATE,
            EMAIL,
            SUCCESS,
            METHOD,
            ROUTE,
            COMMENT,
            IPADRESS,
            DURATIONMS,
            PARAMS,
            APPCOD,
            SOURCE
        FROM
            (
                SELECT
                    *,
                    ROW_NUMBER() OVER (
                        PARTITION BY EMAIL
                        ORDER BY
                            EVENT_DATE DESC
                    ) AS rn
                FROM
                    [GENERALACTIVITY].[dbo].[GLOBALACTIVITY]
                WHERE
                    EMAIL = @EMAIL AND SOURCE = @SOURCE
            ) t
        WHERE
            rn = 1`
      : `SELECT * FROM LATEST_ACTIVITY_DETAILS WHERE EMAIL = @EMAIL`,
    inputs: {
      EMAIL: { type: sql.NVarChar, value: EMAIL },
      SOURCE: { type: sql.NVarChar, value: SOURCE },
    },
  });

  return result.recordset;
}

export async function getPermissions() {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `SELECT PRMID, PRMNAM, PRMDES, PRMLVL, ISCRIT FROM PERMISSIONS`,
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

export async function getPermission(PRMLVL) {
  return (
    await runQuery({
      moduleUrl: import.meta.url,
      query: `SELECT PRMID, PRMNAM, PRMDES, PRMLVL, ISCRIT FROM PERMISSIONS WHERE PRMLVL = @PRMLVL`,
      inputs: { PRMLVL: { type: sql.Int, value: PRMLVL } },
      errorIfEmpty: "DATA_NOT_FOUND",
    })
  ).recordset;
}

export async function getServices(SRVID = undefined) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: SRVID
      ? `
    SELECT POSID, POSNAM, POSDES, POSCOD, POSLVL, SRVID, SRVCOD, SRVNAM, SRVDES
    FROM V_PositionsServices
    WHERE SRVID = @SRVID
    `
      : `
    SELECT POSID, POSNAM, POSDES, POSCOD, POSLVL, SRVID, SRVCOD, SRVNAM, SRVDES
    FROM V_PositionsServices
    `,
    inputs: { SRVID: { type: sql.Int, value: SRVID } },
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

export async function getServicesAll(SRVID = undefined) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: SRVID
      ? `
    SELECT p.POSID, p.POSNAM, p.POSDES, p.POSCOD, p.POSLVL, s.SRVCOD, s.SRVID, s.SRVNAM, s.SRVDES
    FROM dbo.SERVICES AS s
    LEFT OUTER JOIN dbo.POSITIONS AS p ON p.SRVCOD = s.SRVCOD
    WHERE s.SRVID = @SRVID
    `
      : `
    SELECT p.POSID, p.POSNAM, p.POSDES, p.POSCOD, p.POSLVL, s.SRVCOD, s.SRVID, s.SRVNAM, s.SRVDES
    FROM dbo.SERVICES AS s
    LEFT OUTER JOIN dbo.POSITIONS AS p ON p.SRVCOD = s.SRVCOD
    `,
    inputs: { SRVID: { type: sql.Int, value: SRVID } },
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

export async function getPositions(POSID = undefined) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: POSID
      ? `SELECT POSID, POSNAM, POSDES, POSCOD, POSLVL FROM POSITIONS WHERE POSID = @POSID`
      : `SELECT POSID, POSNAM, POSDES, POSCOD, POSLVL FROM POSITIONS`,
    inputs: { POSID: { type: sql.Int, value: POSID } },
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

export async function getGroups(GRPID = undefined) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: GRPID
      ? `
    SELECT GRPID, GRPNAM, GRPDES, GRPACTV, GRPBAS, APPID, APPCOD, APPNAM, APPDES,
           IMGLNK, LOGLNK, DOCLNK, APPLNK, APPACTV, PRMID, PRMNAM, PRMDES, PRMLVL, ISCRIT
    FROM V_GroupsPermission
    WHERE GRPID = @GRPID
    `
      : `
    SELECT GRPID, GRPNAM, GRPDES, GRPACTV, GRPBAS, APPID, APPCOD, APPNAM, APPDES,
           IMGLNK, LOGLNK, DOCLNK, APPLNK, APPACTV, PRMID, PRMNAM, PRMDES, PRMLVL, ISCRIT
    FROM V_GroupsPermission
    `,
    inputs: { GRPID: { type: sql.Int, value: GRPID } },
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

export async function getLastVersionDetails(USRID, APPCOD) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    DECLARE @USRID_VAL INT = @USRID;
    DECLARE @APPCOD_VAL NVARCHAR(20) = @APPCOD;

    SELECT TOP (1000)
          d.[VID], d.[APPCOD], d.[VNUM], d.[RELEASEDTE], d.[SUMMARY],
          d.[CREUSR_ID], d.[CREUSR_LNAME], d.[CREUSR_FNAME], d.[CREUSR_EMAIL],
          d.[CID], d.[CTYPE], d.[CTITLE], d.[CDESC], n.[UID],
          CASE WHEN n.UID IS NULL THEN 0 ELSE 1 END AS ISVIEW
    FROM dbo.V_App_Last_Version_Details AS d
    LEFT JOIN USERAPPNOTIF AS n
        ON n.VID = d.VID
       AND n.UID = @USRID_VAL
    WHERE d.APPCOD = @APPCOD_VAL;
    `,
    inputs: {
      USRID: { type: sql.Int, value: USRID },
      APPCOD: { type: sql.NVarChar, value: APPCOD },
    },
    errorIfEmpty: "DATA_NOT_FOUND",
  });

  return result.recordset;
}

/**
 * Trace d'audit des tentatives de connexion (table LOGINHISTORY côté
 * USERSMANAGER). Complémentaire de la journalisation complète d'activité
 * (postActivityStats, ci-dessous, table USERSACTIVITY côté
 * "generalactivity") : postLoginStats ne trace que les tentatives d'auth,
 * postActivityStats trace les requêtes métier listées dans
 * core/config/activityLog.config.js.
 */
export async function postLoginStats(success, EMAIL, APPCOD) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `INSERT INTO LOGINHISTORY (SUCCESS, EMAIL, APPCOD) VALUES (@SUCCESS, @EMAIL, @APPCOD)`,
    inputs: {
      SUCCESS: { type: sql.Bit, value: success },
      EMAIL: { type: sql.NVarChar, value: EMAIL },
      APPCOD: { type: sql.NVarChar, value: APPCOD },
    },
  });

  return true;
}

export async function postActivityStats(
  METHOD,
  ROUTE,
  COMMENT,
  APPCOD,
  USEREMAIL,
  IPADRESS,
  DURATIONMS,
  PARAMS,
  SUCCESS,
) {
  await runQuery({
    moduleUrl: import.meta.url,
    dbConnectionName: "generalactivity",
    query: `
    INSERT INTO USERSACTIVITY
    (
      METHOD,
      ROUTE,
      COMMENT,
      APPCOD,
      USEREMAIL,
      IPADRESS,
      DURATIONMS,
      PARAMS,
      SUCCESS
    )
    VALUES
    (
      @METHOD,
      @ROUTE,
      @COMMENT,
      @APPCOD,
      @USEREMAIL,
      @IPADRESS,
      @DURATIONMS,
      @PARAMS,
      @SUCCESS
    )
    `,
    // truncate() protège contre un "String or binary data would be
    // truncated" si un appelant transmet une valeur plus longue que la
    // colonne (ex: COMMENT/ROUTE personnalisés, email inhabituellement
    // long) — cf. audit : postActivityStats est appelé en fire-and-forget
    // (log.middleware.js/error.middleware.js), une erreur ici ne doit
    // jamais faire échouer une requête HTTP par ailleurs valide.
    inputs: {
      METHOD: { type: sql.VarChar(10), value: truncate(METHOD, 10) },
      ROUTE: { type: sql.NVarChar(300), value: truncate(ROUTE, 300) },
      COMMENT: { type: sql.NVarChar(300), value: truncate(COMMENT, 300) },
      APPCOD: { type: sql.NVarChar(20), value: truncate(APPCOD, 20) },
      USEREMAIL: { type: sql.NVarChar(320), value: truncate(USEREMAIL, 320) },
      IPADRESS: { type: sql.VarChar(45), value: truncate(IPADRESS, 45) },
      DURATIONMS: { type: sql.Int, value: DURATIONMS },
      PARAMS: { type: sql.NVarChar(sql.MAX), value: PARAMS },
      SUCCESS: { type: sql.Bit, value: SUCCESS },
    },
  });

  return true;
}

/* -------------------------------------------------------------------------- */
/*                                   POSTS                                    */
/* -------------------------------------------------------------------------- */

export async function upsertUser(
  USRID,
  LSTNAM,
  FSTNAM,
  EMAIL,
  PHNNUM,
  USRACTV,
  ISEXT,
  POSID,
  postUSRID,
) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;

    DECLARE @Result TABLE (USRID INT);

    UPDATE U
      SET U.LSTNAM = @LSTNAM,
          U.FSTNAM = @FSTNAM,
          U.EMAIL  = @EMAIL,
          U.PHNNUM = @PHNNUM,
          U.ACTIVE = @USRACTV,
          U.ISEXT  = @ISEXT,
          U.POSID  = @POSID,
          U.UPDDAT = SYSDATETIME(),
          U.UPDUSR = @postUSRID
    OUTPUT INSERTED.USRID INTO @Result
    FROM USERS AS U
    WHERE U.USRID = @USRID;

    IF @@ROWCOUNT = 0
    BEGIN
      INSERT INTO USERS
      ([LSTNAM],[FSTNAM],[EMAIL],[PHNNUM],[POSID],[ISEXT],[ACTIVE],[CREDAT],[UPDDAT],[CREUSR],[UPDUSR])
      OUTPUT INSERTED.USRID INTO @Result
      VALUES
      (@LSTNAM, @FSTNAM, @EMAIL, @PHNNUM, @POSID, @ISEXT, @USRACTV, SYSDATETIME(), SYSDATETIME(), @postUSRID, @postUSRID);
    END;

    SELECT USRID FROM @Result;
    `,
    inputs: {
      USRID: { type: sql.Int, value: USRID },
      LSTNAM: { type: sql.NVarChar(255), value: LSTNAM },
      FSTNAM: { type: sql.NVarChar(255), value: FSTNAM },
      EMAIL: { type: sql.NVarChar(255), value: EMAIL },
      PHNNUM: { type: sql.NVarChar(255), value: PHNNUM },
      USRACTV: { type: sql.Bit, value: USRACTV },
      ISEXT: { type: sql.Bit, value: ISEXT },
      POSID: { type: sql.Int, value: POSID },
      postUSRID: { type: sql.Int, value: postUSRID },
    },
  });

  return result?.recordset?.[0]?.USRID;
}

export async function upsertPosition(
  USRID,
  POSID,
  POSNAM,
  POSDES,
  POSCOD,
  POSLVL,
  SRVCOD,
) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;

    DECLARE @Result TABLE (POSID INT);

    UPDATE P
      SET P.POSCOD = @POSCOD,
          P.POSNAM = @POSNAM,
          P.POSDES = @POSDES,
          P.POSLVL = @POSLVL,
          P.SRVCOD = @SRVCOD,
          P.UPDDAT = SYSDATETIME(),
          P.UPDUSR = @USRID
    OUTPUT INSERTED.POSID INTO @Result
    FROM POSITIONS AS P
    WHERE P.POSID = @POSID;

    IF @@ROWCOUNT = 0
    BEGIN
        INSERT INTO POSITIONS ([POSCOD],[POSNAM],[POSDES],[POSLVL],[SRVCOD],[CREDAT],[UPDDAT],[CREUSR],[UPDUSR])
        OUTPUT INSERTED.POSID INTO @Result
        VALUES (@POSCOD, @POSNAM, @POSDES, @POSLVL, @SRVCOD, SYSDATETIME(), SYSDATETIME(), @USRID, @USRID);
    END;

    SELECT POSID FROM @Result;
    `,
    inputs: {
      USRID: { type: sql.Int, value: USRID },
      POSID: { type: sql.Int, value: POSID },
      POSNAM: { type: sql.NVarChar(255), value: POSNAM },
      POSDES: { type: sql.NVarChar(4000), value: POSDES },
      POSCOD: { type: sql.NVarChar(10), value: POSCOD },
      POSLVL: { type: sql.Int, value: POSLVL },
      SRVCOD: { type: sql.NVarChar(10), value: SRVCOD },
    },
  });

  return result?.recordset?.[0]?.POSID;
}

export async function upsertGroup(
  USRID,
  GRPID,
  GRPNAM,
  GRPDES,
  ACTIVE,
  GRPBAS,
) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;

    DECLARE @Result TABLE (GRPID INT);

    UPDATE G
    SET G.GRPNAM = @GRPNAM,
        G.GRPDES = @GRPDES,
        G.ACTIVE = @ACTIVE,
        G.GRPBAS = @GRPBAS,
        G.UPDDAT = SYSDATETIME(),
        G.UPDUSR = @USRID
    OUTPUT INSERTED.GRPID INTO @Result
    FROM GROUPS AS G
    WHERE G.GRPID = @GRPID;

    IF @@ROWCOUNT = 0
    BEGIN
        INSERT INTO GROUPS (GRPNAM, GRPDES, ACTIVE, GRPBAS, CREDAT, UPDDAT, CREUSR, UPDUSR)
        OUTPUT INSERTED.GRPID INTO @Result
        VALUES (@GRPNAM, @GRPDES, @ACTIVE, @GRPBAS, SYSDATETIME(), SYSDATETIME(), @USRID, @USRID);
    END;

    SELECT GRPID FROM @Result;
    `,
    inputs: {
      USRID: { type: sql.Int, value: USRID },
      GRPID: { type: sql.Int, value: GRPID },
      GRPNAM: { type: sql.NVarChar(255), value: GRPNAM },
      GRPDES: { type: sql.NVarChar(4000), value: GRPDES },
      ACTIVE: { type: sql.Bit, value: ACTIVE },
      GRPBAS: { type: sql.Bit, value: GRPBAS },
    },
  });

  return result?.recordset?.[0]?.GRPID;
}

export async function upsertApplication(
  USRID,
  APPID,
  APPCOD,
  APPNAM,
  APPDES,
  LOGLNK,
  APPLNK,
  DOCLNK,
  IMGLNK,
  ACTIVE,
  MNTCE,
) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;

    DECLARE @Result TABLE (APPID INT);

    UPDATE A
       SET A.APPCOD = @APPCOD,
           A.APPNAM = @APPNAM,
           A.APPDES = @APPDES,
           A.LOGLNK = @LOGLNK,
           A.APPLNK = @APPLNK,
           A.DOCLNK = @DOCLNK,
           A.IMGLNK = @IMGLNK,
           A.ACTIVE = @ACTIVE,
           A.MNTCE  = @MNTCE,
           A.UPDDAT = SYSDATETIME(),
           A.UPDUSR = @USRID
    OUTPUT INSERTED.APPID INTO @Result
      FROM APPLICATIONS AS A
     WHERE A.APPID = @APPID;

    IF @@ROWCOUNT = 0
    BEGIN
        INSERT INTO APPLICATIONS
        ([APPCOD],[APPNAM],[APPDES],[LOGLNK],[APPLNK],[ACTIVE],[CREDAT],[UPDDAT],[CREUSR],[UPDUSR],[DOCLNK],[IMGLNK],[MNTCE])
        OUTPUT INSERTED.APPID INTO @Result
        VALUES (@APPCOD, @APPNAM, @APPDES, @LOGLNK, @APPLNK, @ACTIVE, SYSDATETIME(), SYSDATETIME(), @USRID, @USRID, @DOCLNK, @IMGLNK, @MNTCE);
    END;

    SELECT APPID FROM @Result;
    `,
    inputs: {
      USRID: { type: sql.Int, value: USRID },
      APPID: { type: sql.Int, value: APPID },
      APPCOD: { type: sql.NVarChar(20), value: APPCOD },
      APPNAM: { type: sql.NVarChar(255), value: APPNAM },
      APPDES: { type: sql.NVarChar(4000), value: APPDES },
      LOGLNK: { type: sql.NVarChar(500), value: LOGLNK },
      APPLNK: { type: sql.NVarChar(500), value: APPLNK },
      DOCLNK: { type: sql.NVarChar(500), value: DOCLNK },
      IMGLNK: { type: sql.NVarChar(500), value: IMGLNK },
      ACTIVE: { type: sql.Bit, value: ACTIVE },
      MNTCE: { type: sql.Bit, value: MNTCE },
    },
  });

  return result?.recordset?.[0]?.APPID;
}

export async function upsertService(USRID, SRVID, SRVCOD, SRVNAM, SRVDES) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;

    DECLARE @Result TABLE (SRVID INT);

    UPDATE S
      SET S.SRVCOD = @SRVCOD,
          S.SRVNAM = @SRVNAM,
          S.SRVDES = @SRVDES,
          S.UPDDAT = SYSDATETIME(),
          S.UPDUSR = @USRID
    OUTPUT INSERTED.SRVID INTO @Result
    FROM SERVICES AS S
    WHERE S.SRVID = @SRVID;

    IF @@ROWCOUNT = 0
    BEGIN
      INSERT INTO SERVICES ([SRVCOD],[SRVNAM],[SRVDES],[CREDAT],[UPDDAT],[CREUSR],[UPDUSR])
      OUTPUT INSERTED.SRVID INTO @Result
      VALUES (@SRVCOD, @SRVNAM, @SRVDES, SYSDATETIME(), SYSDATETIME(), @USRID, @USRID);
    END;

    SELECT SRVID FROM @Result;
    `,
    inputs: {
      USRID: { type: sql.Int, value: USRID },
      SRVID: { type: sql.Int, value: SRVID },
      SRVCOD: { type: sql.NVarChar(10), value: SRVCOD },
      SRVNAM: { type: sql.NVarChar(255), value: SRVNAM },
      SRVDES: { type: sql.NVarChar(4000), value: SRVDES },
    },
  });

  return result?.recordset?.[0]?.SRVID;
}

export async function delsertGroupPermissions(GRPID, PERMISSIONS) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    BEGIN TRAN;

    BEGIN TRY
        DELETE FROM dbo.PRMGRP
        WHERE GRPID = @GRPID;

        IF ISJSON(@PERMISSIONS) = 1
           AND EXISTS (SELECT 1 FROM OPENJSON(@PERMISSIONS))
        BEGIN
            INSERT INTO dbo.PRMGRP (APPID, GRPID, PRMID)
            SELECT DISTINCT P.APPID, @GRPID, P.PRMID
            FROM OPENJSON(@PERMISSIONS)
            WITH (APPID INT '$.APPID', PRMID INT '$.PRMID') AS P
            WHERE P.APPID IS NOT NULL AND P.PRMID IS NOT NULL;
        END;

        COMMIT TRAN;

        SELECT @GRPID AS GRPID;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRAN;

        THROW;
    END CATCH;
    `,
    inputs: {
      GRPID: { type: sql.Int, value: GRPID },
      PERMISSIONS: {
        type: sql.NVarChar(sql.MAX),
        value: JSON.stringify(PERMISSIONS ?? []),
      },
    },
  });

  return true;
}

export async function delsertUserGroups(USRID, GRPIDS) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    BEGIN TRAN;

    BEGIN TRY
      DELETE FROM USRGRP
      WHERE USRID = @USRID;

      IF @GRPIDS IS NOT NULL AND LTRIM(RTRIM(@GRPIDS)) <> ''
      BEGIN
        IF ISJSON(@GRPIDS) = 1
        BEGIN
          INSERT INTO USRGRP (USRID, GRPID)
          SELECT @USRID, TRY_CAST([value] AS INT)
          FROM OPENJSON(@GRPIDS)
          WHERE TRY_CAST([value] AS INT) IS NOT NULL;
        END
        ELSE
        BEGIN
          INSERT INTO USRGRP (USRID, GRPID)
          SELECT @USRID, TRY_CAST(value AS INT)
          FROM STRING_SPLIT(@GRPIDS, ',')
          WHERE TRY_CAST(value AS INT) IS NOT NULL;
        END
      END;

      COMMIT TRAN;

      SELECT @USRID AS USRID;
    END TRY
    BEGIN CATCH
      IF @@TRANCOUNT > 0
        ROLLBACK TRAN;

      THROW;
    END CATCH;
    `,
    inputs: {
      USRID: { type: sql.Int, value: USRID },
      GRPIDS: { type: sql.NVarChar(10000), value: GRPIDS },
    },
  });

  return result?.recordset?.[0]?.USRID ?? null;
}

export async function delsertUserPermissions(USRID, PRMS) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    BEGIN TRAN;

    BEGIN TRY
      DELETE FROM PRMUSR
      WHERE USRID = @USRID;

      IF @PRMS IS NOT NULL AND ISJSON(@PRMS) = 1
      BEGIN
        INSERT INTO PRMUSR (USRID, APPID, PRMID)
        SELECT DISTINCT @USRID, P.APPID, P.PRMID
        FROM OPENJSON(@PRMS)
        WITH (APPID INT '$.APPID', PRMID INT '$.PRMID') AS P
        WHERE P.APPID IS NOT NULL AND P.PRMID IS NOT NULL;
      END

      COMMIT TRAN;

      SELECT @USRID AS USRID;
    END TRY
    BEGIN CATCH
      IF @@TRANCOUNT > 0
        ROLLBACK TRAN;

      THROW;
    END CATCH;
    `,
    inputs: {
      USRID: { type: sql.Int, value: USRID },
      PRMS: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(PRMS ?? []) },
    },
  });

  return result?.recordset?.[0]?.USRID ?? null;
}

export async function delsertUserSubordinates(USRID, SUBIDS) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    BEGIN TRAN;

    BEGIN TRY
      DELETE FROM USRHRC
      WHERE USRID = @USRID;

      IF @SUBIDS IS NOT NULL AND LTRIM(RTRIM(@SUBIDS)) <> ''
      BEGIN
        IF ISJSON(@SUBIDS) = 1
        BEGIN
          INSERT INTO USRHRC (USRID, SUBID)
          SELECT DISTINCT @USRID, TRY_CAST([value] AS INT)
          FROM OPENJSON(@SUBIDS)
          WHERE TRY_CAST([value] AS INT) IS NOT NULL;
        END
        ELSE
        BEGIN
          INSERT INTO USRHRC (USRID, SUBID)
          SELECT DISTINCT @USRID, TRY_CAST(value AS INT)
          FROM STRING_SPLIT(@SUBIDS, ',')
          WHERE TRY_CAST(value AS INT) IS NOT NULL;
        END
      END;

      COMMIT TRAN;

      SELECT @USRID AS USRID;
    END TRY
    BEGIN CATCH
      IF @@TRANCOUNT > 0
        ROLLBACK TRAN;

      THROW;
    END CATCH;
    `,
    inputs: {
      USRID: { type: sql.Int, value: USRID },
      SUBIDS: { type: sql.NVarChar(10000), value: SUBIDS },
    },
  });

  return result?.recordset?.[0]?.USRID ?? null;
}

/**
 * Copies mails (table USRMAILCPY, cf. sql/USRMAILCPY.table.sql) : USRID
 * reçoit aussi les mails envoyés à chacun des SRCUSRIDS. Remplace la liste
 * complète (DELETE puis INSERT). L'utilisateur lui-même est ignoré.
 */
export async function delsertUserMailCopies(USRID, SRCUSRIDS) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    BEGIN TRAN;

    BEGIN TRY
      DELETE FROM USRMAILCPY
      WHERE USRID = @USRID;

      IF @SRCUSRIDS IS NOT NULL AND ISJSON(@SRCUSRIDS) = 1
      BEGIN
        INSERT INTO USRMAILCPY (USRID, SRCUSRID)
        SELECT DISTINCT @USRID, TRY_CAST([value] AS INT)
        FROM OPENJSON(@SRCUSRIDS)
        WHERE TRY_CAST([value] AS INT) IS NOT NULL
          AND TRY_CAST([value] AS INT) <> @USRID;
      END;

      COMMIT TRAN;

      SELECT @USRID AS USRID;
    END TRY
    BEGIN CATCH
      IF @@TRANCOUNT > 0
        ROLLBACK TRAN;

      THROW;
    END CATCH;
    `,
    inputs: {
      USRID: { type: sql.Int, value: USRID },
      SRCUSRIDS: { type: sql.NVarChar(10000), value: SRCUSRIDS || null },
    },
  });

  return result?.recordset?.[0]?.USRID ?? null;
}

export async function setLastVersionDetailsOpened(USRID, VID) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    DECLARE @USRID_VAL INT = @USRID;
    DECLARE @VID_VAL INT = @VID;

    INSERT INTO dbo.USERAPPNOTIF (UID, VID)
    SELECT @USRID_VAL, @VID_VAL
    WHERE NOT EXISTS (
        SELECT 1 FROM dbo.USERAPPNOTIF n
        WHERE n.UID = @USRID_VAL AND n.VID = @VID_VAL
    );
    `,
    inputs: {
      USRID: { type: sql.Int, value: USRID },
      VID: { type: sql.Int, value: VID },
    },
  });

  return true;
}

export async function patchServicePosition(SRVCOD, POSID, USRID) {
  await runQuery({
    moduleUrl: import.meta.url,
    query: `
    UPDATE [dbo].[POSITIONS]
    SET [SRVCOD] = @SRVCOD, [UPDDAT] = SYSDATETIME(), [UPDUSR] = @USRID
    WHERE POSID = @POSID
    `,
    inputs: {
      SRVCOD: { type: sql.NVarChar(10), value: SRVCOD },
      POSID: { type: sql.Int, value: POSID },
      USRID: { type: sql.Int, value: USRID },
    },
  });

  return true;
}

/* -------------------------------------------------------------------------- */
/*                                   THÈMES                                   */
/* -------------------------------------------------------------------------- */

/**
 * Préférences de thème enregistrées pour USRID (table USRTHEME, cf.
 * sql/USRTHEME.table.sql) : une ligne par application personnalisée, plus
 * éventuellement une ligne APPID NULL (thème par défaut de l'utilisateur).
 */
export async function getUserThemes(USRID) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SELECT T.APPID, A.APPCOD, T.THEME
    FROM USRTHEME AS T
    LEFT JOIN APPLICATIONS AS A ON A.APPID = T.APPID
    WHERE T.USRID = @USRID
    `,
    inputs: { USRID: { type: sql.Int, value: USRID } },
  });

  return result.recordset;
}

/**
 * Enregistre le thème de USRID pour l'application APPCOD (ou son thème par
 * défaut si APPCOD est null). THEME null supprime la préférence (l'appli
 * repasse sur le thème par défaut). Renvoie false si APPCOD est inconnu.
 */
export async function setUserTheme(USRID, APPCOD, THEME) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    query: `
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @APPID INT = NULL;

    IF @APPCOD IS NOT NULL
    BEGIN
      SELECT @APPID = APPID FROM APPLICATIONS WHERE APPCOD = @APPCOD;

      IF @APPID IS NULL
      BEGIN
        SELECT CAST(0 AS BIT) AS DONE;
        RETURN;
      END;
    END;

    BEGIN TRAN;

    IF @THEME IS NULL
    BEGIN
      DELETE FROM USRTHEME
      WHERE USRID = @USRID
        AND ((@APPID IS NULL AND APPID IS NULL) OR APPID = @APPID);
    END
    ELSE
    BEGIN
      UPDATE T WITH (UPDLOCK, HOLDLOCK)
         SET T.THEME = @THEME,
             T.UPDDAT = GETDATE()
        FROM USRTHEME AS T
       WHERE T.USRID = @USRID
         AND ((@APPID IS NULL AND T.APPID IS NULL) OR T.APPID = @APPID);

      IF @@ROWCOUNT = 0
        INSERT INTO USRTHEME (USRID, APPID, THEME)
        VALUES (@USRID, @APPID, @THEME);
    END;

    COMMIT TRAN;

    SELECT CAST(1 AS BIT) AS DONE;
    `,
    inputs: {
      USRID: { type: sql.Int, value: USRID },
      APPCOD: { type: sql.NVarChar(20), value: APPCOD ?? null },
      THEME: { type: sql.NVarChar(10), value: THEME ?? null },
    },
  });

  return !!result?.recordset?.[0]?.DONE;
}
