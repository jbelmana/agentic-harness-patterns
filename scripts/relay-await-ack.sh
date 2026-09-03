#!/bin/bash
# relay-await-ack.sh <chain-file> <predecessor-token> [timeout-sec=300]
#
# The predecessor calls this AFTER offering the baton (relay-spawn.sh has
# launched a successor). It polls the chain until a DIFFERENT holder has taken
# the baton — a successor claimed it, holder_token != predecessor's AND
# state=held — in which case it exits 0 and the predecessor may stand down.
# If the timeout elapses with no claim, it reverts the stale offer back to
# `held` (via relay-chain.js expireOffer) and appends an alert, so the
# predecessor keeps authority, then exits 1.
#
# relay-chain.js is resolved RELATIVE to THIS script ("$0"/../hooks/lib), never
# a hardcoded $HOME path (ledger ruling): the same file works in-repo
# (scripts/ + hooks/lib/ siblings) and after the forward-sync to ~/.claude.
set -u
CHAIN="$1"; MINE="$2"; TIMEOUT="${3:-300}"
# Validate the timeout up front: a non-integer (or < 1) would make the poll-loop
# guard `[ "$WAITED" -lt "$TIMEOUT" ]` error out falsey on the FIRST iteration and
# fall straight through to the baton revert — reverting authority without ever
# polling. Fail closed as a usage error (64) instead of silently reverting.
[[ "$TIMEOUT" =~ ^[0-9]+$ ]] && [ "$TIMEOUT" -ge 1 ] || {
  echo "timeout must be a positive integer (seconds): $TIMEOUT" >&2; exit 64; }
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
RC_LIB="$SELF_DIR/../hooks/lib/relay-chain.js"

# Poll cadence: 10s in production. Drop to 1s for sub-10s timeouts so a short
# timeout (the test uses 1s) resolves in one honest pass instead of a single
# 10s oversleep that would blow past the intended window.
STEP=10; [ "$TIMEOUT" -lt 10 ] && STEP=1

# WALL-CLOCK deadline, computed ONCE. A logged incident: the loop counted sleep
# durations, not elapsed time — jq/fs stalls between sleeps never counted, and
# the script sat 5m30+ past its 300s deadline until the operator expired the
# offer by hand. $SECONDS is bash's own monotonic
# elapsed-seconds counter; the loop now ends when the WINDOW ends, regardless of
# how long any single poll iteration took.
DEADLINE=$(( SECONDS + TIMEOUT ))
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  HOLDER=$(jq -r '.baton.holder_token' "$CHAIN" 2>/dev/null || echo "")
  STATE=$(jq -r '.baton.state' "$CHAIN" 2>/dev/null || echo "")
  if [ -n "$HOLDER" ] && [ "$HOLDER" != "$MINE" ] && [ "$STATE" = "held" ]; then
    echo "claimed by $HOLDER"; exit 0
  fi
  sleep "$STEP"
done

# Timeout: revert the stale offer to `held` and append the alert. timeoutSec:0
# because the poll loop has already waited the full window — any offer still
# standing here is, by definition, expired. reportSec carries the REAL window so
# the alert reads "ack timeout after ${TIMEOUT}s", not the misleading "after 0s"
# recorded live on 2026-08-26.
node -e '
  const rc = require(process.argv[2]);
  const f = process.argv[1];
  const r = rc.loadChain(f); if (!r.ok) process.exit(1);
  rc.writeChain(f, rc.expireOffer(r.chain,
    { now: new Date().toISOString(), timeoutSec: 0,
      reportSec: Number(process.argv[3]) }));
' "$CHAIN" "$RC_LIB" "$TIMEOUT"
echo "ack timeout — baton reverted, predecessor retains authority" >&2
exit 1
