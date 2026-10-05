"""Smith cihaz envanteri konnektoru (ADR 0004 F3).

Kullanicinin DIGER cihazlarini (Mac `m2`, sunucu `server`) SSH ile yoklar ve
ozetini hafizaya yazar; ayrica YEREL makinenin donanim ozetini. Amac: Smith
"hangi cihazlarim var, server'te ne kosuyor" gibi sorulari TAHMINLE degil
gercek veriyle cevaplasin.

Tasarim:
- Salt-OKUR komutlar; hicbir uzak degisiklik yapilmaz.
- Cihaz erisilemezse ATLANIR (hata degil) — dizustu kapali olabilir; Smith
  "erisemedim" demeyi bilsin diye durum da kaydedilir.
- TUZAK (hafizada kayitli): `ssh m2 'bash -s'` non-login → PATH bos. Mac'te
  `zsh -lc` kullanilir.
- Gizlilik: cihaz envanteri 'personal' (Live'da gorunur; sir degeri yok).
- Tekrar calistirilabilir: sourceId `device:<ad>` → upsert.
"""
from __future__ import annotations
import json, os, subprocess, sys, urllib.request

GW = "http://127.0.0.1:4100"
WS = "ws_b98888ec6fe14f64bc57ca2ff599c31f"
EMAIL = "cihan@example.test"
TIMEOUT = 25


def login() -> str:
    req = urllib.request.Request(
        f"{GW}/v1/dev/login",
        data=json.dumps({"email": EMAIL, "workspaceId": WS}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)["token"]


def remember(token: str, content: str, key: str) -> int:
    body = json.dumps({
        "content": content, "key": key,
        "sourceType": "device", "sensitivity": "personal",
    }).encode()
    req = urllib.request.Request(
        f"{GW}/v1/tools/memory/remember", data=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def ssh(host: str, remote_cmd: str) -> tuple[bool, str]:
    """SSH ile salt-okur komut. (basari, cikti)."""
    try:
        p = subprocess.run(
            ["ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", host, remote_cmd],
            capture_output=True, timeout=TIMEOUT,
        )
        out = (p.stdout or b"").decode("utf-8", "replace").strip()
        if p.returncode != 0 and not out:
            return False, (p.stderr or b"").decode("utf-8", "replace").strip()[:200]
        return True, out
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"


def local_summary() -> str:
    """Yerel makine (Windows) donanim ozeti."""
    ps = (
        "$os=Get-CimInstance Win32_OperatingSystem;"
        "$c=Get-CimInstance Win32_Processor|Select-Object -First 1;"
        "$g=Get-CimInstance Win32_VideoController|Select-Object -First 1;"
        "\"$($c.Name) | $($c.NumberOfLogicalProcessors) thread | \" + "
        "\"RAM $([math]::Round($os.TotalVisibleMemorySize/1MB,1))GB | GPU $($g.Name) | $($os.Caption)\""
    )
    p = subprocess.run(["powershell.exe", "-NoProfile", "-Command", ps],
                       capture_output=True, timeout=TIMEOUT)
    return (p.stdout or b"").decode("utf-8", "replace").strip()


def main() -> int:
    token = login()
    written = failed = 0

    def store(content: str, key: str, label: str) -> None:
        nonlocal written, failed
        code = remember(token, content, key)
        if code == 200:
            written += 1
            print(f"{label}: yazildi")
        else:
            failed += 1
            print(f"{label}: HATA {code}")

    # 1) Yerel makine
    loc = local_summary()
    if loc:
        content = (f"Cihan'in ana gelistirme makinesi (Windows, bu bilgisayarda Smith kurulu): {loc}. "
                   "Smith'in sistem araclari bu makinede kosar.")
        store(content, "device:windows-ana", "yerel")

    # 2) MacBook m2 — zsh -lc SART (non-login shell'de PATH bos)
    ok, out = ssh("m2", "zsh -lc 'sw_vers -productVersion; sysctl -n hw.ncpu; "
                        "echo $(( $(sysctl -n hw.memsize) / 1073741824 ))GB; "
                        "ls ~/workspace 2>/dev/null | head -8'")
    if ok and out:
        lines = [l.strip() for l in out.splitlines() if l.strip()]
        ver = lines[0] if lines else "?"
        cpu = lines[1] if len(lines) > 1 else "?"
        ram = lines[2] if len(lines) > 2 else "?"
        projects = ", ".join(lines[3:]) or "workspace bos/yok"
        content = (f"Cihan'in MacBook Air M2 cihazi (SSH: 'ssh m2', 192.168.1.105): "
                   f"macOS {ver}, {cpu} cekirdek, {ram} RAM. Workspace projeleri: {projects}. "
                   "Smith'in Apple hatti (iOS/watchOS/macOS build) bu cihazda kosar.")
        store(content, "device:m2", "m2")
    else:
        print(f"m2: erisilemedi ({out[:80]})")
        store(
            "Cihan'in MacBook Air M2 cihazi 'ssh m2' ile erisilebilir "
            "(192.168.1.105) ama son yoklamada kapali/erisilemezdi.",
            "device:m2",
            "m2 durum",
        )

    # 3) server sunucu
    ok, out = ssh("server", "hostname; nproc; free -g | awk '/Mem:/{print $2\"GB toplam, \"$7\"GB bos\"}'; "
                            "df -h / | tail -1 | awk '{print $4\" bos\"}'; "
                            "docker ps --format '{{.Names}}' 2>/dev/null | head -10")
    if ok and out:
        lines = [l.strip() for l in out.splitlines() if l.strip()]
        host = lines[0] if lines else "server"
        cpu = lines[1] if len(lines) > 1 else "?"
        ram = lines[2] if len(lines) > 2 else "?"
        disk = lines[3] if len(lines) > 3 else "?"
        services = ", ".join(lines[4:]) or "docker servisi gorunmuyor"
        content = (f"Cihan'in uzak Linux sunucusu server (SSH: 'ssh server', <server-ip>, host {host}): "
                   f"{cpu} cekirdek, RAM {ram}, disk {disk}. Calisan docker servisleri: {services}.")
        store(content, "device:server", "server")
    else:
        print(f"server: erisilemedi ({out[:80]})")
        store(
            "Cihan'in uzak Linux sunucusu server 'ssh server' ile erisilebilir "
            "(<server-ip>) ama son yoklamada kapali/erisilemezdi.",
            "device:server",
            "server durum",
        )

    print(f"Cihaz konnektoru bitti: {written} yazildi, {failed} hata.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
