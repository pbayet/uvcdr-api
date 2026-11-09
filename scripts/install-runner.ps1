# Installe le runner GitHub Actions qui déploie l'API (workflow .github/workflows/deploy-prod.yml).
#
# À lancer UNE FOIS sur le serveur, dans un PowerShell « Exécuter en tant qu'administrateur ».
# Le script peut aussi être copié-collé tel quel dans la console.
#
# Comme pour les fronts, le runner tourne sous SERVICE RÉSEAU (aucun mot de passe).
# Il n'appelle jamais pm2 : il réécrit restart.trigger, que PM2 surveille
# (watch dans ecosystem.prod.config.cjs) pour redémarrer l'API.
& {
  # ── À renseigner ───────────────────────────────────────────────
  $projet  = "uvcdr-api"               # nom du dépôt GitHub : pbayet/<projet>
  $apiDir  = "D:\SITES\API"            # dossier de l'API en prod (clone Git existant)
  $label   = "prod"                    # doit correspondre à runs-on du workflow
  $token   = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXX"   # jeton GitHub, valable 1 h
  $version = "2.338.2"                 # version affichée par GitHub
  $sha256  = "a1f17aa987fc8158bc7521d284912267a0d01b7c2c4684b33c86783b5e8221cc"
  # ───────────────────────────────────────────────────────────────

  $ErrorActionPreference = 'Stop'
  $runnerDir = "C:\actions-runners\$projet"
  $zip       = "$runnerDir\actions-runner-win-x64-$version.zip"

  # 0. Contrôles préalables
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) { throw "Lancer PowerShell en tant qu'administrateur" }
  if (Test-Path "$runnerDir\.runner") {
    throw "Un runner est déjà configuré dans $runnerDir (le supprimer d'abord : voir DEPLOIEMENT.md)"
  }
  if (-not (Test-Path "$apiDir\.git")) { throw "$apiDir n'est pas un clone Git de l'API" }

  # git, node et npm doivent être dans le PATH machine : SERVICE RÉSEAU ne voit pas le PATH utilisateur
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine').Split(';') |
    Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') }
  foreach ($cmd in 'git', 'node', 'npm') {
    $exe = Get-Command "$cmd.cmd", "$cmd.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $exe) { throw "$cmd introuvable" }
    if ($machinePath -notcontains (Split-Path $exe.Source).TrimEnd('\')) {
      throw "$cmd ($($exe.Source)) n'est que dans le PATH utilisateur : l'ajouter au PATH système"
    }
  }
  Write-Host "V git, node et npm accessibles à SERVICE RÉSEAU" -ForegroundColor Green

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

  # 3. Variable lue par le workflow (fichier .env du runner, injecté dans chaque job)
  Set-Content "$runnerDir\.env" -Encoding ASCII -Value "PROD_DIR=$apiDir"
  Write-Host "V PROD_DIR=$apiDir écrit dans $runnerDir\.env" -ForegroundColor Green

  # 4. Enregistrement sur GitHub et installation du service (compte SERVICE RÉSEAU)
  $configArgs = @(
    '--unattended',
    '--url',    "https://github.com/pbayet/$projet",
    '--token',  $token,
    '--name',   "$env:COMPUTERNAME-api",
    '--labels', $label,
    '--work',   '_work',
    '--runasservice'
  )
  & "$runnerDir\config.cmd" @configArgs
  if ($LASTEXITCODE -ne 0) { throw "config.cmd a échoué (code $LASTEXITCODE)" }

  # 5. Droits pour SERVICE RÉSEAU (SID S-1-5-20) sur le dossier de l'API
  icacls $apiDir /grant "*S-1-5-20:(OI)(CI)M" /T /C /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls a échoué sur $apiDir" }
  # Git refuse un dépôt appartenant à un autre compte (« dubious ownership ») : on l'autorise
  git config --system --add safe.directory ($apiDir -replace '\\', '/')
  if ($LASTEXITCODE -ne 0) { throw "git config --system a échoué" }
  # Fichier surveillé par PM2 pour redémarrer l'API
  if (-not (Test-Path "$apiDir\restart.trigger")) { Set-Content "$apiDir\restart.trigger" -Encoding ASCII -Value "init" }
  Write-Host "V Droits et safe.directory accordés sur $apiDir" -ForegroundColor Green

  # 6. Vérification
  Get-Service "actions.runner.pbayet-$projet.*" | Format-Table Name, Status, StartType
  Write-Host "Reste à faire une fois : relancer PM2 depuis ecosystem.prod.config.cjs (voir DEPLOIEMENT.md)" -ForegroundColor Cyan
  Write-Host "Puis tester : GitHub > Actions > Déploiement prod > Run workflow" -ForegroundColor Cyan
}
