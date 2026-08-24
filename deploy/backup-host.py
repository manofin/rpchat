#!/usr/bin/env python3
"""Online SQLite backup (WAL-safe). No docker.

Writes rpchat-<stamp>.db.gz plus rpchat-<stamp>.manifest.json
(app_version + schema_migrations + required_migrations).
"""
import gzip
import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

DATA_DB = Path(os.environ.get("RPCHAT_DB", "/home/hermes/rpchat/data/rpchat.db"))
OUT_DIR = Path(os.environ.get("OUT_DIR", "/home/hermes/rpchat/backups"))
KEEP_DAYS = int(os.environ.get("KEEP_DAYS", "14"))
DEPLOY_DIR = Path(__file__).resolve().parent
REPO_DIR = DEPLOY_DIR.parent
COMPAT_PATH = DEPLOY_DIR / "schema-compat.json"


def git_describe(repo: Path) -> tuple[str, str]:
    env = os.environ.get("RPCHAT_APP_VERSION")
    try:
        desc = subprocess.check_output(
            ["git", "-C", str(repo), "describe", "--tags", "--always"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
        sha = subprocess.check_output(
            ["git", "-C", str(repo), "rev-parse", "HEAD"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
        if env:
            return env, sha
        return desc, sha
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return env or "unknown", "unknown"


def load_required() -> list[str]:
    if not COMPAT_PATH.is_file():
        return []
    data = json.loads(COMPAT_PATH.read_text(encoding="utf-8"))
    raw = data.get("required_migrations") or []
    return [str(x) for x in raw]


def schema_names(db_path: Path) -> list[str]:
    uri = f"file:{db_path}?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    try:
        rows = con.execute(
            "SELECT name FROM schema_migrations ORDER BY name"
        ).fetchall()
        return [str(r[0]) for r in rows]
    except sqlite3.Error:
        return []
    finally:
        con.close()


def main() -> int:
    if not DATA_DB.exists():
        print(f"missing db {DATA_DB}", file=sys.stderr)
        return 1
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    raw = OUT_DIR / f"rpchat-{stamp}.db"
    src = sqlite3.connect(str(DATA_DB))
    dst = sqlite3.connect(str(raw))
    with dst:
        src.backup(dst)
    src.close()
    dst.close()
    gz = OUT_DIR / f"rpchat-{stamp}.db.gz"
    with raw.open("rb") as f_in, gzip.open(gz, "wb") as f_out:
        f_out.writelines(f_in)
    applied = schema_names(raw)
    raw.unlink()
    # backup .backup() 목적지가 원본과 같은 WAL 모드를 그대로 물려받아, 체크포인트 없이
    # 메인 파일만 지우면 -wal/-shm 사이드카가 고아로 남는다(2026-08-24 실측 확인). 정리.
    for suffix in ("-wal", "-shm"):
        side = raw.with_name(raw.name + suffix)
        if side.exists():
            side.unlink()
    required = load_required()
    app_version, git_sha = git_describe(REPO_DIR)
    missing = [m for m in required if m not in applied]
    extra = [m for m in applied if m not in required]
    manifest = {
        "format": "rpchat-backup-manifest-v1",
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "app_version": app_version,
        "git_sha": git_sha,
        "schema_migrations": applied,
        "required_migrations": required,
        "missing_required": missing,
        "extra_in_backup": extra,
        "compat_ok": not missing and not extra,
        "db_gz": gz.name,
        "bytes": gz.stat().st_size,
    }
    man_path = OUT_DIR / f"rpchat-{stamp}.manifest.json"
    man_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        f"[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] "
        f"backup {gz} bytes={gz.stat().st_size} "
        f"app_version={app_version} compat_ok={manifest['compat_ok']}"
    )
    cutoff = datetime.now(timezone.utc) - timedelta(days=KEEP_DAYS)
    for p in OUT_DIR.glob("rpchat-*.db.gz"):
        if datetime.fromtimestamp(p.stat().st_mtime, timezone.utc) < cutoff:
            p.unlink()
            print(f"deleted old {p.name}")
            stem = p.name[: -len(".db.gz")]
            side = p.with_name(f"{stem}.manifest.json")
            if side.exists():
                side.unlink()
                print(f"deleted old {side.name}")
    for p in OUT_DIR.glob("rpchat-*.manifest.json"):
        if datetime.fromtimestamp(p.stat().st_mtime, timezone.utc) < cutoff:
            p.unlink()
            print(f"deleted old {p.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
