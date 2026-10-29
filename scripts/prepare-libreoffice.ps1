# Download and stage LibreOffice for the Windows installer bundle.
# Runs on Windows (locally or on the windows-latest CI runner).
#
# Produces vendor/libreoffice/win32-x64/LibreOffice/ (an administrative MSI
# extract containing program/soffice.exe), picked up by electron-builder's
# win.extraResources and found at runtime via INNO_BUNDLED_TOOLS_DIR.
#
# Usage: pwsh scripts/prepare-libreoffice.ps1 [-Version 26.8.1] [-Sha256 <hex>]
param(
  [string]$Version = "26.8.1",
  [string]$Sha256 = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$DestDir = Join-Path $RepoRoot "vendor/libreoffice/win32-x64"
$Msi = "LibreOffice_${Version}_Win_x86-64.msi"
$Url = "https://download.documentfoundation.org/libreoffice/stable/$Version/win/x86_64/$Msi"

$AlreadyStaged = Test-Path (Join-Path $DestDir "LibreOffice/program/soffice.exe")
if ($AlreadyStaged) {
  Write-Host "already staged: $DestDir/LibreOffice"
} else {
$TmpDir = Join-Path $env:TEMP ("lo-stage-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $TmpDir | Out-Null
try {
  $MsiPath = Join-Path $TmpDir $Msi
  Write-Host "downloading $Url"
  curl.exe -fL --retry 3 -o $MsiPath $Url

  if ($Sha256) {
    $Actual = (Get-FileHash -Algorithm SHA256 $MsiPath).Hash.ToLower()
    if ($Actual -ne $Sha256.ToLower()) { throw "SHA-256 mismatch: expected $Sha256, got $Actual" }
  }

  # Administrative install extracts the payload without installing anything.
  $ExtractDir = Join-Path $TmpDir "extract"
  New-Item -ItemType Directory -Path $ExtractDir | Out-Null
  $proc = Start-Process msiexec.exe -ArgumentList "/a `"$MsiPath`" /qn TARGETDIR=`"$ExtractDir`"" -Wait -PassThru
  if ($proc.ExitCode -ne 0) { throw "msiexec /a failed with exit code $($proc.ExitCode)" }

  New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
  Move-Item (Join-Path $ExtractDir "LibreOffice") (Join-Path $DestDir "LibreOffice")
  Write-Host "staged at $DestDir/LibreOffice"
} finally {
  Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
}

}

# Bundle both serif and sans CJK fallbacks; keep source font choices distinct.
$FontsDir = Join-Path $DestDir "LibreOffice/share/fonts/truetype"
New-Item -ItemType Directory -Path $FontsDir -Force | Out-Null
foreach ($Family in @("Sans", "Serif")) {
  foreach ($Weight in @("Regular", "Bold")) {
    $Font = "Noto${Family}SC-${Weight}.otf"
    $Target = Join-Path $FontsDir $Font
    if (-not (Test-Path $Target)) {
      Write-Host "fetching $Font"
      curl.exe -fL --retry 3 -o $Target `
        "https://raw.githubusercontent.com/googlefonts/noto-cjk/main/$Family/SubsetOTF/SC/$Font"
      if ($LASTEXITCODE -ne 0) { throw "Font download failed: $Font" }
    }
  }
  curl.exe -fL --retry 3 -o (Join-Path $FontsDir "Noto${Family}-LICENSE.txt") `
    "https://raw.githubusercontent.com/googlefonts/noto-cjk/main/$Family/LICENSE"
  if ($LASTEXITCODE -ne 0) { throw "Font license download failed: $Family" }
}
