#!/bin/bash
# relay-spawn.sh — open a successor Claude Code session in a new terminal window.
#
# Usage: relay-spawn.sh <handoff-path> <generation> <chain-file> [--dry-run | --print-prompt]
#   --print-prompt runs every gate, prints the composed successor prompt and
#   exits 0 — it launches nothing, mints no token and mutates nothing. It exists
#   so the handoff doc's "Resume prompt" section is SOURCED from the same
#   composition the launcher runs instead of being retyped beside it.
#
# Terminal emulator: "ghostty", "terminal" (osascript) or "orca".
#   $CLAUDE_RELAY_TERM wins when set. Otherwise the arm is derived from
#   $TERM_PROGRAM, case-insensitively: "Orca" -> orca, everything else ->
#   ghostty. Unknown is deliberately NOT a clipboard-else: Orca teammate
#   sessions run under the tmux shim (TERM_PROGRAM=tmux) and that rule would
#   regress them to a paste. macOS Terminal.app is never a default: a relay
#   that lands in an emulator nobody watches has to be found by hand.
#   The orca arm runs `orca terminal create --worktree path:$BIND … --json` and
#   VERIFIES the result (handle, surface=visible, worktreeId ends in ::$BIND)
#   rather than trusting exit 0. $BIND is the MAIN checkout of the launch cwd —
#   a linked worktree may not be registered with Orca and there is no cheap way
#   to ask — while the `cd` inside the command keeps the successor's cwd
#   authoritative. A failed assert reports and stops; it never closes the tab.
#
# Environment knobs:
#   CLAUDE_RELAY_TERM        force an arm: ghostty | terminal | orca
#   CLAUDE_RELAY_NO_FOCUS    set to drop --focus from the orca create call
#   CLAUDE_RELAY_POLL_SEC    liveness-poll window in seconds (default 20)
#   CLAUDE_RELAY_GHOSTTY_APP Ghostty.app location for the pre-flight check
#   CLAUDE_RELAY_TRUSTED_ROOTS  colon-separated roots a successor may launch
#                            from (default "$HOME/Projects")
#
#   <generation> is the SUCCESSOR's generation — the caller passes current + 1.
#   This script forwards the value UNCHANGED; it never increments. A caller that
#   passes its own current generation instead never trips the cap, which yields
#   exactly the unbounded relay chain the cap exists to prevent.
#
# Exit codes (the caller documents these — keep them stable):
#    0  successor launched, or dry-run composed
#    2  cwd, chain repo_root, or launch cwd is outside the trusted roots, or the
#       chain file is outside BOTH its own repo_root and the legacy relay dir
#    3  handoff file not found
#    4  handoff path is outside the trusted roots
#    5  the emulator did not open a session (verified, not merely reported —
#       see the -1712 note at the launch block)
#    6  chain file not found or invalid (missing spawn_policy / generation.cap)
#    7  worktree creation failed (spawn_policy=worktree)
#    8  no spawnable terminal for the selected arm (the launcher is not
#       installed): the composed prompt is printed to stdout and copied to the
#       clipboard so the operator can paste it into a session by hand. 3 keeps
#       its own meaning — "handoff file not found" — and is never reused here.
#   64  bad usage: wrong argument count, non-integer generation,
#       unrecognized fourth argument, generation cap reached, or an
#       unsupported $CLAUDE_RELAY_TERM value
#
# SAFETY RAILS, and why each exists:
#  - `command claude` bypasses any shell alias named `claude`. Such an alias may
#    add flags (a chat-listener flag, say) whose effects do not compose across
#    two concurrent sessions.
#  - Trusted-root allowlist: the successor runs with --dangerously-skip-permissions,
#    so it must never be launched from an arbitrary directory. The HANDOFF file AND
#    the CHAIN file are held to the same allowlist, because both are the successor's
#    INSTRUCTION SOURCE and therefore strictly stronger levers than the cwd ever was.
#    The chain also SUPPLIES the launch cwd (repo_root / worktree) and the cap, so
#    the resolved repo_root and the finalized launch cwd are each re-gated before the
#    permission-free successor is composed.
#  - The third argument is validated strictly. --dry-run is a safety flag, and a
#    safety flag must fail CLOSED: a typo like `--dryrun` must never fall through
#    to a real, permission-free session launch.
#  - The git prohibition is restated INSIDE the prompt because skipping permission
#    prompts also skips the gate that normally enforces it.
#  - Generation cap: without it, a successor that also crosses the threshold
#    spawns its own successor, forever. The cap is read from the chain but clamped
#    to HARD_MAX_GENERATION, so a forged chain cap can only lower it, never raise it.
#
# CHAIN LOCATION (2026-08-26 decision, tightened 2026-08-27): chains live at
# <repo_root>/.relay/ — the one directory BOTH sides can write: the predecessor's
# cwd is the repo, and a shared-policy successor is launched there too, so the
# claim write lands inside its sandbox allowlist ("."). The chain gate accepts a
# chain under its OWN repo_root or under ~/.claude/relay (the legacy home), and
# nowhere else — see is_trusted_chain below.
# Known limitation: a worktree-policy successor's cwd is the worktree, so its
# claim write to <repo_root>/.relay may still need a sandbox grant — that is one
# write, surfaced loudly, vs. the old default failing on EVERY location.
set -euo pipefail

# The launcher arms live in a sourced sibling so this file stays under the 200-LOC
# counter. Resolved relative to THIS script (the relay-await-ack.sh idiom),
# never a hardcoded $HOME path, so the pair works in-repo (scripts/ + scripts/lib/
# siblings) and after the forward-copy to ~/.claude. A forward copy that takes
# only this file must fail LOUDLY right here — not as a bash parse error further
# down, where the message would name a symbol instead of the missing file.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$SELF_DIR/lib/relay-spawn-arms.sh" ] || { echo "relay-spawn.sh: missing scripts/lib/relay-spawn-arms.sh beside the script" >&2; exit 64; }
. "$SELF_DIR/lib/relay-spawn-arms.sh"

# Roots a permission-free successor may be launched from. Colon-separated in
# CLAUDE_RELAY_TRUSTED_ROOTS so an operator points it at wherever they keep
# repos; relay-dirs.js reads the SAME variable, so the two can never disagree.
# EMPTY segments are dropped, exactly as relay-dirs.js does with
# `.split(':').filter(Boolean)`. This is load-bearing, not tidiness: `read -a`
# keeps a leading/doubled/trailing colon as an empty field, and an empty root
# reaches the gate below as the pattern `/*`, which matches EVERY absolute path.
# One stray colon would silently turn the allowlist into "everything".
IFS=: read -r -a _RAW_ROOTS <<< "${CLAUDE_RELAY_TRUSTED_ROOTS:-$HOME/Projects}"
TRUSTED_ROOTS=()
for _root in ${_RAW_ROOTS[@]+"${_RAW_ROOTS[@]}"}; do
  if [ -n "$_root" ]; then TRUSTED_ROOTS+=("$_root"); fi
done
unset _RAW_ROOTS _root
# An all-empty value leaves ZERO roots, and is_trusted then refuses everything —
# fail closed. The `[@]+` guard keeps that from tripping `set -u` on bash 3.2.
# Generation cap is read from the chain file (.generation.cap), but clamped to an
# unforgeable ceiling: a forged chain cap may lower the loop bound, never raise it.
HARD_MAX_GENERATION=10
USAGE="usage: relay-spawn.sh <handoff-path> <generation> <chain-file> [--dry-run | --print-prompt]
  <generation> is the SUCCESSOR's generation — pass current + 1; this script
  never increments it."

# is_trusted <absolute-path> — 0 when the path lies under a trusted root, else 1.
# Shared by the cwd gate and the handoff gate so the two can never drift apart.
is_trusted() {
  local candidate="$1" root
  local matched=1
  # nocasematch because macOS filesystems are case-insensitive by default: the
  # same tree is reachable under either casing, and a case-sensitive guard
  # would refuse a legitimate path.
  shopt -s nocasematch
  for root in ${TRUSTED_ROOTS[@]+"${TRUSTED_ROOTS[@]}"}; do
    # Belt and braces: an empty root would make the pattern `/*` and match
    # every absolute path. The array is filtered at build time; this is the
    # second lock, because the cost of the gate failing OPEN is a
    # permission-free session launched from an attacker-chosen directory.
    [ -n "$root" ] || continue
    case "$candidate/" in "$root"/*) matched=0;; esac
  done
  shopt -u nocasematch
  return "$matched"
}

# --- Usage validation first: it guards the inputs every later check reads. ---
[ $# -ge 3 ] && [ $# -le 4 ] || { printf '%s\n' "$USAGE" >&2; exit 64; }
HANDOFF="$1"; GENERATION="$2"; CHAIN="$3"; DRY_RUN="${4:-}"

[[ "$GENERATION" =~ ^[0-9]+$ ]] || { echo "generation must be an integer" >&2; exit 64; }
[ -z "$DRY_RUN" ] || [ "$DRY_RUN" = "--dry-run" ] || [ "$DRY_RUN" = "--print-prompt" ] || {
  echo "unrecognized argument: $DRY_RUN" >&2; printf '%s\n' "$USAGE" >&2; exit 64; }

# --- Trust gates next, so a trust refusal is never masked by a later check. ---
CWD="$(pwd -P)"
is_trusted "$CWD" || { echo "refusing to spawn: $CWD is outside the trusted roots" >&2; exit 2; }

# --- Chain gate: the chain is an INSTRUCTION SOURCE (it carries the launch cwd,
# the generation cap, and the successor's resume target), so it is held to the same
# trusted-root allowlist as the handoff and the cwd — resolved with the handoff
# gate's pwd -P idiom (dirname -> pwd -P -> re-append basename) so ".." segments and
# symlinked components cannot escape the roots. Existence (exit 6) is checked before
# trust (exit 2) so a plain missing-file keeps its own code. ---
[ -f "$CHAIN" ] || { echo "chain file not found: $CHAIN" >&2; exit 6; }
CHAIN_DIR="$(cd "$(dirname "$CHAIN")" 2>/dev/null && pwd -P)" || CHAIN_DIR=""
[ -n "$CHAIN_DIR" ] || { echo "refusing to spawn: cannot resolve chain path: $CHAIN" >&2; exit 2; }
CHAIN="$CHAIN_DIR/$(basename "$CHAIN")"

# repo_root is read BEFORE the trust gate because the gate needs it to know where
# this chain is ALLOWED to live — but ONLY repo_root, and the shape check stays
# below the gate so a trust refusal is still never masked by a later check.
# Reading a not-yet-trusted file is safe: jq parses, it does not execute, and
# nothing read here is acted on until the gate passes.
REPO_ROOT=$(jq -r '.repo_root' "$CHAIN" 2>/dev/null) || REPO_ROOT=""

# Resolve the chain-supplied repo_root once, here, for two consumers: the chain
# gate below and the worktree launch location further down. The emptiness test is
# load-bearing — `cd "" && pwd -P` SUCCEEDS in bash and yields the current
# directory, which would silently make the cwd an accepted chain home.
REPO_RESOLVED=""
if [ -n "$REPO_ROOT" ] && [ "$REPO_ROOT" != "null" ]; then
  REPO_RESOLVED="$(cd "$REPO_ROOT" 2>/dev/null && pwd -P)" || REPO_RESOLVED=""
fi

# A chain has exactly TWO accepted homes:
#   1. its OWN resolved repo_root — which must itself be under a trusted root, so
#      a forged repo_root buys nothing. "Somewhere under a trusted root" was too
#      wide: a chain planted in repo A could hand a permission-free successor
#      launched in repo B a ledger nobody in B wrote.
#   2. $HOME/.claude/relay — the relay library's legacy chain home. Without it,
#      /relay chain-create could never spawn from the documented default
#      location. Retire this arm when the legacy dir goes.
# Arm 2 is the only widening, and it is CHAIN-ONLY: the cwd, handoff, and
# launch-cwd gates stay on TRUSTED_ROOTS — an operator-written chain home is not
# a launch location.
is_trusted_chain() {
  local candidate="$1" ok=1 owner=""
  # Resolve the repo-root arm BEFORE enabling nocasematch: is_trusted toggles the
  # option off on its way out, which would silently make the cases below
  # case-sensitive on this case-insensitive filesystem.
  if [ -n "$REPO_RESOLVED" ] && is_trusted "$REPO_RESOLVED"; then owner="$REPO_RESOLVED"; fi
  shopt -s nocasematch
  if [ -n "$owner" ]; then
    case "$candidate/" in "$owner"/*) ok=0;; esac
  fi
  case "$candidate/" in "$HOME/.claude/relay"/*) ok=0;; esac
  shopt -u nocasematch
  return "$ok"
}
is_trusted_chain "$CHAIN" || {
  echo "refusing to spawn: chain $CHAIN is outside its repo_root and the legacy relay dir" >&2
  exit 2; }

# Shape check on the now trust-gated chain (Task 1 shape).
jq -e '.spawn_policy and .generation.cap' "$CHAIN" >/dev/null 2>&1 \
  || { echo "chain file invalid (missing spawn_policy / generation.cap): $CHAIN" >&2; exit 6; }
# Clamp the chain-supplied cap to HARD_MAX_GENERATION: the chain may LOWER the loop
# bound, never raise it. A cap < 1 (or non-numeric) falls back to the hard ceiling
# rather than disabling the bound outright.
CAP=$(jq -r '.generation.cap' "$CHAIN") || CAP=""; [ "$CAP" -ge 1 ] 2>/dev/null || CAP=$HARD_MAX_GENERATION
[ "$CAP" -gt "$HARD_MAX_GENERATION" ] && CAP=$HARD_MAX_GENERATION
POLICY=$(jq -r '.spawn_policy' "$CHAIN")

# Forwarded, never incremented — see the <generation> note in the usage block.
# CAP replaces the old hardcoded MAX_GENERATION=3.
[ "$GENERATION" -lt "$CAP" ] || { echo "generation cap ($CAP) reached" >&2; exit 64; }

[ -f "$HANDOFF" ] || { echo "handoff not found: $HANDOFF" >&2; exit 3; }
# Resolve the containing directory the same way pwd -P resolves the cwd, so that
# ".." segments and symlinked directory components cannot escape the roots.
HANDOFF_DIR="$(cd "$(dirname "$HANDOFF")" 2>/dev/null && pwd -P)" || HANDOFF_DIR=""
[ -n "$HANDOFF_DIR" ] || { echo "refusing to spawn: cannot resolve handoff: $HANDOFF" >&2; exit 4; }
HANDOFF_RESOLVED="$HANDOFF_DIR/$(basename "$HANDOFF")"
is_trusted "$HANDOFF_RESOLVED" || {
  echo "refusing to spawn: handoff $HANDOFF_RESOLVED is outside the trusted roots" >&2; exit 4; }

RESUME="Read '$HANDOFF_RESOLVED' and continue that work."
# The GSD planning tree; override for a project that keeps state elsewhere.
PLANNING_DIR="${CLAUDE_RELAY_PLANNING_DIR:-.planning}"
if [ -f "$CWD/$PLANNING_DIR/STATE.md" ]; then
  RESUME="Run /gsd-resume-work first — STATE.md is canonical here — then read '$HANDOFF_RESOLVED' as supplementary session context and continue."
fi

# FIRST ACTION is the claim — an observed dual-controller collision happened
# because the successor prompt never named /relay claim: the gen-1 successor
# worked unclaimed while the predecessor kept driving. The claim directive
# leads, and a failed claim halts the successor.
PROMPT="You are a relay successor session. FIRST ACTION, before anything else: run /relay claim to claim the baton for this chain. If the claim fails, STOP — report the failure via /relay status and do nothing further. Only after a verified claim: $RESUME You are continuing work handed off because the previous session's context filled up. You are running without permission prompts. Git authority: pushing the chain's own relay/<chain_id> branch, opening its PR, and gh pr merge proceed under the repository's standing authorizations in its CLAUDE.md — that is the T-ship pathway; do NOT run git push --force, git rebase, git reset --hard, git merge, git branch -D, or any push to master unless the operator authorizes it in this session."

# --- Print-prompt exits HERE, above the identity block: the gates that shape the
# PROMPT have all run (cwd 2, chain 2/6, cap 64, handoff 3/4), and the
# worktree-policy repo_root gate below is replicated so a chain the real
# spawn would refuse (exit 2) cannot mint a doc-embedded Resume prompt. No token
# is minted, no worktree created, no chain write. ---
if [ "$DRY_RUN" = "--print-prompt" ]; then
  if [ "$POLICY" = "worktree" ] && [ -n "$REPO_ROOT" ] && [ "$REPO_ROOT" != "null" ]; then
    { [ -n "$REPO_RESOLVED" ] && is_trusted "$REPO_RESOLVED"; } \
      || { echo "refusing: chain repo_root is unreadable or outside the trusted roots" >&2; exit 2; }
  fi
  printf '%s\n' "$PROMPT"; exit 0
fi

# --- Identity + worktree policy (v2): successor token, chain path, target cwd. ---
TOKEN=$(uuidgen)
TARGET_CWD="$CWD"
if [ "$POLICY" = "worktree" ] && [ -n "$REPO_ROOT" ] && [ "$REPO_ROOT" != "null" ]; then
  # The chain-supplied repo_root becomes the successor's launch location, so gate it
  # BEFORE `git worktree add` and BEFORE the dry-run branch (a dry-run must enforce
  # it too): a forged repo_root (e.g. /tmp/evil) must never host a permission-free
  # successor. REPO_RESOLVED was computed with the chain reads above; here the
  # failures are FATAL, whereas the chain gate merely declines that arm.
  [ -n "$REPO_RESOLVED" ] || { echo "repo_root unreadable: $REPO_ROOT" >&2; exit 2; }
  is_trusted "$REPO_RESOLVED" || { echo "refusing: chain repo_root $REPO_RESOLVED is outside the trusted roots" >&2; exit 2; }
  REPO_ROOT="$REPO_RESOLVED"
  WT="$REPO_ROOT/.wt-relay-g$GENERATION"
  TARGET_CWD="$WT"
  # Creation is DEFERRED until after arm validation + preflight: a
  # typo'd CLAUDE_RELAY_TERM (exit 64) or a missing launcher (exit 8) used to
  # strand an orphan worktree that bricked the corrected retry with exit 7.
  if [ "$DRY_RUN" = "--dry-run" ]; then
    echo "worktree not created (dry-run): $WT" >&2
  fi
fi

# Final trust gate: TARGET_CWD is the ACTUAL launch cwd for the permission-free
# successor (the trusted cwd under `shared`, or the worktree under `worktree`).
# Gate it explicitly with the handoff gate's idiom — resolve the PARENT with pwd -P
# (it always exists: the cwd's parent, or the already-trusted repo_root) and
# re-append the basename, so an as-yet-uncreated dry-run worktree still resolves
# while ".."/symlinks cannot escape the roots.
TARGET_DIR="$(cd "$(dirname "$TARGET_CWD")" 2>/dev/null && pwd -P)" || TARGET_DIR=""
[ -n "$TARGET_DIR" ] || { echo "refusing to spawn: cannot resolve launch cwd: $TARGET_CWD" >&2; exit 2; }
TARGET_CWD="$TARGET_DIR/$(basename "$TARGET_CWD")"
is_trusted "$TARGET_CWD" || {
  echo "refusing to spawn: launch cwd $TARGET_CWD is outside the trusted roots" >&2; exit 2; }

# v2 gains CLAUDE_RELAY_TOKEN and CLAUDE_RELAY_CHAIN before `command claude`;
# CLAUDE_RELAY_GENERATION and the `command claude --dangerously-skip-permissions`
# bypass carry over from v1 VERBATIM. cwd is TARGET_CWD (worktree, else trusted cwd).
INNER="cd $(printf '%q' "$TARGET_CWD") && CLAUDE_RELAY_TOKEN=$(printf '%q' "$TOKEN") CLAUDE_RELAY_CHAIN=$(printf '%q' "$CHAIN") CLAUDE_RELAY_GENERATION=$GENERATION command claude --dangerously-skip-permissions $(printf '%q' "$PROMPT")"

# AppleScript string escaping. Backslashes MUST be doubled before quotes are
# escaped — the reverse order would re-escape the backslashes this step adds.
ESCAPED="${INNER//\\/\\\\}"; ESCAPED="${ESCAPED//\"/\\\"}"
SCRIPT_ARG="tell application \"Terminal\" to do script \"$ESCAPED\""
ACTIVATE_ARG='tell application "Terminal" to activate'

# $BIND derives from the already trust-gated TARGET_CWD, so the Orca arm inherits
# that gate instead of introducing a second path source.
prepare_launch
TERM_CHOICE="${CLAUDE_RELAY_TERM:-$(arm_from_term_program)}"
validate_arm "$TERM_CHOICE"

# The dry-run preview and the three launcher arms live in scripts/lib/relay-spawn-arms.sh.
if [ "$DRY_RUN" = "--dry-run" ]; then print_dry_run; exit 0; fi

# Pre-flight BEFORE the offer echoes and the worktree: if the selected launcher
# is not installed, the PASTE= launch command (which carries the token env) goes
# to stdout + clipboard and the script exits 8 without touching the chain or the
# tree. The chain's baton was already offered by chain-create, so a hand-pasted
# session's /relay claim still succeeds.
preflight_arm "$TERM_CHOICE" || clipboard_fallback "$TERM_CHOICE"

# The worktree is created only now — every cheap refusal (64/8) is behind us; a
# failure here is the real exit 7.
if [ "$POLICY" = "worktree" ] && [ -n "${WT:-}" ]; then
  git -C "$REPO_ROOT" worktree add "$WT" HEAD >/dev/null 2>&1 \
    || { echo "worktree creation failed at $WT" >&2; exit 7; }
fi

announce_offer

# The spawn record is instrumentation, written on the REAL path only and
# BEFORE the launcher: a post-launch write would race the successor's claimBaton
# -> writeChain (load-then-rename, last writer wins) and could erase a fast claim.
# Pre-launch there is no second writer. RC_LIB resolves beside this script exactly
# as relay-await-ack.sh does. A failure warns and continues — losing the
# record is instrumentation loss, not loop-protection loss.
node -e '
  const rc = require(process.argv[2]);
  const r = rc.loadChain(process.argv[1]); if (!r.ok) process.exit(1);
  r.chain.spawn = { arm: process.argv[3], bind: process.argv[4],
                    generation: Number(process.argv[5]), at: new Date().toISOString() };
  rc.writeChain(process.argv[1], r.chain);
' "$CHAIN" "$SELF_DIR/../hooks/lib/relay-chain.js" "$TERM_CHOICE" "$BIND" "$GENERATION" \
  || echo "relay: could not record the spawn on the chain (instrumentation only)" >&2

spawn_arm "$TERM_CHOICE"
confirm_successor
