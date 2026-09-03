'use strict';
// relay-chain-state.test.js — chain schema 2: the operator config readers, the
// createChain field seed, validateChain's schema-2 arm, and the four state
// helpers (setWaiting / clearWaiting / logDecision / setPaused).
// The schema-1 half of the ledger stays in relay-chain.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const rc = require('../lib/relay-chain.js');

const NOW = '2026-08-27T00:00:00.000Z';
const ABSENT = path.join(os.tmpdir(), 'relay-config-absent.json');

// Every test pins CLAUDE_RELAY_CONFIG so the machine's real relay.config.json
// can never decide an assertion.
const withConfig = (t, cfg) => {
  if (cfg === null) { process.env.CLAUDE_RELAY_CONFIG = ABSENT; }
  else {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'relaycfg-')), 'relay.config.json');
    fs.writeFileSync(f, cfg);
    process.env.CLAUDE_RELAY_CONFIG = f;
  }
  t.after(() => { delete process.env.CLAUDE_RELAY_CONFIG; });
};

const make = (over = {}) => rc.createChain({ chainId: 'c', repoRoot: '/r',
  spawnPolicy: 'shared', mode: 'autonomous', holderToken: 'tok-1',
  handoffDoc: '', now: NOW, ...over });

// ── operator config ──────────────────────────────────────────────────────────
test('loopCap: default 30, config wins, malformed falls back', (t) => {
  withConfig(t, null);
  assert.strictEqual(rc.configuredLoopCap(), 30);
  assert.strictEqual(rc.configuredCap(), 3);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaycfg-'));
  const f = path.join(dir, 'relay.config.json');
  process.env.CLAUDE_RELAY_CONFIG = f;
  fs.writeFileSync(f, JSON.stringify({ loopCap: 7, generationCap: 2 }));
  assert.strictEqual(rc.configuredLoopCap(), 7);
  assert.strictEqual(rc.configuredCap(), 2);          // one file, both knobs
  fs.writeFileSync(f, JSON.stringify({ loopCap: 'lots' }));
  assert.strictEqual(rc.configuredLoopCap(), 30);
  fs.writeFileSync(f, 'not json');
  assert.strictEqual(rc.configuredLoopCap(), 30);
  assert.deepStrictEqual(rc.readConfig(), {});
});

// ── createChain seeds schema 2 ───────────────────────────────────────────────
test('createChain seeds the schema-2 fields and validates', (t) => {
  withConfig(t, null);
  const c = make();
  assert.strictEqual(c.schema, 2);
  assert.strictEqual(c.model, null);                  // optional at the lib level
  assert.strictEqual(c.paused, false);
  assert.strictEqual(c.waiting, null);
  assert.deepStrictEqual(c.loop, { cap: 30, iterations: {}, relayNudges: 0 });
  assert.deepStrictEqual(c.decisions, []);
  assert.strictEqual(rc.validateChain(c).ok, true);
});

test('createChain records the model and honours the configured loop cap', (t) => {
  withConfig(t, JSON.stringify({ loopCap: 12 }));
  const c = make({ model: 'claude-opus-5' });
  assert.strictEqual(c.model, 'claude-opus-5');
  assert.strictEqual(c.loop.cap, 12);
  assert.strictEqual(rc.validateChain(c).ok, true);
});

// ── validateChain, schema-2 arm ──────────────────────────────────────────────
test('validateChain still accepts a schema-1 chain unchanged', (t) => {
  withConfig(t, null);
  const c = make();
  for (const k of ['schema', 'model', 'paused', 'waiting', 'loop', 'decisions']) delete c[k];
  assert.strictEqual(rc.validateChain(c).ok, true);
});

test('validateChain requires every schema-2 key once schema is 2', (t) => {
  withConfig(t, null);
  for (const k of ['model', 'paused', 'waiting', 'loop', 'decisions']) {
    const c = make(); delete c[k];
    const v = rc.validateChain(c);
    assert.strictEqual(v.ok, false, `${k} should be required`);
    assert.match(v.error, new RegExp(k));
  }
});

test('validateChain rejects bad schema-2 shapes and a waiting class off the allowlist', (t) => {
  withConfig(t, null);
  const bad = (over) => rc.validateChain(Object.assign(make(), over));
  assert.match(bad({ paused: 'yes' }).error, /paused/);
  assert.match(bad({ model: 7 }).error, /model/);
  assert.match(bad({ loop: null }).error, /loop/);
  assert.match(bad({ loop: { cap: 30, relayNudges: 0 } }).error, /loop\.iterations/);
  assert.match(bad({ decisions: 'none' }).error, /decisions/);
  assert.match(bad({ waiting: { class: 'vibes', question: 'q', since: NOW } }).error,
    /waiting\.class/);
  for (const cls of rc.WAITING_CLASSES)
    assert.strictEqual(bad({ waiting: { class: cls, question: 'q', since: NOW } }).ok, true);
});

// ── setWaiting ───────────────────────────────────────────────────────────────
test('setWaiting records the class, question, since and options without mutating', (t) => {
  withConfig(t, null);
  const c = make({ model: 'm' });
  const before = JSON.stringify(c);
  const w = rc.setWaiting(c, { class: 'spend', question: 'enable the paid key?',
    options: ['yes', 'no'], now: NOW });
  assert.deepStrictEqual(w.waiting, { class: 'spend', question: 'enable the paid key?',
    since: NOW, options: ['yes', 'no'] });
  assert.strictEqual(rc.validateChain(w).ok, true);
  assert.strictEqual(JSON.stringify(c), before);
  assert.strictEqual(rc.setWaiting(c, { class: 'outward', question: 'q', now: NOW })
    .waiting.options, undefined);
});

// `since` is what /relay status and the dashboard date the wait by, and
// schemaTwoError does NOT require it — so an omitted `now` would drop the key,
// validate clean, and render an undatable wait. Default it, like logDecision.
test('setWaiting dates the wait even when the caller omits now', (t) => {
  withConfig(t, null);
  const w = rc.setWaiting(make(), { class: 'ask-rule', question: 'force-push?' });
  assert.match(w.waiting.since, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.strictEqual(rc.validateChain(w).ok, true);
});

test('setWaiting refuses a class that validateChain would then reject', (t) => {
  withConfig(t, null);
  assert.throws(() => rc.setWaiting(make(), { class: 'vibes', question: 'q', now: NOW }),
    /waiting.*vibes/);
});

// ── clearWaiting ─────────────────────────────────────────────────────────────
test('clearWaiting clears the wait and appends the answer to decisions[]', (t) => {
  withConfig(t, null);
  const w = rc.setWaiting(make(), { class: 'money-path', question: 'post the ledger row?',
    now: NOW });
  const before = JSON.stringify(w);
  const c = rc.clearWaiting(w, { answer: 'no — read-only phase', now: NOW });
  assert.strictEqual(c.waiting, null);
  assert.strictEqual(c.decisions.length, 1);
  assert.strictEqual(c.decisions[0].question, 'post the ledger row?');
  assert.strictEqual(c.decisions[0].chosen, 'no — read-only phase');
  assert.strictEqual(c.decisions[0].gen, 0);
  assert.strictEqual(c.decisions[0].ts, NOW);
  assert.strictEqual(c.decisions[0].id, 'D1');
  assert.strictEqual(rc.validateChain(c).ok, true);
  assert.strictEqual(JSON.stringify(w), before);
  // Resuming a chain that was not waiting still records the answer, never throws.
  assert.strictEqual(rc.clearWaiting(make(), { answer: 'go', now: NOW }).decisions.length, 1);
});

// ── logDecision ──────────────────────────────────────────────────────────────
test('logDecision appends an autonomous decision and numbers it', (t) => {
  withConfig(t, null);
  const c = make();
  const one = rc.logDecision(c, { question: 'which cap?', chosen: '30',
    why: 'recommended default', ts: NOW });
  assert.deepStrictEqual(one.decisions, [{ id: 'D1', question: 'which cap?', chosen: '30',
    why: 'recommended default', gen: 0, ts: NOW }]);
  const two = rc.logDecision(one, { id: 'D-x', question: 'q2', chosen: 'c2', why: 'w2',
    gen: 2, ts: NOW });
  assert.strictEqual(two.decisions[1].id, 'D-x');
  assert.strictEqual(two.decisions[1].gen, 2);
  assert.strictEqual(one.decisions.length, 1);        // input untouched
  assert.strictEqual(rc.validateChain(two).ok, true);
});

// ── setPaused ────────────────────────────────────────────────────────────────
test('setPaused flips the kill switch without mutating', (t) => {
  withConfig(t, null);
  const c = make();
  const p = rc.setPaused(c, true);
  assert.strictEqual(p.paused, true);
  assert.strictEqual(c.paused, false);
  assert.strictEqual(rc.setPaused(p, false).paused, false);
  assert.strictEqual(rc.validateChain(p).ok, true);
});

// A schema-1 chain that gets paused/decided must still validate — the helpers add
// keys without claiming schema 2, so nothing they touch can trip the baton guard.
test('the state helpers leave a schema-1 chain valid', (t) => {
  withConfig(t, null);
  const c = make();
  for (const k of ['schema', 'model', 'paused', 'waiting', 'loop', 'decisions']) delete c[k];
  assert.strictEqual(rc.validateChain(rc.setPaused(c, true)).ok, true);
  assert.strictEqual(rc.validateChain(rc.logDecision(c, { question: 'q', chosen: 'c',
    why: 'w', ts: NOW })).ok, true);
  assert.strictEqual(rc.validateChain(rc.setWaiting(c, { class: 'ask-rule', question: 'q',
    now: NOW })).ok, true);
});
