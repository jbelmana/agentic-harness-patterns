#!/bin/bash
# relay-spawn-arms.sh — the launcher arms for relay-spawn.sh.
#
# SOURCED, NEVER EXECUTED. relay-spawn.sh resolves this file relative to its own
# $0 (the relay-await-ack.sh:23-24 idiom) so the pair works in-repo and after the
# forward-copy to ~/.claude. Running this file directly does nothing useful: it
# defines functions and returns.
#
# Every function here reads GLOBALS the main script owns — INNER, SCRIPT_ARG,
# ACTIVATE_ARG, TERM_CHOICE, TOKEN, CHAIN, GENERATION, HANDOFF_RESOLVED — so the
# arms stay argument-free and the trust gates stay in one file.

# Launcher stderr goes to $TMPDIR, not bare /tmp: under the Bash sandbox /tmp is
# outside the write allowlist, so the redirect failed and took the whole launch
# with it. Per-run mktemp: a fixed shared path let confirm_successor print a
# STALE error from a previous run's arm, and
# concurrent spawns clobbered each other's file.
LAUNCH_ERR="$(mktemp "${TMPDIR:-/tmp}/relay-launch-err.XXXXXX" 2>/dev/null || echo "${TMPDIR:-/tmp}/relay-launch-err.$$")"

# arm_from_term_program — the default arm when $CLAUDE_RELAY_TERM is unset.
# Case-insensitive because Orca reports "Orca" while Ghostty reports "ghostty"
# (the casing convention comes from a teammate's spawner). Anything else falls
# back to ghostty rather than to a paste: teammate sessions run under the tmux
# shim (TERM_PROGRAM=tmux) and a clipboard-else rule would regress them.
arm_from_term_program() {
  case "$(printf '%s' "${TERM_PROGRAM:-}" | tr '[:upper:]' '[:lower:]')" in
    orca) echo orca;;
    *) echo ghostty;;
  esac
}

# validate_arm <term-choice> — accept a supported emulator, else exit 64 (usage).
validate_arm() {
  case "$1" in
    ghostty|terminal|orca) ;;
    *)
      echo "unsupported CLAUDE_RELAY_TERM: $1 (want: ghostty | terminal | orca)" >&2
      exit 64 ;;
  esac
}

# derive_bind — the worktree Orca binds the new tab to: the MAIN checkout of
# $TARGET_CWD, never the linked worktree. A linked worktree may not be registered
# with Orca and there is no cheap way to ask (this is what a teammate's
# five-spawn kill loop turned on); the main checkout is registered whenever the repo
# is open in Orca at all, and the `cd` inside $INNER keeps the successor's cwd
# authoritative. A submodule (<super>/.git/modules/<n>) or bare layout keeps
# $TARGET_CWD — dirname() of either is not a checkout. A not-yet-created dry-run
# worktree makes git fail outright, so the chain's resolved repo_root stands in.
derive_bind() {
  local common="" main="" cand=""
  common="$(git -C "$TARGET_CWD" rev-parse --git-common-dir 2>/dev/null)" || common=""
  if [ -z "$common" ]; then cand="${REPO_RESOLVED:-$TARGET_CWD}"
  else
    case "$common" in /*) ;; *) common="$TARGET_CWD/$common";; esac
    if [ "$(basename "$common")" = ".git" ]; then
      main="$(cd "$(dirname "$common")" 2>/dev/null && pwd -P)" || main=""
    fi
    if [ -n "$main" ] && [ -d "$main" ]; then cand="$main"; else cand="$TARGET_CWD"; fi
  fi
  # From review: REPO_RESOLVED (shared policy) and an out-of-roots main checkout are
  # the two candidates NOT covered by the TARGET_CWD gate — re-gate, fall back to
  # the already-gated launch cwd so BIND can never name an untrusted path.
  is_trusted "$cand" || cand="$TARGET_CWD"
  printf '%s\n' "$cand"
}

# prepare_launch — the arm-independent launch facts every arm and the dry-run
# preview read. --focus unless CLAUDE_RELAY_NO_FOCUS: without it Orca creates the
# tab "without switching focus when possible", so a handoff the operator is
# waiting on appears in a workspace nobody is looking at.
prepare_launch() {
  BIND="$(derive_bind)"
  ORCA_TITLE="relay-g$GENERATION-$(basename "$BIND")"
  ORCA_FOCUS=""
  [ -n "${CLAUDE_RELAY_NO_FOCUS:-}" ] || ORCA_FOCUS="--focus"
}

# spawn_orca — create the tab, then VERIFY it rather than trusting exit 0.
# NOTE, and it is the whole reason this function returns instead of cleaning up:
# ok:true plus a handle means the command is ALREADY running, so a failed assert
# must never `orca terminal close` the tab it just opened — that is exactly how,
# in one reported incident, five live successors were killed. Read the tab back
# instead. Returns 1 on any failed assert; the caller turns that into 5.
spawn_orca() {
  local out handle surface landed
  # stderr stays OUT of the jq input: non-JSON noise on a successful
  # create used to break the handle extraction and exit 5 with the tab open.
  # shellcheck disable=SC2086  # ORCA_FOCUS is a single literal flag or empty
  out=$(orca terminal create --worktree path:"$BIND" --title "$ORCA_TITLE" \
        --command "$INNER" $ORCA_FOCUS --json 2>"$LAUNCH_ERR") || {
    printf '%s\n' "$out" >&2; [ -s "$LAUNCH_ERR" ] && cat "$LAUNCH_ERR" >&2
    echo "orca terminal create failed" >&2; return 1; }
  handle=$(printf '%s' "$out" | jq -r '.result.terminal.handle // empty')
  surface=$(printf '%s' "$out" | jq -r '.result.terminal.surface // empty')
  landed=$(printf '%s' "$out" | jq -r '.result.terminal.worktreeId // empty')
  [ -n "$handle" ] || { echo "orca returned no terminal handle: $out" >&2; return 1; }
  [ "$surface" = "visible" ] || { echo "orca terminal is not visible (surface=$surface)" >&2; return 1; }
  # worktreeId is "<repo-id>::<path>", so WHERE the tab landed is checkable.
  case "$landed" in
    *"::$BIND") ;;
    "") echo "Warning: orca reported no worktreeId; could not confirm where the tab landed." >&2;;
    *) echo "orca put the terminal in the wrong worktree: wanted $BIND, got ${landed#*::}" >&2
       return 1;;
  esac
  echo "relay: orca terminal $handle bound to $BIND"
}

# announce_offer — the TOKEN the successor claims with, plus its env contract.
# Emitted BEFORE the launcher on the real path: exit 5 means "did not appear",
# which does NOT prove no session started, so the caller needs the token anyway.
announce_offer() {
  echo "TOKEN=$TOKEN"
  echo "CLAUDE_RELAY_CHAIN=$CHAIN"
  echo "CLAUDE_RELAY_GENERATION=$GENERATION"
}

# print_dry_run — the FULL invocation rather than just $INNER, so the escaping
# transform in the main script (the most injection-relevant line there) has a
# reachable test seam. Printed raw, not %q-quoted: a third escaping layer would
# obscure the very transform this seam exists to expose.
print_dry_run() {
  case "$TERM_CHOICE" in
    terminal) printf 'osascript -e %s -e %s\n' "$SCRIPT_ARG" "$ACTIVATE_ARG";;
    orca) printf 'orca terminal create --worktree path:%s --title %s --command %s%s --json\n' \
            "$BIND" "$ORCA_TITLE" "$(printf '%q' "$INNER")" "${ORCA_FOCUS:+ $ORCA_FOCUS}"
          echo "BIND=$BIND";;
    *) printf 'open -na Ghostty --args -e bash -lc %s\n' "$(printf '%q' "$INNER")";;
  esac
  announce_offer
}

# preflight_arm <arm> — is the SELECTED launcher installed at all? Returns 1 when
# it is not, which the caller turns into the clipboard fallback. "The launcher ran
# but nothing appeared" is a DIFFERENT failure and stays exit 5.
preflight_arm() {
  case "$1" in
    orca) command -v orca >/dev/null 2>&1 || return 1;;
    ghostty) [ -d "${CLAUDE_RELAY_GHOSTTY_APP:-/Applications/Ghostty.app}" ] || return 1;;
    terminal) [ -d /System/Applications/Utilities/Terminal.app ] || return 1;;
  esac
}

# clipboard_fallback <arm> — nothing can launch, so hand the operator the FULL
# launch command. A bare prompt dead-ends — its mandated /relay claim
# needs CLAUDE_RELAY_TOKEN/CHAIN in the environment, which only $INNER carries.
# So the paste artifact is $INNER (cd + env + `command claude …`); $PROMPT still
# prints for the doc seam — both come from the one composition.
# stdout is the GUARANTEED channel; pasteboard access under the Bash sandbox is
# unverified, so a pbcopy failure is noted and survived.
clipboard_fallback() {
  printf 'PROMPT=%s\n' "$PROMPT"
  printf 'PASTE=%s\n' "$INNER"
  if command -v pbcopy >/dev/null 2>&1; then printf '%s' "$INNER" | pbcopy 2>/dev/null || echo "relay: pbcopy failed; the launch command is on stdout" >&2
  else echo "relay: clipboard unavailable (no pbcopy); the prompt is on stdout" >&2; fi
  echo "no spawnable terminal for $1; run the PASTE= launch command (also on the clipboard) in a terminal you open yourself" >&2
  exit 8
}

spawn_terminal() {
  osascript -e "$SCRIPT_ARG" -e "$ACTIVATE_ARG" >/dev/null 2>"$LAUNCH_ERR" || true
}

spawn_ghostty() {
  open -na Ghostty --args -e bash -lc "$INNER" 2>"$LAUNCH_ERR" || true
}

spawn_arm() {
  case "$1" in
    orca) spawn_orca || exit 5;;
    terminal) spawn_terminal;;
    *) spawn_ghostty;;
  esac
}

# successor_running — did a successor actually start? Poll for a claude process
# whose command line carries THIS handoff path. Every arm needs this for the same
# reason: none reports child success. `open` returns 0 once LaunchServices accepts
# the request, and osascript can return non-zero on an AppleEvent REPLY timeout
# (-1712) while macOS still opens the window and runs the command — a false
# negative that, acted on, starts a second session on one checkout (observed
# 2026-08-24). Exit 5 means "polled and did not appear", not "the launcher said
# something".
# $CLAUDE_RELAY_POLL_SEC (default 20) is the test seam: the suites cannot
# afford a 20s window per launch, and production never sets it.
# A design review caught this: `pgrep -fl claude` matched the SPAWNER's own process tree — the
# invoking cmdline contains both "claude" (~/.claude/scripts/…) and the handoff
# path — so a silent launcher failure still read as "verified running".
# `dangerously-skip-permissions` appears only in the successor's argv.
successor_running() {
  local deadline=$(( SECONDS + ${CLAUDE_RELAY_POLL_SEC:-20} ))
  while [ "$SECONDS" -lt "$deadline" ]; do
    pgrep -fl -- dangerously-skip-permissions 2>/dev/null | grep -Fq -- "$HANDOFF_RESOLVED" && return 0
    sleep 1
  done
  return 1
}

confirm_successor() {
  successor_running || {
    echo "no successor appeared within ${CLAUDE_RELAY_POLL_SEC:-20}s (emulator: $TERM_CHOICE)" >&2
    [ -s "$LAUNCH_ERR" ] && sed 's/^/  launcher said: /' "$LAUNCH_ERR" >&2
    exit 5; }
  echo "relay: successor generation $GENERATION opened in $TERM_CHOICE (verified running)"
}
