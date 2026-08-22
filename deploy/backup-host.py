#!/usr/bin/env python3
"""Online SQLite backup (WAL-safe). No docker."""
import gzip
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

DATA_DB = Path(os.environ.get("RPCHAT_DB", "/home/hermes/rpchat/data/rpchat.db"))
OUT_DIR = Path(os.environ.get("OUT_DIR", "/home/hermes/rpchat/backups"))
KEEP_DAYS = int(os.environ.get("KEEP_DAYS", "14"))

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
    gz = raw.with_suffix(".db.gz")
    with raw.open("rb") as f_in, gzip.open(gz, "wb") as f_out:
        f_out.writelines(f_in)
    raw.unlink()
    print(f"[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] backup {gz} bytes={gz.stat().st_size}")
    cutoff = datetime.now(timezone.utc) - timedelta(days=KEEP_DAYS)
    for p in OUT_DIR.glob("rpchat-*.db.gz"):
        if datetime.fromtimestamp(p.stat().st_mtime, timezone.utc) < cutoff:
            p.unlink()
            print(f"deleted old {p.name}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
