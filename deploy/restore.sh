#!/usr/bin/env bash
# SQLite 백업 복원 (host, systemd --user — no docker on this deployment).
# 대상: deploy/backup-host.py 가 만든 rpchat-YYYYMMDD-HHMMSS.db.gz
# 사용법: ./restore.sh /home/hermes/rpchat/backups/rpchat-YYYYMMDD-HHMMSS.db.gz
set -euo pipefail

DB="${RPCHAT_DB:-/home/hermes/rpchat/data/rpchat.db}"
BACKUP_DIR="${RPCHAT_BACKUP_DIR:-/home/hermes/rpchat/backups}"
SERVICE="${RPCHAT_SERVICE:-rpchat.service}"
SRC="${1:?복원할 .db.gz 경로를 인자로 주세요 (예: /home/hermes/rpchat/backups/rpchat-YYYYMMDD-HHMMSS.db.gz)}"

[ -f "$SRC" ] || { echo "파일 없음: $SRC" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
gunzip -c "$SRC" > "$TMP/restore.db"

# 무결성 확인 — 라이브를 건드리기 전에 실패해야 한다.
CHECK="$(sqlite3 "$TMP/restore.db" 'PRAGMA integrity_check;')"
if [ "$CHECK" != "ok" ]; then
  echo "무결성 검사 실패: $CHECK" >&2
  exit 1
fi
CONV_COUNT="$(sqlite3 "$TMP/restore.db" 'SELECT count(*) FROM conversations;' 2>/dev/null || echo '?')"
MSG_COUNT="$(sqlite3 "$TMP/restore.db" 'SELECT count(*) FROM messages;' 2>/dev/null || echo '?')"
echo "복원 대상: $SRC"
echo "  integrity_check: ok, conversations=$CONV_COUNT, messages=$MSG_COUNT"

if [ -f "$DB" ]; then
  LIVE_CONV="$(sqlite3 "$DB" 'SELECT count(*) FROM conversations;' 2>/dev/null || echo '?')"
  LIVE_MSG="$(sqlite3 "$DB" 'SELECT count(*) FROM messages;' 2>/dev/null || echo '?')"
  echo "현재 라이브: conversations=$LIVE_CONV, messages=$LIVE_MSG"
fi

echo "경고: 현재 라이브 데이터($DB)를 덮어씁니다. systemd --user 서비스($SERVICE)를 먼저 중지합니다."
read -r -p "계속하려면 'yes' 입력: " ok
[ "$ok" = "yes" ] || { echo "취소됨"; exit 1; }

systemctl --user stop "$SERVICE"

if [ -f "$DB" ]; then
  mkdir -p "$BACKUP_DIR"
  PRE="$BACKUP_DIR/rpchat-pre-restore-$(date -u +%Y%m%d-%H%M%S).db"
  cp "$DB" "$PRE"
  echo "복원 전 라이브 안전판: $PRE (복원이 잘못됐을 때 이 파일로 되돌릴 것)"
fi

rm -f "$DB" "$DB-wal" "$DB-shm"
cp "$TMP/restore.db" "$DB"

systemctl --user start "$SERVICE"
sleep 2
if systemctl --user is-active --quiet "$SERVICE"; then
  echo "서비스 재기동 확인: active"
else
  echo "경고: 서비스가 active 상태가 아님 — journalctl --user -u $SERVICE 로 확인할 것" >&2
fi

echo "복원 완료. curl http://127.0.0.1:8787/api/health 로 db/모델 상태를 확인하세요."
