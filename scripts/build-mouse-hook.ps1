$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $projectRoot 'native\MouseSideHotkey.cs'
$outputPath = Join-Path $projectRoot 'native\MouseSideHotkey.exe'
$compiler = Get-ChildItem -LiteralPath 'C:\Windows\Microsoft.NET\Framework64' -Filter csc.exe -Recurse |
  Sort-Object FullName -Descending |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $compiler) { throw 'Windows C# compiler was not found.' }
& $compiler /nologo /target:exe /optimize+ /platform:x64 "/out:$outputPath" $sourcePath
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outputPath)) {
  throw 'Mouse side-button helper compilation failed.'
}
Write-Output "Mouse side-button helper built: $outputPath"
