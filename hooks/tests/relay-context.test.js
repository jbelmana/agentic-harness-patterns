'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { displayedUsedPct, AUTO_COMPACT_BUFFER_PCT } = require('../lib/relay-context.js');

test('buffer constant matches the statusline buffer constant', () => {
  assert.strictEqual(AUTO_COMPACT_BUFFER_PCT, 16.5);
});

test('converts remaining_percentage to the displayed meter value', () => {
  // Anchor: an observed bridge sample of {remaining:34, used_pct:79}.
  assert.strictEqual(displayedUsedPct(34), 79);
  assert.strictEqual(displayedUsedPct(67), 40); // first firing value — the 40% trigger
  assert.strictEqual(displayedUsedPct(63), 44); // above the trigger
  assert.strictEqual(displayedUsedPct(62), 46); // above the trigger
  assert.strictEqual(displayedUsedPct(58), 50); // above the trigger
  assert.strictEqual(displayedUsedPct(35), 78); // existing gsd WARNING
  assert.strictEqual(displayedUsedPct(25), 90); // existing gsd CRITICAL
});

test('clamps at both ends', () => {
  assert.strictEqual(displayedUsedPct(100), 0);
  assert.strictEqual(displayedUsedPct(16.5), 100);
  assert.strictEqual(displayedUsedPct(0), 100);
  assert.strictEqual(displayedUsedPct(-5), 100);
});

test('rejects non-finite and non-numeric input rather than guessing', () => {
  assert.strictEqual(displayedUsedPct(null), null);
  assert.strictEqual(displayedUsedPct(undefined), null);
  assert.strictEqual(displayedUsedPct('62'), null);
  assert.strictEqual(displayedUsedPct(NaN), null);
  assert.strictEqual(displayedUsedPct(Infinity), null);
});

const { shouldRelay, DEFAULTS } = require('../lib/relay-context.js');

const NOW = 1787438478;
const fresh = (remaining) => ({ remaining_percentage: remaining, timestamp: NOW });
const zero = { injections: 0, callsSinceInject: 0 };
const call = (over) => shouldRelay({
  metrics: fresh(62), sentinel: zero, generation: 0, now: NOW, ...over,
});

// Every quiet path must hand back a persistable sentinel whose call counter
// advanced: the hook writes result.sentinel unconditionally, so a dropped one
// stalls debounce forever and the relay goes silent for the rest of the session.
const assertQuiet = (r, reason, priorCalls = 0) => {
  assert.strictEqual(r.inject, false, `${reason} must not inject`);
  assert.strictEqual(r.reason, reason);
  assert.ok(r.sentinel, `${reason} must return a persistable sentinel`);
  assert.strictEqual(r.sentinel.callsSinceInject, priorCalls + 1, `${reason} must count the call`);
};

test('defaults match the spec', () => {
  assert.strictEqual(DEFAULTS.triggerDisplayedPct, 40);
  assert.strictEqual(DEFAULTS.maxInjections, 3);
  assert.strictEqual(DEFAULTS.debounceCalls, 10);
  assert.strictEqual(DEFAULTS.maxGeneration, 3);
  assert.strictEqual(DEFAULTS.staleSeconds, 60);
});

test('injects on the first crossing of the threshold', () => {
  const r = call();
  assert.strictEqual(r.inject, true);
  assert.strictEqual(r.displayed, 46);
  assert.deepStrictEqual(r.sentinel, { injections: 1, callsSinceInject: 0 });
});

test('stays silent below the threshold and still counts the call', () => {
  assertQuiet(call({ metrics: fresh(68) }), 'below-threshold');
});

test('debounces until debounceCalls tool uses have elapsed', () => {
  const nine = { injections: 1, callsSinceInject: 8 };
  assertQuiet(call({ sentinel: nine }), 'debounce', 8);
  const ten = { injections: 1, callsSinceInject: 9 };
  assert.strictEqual(call({ sentinel: ten }).inject, true);
});

test('goes permanently silent after maxInjections', () => {
  assertQuiet(call({ sentinel: { injections: 3, callsSinceInject: 99 } }), 'injection-cap', 99);
});

test('refuses to relay past the generation cap', () => {
  assertQuiet(call({ generation: 3 }), 'generation-cap');
});

// ONE ceiling, two key names. The relay monitor hook spreads
// ~/.claude/relay.config.json straight into `config`, and the chain writers read
// `generationCap` out of that same file (see relay-chain-state.js). A config
// setting only `generationCap: 5` therefore created cap-5 chains while this gate
// silently stayed on the default 3. `generationCap` is the documented key;
// `maxGeneration` stays a legacy alias and must keep working.
test('the generation ceiling reads generationCap, then maxGeneration, then the default', () => {
  assert.strictEqual(call({ generation: 4, config: { generationCap: 5 } }).inject, true);
  assertQuiet(call({ generation: 5, config: { generationCap: 5 } }), 'generation-cap');
  assert.strictEqual(call({ generation: 4, config: { maxGeneration: 5 } }).inject, true);
  assertQuiet(call({ generation: 5, config: { maxGeneration: 5 } }), 'generation-cap');
  assert.strictEqual(call({ generation: 2, config: {} }).inject, true);
  assertQuiet(call({ generation: 3, config: {} }), 'generation-cap');
  assertQuiet(call({ generation: 3 }), 'generation-cap');            // no config at all
  // Both present ⇒ the documented key wins.
  assertQuiet(call({ generation: 2, config: { generationCap: 2, maxGeneration: 9 } }),
    'generation-cap');
  // DEFAULTS must NOT gain a generationCap key: it would always be defined, the
  // alias would short-circuit, and a maxGeneration-only config would go ignored.
  assert.strictEqual(DEFAULTS.generationCap, undefined);
});

// A malformed ceiling must FAIL CLOSED to the default, exactly as capOr does at
// relay-chain-state.js:36 — the two readers of this key cannot disagree. A bare
// `??` chain passes garbage through: `3 >= "lots"` is NaN-false, so the cap
// never fires again, and `0` silences the relay for good. That config shape is
// live, not theoretical (relay-chain-io.test.js:176 writes generationCap 'lots').
test('a malformed generation ceiling falls back to the default, never past it', () => {
  for (const bad of ['lots', 0, -1, null, 2.5, true, {}]) {
    assertQuiet(call({ generation: 3, config: { generationCap: bad } }), 'generation-cap');
    assertQuiet(call({ generation: 3, config: { maxGeneration: bad } }), 'generation-cap');
    assert.strictEqual(call({ generation: 2, config: { generationCap: bad } }).inject, true);
  }
  // A malformed generationCap falls THROUGH to a well-formed maxGeneration.
  assert.strictEqual(
    call({ generation: 4, config: { generationCap: 'lots', maxGeneration: 5 } }).inject, true);
});

test('ignores stale and malformed metrics', () => {
  assertQuiet(call({ now: NOW + 61 }), 'stale');
  assertQuiet(call({ metrics: null }), 'no-metrics');
  // no-metrics also covers a present metrics object with a non-numeric timestamp
  assertQuiet(call({ metrics: { remaining_percentage: 62, timestamp: 'soon' } }), 'no-metrics');
  assertQuiet(call({ metrics: { timestamp: NOW } }), 'bad-metrics');
});

test('honours a configured threshold override', () => {
  const r = call({ metrics: fresh(80), config: { triggerDisplayedPct: 20 } });
  assert.strictEqual(r.inject, true);
});

// Guards the module's stated invariant across EVERY reason at once: deleting
// `sentinel: counted` from the quiet() helper must not survive the suite.
test('every quiet path returns a persistable sentinel that counted the call', () => {
  const cases = [
    ['generation-cap', { generation: 3 }],
    ['no-metrics', { metrics: null }],
    ['no-metrics', { metrics: { remaining_percentage: 62, timestamp: 'soon' } }],
    ['stale', { now: NOW + 61 }],
    ['bad-metrics', { metrics: { timestamp: NOW } }],
    ['below-threshold', { metrics: fresh(68) }],
    ['injection-cap', { sentinel: { injections: 3, callsSinceInject: 99 } }],
    ['debounce', { sentinel: { injections: 1, callsSinceInject: 8 } }],
    ['baton-released', { released: true }],
  ];
  for (const [reason, over] of cases) {
    assertQuiet(call(over), reason, Number(over.sentinel?.callsSinceInject) || 0);
  }
});

// A sentinel corrupted to a negative count must not buy free injections:
// Number(-1) || 0 === -1, which keeps the >= maxInjections check false forever.
test('clamps a corrupt negative sentinel so the injection cap still binds', () => {
  const r = call({ sentinel: { injections: -1, callsSinceInject: 0 } });
  assert.strictEqual(r.inject, true);
  assert.deepStrictEqual(r.sentinel, { injections: 1, callsSinceInject: 0 });
  const deep = call({ sentinel: { injections: -99, callsSinceInject: 99 } });
  assert.deepStrictEqual(deep.sentinel, { injections: 1, callsSinceInject: 0 });
  assertQuiet(call({ sentinel: { injections: 1, callsSinceInject: -5 } }), 'debounce', 0);
});

// The gate is `displayed < triggerDisplayedPct`, so displayed === 40 must FIRE.
// remaining 67 maps to exactly 40 (see the displayedUsedPct assertions above).
test('fires at exactly the trigger threshold, pinning < over <=', () => {
  const r = call({ metrics: fresh(67) });
  assert.strictEqual(r.displayed, 40);
  assert.strictEqual(r.inject, true);
  assert.strictEqual(r.reason, 'relay');
});

// The gate is `now - timestamp > staleSeconds`, so exactly staleSeconds is fresh.
test('treats an age of exactly staleSeconds as fresh', () => {
  assert.strictEqual(call({ now: NOW + DEFAULTS.staleSeconds }).inject, true);
  assertQuiet(call({ now: NOW + DEFAULTS.staleSeconds + 1 }), 'stale');
});

// A released baton means a successor already owns the work — the predecessor
// must go quiet even though metrics would otherwise fire (this is the FIRST guard).
test('shouldRelay is quiet for a session whose baton is released', () => {
  const r = call({ released: true });
  assert.strictEqual(r.inject, false);
  assert.strictEqual(r.reason, 'baton-released');
});
