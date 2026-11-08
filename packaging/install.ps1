# Installs the standalone hesdor binary for Windows x64 from GitHub releases.
#   irm https://raw.githubusercontent.com/ksjxixi-gif/Hesdor/main/packaging/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/ksjxixi-gif/Hesdor/main/packaging/install.ps1))) -Version 0.2.0
# Downloads hesdor-win-x64.zip and SHA256SUMS, refuses to install on a checksum mismatch, unpacks into
# -InstallDir and adds it to the user PATH (skip with -NoPath). Works on Windows PowerShell 5.1 and pwsh 7.
param(
  [string]$Version = 'latest',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\hesdor'),
  [string]$BaseUrl = 'https://github.com/ksjxixi-gif/Hesdor/releases',
  [switch]$NoPath
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # the progress bar makes Invoke-WebRequest very slow on 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$asset = 'hesdor-win-x64.zip'
$Version = $Version.TrimStart('v')
$base = if ($Version -eq 'latest') { "$BaseUrl/latest/download" } else { "$BaseUrl/download/v$Version" }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("hesdor-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading $base/$asset"
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile (Join-Path $tmp $asset)
  Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile (Join-Path $tmp 'SHA256SUMS')

  $line = Get-Content (Join-Path $tmp 'SHA256SUMS') | Where-Object { $_ -match "^[0-9a-fA-F]{64}\s+\*?$([regex]::Escape($asset))$" } | Select-Object -First 1
  if (-not $line) { throw "SHA256SUMS has no entry for $asset" }
  $expected = $line.Substring(0, 64).ToLower()
  $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $asset)).Hash.ToLower()
  if ($actual -ne $expected) { throw "Checksum mismatch for ${asset}: expected $expected, got $actual. Nothing was installed." }

  Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath (Join-Path $tmp 'x') -Force
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Copy-Item -Force (Join-Path $tmp 'x\*') $InstallDir
  $exe = Join-Path $InstallDir 'hesdor.exe'
  Write-Host "Installed $exe"

  if (-not $NoPath) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($userPath -split ';' | Where-Object { $_ })
    if ($parts -notcontains $InstallDir) {
      [Environment]::SetEnvironmentVariable('Path', (($parts + $InstallDir) -join ';'), 'User')
      $env:Path = "$env:Path;$InstallDir"
      Write-Host "Added $InstallDir to your user PATH (open a new terminal to pick it up)."
    }
  }
  Write-Host "Run: hesdor --help"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
