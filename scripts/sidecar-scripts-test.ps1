# Static and AST regressions for sidecar launch and ingestion scripts.
# Production scripts are not dot-sourced: they touch live services and tasks.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'powershell-test-helpers.ps1')
Initialize-SmithTestRun

$speakerPath = Join-Path $PSScriptRoot 'speaker-server.ps1'
$sttPath = Join-Path $PSScriptRoot 'stt-server.ps1'
$ingestPath = Join-Path $PSScriptRoot 'ingest-all.ps1'
$scanPath = Join-Path $PSScriptRoot 'awareness-scan.ps1'
$installPath = Join-Path $PSScriptRoot 'awareness-install-task.ps1'

Invoke-Case 'scripts parse in the current shell' {
    foreach ($path in @($speakerPath, $sttPath, $ingestPath, $scanPath, $installPath)) {
        $tokens = $null
        $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile(
            $path, [ref]$tokens, [ref]$errors
        )
        Assert-True "parser: $(Split-Path -Leaf $path)" ($errors.Count -eq 0) ($errors -join '; ')
    }
}

Invoke-Case 'ingest SQL is scoped to one workspace' {
    $text = Get-Content -LiteralPath $ingestPath -Raw
    Assert-True 'workspace id is explicit' ($text -match '\$WorkspaceId\s*=')
    Assert-True 'total count is workspace scoped' (
        $text -match 'count\(\*\).*where\s+"workspaceId"\s*=.*WorkspaceId'
    )
    Assert-True 'source counts are workspace scoped' (
        $text -match 'sourceType.*count\(\*\).*where\s+"workspaceId".*group by\s+"sourceType"'
    )
    Assert-True 'exclude ids are workspace scoped' (
        $text -match 'sourceId.*where\s+"workspaceId"\s*=.*WorkspaceId.*sourceType'
    )
}

Invoke-Case 'ingest writes UTF-8 without BOM and propagates failures' {
    $text = Get-Content -LiteralPath $ingestPath -Raw
    Assert-True 'BOM-less encoder is explicit' ($text -match 'UTF8Encoding\]\:\:new\(\$false\)')
    Assert-True 'exclude writer uses WriteAllLines' ($text -match 'WriteAllLines')
    Assert-True 'failed connector exits nonzero' (
        $text -match 'Where-Object\s*\{\s*\$_.Exit\s*-ne\s*0\s*\}' -and
        $text -match 'if\s*\(\$ExitCode\s*-ne\s*0\)\s*\{\s*exit\s+\$ExitCode\s*\}'
    )
}

Invoke-Case 'speaker launcher is relocatable and preserves Python exit' {
    $text = Get-Content -LiteralPath $speakerPath -Raw
    Assert-True 'sidecar path derives from PSScriptRoot' (
        $text -match '\$PSScriptRoot' -and $text -notmatch 'C:\\Users\\[^\\]+\\smith-monorepo'
    )
    Assert-True 'Python exit is propagated' ($text -match 'exit\s+\$LASTEXITCODE\s*$')
}

Invoke-Case 'awareness task update does not unregister first' {
    $text = Get-Content -LiteralPath $installPath -Raw
    $start = $text.IndexOf('function Register-AwarenessTask')
    $end = $text.IndexOf('# --- SmithAwareness:', $start)
    $body = $text.Substring($start, $end - $start)
    Assert-True 'register path keeps existing task until replacement' ($body -notmatch 'Remove-TaskIfExists')
    Assert-True 'registration replaces atomically with Force' ($body -match 'Register-ScheduledTask[\s\S]*?-Force')
}

Invoke-Case 'awareness wrapper propagates child failures' {
    $text = Get-Content -LiteralPath $scanPath -Raw
    Assert-True 'child exit is captured' ($text -match '\$exit\s*=\s*\$LASTEXITCODE')
    Assert-True 'any failed scanner exits one' (
        $text -match 'Where-Object\s*\{\s*\$_.Exit\s*-ne\s*0\s*\}' -and
        $text -match 'if\s*\(\$failed.Count\s*-gt\s*0\)\s*\{\s*exit\s+1\s*\}'
    )
}

Complete-SmithTestRun
