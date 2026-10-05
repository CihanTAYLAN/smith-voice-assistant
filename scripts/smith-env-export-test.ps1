# smith-env-export.ps1 izin listesi KAPISI (talimat degil mekanizma).
#
# NEDEN VAR: paketli (release) masaustu uygulamasi ortami dev-win.ps1'den degil
# <veri koku>\smith.env dosyasindan alir ve dosyaya YALNIZ smith-env-export.ps1'deki
# izin listesindeki SMITH_* adlari yazilir. Rust'ta yeni bir `std::env::var("SMITH_X")`
# eklenip liste unutulunca paketli uygulama o ayari sessizce varsayilanla calistirir:
# 2026-10-03 sahasinda SMITH_LOG_TRANSCRIPT, SMITH_ECHO_GATE ve oyun modu degiskenleri
# boyle eksikti ve hicbir hata/uyari yoktu. Bu test Rust kaynagini tarar ve iki yonlu
# sozlesmeyi zorlar:
#   1) Masaustu Rust kaynaginda OKUNAN her SMITH_* adi izin listesinde ya da asagidaki
#      ACIK istisna listesinde olmali (istisna = bilincli dislama + gerekce).
#   2) Liste/istisna curumesin: istisna adi gercekten okunmali ve listede olmamali,
#      izin listesindeki her ad Rust'ta okunmali (yazim hatasi / silinmis ayar yakalanir).
#
# Okuma sayilmayanlar: `.env(..)`, `.env_remove(..)`, `set_var(..)`, `remove_var(..)`
# (alt surece/teste ortam verme) ve `env!(..)` (derleme zamani). Bunlar uygulamanin
# disaridan OKUDUGU ayar degildir.
#
# Kullanim (iki kabukta da yesil olmali):
#   powershell.exe -NoProfile -File scripts\smith-env-export-test.ps1
#   pwsh -NoProfile -File scripts\smith-env-export-test.ps1
# -ExportScript yalniz kapinin kirmizi/yesil kanitini gostermek icin (eski surum).
param(
    [string]$ExportScript = (Join-Path $PSScriptRoot 'smith-env-export.ps1')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'powershell-test-helpers.ps1')
Initialize-SmithTestRun

# BILINCLI DISLANANLAR: ad -> neden. Yeni bir ad buraya ancak gerekceyle eklenir.
$Exceptions = [ordered]@{
    'SMITH_CODE_AGENT_VERIFY'         = 'guvenlik anahtari: host dogrulamasi (pnpm install/verify) bilincli ve oturum basina acilir; paketli uygulamaya dosyayla TASINMAZ'
    'SMITH_ALLOW_MULTI'               = 'gelistirme/test kacisi: tek ornek kilidini kaldirir, ikinci kopya mikrofonu cakistirir; paketli uygulamaya tasinmaz'
    'SMITH_AUDIT_DEADLINE_CHILD'      = 'yalniz test: alt surec isaretcisi (system_tools testi)'
    'SMITH_TEST_PENCERE_ISARET'       = 'yalniz test: pencere sondasi (system_tools testi)'
    'SMITH_TEST_PENCERE_UYKU_MS'      = 'yalniz test: pencere sondasi (system_tools testi)'
    'SMITH_TEST_DOGRUDAN'             = 'yalniz test: pencere sondasi (system_tools testi)'
    'SMITH_TEST_SMITH_BEKLE'          = 'yalniz test: pencere sondasi (system_tools testi)'
    'SMITH_TEST_OLMAYAN_BAYRAK_XYZ'   = 'yalniz test: env_flag olmayan degisken senaryosu'
    'SMITH_CODE_AGENT_OLMAYAN_DEGISKEN' = 'yalniz test: code_agent olmayan degisken senaryosu'
    'SMITH_NET_KARE_PROBE_IN'         = 'yalniz sonda: ekrani_net_gor olcum testi (ignore)'
    'SMITH_NET_KARE_PROBE_OUT'        = 'yalniz sonda: ekrani_net_gor olcum testi (ignore)'
    'SMITH_LIVE_PROBE_OUT'            = 'yalniz sonda: canli kurulum olcum testi (ignore)'
    'SMITH_LIVE_PROBE_BASELINE'       = 'yalniz sonda: canli kurulum olcum testi (ignore)'
    'SMITH_A2_MEMORY_CHILD'           = 'yalniz test: proaktif bellek alt surec isaretcisi (setup testi)'
}

# Yazma/derleme-zamani cagrilari: literal bunlarin ilk argumani ise OKUMA degildir.
$NotARead = '(?:\.env|\.env_remove|set_var|remove_var|env!)\(\s*$'

function Get-RustEnvReads([string]$SrcDir) {
    $reads = @{}
    foreach ($f in @(Get-ChildItem -LiteralPath $SrcDir -Recurse -Filter '*.rs' -File)) {
        $lineNo = 0
        foreach ($line in [System.IO.File]::ReadAllLines($f.FullName)) {
            $lineNo++
            foreach ($m in [regex]::Matches($line, '"(SMITH_[A-Z0-9_]+)"')) {
                $before = $line.Substring(0, $m.Index)
                if ($before -match $NotARead) { continue }
                $name = $m.Groups[1].Value
                if (-not $reads.ContainsKey($name)) { $reads[$name] = @() }
                $reads[$name] += ('{0}:{1}' -f $f.Name, $lineNo)
            }
        }
    }
    return $reads
}

function Get-ExportAllowList([string]$Path) {
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { throw "ayristirma hatasi: $($errors[0].Message)" }
    $assign = $ast.Find({
            param($n)
            $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and
                $n.Left.Extent.Text -eq '$allowKeys'
        }, $true)
    if (-not $assign) { throw '$allowKeys atamasi bulunamadi' }
    $strings = $assign.Right.FindAll({
            param($n)
            $n -is [System.Management.Automation.Language.StringConstantExpressionAst]
        }, $true)
    return @($strings | ForEach-Object { $_.Value })
}

$srcDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'apps\desktop\src-tauri\src'

Invoke-Case 'izin listesi ve Rust env okumalari' {
    Assert-True 'Rust kaynak dizini var' (Test-Path -LiteralPath $srcDir) $srcDir
    $reads = Get-RustEnvReads $srcDir
    $allow = Get-ExportAllowList $ExportScript
    Write-Host ("  Rust'ta okunan SMITH_* adi: {0}, izin listesi: {1}, istisna: {2}" -f $reads.Count, $allow.Count, $Exceptions.Count)

    # Sessiz yesil olmasin: tarama gercekten okuma buldu mu.
    Assert-True 'tarama anlamli sayida okuma buldu (yanlis yol/desen degil)' ($reads.Count -ge 30) "bulunan: $($reads.Count)"

    $missing = @($reads.Keys | Where-Object { ($allow -cnotcontains $_) -and (-not $Exceptions.Contains($_)) } | Sort-Object)
    $detail = ($missing | ForEach-Object { '{0} ({1})' -f $_, (@($reads[$_] | Select-Object -First 2) -join ',') }) -join '; '
    Assert-True 'okunan her SMITH_* izin listesinde ya da istisnada' ($missing.Count -eq 0) ("eksik: $detail")

    $dupes = @($allow | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })
    Assert-True 'izin listesinde yinelenen ad yok' ($dupes.Count -eq 0) ("yinelenen: " + ($dupes -join ', '))

    $notRead = @($allow | Where-Object { -not $reads.ContainsKey($_) })
    Assert-True 'izin listesindeki her ad Rust kaynaginda okunuyor' ($notRead.Count -eq 0) ("okunmayan: " + ($notRead -join ', '))

    $staleExceptions = @($Exceptions.Keys | Where-Object { -not $reads.ContainsKey($_) })
    Assert-True 'her istisna adi gercekten okunuyor (bayat istisna yok)' ($staleExceptions.Count -eq 0) ("bayat: " + ($staleExceptions -join ', '))

    $both = @($Exceptions.Keys | Where-Object { $allow -ccontains $_ })
    Assert-True 'istisna ve izin listesi ayrik' ($both.Count -eq 0) ("ikisinde de: " + ($both -join ', '))

    foreach ($name in @('SMITH_CONTEXT_EXCLUDE', 'SMITH_DATA_DIR', 'SMITH_LOG_TRANSCRIPT', 'SMITH_ECHO_GATE')) {
        Assert-True "$name izin listesinde" ($allow -ccontains $name)
    }
}

Invoke-Case 'secret anahtarlari izin listesine girmez' {
    $allow = Get-ExportAllowList $ExportScript
    $bad = @($allow | Where-Object { $_ -cmatch '(?:^SMITH_(?:LLM|EMBED|MISTRAL)_|PASSWORD|TOKEN|SECRET|DEEPGRAM|ELEVENLABS)' })
    Assert-True 'gateway/worker/sidecar sirlari listede yok' ($bad.Count -eq 0) ("bulunan: " + ($bad -join ', '))
}

Complete-SmithTestRun
