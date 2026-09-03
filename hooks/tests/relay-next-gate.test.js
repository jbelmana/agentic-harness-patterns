'use strict';
// relay-next-gate.test.js — the `/relay next` gate INPUTS, which used to be
// hand-rolled in SKILL.md prose and therefore untested: which chain counts as
// the predecessor, what happens when that chain cannot be read, and the day-cap
// default. Lives apart from relay-next.test.js only because that file is near
// the 200-LOC ceiling.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const rc = require('../lib/relay-chain.js');
const rn = require('../lib/relay-next.js');

const ABSENT = path.join(os.tmpdir(), 'relay-config-absent.json');
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relaygate-'));
// The machine's real relay.config.json must never decide an assertion.
const noConfig = (t) => {
  process.env.CLAUDE_RELAY_CONFIG = ABSENT;
  t.after(() => { delete process.env.CLAUDE_RELAY_CONFIG; });
};

const chain = (created, over = {}) => ({
  ...rc.createChain({ chainId: 'c', repoRoot: '/r', spawnPolicy: 'shared',
    mode: 'autonomous', holderToken: 'tok', handoffDoc: '', now: created }),
  ...over,
});
const write = (dir, name, c) =>
  fs.writeFileSync(path.join(dir, name), JSON.stringify(c));
// nextRefusal fed exactly what resolvePrevChain returns — the skill block does
// the same, so a shape change here breaks the test rather than the loop.
const gateOn = (prev, over = {}) => rn.nextRefusal({ nextEnabled: true,
  prevChain: prev.chain, prevRetired: prev.retired, prevReadable: prev.readable,
  chainsToday: 0, cap: 3, ...over });

// ── resolvePrevChain ─────────────────────────────────────────────────────────
test('resolvePrevChain reports no predecessor for an empty or missing home', (t) => {
  noConfig(t);
  const d = home();
  assert.deepStrictEqual(rn.resolvePrevChain(d),
    { file: null, chain: null, retired: false, readable: true });
  assert.deepStrictEqual(rn.resolvePrevChain(path.join(d, 'nope')),
    { file: null, chain: null, retired: false, readable: true });
  assert.strictEqual(gateOn(rn.resolvePrevChain(d)), null, 'first chain may start');
});

// mtime is NOT the ordering key: a long-retired chain touched by any tool (a
// backup, an editor, a sync) would out-sort the chain that is actually live.
test('a recently touched older .done.json does not out-rank a newer active chain', (t) => {
  noConfig(t);
  const d = home();
  write(d, 'chain-old.done.json', chain('2026-08-20T01:00:00.000Z',
    { ship: { branch: null, pr: null, review_rounds: 1, merged: true },
      ended: { reason: 'complete', at: '2026-08-20T02:00:00.000Z' } }));
  write(d, 'chain-new.json', chain('2026-08-27T01:00:00.000Z'));
  const future = new Date(Date.now() + 60000);
  fs.utimesSync(path.join(d, 'chain-old.done.json'), future, future);
  const prev = rn.resolvePrevChain(d);
  assert.strictEqual(path.basename(prev.file), 'chain-new.json');
  assert.strictEqual(prev.retired, false);
  assert.strictEqual(gateOn(prev).message, 'previous chain not ended');
});

test('resolvePrevChain reads ship/ended off the newest chain, retired or not', (t) => {
  noConfig(t);
  const d = home();
  write(d, 'chain-a.json', chain('2026-08-25T01:00:00.000Z'));
  write(d, 'chain-b.done.json', chain('2026-08-27T01:00:00.000Z',
    { ship: { branch: 'relay/b', pr: 'o/r#3', review_rounds: 2, merged: true },
      ended: { reason: 'complete', at: '2026-08-27T02:00:00.000Z' } }));
  const prev = rn.resolvePrevChain(d);
  assert.strictEqual(path.basename(prev.file), 'chain-b.done.json');
  assert.strictEqual(prev.retired, true);
  assert.strictEqual(prev.readable, true);
  assert.strictEqual(prev.chain.ship.pr, 'o/r#3');
  assert.strictEqual(gateOn(prev), null);
});

// FAIL CLOSED. `prev && prev.ok ? prev.chain : null` collapsed an unreadable
// predecessor to "no predecessor", which nextRefusal read as "first chain" — the
// gate OPENED over a corrupt chain and started a second loop beside a live one.
test('an unreadable or invalid predecessor fails the gate CLOSED', (t) => {
  noConfig(t);
  for (const bad of ['not json at all', JSON.stringify({ chain_id: 'x' }),
    JSON.stringify(chain('2026-08-27T01:00:00.000Z', { mode: 'nonsense' }))]) {
    const d = home();
    fs.writeFileSync(path.join(d, 'chain-broken.json'), bad);
    const prev = rn.resolvePrevChain(d);
    assert.strictEqual(prev.readable, false, bad.slice(0, 40));
    assert.strictEqual(path.basename(prev.file), 'chain-broken.json');
    assert.strictEqual(prev.chain, null);
    const g = gateOn(prev);
    assert.strictEqual(g.refused, 'previous_chain');
    assert.strictEqual(g.message, 'previous chain not ended');
  }
});

// One stray corrupt file must not block a repo forever: a candidate whose
// `created` parses always outranks one whose does not, so fail-closed fires only
// when there is no readable chain to gate on at all.
test('a parseable chain outranks an unparseable one regardless of file order', (t) => {
  noConfig(t);
  const d = home();
  fs.writeFileSync(path.join(d, 'chain-zzz.json'), '{ broken');
  write(d, 'chain-aaa.done.json', chain('2026-08-27T01:00:00.000Z',
    { ship: { branch: null, pr: null, review_rounds: 0, merged: true },
      ended: { reason: 'complete', at: '2026-08-27T02:00:00.000Z' } }));
  const prev = rn.resolvePrevChain(d);
  assert.strictEqual(path.basename(prev.file), 'chain-aaa.done.json');
  assert.strictEqual(prev.readable, true);
  assert.strictEqual(gateOn(prev), null);
});

// M8: the hooks (guard, monitor, driver) all resolve chains from relayDirs(cwd)
// = [<repo>/.relay, legacy RELAY_DIR]. resolvePrevChain read ONE dir, so a
// predecessor living in the legacy home was invisible to the gate — which then
// read "no predecessor" and OPENED a second loop beside a live one.
test('resolvePrevChain accepts a dir LIST and ranks across all of them', (t) => {
  noConfig(t);
  const a = home(); const b = home();
  write(a, 'chain-a.json', chain('2026-08-25T01:00:00.000Z'));
  write(b, 'chain-b.done.json', chain('2026-08-27T01:00:00.000Z',
    { ship: { branch: null, pr: null, review_rounds: 0, merged: true },
      ended: { reason: 'complete', at: '2026-08-27T02:00:00.000Z' } }));
  const prev = rn.resolvePrevChain([a, b]);
  assert.strictEqual(path.basename(prev.file), 'chain-b.done.json');
  assert.strictEqual(prev.retired, true);
  assert.strictEqual(gateOn(prev), null);
  // The live chain in the OTHER dir now gates the run, where a single-dir scan
  // of `b` alone would have waved it through.
  const both = rn.resolvePrevChain([b, a]);
  assert.strictEqual(path.basename(both.file), 'chain-b.done.json');
  // Back-compat: a bare string is still one dir.
  assert.strictEqual(path.basename(rn.resolvePrevChain(a).file), 'chain-a.json');
  // A dir that does not exist, a dupe, and a non-string are skipped, not fatal.
  assert.strictEqual(path.basename(
    rn.resolvePrevChain([path.join(a, 'nope'), b, b, null]).file), 'chain-b.done.json');
});

// D13: a gate's default belongs CLOSED. `prevReadable = true` meant a caller who
// forgot the field got "the predecessor is fine" for free — the one answer that
// lets a second chain start over a corrupt one.
test('nextRefusal defaults prevReadable CLOSED', () => {
  assert.deepStrictEqual(rn.nextRefusal({ nextEnabled: true, chainsToday: 0, cap: 3 }),
    { refused: 'previous_chain', message: 'previous chain not ended' });
  assert.strictEqual(
    rn.nextRefusal({ nextEnabled: true, prevReadable: true, chainsToday: 0, cap: 3 }), null);
});

// ── R3: actionability ────────────────────────────────────────────────────────
// On the real ledger the first critical is an upstream `~/.claude/gsd-core/…`
// entry this repo can neither fix nor close, and the next is a "DO NOT WIRE"
// advisory whose acceptance already passes. Either one burns a whole chain to
// loop.cap without a commit.
const OUTSIDE = '1:- [open] [!] 2026-08-27 ~/.claude/gsd-core/bin/x.cjs:9 — upstream crash';
const ELSEWHERE = '2:- [open] [!] 2026-08-27 /Users/someone/other/a.js:1 — another repo';
const INSIDE = '3:- [open] 2026-08-27 hooks/foo.cjs:216 — in this repo';
const UNDER_ROOT = '4:- [open] [!] 2026-08-27 /repo/lib/b.js:2 — absolute but ours';
const R3 = { root: '/repo', chainsToday: 0, cap: 3 };

test('pickNext skips found-issues whose location is outside the repo', () => {
  assert.strictEqual(rn.pickNext('found-issues', [OUTSIDE, ELSEWHERE, INSIDE], R3).id, 'FI-3');
  // An absolute path UNDER the root is ours, and still outranks a plain entry.
  assert.strictEqual(
    rn.pickNext('found-issues', [OUTSIDE, INSIDE, UNDER_ROOT], R3).id, 'FI-4');
  // Nothing left in this repo is `source empty`, not a bogus pick.
  assert.strictEqual(rn.pickNext('found-issues', [OUTSIDE, ELSEWHERE], R3).refused,
    'source_empty');
  // ROOT-GATED: with no root there is no repo to be outside of, and the
  // pre-R3 ordering stands (relay-next.test.js proves escaping on a `~/` entry).
  assert.strictEqual(
    rn.pickNext('found-issues', [OUTSIDE, INSIDE], { chainsToday: 0, cap: 3 }).id, 'FI-1');
});

test('pickNext skips an entry whose acceptance already passes', () => {
  const seen = [];
  const isDone = (p) => { seen.push(p.id); return p.id === 'FI-4'; };
  const r = rn.pickNext('found-issues', [UNDER_ROOT, INSIDE], { ...R3, isDone });
  assert.strictEqual(r.id, 'FI-3');
  assert.deepStrictEqual(seen, ['FI-4', 'FI-3'], 'probed in priority order, criticals first');
  assert.strictEqual(seen.length, 2, 'the survivor is probed once, then picked');
  assert.strictEqual(
    rn.pickNext('found-issues', [UNDER_ROOT, INSIDE], { ...R3, isDone: () => true }).refused,
    'source_empty');
  // A probe that THROWS is not evidence of doneness — the loop must not stall on
  // a broken rg. The entry is picked, and the chain finds out for itself.
  assert.strictEqual(rn.pickNext('found-issues', [UNDER_ROOT],
    { ...R3, isDone: () => { throw new Error('rg exploded'); } }).id, 'FI-4');
});

// ── the day cap defaults instead of vanishing ────────────────────────────────
// `n >= undefined` is false, so an omitted (or null) cap used to disable the
// whole day budget silently — the one gate that rations dollars.
test('an omitted or null cap falls back to DEFAULT_CHAINS_PER_DAY, not to no limit', () => {
  const CRIT = '1:- [open] [!] 2026-08-06 a.js:1 — boom';
  for (const budget of [{ chainsToday: 3 }, { chainsToday: 3, cap: null },
    { chainsToday: 3, cap: 0 }, { chainsToday: 3, cap: 'three' }]) {
    const r = rn.pickNext('found-issues', [CRIT], budget);
    assert.strictEqual(r.refused, 'chains_per_day', JSON.stringify(budget));
    assert.strictEqual(r.message, 'chains_per_day reached (3)');
    // prevReadable is explicit since D13 flipped its default CLOSED — without it
    // the run refuses on `previous_chain` and never reaches the day budget.
    assert.strictEqual(
      rn.nextRefusal({ nextEnabled: true, prevReadable: true, ...budget }).refused,
      'chains_per_day', JSON.stringify(budget));
  }
  assert.strictEqual(rn.pickNext('found-issues', [CRIT], { chainsToday: 2 }).refused,
    undefined, 'under the default cap it still picks');
});
