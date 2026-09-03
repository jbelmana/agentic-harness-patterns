'use strict';
// relay-loop.test.js — the PURE loop decision, one test per decision-table row,
// in the table's order (first match wins). Spec: the relay v2 design note,
// §"Loop driver".
// The hook shell that feeds this function lives in relay-loop-driver.test.js.
const test = require('node:test');
const assert = require('node:assert');
const { decideLoop } = require('../lib/relay-loop.js');
const { validateChain } = require('../lib/relay-chain.js');

const NOW = '2026-08-27T00:00:00.000Z';
const task = (id, state = 'open') => ({ id, desc: `do ${id}`, acceptance: 'x', state, gen: 1 });

// A schema-2 chain held by tok-1 at generation 1 with two open tasks: the state
// that MUST block, so every allow row below is proven by its own condition.
const chain = (over = {}) => ({
  chain_id: 'c', created: NOW, repo_root: '/r', spawn_policy: 'shared',
  mode: 'autonomous', artifact_url: '', schema: 2, model: 'claude-opus-5',
  paused: false, waiting: null, decisions: [],
  loop: { cap: 30, iterations: {}, relayNudges: 0 },
  generation: { current: 1, cap: 3 },
  baton: { holder_token: 'tok-1', state: 'held', offered_at: null, claimed_at: NOW },
  handoff_doc: '', tasks: [task('T1'), task('T2')], history: [], alerts: [], ...over,
});
const ctx = (over = {}) => ({ token: 'tok-1', displayedPct: 10, gen: 1, now: NOW, ...over });

// Every EARLY allow row is fed the state that rows 7 and 8 would otherwise
// claim: a meter past the nudge threshold AND an iteration count already at the
// cap. Without it a row that stopped matching would fall through to row 7 or 8,
// still allow, and the test would still pass — the fixture, not the code, would
// be doing the proving. `ARMED` is the chain half, `LOADED` the ctx half.
const ARMED = { loop: { cap: 30, iterations: { 1: 30 }, relayNudges: 0 } };
const LOADED = { displayedPct: 90 };

// ── row 1: no chain / holder is not this session ─────────────────────────────
test('row 1: no chain -> allow not-holder', () => {
  assert.deepStrictEqual(decideLoop(null, ctx(LOADED)), { allow: true, reason: 'not-holder' });
});

test('row 1: another session holds the baton -> allow not-holder', () => {
  const c = chain({ ...ARMED,
    baton: { holder_token: 'tok-9', state: 'held', offered_at: null, claimed_at: NOW } });
  assert.strictEqual(decideLoop(c, ctx(LOADED)).reason, 'not-holder');
});

// ── row 2: mode ──────────────────────────────────────────────────────────────
test('row 2: interactive mode -> allow interactive', () => {
  const r = decideLoop(chain({ mode: 'interactive', ...ARMED }), ctx(LOADED));
  assert.deepStrictEqual(r, { allow: true, reason: 'interactive' });
});

// ── row 3: the kill switch ───────────────────────────────────────────────────
test('row 3: paused -> allow paused (beats every later row)', () => {
  const r = decideLoop(chain({ paused: true, ...ARMED }), ctx(LOADED));
  assert.deepStrictEqual(r, { allow: true, reason: 'paused' });
});

// ── row 4: a declared stop class ─────────────────────────────────────────────
test('row 4: waiting -> allow waiting:<class>', () => {
  const w = { class: 'spend', question: 'enable the paid key?', since: NOW };
  assert.strictEqual(decideLoop(chain({ waiting: w, ...ARMED }), ctx(LOADED)).reason,
    'waiting:spend');
});

// ── row 5: the baton is no longer this session's loop to drive ───────────────
test('row 5: baton offered -> allow baton-offered', () => {
  const c = chain({ ...ARMED,
    baton: { holder_token: 'tok-1', state: 'offered', offered_at: NOW, claimed_at: NOW } });
  assert.strictEqual(decideLoop(c, ctx(LOADED)).reason, 'baton-offered');
});

// Defence in depth: the driver resolves a chain only when holder_token === token,
// so it cannot hand decideLoop a released token. A caller that does anyway must
// still get an allow, and a truer reason than "not-holder".
test('row 5: token in history -> allow baton-released', () => {
  const c = chain({ ...ARMED, history: [{ gen: 0, token: 'tok-1', released: NOW }] });
  assert.strictEqual(decideLoop(c, ctx(LOADED)).reason, 'baton-released');
});

// ── row 6: the ledger is done ────────────────────────────────────────────────
test('row 6: zero open tasks -> allow complete', () => {
  const c = chain({ tasks: [task('T1', 'verified'), task('T2', 'verified')] });
  assert.deepStrictEqual(decideLoop(c, ctx()), { allow: true, reason: 'complete' });
});

// Row 6 outranks row 7: a finished ledger is finished whatever the meter reads.
// A chain with nothing left open must never spend a relay nudge telling a session
// to hand on work that does not exist.
test('row 6 beats row 7: all verified at 45% displayed -> complete, no nudge', () => {
  const c = chain({ tasks: [task('T1', 'verified'), task('T2', 'verified')] });
  assert.deepStrictEqual(decideLoop(c, ctx({ displayedPct: 45 })),
    { allow: true, reason: 'complete' });
});

// ── row 7: the context nudge, and its cap ────────────────────────────────────
// The reason says OFFER the held chain, not "run chain-create" flat. Row 7 fires
// on a session that already HOLDS a chain, and `chain-create` unqualified reads
// as "make a second one" — which orphans the held chain `held` forever, losing
// its ship.branch, decisions and review_rounds, and hands the successor a ledger
// with no T-ship. SKILL.md § chain-create step 0 is the other half of this fix:
// reuse the held chain rather than minting a new id.
test('row 7: displayed >= 40 -> BLOCK telling the session to OFFER the held chain', () => {
  const r = decideLoop(chain(), ctx({ displayedPct: 41 }));
  assert.strictEqual(r.allow, false);
  assert.match(r.reason, /RELAY: offer the held chain via \/relay chain-create now/);
  assert.doesNotMatch(r.reason, /RELAY: run \/relay chain-create/,
    'the bare "run chain-create" wording is what created a second chain');
  assert.strictEqual(r.next.loop.relayNudges, 1);
  assert.strictEqual(r.next.loop.iterations['1'], undefined); // a nudge is not an iteration
});

test('row 7: relayNudges at the cap -> allow relay-nudge-cap plus an alert', () => {
  const c = chain({ loop: { cap: 30, iterations: {}, relayNudges: 3 } });
  const r = decideLoop(c, ctx({ displayedPct: 41 }));
  assert.strictEqual(r.allow, true);
  assert.strictEqual(r.reason, 'relay-nudge-cap');
  assert.strictEqual(r.next.alerts.length, 1);
  assert.deepStrictEqual(Object.keys(r.next.alerts[0]).sort(), ['at', 'msg']);
  assert.match(r.next.alerts[0].msg, /relay nudge cap reached/);
  assert.strictEqual(r.next.alerts[0].at, NOW);
});

// ── row 8: the loop cap ──────────────────────────────────────────────────────
test('row 8: iterations at cap -> allow loop-cap with the "N open" alert', () => {
  const c = chain({ loop: { cap: 30, iterations: { 1: 30 }, relayNudges: 0 } });
  const r = decideLoop(c, ctx());
  assert.strictEqual(r.allow, true);
  assert.strictEqual(r.reason, 'loop-cap');
  assert.strictEqual(r.next.alerts[0].msg, 'loop cap reached, 2 open');
});

// The chain records its own cap at creation, exactly like generation.cap — so a
// chain capped at 5 ends at 5 even when the operator config says 30.
test('row 8: chain.loop.cap wins over opts.cap', () => {
  const c = chain({ loop: { cap: 5, iterations: { 1: 5 }, relayNudges: 0 } });
  assert.strictEqual(decideLoop(c, ctx(), { cap: 30 }).reason, 'loop-cap');
});

test('row 8: no chain.loop.cap -> opts.cap gates, and the reason prints the same cap', () => {
  const c = chain({ loop: { iterations: { 1: 5 }, relayNudges: 0 } });
  assert.strictEqual(decideLoop(c, ctx(), { cap: 5 }).reason, 'loop-cap');
  const under = chain({ loop: { iterations: { 1: 1 }, relayNudges: 0 } });
  assert.match(decideLoop(under, ctx(), { cap: 5 }).reason, /Iteration 2\/5\./);
});

// ── the cap alerts are one-shot ──────────────────────────────────────────────
// Rows 7-at-cap and 8 are precisely the states where the loop has ALREADY stopped
// driving, and the appended alert is the only tell. Neither row changes the
// condition that produced it, so an un-gated push buries that tell under copies
// of itself on every later turn-end (`/relay status` prints every alert).
// A `next` is returned ONLY when there is something new to persist.
test('row 8: the cap alert is one-shot — a second decision has nothing to persist', () => {
  const c = chain({ loop: { cap: 30, iterations: { 1: 30 }, relayNudges: 0 } });
  const first = decideLoop(c, ctx());
  assert.strictEqual(first.next.alerts.length, 1);
  const second = decideLoop(first.next, ctx());
  assert.strictEqual(second.reason, 'loop-cap');
  assert.strictEqual(second.next, undefined);
});

// The nudge alert embeds the live meter reading, so de-duplicating on the message
// text would leak a fresh copy every time the percentage drifted. The flag does not.
test('row 7: the nudge-cap alert is one-shot too, across a drifting meter', () => {
  const c = chain({ loop: { cap: 30, iterations: {}, relayNudges: 3 } });
  const first = decideLoop(c, ctx({ displayedPct: 41 }));
  assert.strictEqual(first.next.alerts.length, 1);
  const second = decideLoop(first.next, ctx({ displayedPct: 44 }));
  assert.strictEqual(second.reason, 'relay-nudge-cap');
  assert.strictEqual(second.next, undefined);
});

// ── row 9: the loop itself ───────────────────────────────────────────────────
test('row 9: otherwise -> BLOCK with the loop directive and an incremented counter', () => {
  const r = decideLoop(chain(), ctx());
  assert.strictEqual(r.allow, false);
  assert.match(r.reason, /LOOP: chain c gen 1 — 2 open \(T1, T2\)/);
  assert.strictEqual(r.reason, 'LOOP: chain c gen 1 — 2 open (T1, T2). Next: pick one, '
    + 'do it, run its acceptance, mark done→verified via /relay. Iteration 1/30. '
    + '/relay pause to stop.');
  assert.strictEqual(r.next.loop.iterations['1'], 1);
});

// T-ship is the terminal ship task; it reads last in the directive however it sits
// in the array, so the model never picks "ship" before the work it ships.
test('row 9: T-ship is listed last among the open ids', () => {
  const c = chain({ tasks: [task('T1'), task('T-ship'), task('T2')] });
  assert.match(decideLoop(c, ctx()).reason, /3 open \(T1, T2, T-ship\)/);
});

// ── row 10: an unreadable context meter must not fake a relay nudge ──────────
test('row 10: displayedPct null falls through to row 9, never row 7', () => {
  const r = decideLoop(chain(), ctx({ displayedPct: null }));
  assert.strictEqual(r.allow, false);
  assert.match(r.reason, /^LOOP: chain c/);
  assert.strictEqual(r.next.loop.relayNudges, 0);
});

// ── invariants ───────────────────────────────────────────────────────────────
test('decideLoop never mutates its input', () => {
  const c = chain();
  const before = JSON.stringify(c);
  decideLoop(c, ctx({ displayedPct: 41 }));
  decideLoop(c, ctx());
  decideLoop(chain({ loop: { cap: 1, iterations: { 1: 1 }, relayNudges: 0 } }), ctx());
  assert.strictEqual(JSON.stringify(c), before);
});

// A schema-1 chain predates every loop field. It must loop anyway — seeding the
// counters on the first write — and must NOT be promoted to schema 2, which would
// claim keys (model, waiting, decisions) the file does not have.
test('schema-1 chain: loop fields are seeded on the first block, schema untouched', () => {
  const c = chain();
  delete c.schema; delete c.model; delete c.paused; delete c.waiting;
  delete c.loop; delete c.decisions;
  const r = decideLoop(c, ctx(), { cap: 30 });
  assert.strictEqual(r.allow, false);
  assert.deepStrictEqual(r.next.loop, { cap: 30, iterations: { 1: 1 }, relayNudges: 0 });
  assert.strictEqual('schema' in r.next, false);
});

// The baton guard SKIPS any chain that fails validateChain — so a `next` the
// driver writes that does not validate would silently un-block a released
// predecessor. Every chain this function emits must stay valid.
test('the emitted next chain still passes validateChain (schema 1 and schema 2)', () => {
  assert.strictEqual(validateChain(decideLoop(chain(), ctx()).next).ok, true);
  const one = chain();
  delete one.schema; delete one.model; delete one.paused; delete one.waiting;
  delete one.loop; delete one.decisions;
  assert.strictEqual(validateChain(decideLoop(one, ctx()).next).ok, true);
});

// A chain with no alerts array (hand-written, or an older writer) must not throw.
test('missing alerts/history/tasks arrays do not throw', () => {
  const c = chain({ loop: { cap: 1, iterations: { 1: 1 }, relayNudges: 0 } });
  delete c.alerts; delete c.history;
  const r = decideLoop(c, ctx());
  assert.strictEqual(r.reason, 'loop-cap');
  assert.strictEqual(r.next.alerts.length, 1);
  assert.strictEqual(decideLoop(chain({ tasks: undefined }), ctx()).reason, 'complete');
});
