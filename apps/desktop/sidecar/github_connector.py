"""Smith GitHub konnektoru (ADR 0004 F1).

`gh` WSL'de auth'lu; repo meta'sini oradan ceker, POST'u Windows'tan gateway'e
atar (WSL->Windows localhost NAT'ta kapali, ters yon acik degil). Her repo =
1 hafiza kaydi. Gemini free-tier embed RPM limitine takilmamak icin istekler
arasi bekleme var. Gorunurluk -> gizlilik: PUBLIC=public, private=personal
(repo meta'si sir DEGERI icermez; sadece baglam). @smith/protocol degismez.
"""
from __future__ import annotations
import json, os, subprocess, sys, time, urllib.request

GW = "http://127.0.0.1:4100"
WS = "ws_b98888ec6fe14f64bc57ca2ff599c31f"
EMAIL = "cihan@example.test"
SLEEP = 0.9  # ~66 istek/dk


def login() -> str:
    req = urllib.request.Request(
        f"{GW}/v1/dev/login",
        data=json.dumps({"email": EMAIL, "workspaceId": WS}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)["token"]


def repos() -> list[dict]:
    # gh WSL'de. TUZAK: wsl.exe varsayilan UTF-16 yazar → Python None/bozuk
    # gorur; WSL_UTF8=1 temiz UTF-8'e zorlar. Yine de bytes alip guvenli decode.
    env = {**os.environ, "WSL_UTF8": "1"}
    out = subprocess.run(
        ["wsl", "-d", "Ubuntu", "--", "bash", "-lc",
         "gh repo list --limit 200 --json name,description,primaryLanguage,visibility,pushedAt"],
        capture_output=True, timeout=60, env=env,
    )
    if out.returncode != 0:
        print("gh hata:", (out.stderr or b"").decode("utf-8", "replace")[:300]); sys.exit(1)
    text = (out.stdout or b"").decode("utf-8", "replace").lstrip("﻿").strip()
    if not text:
        print("gh bos dondu"); sys.exit(1)
    return json.loads(text)


def remember(token: str, content: str, key: str, sens: str) -> int:
    body = json.dumps({
        "content": content, "key": key,
        "sourceType": "github", "sensitivity": sens,
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


def main() -> int:
    token = login()
    rs = repos()
    print(f"toplam repo: {len(rs)}")
    ok = fail = 0
    for r in rs:
        name = r["name"]
        desc = (r.get("description") or "aciklama yok").strip()
        lang = (r.get("primaryLanguage") or {}).get("name", "?")
        vis = r.get("visibility", "PRIVATE")
        pushed = (r.get("pushedAt") or "").split("T")[0]
        sens = "public" if vis == "PUBLIC" else "personal"
        content = (f"GitHub repo '{name}' (owner): {desc}. "
                   f"Dil: {lang}. Gorunurluk: {vis}. Son guncelleme: {pushed}.")
        code = remember(token, content, f"github:{name}", sens)
        if code == 200:
            ok += 1
        else:
            fail += 1
            print(f"  HATA {code}: {name}")
        time.sleep(SLEEP)
    print(f"GitHub konnektor bitti: {ok} yazildi, {fail} hata.")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
