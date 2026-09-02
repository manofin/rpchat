#!/usr/bin/env python3
import os
import sqlite3
import urllib.request

FROST = "f89ace9b-8684-4d97-96dc-e00c4b25a819"
KAI = "255f96a2-d78e-433d-9169-fb6da6e0963f"
DB = "/home/hermes/rpchat/data/rpchat.db"
CID = "cc8222eb-430d-4057-b816-5fbf828adab6"
AUTH = {"Tailscale-User-Login": "manofin@github"}

print("DESCRIBE", os.popen("git -C /home/hermes/rpchat/app describe --tags").read().strip())
req = urllib.request.Request("http://127.0.0.1:8787/api/health", headers=AUTH)
with urllib.request.urlopen(req, timeout=10) as r:
    print("HEALTH", r.status, r.read().decode())

con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
con.row_factory = sqlite3.Row
cur = con.cursor()
print("CONV_GONE", cur.execute("SELECT COUNT(*) n FROM conversations WHERE id = ?", (CID,)).fetchone()["n"])
print("MSG_LEFT", cur.execute("SELECT COUNT(*) n FROM messages WHERE conversation_id = ?", (CID,)).fetchone()["n"])
print("SUM_LEFT", cur.execute("SELECT COUNT(*) n FROM summaries WHERE conversation_id = ?", (CID,)).fetchone()["n"])
print("TEST_SUM", cur.execute("SELECT COUNT(*) n FROM summaries WHERE content LIKE '%__test__%'").fetchone()["n"])
print("TEST_MEM", cur.execute("SELECT COUNT(*) n FROM memories WHERE content LIKE '%__test__%'").fetchone()["n"])
print("TEST_CONV_TITLE", cur.execute("SELECT COUNT(*) n FROM conversations WHERE title LIKE '%__test__%'").fetchone()["n"])
print("FROST_CONV_N", cur.execute("SELECT COUNT(*) n FROM conversations WHERE character_id = ?", (FROST,)).fetchone()["n"])
print("KAI_CONV_N", cur.execute("SELECT COUNT(*) n FROM conversations WHERE character_id = ?", (KAI,)).fetchone()["n"])
print("MEMORIES")
for r in cur.execute("SELECT status, COUNT(*) n FROM memories GROUP BY status ORDER BY 1"):
    print(f"  {r['status']}|{r['n']}")
print("SUMMARIES")
for r in cur.execute("SELECT tier, status, COUNT(*) n FROM summaries GROUP BY 1,2 ORDER BY 1,2"):
    print(f"  {r['tier']}|{r['status']}|{r['n']}")
print("FROST_CHAR_STILL", cur.execute("SELECT id, name FROM characters WHERE id = ?", (FROST,)).fetchone()["name"])
