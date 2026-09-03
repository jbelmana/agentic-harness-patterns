'use strict';
// relay-chain.test.js — the PURE half of relay-chain.js: chain shape, validation,
// and the baton/task transitions. Everything that touches disk lives in
// relay-chain-io.test.js; the directory helpers live in relay-dirs.test.js.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const rc = require('../lib/relay-chain.js');

test('createChain produces a valid chain with defaults', (t) => {
  // Pinned at an absent path so the default-cap assertion never depends on
  // whether this machine happens to carry ~/.claude/relay.config.json.
  process.env.CLAUDE_RELAY_CONFIG = path.join(os.tmpdir(), 'relay-config-absent.json');
  t.after(() => { delete process.env.CLAUDE_RELAY_CONFIG; });
  const c = rc.createChain({ chainId: '2026-08-26-test', repoRoot: '/r',
    spawnPolicy: 'shared', mode: 'interactive', holderToken: 'tok-0',
    handoffDoc: '', now: '2026-08-26T00:00:00Z' });
  assert.strictEqual(c.chain_id, '2026-08-26-test');
  assert.strictEqual(c.generation.current, 0);
  assert.strictEqual(c.generation.cap, 3);
  assert.deepStrictEqual(c.baton, { holder_token: 'tok-0', state: 'held',
    offered_at: null, claimed_at: '2026-08-26T00:00:00Z' });
  assert.deepStrictEqual(c.tasks, []);
  assert.strictEqual(rc.validateChain(c).ok, true);
});

test('validateChain rejects a bad baton state', () => {
  const c = rc.createChain({ chainId: 'x', repoRoot: '/r', spawnPolicy: 'shared',
    mode: 'autonomous', holderToken: 't', handoffDoc: '', now: 'now' });
  c.baton.state = 'zombie';
  const v = rc.validateChain(c);
  assert.strictEqual(v.ok, false);
  assert.match(v.error, /baton\.state/);
});

test('validateChain fails cleanly on null baton, non-array tasks, and null generation', () => {
  const base = rc.createChain({ chainId: 'z', repoRoot: '/r', spawnPolicy: 'shared',
    mode: 'autonomous', holderToken: 't', handoffDoc: '', now: 'now' });
  const nb = JSON.parse(JSON.stringify(base)); nb.baton = null;
  const v1 = rc.validateChain(nb);
  assert.strictEqual(v1.ok, false); assert.match(v1.error, /baton/);
  const nt = JSON.parse(JSON.stringify(base)); nt.tasks = 'nope';
  const v2 = rc.validateChain(nt);
  assert.strictEqual(v2.ok, false); assert.match(v2.error, /tasks/);
  // fix-1: generation:null is a released-session escape vector — validateChain
  // must reject the shape so the baton guard skips it instead of crashing on deref.
  const ng = JSON.parse(JSON.stringify(base)); ng.generation = null;
  const v3 = rc.validateChain(ng); assert.strictEqual(v3.ok, false); assert.match(v3.error, /generation/);
});

test('validateChain requires the alerts ledger key', () => {
  const c = rc.createChain({ chainId: 'y', repoRoot: '/r', spawnPolicy: 'shared',
    mode: 'autonomous', holderToken: 't', handoffDoc: '', now: 'now' });
  delete c.alerts;
  const v = rc.validateChain(c);
  assert.strictEqual(v.ok, false);
  assert.match(v.error, /alerts/);
});

test('RELAY_DIR and chainPath honour the on-disk contract', () => {
  assert.strictEqual(rc.RELAY_DIR.endsWith(path.join('.claude', 'relay')), true);
  assert.strictEqual(rc.chainPath('x'), path.join(rc.RELAY_DIR, 'chain-x.json'));
  // Explicit dir is the chain-home path T11-T14 use: chainPath(id, relayDir(root)).
  assert.strictEqual(rc.chainPath('x', '/r/.relay'), path.join('/r', '.relay', 'chain-x.json'));
});

test('offer -> claim moves old holder to history and bumps generation', () => {
  let c = rc.createChain({ chainId: 'c', repoRoot: '/r', spawnPolicy: 'shared',
    mode: 'autonomous', holderToken: 'tok-0', handoffDoc: '', now: 't0' });
  c = rc.offerBaton(c, { now: 't1' });
  assert.strictEqual(c.baton.state, 'offered');
  c = rc.claimBaton(c, { token: 'tok-1', gen: 1, now: 't2' });
  assert.deepStrictEqual(c.history, [{ gen: 0, token: 'tok-0', released: 't2' }]);
  assert.strictEqual(c.baton.holder_token, 'tok-1');
  assert.strictEqual(c.baton.state, 'held');
  assert.strictEqual(c.generation.current, 1);
  assert.strictEqual(rc.isReleasedToken(c, 'tok-0'), true);
  assert.strictEqual(rc.isReleasedToken(c, 'tok-1'), false);
});

test('claim without an offer throws', () => {
  const c = rc.createChain({ chainId: 'd', repoRoot: '/r', spawnPolicy: 'shared',
    mode: 'autonomous', holderToken: 't0', handoffDoc: '', now: 't0' });
  assert.throws(() => rc.claimBaton(c, { token: 't1', gen: 1, now: 't1' }),
    /not offered/);
});

test('expireOffer reverts a stale offer and alerts; keeps a fresh one', () => {
  let c = rc.createChain({ chainId: 'e', repoRoot: '/r', spawnPolicy: 'shared',
    mode: 'autonomous', holderToken: 't0', handoffDoc: '',
    now: '2026-08-26T00:00:00Z' });
  c = rc.offerBaton(c, { now: '2026-08-26T00:00:00Z' });
  const fresh = rc.expireOffer(c, { now: '2026-08-26T00:02:00Z' });
  assert.strictEqual(fresh.baton.state, 'offered');
  const stale = rc.expireOffer(c, { now: '2026-08-26T00:06:00Z' });
  assert.strictEqual(stale.baton.state, 'held');
  assert.strictEqual(stale.alerts.length, 1);
  assert.match(stale.alerts[0].msg, /ack timeout/);
});

test('task lifecycle enforces open -> done -> verified', () => {
  let c = rc.createChain({ chainId: 'f', repoRoot: '/r', spawnPolicy: 'shared',
    mode: 'autonomous', holderToken: 't0', handoffDoc: '', now: 't0' });
  c = rc.addTask(c, { id: 'T1', desc: 'd', acceptance: 'a' });
  assert.throws(() => rc.markVerified(c, 'T1', { gen: 0 }), /not done/);
  c = rc.markDone(c, 'T1', { gen: 0 });
  assert.strictEqual(rc.isComplete(c), false);
  c = rc.markVerified(c, 'T1', { gen: 0 });
  assert.strictEqual(rc.isComplete(c), true);
  assert.deepStrictEqual(rc.openTasks(c), []);
});

test('offerBaton refuses to offer a baton that is not held', () => {
  const c = rc.createChain({ chainId: 'o', repoRoot: '/r', spawnPolicy: 'shared',
    mode: 'autonomous', holderToken: 't0', handoffDoc: '', now: 't0' });
  const offered = rc.offerBaton(c, { now: 't1' });
  assert.throws(() => rc.offerBaton(offered, { now: 't2' }), /not held/);
});

test('addTask rejects a duplicate task id', () => {
  const c = rc.createChain({ chainId: 'p', repoRoot: '/r', spawnPolicy: 'shared',
    mode: 'autonomous', holderToken: 't0', handoffDoc: '', now: 't0' });
  const one = rc.addTask(c, { id: 'T1', desc: 'd', acceptance: 'a' });
  assert.throws(() => rc.addTask(one, { id: 'T1', desc: 'd2', acceptance: 'a2' }), /duplicate/);
});

test('isReleasedToken tolerates malformed history entries', () => {
  assert.strictEqual(rc.isReleasedToken({ history: [null, { token: 'tok-0' }] }, 'tok-0'), true);
  assert.strictEqual(rc.isReleasedToken({ history: [null] }, 'tok-0'), false);
});

// A logged incident: same-day date+slug chain ids collided (two chains sharing
// one id clobbered each other and each other's dashboard).
test('uniqueChainId embeds date + slug and never repeats for the same inputs', () => {
  const now = new Date('2026-08-26T12:00:00Z');
  const a = rc.uniqueChainId('example-app', now);
  const b = rc.uniqueChainId('example-app', now);
  assert.match(a, /^2026-08-26-example-app-[0-9a-f]{4}$/);
  assert.notStrictEqual(a, b);
});

// A logged incident: the timeout alert read "ack timeout after 0s" because the
// caller passes timeoutSec:0 after waiting its real window. reportSec carries
// the humanly-true number into the alert.
test('expireOffer reports reportSec in the alert when supplied', () => {
  const c = rc.createChain({ chainId: 'e', repoRoot: '/r', spawnPolicy: 'shared',
    mode: 'autonomous', holderToken: 't0', handoffDoc: '', now: '2026-08-26T00:00:00Z' });
  const offered = rc.offerBaton(c, { now: '2026-08-26T00:00:00Z' });
  const expired = rc.expireOffer(offered,
    { now: '2026-08-26T00:10:00Z', timeoutSec: 0, reportSec: 300 });
  assert.strictEqual(expired.baton.state, 'held');
  assert.match(expired.alerts[0].msg, /ack timeout after 300s/);
  // without reportSec the alert still names timeoutSec (existing contract)
  const plain = rc.expireOffer(offered, { now: '2026-08-26T00:10:00Z', timeoutSec: 60 });
  assert.match(plain.alerts[0].msg, /ack timeout after 60s/);
});
