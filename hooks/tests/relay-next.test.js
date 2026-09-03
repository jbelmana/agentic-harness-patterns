'use strict';
// relay-next.test.js — the backlog picker behind `/relay next`: how many chains
// today's budget has already spent, which backlog item the next chain gets, and
// the four refusals that must be PRINTED rather than silently no-op'd.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');
// Set BEFORE the require: relay-next.js reads CLAUDE_RELAY_PLANNING_DIR once,
// at module load. A distinctive value lets the phase assertions below pin a
// LITERAL — asserting against rn.PLANNING_DIR would pass for any value the
// module happened to hold, including a wrong one, and would not notice the
// env var being ignored altogether.
process.env.CLAUDE_RELAY_PLANNING_DIR = 'plans-x';
const rn = require('../lib/relay-next.js');

const TODAY = '2026-08-27';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relaynext-'));
const chain = (dir, name, created) =>
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ chain_id: name, created }));
// `rg -q '^\- \[fixed\]…'` — the found-issues sync flips [open]→[fixed] on merge,
// so the acceptance command is "the entry closed", not "the file changed".
// Takes the PATTERN, not the location: the regex escaping is asserted literally
// at each call site rather than mirrored from the implementation.
const ACCEPT = (pat) => `accept: rg -q '^\\- \\[fixed\\].*${pat}' DOCs/found-issues.md`;

// ── chainsToday ──────────────────────────────────────────────────────────────
// Deliberately the INVERSE of resolveNewestChain's filter (relay-chain.js:118,
// which skips .done.json): a retired chain still spent today's budget.
test('chainsToday counts active AND retired chains created today', () => {
  const d = tmp();
  chain(d, 'chain-a.json', `${TODAY}T01:00:00.000Z`);
  chain(d, 'chain-b.done.json', `${TODAY}T02:00:00.000Z`);
  chain(d, 'chain-c.done.json', '2026-08-26T23:59:00.000Z');
  chain(d, 'chain-d.json', '2026-08-28T00:00:01.000Z');
  assert.strictEqual(rn.chainsToday([d], TODAY), 2);
  assert.strictEqual(rn.chainsToday([d], '2026-08-26'), 1);
});

test('chainsToday sums across dirs, dedupes them, and ignores non-chain files', () => {
  const a = tmp(); const b = tmp();
  chain(a, 'chain-1.json', `${TODAY}T01:00:00.000Z`);
  chain(b, 'chain-2.json', `${TODAY}T01:00:00.000Z`);
  fs.writeFileSync(path.join(a, 'instance-1.json'), JSON.stringify({ created: TODAY }));
  fs.writeFileSync(path.join(a, 'dash-x.html'), '<p>');
  assert.strictEqual(rn.chainsToday([a, b, a], TODAY), 2);
  assert.strictEqual(rn.chainsToday(a, TODAY), 1);          // single dir accepted
});

test('chainsToday never throws on an unreadable dir or a corrupt chain', () => {
  const d = tmp();
  chain(d, 'chain-ok.json', `${TODAY}T01:00:00.000Z`);
  fs.writeFileSync(path.join(d, 'chain-bad.json'), 'not json');
  fs.writeFileSync(path.join(d, 'chain-nodate.json'), JSON.stringify({ chain_id: 'x' }));
  assert.strictEqual(rn.chainsToday([d, path.join(d, 'nope'), null], TODAY), 1);
  assert.strictEqual(rn.chainsToday([], TODAY), 0);
});

// ── pickNext: found-issues ───────────────────────────────────────────────────
const CRIT = '135:- [open] [!] 2026-08-06 hooks/foo.cjs:216 — append races and loses writes';
const PLAIN = '8:- [open] 2026-08-26 DOCs/found-issues.md — the symlink is clobbered';
const BUDGET = { chainsToday: 2, cap: 3 };

test('pickNext prefers the first critical open found-issue', () => {
  const r = rn.pickNext('found-issues', [PLAIN, CRIT], BUDGET);
  assert.strictEqual(r.refused, undefined);
  assert.strictEqual(r.task, 'FI-135: fix hooks/foo.cjs:216 — append races and loses writes'
    + ` | ${ACCEPT('hooks/foo\\.cjs:216')}`);
  assert.strictEqual(r.source, 'found-issues');
  assert.match(r.label, /FI-135/);
});

test('pickNext falls back to the first plain open entry', () => {
  const r = rn.pickNext('found-issues', [PLAIN, '9:- [open] 2026-08-26 b.js:2 — second'],
    BUDGET);
  assert.strictEqual(r.task, 'FI-8: fix DOCs/found-issues.md — the symlink is clobbered'
    + ` | ${ACCEPT('DOCs/found-issues\\.md')}`);
});

test('pickNext never picks a deferred or fixed entry', () => {
  const r = rn.pickNext('found-issues', [
    '3:- [deferred] 2026-08-01 a.js:1 — deferred thing',
    '4:- [fixed] 2026-08-02 b.js:2 — fixed thing',
    PLAIN], BUDGET);
  assert.match(r.task, /^FI-8:/);
  assert.strictEqual(rn.pickNext('found-issues',
    ['3:- [deferred] 2026-08-01 a.js:1 — x'], BUDGET).refused, 'source_empty');
});

test('pickNext handles an entry whose location carries no :line', () => {
  const r = rn.pickNext('found-issues',
    ['11:- [open] 2026-06-10 plugin:found-issues sync (tombstone) — false positives'],
    BUDGET);
  assert.strictEqual(r.task, 'FI-11: fix plugin:found-issues sync (tombstone) — '
    + `false positives | ${ACCEPT('plugin:found-issues sync \\(tombstone\\)')}`);
});

test('pickNext truncates a long symptom to 100 chars', () => {
  const long = 'x'.repeat(240);
  const r = rn.pickNext('found-issues', [`5:- [open] 2026-08-26 a.js:1 — ${long}`], BUDGET);
  assert.ok(r.task.includes(`— ${'x'.repeat(100)}… |`), r.task.slice(0, 140));
  assert.ok(!r.task.includes('x'.repeat(101)));
});

test('pickNext tolerates a line with no rg -n prefix and no symptom', () => {
  const r = rn.pickNext('found-issues', ['- [open] 2026-08-26 a.js:1'], BUDGET);
  assert.strictEqual(r.task,
    `FI-1: fix a.js:1 — (no symptom recorded) | ${ACCEPT('a\\.js:1')}`);
});

// ── pickNext: gsd-next ───────────────────────────────────────────────────────
test('pickNext turns the next GSD phase into one execute task', () => {
  const r = rn.pickNext('gsd-next', { phase: '12', name: 'Storage Layer' }, BUDGET);
  assert.strictEqual(r.task, 'P12: /gsd-execute-phase 12 | accept: '
    + 'plans-x/phases/12-*/VERIFICATION.md exists');
  assert.strictEqual(r.label, 'Phase 12: Storage Layer');
  assert.strictEqual(rn.pickNext('gsd-next', { phase: 12 }, BUDGET).task,
    r.task, 'an integer phase from smart-entry --json reads the same');
});

test('pickNext refuses an empty source', () => {
  for (const items of [[], null, undefined]) {
    const r = rn.pickNext('found-issues', items, BUDGET);
    assert.strictEqual(r.refused, 'source_empty');
    assert.strictEqual(r.message, 'source empty');
  }
  assert.strictEqual(rn.pickNext('gsd-next', { name: 'no phase' }, BUDGET).refused,
    'source_empty');
});

test('pickNext refuses once the day budget is spent', () => {
  const r = rn.pickNext('found-issues', [CRIT], { chainsToday: 3, cap: 3 });
  assert.strictEqual(r.refused, 'chains_per_day');
  assert.strictEqual(r.message, 'chains_per_day reached (3)');
  // The number in the message is the CAP, not the count — a run that somehow
  // overshot still names the limit it broke.
  assert.strictEqual(rn.pickNext('found-issues', [CRIT], { chainsToday: 4, cap: 3 }).message,
    'chains_per_day reached (3)');
});

test('pickNext throws on a source the repo config misspelled', () => {
  assert.throws(() => rn.pickNext('gsd_next', [], BUDGET), /unknown source/);
});

// The acceptance command carries single quotes, so it can never be pasted into
// a `node -e '…'` block. The pre-split parts go through the environment as JSON
// and straight into rc.addTask — no shell quoting anywhere on that path.
test('a pick carries the pre-split addTask parts as well as the task string', () => {
  const fi = rn.pickNext('found-issues', [CRIT], BUDGET);
  assert.strictEqual(fi.id, 'FI-135');
  assert.strictEqual(fi.desc, 'fix hooks/foo.cjs:216 — append races and loses writes');
  assert.strictEqual(fi.acceptance,
    "rg -q '^\\- \\[fixed\\].*hooks/foo\\.cjs:216' DOCs/found-issues.md");
  assert.strictEqual(`${fi.id}: ${fi.desc} | accept: ${fi.acceptance}`, fi.task);
  const p = rn.pickNext('gsd-next', { phase: 12, name: 'x' }, BUDGET);
  assert.deepStrictEqual([p.id, p.desc, p.acceptance],
    ['P12', '/gsd-execute-phase 12',
      'plans-x/phases/12-*/VERIFICATION.md exists']);
  assert.strictEqual(JSON.parse(JSON.stringify(p)).acceptance, p.acceptance);
});

// `rg` treats its pattern as a REGEX, and the SHELL treats the surrounding `'…'`
// as a string — a found-issues location must survive both. Two shapes break it:
// `plugin:example-sync run (tombstone)` (parens → a capture group), and an entry
// whose primary separator is ` -- `, so the ` — ` split lands a several-hundred-
// char body carrying an apostrophe in `location`. That apostrophe closes the
// single-quoted rg pattern and the remainder becomes shell words.
// Either way markVerified never fires and the chain burns to loop.cap instead of
// shipping. This runs the emitted command for real.
test('the emitted acceptance command actually matches the ledger line', () => {
  const d = tmp();
  const ledger = path.join(d, 'DOCs', 'found-issues.md');
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  const locations = ['plugin:example-sync run (tombstone)', 'hooks/foo.cjs:216',
    '~/.claude/toolkit/bin/lib/window-check.cjs:216',
    "scripts/drift-check.js:1 -- the sync plugin's own auto-pass",
    `DOCs/found-issues.md:9 -- ${'over-long '.repeat(24)}tail`];
  fs.writeFileSync(ledger, locations
    .map((l) => `- [fixed] 2026-08-27 ${l} — done`).join('\n') + '\n');
  for (const [i, loc] of locations.entries()) {
    const r = rn.pickNext('found-issues',
      [`${i + 1}:- [open] 2026-08-27 ${loc} — a symptom`], BUDGET);
    const cmd = r.acceptance;
    assert.strictEqual(execSync(`${cmd}; echo $?`, { cwd: d, encoding: 'utf8' }).trim(),
      '0', `acceptance did not match its own ledger entry: ${cmd}`);
  }
});

// An over-long location is TRUNCATED, never refused — and truncated with no
// ellipsis, because the pattern is matched as a prefix against the whole ledger
// line; a trailing `…` would be a literal nothing can match.
test('a run-on location is capped at LOCATION_MAX and stays a matching prefix', () => {
  const long = `a/path.js:1 -- ${'x'.repeat(400)}`;
  const r = rn.pickNext('found-issues', [`7:- [open] 2026-08-27 ${long} — sym`], BUDGET);
  assert.strictEqual(rn.LOCATION_MAX, 120);
  assert.strictEqual(rn.parseFoundIssue(`- [open] 2026-08-27 ${long}`, 0).location.length,
    rn.LOCATION_MAX);
  assert.ok(!r.acceptance.includes('…'), r.acceptance);
  assert.ok(long.startsWith(r.desc.replace(/^fix /, '').replace(/ — sym$/, '')));
});

// ── nextRefusal ──────────────────────────────────────────────────────────────
const MERGED = { ship: { merged: true }, ended: { reason: 'complete' } };
const STALLED = { ship: { merged: false }, ended: { reason: 'review-stalled' } };
// `prevReadable` is spelled out because D13 flipped its default CLOSED — a gate
// default belongs closed, so every caller states what it actually read.
const GATE = { nextEnabled: true, prevRetired: true, prevReadable: true,
  chainsToday: 0, cap: 3 };

test('nextRefusal lets the next chain start after a merged or stalled predecessor', () => {
  assert.strictEqual(rn.nextRefusal({ ...GATE, prevChain: MERGED }), null);
  assert.strictEqual(rn.nextRefusal({ ...GATE, prevChain: STALLED }), null);
  assert.strictEqual(rn.nextRefusal({ ...GATE, prevChain: null }), null);
});

test('nextRefusal blocks on a disabled repo, a live predecessor, or the day cap', () => {
  assert.strictEqual(rn.nextRefusal({ ...GATE, nextEnabled: false }).message,
    'next_enabled false');
  assert.strictEqual(rn.nextRefusal({ ...GATE, prevChain: MERGED, prevRetired: false })
    .message, 'previous chain not ended');
  assert.strictEqual(rn.nextRefusal({ ...GATE, prevChain: { ship: {}, ended: null } })
    .message, 'previous chain not ended');
  assert.strictEqual(rn.nextRefusal({ ...GATE, prevChain: MERGED, chainsToday: 3 }).message,
    'chains_per_day reached (3)');
});

// Not a bug: `complete` with merged:false is the owned-repos-only path, where
// T-ship stops at "PR opened". A human merges it, and only then does `next` run.
test('nextRefusal holds when a complete chain stopped at PR-opened', () => {
  const openPr = { ship: { pr: 'o/r#9', merged: false }, ended: { reason: 'complete' } };
  assert.strictEqual(rn.nextRefusal({ ...GATE, prevChain: openPr }).refused,
    'previous_chain');
});
