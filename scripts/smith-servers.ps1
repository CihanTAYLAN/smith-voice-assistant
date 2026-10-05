# Smith algi sunucularini GORUNMEZ baslatir/durdurur/durumunu gosterir.
#
# Neden VBS sarmalayici: `Start-Process pwsh -WindowStyle Minimized` Windows'ta
# yine bir konsol penceresi cizer (ekranda gorunur). WScript.Shell.Run 0 ile
# pencere hic olusturulmaz.
#
# Kullanim:
#   .\scripts\smith-servers.ps1 start   # ses izi sunucusu (gizli)
#   .\scripts\smith-servers.ps1 stop
#   .\scripts\smith-servers.ps1 status
param(
    [ValidateSet("start", "stop", "status")]
    [string]$Action = "status",
    # SES IZI SUNUCUSU (:8124) tek algi sunucusudur. `dev-win.ps1`
    # `SMITH_SPEAKER_SIDECAR`i set ediyor, yani kapi ACIK; sunucu yoksa
    # dogrulayici KULLANILAMIYOR sayilir ve mutasyon ile gizlilik araclarinin
    # TAMAMI kapali kalir (fail-closed, `DENY_UNAVAILABLE`, bkz. audio/speaker.rs);
    # sunucu yanit verince kapi kendiliginden acilir -- yoklugu en cok belirti
    # ureten sunucu bu.
    #
    # 2026-08-17: stt-sidecar / stt-wlk / tts-piper girdileri KALDIRILDI. Basamakli
    # ses hatti sokuldugu icin o uc sunucu Smith'te hicbir sey yapmiyordu; script'leri
    # de silindi.
    [string[]]$Only = @("speaker")
)

. (Join-Path $PSScriptRoot 'smith-common.ps1')
$repo = Split-Path -Parent $PSScriptRoot
$logDir = Get-SmithLogDir   # <veri koku>\logs (olusturur)

# ad => @(script, port)
$servers = [ordered]@{
    # Ses izi: yoklugu hafizaya yazmayi sessizce kilitledigi icin varsayilan
    # sette ILK sirada. Kayit (bir kere): .\scripts\speaker-enroll.ps1
    "speaker"     = @("$repo\scripts\speaker-server.ps1", 8124)
}

function Test-Port([int]$port) {
    [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Start-Hidden([string]$name, [string]$script) {
    $log = Join-Path $logDir "$name.log"
    # WScript.Shell.Run(..., 0, $false): pencere HIC olusturulmaz.
    # `Start-Process -WindowStyle Minimized` ise konsol penceresi cizer.
    $cmd = 'cmd /c ""' + $env:ProgramFiles + '\PowerShell\7\pwsh.exe" -NoProfile -File "' +
           $script + '" > "' + $log + '" 2>&1"'
    $sh = New-Object -ComObject WScript.Shell
    $sh.Run($cmd, 0, $false) | Out-Null
    Write-Host "[start] $name (gizli) -> $log"
}

switch ($Action) {
    "start" {
        foreach ($name in $servers.Keys) {
            if ($Only -notcontains $name) { continue }
            $script, $port = $servers[$name]
            if (Test-Port $port) { Write-Host "[atla] $name zaten :$port dinliyor"; continue }
            Start-Hidden $name $script
        }
        Write-Host "`nModeller yuklenirken 20-30 sn gecebilir; durum: .\scripts\smith-servers.ps1 status"
    }
    "stop" {
        foreach ($name in $servers.Keys) {
            $script, $port = $servers[$name]
            $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
            foreach ($c in $conns) {
                Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
                Write-Host "[stop] $name (pid $($c.OwningProcess))"
            }
        }
    }
    "status" {
        foreach ($name in $servers.Keys) {
            $script, $port = $servers[$name]
            $state = if (Test-Port $port) { "AYAKTA" } else { "kapali" }
            Write-Host ("{0,-12} :{1,-5} {2}" -f $name, $port, $state)
        }
        Write-Host "loglar: $logDir"
    }
}
