import sql from "mssql";
import { runQuery } from "../../core/utils/db.utils.js";
import * as utils from "./utils.js";
import * as signingService from "../../core/services/attachmentSigning.service.js";

const SELECT_COLUMNS = `
  ID, FILECODE, APPCODE, ENTITYTYPE, ENTITYID, ORIGINALNAME, STOREDNAME,
  RELATIVEPATH, MIMETYPE, EXTENSION, COMPRESSED, ORIGINALSIZEBYTES, SIZEBYTES,
  CHECKSUMSHA256, STATUS, UPLOADEDBY, CREATEDAT, DELETEDAT
`;

export async function getFiles(META) {
  const query = META.FILECODE
    ? `SELECT ${SELECT_COLUMNS} FROM ATTACHMENTS WHERE FILECODE = @FILECODE AND DELETEDAT IS NULL`
    : META.ENTITYTYPE && META.ENTITYID
      ? `SELECT ${SELECT_COLUMNS} FROM ATTACHMENTS WHERE ENTITYTYPE = @ENTITYTYPE AND ENTITYID = @ENTITYID AND DELETEDAT IS NULL`
      : `SELECT ${SELECT_COLUMNS} FROM ATTACHMENTS WHERE DELETEDAT IS NULL`;

  console.log(query);

  const result = await runQuery({
    moduleUrl: import.meta.url,
    dbConnectionName: "attachments",
    query,
    inputs: {
      FILECODE: { type: sql.VarChar(50), value: META.FILECODE },
      ENTITYTYPE: { type: sql.VarChar(100), value: META.ENTITYTYPE },
      ENTITYID: { type: sql.VarChar(100), value: META.ENTITYID },
    },
  });

  return result.recordset;
}

export async function saveMetaAttachment(meta, ignoreIfExist) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    dbConnectionName: "attachments",
    query: `
    DECLARE @INSERTED bit = 0;

    IF @IGNOREIFEXIST = 0
    BEGIN
      INSERT INTO ATTACHMENTS (
        FILECODE, APPCODE, ENTITYTYPE, ENTITYID, ORIGINALNAME, STOREDNAME,
        RELATIVEPATH, MIMETYPE, EXTENSION, COMPRESSED, ORIGINALSIZEBYTES,
        SIZEBYTES, CHECKSUMSHA256, UPLOADEDBY, CREATEDAT
      )
      VALUES (
        @FILECODE, @APPCODE, @ENTITYTYPE, @ENTITYID, @ORIGINALNAME, @STOREDNAME,
        @RELATIVEPATH, @MIMETYPE, @EXTENSION, @COMPRESSED, @ORIGINALSIZEBYTES,
        @SIZEBYTES, @CHECKSUMSHA256, @UPLOADEDBY, SYSDATETIME()
      );

      SET @INSERTED = 1;
    END
    ELSE
    BEGIN
      INSERT INTO ATTACHMENTS (
        FILECODE, APPCODE, ENTITYTYPE, ENTITYID, ORIGINALNAME, STOREDNAME,
        RELATIVEPATH, MIMETYPE, EXTENSION, COMPRESSED, ORIGINALSIZEBYTES,
        SIZEBYTES, CHECKSUMSHA256, UPLOADEDBY, CREATEDAT
      )
      SELECT
        @FILECODE, @APPCODE, @ENTITYTYPE, @ENTITYID, @ORIGINALNAME, @STOREDNAME,
        @RELATIVEPATH, @MIMETYPE, @EXTENSION, @COMPRESSED, @ORIGINALSIZEBYTES,
        @SIZEBYTES, @CHECKSUMSHA256, @UPLOADEDBY, SYSDATETIME()
      WHERE NOT EXISTS (
        SELECT 1 FROM ATTACHMENTS WITH (UPDLOCK, HOLDLOCK)
        WHERE APPCODE = @APPCODE AND ENTITYTYPE = @ENTITYTYPE AND ENTITYID = @ENTITYID
          AND CHECKSUMSHA256 = @CHECKSUMSHA256 AND DELETEDAT IS NULL
      );

      SET @INSERTED = CASE WHEN @@ROWCOUNT = 1 THEN 1 ELSE 0 END;
    END;

    SELECT @INSERTED AS INSERTED;
    `,
    inputs: {
      IGNOREIFEXIST: { type: sql.Bit, value: Boolean(ignoreIfExist) },
      FILECODE: { type: sql.VarChar(50), value: meta.FILECODE },
      APPCODE: { type: sql.VarChar(50), value: meta.APPCODE },
      ENTITYTYPE: { type: sql.VarChar(100), value: meta.ENTITYTYPE },
      ENTITYID: { type: sql.VarChar(100), value: meta.ENTITYID },
      ORIGINALNAME: { type: sql.NVarChar(255), value: meta.ORIGINALNAME },
      STOREDNAME: { type: sql.VarChar(255), value: meta.STOREDNAME },
      RELATIVEPATH: { type: sql.NVarChar(500), value: meta.RELATIVEPATH },
      MIMETYPE: { type: sql.VarChar(150), value: meta.MIMETYPE },
      EXTENSION: { type: sql.VarChar(20), value: meta.EXTENSION },
      COMPRESSED: { type: sql.Bit, value: meta.COMPRESSED },
      ORIGINALSIZEBYTES: { type: sql.BigInt, value: meta.ORIGINALSIZEBYTES },
      SIZEBYTES: { type: sql.BigInt, value: meta.SIZEBYTES },
      CHECKSUMSHA256: { type: sql.VarChar(64), value: meta.CHECKSUMSHA256 },
      UPLOADEDBY: { type: sql.VarChar(100), value: meta.UPLOADEDBY },
    },
  });

  return Boolean(result.recordset?.[0]?.INSERTED);
}

export async function markReadyAttachment(FILECODE) {
  await runQuery({
    moduleUrl: import.meta.url,
    dbConnectionName: "attachments",
    query: `UPDATE ATTACHMENTS SET STATUS = 'READY' WHERE FILECODE = @FILECODE`,
    inputs: { FILECODE: { type: sql.VarChar(50), value: FILECODE } },
  });

  return true;
}

/**
 * Retourne l'ENTITYTYPE/ENTITYID du fichier supprimé (plutôt qu'un simple
 * booléen) — nécessaire au controller pour diffuser un évènement WS ciblé
 * (cf. `ticket.attachment.deleted`) quand ENTITYTYPE vaut "TCKCOD" : cette
 * info n'est disponible qu'ici, la ligne étant supprimée (DELETEDAT) juste
 * après.
 */
export async function deleteFileByCode(fileCode) {
  const files = await utils.formatFiles(await getFiles({ FILECODE: fileCode }));
  if (!files[0]) return null;

  await runQuery({
    moduleUrl: import.meta.url,
    dbConnectionName: "attachments",
    query: `UPDATE ATTACHMENTS SET DELETEDAT = SYSDATETIME() WHERE FILECODE = @FILECODE AND DELETEDAT IS NULL`,
    inputs: { FILECODE: { type: sql.VarChar(50), value: fileCode } },
  });

  return { ENTITYTYPE: files[0].ENTITYTYPE, ENTITYID: files[0].ENTITYID };
}

export async function deleteFileByEntity(entityName, entityId) {
  const files = await utils.formatFiles(
    await getFiles({ ENTITYTYPE: entityName, ENTITYID: entityId }),
  );
  if (!files[0]) return false;

  await runQuery({
    moduleUrl: import.meta.url,
    dbConnectionName: "attachments",
    query: `UPDATE ATTACHMENTS SET DELETEDAT = SYSDATETIME() WHERE ENTITYTYPE = @ENTITYTYPE AND ENTITYID = @ENTITYID AND DELETEDAT IS NULL`,
    inputs: {
      ENTITYTYPE: { type: sql.VarChar(100), value: entityName },
      ENTITYID: { type: sql.VarChar(100), value: entityId },
    },
  });

  return true;
}

/**
 * CAVEID propriétaire du dossier NUMDOS (ou `null`), pour autoriser une
 * cave (token DCLING) à ne signer que les PJ "du dossier" (ENTITYTYPE
 * "NUMDOS") de SON PROPRE dossier — cf. controllers.assertCaveOwnsAttachment.
 * Requête directe sur la base "declcav" plutôt qu'un import du module
 * declcav : les modules restent volontairement indépendants (cf.
 * notifyTicketAttachmentChange dans controllers.js, qui connaît déjà
 * l'ENTITYTYPE "TCKCOD" du module ticketing sans l'importer).
 */
export async function getFolderCaveId(numdos) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    dbConnectionName: "declcav",
    query: `SELECT CAVEID FROM V_DECFOLDERS WHERE NUMDOS = @NUMDOS`,
    inputs: {
      NUMDOS: { type: sql.NVarChar(30), value: numdos },
    },
  });

  return result.recordset?.[0]?.CAVEID ?? null;
}

/**
 * Signe numériquement une pièce jointe (HMAC-SHA256, cf.
 * core/services/attachmentSigning.service.js) : calcule la signature sur
 * ATTACHMENTS.CHECKSUMSHA256 au moment de l'appel et l'enregistre dans
 * ATTACHMENTSIGNATURES. Un même signataire ne peut pas signer deux fois la
 * même PJ tant que sa précédente signature est VALID (cf.
 * UQ_ATTACHMENTSIGNATURES_FILEID_SIGNEDBY_VALID) — l'appel échoue alors
 * avec un 409 plutôt que de dupliquer silencieusement la signature.
 */
export async function signAttachment(fileCode, signedBy) {
  const [attachment] = await utils.formatFiles(
    await getFiles({ FILECODE: fileCode }),
  );

  if (!attachment || attachment.DELETEDAT) {
    const err = new Error("Pièce jointe introuvable.");
    err.status = 404;
    throw err;
  }

  console.log(attachment);

  const keyVersion = signingService.getCurrentKeyVersion();
  const signatureValue = signingService.computeSignature(
    attachment.CHECKSUMSHA256,
    keyVersion,
  );

  try {
    const result = await runQuery({
      moduleUrl: import.meta.url,
      dbConnectionName: "attachments",
      query: `
        INSERT INTO ATTACHMENTSIGNATURES (FILEID, ALGORITHM, KEYVERSION, SIGNATUREVALUE, SIGNEDHASH, SIGNEDBY)
        OUTPUT INSERTED.SIGID, INSERTED.SIGNEDAT
        VALUES (@FILEID, 'HMAC-SHA256', @KEYVERSION, @SIGNATUREVALUE, @SIGNEDHASH, @SIGNEDBY);
      `,
      inputs: {
        FILEID: { type: sql.Int, value: attachment.ID },
        KEYVERSION: { type: sql.VarChar(50), value: keyVersion },
        SIGNATUREVALUE: { type: sql.VarBinary(64), value: signatureValue },
        SIGNEDHASH: { type: sql.VarChar(64), value: attachment.CHECKSUMSHA256 },
        SIGNEDBY: { type: sql.VarChar(100), value: signedBy },
      },
    });

    const inserted = result.recordset?.[0];

    return {
      SIGID: inserted?.SIGID,
      FILECODE: fileCode,
      ALGORITHM: "HMAC-SHA256",
      KEYVERSION: keyVersion,
      SIGNEDHASH: attachment.CHECKSUMSHA256,
      SIGNEDBY: signedBy,
      SIGNEDAT: inserted?.SIGNEDAT,
      STATUS: "VALID",
    };
  } catch (err) {
    // Violation de l'index unique filtré UQ_ATTACHMENTSIGNATURES_FILEID_SIGNEDBY_VALID
    // (2601/2627, SQL Server) : ce signataire a déjà une signature VALID sur cette PJ.
    if (err.number === 2601 || err.number === 2627) {
      const dupErr = new Error(
        "Cette pièce jointe est déjà signée par ce signataire.",
      );
      dupErr.status = 409;
      throw dupErr;
    }
    throw err;
  }
}

/**
 * Liste les signatures (VALID + REVOKED, les plus récentes d'abord) d'une
 * pièce jointe désignée par son FILECODE.
 */
/**
 * Récupère une signature par SIGID avec le FILECODE de la PJ associée —
 * utilisé par le contrôleur pour vérifier qui a le droit de la révoquer
 * (signataire d'origine ou profil gestionnaire, cf. controllers.js) avant
 * d'appeler revokeSignature.
 */
export async function getSignatureById(sigId) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    dbConnectionName: "attachments",
    query: `
      SELECT s.SIGID, s.FILEID, s.ALGORITHM, s.KEYVERSION, s.SIGNEDHASH, s.SIGNEDBY,
             s.SIGNEDAT, s.STATUS, s.REVOKEDAT, s.REVOKEDBY, s.REVOKEREASON,
             a.FILECODE
      FROM ATTACHMENTSIGNATURES s
      INNER JOIN ATTACHMENTS a ON a.ID = s.FILEID
      WHERE s.SIGID = @SIGID
    `,
    inputs: { SIGID: { type: sql.Int, value: sigId } },
  });

  return result.recordset?.[0] || null;
}

export async function getSignatures(fileCode) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    dbConnectionName: "attachments",
    query: `
      SELECT s.SIGID, s.FILEID, s.ALGORITHM, s.KEYVERSION, s.SIGNEDHASH, s.SIGNEDBY,
             s.SIGNEDAT, s.STATUS, s.REVOKEDAT, s.REVOKEDBY, s.REVOKEREASON
      FROM ATTACHMENTSIGNATURES s
      INNER JOIN ATTACHMENTS a ON a.ID = s.FILEID
      WHERE a.FILECODE = @FILECODE
      ORDER BY s.SIGNEDAT DESC
    `,
    inputs: { FILECODE: { type: sql.VarChar(50), value: fileCode } },
  });

  return result.recordset;
}

/**
 * Vérifie une signature : validité cryptographique (le HMAC recalculé
 * correspond bien à SIGNATUREVALUE, avec le secret de KEYVERSION) ET
 * absence d'altération du fichier depuis la signature (SIGNEDHASH ==
 * ATTACHMENTS.CHECKSUMSHA256 actuel). `valid` combine les deux avec le
 * STATUS courant (une signature REVOKED n'est plus `valid`, même si sa
 * preuve cryptographique reste intacte).
 */
export async function verifySignature(sigId) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    dbConnectionName: "attachments",
    query: `
      SELECT s.SIGID, s.KEYVERSION, s.SIGNATUREVALUE, s.SIGNEDHASH, s.STATUS, a.CHECKSUMSHA256 AS CURRENTHASH
      FROM ATTACHMENTSIGNATURES s
      INNER JOIN ATTACHMENTS a ON a.ID = s.FILEID
      WHERE s.SIGID = @SIGID
    `,
    inputs: { SIGID: { type: sql.Int, value: sigId } },
  });

  const row = result.recordset?.[0];

  if (!row) {
    const err = new Error("Signature introuvable.");
    err.status = 404;
    throw err;
  }

  const cryptographicallyValid = signingService.verifySignatureValue(
    row.SIGNEDHASH,
    row.KEYVERSION,
    row.SIGNATUREVALUE,
  );
  const fileUnchanged = row.CURRENTHASH === row.SIGNEDHASH;

  return {
    SIGID: row.SIGID,
    STATUS: row.STATUS,
    cryptographicallyValid,
    fileUnchanged,
    valid: cryptographicallyValid && fileUnchanged && row.STATUS === "VALID",
  };
}

/**
 * Révoque une signature VALID (ne la supprime jamais physiquement — cf.
 * CK_ATTACHMENTSIGNATURES_REVOKE_CONSISTENCY). Retourne `false` si la
 * signature n'existe pas ou est déjà REVOKED (idempotent côté appelant).
 */
export async function revokeSignature(sigId, revokedBy, reason = null) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    dbConnectionName: "attachments",
    query: `
      UPDATE ATTACHMENTSIGNATURES
      SET STATUS = 'REVOKED', REVOKEDAT = SYSUTCDATETIME(), REVOKEDBY = @REVOKEDBY, REVOKEREASON = @REVOKEREASON
      OUTPUT INSERTED.SIGID
      WHERE SIGID = @SIGID AND STATUS = 'VALID';
    `,
    inputs: {
      SIGID: { type: sql.Int, value: sigId },
      REVOKEDBY: { type: sql.VarChar(100), value: revokedBy },
      REVOKEREASON: { type: sql.NVarChar(255), value: reason },
    },
  });

  return Boolean(result.recordset?.[0]);
}

/**
 * Pièces jointes supprimées logiquement (DELETEDAT) depuis plus de
 * `retentionMonths` mois et dont le fichier physique n'a pas encore été
 * purgé (STATUS <> 'PURGED'). Pagination par clé (ID > @AFTERID) plutôt
 * qu'OFFSET : une ligne en échec (fichier verrouillé…) n'est pas re-lue
 * dans le même passage, ce qui évite toute boucle infinie côté appelant.
 */
export async function getAttachmentsToPurge({
  retentionMonths,
  afterId = 0,
  batchSize = 500,
}) {
  const result = await runQuery({
    moduleUrl: import.meta.url,
    dbConnectionName: "attachments",
    query: `
      SELECT TOP (@BATCHSIZE) ID, FILECODE, RELATIVEPATH, SIZEBYTES, DELETEDAT
      FROM ATTACHMENTS
      WHERE DELETEDAT IS NOT NULL
        AND DELETEDAT < DATEADD(MONTH, -@RETENTIONMONTHS, SYSDATETIME())
        AND (STATUS IS NULL OR STATUS <> 'PURGED')
        AND ID > @AFTERID
      ORDER BY ID
    `,
    inputs: {
      BATCHSIZE: { type: sql.Int, value: batchSize },
      RETENTIONMONTHS: { type: sql.Int, value: retentionMonths },
      AFTERID: { type: sql.Int, value: afterId },
    },
  });

  return result.recordset ?? [];
}

/**
 * Marque une PJ comme purgée (fichier physique supprimé). La ligne est
 * conservée : les signatures (FK_ATTACHMENTSIGNATURES_ATTACHMENTS) et la
 * trace d'audit doivent survivre au fichier.
 */
export async function markPurgedAttachment(id) {
  await runQuery({
    moduleUrl: import.meta.url,
    dbConnectionName: "attachments",
    query: `UPDATE ATTACHMENTS SET STATUS = 'PURGED' WHERE ID = @ID AND DELETEDAT IS NOT NULL`,
    inputs: { ID: { type: sql.Int, value: id } },
  });

  return true;
}
