# Installe le runner GitHub Actions qui déploie l'API (workflow .github/workflows/deploy-prod.yml).
#
# À lancer UNE FOIS sur le serveur, dans un PowerShell « Exécuter en tant qu'administrateur »,
# connecté avec le compte Windows qui fait tourner PM2 (celui de « pm2 list »).
# Le script peut aussi être copié-collé tel quel dans la console.
#
# Différence avec le script des fronts : le service ne tourne PAS sous SERVICE RÉSEAU
# mais sous le compte de PM2. Sinon le runner ne voit pas le process PM2 de l'API
# (autre PM2_HOME) et Git refuse le dossier (« dubious ownership »).
& {
  # ── À renseigner ───────────────────────────────────────────────
  $projet  = "uvcdr-api"               # nom du dépôt GitHub : pbayet/<projet>
  $apiDir  = "D:\APIs\uvcdr-api"       # dossier de l'API en prod (clone Git existant)
  $pm2App  = "UVCDR API PROD"          # nom du process PM2
  $label   = "prod"                    # doit correspondre à runs-on du workflow
  $token   = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXX"   # jeton GitHub, valable 1 h
  $version = "2.338.2"                 # version affichée par GitHub
  $sha256  = "a1f17aa987fc8158bc7521d284912267a0d01b7c2c4684b33c86783b5e8221cc"
  # ───────────────────────────────────────────────────────────────

  $ErrorActionPreference = 'Stop'
  $runnerDir = "C:\actions-runners\$projet"
  $zip       = "$runnerDir\actions-runner-win-x64-$version.zip"
  $compte    = "$env:USERDOMAIN\$env:USERNAME"

  # 0. Contrôles préalables
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) { throw "Lancer PowerShell en tant qu'administrateur" }
  if (Test-Path "$runnerDir\.runner") {
    throw "Un runner est déjà configuré dans $runnerDir (le supprimer d'abord : voir DEPLOIEMENT.md)"
  }
  if (-not (Test-Path "$apiDir\.git")) { throw "$apiDir n'est pas un clone Git de l'API" }
  $pm2Pid = (pm2.cmd pid $pm2App | Out-String).Trim()
  if (-not $pm2Pid -or $pm2Pid -eq '0') {
    throw "PM2 ne voit pas « $pm2App » avec le compte $compte : lancer ce script avec le compte qui fait tourner PM2"
  }
  Write-Host "V PM2 voit « $pm2App » (PID $pm2Pid) avec le compte $compte" -ForegroundColor Green

  $mdp = Read-Host "Mot de passe Windows de $compte (pour le service du runner)" -AsSecureString
  $mdpClair = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($mdp))

  New-Item -ItemType Directory -Force $runnerDir | Out-Null
  Set-Location $runnerDir

  # 1. Téléchargement (via l'API : le lien direct répond parfois 504)
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = 'SilentlyContinue'
  $rel   = Invoke-RestMethod "https://api.github.com/repos/actions/runner/releases/tags/v$version" -UseBasicParsing
  $asset = $rel.assets | Where-Object name -eq (Split-Path $zip -Leaf)
  if (-not $asset) { throw "Archive introuvable dans la release v$version" }
  Invoke-WebRequest $asset.url -Headers @{ Accept = 'application/octet-stream' } -OutFile $zip -UseBasicParsing
  Write-Host "V Téléchargé" -ForegroundColor Green

  # 2. Contrôle et extraction
  if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $sha256) { throw "Checksum incorrect" }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $runnerDir)
  Remove-Item $zip
  Write-Host "V Extrait dans $runnerDir" -ForegroundColor Green

  # 3. Variables lues par le workflow (fichier .env du runner, injecté dans chaque job)
  Set-Content "$runnerDir\.env" -Encoding ASCII -Value @(
    "PROD_DIR=$apiDir",
    "PM2_APP=$pm2App"
  )
  Write-Host "V PROD_DIR=$apiDir écrit dans $runnerDir\.env" -ForegroundColor Green

  # 4. Enregistrement sur GitHub et installation du service (compte de PM2)
  $configArgs = @(
    '--unattended',
    '--url',    "https://github.com/pbayet/$projet",
    '--token',  $token,
    '--name',   "$env:COMPUTERNAME-api",
    '--labels', $label,
    '--work',   '_work',
    '--runasservice',
    '--windowslogonaccount',  $compte,
    '--windowslogonpassword', $mdpClair
  )
  try {
    & "$runnerDir\config.cmd" @configArgs
    if ($LASTEXITCODE -ne 0) { throw "config.cmd a échoué (code $LASTEXITCODE)" }
  } finally {
    $mdpClair = $null; $configArgs = $null
  }

  # 5. Vérification
  Get-Service "actions.runner.pbayet-$projet.*" | Format-Table Name, Status, StartType
  Write-Host "Test : GitHub > Actions > Déploiement prod > Run workflow" -ForegroundColor Cyan
}
