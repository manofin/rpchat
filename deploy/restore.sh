#!/usr/bin/env bash
# 백업 복원. 사용법: ./restore.sh /opt/rpchat/backups/rpchat-YYYYMMDD-HHMMSS.db.gz
set -euo pipefail
VOLUME="${VOLUME:-rpchat-data}"
SRC="${1:?복원할 .db.gz 경로를 인자로 주세요}"
TMP="$(mktemp -d)"
gunzip -c "$SRC" > "$TMP/rpchat.db"

echo "경고: 현재 데이터를 덮어씁니다. rpchat 컨테이너를 먼저 중지하세요 (docker compose stop)."
read -r -p "계속하려면 'yes' 입력: " ok
[ "$ok" = "yes" ] || { echo "취소됨"; exit 1; }

docker run --rm -v "${VOLUME}":/data -v "$TMP":/restore node:22-bookworm-slim \
  sh -c 'rm -f /data/rpchat.db /data/rpchat.db-wal /data/rpchat.db-shm && cp /restore/rpchat.db /data/rpchat.db && chown 1000:1000 /data/rpchat.db'
rm -rf "$TMP"
echo "복원 완료. docker compose start 로 재기동하세요."
