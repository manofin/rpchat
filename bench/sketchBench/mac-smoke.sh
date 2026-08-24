#!/usr/bin/env bash
# Mac-only stub-image smoke for Task 3 orchestration (NOT a §4 measurement).
# Does not touch mac-exec.sh. Scratch is /tmp/sketchbench-smoke (not /tmp/bench).
#
# Default N_CHAT=8 / N_IMAGE=4 — smoke-only, not the preregistered N=20/N=10.
# Always passes --tag STUBIMG so results cannot be confused with Task 4.
#
# Usage (on Mac):
#   ./mac-smoke.sh
#   STUB_FAIL_EVERY_N=3 ./mac-smoke.sh
# Extra args after the script are forwarded to run-concurrent.ts.
set -euo pipefail

HOST="${RPCHAT_SSH_HOST:-rpchat}"
REMOTE="${RPCHAT_REMOTE:-/home/hermes/rpchat/app}"
SCRATCH="/tmp/sketchbench-smoke"
STUB_PORT="${STUB_PORT:-9999}"
N_CHAT="${N_CHAT:-8}"
N_IMAGE="${N_IMAGE:-4}"
IMG_INTERVAL="${IMG_INTERVAL:-3500}"
STUB_PID=""

cleanup() {
  local ec=$?
  if [[ -n "${STUB_PID}" ]] && kill -0 "${STUB_PID}" 2>/dev/null; then
    kill "${STUB_PID}" 2>/dev/null || true
    wait "${STUB_PID}" 2>/dev/null || true
  fi
  rm -rf "${SCRATCH}"
  exit "${ec}"
}
trap cleanup EXIT INT TERM

rm -rf "${SCRATCH}"
mkdir -p "${SCRATCH}"
ssh "${HOST}" "tar -C '${REMOTE}' -cf - bench/sketchBench --exclude=bench/sketchBench/results --exclude=bench/sketchBench/lib/queryGenerationLog.ts" | tar -xf - -C "${SCRATCH}"
# tar emits bench/sketchBench/... under SCRATCH
WORKDIR="${SCRATCH}/bench/sketchBench"
mkdir -p "${WORKDIR}/results"
cd "${WORKDIR}"

export GEMMA_PGREP="${GEMMA_PGREP:-Gemma-4-Dark-Thoughts}"
export STUB_PORT
export STUB_DELAY_MS="${STUB_DELAY_MS:-3000}"
export STUB_FAIL_EVERY_N="${STUB_FAIL_EVERY_N:-0}"
export DRAW_THINGS_BASE_URL="http://127.0.0.1:${STUB_PORT}"

npx tsx lib/stubDrawThingsServer.ts &
STUB_PID=$!

ok=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf "http://127.0.0.1:${STUB_PORT}/healthz" >/dev/null; then
    ok=1
    break
  fi
  sleep 0.5
done
if [[ "${ok}" -ne 1 ]]; then
  echo "stub /healthz did not become ready on 127.0.0.1:${STUB_PORT}" >&2
  exit 1
fi

npx tsx run-concurrent.ts \
  --tag STUBIMG \
  --n-chat "${N_CHAT}" \
  --n-image "${N_IMAGE}" \
  --image-interval-ms "${IMG_INTERVAL}" \
  "$@"

shopt -s nullglob
for f in "${WORKDIR}"/results/concurrent-STUBIMG-*.json; do
  base="$(basename "${f}")"
  if ssh "${HOST}" "test -f '${REMOTE}/bench/sketchBench/results/${base}'"; then
    echo "skip existing ${base}" >&2
  else
    ssh "${HOST}" "mkdir -p '${REMOTE}/bench/sketchBench/results' && cat > '${REMOTE}/bench/sketchBench/results/${base}'" < "${f}"
    echo "pushed ${base}" >&2
  fi
done
