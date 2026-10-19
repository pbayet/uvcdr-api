<#
  Convertit un .pptx en .pdf en pilotant PowerPoint par automatisation COM.
  Appelé par modules/vinidoc/engine/pdf-converter.js (VINIDOC_PDF_ENGINE=powerpoint)
  — repris tel quel du POC technical-data-sheet-tests.

  Constantes COM (PowerPoint Object Model) :
    32 = PpSaveAsFileType.ppSaveAsPDF
    -1 = msoTrue / 0 = msoFalse
#>
param(
    [Parameter(Mandatory = $true)][string]$PptxPath,
    [Parameter(Mandatory = $true)][string]$PdfPath
)

$ErrorActionPreference = "Stop"
$ppSaveAsPDF = 32

$ppt = $null
$presentation = $null

try {
    if (-not (Test-Path -LiteralPath $PptxPath)) {
        throw "Fichier PPTX introuvable : $PptxPath"
    }

    $ppt = New-Object -ComObject PowerPoint.Application
    # PowerPoint n'autorise pas Application.Visible = False ; la fenêtre de
    # la présentation est masquée à l'ouverture (WithWindow = msoFalse).
    $ppt.Visible = -1

    # Open(FileName, ReadOnly, Untitled, WithWindow)
    $presentation = $ppt.Presentations.Open($PptxPath, -1, 0, 0)
    $presentation.SaveAs($PdfPath, $ppSaveAsPDF)
}
finally {
    if ($presentation) {
        try { $presentation.Close() } catch {}
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) | Out-Null
    }
    if ($ppt) {
        try { $ppt.Quit() } catch {}
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) | Out-Null
    }
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
}

if (-not (Test-Path -LiteralPath $PdfPath)) {
    throw "PowerPoint n'a pas produit de PDF à l'emplacement attendu : $PdfPath"
}
