'use strict';
// relay-ship.test.js — the v2.1 review-pathway half of schema 2: the `ship`
// record every chain ends by filling in, and the `ended` stamp that says why the
// chain stopped. Lives apart from relay-chain-state.test.js only because that
// file is already at the 200-LOC ceiling.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const rc = require('../lib/relay-chain.js');

const NOW = '2026-08-27T00:00:00.000Z';
const ABSENT = path.join(os.tmpdir(), 'relay-config-absent.json');

// The machine's real relay.config.json must never decide an assertion.
const noConfig = (t) => {
  process.env.CLAUDE_RELAY_CONFIG = ABSENT;
  t.after(() => { delete process.env.CLAUDE_RELAY_CONFIG; });
};

const make = (over = {}) => rc.createChain({ chainId: 'c', repoRoot: '/r',
  spawnPolicy: 'shared', mode: 'autonomous', holderToken: 'tok-1',
  handoffDoc: '', now: NOW, ...over });

// ── seed ─────────────────────────────────────────────────────────────────────
test('createChain seeds an empty ship record and no ending', (t) => {
  noConfig(t);
  const c = make();
  assert.deepStrictEqual(c.ship,
    { branch: null, pr: null, review_rounds: 0, merged: false });
  assert.strictEqual(c.ended, null);
  assert.strictEqual(rc.validateChain(c).ok, true);
});

// ── setShip ──────────────────────────────────────────────────────────────────
test('setShip records branch, PR and merge one field at a time', (t) => {
  noConfig(t);
  const c = make();
  const branched = rc.setShip(c, { branch: 'relay/2026-08-27-example-app-1a2b' });
  assert.strictEqual(branched.ship.branch, 'relay/2026-08-27-example-app-1a2b');
  assert.strictEqual(branched.ship.pr, null);          // untouched keys survive
  const pr = rc.setShip(branched, { pr: 'example/repo#12' });
  assert.strictEqual(pr.ship.pr, 'example/repo#12');
  assert.strictEqual(pr.ship.branch, 'relay/2026-08-27-example-app-1a2b');
  const merged = rc.setShip(pr, { merged: true });
  assert.strictEqual(merged.ship.merged, true);
  assert.strictEqual(rc.setShip(merged, { review_rounds: 2 }).ship.review_rounds, 2);
  assert.strictEqual(c.ship.branch, null);             // input untouched
  assert.strictEqual(branched.ship.pr, null);
  assert.strictEqual(rc.validateChain(merged).ok, true);
});

// A T11-era chain on disk has no `ship` key at all. Writing only the field the
// caller passed would leave a PARTIAL ship record — the exact shape the tolerant
// validation arm below rejects — so the default must be seeded underneath.
test('setShip seeds the whole record on a chain written before T13', (t) => {
  noConfig(t);
  const c = make();
  delete c.ship;
  const s = rc.setShip(c, { branch: 'relay/x' });
  assert.deepStrictEqual(s.ship,
    { branch: 'relay/x', pr: null, review_rounds: 0, merged: false });
  assert.strictEqual(rc.validateChain(s).ok, true);
});

// ── bumpReviewRound ──────────────────────────────────────────────────────────
// `setShip` takes an ABSOLUTE round count, so the "max 2 rounds" cap was
// unenforceable across a handoff: a successor generation could not tell whether
// round 1 or round 2 had already been spent, and `status` / the dashboard
// rendered a permanent 0. The writer the ship pathway's step 3 calls.
test('bumpReviewRound counts the rounds the cap is enforced against', (t) => {
  noConfig(t);
  const c = make();
  const one = rc.bumpReviewRound(c);
  assert.strictEqual(one.ship.review_rounds, 1);
  assert.strictEqual(rc.bumpReviewRound(one).ship.review_rounds, 2);
  assert.strictEqual(c.ship.review_rounds, 0);           // input untouched
  assert.strictEqual(one.ship.review_rounds, 1);         // and the intermediate
  assert.strictEqual(rc.validateChain(rc.bumpReviewRound(one)).ok, true);
});

test('bumpReviewRound seeds a pre-T13 or corrupt count instead of poisoning it', (t) => {
  noConfig(t);
  const c = make();
  delete c.ship;
  assert.deepStrictEqual(rc.bumpReviewRound(c).ship,
    { branch: null, pr: null, review_rounds: 1, merged: false });
  const bad = rc.setShip(make(), { branch: 'relay/x' });
  bad.ship.review_rounds = 'two';   // a string would make `+ 1` write 'two1'
  const fixed = rc.bumpReviewRound(bad);
  assert.strictEqual(fixed.ship.review_rounds, 1);
  assert.strictEqual(fixed.ship.branch, 'relay/x');
  assert.strictEqual(rc.validateChain(fixed).ok, true);
});

// ── markEnded ────────────────────────────────────────────────────────────────
test('markEnded stamps the reason and the time', (t) => {
  noConfig(t);
  const c = make();
  for (const reason of ['complete', 'cap', 'review-stalled']) {
    const e = rc.markEnded(c, { reason, now: NOW });
    assert.deepStrictEqual(e.ended, { reason, at: NOW });
    assert.strictEqual(c.ended, null);                 // input untouched
    assert.strictEqual(rc.validateChain(e).ok, true);
  }
  assert.ok(rc.markEnded(c, { reason: 'complete' }).ended.at, 'defaults `at` to now');
});

test('markEnded refuses a reason outside the three the pathway defines', (t) => {
  noConfig(t);
  const c = make();
  assert.throws(() => rc.markEnded(c, { reason: 'abandoned', now: NOW }),
    /abandoned/, 'an unknown reason must throw, never land on disk');
  assert.throws(() => rc.markEnded(c, { now: NOW }), /reason/);
});

test('markEnded works on a chain written before T13', (t) => {
  noConfig(t);
  const c = make();
  delete c.ended;
  const e = rc.markEnded(c, { reason: 'cap', now: NOW });
  assert.deepStrictEqual(e.ended, { reason: 'cap', at: NOW });
  assert.strictEqual(rc.validateChain(e).ok, true);
});

// ── validateChain ────────────────────────────────────────────────────────────
// Schema 2 stays additive WITHIN itself: the T11 chains already on disk carry no
// ship/ended, and making them required would fail validateChain — which is what
// the baton guard and the loop driver both gate on. A live chain must not go
// dark because a later task added a field.
test('a schema-2 chain written before T13 still validates', (t) => {
  noConfig(t);
  const c = make();
  delete c.ship; delete c.ended;
  assert.strictEqual(rc.validateChain(c).ok, true);
});

test('a malformed ship or ended is rejected once present', (t) => {
  noConfig(t);
  const bad = (mut) => { const c = make(); mut(c); return rc.validateChain(c); };
  assert.strictEqual(bad((c) => { c.ship = 'relay/x'; }).ok, false);
  assert.match(bad((c) => { c.ship = { branch: 'b' }; }).error, /ship/);
  assert.match(bad((c) => { c.ship.merged = 'yes'; }).error, /ship\.merged/);
  assert.match(bad((c) => { c.ended = { reason: 'nope', at: NOW }; }).error, /ended\.reason/);
  assert.match(bad((c) => { c.ended = 'done'; }).error, /ended/);
  assert.strictEqual(bad((c) => { c.ended = { reason: 'cap', at: NOW }; }).ok, true);
});

test('the ship helpers leave a schema-1 chain valid', (t) => {
  noConfig(t);
  const c = make();
  for (const k of ['schema', 'model', 'paused', 'waiting', 'loop', 'decisions',
    'ship', 'ended']) delete c[k];
  assert.strictEqual(rc.validateChain(rc.setShip(c, { pr: 'o/r#1' })).ok, true);
  assert.strictEqual(rc.validateChain(rc.markEnded(c, { reason: 'complete', now: NOW })).ok,
    true);
});
