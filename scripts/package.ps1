param(
    [string]$Target = '',
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Push-Location $taskRoot
try {
    $taskArgs = @('build', '--release', '--locked')
    $taskBinary = Join-Path $taskRoot 'target/release/oracle-bot-panel.exe'
    if ($Target) {
        $taskArgs += @('--target', $Target)
        $taskBinary = Join-Path $taskRoot "target/$Target/release/oracle-bot-panel.exe"
    }
    if (-not $SkipBuild) {
        & cargo @taskArgs
        if ($LASTEXITCODE -ne 0) { throw 'Rust release build failed.' }
    }
    if (-not (Test-Path -LiteralPath $taskBinary)) { throw "Executable not found: $taskBinary" }
    $taskDist = Join-Path $taskRoot 'dist'
    New-Item -ItemType Directory -Force $taskDist | Out-Null
    # Build the archive from a fresh staging directory, never a user's existing config.
    $taskStage = Join-Path $taskDist ('stage-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory $taskStage | Out-Null
    $taskFiles = @('config.example.json', '.env.example', 'Launch-Control-Panel.cmd', 'README.md')
    Copy-Item -LiteralPath $taskBinary -Destination (Join-Path $taskStage 'oracle-bot-panel.exe')
    foreach ($taskFile in $taskFiles) { Copy-Item -LiteralPath (Join-Path $taskRoot $taskFile) -Destination $taskStage }
    New-Item -ItemType Directory (Join-Path $taskStage 'docs') | Out-Null
    foreach ($taskDoc in @('ARCHITECTURE.md', 'OPERATIONS.md', 'CONFIGURATION.md', 'SECURITY.md', 'DEVELOPMENT.md')) {
        Copy-Item -LiteralPath (Join-Path $taskRoot "docs/$taskDoc") -Destination (Join-Path $taskStage 'docs')
    }
    $taskZip = Join-Path $taskDist 'OracleBotControlPanel-windows-x64.zip'
    $taskArchiveFiles = @((Join-Path $taskStage 'oracle-bot-panel.exe')) + @($taskFiles | ForEach-Object { Join-Path $taskStage $_ }) + @((Join-Path $taskStage 'docs'))
    Compress-Archive -LiteralPath $taskArchiveFiles -DestinationPath $taskZip -Force
    Copy-Item -LiteralPath (Join-Path $taskStage 'oracle-bot-panel.exe') -Destination (Join-Path $taskDist 'oracle-bot-panel.exe') -Force
    $taskResolved = [IO.Path]::GetFullPath($taskStage)
    $taskAllowed = [IO.Path]::GetFullPath($taskDist) + [IO.Path]::DirectorySeparatorChar
    if (-not $taskResolved.StartsWith($taskAllowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Staging path escaped dist.' }
    Remove-Item -LiteralPath $taskResolved -Recurse -Force
    Get-FileHash -LiteralPath $taskZip -Algorithm SHA256
    Write-Output "Portable executable: $(Join-Path $taskDist 'oracle-bot-panel.exe')"
    Write-Output "Portable package: $taskZip"
} finally { Pop-Location }
