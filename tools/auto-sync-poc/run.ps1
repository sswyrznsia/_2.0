param(
  [Parameter(Mandatory = $true)]
  [string]$InputJson,
  [Parameter(Mandatory = $true)]
  [string]$OutputJson
)

$ErrorActionPreference = 'Stop'
$Workspace = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Python = Join-Path $Workspace '.venv-auto-sync\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $Python)) {
  throw 'Missing .venv-auto-sync. Follow tools/auto-sync-poc/README.md first.'
}
$Ffmpeg = Get-ChildItem -LiteralPath (Join-Path $Workspace '.poc-cache\ffmpeg') -Filter ffmpeg.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $Ffmpeg) {
  throw 'Missing FFmpeg in .poc-cache/ffmpeg. Follow tools/auto-sync-poc/README.md first.'
}
$TorchLib = Join-Path $Workspace '.venv-auto-sync\Lib\site-packages\torch\lib'
$env:PATH = "$($Ffmpeg.DirectoryName);$TorchLib;$env:PATH"
$env:HF_HUB_DISABLE_XET = '1'

& $Python (Join-Path $PSScriptRoot 'auto_sync_poc.py') `
  --input (Resolve-Path -LiteralPath $InputJson) `
  --output $OutputJson `
  --workspace $Workspace
exit $LASTEXITCODE
