#!/usr/bin/env bash
# SQLite 온라인 백업. 앱이 실행 중이어도 .backup 은 일관된 스냅샷을 만든다.
# cron 예: 0 4 * * *  /opt/rpchat/deploy/backup.sh >> /var/log/rpchat-backup.log 2>&1
set -euo pipefail

VOLUME="${VOLUME:-rpchat-data}"          # docker volume ls 로 실제 이름 확인 (예: deploy_rpchat-data)
OUT_DIR="${OUT_DIR:-/opt/rpchat/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$OUT_DIR"

# sqlite3 CLI 이미지로 .backup 실행 (호스트에 sqlite3 설치 불필요).
docker run --rm \
  -v "${VOLUME}":/data:ro \
  -v "${OUT_DIR}":/backup \
  keinos/sqlite3:latest \
  sqlite3 /data/rpchat.db ".backup '/backup/rpchat-${STAMP}.db'"

gzip -f "${OUT_DIR}/rpchat-${STAMP}.db"
echo "[$(date -Is)] 백업 완료: ${OUT_DIR}/rpchat-${STAMP}.db.gz"

find "$OUT_DIR" -name 'rpchat-*.db.gz' -mtime +"${KEEP_DAYS}" -delete || true
echo "[$(date -Is)] ${KEEP_DAYS}일 초과 백업 정리 완료"
