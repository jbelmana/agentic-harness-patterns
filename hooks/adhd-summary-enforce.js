#!/usr/bin/env node
// adhd-summary-enforce.js -- global Stop hook (an operator preference).
//
// One gate enforces the whole close-out:
//   A. File-changing turns must END with the Summary:/- Done:/- Next: trailer.
//   B. If a trailer is present on a substantive reply, the ADHD block
//      (## <chequered-flag> headline + <black-star> Insight box) must sit ABOVE it.
// Both checks share one block-once discipline: stop_hook_active stands down,
// and a per-session sentinel caps consecutive blocks at MAX_BLOCKS.
//
// Rule source:  ~/.claude/rules/interaction-style.md
// It is deliberately a GLOBAL user hook rather than an in-project one: a project
// whose tooling rewrites its own checkout can revert an in-project patch, and a
// close-out gate that a project can revert is not a gate. Flush-race guards are
// load-bearing -- Stop can fire before the final text is flushed, and ambiguity
// is never a violation.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BLOCKS = 2; // cap re-fires: each block replays full session context

function walkTranscript(transcriptPath) {
  // From the end: final assistant text, whether files changed since the last
  // real user turn, and the flush-race tell (tool activity newer than text).
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  let assistantText = '';
  let changedFiles = false;
  let newestTextIdx = -1;
  let newestToolIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch (e) { continue; }
    const msg = entry.message;
    if (!msg) continue;
    if (entry.type === 'assistant') {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const b of blocks) {
        if (b.type === 'text' && !assistantText) {
          assistantText = b.text || '';
          if (newestTextIdx < 0) newestTextIdx = i;
        }
        if (b.type === 'tool_use') {
          if (newestToolIdx < 0) newestToolIdx = i;
          if (['Write', 'Edit', 'NotebookEdit'].includes(b.name)) changedFiles = true;
        }
      }
    } else if (entry.type === 'user') {
      const c = msg.content;
      const isToolResult = Array.isArray(c) && c.some((b) => b.type === 'tool_result');
      if (!isToolResult) break; // real user turn boundary
    }
  }
  return { assistantText, changedFiles, finalTextUnflushed: newestToolIdx > newestTextIdx };
}

function emitBlock(sentinel, reason) {
  let blocks = 0;
  try { blocks = parseInt(fs.readFileSync(sentinel, 'utf8'), 10) || 0; } catch (e) {}
  if (blocks >= MAX_BLOCKS) return; // cap reached: let the turn end
  try { fs.writeFileSync(sentinel, String(blocks + 1)); } catch (e) {}
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  try {
    const hook = JSON.parse(input);
    if (hook.stop_hook_active) return process.exit(0); // another gate already blocked
    const sessionId = hook.session_id || 'unknown';
    const sentinel = path.join(os.tmpdir(), `claude-adhd-enforce-${sessionId}`);

    let walked = null;
    if (hook.transcript_path) {
      try { walked = walkTranscript(hook.transcript_path); } catch (e) {}
    }
    const text =
      (typeof hook.last_assistant_message === 'string' && hook.last_assistant_message.trim()) ||
      (walked && walked.assistantText ? walked.assistantText.trim() : '');
    if (!text) return process.exit(0);

    // Done group greedy so a Done line mentioning "- Next:" doesn't truncate.
    const trailer = text.match(/(?:^|\s)Summary:\s*-\s*Done:\s+[\s\S]+-\s*Next:\s+[\s\S]+?\s*$/i);

    // Check A (from summary-trailer-enforce): changed files require a trailer.
    if (!trailer && walked && walked.changedFiles && !walked.finalTextUnflushed) {
      emitBlock(
        sentinel,
        'Files were changed this turn but the reply has no close-out trailer. End with exactly: `Summary:` then `- Done: <what changed, commands run, verification state>` then `- Next: <one owner-first action, or "No further action">`. (merged close-out gate, blocks once)',
      );
      return process.exit(0);
    }
    if (!trailer) return process.exit(0); // chat-only turn without trailer: inert

    // Check B: substantive reply with a trailer needs the ADHD block above it.
    const preTrailer = text.slice(0, trailer.index);
    const substantive = text.length >= 1200; // short/trivial turns exempt
    // \u{1F3C1} = chequered flag; kept as escape so this file never contains
    // the literal marker it scans for.
    //
    // Loosened 2026-08-25: these were exact `includes()` matches, so a compliant
    // close-out rendered as `★ **Insight**` (bold, which reads better) failed the
    // gate and blocked twice in a row with a message asserting the box was
    // "missing" when it was present. Detectors must not fail on cosmetic
    // variation of the thing they require. Now tolerated: any heading depth,
    // flexible whitespace, and optional bold/emphasis around "Insight".
    // 2026-08-26: headline accepts \u{23F3} (hourglass) too -- the flag is now
    // reserved for truly-done turns; partial turns headline with the hourglass.
    const headingRe = /#{2,}\s*(?:\u{1F3C1}|\u{23F3})/u;
    const insightRe = /★\s*[*_]{0,2}\s*Insight/iu;
    const hasBlock = headingRe.test(preTrailer) && insightRe.test(preTrailer);
    if (substantive && !hasBlock) {
      emitBlock(
        sentinel,
        'ADHD close-out missing: a substantive final reply must render `## \u{1F3C1}` (done) or `## \u{23F3}` (in flight) `<verb-first headline>` + a shipped-table + a `★ Insight` box ABOVE the `Summary:` trailer (per the harness\'s interaction-style rule). Short/trivial turns are exempt.',
      );
      return process.exit(0);
    }

    // Check C: terminal state line -- the LAST line must declare done-ness so
    // the user can find it at the bottom without reading (added 2026-08-26).
    // Check D: the headline emoji must agree with it.
    const lastLine = text.trim().split('\n').pop().trim();
    const isDone = /^\u{1F3C1}{1,3}\s*DONE\b/u.test(lastLine);
    const isNotDone = /^\u{23F3}\s*NOT DONE\b/u.test(lastLine);
    if (!isDone && !isNotDone) {
      emitBlock(
        sentinel,
        'Terminal state line missing: the LAST line of a turn-ending reply must be exactly one of `\u{1F3C1}\u{1F3C1}\u{1F3C1} DONE — nothing in flight, nothing waiting on me` (only if zero running agents/tasks, zero promised follow-ups) or `\u{23F3} NOT DONE — in flight: <what> · waiting on: <who>`. (close-out gate Check C, blocks once)',
      );
      return process.exit(0);
    }
    const headIsDone = /#{2,}\s*\u{1F3C1}/u.test(preTrailer);
    const headIsNotDone = /#{2,}\s*\u{23F3}/u.test(preTrailer);
    if ((isDone && headIsNotDone && !headIsDone) || (isNotDone && headIsDone && !headIsNotDone)) {
      emitBlock(
        sentinel,
        'Headline/terminal-state mismatch: `\u{1F3C1}` headline pairs only with the DONE line; `\u{23F3}` headline pairs only with the NOT DONE line. Fix whichever is wrong. (close-out gate Check D, blocks once)',
      );
      return process.exit(0);
    }
    try { fs.unlinkSync(sentinel); } catch (e) {} // compliant close-out resets counter
    return process.exit(0);
  } catch (e) {
    return process.exit(0); // fail-open: a hook must never break Stop
  }
});
