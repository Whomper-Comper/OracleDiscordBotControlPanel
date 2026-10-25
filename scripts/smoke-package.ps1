param([string]$Package = '')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if (-not $Package) { $Package = Join-Path $taskRoot 'dist/OracleBotControlPanel-windows-x64.zip' }
$taskTempRoot = Join-Path $taskRoot 'target'
New-Item -ItemType Directory -Force $taskTempRoot | Out-Null
$taskStage = Join-Path $taskTempRoot ('package-smoke-' + [Guid]::NewGuid().ToString('N'))
$taskProcess = $null
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $taskArchive = [IO.Compression.ZipFile]::OpenRead($Package)
    try {
        $taskAllowed = @('oracle-bot-panel.exe', 'Launch-Control-Panel.cmd', 'config.example.json', '.env.example', 'README.md', 'docs/ARCHITECTURE.md', 'docs/OPERATIONS.md', 'docs/CONFIGURATION.md', 'docs/SECURITY.md', 'docs/DEVELOPMENT.md')
        $taskNames = @($taskArchive.Entries | Where-Object { $_.Name } | ForEach-Object { $_.FullName.Replace('\', '/') })
        foreach ($taskName in $taskNames) { if ($taskName -notin $taskAllowed) { throw "Unexpected package file: $taskName" } }
        foreach ($taskName in $taskAllowed) { if ($taskName -notin $taskNames) { throw "Missing package file: $taskName" } }
    } finally { $taskArchive.Dispose() }
    Expand-Archive -LiteralPath $Package -DestinationPath $taskStage
    $taskListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $taskListener.Start()
    $taskPort = $taskListener.LocalEndpoint.Port
    $taskListener.Stop()
    $taskSavedPath = $env:PATH
    try {
        # Prove startup without Node, Rust or project-local compiler tools on PATH.
        $env:PATH = Join-Path $env:SystemRoot 'System32'
        $taskProcess = Start-Process -FilePath (Join-Path $taskStage 'oracle-bot-panel.exe') -ArgumentList @('--no-browser', '--port', $taskPort) -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru
    } finally { $env:PATH = $taskSavedPath }
    $taskUrl = "http://127.0.0.1:$taskPort"
    $taskReady = $false
    for ($taskAttempt = 0; $taskAttempt -lt 50; $taskAttempt++) {
        if ($taskProcess.HasExited) { throw "Packaged EXE exited: $($taskProcess.ExitCode)" }
        try { $taskResponse = Invoke-WebRequest "$taskUrl/" -UseBasicParsing; $taskReady = $true; break } catch { Start-Sleep -Milliseconds 100 }
    }
    if (-not $taskReady) { throw 'Packaged EXE did not start.' }
    foreach ($taskPath in @('/', '/dashboard.js', '/panel-ui.js')) {
        $taskResponse = Invoke-WebRequest "$taskUrl$taskPath" -UseBasicParsing
        if ($taskResponse.StatusCode -ne 200 -or $taskResponse.Content.Length -lt 1000) { throw "Missing embedded asset: $taskPath" }
    }
    Invoke-RestMethod "$taskUrl/api/config" -Method Post -Headers @{'X-Panel' = '1'} -ContentType 'application/json' -Body '{"name":"Packaged smoke fixture"}' | Out-Null
    $taskSaved = Get-Content -LiteralPath (Join-Path $taskStage 'config.json') -Raw | ConvertFrom-Json
    if ($taskSaved.bots[0].name -ne 'Packaged smoke fixture') { throw 'EXE did not save settings beside itself.' }
    Write-Output 'Package smoke passed: safe ZIP contents, embedded UI, portable config, no local Node runtime.'
} finally {
    if ($taskProcess -and -not $taskProcess.HasExited) { Stop-Process -InputObject $taskProcess; $taskProcess.WaitForExit() }
    $taskResolved = [IO.Path]::GetFullPath($taskStage)
    $taskAllowedRoot = [IO.Path]::GetFullPath($taskTempRoot) + [IO.Path]::DirectorySeparatorChar
    if (-not $taskResolved.StartsWith($taskAllowedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Smoke path escaped target.' }
    if (Test-Path -LiteralPath $taskResolved) { Remove-Item -LiteralPath $taskResolved -Recurse -Force }
}
