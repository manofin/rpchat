#!/usr/bin/env bash
# Pull sketchBench (no results, no queryGenerationLog) from hermes, run a tsx
# entry on this Mac, push only new results/*.json back.
# Usage: ./mac-exec.sh run-concurrent.ts [args...]
#        ./mac-exec.sh run-image-gen.ts
# Host: RPCHAT_SSH_HOST (default rpchat). Scratch: /tmp/bench/sketchBench.
set -euo pipefail

HOST="${RPCHAT_SSH_HOST:-rpchat}"
REMOTE="${RPCHAT_REMOTE:-/home/hermes/rpchat/app}"
SCRATCH="/tmp/bench/sketchBench"
# §4.4-2 (Gemma eviction/reload) silently reports NA if this is unset — default
# it to the known llama-server cmdline pattern; override with GEMMA_PGREP=... if
# the model changes.
export GEMMA_PGREP="${GEMMA_PGREP:-Gemma-4-Dark-Thoughts}"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <tsx-entry> [args...]" >&2
  exit 2
fi

rm -rf /tmp/bench
mkdir -p /tmp
ssh "$HOST" "tar -C '$REMOTE' -cf - bench/sketchBench --exclude=bench/sketchBench/results --exclude=bench/sketchBench/lib/queryGenerationLog.ts" | tar -xf - -C /tmp/
mkdir -p "$SCRATCH/results"
cd "$SCRATCH"
npx tsx "$@"
mkdir -p "$SCRATCH/results"

shopt -s nullglob
for f in "$SCRATCH"/results/*.json; do
  base="$(basename "$f")"
  if ssh "$HOST" "test -f '$REMOTE/bench/sketchBench/results/$base'"; then
    echo "skip existing $base" >&2
  else
    ssh "$HOST" "mkdir -p '$REMOTE/bench/sketchBench/results' && cat > '$REMOTE/bench/sketchBench/results/$base'" < "$f"
    echo "pushed $base" >&2
  fi
done
