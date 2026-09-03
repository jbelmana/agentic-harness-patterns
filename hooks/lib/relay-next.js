'use strict';
// relay-next.js — the backlog picker behind `/relay next`: how much of today's
// chain budget is spent, whether the next chain may start at all, and which
// backlog item it gets. Spec: the relay v2 design note, § "Review pathway —
// the loop that keeps the machine building".
//
// `pickNext` is pure by intent: nothing there shells out. The skill runs `rg` /
// `gsd-tools` and passes the resulting lines in, so every refusal string and
// every emitted task is covered by a test rather than by prose in a SKILL.md
// block. The I/O this file does keep is reading chain files — counting them for
// the day budget, and resolving the predecessor the gate reads.
//
// Dependency direction: relay-next.js → relay-chain.js, never the reverse. The
// skill requires THIS file directly (relay-chain.js does not re-export it).
const fs = require('node:fs');
const path = require('node:path');
const rc = require('./relay-chain.js');

const SOURCES = ['found-issues', 'gsd-next'];
const FOUND_ISSUES_LEDGER = 'DOCs/found-issues.md';
// The GSD planning tree. Read from the environment so this module, relay-spawn.sh
// and the skill's shell block all resolve the SAME directory — a hardcoded value
// here would emit an acceptance command pointing at a tree the spawner never
// looked in, and the chain would burn to loop.cap on a path that does not exist.
const PLANNING_DIR = process.env.CLAUDE_RELAY_PLANNING_DIR || '.planning';
const SYMPTOM_MAX = 100;
// A location is not always a path. `parseFoundIssue` splits on the ledger's
// ` — `, and a real ledger line may use ` -- ` as its primary separator, so a
// 426-char body lands in `location`. Truncate, never refuse: the pattern is
// matched as a prefix, so a shorter one still finds its own ledger line.
const LOCATION_MAX = 120;

const refusal = (code, message) => ({ refused: code, message });

// How many chains today's budget has already spent. Deliberately the INVERSE of
// resolveNewestChain's filter (relay-chain.js:118, which skips `.done.json`): a
// retired chain still cost its money, so it still counts against chains_per_day.
// A dir we cannot read and a chain we cannot parse are skipped, never thrown —
// a corrupt file must not be able to block the loop.
function chainsToday(dirs, todayISO) {
  const list = typeof dirs === 'string' ? [dirs] : (dirs || []);
  let count = 0;
  for (const dir of new Set(list)) {
    if (!dir || typeof dir !== 'string') continue;
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/^chain-.*\.json$/.test(name)) continue; // matches chain-*.done.json too
      try {
        const c = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (typeof c.created === 'string' && c.created.slice(0, 10) === todayISO) count++;
      } catch { /* unreadable or malformed — not countable, not fatal */ }
    }
  }
  return count;
}

// An absent cap must not disable the day budget: `n >= undefined` is false, so
// omitting it silently retired the one gate that rations dollars. Mirrors
// `capOr` in relay-chain-state.js:36 — null, 0 and a string fall back too.
const capOr = (cap) =>
  (Number.isInteger(cap) && cap >= 1 ? cap : rc.DEFAULT_CHAINS_PER_DAY);
const capRefusal = (spent, cap) => {
  const limit = capOr(cap);
  return (Number(spent) || 0) >= limit
    ? refusal('chains_per_day', `chains_per_day reached (${limit})`) : null;
};

// Ordering key for the predecessor scan: the chain's OWN `created`, never mtime.
// A candidate whose `created` parses always outranks one whose does not, so a
// single corrupt file cannot capture the slot in a repo that still has valid
// chains; mtime only breaks ties among the unparseable.
function chainSortKey(file) {
  try {
    const { created } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof created === 'string' && created) return { parsed: true, key: created };
  } catch { /* unreadable or malformed — ranked below every parseable chain */ }
  let ms = 0;
  try { ms = fs.statSync(file).mtimeMs; } catch { /* vanished mid-scan */ }
  return { parsed: false, key: new Date(ms).toISOString() };
}
const outranks = (a, b) => (a.parsed !== b.parsed ? a.parsed : a.key > b.key);

// The predecessor `/relay next` gates on: the newest chain across THIS repo's
// chain HOMES, active OR retired. Accepts one dir (back-compat) or the dir LIST
// every hook already uses — `relayDirs(cwd)` = [<repo>/.relay, legacy RELAY_DIR].
// Reading a single dir made a predecessor in the legacy home invisible, and an
// invisible predecessor reads as "first chain": the gate opened a second loop
// beside a live one. `readable: false` — the file exists but fails loadChain or
// validateChain — is a REFUSAL, not "no predecessor": collapsing it to null let
// the gate read "first chain" and OPEN over a corrupt predecessor.
function resolvePrevChain(homes) {
  const list = typeof homes === 'string' ? [homes] : (homes || []);
  let best = null;
  for (const home of new Set(list)) {
    if (!home || typeof home !== 'string') continue;
    let names;
    try { names = fs.readdirSync(home); } catch { continue; }
    for (const name of names) {
      if (!/^chain-.*\.json$/.test(name)) continue; // matches chain-*.done.json too
      const file = path.join(home, name);
      const cand = { file, ...chainSortKey(file) };
      if (!best || outranks(cand, best)) best = cand;
    }
  }
  if (!best) return { file: null, chain: null, retired: false, readable: true };
  const r = rc.loadChain(best.file);
  const ok = Boolean(r.ok) && rc.validateChain(r.chain).ok;
  return { file: best.file, chain: ok ? r.chain : null,
    retired: best.file.endsWith('.done.json'), readable: ok };
}

// One `rg -n '^- \[open\]' DOCs/found-issues.md` line → its parts. The location
// is NOT a single token in practice (`plugin:found-issues sync (tombstone)`),
// so the split is on the em-dash that the ledger format guarantees, not on
// whitespace. `[deferred]` / `[fixed]` lines return null and are never picked.
function parseFoundIssue(line, index) {
  const [head, ...rest] = String(line).split(' — ');
  const m = /^(?:(\d+):)?- \[open\](?: (\[!\]))?(?: (\d{4}-\d{2}-\d{2}))? (.*)$/.exec(head.trim());
  if (!m) return null;
  const symptom = rest.join(' — ').trim();
  return {
    // The `rg -n` prefix. The index fallback is only meaningful because the
    // skill always passes `rg -n` output (SKILL.md § next names the exact
    // command); a line without the prefix is hand-pasted, and its ordinal is
    // only ever a label — `lineNo` never reaches the acceptance command.
    lineNo: m[1] || String(index + 1),
    critical: Boolean(m[2]),
    // Truncated, never refused — and with NO ellipsis: the location becomes an
    // `rg` PREFIX pattern matched against the whole ledger line, so a trailing
    // `…` would be a literal that nothing can ever match.
    location: m[4].trim().slice(0, LOCATION_MAX).trimEnd(),
    symptom: symptom.length > SYMPTOM_MAX
      ? `${symptom.slice(0, SYMPTOM_MAX)}…`
      : (symptom || '(no symptom recorded)'),
  };
}

// `task` is the `/relay start` argument form; `id`/`desc`/`acceptance` are the
// same thing pre-split, so a caller hands the parts straight to `rc.addTask`
// instead of re-parsing the string. That matters more than it looks: the
// found-issues acceptance CONTAINS single quotes, so it can never be pasted
// into a `node -e '…'` block — the skill ships this object through the
// environment as JSON and parses it on the far side.
const pick = (source, label, parts) => ({ source, label, ...parts,
  task: `${parts.id}: ${parts.desc} | accept: ${parts.acceptance}` });

// `rg` reads its pattern as a REGEX, and a location is not always a plain path —
// `plugin:found-issues sync (tombstone)` is a real ledger entry. Interpolated
// raw, those parens become a capture group and the acceptance can never match:
// markVerified would never fire and the chain would burn to loop.cap instead of
// shipping. Escaped only in the PATTERN; desc and label keep the raw location.
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// …and the SHELL reads the same string as a single-quoted argument. A real
// ledger location carries an apostrophe — e.g. `the sync plugin's own
// PostToolUse pass` — which closes `rg -q '…'`
// early and spills the remainder into unquoted shell words. Same failure class
// as the regex one, one layer up: applied AFTER rx, because rx emits
// backslashes that a shell-escape run first would have to escape again.
const sq = (s) => s.replace(/'/g, "'\\''");

// An entry this repo cannot act on is not this chain's work. The real ledger
// carries upstream locations (`~/.claude/gsd-core/…`) that a chain here can
// neither fix nor close, so picking one burns a whole chain to loop.cap without
// a commit. ROOT-GATED on purpose: "outside" needs a repo to be outside OF, so a
// caller that passes no `root` keeps the pre-R3 behaviour — the escaping tests
// deliberately exercise a `~/` location and must stay able to.
function outsideRepo(location, root) {
  if (!root) return false;
  const p = String(location).split(/\s/)[0];
  if (p === '~' || p.startsWith('~/')) return true;
  if (!p.startsWith('/')) return false;             // relative = repo-relative
  const base = String(root).replace(/\/+$/, '');
  return p !== base && !p.startsWith(`${base}/`);
}

// An acceptance that ALREADY passes means the entry is closed and only the
// ledger line lags — a chain opened on it has nothing to do. `isDone` is the
// probe the skill supplies (it runs the emitted command; exit 0 ⇒ skip). A probe
// that THROWS is not evidence of doneness: treat it as not done and let the
// chain find out for itself, rather than stalling the loop on a broken rg.
function alreadyDone(isDone, candidate) {
  if (typeof isDone !== 'function') return false;
  try { return isDone(candidate) === true; } catch { return false; }
}

// The acceptance is "the ledger entry closed", not "a file changed": the
// found-issues sync flips [open] → [fixed] when the PR merges, so this command
// passes only once the fix actually shipped through the review rail.
function pickFoundIssue(items, { root, isDone } = {}) {
  const open = (Array.isArray(items) ? items : [])
    .map(parseFoundIssue).filter(Boolean)
    .filter((x) => !outsideRepo(x.location, root));
  // Criticals first, then plain opens — and now a QUEUE rather than one guess:
  // an entry that is already closed falls through to the next candidate instead
  // of refusing the whole run.
  for (const e of [...open.filter((x) => x.critical), ...open.filter((x) => !x.critical)]) {
    const candidate = pick('found-issues', `FI-${e.lineNo} ${e.location}`, {
      id: `FI-${e.lineNo}`,
      desc: `fix ${e.location} — ${e.symptom}`,
      acceptance: `rg -q '^\\- \\[fixed\\].*${sq(rx(e.location))}' ${FOUND_ISSUES_LEDGER}`,
    });
    if (!alreadyDone(isDone, candidate)) return candidate;
  }
  return refusal('source_empty', 'source empty');
}

// `/gsd-next` resolves the phase through
// `node ~/.claude/gsd-core/bin/gsd-tools.cjs smart-entry --json` →
// `signals.current_phase`, an integer with no name attached; the skill reads the
// name from the planning tree's ROADMAP.md and passes both in.
function pickGsdPhase(item) {
  const phase = item && item.phase;
  if (phase === undefined || phase === null || phase === '')
    return refusal('source_empty', 'source empty');
  const n = String(phase);
  return pick('gsd-next', `Phase ${n}${item.name ? `: ${item.name}` : ''}`, {
    id: `P${n}`,
    desc: `/gsd-execute-phase ${n}`,
    acceptance: `${PLANNING_DIR}/phases/${n}-*/VERIFICATION.md exists`,
  });
}

// The single task the next chain starts with, in `/relay start` argument form.
// `items` is whatever the source produced: rg lines for found-issues, a
// `{phase, name}` object for gsd-next.
// `opts` also carries the actionability filters `root` and `isDone` (R3), which
// only found-issues uses — a gsd-next phase is a repo-relative path by
// construction and its VERIFICATION.md acceptance is the phase, not a ledger line.
function pickNext(source, items, opts = {}) {
  if (!SOURCES.includes(source))
    throw new Error(`pickNext: unknown source '${source}' (expected ${SOURCES.join(' | ')})`);
  const over = capRefusal(opts.chainsToday ?? 0, opts.cap);
  if (over) return over;
  return source === 'found-issues' ? pickFoundIssue(items, opts) : pickGsdPhase(items);
}

// The gates that run BEFORE a source is even read, in the order `/relay next`
// must report them. Returns null when the next chain may start.
//
// `prevChain` is the newest chain in this repo and `prevRetired` says whether it
// is a `.done.json`. Both matter: a merged chain that was never retired still
// holds the baton and an instance file. And note the asymmetry that is NOT a
// bug — `ended.reason === 'complete'` with `ship.merged === false` is the
// owned-repos-only path where T-ship stops at "PR opened"; a human merges that
// PR, and only then does the loop get to continue.
function nextRefusal({ nextEnabled, prevChain = null, prevRetired = false,
  prevReadable = false, chainsToday: spent = 0, cap } = {}) {
  if (nextEnabled !== true) return refusal('next_enabled', 'next_enabled false');
  // A predecessor that exists but cannot be read is NOT "no predecessor" — fail
  // CLOSED. `resolvePrevChain` reports it as `readable: false`, and the DEFAULT
  // is the same refusal: a gate's default belongs closed, so a caller who omits
  // the field cannot be handed the one answer that starts a chain over a corrupt
  // predecessor. Every caller of record passes `prevReadable: prev.readable`.
  if (prevReadable !== true) return refusal('previous_chain', 'previous chain not ended');
  if (prevChain) {
    const merged = Boolean(prevChain.ship && prevChain.ship.merged === true);
    const stalled = Boolean(prevChain.ended && prevChain.ended.reason === 'review-stalled');
    if (!prevRetired || !(merged || stalled))
      return refusal('previous_chain', 'previous chain not ended');
  }
  return capRefusal(spent, cap);
}

module.exports = { SOURCES, FOUND_ISSUES_LEDGER, PLANNING_DIR, SYMPTOM_MAX,
  LOCATION_MAX, chainsToday, resolvePrevChain, pickNext, nextRefusal,
  parseFoundIssue };
