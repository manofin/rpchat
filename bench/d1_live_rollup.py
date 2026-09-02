#!/usr/bin/env python3
"""D1 isolated episode live rollup. Throwaway conv only. Cleans up on any exit."""
import json
import sqlite3
import sys
import traceback
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

FROST = "f89ace9b-8684-4d97-96dc-e00c4b25a819"
KAI = "255f96a2-d78e-433d-9169-fb6da6e0963f"
DB = "/home/hermes/rpchat/data/rpchat.db"
BASE = "http://127.0.0.1:8787"
AUTH = {"Tailscale-User-Login": "manofin@github"}
MARKER = "__test__"

conv_id = None
scene_ids = []
episode_id = None


def utcnow():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def http(method, path, body=None, timeout=60):
    data = None
    headers = dict(AUTH)
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode()
            return r.status, raw, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        print(f"HTTP_{e.code}", method, path)
        print("HTTP_ERR_BODY", raw[:4000])
        return e.code, raw, None


def system_blob(preview):
    msgs = (preview or {}).get("messages") or []
    parts = []
    for m in msgs:
        if m.get("role") == "system":
            parts.append(m.get("content") or "")
    return "\n".join(parts)


def diag_summaries(preview):
    bud = (preview or {}).get("budget") or {}
    d = bud.get("diagnostics") or {}
    return d.get("summaries") or []


def open_rw():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def refuse_frost(con, label, cid=None, char_id=None):
    if cid:
        row = con.execute("SELECT character_id FROM conversations WHERE id = ?", (cid,)).fetchone()
        if row and row["character_id"] == FROST:
            raise RuntimeError(f"refused: frost character {label} conv {cid}")
        if cid == FROST:
            raise RuntimeError(f"refused: frost id used as conv {label}")
    if char_id == FROST:
        raise RuntimeError(f"refused: frost character {label} {char_id}")


def snapshot(con, tag):
    mem = {r["status"]: r["n"] for r in con.execute("SELECT status, COUNT(*) n FROM memories GROUP BY status")}
    sm = [(r["tier"], r["status"], r["n"]) for r in con.execute(
        "SELECT tier, status, COUNT(*) n FROM summaries GROUP BY 1,2 ORDER BY 1,2"
    )]
    leftover = con.execute("SELECT COUNT(*) n FROM summaries WHERE content LIKE ?", (f"%{MARKER}%",)).fetchone()["n"]
    print(f"SNAP_{tag}_MEM", json.dumps(mem, sort_keys=True))
    print(f"SNAP_{tag}_SUM", sm)
    print(f"SNAP_{tag}_TEST", leftover)
    return mem, sm, leftover


def cleanup(con):
    print("CLEANUP_BEGIN")
    refuse_frost(con, "cleanup", cid=conv_id)
    if episode_id:
        st, raw, _ = http("DELETE", f"/api/summaries/{episode_id}")
        print("CLEANUP_EP_DELETE", st, raw[:200])
    for sid in scene_ids:
        cur = con.execute(
            "DELETE FROM summaries WHERE id = ? AND content LIKE ?",
            (sid, f"%{MARKER}%"),
        )
        print(f"CLEANUP_SCENE id={sid} changes={cur.rowcount}")
    con.commit()
    leftover = con.execute("SELECT COUNT(*) n FROM summaries WHERE content LIKE ?", (f"%{MARKER}%",)).fetchone()["n"]
    print("CLEANUP_LEFTOVER_TEST", leftover)
    if conv_id:
        refuse_frost(con, "cleanup-conv", cid=conv_id)
        # extra safety: only delete our titled throwaway
        row = con.execute(
            "SELECT id, character_id, title FROM conversations WHERE id = ?",
            (conv_id,),
        ).fetchone()
        print("CLEANUP_CONV_ROW", None if row is None else dict(row))
        if row:
            if row["character_id"] == FROST:
                raise RuntimeError("refused: frost conv in cleanup")
            if MARKER not in (row["title"] or ""):
                raise RuntimeError("refused: conv title missing marker")
            st, raw, _ = http("DELETE", f"/api/conversations/{conv_id}")
            print("CLEANUP_CONV_DELETE", st, raw[:200])
    gone = con.execute("SELECT COUNT(*) n FROM conversations WHERE id = ?", (conv_id,)).fetchone()["n"] if conv_id else 0
    msg_left = con.execute("SELECT COUNT(*) n FROM messages WHERE conversation_id = ?", (conv_id,)).fetchone()["n"] if conv_id else 0
    sum_left = con.execute("SELECT COUNT(*) n FROM summaries WHERE conversation_id = ?", (conv_id,)).fetchone()["n"] if conv_id else 0
    leftover2 = con.execute("SELECT COUNT(*) n FROM summaries WHERE content LIKE ?", (f"%{MARKER}%",)).fetchone()["n"]
    print("CLEANUP_OK leftover_test=%s conv_gone=%s msg_left=%s sum_left=%s" % (
        leftover2, int(gone == 0), msg_left, sum_left
    ))


def main():
    global conv_id, scene_ids, episode_id
    con = open_rw()
    try:
        before = snapshot(con, "BEFORE")
        refuse_frost(con, "start", char_id=KAI)
        kai = con.execute("SELECT id, name FROM characters WHERE id = ?", (KAI,)).fetchone()
        print("KAI_ROW", dict(kai) if kai else None)
        frost_convs = [r["id"] for r in con.execute("SELECT id FROM conversations WHERE character_id = ?", (FROST,))]
        print("FROST_GUARD char", FROST, "convs", len(frost_convs))
        print("FROST_GUARD_OK")

        st, raw, created = http("POST", "/api/conversations", {
            "characterId": KAI,
            "title": "__test__ d1-episode-rollup",
            "mode": "chat",
        })
        print("CREATE_STATUS", st)
        print("CREATE_BODY", raw[:1500])
        if st != 201 or not created:
            raise RuntimeError("create conv failed")
        conv_id = created["id"]
        refuse_frost(con, "after-create", cid=conv_id)
        if created.get("character_id") != KAI:
            raise RuntimeError(f"unexpected character {created.get('character_id')}")

        # reload head
        row = con.execute("SELECT head_message_id FROM conversations WHERE id = ?", (conv_id,)).fetchone()
        parent = row["head_message_id"]
        print("GREETING_HEAD", parent)
        # grow path to 30 messages
        need = 30
        existing = con.execute("SELECT COUNT(*) n FROM messages WHERE conversation_id = ?", (conv_id,)).fetchone()["n"]
        print("MSG_EXISTING", existing)
        last = parent
        for i in range(existing, need):
            role = "user" if i % 2 == 1 else "assistant"
            mid = str(uuid.uuid4())
            ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{i:06d}Z"
            con.execute(
                "INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, bookmarked, created_at) VALUES (?,?,?,?,?,?,?,0,?)",
                (mid, conv_id, last, role, f"{MARKER} path msg {i}", "complete", "{}", ts),
            )
            last = mid
        con.execute("UPDATE conversations SET head_message_id = ?, updated_at = ? WHERE id = ?", (last, utcnow(), conv_id))
        con.commit()

        # walk path like getPath
        path = []
        cur = last
        guard = set()
        while cur and cur not in guard:
            guard.add(cur)
            m = con.execute("SELECT id, parent_id FROM messages WHERE id = ?", (cur,)).fetchone()
            if not m:
                break
            path.append(m["id"])
            cur = m["parent_id"]
        path.reverse()
        print("PATH_LEN", len(path))
        if len(path) < 25:
            raise RuntimeError("path shorter than 25")
        covers = path[-(24 + 1)]
        recent = set(path[-24:])
        print("COVERS_UNTIL", covers)
        print("COVERS_IN_GUARD", int(covers in recent))

        for i in range(5):
            sid = str(uuid.uuid4())
            ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{i:06d}Z"
            con.execute(
                "INSERT INTO summaries (id, conversation_id, content, covers_until_message_id, covers_from_message_id, status, created_at, tier, rolled_up_into) VALUES (?,?,?,?,?,?,?,?,NULL)",
                (sid, conv_id, f"{MARKER} scene {i+1} old arc beat", covers, covers, "approved", ts, "scene"),
            )
            scene_ids.append(sid)
        con.commit()
        print("SCENE_IDS", scene_ids)
        print("SEED_OK path_len=%s scenes=%s covers_until_in_guard=%s" % (
            len(path), len(scene_ids), int(covers in recent)
        ))

        st, raw, preview0 = http("GET", f"/api/conversations/{conv_id}/prompt-preview")
        print("PREVIEW0_STATUS", st)
        blob0 = system_blob(preview0)
        print("A_PRE_SCENE_HEADING", "### 최근 장면" in blob0)
        print("A_PRE_TEST_MARKER", MARKER in blob0)
        print("A_PRE_EPISODE_HEADING", "### 지난 에피소드" in blob0)
        print("A_PRE_DIAG", diag_summaries(preview0))

        print("ROLLUP_BEGIN")
        st, raw, rolled = http("POST", f"/api/conversations/{conv_id}/rollup-episode", {}, timeout=300)
        print("ROLLUP_STATUS", st)
        print("ROLLUP_BODY", raw[:3000])
        if st != 200 or not rolled:
            raise RuntimeError("rollup failed")
        episode_id = (rolled.get("episode") or {}).get("id")
        print("EPISODE_ID", episode_id)
        print("ROLLED_SCENES", rolled.get("rolledScenes"))
        marked = list(con.execute(
            "SELECT id, rolled_up_into, status FROM summaries WHERE id IN (%s)" % ",".join("?" * len(scene_ids)),
            scene_ids,
        ))
        print("MARKED", [dict(r) for r in marked])

        st, raw, previewB = http("GET", f"/api/conversations/{conv_id}/prompt-preview")
        blobB = system_blob(previewB)
        print("PREVIEW_B_STATUS", st)
        print("B_DRAFT_SCENE_KEEP", ("### 최근 장면" in blobB) and (MARKER in blobB))
        print("B_DRAFT_EPISODE_HEADING", "### 지난 에피소드" in blobB)
        print("B_DRAFT_DIAG", diag_summaries(previewB))

        st, raw, patched = http("PATCH", f"/api/summaries/{episode_id}", {"status": "approved"})
        print("APPROVE_STATUS", st)
        print("APPROVE_BODY", raw[:1500])

        st, raw, previewC = http("GET", f"/api/conversations/{conv_id}/prompt-preview")
        blobC = system_blob(previewC)
        print("PREVIEW_C_STATUS", st)
        print("C_EPISODE_HEADING", "### 지난 에피소드" in blobC)
        print("C_TEST_MARKER", MARKER in blobC)
        print("C_SCENE_HEADING", "### 최근 장면" in blobC)
        print("C_APPROVED_FOLDED", ("### 지난 에피소드" in blobC) and (MARKER not in blobC))
        print("C_APPROVE_DIAG", diag_summaries(previewC))
        if "### 지난 에피소드" in blobC:
            i = blobC.find("### 지난 에피소드")
            print("C_EPISODE_SNIP", blobC[i:i + 400].replace("\n", "\\n"))

        st, raw, _ = http("DELETE", f"/api/summaries/{episode_id}")
        print("DELETE_EP_STATUS", st, raw[:200])
        episode_id = None
        nulls = list(con.execute(
            "SELECT id, rolled_up_into FROM summaries WHERE id IN (%s)" % ",".join("?" * len(scene_ids)),
            scene_ids,
        ))
        print("AFTER_DEL_MARK", [dict(r) for r in nulls])
        print("D_ROLLED_NULL", all(r["rolled_up_into"] is None for r in nulls) and len(nulls) == 5)

        st, raw, previewD = http("GET", f"/api/conversations/{conv_id}/prompt-preview")
        blobD = system_blob(previewD)
        print("PREVIEW_D_STATUS", st)
        print("D_RETURN_SCENES", ("### 최근 장면" in blobD) and (MARKER in blobD) and ("### 지난 에피소드" not in blobD))
        print("D_RETURN_DIAG", diag_summaries(previewD))

        # explicit probe deletes
        for sid in scene_ids:
            cur = con.execute(
                "DELETE FROM summaries WHERE id = ? AND content LIKE ?",
                (sid, f"%{MARKER}%"),
            )
            print(f"PROBE_DELETE id={sid} changes={cur.rowcount}")
        con.commit()
        leftover = con.execute("SELECT COUNT(*) n FROM summaries WHERE content LIKE ?", (f"%{MARKER}%",)).fetchone()["n"]
        print("PROBE_LEFTOVER", leftover)
        scene_ids = []

        refuse_frost(con, "final-conv-del", cid=conv_id)
        st, raw, _ = http("DELETE", f"/api/conversations/{conv_id}")
        print("CONV_DELETE_STATUS", st, raw[:200])
        gone = con.execute("SELECT COUNT(*) n FROM conversations WHERE id = ?", (conv_id,)).fetchone()["n"]
        print("CONV_GONE", int(gone == 0))
        conv_id = None

        after = snapshot(con, "AFTER")
        print("LIVE_UNTOUCHED memories_delta=%s summaries_delta=%s" % (
            int(after[0] != before[0]), int(after[1] != before[1])
        ))
        print("MEM_BEFORE", before[0])
        print("MEM_AFTER", after[0])
        print("SUM_BEFORE", before[1])
        print("SUM_AFTER", after[1])
        if after[0] != before[0] or after[1] != before[1] or after[2] != 0:
            print("LIVE_DRIFT")
        else:
            print("LIVE_UNTOUCHED_OK")
        print("D1_DONE")
    except Exception:
        print("D1_FAIL")
        traceback.print_exc()
        try:
            cleanup(con)
        except Exception:
            print("CLEANUP_FAIL")
            traceback.print_exc()
        sys.exit(1)
    finally:
        con.close()


if __name__ == "__main__":
    main()
