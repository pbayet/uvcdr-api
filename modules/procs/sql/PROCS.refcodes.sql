/* ═══════════════════════════════════════════════════════════════
   PROCS — Références générées : rattrapage des fiches existantes

   Depuis que la référence est générée par l'API à la création
   (PROC-QUA-001 : 3 lettres de la catégorie racine + numéro par préfixe,
   cf. utils.refcodePrefix et services.createProcedure), ce script attribue
   une référence aux fiches qui n'en ont pas, dans l'ordre de création.

   - Les références déjà saisies sont conservées telles quelles.
   - Les numéros suivent les références existantes de même préfixe
     (fiches supprimées comprises : un numéro n'est jamais réattribué).
   - Préfixe : nom de la catégorie racine sans accents, lettres A-Z seules,
     3 premières (« Qualité » → PROC-QUA-, « Ressources humaines » →
     PROC-RES-) ; sans catégorie : PROC-GEN-.

   Script idempotent : relancé, il ne trouve plus de fiche sans référence.
   À exécuter une fois, après le déploiement de l'API.
═══════════════════════════════════════════════════════════════ */

USE [PROCS];
GO

SET XACT_ABORT ON;
BEGIN TRANSACTION;

DECLARE @PRCID INT, @ROOTNAME NVARCHAR(150);

DECLARE fiches CURSOR LOCAL FAST_FORWARD FOR
    SELECT p.PRCID, COALESCE(gpc.NAME, pc.NAME, c.NAME)
    FROM dbo.PROCEDURES AS p
    LEFT JOIN dbo.PROCCATEGORIES AS c ON c.CATID = p.CATID
    LEFT JOIN dbo.PROCCATEGORIES AS pc ON pc.CATID = c.PARENTID
    LEFT JOIN dbo.PROCCATEGORIES AS gpc ON gpc.CATID = pc.PARENTID
    WHERE p.REFCODE IS NULL OR LTRIM(RTRIM(p.REFCODE)) = N''
    ORDER BY p.CREDAT, p.PRCID;

OPEN fiches;
FETCH NEXT FROM fiches INTO @PRCID, @ROOTNAME;

WHILE @@FETCH_STATUS = 0
BEGIN
    -- Accents retirés (collation insensible aux accents), majuscules, lettres A-Z seules.
    DECLARE @ASCII VARCHAR(150) = UPPER(CAST(ISNULL(@ROOTNAME, N'') COLLATE SQL_Latin1_General_CP1253_CI_AI AS VARCHAR(150)));
    DECLARE @LETTERS VARCHAR(3) = '', @I INT = 1;
    WHILE @I <= LEN(@ASCII) AND LEN(@LETTERS) < 3
    BEGIN
        IF SUBSTRING(@ASCII, @I, 1) LIKE '[A-Z]' COLLATE Latin1_General_BIN
            SET @LETTERS = @LETTERS + SUBSTRING(@ASCII, @I, 1);
        SET @I = @I + 1;
    END;

    DECLARE @PREFIX NVARCHAR(20) = N'PROC-' + CASE WHEN @LETTERS = '' THEN 'GEN' ELSE @LETTERS END + N'-';

    DECLARE @NUM INT = 1 + ISNULL((
        SELECT MAX(CAST(SUBSTRING(REFCODE, LEN(@PREFIX) + 1, 10) AS INT))
        FROM dbo.PROCEDURES WITH (UPDLOCK, HOLDLOCK)
        WHERE LEFT(REFCODE, LEN(@PREFIX)) = @PREFIX
          AND LEN(REFCODE) BETWEEN LEN(@PREFIX) + 1 AND LEN(@PREFIX) + 9
          AND SUBSTRING(REFCODE, LEN(@PREFIX) + 1, 10) NOT LIKE '%[^0-9]%'
    ), 0);

    UPDATE dbo.PROCEDURES
    SET REFCODE = @PREFIX + CASE WHEN @NUM < 1000 THEN RIGHT('00' + CAST(@NUM AS VARCHAR(10)), 3) ELSE CAST(@NUM AS VARCHAR(10)) END
    WHERE PRCID = @PRCID;

    FETCH NEXT FROM fiches INTO @PRCID, @ROOTNAME;
END;

CLOSE fiches;
DEALLOCATE fiches;

COMMIT TRANSACTION;

SELECT PRCID, REFCODE, TITLE FROM dbo.PROCEDURES ORDER BY REFCODE;
GO
