# Smith ses izi KAYDI (enrollment) - bir kere calistirilir.
#
# NE YAPAR: mikrofondan SEKIZ cumle kaydeder (~40 sn ham ses), her birinin ses
# izi embedding'ini cikarir ve PROTOTIP SETI olarak
# <veri koku>\speaker\owner.npy dosyasina yazar (0. satir centroid,
# sonrasi tek tek ornekler). Once KAYITTA KULLANILMAYAN yeni bir ifadeyle
# kendi kendini dogrular, skoru basar ve kayit onayi ister (gorulmemis ses sarti bilincli:
# kendi kayitlariyla test etmek kanit degildir).
#
# Ses tonu/hiz degisir, mikrofon sabit kalir: kulaklikta mesafe degismez;
# basi cevirmek gurultu bastirmasinin konusmayi kesmesine neden olabilir.
# Her deneme gurultu tabanina gore olculur. Uc gecersiz denemede yazmadan durur.
# Yalniz acik kayit onayiyla eski owner.npy yedeklenir ve yeni referans yazilir.
#
# Eski uyarlama prototipleri (owner_adapt.npy) SILINIR: yeni kayit temiz bir
# baslangictir.
#
# Ayrica olculen ayni-kisi benzerlik dagilimini yazar ve gerekiyorsa esik onerir.
#
# KULLANIM:
#   .\scripts\speaker-enroll.ps1                        # mikrofondan (normal yol)
#   .\scripts\speaker-enroll.ps1 -Device "Mikrofon (Fuxi-H7)" # cihaz adi veya indeksi
#   .\scripts\speaker-enroll.ps1 -FromWav a.wav b.wav   # WAV'lardan (kuru calisma)
#
# Kayit sirasinda ODADA YALNIZ CIHAN KONUSSUN - referansa baska bir ses karisirsa
# kapi o sesi de sahip sayar ve tum koruma anlamsizlasir.
param(
    [string[]]$FromWav = @(),
    [string]$Device = ""
)

$ErrorActionPreference = "Stop"
$side = Join-Path (Split-Path $PSScriptRoot -Parent) "apps\desktop\sidecar"
Set-Location $side

# SMITH ACIKKEN KAYIT YAPILAMAZ. Iki ayri sekilde bozar:
#   1. Smith cumleleri duyup SESLI CEVAP verir; kendi sesi mikrofona kacar ve
#      referansa karisir - o andan itibaren kapi Smith'in kendi sesini de
#      "sahip" sayar, yani koruma anlamsizlasir.
#   2. Mikrofonu paylasmak kayit seviyesini ongorulemez hale getirir.
# Sessizce devam etmek yerine durup soyluyoruz: bozuk bir referans, hic
# kayit olmamasindan daha kotudur.
$acik = Get-Process -Name smith-desktop -ErrorAction SilentlyContinue
if ($acik) {
    Write-Host ""
    Write-Host "  Smith su anda CALISIYOR (pid $($acik.Id -join ', ')) ve mikrofonu dinliyor." -ForegroundColor Yellow
    Write-Host "  Kayit sirasinda sesli cevap verir, kendi sesi referansa karisir." -ForegroundColor Yellow
    Write-Host ""
    $c = Read-Host "  Kapatip devam edeyim mi? (E/h)"
    if ($c -eq "" -or $c -match '^[eEyY]') {
        $acik | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 800
        Write-Host "  Smith kapatildi. Kayit bitince yeniden baslat:" -ForegroundColor Green
        Write-Host "    pwsh -NoProfile -File scripts/smith-up.ps1" -ForegroundColor Green
        Write-Host ""
    } else {
        throw "[speaker] Smith acikken kayit yapilmaz - once kapat."
    }
}

if (-not (Test-Path ".venv")) {
    Write-Host "[speaker] venv kuruluyor..."
    uv venv .venv | Out-Host
}
$py = Join-Path $side ".venv\Scripts\python.exe"
# sounddevice mikrofon kaydi icin; sherpa-onnx ses izi modeli icin.
uv pip install -p $py -q sherpa-onnx numpy sounddevice | Out-Host

if ($FromWav.Count -gt 0) {
    & $py speaker_server.py --enroll-from-wav @FromWav
} else {
    $enrollArgs = @("speaker_server.py", "--enroll")
    if ($Device -ne "") { $enrollArgs += @("--device", $Device) }
    & $py @enrollArgs
}
if ($LASTEXITCODE -ne 0) { throw "[speaker] kayit basarisiz (exit $LASTEXITCODE)" }

Write-Host ""
Write-Host "Smith'i yeniden baslat:" -ForegroundColor Green
Write-Host "  pwsh -NoProfile -File scripts/smith-up.ps1" -ForegroundColor Green
