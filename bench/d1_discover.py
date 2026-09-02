#!/usr/bin/env python3
import json
import os
import sqlite3
import urllib.request

FROST = "f89ace9b-8684-4d97-96dc-e00c4b25a819"
AUTH = {"Tailscale-User-Login": "manofin@github"}

print("CWD", os.getcwd())
print("DATE", os.popen("date -u +%Y-%m-%dT%H:%M:%SZ").read().strip())
print("DESCRIBE", os.popen("git -C /home/hermes/rpchat/app describe --tags").read().strip())
print("HEAD", os.popen("git -C /home/hermes/rpchat/app rev-parse --short HEAD").read().strip())

req = urllib.request.Request("http://127.0.0.1:8787/api/health", headers=AUTH)
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        body = r.read().decode()
        print("HEALTH_STATUS", r.status)
        print("HEALTH_BODY", body)
except Exception as e:
    print("HEALTH_ERR", type(e).__name__, e)

# locate live pid / data dir
import subprocess
ps = subprocess.check_output(["ps", "-eo", "pid,lstart,cmd"], text=True)
hits = [ln for ln in ps.splitlines() if "rpchat" in ln.lower() or "apps/server" in ln]
print("PS_HITS", len(hits))
for ln in hits[:20]:
    print("PS", ln)

# common data paths
cands = [
    "/home/hermes/rpchat/data/rpchat.db",
    "/home/hermes/rpchat/app/data/rpchat.db",
    os.path.expanduser("~/.local/share/rpchat/rpchat.db"),
]
for p in cands:
    print("CAND", p, "exists", os.path.exists(p), "size", os.path.getsize(p) if os.path.exists(p) else None)

db_path = next((p for p in cands if os.path.exists(p)), None)
print("DB_PATH", db_path)
if not db_path:
    raise SystemExit(2)

con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
con.row_factory = sqlite3.Row
cur = con.cursor()
print("TABLES", [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1")])
print("MIGRATIONS", [r[0] for r in cur.execute("SELECT name FROM schema_migrations ORDER BY 1")])
print("USER_VERSION", cur.execute("PRAGMA user_version").fetchone()[0])

print("CHARACTERS")
for r in cur.execute("SELECT id, name, archived FROM characters ORDER BY created_at"):
    frost = r["id"] == FROST
    print(f"  char id={r['id']} name={r['name']!r} archived={r['archived']} frost={frost}")

print("CONV_COUNTS")
for r in cur.execute(
    "SELECT character_id, COUNT(*) n FROM conversations GROUP BY character_id"
):
    print(f"  character_id={r['character_id']} n={r['n']} frost={r['character_id']==FROST}")

print("MEMORIES_STATUS")
for r in cur.execute("SELECT status, COUNT(*) n FROM memories GROUP BY status ORDER BY 1"):
    print(f"  {r['status']}|{r['n']}")
print("SUMMARIES_TIER_STATUS")
for r in cur.execute(
    "SELECT tier, status, COUNT(*) n FROM summaries GROUP BY tier, status ORDER BY 1,2"
):
    print(f"  {r['tier']}|{r['status']}|{r['n']}")
print("TEST_LEFTOVER", cur.execute("SELECT COUNT(*) FROM summaries WHERE content LIKE '%__test__%'").fetchone()[0])
print("TEST_MEM", cur.execute("SELECT COUNT(*) FROM memories WHERE content LIKE '%__test__%'").fetchone()[0])

# cascade?
fk = cur.execute("PRAGMA foreign_key_list(summaries)").fetchall()
print("FK_SUMMARIES", [tuple(x) for x in fk])
fk2 = cur.execute("PRAGMA foreign_key_list(messages)").fetchall()
print("FK_MESSAGES", [tuple(x) for x in fk2])
fk3 = cur.execute("PRAGMA foreign_key_list(conversations)").fetchall()
print("FK_CONVERSATIONS", [tuple(x) for x in fk3])
print("PRAGMA_FK", cur.execute("PRAGMA foreign_keys").fetchone()[0])
print("SUMMARIES_SCHEMA")
for r in cur.execute("PRAGMA table_info(summaries)"):
    print(" ", tuple(r))
print("MESSAGES_SCHEMA")
for r in cur.execute("PRAGMA table_info(messages)"):
    print(" ", tuple(r))
