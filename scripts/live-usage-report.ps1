<#
.SYNOPSIS
  Gemini Live token kullanim gunlugunu (live-usage-<yyyyMMdd>.jsonl) ozetler.

.DESCRIPTION
  Smith masaustu uygulamasi, Live sunucu mesajlarindaki usageMetadata'yi her
  ornek icin tek satir JSON olarak
    <veri koku>\logs\live-usage-<yyyyMMdd>.jsonl
  (veri koku: SMITH_DATA_DIR ya da %USERPROFILE%\.smith, bkz. smith-common.ps1)
  dosyasina ekler (icerik/transkript ASLA yazilmaz, yalniz sayaclar). Bu betik
  bir gunun dosyasini okur ve ozetler: tur sayisi, modaliteye gore toplam
  girdi/cikti token ve tahmini USD.

  GUN SINIRI UTC'dir: dosya adindaki tarih UTC'ye gore verilir (TR yerel saatle
  03:00'te yeni dosya baslar). -Date verilmezse bugunun UTC tarihi kullanilir.

  TUR SAYISI = usageMetadata ornek sayisi. Her ornek bir tur sayilir ve
  toplanir; sunucu ayni tur icin birden fazla ornek yollarsa toplam bir UST
  SINIRDIR. Her turda baglam yeniden faturalandigi icin girdi token'i
  konusma uzadikca buyur (baglam sikistirmasi bunu sinirlar).

  FIYAT TABLOSU SABITTIR (asagida), 1M token basina USD, model gemini-3.8-live,
  PAID tier. Kaynak: https://ai.google.dev/gemini-api/docs/pricing , okunma
  tarihi 2026-10-01. Fiyat degisirse yalniz $Fiyat tablosunu guncelle.
  Free tier'da ucret YOKTUR: cikan rakam "paid olsaydi" tahminidir, gercek
  fatura degildir.

  Varsayimlar: dusunme (thoughts) token'lari cikti metin fiyatindan, arac
  kullanimi (toolUsePrompt) token'lari girdi metin fiyatindan sayilir (tabloda
  ayri satir yoktur). Modalite kirilimi gelmeyen token "kirilimsiz" diye ayri
  gosterilir ve FIYATLANMAZ.

.PARAMETER Date
  Ozetlenecek gun (yyyyMMdd veya yyyy-MM-dd). Varsayilan: bugun (UTC).

.PARAMETER Path
  Dogrudan bir jsonl dosyasi (ornek veri / test icin). Verilirse -Date ve
  gercek log klasoru yok sayilir.

.EXAMPLE
  .\scripts\live-usage-report.ps1
  .\scripts\live-usage-report.ps1 -Date 2026-10-02
  .\scripts\live-usage-report.ps1 -Path C:\temp\ornek.jsonl
#>
[CmdletBinding()]
param(
    [string]$Date,
    [string]$Path
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'smith-common.ps1')
$inv = [System.Globalization.CultureInfo]::InvariantCulture

# --- FIYAT TABLOSU (USD / 1M token, gemini-3.8-live, paid) -------------------
# Kaynak: ai.google.dev/gemini-api/docs/pricing , 2026-10-01.
$Fiyat = @{
    'in_metin'     = 0.75
    'in_ses'       = 3.00
    'in_goruntu'   = 1.00   # goruntu ve video ayni kalem
    'out_metin'    = 4.50
    'out_ses'      = 12.00
}

if ([string]::IsNullOrWhiteSpace($Path)) {
    if ([string]::IsNullOrWhiteSpace($Date)) {
        $gun = [DateTime]::UtcNow.ToString('yyyyMMdd')
    } else {
        $ham = $Date.Trim().Replace('-', '')
        if ($ham -notmatch '^\d{8}$') {
            Write-Error "Gecersiz -Date '$Date' (yyyyMMdd veya yyyy-MM-dd bekleniyor)."
        }
        $gun = $ham
    }
    # Resolve: yan etkisiz (rapor betigi dizin olusturmaz); kok cozulemezse acik hata verir.
    $Path = Join-Path (Join-Path (Resolve-SmithDataDir) 'logs') ("live-usage-" + $gun + ".jsonl")
} else {
    $gun = '(dosya)'
}

if (-not (Test-Path -LiteralPath $Path)) {
    Write-Output "Kullanim kaydi yok: $Path"
    Write-Output 'Bu gun Live oturumu usageMetadata yollamamis ya da uygulama calismamis olabilir.'
    exit 0
}

function Get-Sayi($nesne, [string]$ad) {
    # Eksik/sayi olmayan alan 0 sayilir (eski/yeni surum satirlari karisabilir).
    $p = $nesne.PSObject.Properties[$ad]
    if ($null -eq $p -or $null -eq $p.Value) { return [double]0 }
    $d = 0.0
    if ([double]::TryParse([string]$p.Value, [System.Globalization.NumberStyles]::Float, $inv, [ref]$d)) { return $d }
    return [double]0
}

function Get-Kalem([string]$yon, [string]$modalite) {
    $m = ([string]$modalite).ToUpperInvariant()
    switch ($m) {
        'TEXT'  { return $yon + '_metin' }
        'AUDIO' { return $yon + '_ses' }
        'IMAGE' { return $yon + '_goruntu' }
        'VIDEO' { return $yon + '_goruntu' }
        default { return $yon + '_diger' }
    }
}

$kalemler = @('in_metin', 'in_ses', 'in_goruntu', 'in_diger', 'out_metin', 'out_ses', 'out_goruntu', 'out_diger')
$toplam = @{}
foreach ($k in $kalemler) { $toplam[$k] = [double]0 }
$girdiKirilimsiz = [double]0
$ciktiKirilimsiz = [double]0
$dusunme = [double]0
$aracGirdi = [double]0
$tur = 0
$bozuk = 0
$oturumlar = @{}
$ilkTs = $null
$sonTs = $null

foreach ($satir in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
    if ([string]::IsNullOrWhiteSpace($satir)) { continue }
    try {
        $o = $satir | ConvertFrom-Json
    } catch {
        $bozuk++
        continue
    }
    $tur++
    $oturumNo = [string](Get-Sayi $o 'oturum_no')
    $oturumlar[$oturumNo] = $true
    $tsP = $o.PSObject.Properties['ts']
    if ($null -ne $tsP -and $null -ne $tsP.Value) {
        # pwsh 7 ISO damgayi DateTime'a cevirir, 5.1 string birakir: ikisini
        # ayni bicime indir.
        if ($tsP.Value -is [DateTime]) {
            $ts = $tsP.Value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ', $inv)
        } else {
            $ts = [string]$tsP.Value
        }
        if ($null -eq $ilkTs -or $ts -lt $ilkTs) { $ilkTs = $ts }
        if ($null -eq $sonTs -or $ts -gt $sonTs) { $sonTs = $ts }
    }

    $girdiToplam = Get-Sayi $o 'promptTokenCount'
    $ciktiToplam = Get-Sayi $o 'responseTokenCount'
    $dusunme += Get-Sayi $o 'thoughtsTokenCount'
    $aracGirdi += Get-Sayi $o 'toolUsePromptTokenCount'

    $girdiDetay = [double]0
    $pd = $o.PSObject.Properties['promptTokensDetails']
    if ($null -ne $pd -and $null -ne $pd.Value) {
        foreach ($d in @($pd.Value)) {
            $n = Get-Sayi $d 'tokenCount'
            $toplam[(Get-Kalem 'in' $d.modality)] += $n
            $girdiDetay += $n
        }
    }
    if ($girdiToplam -gt $girdiDetay) { $girdiKirilimsiz += ($girdiToplam - $girdiDetay) }

    $ciktiDetay = [double]0
    $rd = $o.PSObject.Properties['responseTokensDetails']
    if ($null -ne $rd -and $null -ne $rd.Value) {
        foreach ($d in @($rd.Value)) {
            $n = Get-Sayi $d 'tokenCount'
            $toplam[(Get-Kalem 'out' $d.modality)] += $n
            $ciktiDetay += $n
        }
    }
    if ($ciktiToplam -gt $ciktiDetay) { $ciktiKirilimsiz += ($ciktiToplam - $ciktiDetay) }
}

# Dusunme ve arac girdisi: tabloda ayri satir yok, yukaridaki varsayimla ekle.
$fiyatliToplam = @{}
foreach ($k in $kalemler) { $fiyatliToplam[$k] = $toplam[$k] }
$fiyatliToplam['out_metin'] += $dusunme
$fiyatliToplam['in_metin'] += $aracGirdi

function Get-Usd([string]$kalem) {
    if (-not $Fiyat.ContainsKey($kalem)) { return [double]0 }
    return ($fiyatliToplam[$kalem] / 1000000.0) * $Fiyat[$kalem]
}

$etiket = @{
    'in_metin'    = 'girdi  metin'
    'in_ses'      = 'girdi  ses'
    'in_goruntu'  = 'girdi  goruntu/video'
    'in_diger'    = 'girdi  diger'
    'out_metin'   = 'cikti  metin'
    'out_ses'     = 'cikti  ses'
    'out_goruntu' = 'cikti  goruntu'
    'out_diger'   = 'cikti  diger'
}

Write-Output ''
Write-Output "Live kullanim ozeti  gun=$gun  dosya=$Path"
Write-Output ('Tur (usageMetadata ornegi): {0}   oturum: {1}' -f $tur, $oturumlar.Count)
if ($null -ne $ilkTs) { Write-Output ("Ilk kayit: {0}   son kayit: {1}  (UTC)" -f $ilkTs, $sonTs) }
if ($bozuk -gt 0) { Write-Output ("UYARI: {0} satir JSON olarak okunamadi, atlandi." -f $bozuk) }
Write-Output ''
Write-Output ('{0,-24} {1,14} {2,12} {3,12}' -f 'kalem', 'token', '$/1M', 'tahmini USD')

$usdToplam = [double]0
foreach ($k in $kalemler) {
    $tok = $fiyatliToplam[$k]
    if ($tok -le 0) { continue }
    if ($Fiyat.ContainsKey($k)) {
        $usd = Get-Usd $k
        $usdToplam += $usd
        Write-Output ('{0,-24} {1,14:N0} {2,12} {3,12}' -f $etiket[$k], $tok, $Fiyat[$k].ToString('0.00', $inv), $usd.ToString('0.0000', $inv))
    } else {
        Write-Output ('{0,-24} {1,14:N0} {2,12} {3,12}' -f $etiket[$k], $tok, '-', 'fiyatsiz')
    }
}
if ($girdiKirilimsiz -gt 0) {
    Write-Output ('{0,-24} {1,14:N0} {2,12} {3,12}' -f 'girdi  kirilimsiz', $girdiKirilimsiz, '-', 'fiyatsiz')
}
if ($ciktiKirilimsiz -gt 0) {
    Write-Output ('{0,-24} {1,14:N0} {2,12} {3,12}' -f 'cikti  kirilimsiz', $ciktiKirilimsiz, '-', 'fiyatsiz')
}
Write-Output ('{0,-24} {1,14} {2,12} {3,12}' -f 'TOPLAM (tahmini)', '', '', $usdToplam.ToString('0.0000', $inv))
Write-Output ''
if ($dusunme -gt 0) { Write-Output ("Not: {0:N0} dusunme token'i cikti metin fiyatindan eklendi." -f $dusunme) }
if ($aracGirdi -gt 0) { Write-Output ("Not: {0:N0} arac-girdi token'i girdi metin fiyatindan eklendi." -f $aracGirdi) }
Write-Output 'UYARI: Bu rakam PAID TIER FIYATLARIYLA "paid olsaydi" TAHMINIDIR (gemini-3.8-live,'
Write-Output '1M token USD: girdi metin 0.75 / ses 3.00 / goruntu-video 1.00; cikti metin 4.50 / ses 12.00;'
Write-Output 'kaynak ai.google.dev/gemini-api/docs/pricing, 2026-10-01). Free tier kullaniyorsan gercek'
Write-Output 'ucret YOKTUR; yalnizca ne kadar tuketildigini ve kotaya yakinligi gosterir.'
exit 0
