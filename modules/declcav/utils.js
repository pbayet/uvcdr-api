import { utcToParisIso } from "../../core/utils/dates.utils.js";

/* ═══════════════════════════════════════════════════════════════
   DECLCAV — Formatage
   Port quasi identique de V1.0.0 : cette couche n'accédait déjà à aucune
   ressource sensible (pas de console.log, pas de logique métier dépendant
   de l'utilisateur courant) et suit la même logique d'agrégation par clé
   (Map + Set de déduplication) que modules/ticketing/utils.js.
═══════════════════════════════════════════════════════════════ */

// rows = résultat d'une requête qui peut contenir plusieurs lignes pour la même CAVEID
// (ex: 1 ligne par mail). Retourne une liste d'objets "Cave".
export function formatCaves(rows = []) {
  const cavesById = new Map(); // CAVEID -> cave
  const mailsSeenByCave = new Map(); // CAVEID -> Set(mailKey)

  for (const row of rows) {
    const caveId = Number(row?.CAVEID ?? 0);
    if (!caveId) continue;

    let cave = cavesById.get(caveId);
    if (!cave) {
      cave = {
        CAVEID: caveId,
        SIRET: row?.SIRET ?? "",
        CAVENOM: row?.CAVENOM ?? "",
        TYPE: {
          ID: row.TYPID,
          CODE: row.TYPCOD,
          LIBEL: row.TYPLIB,
          REMARK: row.TYPREMARK,
          ACTIF: row.ACTIF,
        },
        ACCIID: row?.ACCIID ?? "",
        CODACCI: row?.CODACCI ?? "",
        CDFRX3: row?.CDFRX3 ?? "",
        TRCVALDTEEND: row?.TRCVALDTEEND,
        NBDOS: Number(row?.NB_DOS ?? 0) || 0,
        MAILS: [],
        LSTDATQST: utcToParisIso(row.LSTDATQST ?? null),
      };

      cavesById.set(caveId, cave);
      mailsSeenByCave.set(caveId, new Set());
    } else {
      const nbDos = Number(row?.NB_DOS ?? 0) || 0;
      if (nbDos > (cave.CAVE_NB_DOS || 0)) cave.CAVE_NB_DOS = nbDos;
    }

    // Selon la vue, l'adresse peut être MAILADR (comme V_CAVES) ou MAIL.
    const mailId = Number(row?.MAILID ?? 0) || 0;
    const mail = (row?.MAIL ?? row?.MAILADR ?? "").toString().trim();

    if (!mailId && !mail) continue;

    const primail = row?.PRIMAIL == null ? false : Boolean(row.PRIMAIL);
    const actif = row?.ACTIF == null ? false : Boolean(row.ACTIF);

    const mailKey = mailId ? `ID:${mailId}` : `MAIL:${mail.toLowerCase()}`;
    const seen = mailsSeenByCave.get(caveId);

    if (seen && !seen.has(mailKey)) {
      seen.add(mailKey);

      cave.MAILS.push({
        MAILID: mailId,
        MAIL: mail,
        PRIMAIL: primail,
        ACTIF: actif,
      });
    }
  }

  return Array.from(cavesById.values());
}

export function formatResponses(rows = []) {
  const submitsById = new Map();

  for (const row of rows) {
    const subId = Number(row?.SUBID ?? 0);
    if (!subId) continue;

    let submit = submitsById.get(subId);

    if (!submit) {
      submit = {
        SUBID: subId,
        REFEXT: row?.REFEXT ?? "",
        SUBDAT: row?.SUBDAT ? new Date(row.SUBDAT) : null,
        STATUS: row?.STATUS ?? "",
        QuestionAnswers: [],
        _answersById: new Map(),
      };

      submitsById.set(subId, submit);
    }

    const aswrId = Number(row?.ASWRID ?? 0);
    if (!aswrId) continue;

    let answer = submit._answersById.get(aswrId);

    if (!answer) {
      answer = {
        ASWRID: aswrId,
        SUBID: subId,
        QSTCOD: row?.QSTCOD ?? "",
        PRTQSTCOD: row?.PRTQSTCOD ?? "",
        ROWCOD: row?.ROWCOD ?? "",
        ASWRTYP: row?.ASWRTYP ?? "",
        VALTXT: row?.VALTXT ?? "",
        VALBIT: row?.VALBIT == null ? false : Boolean(row.VALBIT),
        VALNUM: Number(row?.VALNUM ?? 0) || 0,
        VALDAT: row?.VALDAT ? new Date(row.VALDAT) : null,
        VALJSON: row?.VALJSON ?? "",
        CREDAT: row?.CREDAT ? new Date(row.CREDAT) : null,
        ATTACHMENTS: [],
        _attachmentsById: new Map(),
      };

      submit._answersById.set(aswrId, answer);
      submit.QuestionAnswers.push(answer);
    }

    const attId = Number(row?.ATTID ?? 0);
    if (!attId || answer._attachmentsById.has(attId)) continue;
    // PJ supprimée (soft-delete) : ne doit plus être renvoyée
    if (row?.ATTDELETEDAT != null) continue;

    const attachment = {
      ID: attId,
      FILECODE: row?.ATTFILECODE ?? "",
      APPCODE: row?.ATTAPPCODE ?? "",
      ENTITYTYPE: row?.ATTENTITYTYPE ?? "",
      ENTITYID: row?.ATTENTITYID ?? "",
      ORIGINALNAME: row?.ATTORIGINALNAME ?? "",
      STOREDNAME: row?.ATTSTOREDNAME ?? "",
      RELATIVEPATH: row?.ATTRELATIVEPATH ?? "",
      MIMETYPE: row?.ATTMIMETYPE ?? "",
      EXTENSION: row?.ATTEXTENSION ?? "",
      COMPRESSED:
        row?.ATTCOMPRESSED == null ? false : Boolean(row.ATTCOMPRESSED),
      ORIGINALSIZEBYTES: Number(row?.ATTORIGINALSIZEBYTES ?? 0) || 0,
      SIZEBYTES: Number(row?.ATTSIZEBYTES ?? 0) || 0,
      CHECKSUMSHA256: row?.ATTCHECKSUMSHA256 ?? "",
      STATUS: row?.ATTSTATUS ?? "",
      UPLOADEDBY: row?.ATTUPLOADEDBY ?? "",
      CREATEDAT: row?.ATTCREATEDAT ? new Date(row.ATTCREATEDAT) : null,
      DELETEDAT: row?.ATTDELETEDAT ? new Date(row.ATTDELETEDAT) : null,
    };

    answer._attachmentsById.set(attId, attachment);
    answer.ATTACHMENTS.push(attachment);
  }

  return Array.from(submitsById.values()).map((submit) => {
    delete submit._answersById;

    for (const answer of submit.QuestionAnswers) {
      delete answer._attachmentsById;
    }

    return submit;
  });
}

// Intègre l'agrégation des MAILS (formatCaves) directement dans formatFolders
export function formatFolders(rows = []) {
  const dossiersMap = new Map();

  for (const row of rows) {
    const numdos = row?.NUMDOS ?? "";
    if (!numdos) continue;

    if (!dossiersMap.has(numdos)) {
      dossiersMap.set(numdos, {
        ent: {
          ENTID: row.ENTID ?? 0,
          NUMDOS: row.NUMDOS ?? "",
          VRSDEC: row.VRSDEC ?? 0,
          MAXVRSDEC: row.MAXVRSDEC ?? 0,
          TYPCOD: row.TYPCOD ?? "",
          TYPNAM: row.TYPNAM ?? "",
          STAT: row.STAT ?? "",
          STATNAM: row.STATNAM ?? "",
          ISREL: row.ISREL ?? 0,
          REFMAR: row.REFMAR ?? "",
          REFINTR: row.REFINTR ?? "",
          DATMRC: utcToParisIso(row.DATMRC ?? null),
          DEBMRV: utcToParisIso(row.DEBMRV ?? null),
          FINMRV: utcToParisIso(row.FINMRV ?? null),
          REM_ENT: row.REM_ENT ?? "",
          CODFOUR: row.CODFOUR ?? "",
          NOMFOUR: row.NOMFOUR ?? "",
          REFVRAC: row.REFVRAC ?? "",
          DESA1: row.DESA1 ?? "",
          DESA2: row.DESA2 ?? "",
          APPL: row.APPL ?? "",
          COUL: row.COUL ?? "",
          QTEMRV: row.QTEMRV ?? 0,
          TYPO: row.TYPO ?? "",
          SPECTYPO: row.SPECTYPO ?? "",
          QAL: row.QAL ?? 0,
          VALID: row.VALID ?? 0,
          MLOPER: row.MLOPER ?? "",
          DERREL: row.DERREL ?? null,
          CANREL: row.CANREL ?? false,
          DERRELQST: row.DERRELQST ?? null,
          CANRELQST: row.CANRELQST ?? false,
          VALDAT: utcToParisIso(row.VALDAT ?? null),
          VALDDATE: utcToParisIso(row.VALDDATE ?? null),
          DECLQST: row.DECLQST ?? false,
          DECLQSTSTA: row.DECLQSTSTA ?? null,
          DATQST: utcToParisIso(row.DATQST ?? null),
          VALDATQST: utcToParisIso(row.VALDATQST ?? null),
          ENT_CREDAT: utcToParisIso(row.ENT_CREDAT ?? null),
          ENT_CREUSR: row.ENT_CREUSR ?? "",
          ENT_UPDDAT: utcToParisIso(row.ENT_UPDDAT ?? null),
          ENT_UPDUSR: row.ENT_UPDUSR ?? "",
          IS_DEL: row.IS_DEL ?? false,
          PJS: [],
        },
        cave: {
          CAVEID: row.CAVEID ?? 0,
          SIRET: row.SIRET ?? "",
          CAVENOM: row.CAVENOM ?? "",
          ACCIID: row.ACCIID ?? "",
          CODACCI: row.CODACCI ?? "",
          CDFRX3: row.CDFRX3 ?? "",
          CAVE_NB_DOS: row.CAVE_NB_DOS ?? 0,
          TYPE: {
            CODE: row.TYPCODE ?? "",
            LIBEL: row.TYPLIB ?? "",
          },
          MAILS: [],
          LSTDATQST: utcToParisIso(row.LSTDATQST ?? null),
          _mailKeys: new Set(),
        },
        ingres: [],
        _ingreKeys: new Set(),
        _pjKeys: new Set(),
      });
    }

    const dossier = dossiersMap.get(numdos);

    // --- Cave : agrégation MAILS ---
    {
      const mailId = Number(row?.MAILID ?? 0) || 0;
      const mail = (row?.MAIL ?? row?.MAILADR ?? "").toString().trim();

      if (mailId || mail) {
        const primail = row?.PRIMAIL == null ? false : Boolean(row.PRIMAIL);
        const actif =
          row?.MAILACTIF == null ? Boolean(row.ACTIF) : Boolean(row.MAILACTIF);
        const mailKey = mailId ? `ID:${mailId}` : `MAIL:${mail.toLowerCase()}`;

        if (!dossier.cave._mailKeys.has(mailKey)) {
          dossier.cave._mailKeys.add(mailKey);
          dossier.cave.MAILS.push({
            MAILID: mailId,
            MAIL: mail,
            PRIMAIL: primail,
            ACTIF: actif,
          });
        }
      }
    }

    // --- ENT : agrégation PJS ---
    {
      const attId = Number(row?.ATT_ID ?? 0) || 0;
      const attStoredName = (row?.ATT_STOREDNAME ?? "").toString().trim();

      // PJ supprimée (soft-delete) : ne doit plus être renvoyée
      if ((attId || attStoredName) && row?.ATT_DELETEDAT == null) {
        const pjKey = attId
          ? `ID:${attId}`
          : `NAME:${attStoredName.toLowerCase()}`;

        if (!dossier._pjKeys.has(pjKey)) {
          dossier._pjKeys.add(pjKey);

          dossier.ent.PJS.push({
            ID: attId,
            FILECODE: (row.ATT_FILECODE ?? "").toString(),
            APPCODE: (row.ATT_APPCODE ?? "").toString(),
            ENTITYTYPE: row.ATT_ENTITYTYPE ?? undefined,
            ENTITYID: row.ATT_ENTITYID ?? undefined,
            ORIGINALNAME: (row.ATT_ORIGINALNAME ?? "").toString(),
            STOREDNAME: attStoredName,
            RELATIVEPATH: (row.ATT_RELATIVEPATH ?? "").toString(),
            MIMETYPE: (row.ATT_MIMETYPE ?? "").toString(),
            EXTENSION: (row.ATT_EXTENSION ?? "").toString(),
            COMPRESSED: Boolean(row.ATT_COMPRESSED),
            ORIGINALSIZEBYTES: Number(row.ATT_ORIGINALSIZEBYTES ?? 0),
            SIZEBYTES: Number(row.ATT_SIZEBYTES ?? 0),
            STATUS: (row.ATT_STATUS ?? "").toString(),
            UPLOADEDBY: row.ATT_UPLOADEDBY ?? undefined,
            CREATEDAT: utcToParisIso(row.ATT_CREATEDAT ?? null),
            DELETEDAT:
              row.ATT_DELETEDAT != null
                ? utcToParisIso(row.ATT_DELETEDAT)
                : undefined,
          });
        }
      }
    }

    // --- Ingrédient (ITEM*) ---
    const itemTyp = row.ITEMTYP ?? "";
    const itemCode = row.ITEMCODE ?? "";
    if (itemTyp || itemCode) {
      const key = `${itemTyp}|${itemCode}`;
      if (!dossier._ingreKeys.has(key)) {
        dossier._ingreKeys.add(key);
        dossier.ingres.push({
          TYP: itemTyp,
          CODE: itemCode,
          LIBEL: row.ITEMLIB ?? "",
          CATID: row.CATID ?? 0,
          CATEGORY: row.CATEGORY ?? "",
          POURC: row.POURC ?? 0,
          AVISUV1: row.AVISUV1 ?? "",
          AVISUV2: row.AVISUV2 ?? "",
          ACTIF: Boolean(row.ITEMACT),
          REMARK: row.ITEMREM ?? "",
          IS_CEP: Boolean(row.IS_CEP),
        });
      }
    }
  }

  return Array.from(dossiersMap.values()).map((d) => {
    const { cave, ...entDto } = d;
    const { ...caveDto } = cave;
    return { ...entDto, cave: caveDto };
  });
}

// rows = résultat de: SELECT ... FROM dbo.V_INGREDIENTS
export function formatIngredients(rows = []) {
  const out = [];
  const seen = new Set(); // dédoublonnage (ITEMTYP|CODE)

  for (const row of rows) {
    const typ = row?.ITEMTYP ?? "";
    const code = row?.CODE ?? "";

    if (!typ && !code) continue;

    const key = `${typ}|${code}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      TYP: typ,
      CODE: code,
      LIBEL: row?.LIBEL ?? "",
      CATID: row?.CATID ?? 0,
      CATEGORY: row?.CATEGORY ?? "",
      POURC: 0, // pas dans V_INGREDIENTS
      AVISUV1: row?.AVISUV1 ?? "",
      AVISUV2: row?.AVISUV2 ?? "",
      ACTIF: row?.ACTIF == null ? true : Boolean(row.ACTIF),
      REMARK: row?.REMARQ ?? "",
      IS_CEP: typ === "CEP", // pas dans V_INGREDIENTS
    });
  }

  return out;
}

/**
 * Agrège V_DECFOLDERS_LATEST (déjà filtrée sur DECLQST/DECLQSTSTA par
 * services.getQuestRelaunchData) par cave, dans le même format que
 * formatRelaunchData ({ CAVEID, MAILS, NUMDOSS }) : une entrée par cave
 * concernée, ses emails actifs dédoublonnés et la liste des NUMDOS dont le
 * questionnaire est en attente. Pas de filtre CANREL ici (déjà géré côté
 * SQL) — contrairement à formatRelaunchData qui filtre sur CANREL.
 */
export function formatQuestRelaunchData(rows = []) {
  const out = [];
  const byCave = new Map(); // CAVEID -> objet final
  const mailsSeen = new Map(); // CAVEID -> Set(mail)
  const dosSeen = new Map(); // CAVEID -> Set(numdos)

  for (const row of rows) {
    const caveId = row?.CAVEID ?? null;
    if (caveId == null) continue;

    if (!byCave.has(caveId)) {
      byCave.set(caveId, { CAVEID: caveId, MAILS: [], NUMDOSS: [] });
      mailsSeen.set(caveId, new Set());
      dosSeen.set(caveId, new Set());
    }

    const current = byCave.get(caveId);
    const mSet = mailsSeen.get(caveId);
    const dSet = dosSeen.get(caveId);

    // Mail : mêmes alias possibles (MAIL ou MAILADR) et même résolution du
    // flag actif que formatFolders (MAILACTIF si présent, sinon ACTIF).
    const mail = (row?.MAIL ?? row?.MAILADR ?? "").toString().trim();
    const actif =
      row?.MAILACTIF == null
        ? Boolean(row?.ACTIF ?? true)
        : Boolean(row.MAILACTIF);

    if (mail && actif && !mSet.has(mail)) {
      mSet.add(mail);
      current.MAILS.push(mail);
    }

    const numdos = (row?.NUMDOS ?? "").toString().trim();
    if (numdos && !dSet.has(numdos)) {
      dSet.add(numdos);
      current.NUMDOSS.push(numdos);
    }
  }

  for (const v of byCave.values()) out.push(v);
  return out;
}

export function formatRelaunchData(rows = []) {
  const out = [];
  const byCave = new Map(); // CaveID -> objet final
  const mailsSeen = new Map(); // CaveID -> Set(mail)
  const dosSeen = new Map(); // CaveID -> Set(numdos)

  for (const row of rows) {
    const caveId = row?.CaveID ?? row?.CAVEID ?? null;
    if (caveId == null) continue;

    if (!byCave.has(caveId)) {
      byCave.set(caveId, { CAVEID: caveId, MAILS: [], NUMDOSS: [] });
      mailsSeen.set(caveId, new Set());
      dosSeen.set(caveId, new Set());
    }

    const current = byCave.get(caveId);
    const mSet = mailsSeen.get(caveId);
    const dSet = dosSeen.get(caveId);

    // Mail : on ne garde que les actifs si le champ existe
    const mail = (row?.MAILADR ?? row?.MAIL ?? "").toString().trim();
    const actif = row?.ACTIF == null ? true : Boolean(row.ACTIF);

    if (mail && actif && !mSet.has(mail)) {
      mSet.add(mail);
      current.MAILS.push(mail);
    }

    // Dossier : CANREL=1 si le champ existe
    const numdos = (row?.NUMDOS ?? row?.NUMDOSS ?? "").toString().trim();
    const canrel = row?.CANREL == null ? true : Number(row.CANREL) === 1;

    if (numdos && canrel && !dSet.has(numdos)) {
      dSet.add(numdos);
      current.NUMDOSS.push(numdos);
    }
  }

  for (const v of byCave.values()) out.push(v);
  return out;
}
