"""Smith kod/workspace konnektoru (ADR 0004 F2).

Amac: Smith "X projesinde ne var" ve "neredeydim" sorularini TAHMINLE degil
gercek repo verisiyle cevaplasin. Kaynak: WSL `~/workspace` altindaki git
repolari + Windows `smith-monorepo`.

Repo basina 2 kayit yazilir (dosya basina DEGIL — Gemini free-tier embed
kotasi dosya-granulerligini kaldirmaz):
  code:<repo>:ozet   → README ozeti + dil dagilimi + ust duzey dizin yapisi
  code:<repo>:durum  → branch, commit sayisi, son 5 commit, TODO sayisi
Git gecmisi olmayan repoda `durum` bos bir iskelet degil, bu durumu ANLATAN bir
metin olur; icerigi bos kayit semantik aramada gercek repoyu geride birakiyordu.

TEKRAR CALISTIRILABILIR: sourceId `code:<repo>:<bolum>` → upsert. Gateway her
POST'ta yeniden embed uretir, bu yuzden yazilmis kaydi tekrar gondermek bosa
kota harcar; `--exclude-file` (satir basina bir sourceId, DB'den uretilir)
POST'u tamamen atlar.

GIZLILIK (ADR 0004 kirmizi cizgisi). Iki katmanli, tek kaynakli kara liste:
  1. Repo KESFI kara listeden gecirilir. Kesif bilincli olarak PRUNE'SUZ
     yapilir (`find -name .git`), boylece reddedilen her repo LOG'a duser —
     "prune ettim" iddiasi degil, gorunur kanit. `customers/` ve
     `github-backup/` altindaki musteri repolari burada elenir.
  2. Dosya listesi `git ls-files` ile alinir (takipli dosyalar → node_modules,
     target, .venv zaten yok) ve her yol ayrica kara listeden gecirilir;
     `.env`, `id_rsa`, `id_ed25519`, `*.pem`, ham `*.sql` dokumleri ne OKUNUR
     ne de dil/yapi ozetine girer.
Kara liste tek yerde tanimlidir (BLACKLIST_*); `--audit-blacklist` onu
calistirip verdict'i basar. Salt-okur: hicbir repo degistirilmez.

Kullanim:
  python code_connector.py --dry-run            # hicbir POST yok, ne yazilacagini gosterir
  python code_connector.py --audit-blacklist    # kara liste verdict tablosu
  python code_connector.py --exclude-file w.txt --written-file new.txt
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
from pathlib import Path, PurePosixPath

# Windows'ta stdout varsayilani cp1254; ASCII disi tek karakter (repo adi veya
# commit mesaji) UnicodeEncodeError ile TUM kosuyu dusurur — yaziliyor gorunen
# is orta yerde olur. UTF-8'e sabitle, cevrilemeyeni degistir.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:  # cok eski Python — sadece guvence
    pass

GW = "http://127.0.0.1:4100"
WS = "ws_b98888ec6fe14f64bc57ca2ff599c31f"
EMAIL = "cihan@example.test"
SOURCE_TYPE = "code"
SENSITIVITY = "personal"

WSL_DISTRO = "Ubuntu"
WIN_REPOS = [Path.home() / "smith-monorepo"]

# --------------------------------------------------------------------------
# KARA LISTE — tek kaynak. Hem repo kesfi hem dosya listesi buradan gecer.
# --------------------------------------------------------------------------

#: Yol icinde bu isimde bir bilesen varsa yol tamamen reddedilir.
BLACKLIST_DIRS = frozenset(
    {
        "node_modules",
        ".git",
        "target",
        ".venv",
        "venv",
        "db-dumps",
        "customers",
        "docker-data",
        "github-backup",
        "backups",
        "letsencrypt",
        "__pycache__",
        ".turbo",
        ".next",
        "dist",
        "build",
        "coverage",
        "vendor",
        "Pods",
        ".gradle",
        ".terraform",
        # git worktree checkout'lari (ornek: earlier-project/.claude/worktrees/*) ana
        # reponun kopyasidir. Ayri kayit acmak hem kota harcar hem de semantik
        # geri cagirmada ana repoyla yarisan neredeyse-ayni metin uretir.
        "worktrees",
    }
)

#: Dosya adi bu desenlerden birine uyarsa okunmaz ve ozete girmez.
BLACKLIST_FILE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^\.env($|\.)", re.I),  # .env, .env.local — .env.example de dahil (temkinli)
    re.compile(r"^id_rsa", re.I),
    re.compile(r"^id_ed25519", re.I),
    re.compile(r"^id_ecdsa", re.I),
    re.compile(r"\.pem$", re.I),
    re.compile(r"\.p12$", re.I),
    re.compile(r"\.pfx$", re.I),
    re.compile(r"\.key$", re.I),
    re.compile(r"\.keystore$", re.I),
    re.compile(r"\.jks$", re.I),
    re.compile(r"\.sql$", re.I),  # ham dokum
    re.compile(r"\.dump$", re.I),
    re.compile(r"\.sqlite3?$", re.I),
    re.compile(r"^secrets?\.", re.I),
    re.compile(r"^credentials", re.I),
    re.compile(r"\.crt$", re.I),
)


def blacklist_reason(rel_path: str) -> str | None:
    """Yol reddedilecekse gerekce, kabul edilecekse None.

    `rel_path` POSIX ayiricili ve gorece olmalidir (repo koku veya workspace
    kokune gore). Dizin ve dosya kurallari ayni fonksiyondan gecer — kara
    listenin iki kopyasi olmaz.
    """
    parts = [p for p in PurePosixPath(rel_path).parts if p not in ("", ".")]
    for part in parts:
        if part in BLACKLIST_DIRS:
            return f"kara liste dizini: {part}"
    if parts:
        name = parts[-1]
        for pattern in BLACKLIST_FILE_PATTERNS:
            if pattern.search(name):
                return f"kara liste dosya deseni: {pattern.pattern}"
    return None


#: Dil dagiliminda sayilacak uzantilar. Kara liste "okumayi" engeller; bu
#: liste ise gurultuyu (lock, cache, binary) ozetten uzak tutar.
LANG_BY_EXT = {
    "ts": "TypeScript",
    "tsx": "TypeScript (React)",
    "js": "JavaScript",
    "jsx": "JavaScript (React)",
    "mjs": "JavaScript",
    "cjs": "JavaScript",
    "py": "Python",
    "rs": "Rust",
    "go": "Go",
    "java": "Java",
    "kt": "Kotlin",
    "swift": "Swift",
    "rb": "Ruby",
    "php": "PHP",
    "c": "C",
    "h": "C/C++ header",
    "cpp": "C++",
    "hpp": "C++ header",
    "cs": "C#",
    "sh": "Shell",
    "ps1": "PowerShell",
    "vue": "Vue",
    "svelte": "Svelte",
    "dart": "Dart",
    "ex": "Elixir",
    "scala": "Scala",
    "lua": "Lua",
    "md": "Markdown",
    "yml": "YAML",
    "yaml": "YAML",
    "toml": "TOML",
    "tf": "Terraform",
    "prisma": "Prisma schema",
    "graphql": "GraphQL",
    "css": "CSS",
    "scss": "SCSS",
    "html": "HTML",
}

README_CANDIDATES = ("README.md", "readme.md", "README.MD", "Readme.md", "README", "README.rst")
README_CHARS = 800

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
        {
            "content": content,
            "key": key,
            "sourceType": SOURCE_TYPE,
            "sensitivity": SENSITIVITY,
        }
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
    except Exception:  # baglanti/timeout — hata say, backoff devreye girsin
        return 0


def remember_with_backoff(token: str, content: str, key: str, waits: list[float]) -> int:
    """Kota/gecici hatada bekleyip tekrar dener. Son HTTP kodunu dondurur.

    Embed kotasi dakikalik yenilendigi icin beklemek gercekten ise yarar;
    beklemesiz tekrar denemeler kotayi daha da doldurur.
    """
    code = remember(token, content, key)
    for wait in waits:
        if code == 200:
            return code
        print(f"    kota/hata {code} -> {wait:.0f}s bekle, tekrar", flush=True)
        time.sleep(wait)
        code = remember(token, content, key)
    return code


# --------------------------------------------------------------------------
# WSL kabugu — TUZAK: wsl.exe varsayilan UTF-16 yazar, WSL_UTF8=1 sart.
# Script stdin'den (`bash -s`) verilir; boylece Windows argv alintilama
# kurallari ile bash alintilama kurallari carpismaz.
# --------------------------------------------------------------------------

BASH_PRELUDE = "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n"


def wsl_bash(script: str, timeout: int = 240) -> str:
    env = {**os.environ, "WSL_UTF8": "1"}
    proc = subprocess.run(
        ["wsl", "-d", WSL_DISTRO, "--", "bash", "-s"],
        input=(BASH_PRELUDE + script).encode("utf-8"),
        capture_output=True,
        timeout=timeout,
        env=env,
    )
    out = (proc.stdout or b"").decode("utf-8", "replace").lstrip("\ufeff")
    if proc.returncode != 0 and not out.strip():
        err = (proc.stderr or b"").decode("utf-8", "replace")[:400]
        raise RuntimeError(f"wsl bash hata ({proc.returncode}): {err}")
    return out


# --------------------------------------------------------------------------
# Kesif
# --------------------------------------------------------------------------


def discover_wsl_repos() -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """(kabul, red). Kabul = [(ad, abs_path)], red = [(ad, gerekce)].

    Kesif BILINCLI olarak prune'suz: reddi gorunur kilmak icin. `-maxdepth 5`
    hem `~/workspace/x/.git` hem `~/workspace/opensource/y/.git` hem de
    musteri agaclarindaki derin repolari yakalar.
    """
    raw = wsl_bash(
        'cd "$HOME/workspace" 2>/dev/null || exit 1\n'
        'echo "ROOT=$PWD"\n'
        "find . -maxdepth 5 -name .git 2>/dev/null | sort\n"
    )
    root = ""
    found: list[str] = []
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("ROOT="):
            root = line[5:].strip()
        elif line:
            found.append(line)

    accepted: list[tuple[str, str]] = []
    rejected: list[tuple[str, str]] = []
    for git_path in found:
        rel = git_path[2:] if git_path.startswith("./") else git_path
        rel = rel[: -len("/.git")] if rel.endswith("/.git") else rel
        if not rel or rel == ".git":
            continue
        reason = blacklist_reason(rel)
        if reason:
            rejected.append((rel, reason))
            continue
        # Baska bir kabul edilmis reponun ICINDE ise vendored kopyadir; ayri
        # kayit acmak kotayi bosa harcar.
        parent = next((a for a, _ in accepted if rel.startswith(a + "/")), None)
        if parent:
            rejected.append((rel, f"vendored: {parent} icinde"))
            continue
        accepted.append((rel, f"{root}/{rel}"))
    return accepted, rejected


# --------------------------------------------------------------------------
# Hasat — takipli dosya listesi + git meta. `git ls-files` build artefaktini
# zaten dislar; her yol yine de kara listeden gecer.
# --------------------------------------------------------------------------

#: TODO/FIXME sayimi takipli dosyalar uzerinde yapilir; ham dokum ve lock
#: dosyalari sayimdan cikarilir (icerikleri okunmaz, yalniz sayilirdi).
TODO_GREP = (
    "timeout 25 git grep -I -l -e TODO -e FIXME -- . "
    "':(exclude)*.sql' ':(exclude)*.lock' ':(exclude)*.pem' 2>/dev/null | wc -l"
)

#: `git ls-files` bos donen repolar icin dosya sistemi yedegi. Bazi projeler
#: gercek (ornek `api-server`: 12 girdi, README, nest-cli.json) ama HENUZ
#: commit edilmemis — `git init` var, HEAD yok. Yalniz git'e guvenmek boyle bir
#: projeyi tamamen kaybettirir. Prune listesi BLACKLIST_DIRS'ten uretilir, yani
#: kara listenin ikinci bir kopyasi olusmaz.
FS_FALLBACK_MAXDEPTH = 4
FS_FALLBACK_CAP = 4000


def find_prune_expr() -> str:
    """BLACKLIST_DIRS'ten `find` prune ifadesi uretir (tek kaynak)."""
    names = " -o ".join(f'-name "{d}"' for d in sorted(BLACKLIST_DIRS))
    return f"\\( {names} \\) -prune -o"


def build_wsl_harvest_script(repos: list[tuple[str, str]]) -> str:
    parts: list[str] = []
    for name, abs_path in repos:
        readme_probe = "".join(
            f'    if [ -f "{cand}" ]; then head -c {README_CHARS + 200} "{cand}"; echo ""; break; fi\n'
            for cand in README_CANDIDATES
        )
        parts.append(
            f'echo "@@@REPO {name}"\n'
            f'if cd "{abs_path}" 2>/dev/null; then\n'
            '  echo "@@@F branch"; git rev-parse --abbrev-ref HEAD 2>/dev/null\n'
            "  echo \"@@@F commits\"; git log -5 --date=short --pretty=format:'%ad %s' 2>/dev/null; echo \"\"\n"
            '  echo "@@@F count"; git rev-list --count HEAD 2>/dev/null\n'
            '  echo "@@@F dirty"; git status --porcelain 2>/dev/null | wc -l\n'
            f'  echo "@@@F todo"; {TODO_GREP}\n'
            '  echo "@@@F files"; git ls-files 2>/dev/null\n'
            '  echo "@@@F fsfiles"\n'
            '  if [ -z "$(git ls-files 2>/dev/null | head -1)" ]; then\n'
            f"    find . -maxdepth {FS_FALLBACK_MAXDEPTH} {find_prune_expr()} -type f -print "
            f"2>/dev/null | sed 's|^\\./||' | head -{FS_FALLBACK_CAP}\n"
            "  fi\n"
            '  echo "@@@F readme"\n'
            "  for _ in 1; do\n" + readme_probe + "  done\n"
            "else\n"
            '  echo "@@@F error"; echo "cd basarisiz"\n'
            "fi\n"
        )
    return "".join(parts) + 'echo "@@@REPO __end__"\n'


def parse_harvest(raw: str) -> dict[str, dict[str, list[str]]]:
    out: dict[str, dict[str, list[str]]] = {}
    repo: str | None = None
    field: str | None = None
    for line in raw.splitlines():
        if line.startswith("@@@REPO "):
            repo = line[len("@@@REPO ") :].strip()
            field = None
            if repo != "__end__":
                out[repo] = {}
            continue
        if line.startswith("@@@F "):
            field = line[len("@@@F ") :].strip()
            if repo and repo != "__end__":
                out[repo][field] = []
            continue
        if repo and repo != "__end__" and field:
            out[repo][field].append(line)
    return out


def harvest_windows(repo_path: Path) -> dict[str, list[str]]:
    """Windows reposu: ayni git komutlari, yerel subprocess ile."""

    def git(*args: str) -> list[str]:
        try:
            p = subprocess.run(
                ["git", "-C", str(repo_path), *args],
                capture_output=True,
                timeout=180,
            )
            return (p.stdout or b"").decode("utf-8", "replace").splitlines()
        except Exception:  # noqa: BLE001 — repo yok/git yok: alan bos kalir
            return []

    readme: list[str] = []
    for cand in README_CANDIDATES:
        f = repo_path / cand
        if f.is_file():
            readme = f.read_text(encoding="utf-8", errors="replace")[: README_CHARS + 200].splitlines()
            break
    todo_hits = git(
        "grep",
        "-I",
        "-l",
        "-e",
        "TODO",
        "-e",
        "FIXME",
        "--",
        ".",
        ":(exclude)*.sql",
        ":(exclude)*.lock",
        ":(exclude)*.pem",
    )
    tracked = git("ls-files")
    return {
        "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
        "commits": git("log", "-5", "--date=short", "--pretty=format:%ad %s"),
        "count": git("rev-list", "--count", "HEAD"),
        "dirty": [str(len(git("status", "--porcelain")))],
        "todo": [str(len([h for h in todo_hits if h.strip()]))],
        "files": tracked,
        "fsfiles": [] if tracked else walk_files(repo_path),
        "readme": readme,
    }


def walk_files(root: Path) -> list[str]:
    """git index'i bos olan repo icin dosya sistemi yedegi (kara liste prune'lu)."""
    out: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in BLACKLIST_DIRS]
        rel_dir = Path(dirpath).relative_to(root)
        if len(rel_dir.parts) >= FS_FALLBACK_MAXDEPTH:
            dirnames[:] = []
        for fname in filenames:
            out.append((rel_dir / fname).as_posix())
            if len(out) >= FS_FALLBACK_CAP:
                return out
    return out


# --------------------------------------------------------------------------
# Ozet uretimi
# --------------------------------------------------------------------------


def summarize_files(files: list[str]) -> tuple[dict[str, int], list[str], int, list[str]]:
    """(dil sayimlari, ust duzey yapi, kabul edilen dosya sayisi, reddedilenler)."""
    langs: dict[str, int] = {}
    tree: dict[str, set[str]] = {}
    top_files: list[str] = []
    kept = 0
    skipped: list[str] = []
    for rel in files:
        rel = rel.strip().strip('"')
        if not rel:
            continue
        reason = blacklist_reason(rel)
        if reason:
            skipped.append(f"{rel} ({reason})")
            continue
        kept += 1
        ext = rel.rsplit(".", 1)[-1].lower() if "." in rel.rsplit("/", 1)[-1] else ""
        lang = LANG_BY_EXT.get(ext)
        if lang:
            langs[lang] = langs.get(lang, 0) + 1
        parts = rel.split("/")
        if len(parts) == 1:
            top_files.append(parts[0])
        else:
            tree.setdefault(parts[0], set())
            if len(parts) > 2:
                tree[parts[0]].add(parts[1])
    structure: list[str] = []
    for top in sorted(tree):
        subs = sorted(tree[top])[:6]
        structure.append(f"{top}/({', '.join(subs)})" if subs else f"{top}/")
    return langs, structure, kept, skipped


def build_sections(
    name: str, host: str, path: str, data: dict[str, list[str]]
) -> tuple[dict[str, str], list[str]]:
    """({bolum: icerik}, kara listeyle atlanan yollar)."""
    branch = (data.get("branch") or ["?"])[0].strip() or "?"
    commit_count = (data.get("count") or ["?"])[0].strip() or "?"
    dirty = (data.get("dirty") or ["0"])[0].strip() or "0"
    todo = (data.get("todo") or ["?"])[0].strip() or "?"
    commits = [c.strip() for c in (data.get("commits") or []) if c.strip()][:5]
    readme_raw = " ".join(" ".join(data.get("readme") or []).split())
    readme = readme_raw[:README_CHARS] if readme_raw else "README yok"

    tracked = data.get("files") or []
    fallback = data.get("fsfiles") or []
    langs, structure, kept, skipped = summarize_files(tracked or fallback)
    origin = "takipli dosya" if tracked else "commit edilmemis dosya"
    # SINYALSIZ REPO KAPISI. Ne git'ten ne dosya sisteminden icerik cikmayan bir
    # repo yalniz ADINI tasir; boyle bir kayit semantik aramada gercek repoyla
    # yarisir ve onu GECER (olculdu: bos 'sample-app-unsigned-release' 0.738 ile
    # birinci, 690 dosyali 'sample-app-monorepo' 0.720 ile dorduncu geldi).
    if kept == 0 and not commits:
        return {}, skipped

    lang_txt = (
        ", ".join(f"{lang} {n}" for lang, n in sorted(langs.items(), key=lambda kv: -kv[1])[:8])
        or "tanimli dil dosyasi yok"
    )
    struct_txt = ", ".join(structure[:14]) or "tek duzey"

    has_history = bool(commits) and commit_count.isdigit()
    history_note = "" if has_history else " Bu repoda git gecmisi yok (hic commit edilmemis calisma kopyasi)."
    ozet = (
        f"Kod reposu '{name}' ({host}, yol: {path}). Toplam {origin}: {kept}. "
        f"Dil dagilimi: {lang_txt}. Ust duzey yapi: {struct_txt}.{history_note} "
        f"README ozeti: {readme}"
    )
    if has_history:
        durum = (
            f"Kod reposu '{name}' son durumu ({host}): aktif branch {branch}, "
            f"toplam {commit_count} commit, commit edilmemis {dirty} degisiklik, "
            f"TODO/FIXME isaretli {todo} dosya. "
            f"Son commit'ler: " + " | ".join(commits) + "."
        )
    else:
        # GIT GECMISI OLMAYAN REPO ICIN `durum` BOS BIRAKILMAZ, ANLATILIR.
        # Onceki surum burada "aktif branch ?, toplam ? commit, commit gecmisi
        # okunamadi" yaziyordu; o metin geriye yalniz repo ADINI birakiyor ve
        # semantik aramada gercek repoyu GECIYOR — olculdu: "sample-app
        # projesinde ne var" sorgusunda bos 'sample-app-unsigned-release:durum'
        # 0.738 ile birinci, 690 dosyali 'sample-app-monorepo' 0.720 ile
        # dorduncu geldi. Bolumu tamamen silmek de cozum degildi: konnektor daha
        # once o sourceId'yi yazmissa DB'de sahipsiz (guncellenmeyen) bir kayit
        # kalir. Bu yuzden bolum korunur ve GERCEK bilgiyle doldurulur.
        durum = (
            f"Kod reposu '{name}' son durumu ({host}, yol: {path}): git gecmisi YOK — "
            "dizin bir git deposu olarak baslatilmis ama hic commit edilmemis, "
            "bu yuzden commit gecmisinden 'en son ne yaptim' cevabi cikmaz. "
            f"Calisma kopyasinda {kept} dosya duruyor; iceriginin dokumu icin ayni "
            f"reponun ozet kaydina bak. Dil dagilimi: {lang_txt}."
        )
    return {"ozet": ozet, "durum": durum}, skipped


def load_exclude(path: str | None) -> set[str]:
    if not path:
        return set()
    p = Path(path)
    if not p.exists():
        return set()
    return {ln.strip() for ln in p.read_text(encoding="utf-8-sig").splitlines() if ln.strip()}


# --------------------------------------------------------------------------


def audit_blacklist() -> None:
    """Kara listenin verdict tablosu — iddia degil, calistirilmis kanit."""
    probes = [
        "smith/packages/core/src/loop.ts",
        "smith/.env",
        "smith/.env.local",
        "customers/client-project/projects/tracking",
        "github-backup/client-project/data-ingress",
        "db-dumps/defaultdb-202511181346.sql",
        "docker-data/postgres/pg_wal",
        "sample-app-monorepo/node_modules/react/index.js",
        "smith/apps/desktop/src-tauri/target/debug/smith.exe",
        "apps/desktop/sidecar/.venv/Scripts/python.exe",
        "earlier-project/.claude/worktrees/quirky-shannon-424e33",
        "personal/PersonalDocs/README.md",
        "opensource/proxy-manager/certs/server.pem",
        "projectx/id_ed25519",
        "projectx/keys/id_rsa.pub",
        "backups/2026-08/dump.sql",
        "earlier-project/prisma/schema.prisma",
        "earlier-project/secrets.json",
        "api-server/credentials.json",
    ]
    print("KARA LISTE DENETIMI (blacklist_reason)")
    print("-" * 78)
    for probe in probes:
        reason = blacklist_reason(probe)
        verdict = f"RED   ({reason})" if reason else "KABUL"
        print(f"  {verdict:<52} {probe}")
    print("-" * 78)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=200, help="En fazla kac POST denenecek.")
    ap.add_argument("--sleep", type=float, default=0.9, help="Istekler arasi bekleme (RPM).")
    ap.add_argument("--exclude-file", help="Satir basina sourceId; bu kayitlar POST EDILMEZ.")
    ap.add_argument("--written-file", help="Basarili her sourceId buraya eklenir.")
    ap.add_argument("--max-consecutive-fail", type=int, default=6)
    ap.add_argument("--dry-run", action="store_true", help="POST yok; ne yazilacagini basar.")
    ap.add_argument("--show-skips", action="store_true", help="Kara listeyle atlanan yollari basar.")
    ap.add_argument("--audit-blacklist", action="store_true", help="Yalniz kara liste denetimi.")
    args = ap.parse_args()

    if args.audit_blacklist:
        audit_blacklist()
        return 0

    accepted, rejected = discover_wsl_repos()
    print(f"WSL kesfi: {len(accepted)} repo kabul, {len(rejected)} reddedildi.", flush=True)
    bl_rejects = [r for r in rejected if not r[1].startswith("vendored")]
    vendored = [r for r in rejected if r[1].startswith("vendored")]
    print(f"  kara liste redleri: {len(bl_rejects)}, vendored redleri: {len(vendored)}", flush=True)
    for rel, reason in bl_rejects[:8]:
        print(f"  RED (kara liste): {rel} — {reason}", flush=True)
    if len(bl_rejects) > 8:
        print(f"  ... ve {len(bl_rejects) - 8} kara liste reddi daha", flush=True)
    for rel, reason in vendored:
        print(f"  RED (vendored): {rel} — {reason}", flush=True)

    print("WSL repolari hasat ediliyor (git ls-files + git log)...", flush=True)
    harvested = parse_harvest(wsl_bash(build_wsl_harvest_script(accepted), timeout=600))

    records: list[tuple[str, str]] = []  # (key, content)
    all_skips: list[str] = []
    for name, abs_path in accepted:
        data = harvested.get(name)
        if not data or "error" in data:
            print(f"  UYARI: {name} hasat edilemedi, atlandi.", flush=True)
            continue
        sections, skips = build_sections(name, "WSL Ubuntu", abs_path, data)
        all_skips.extend(f"{name}/{s}" for s in skips)
        if not sections:
            print(f"  ATLANDI (sinyalsiz repo): {name}", flush=True)
            continue
        for section, content in sections.items():
            records.append((f"code:{name}:{section}", content))

    for win_repo in WIN_REPOS:
        if not (win_repo / ".git").exists():
            print(f"  UYARI: {win_repo} git reposu degil, atlandi.", flush=True)
            continue
        rel_name = win_repo.name
        reason = blacklist_reason(rel_name)
        if reason:
            print(f"  RED (kara liste): {rel_name} — {reason}", flush=True)
            continue
        data = harvest_windows(win_repo)
        sections, skips = build_sections(rel_name, "Windows ana makine", str(win_repo), data)
        all_skips.extend(f"{rel_name}/{s}" for s in skips)
        if not sections:
            print(f"  ATLANDI (sinyalsiz repo): {rel_name}", flush=True)
            continue
        for section, content in sections.items():
            records.append((f"code:{rel_name}:{section}", content))

    print(f"Uretilen kayit: {len(records)}.", flush=True)
    print(f"Kara listeyle atlanan takipli dosya: {len(all_skips)}", flush=True)
    if all_skips and (args.show_skips or args.dry_run):
        for s in all_skips[:25]:
            print(f"  ATLANDI: {s}", flush=True)
        if len(all_skips) > 25:
            print(f"  ... ve {len(all_skips) - 25} dosya daha", flush=True)

    exclude = load_exclude(args.exclude_file)
    if exclude:
        print(f"Haric tutulan (zaten yazili): {len(exclude)}", flush=True)

    if args.dry_run:
        for key, content in records:
            print(f"\n--- {key}\n{content[:400]}{'...' if len(content) > 400 else ''}", flush=True)
        print(f"\nKURU CALISTIRMA: {len(records)} kayit uretildi, POST yapilmadi.", flush=True)
        return 0

    token = login()
    written = open(args.written_file, "a", encoding="utf-8") if args.written_file else None
    ok = fail = already = 0
    streak = 0
    for key, content in records:
        if ok + fail >= args.max:
            break
        if key in exclude:
            already += 1
            continue
        code = remember_with_backoff(token, content, key, [30.0, 90.0])
        if code == 200:
            ok += 1
            streak = 0
            if written:
                written.write(key + "\n")
                written.flush()
            print(f"  yazildi: {key}", flush=True)
        else:
            fail += 1
            streak += 1
            print(f"  HATA {code}: {key}", flush=True)
            if streak >= args.max_consecutive_fail:
                print(
                    f"DUR: {streak} ust uste hata — kota tukenmis gorunuyor. "
                    "Kalan kayitlar icin sonra --exclude-file ile devam et.",
                    flush=True,
                )
                break
        time.sleep(args.sleep)
    if written:
        written.close()
    remaining = len(records) - ok - already - fail
    print(
        f"Kod konnektor bitti: {ok} yazildi, {fail} hata, "
        f"{already} zaten-yazili-atlandi, {remaining} denenmedi.",
        flush=True,
    )
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
