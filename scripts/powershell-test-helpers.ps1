# PowerShell betik testlerinin ortak, exception-guvenli kosucusu.
# Dot-source edilir; uretim betikleri bu dosyaya baglanmaz.

function Initialize-SmithTestRun {
    $script:Passed = 0
    $script:Failed = @()
}

function Add-Pass([string]$Name) {
    $script:Passed++
    Write-Host "  [gecti] $Name" -ForegroundColor Green
}

function Add-Failure([string]$Name, [string]$Detail) {
    $script:Failed += $Name
    Write-Host "  [KALDI] $Name" -ForegroundColor Red
    if ($Detail) { Write-Host "          $Detail" -ForegroundColor Red }
}

function Assert-True([string]$Name, [bool]$Condition, [string]$Detail = '') {
    if ($Condition) { Add-Pass $Name } else { Add-Failure $Name $Detail }
}

function Assert-SetEqual([string]$Name, $Actual, $Expected) {
    $actualSorted = @($Actual | Sort-Object)
    $expectedSorted = @($Expected | Sort-Object)
    if (($actualSorted -join '|') -ceq ($expectedSorted -join '|')) {
        Add-Pass $Name
        return
    }
    Add-Failure $Name ("beklenen: [{0}]  gercek: [{1}]" -f
        ($expectedSorted -join ', '), ($actualSorted -join ', '))
}

function Invoke-Case([string]$Name, [scriptblock]$Body) {
    Write-Host "== $Name"
    try {
        & $Body
    } catch {
        Add-Failure $Name ("istisna: " + $_.Exception.Message)
    }
}

function Complete-SmithTestRun {
    Write-Host ''
    Write-Host ("SONUC: {0} gecti, {1} kaldi" -f $script:Passed, $script:Failed.Count)
    if ($script:Failed.Count -gt 0) {
        foreach ($failure in $script:Failed) { Write-Host "  - $failure" -ForegroundColor Red }
        exit 1
    }
    Write-Host 'Hepsi yesil.' -ForegroundColor Green
    exit 0
}
