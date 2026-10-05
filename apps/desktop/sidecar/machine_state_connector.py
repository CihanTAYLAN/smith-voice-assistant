"""Smith makine durumu konnektoru — surekli farkindalik katmani (ADR 0006).

Amac: Smith kurulu oldugu makinenin donanimini, disk doluluk egilimini ve
hangi servislerin ayakta oldugunu BILEREK konussun.

`sistem_durumu` ARACIYLA KARISTIRILMAMALI. O arac ANLIK sorgu yapar ("su an
CPU %23") ve dogru yer orasidir. Bu konnektor TARIHSEL/BAGLAMSAL bilgi yazar:
"bu makinede RTX 5060 var", "C: surucusu %97 dolu", "postgres 5433'te
kosuyor". Anlik degeri hafizaya yazmak iki kat zarardir — hem gurultu, hem
her kosuda bosa embed.

KOTA — snapshot'a NE GIRMEZ
---------------------------
Delta kapisi snapshot'in birebir esitligine bakar; snapshot'a giren her
oynak alan saatlik bir embed demektir. Bu yuzden KASTEN DISLANANLAR:
  - CPU/RAM kullanim yuzdesi, VRAM kullanimi, load — surekli oynar
  - uptime SURESI — her saniye degisir. Yerine ACILIS ZAMANI yazilir: yeniden
    baslatilana kadar sabittir, yani dogru delta davranisi verir.
  - docker "Up 7 hours" durum metni — yerine yalniz container ADI + imaj
  - disk bos alani HAM BAYT — yerine %5'lik kova (mandat: "disk %5+ degistiyse")

Uc kayit yazilir (kok basina degil, toplam):
  machine:donanim   → CPU/GPU/RAM/OS/acilis + WSL durumu
  machine:disk      → her surucu icin toplam/bos/%dolu (kovali)
  machine:servisler → docker container'lari + dinlenen Smith portlari

Kullanim:
  python machine_state_connector.py --dry-run
  python machine_state_connector.py
  python machine_state_connector.py --force
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

import smith_paths

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:  # pragma: no cover
    pass

GW = "http://127.0.0.1:4100"
WS = "ws_b98888ec6fe14f64bc57ca2ff599c31f"
EMAIL = "cihan@example.test"
SOURCE_TYPE = "machine"
SENSITIVITY = "personal"

# DURUM DIZINI tek veri kokunun altinda (smith_paths.data_root: SMITH_DATA_DIR ya da
# %USERPROFILE%.smith); AppData tabanli DEGIL. MSIX tuzagi (zamanlanmis gorev ile
# paketli uygulama ayni yolu farkli gorur, delta durumu her kosuda "bos" gorunur ve
# kota bosa yanar) ve gerekce: smith_paths.py basligi.
STATE_DIR = smith_paths.data_root() / "awareness"
STATE_FILE = STATE_DIR / "machine_state.json"

#: Disk doluluk kovasi (yuzde puani). Mandat: "disk %5+ degistiyse yaz".
DISK_BUCKET_PCT = 5

#: Smith'in kendi servis portlari — bunlarin ayakta olup olmadigi Smith icin
#: gercek baglamdir ("neden konusamiyorum" sorusunun cevabi burada).
SMITH_PORTS = {
    4100: "gateway (hono HTTP + WS)",
    5433: "postgres (pgvector, smith-dev-postgres-1)",
    6380: "redis (smith-dev-redis-1)",
    8000: "WhisperLiveKit STT (WS)",
    8123: "faster-whisper STT sidecar (TCP)",
    8124: "konusmaci tanima (speaker) sunucusu",
    5000: "Piper TTS HTTP",
}

PS_TIMEOUT = 60


def run_ps(script: str) -> str | None:
    """PowerShell'i -NoProfile ile kosar. Cikti UTF-8 zorlanir."""
    try:
        p = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            timeout=PS_TIMEOUT,
        )
        if p.returncode != 0:
            print(f"    UYARI: powershell probe exit {p.returncode}", flush=True)
            return None
        return (p.stdout or b"").decode("utf-8", "replace").strip()
    except Exception as e:  # noqa: BLE001 — probe basarisiz: alan bos kalir
        print(f"    UYARI: powershell probe basarisiz: {type(e).__name__}: {e}", flush=True)
        return None


def run_cmd(args: list[str], timeout: int = 30) -> str | None:
    try:
        p = subprocess.run(args, capture_output=True, timeout=timeout)
        if p.returncode != 0:
            return None
        return (p.stdout or b"").decode("utf-8", "replace").strip()
    except Exception:  # noqa: BLE001 — arac yok/zaman asimi: bos don
        return None


# --------------------------------------------------------------------------
# Gateway
# --------------------------------------------------------------------------


def login() -> str:
    req = urllib.request.Request(
        f"{GW}/v1/dev/login",
        data=json.dumps({"email": EMAIL, "workspaceId": WS}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)["token"]


def remember(token: str, content: str, key: str) -> int:
    body = json.dumps(
        {"content": content, "key": key, "sourceType": SOURCE_TYPE, "sensitivity": SENSITIVITY}
    ).encode()
    req = urllib.request.Request(
        f"{GW}/v1/tools/memory/remember",
        data=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:  # noqa: BLE001
        return 0


def remember_with_backoff(token: str, content: str, key: str, waits: list[float]) -> int:
    code = remember(token, content, key)
    for wait in waits:
        if code == 200:
            return code
        print(f"    kota/hata {code} -> {wait:.0f}s bekle, tekrar", flush=True)
        time.sleep(wait)
        code = remember(token, content, key)
    return code


# --------------------------------------------------------------------------
# Durum dosyasi
# --------------------------------------------------------------------------


def load_state() -> dict:
    if not STATE_FILE.exists():
        return {"version": 1, "kayitlar": {}}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        print(f"UYARI: durum dosyasi okunamadi ({e}); sifirdan varsayiliyor.", flush=True)
        return {"version": 1, "kayitlar": {}}


def save_state(state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(STATE_FILE)


# --------------------------------------------------------------------------
# Toplayicilar
# --------------------------------------------------------------------------

HW_PS = r"""
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$gpus = Get-CimInstance Win32_VideoController
$o = [ordered]@{
  cpu    = $cpu.Name.Trim()
  cekirdek = [int]$cpu.NumberOfCores
  thread = [int]$cpu.NumberOfLogicalProcessors
  ram_gb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
  os     = "$($os.Caption) build $($os.BuildNumber)"
  acilis = $os.LastBootUpTime.ToString('yyyy-MM-dd HH:mm')
  gpu    = @($gpus | ForEach-Object { "$($_.Name) (surucu $($_.DriverVersion))" })
}
$o | ConvertTo-Json -Compress -Depth 4
"""

DISK_PS = r"""
$rows = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  [ordered]@{
    surucu  = $_.DeviceID
    etiket  = if ($_.VolumeName) { $_.VolumeName } else { '' }
    toplam_gb = [math]::Round($_.Size / 1GB, 1)
    bos_gb    = [math]::Round($_.FreeSpace / 1GB, 1)
    dolu_pct  = if ($_.Size -gt 0) { [math]::Round((($_.Size - $_.FreeSpace) / $_.Size) * 100, 1) } else { 0 }
  }
}
ConvertTo-Json -InputObject @($rows) -Compress -Depth 4
"""


def collect_hardware() -> dict:
    raw = run_ps(HW_PS)
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        print(f"    UYARI: donanim JSON cozulemedi: {raw[:120]}", flush=True)
        return {}

    # nvidia-smi varsa VRAM TOPLAMINI oradan al. Win32_VideoController.AdapterRAM
    # 32-bit tasmasi yuzunden 8GB karti "4GB" gosterir (olculdu: RTX 5060 →
    # 4GB yaziyor, nvidia-smi 8151 MiB diyor). Yanlis donanim bilgisini hafizaya
    # yazmak, hic yazmamaktan kotudur.
    smi = run_cmd(
        ["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"]
    )
    nvidia: list[str] = []
    for line in (smi or "").splitlines():
        cols = [c.strip() for c in line.split(",")]
        if len(cols) >= 2:
            nvidia.append(f"{cols[0]} VRAM {cols[1]}" + (f" surucu {cols[2]}" if len(cols) > 2 else ""))
    if nvidia:
        data["nvidia"] = nvidia

    # WSL dagitim durumu. TUZAK (hafizada kayitli): `wsl -l -v` ciktisi
    # UTF-16LE'dir → WSL_UTF8=1 olmadan okunamaz.
    env = {**os.environ, "WSL_UTF8": "1"}
    try:
        p = subprocess.run(["wsl", "-l", "-v"], capture_output=True, timeout=25, env=env)
        wsl_raw = (p.stdout or b"").decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        wsl_raw = ""
    distros: list[str] = []
    for line in wsl_raw.splitlines()[1:]:
        line = line.replace("\x00", "").strip().lstrip("*").strip()
        if not line:
            continue
        cols = re.split(r"\s{2,}|\t", line)
        cols = [c for c in (c.strip() for c in cols) if c]
        if len(cols) >= 2:
            distros.append(f"{cols[0]}: {cols[1]}")
    if distros:
        data["wsl"] = distros
    return data


def collect_disks() -> list[dict]:
    raw = run_ps(DISK_PS)
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        print(f"    UYARI: disk JSON cozulemedi: {raw[:120]}", flush=True)
        return []
    return data if isinstance(data, list) else [data]


def collect_services() -> dict | None:
    """Docker container'lari + dinlenen Smith portlari.

    Docker'in "Up 7 hours" durum metni KASTEN alinmaz: her kosuda degisir ve
    snapshot'i her saat farkli kilar (bosa embed). Container'in VARLIGI
    bilgidir, ne kadar suredir ayakta oldugu anlik veridir.
    """
    containers: list[str] = []
    raw = run_cmd(["docker", "ps", "--format", "{{.Names}}|{{.Image}}"])
    if raw is None:
        return None
    for line in raw.splitlines():
        name, _, image = line.partition("|")
        name = name.strip()
        # buildkit builder container'i gecici bir build artefaktidir; adinda
        # rastgele UUID tasir ve her build'de degisir → snapshot gurultusu.
        if not name or name.startswith("buildx_buildkit_"):
            continue
        containers.append(f"{name} ({image.strip()})")

    ports_raw = run_ps(
        "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | "
        "Select-Object -ExpandProperty LocalPort | Sort-Object -Unique"
    )
    if ports_raw is None:
        return None
    listening: set[int] = set()
    for line in ports_raw.splitlines():
        line = line.strip()
        if line.isdigit():
            listening.add(int(line))
    smith_up = sorted(p for p in SMITH_PORTS if p in listening)
    smith_down = sorted(p for p in SMITH_PORTS if p not in listening)
    return {
        "docker": sorted(containers),
        "smith_acik": smith_up,
        "smith_kapali": smith_down,
    }


# --------------------------------------------------------------------------
# Snapshot + icerik
# --------------------------------------------------------------------------


def bucket_pct(pct: float) -> int:
    return int(round(float(pct) / DISK_BUCKET_PCT)) * DISK_BUCKET_PCT


def hw_records(hw: dict) -> tuple[dict, str] | None:
    if not hw:
        return None
    gpu_txt = ", ".join(hw.get("nvidia") or hw.get("gpu") or []) or "GPU bilgisi yok"
    wsl_txt = ", ".join(hw.get("wsl") or []) or "WSL dagitimi gorunmuyor"
    # Snapshot = icerigi belirleyen TUM alanlar; oynak alan girmez.
    snap = {
        "cpu": hw.get("cpu"),
        "cekirdek": hw.get("cekirdek"),
        "thread": hw.get("thread"),
        "ram_gb": hw.get("ram_gb"),
        "os": hw.get("os"),
        "acilis": hw.get("acilis"),
        "gpu": hw.get("nvidia") or hw.get("gpu"),
        "wsl": hw.get("wsl"),
    }
    content = (
        "Smith'in kurulu oldugu ana makine (Cihan'in Windows gelistirme "
        f"bilgisayari) donanim durumu: CPU {hw.get('cpu')} "
        f"({hw.get('cekirdek')} cekirdek / {hw.get('thread')} thread), "
        f"RAM {hw.get('ram_gb')} GB, GPU {gpu_txt}. "
        f"Isletim sistemi {hw.get('os')}. Son acilis (boot) {hw.get('acilis')}. "
        f"WSL dagitimlari: {wsl_txt}. "
        "Bu makine ayni zamanda Smith'in yerel algi sunucusudur: STT ve TTS "
        "sidecar'lari bu GPU'da kosar. Anlik CPU/RAM/VRAM kullanimi bu kayitta "
        "YOKTUR — onu 'sistem_durumu' araci canli sorgular."
    )
    return snap, content


def disk_records(disks: list[dict]) -> tuple[dict, str] | None:
    if not disks:
        return None
    snap = {}
    for d in disks:
        dolu_kova = bucket_pct(d["dolu_pct"])
        toplam_gb = float(d["toplam_gb"])
        snap[d["surucu"]] = {
            "toplam_gb": d["toplam_gb"],
            # Icerik de bu normalize degerleri kullanir. Boylece snapshot esit
            # ise yazilacak metin de esittir.
            "dolu_kova": dolu_kova,
            "bos_gb_kova": round(toplam_gb * (100 - dolu_kova) / 100, 1),
            "kritik": float(d["dolu_pct"]) >= 90,
        }
    lines: list[str] = []
    alerts: list[str] = []
    for d in disks:
        disk_snap = snap[d["surucu"]]
        label = f" '{d['etiket']}'" if d.get("etiket") else ""
        lines.append(
            f"{d['surucu']}{label} toplam {disk_snap['toplam_gb']} GB, "
            f"yaklasik {disk_snap['bos_gb_kova']} GB bos, %{disk_snap['dolu_kova']} dolu"
        )
        if disk_snap["kritik"]:
            alerts.append(
                f"{d['surucu']} surucusu %{disk_snap['dolu_kova']} dolu ve yaklasik "
                f"{disk_snap['bos_gb_kova']} GB bos kaldi — build, docker imaji ve model "
                "indirmeleri icin kritik esikte"
            )
    content = (
        "Smith'in kurulu oldugu ana makinenin (Windows) disk doluluk durumu: "
        + "; ".join(lines)
        + "."
    )
    if alerts:
        content += " DIKKAT: " + " ".join(alerts) + "."
    content += (
        " Bu degerler saatlik tazelenir; doluluk %5'lik esiklerle takip edilir."
    )
    return snap, content


def service_records(svc: dict | None) -> tuple[dict, str] | None:
    if svc is None:
        return None
    snap = {
        "docker": svc["docker"],
        "acik": svc["smith_acik"],
        "kapali": svc["smith_kapali"],
    }
    docker_txt = ", ".join(svc["docker"]) or "calisan docker container'i yok"
    up_txt = (
        ", ".join(f"{p} = {SMITH_PORTS[p]}" for p in svc["smith_acik"])
        or "Smith servis portlarinin hicbiri dinlemiyor"
    )
    down_txt = (
        ", ".join(f"{p} = {SMITH_PORTS[p]}" for p in svc["smith_kapali"]) or "yok"
    )
    content = (
        f"Smith'in ana makinesinde calisan servisler. Docker container'lari: {docker_txt}. "
        f"Dinlenen (AYAKTA) Smith servis portlari: {up_txt}. "
        f"Su an KAPALI olan Smith portlari: {down_txt}. "
        "Postgres 5433 ve redis 6380'de kosar (5432 ve 6379 BASKA projelere "
        "aittir, Smith onlari kullanmaz). Bir yetenek calismiyorsa once ilgili "
        "portun ayakta olup olmadigina bakilir."
    )
    return snap, content


# --------------------------------------------------------------------------


def main() -> int:
    smith_paths.warn_if_legacy_data()
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="POST yok; snapshot ve icerigi basar.")
    ap.add_argument("--force", action="store_true", help="Snapshot esit olsa da yazar.")
    args = ap.parse_args()

    state = load_state()
    saved: dict = state.setdefault("kayitlar", {})
    print(f"Makine durumu toplaniyor. Durum dosyasi: {STATE_FILE}", flush=True)

    built: list[tuple[str, dict, str]] = []  # (key, snapshot, content)

    hw = hw_records(collect_hardware())
    if hw:
        built.append(("machine:donanim", hw[0], hw[1]))
    else:
        print("  donanim: toplanamadi, atlandi", flush=True)

    dk = disk_records(collect_disks())
    if dk:
        built.append(("machine:disk", dk[0], dk[1]))
    else:
        print("  disk: toplanamadi, atlandi", flush=True)

    sv = service_records(collect_services())
    if sv:
        built.append(("machine:servisler", sv[0], sv[1]))
    else:
        print("  servisler: toplanamadi, atlandi", flush=True)

    pending: list[tuple[str, dict, str]] = []
    for key, snap, content in built:
        prev = (saved.get(key) or {}).get("snapshot")
        # DELTA KAPISI — snapshot birebir esitse POST hic denenmez (0 embed).
        if prev == snap and not args.force:
            print(f"  {key}: DEGISMEDI -> POST atlandi (0 embed)", flush=True)
            continue
        if prev:
            changed = [k for k in set(prev) | set(snap) if prev.get(k) != snap.get(k)]
            print(f"  {key}: DEGISTI -> alanlar: {', '.join(sorted(changed)) or '?'}", flush=True)
        else:
            print(f"  {key}: ILK KAYIT -> yazilacak", flush=True)
        pending.append((key, snap, content))

    if args.dry_run:
        for key, snap, content in pending:
            print(f"\n--- {key}\n{content}\n    snapshot: {json.dumps(snap, ensure_ascii=False)[:400]}")
        print(f"\nKURU CALISTIRMA: {len(pending)} kayit uretildi, POST yapilmadi.", flush=True)
        print("EMBED HARCANAN: 0 (kuru calistirma)", flush=True)
        return 0

    if not pending:
        print("Makine durumu bitti: degisiklik yok.", flush=True)
        print("EMBED HARCANAN: 0", flush=True)
        return 0

    token = login()
    ok = fail = 0
    for key, snap, content in pending:
        code = remember_with_backoff(token, content, key, [30.0, 90.0])
        if code == 200:
            ok += 1
            saved[key] = {
                "snapshot": snap,
                "yazildi": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
            save_state(state)
            print(f"  yazildi: {key}", flush=True)
        else:
            fail += 1
            print(f"  HATA {code}: {key}", flush=True)
        time.sleep(0.9)

    print(f"Makine durumu bitti: {ok} yazildi, {fail} hata.", flush=True)
    print(f"EMBED HARCANAN: {ok + fail} (basarili {ok})", flush=True)
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
