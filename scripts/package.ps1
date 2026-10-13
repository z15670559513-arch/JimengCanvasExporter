$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$SkipTests = $args -contains '-SkipTests'
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot 'manifest.json') | ConvertFrom-Json
Push-Location $projectRoot
try {
  if (-not $SkipTests) { & node scripts/test.mjs; if ($LASTEXITCODE -ne 0) { throw 'Regression failed' } }
  & node scripts/release-audit.mjs $projectRoot
  if ($LASTEXITCODE -ne 0) { throw 'Release privacy/dependency audit failed' }
} finally { Pop-Location }
$runtime = @('manifest.json','background.js','page-api.js','generated-resource.js','snapshot.js','incremental.js','task-context.js','download.js','async.js','files.js','task-store.js','sidepanel.html','sidepanel.css','sidepanel.js')
$development = @('package.json','README.md','CHANGELOG.md','PRIVACY.md','DEVELOPMENT.md','RELEASE_NOTES.md','RELEASE_TEST_REPORT.md','LICENSE','THIRD_PARTY_NOTICES.md','.gitignore','scripts/package.ps1','scripts/release-audit.mjs','scripts/public-audit.mjs','scripts/test.mjs','scripts/fixtures.mjs','scripts/test-snapshot.mjs','scripts/test-incremental.mjs','scripts/test-generated-validation.mjs','scripts/test-context.mjs','scripts/test-files.mjs','scripts/test-download.mjs','scripts/browser-smoke.mjs')
$dist = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
$made = @()
foreach ($kind in @('Release','Source')) {
  $zipPath = Join-Path $dist ("JimengCanvasExporter-v{0}-{1}.zip" -f $manifest.version,$kind)
  if (Test-Path -LiteralPath $zipPath) { $zipPath = Join-Path $dist ("JimengCanvasExporter-v{0}-{1}-{2}.zip" -f $manifest.version,$kind,(Get-Date -Format 'yyyyMMdd-HHmmss')) }
  $files = @($runtime)
  if ($kind -eq 'Source') { $files += $development }
  foreach ($file in $files) { if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $file) -PathType Leaf)) { throw "Missing package input: $file" } }
  $archive = [IO.Compression.ZipFile]::Open($zipPath,[IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in $files) {
      $full = [IO.Path]::GetFullPath((Join-Path $projectRoot $file))
      if (-not $full.StartsWith($projectRoot.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid package path' }
      if ((Get-Item -LiteralPath $full).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Package input cannot be a reparse point' }
      [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$full,$file.Replace('\','/'),[IO.Compression.CompressionLevel]::Optimal)
    }
  } finally { $archive.Dispose() }
  $made += $zipPath
}
# Only archive previous packages. Never touch user data or source backups.
$historyName = -join @([char]0x5F80,[char]0x671F,[char]0x7248,[char]0x672C)
$historyPath = Join-Path $dist $historyName
New-Item -ItemType Directory -Force -Path $historyPath | Out-Null
$distFull = [IO.Path]::GetFullPath($dist).TrimEnd('\')+'\'
$historyFull = [IO.Path]::GetFullPath($historyPath).TrimEnd('\')+'\'
if (-not $historyFull.StartsWith($distFull,[StringComparison]::OrdinalIgnoreCase) -or ((Get-Item -LiteralPath $historyPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe archive path' }
Get-ChildItem -LiteralPath $dist -File -Filter 'JimengCanvasExporter-v*.zip' | Where-Object { $made -notcontains $_.FullName } | ForEach-Object {
  if (-not [IO.Path]::GetFullPath($_.FullName).StartsWith($distFull,[StringComparison]::OrdinalIgnoreCase)) { throw 'Archive source outside dist' }
  $destination = Join-Path $historyPath $_.Name
  if (Test-Path -LiteralPath $destination) { $destination = Join-Path $historyPath ($_.BaseName+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8)+'.zip') }
  Move-Item -LiteralPath $_.FullName -Destination $destination
}
$canonical = @()
foreach ($file in $made) {
  $kind = if ([IO.Path]::GetFileName($file) -match '-Release') { 'Release' } else { 'Source' }
  $target = Join-Path $dist ("JimengCanvasExporter-v{0}-{1}.zip" -f $manifest.version,$kind)
  if ($file -ne $target) { Move-Item -LiteralPath $file -Destination $target }
  $canonical += $target
}
$checks = foreach ($file in $canonical) { [PSCustomObject]@{File=$file;SHA256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash;Bytes=(Get-Item -LiteralPath $file).Length} }
$lines = @($checks | ForEach-Object { $_.SHA256+'  '+[IO.Path]::GetFileName($_.File) })
[IO.File]::WriteAllLines((Join-Path $dist ('SHA256SUMS-v'+$manifest.version+'.txt')),$lines,(New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllLines((Join-Path $dist 'SHA256SUMS.txt'),$lines,(New-Object Text.UTF8Encoding($false)))
$checks
