'use strict';
// relay-chain-state.js — operator config and the schema-2 chain state helpers
// (paused / waiting / decisions). Split out of relay-chain.js, which sits at the
// 200-LOC ceiling; everything here is re-exported from there, so callers still
// need exactly one require.
//
// Standalone by design: relay-chain.js requires THIS file, never the reverse.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_GENERATION_CAP = 3; // relay chain depth
const DEFAULT_LOOP_CAP = 30;      // Stop-hook iterations per generation
// Chains `/relay next` may start per day. This is a SPEND cap: each chain runs
// unattended sessions on metered API billing, so it is never raised without the
// operator confirming the billing plan first.
const DEFAULT_CHAINS_PER_DAY = 3;

// The ONLY decision classes that may end an autonomous turn (design ballot q3).
// Everything else takes the recommended default and lands in `decisions[]` —
// see rules/interaction-style.md § Interactive triage.
const WAITING_CLASSES = ['spend', 'outward', 'money-path', 'ask-rule'];

// One read for every operator knob. CLAUDE_RELAY_CONFIG repoints the file for
// tests. A missing, unreadable, or malformed config must never throw — the
// defaults below stand instead.
function readConfig() {
  const file = process.env.CLAUDE_RELAY_CONFIG
    || path.join(os.homedir(), '.claude', 'relay.config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch { return {}; }
}

const capOr = (v, d) => (Number.isInteger(v) && v >= 1 ? v : d);
const configuredCap = () => capOr(readConfig().generationCap, DEFAULT_GENERATION_CAP);
const configuredLoopCap = () => capOr(readConfig().loopCap, DEFAULT_LOOP_CAP);
const configuredChainsPerDay = () =>
  capOr(readConfig().chainsPerDay, DEFAULT_CHAINS_PER_DAY);

// ── schema 2 ────────────────────────────────────────────────────────────────
// Every helper below is a clone-then-mutate: the caller's chain is never touched,
// exactly like the baton/task transitions in relay-chain.js.
const clone = (c) => JSON.parse(JSON.stringify(c));

// The three ways a chain can stop. `complete` = every task verified (on an
// owned repo, through a merged PR); `cap` = generation or loop ceiling hit;
// `review-stalled` = 2 review rounds did not clear the findings, so they were
// filed and the PR left open. Anything else is a caller bug, not a new state.
// Declared ABOVE schemaTwoFields, which spreads shipFields into the seed.
const END_REASONS = ['complete', 'cap', 'review-stalled'];
const shipDefault = () =>
  ({ branch: null, pr: null, review_rounds: 0, merged: false });
const shipFields = () => ({ ship: shipDefault(), ended: null });

// The v2.1 field seed, spread into createChain. `model` is optional at the lib
// level — `/relay start` and `chain-create` are the callers that MUST supply the
// session's own model id; a chain written by an older writer legitimately has none.
const schemaTwoFields = (model = null) => ({
  schema: 2, model: model ?? null, paused: false, waiting: null,
  loop: { cap: configuredLoopCap(), iterations: {}, relayNudges: 0 },
  decisions: [],
  ...shipFields(), // v2.1 review pathway: every chain ends by shipping (T13)
});

// Returns an error string, or null when the schema-2 half is well formed.
// validateChain calls this ONLY when `schema === 2`, so a schema-1 file — and any
// schema-1 chain the loop driver seeds `loop` into — still validates unchanged.
function schemaTwoError(c) {
  for (const k of ['model', 'paused', 'waiting', 'loop', 'decisions'])
    if (!(k in c)) return `missing ${k}`;
  if (c.model !== null && typeof c.model !== 'string') return 'model not a string';
  if (typeof c.paused !== 'boolean') return 'paused not a boolean';
  if (!Array.isArray(c.decisions)) return 'decisions not an array';
  if (!c.loop || typeof c.loop !== 'object') return 'loop not an object';
  if (!c.loop.iterations || typeof c.loop.iterations !== 'object') return 'loop.iterations';
  if (c.waiting !== null) {
    if (!c.waiting || typeof c.waiting !== 'object') return 'waiting not an object';
    if (!WAITING_CLASSES.includes(c.waiting.class)) return `waiting.class ${c.waiting.class}`;
  }
  return shipError(c);
}

// Schema 2 is additive WITHIN itself too: `ship` and `ended` arrived in v2.1, so
// the T11-era chains already on disk carry neither. Requiring them would fail
// validateChain — the exact gate the baton guard and the loop driver read — and
// a live chain would go dark on an upgrade. Checked only once present.
function shipError(c) {
  if ('ship' in c && c.ship !== undefined) {
    const s = c.ship;
    if (!s || typeof s !== 'object') return 'ship not an object';
    for (const k of ['branch', 'pr', 'review_rounds', 'merged'])
      if (!(k in s)) return `ship missing ${k}`;
    if (typeof s.merged !== 'boolean') return 'ship.merged not a boolean';
    if (!Number.isInteger(s.review_rounds)) return 'ship.review_rounds not an integer';
  }
  if ('ended' in c && c.ended !== undefined && c.ended !== null) {
    if (typeof c.ended !== 'object') return 'ended not an object';
    if (!END_REASONS.includes(c.ended.reason)) return `ended.reason ${c.ended.reason}`;
  }
  return null;
}

// The review pathway's one write: branch at start, PR when /ship opens it, a
// round count as findings come back, merged when gh reports mergedAt. A chain
// written before v2.1 has no `ship` at all, so the default is seeded UNDER the
// patch — a partial record would fail shipError on the very next validate.
function setShip(chain, patch) {
  const c = clone(chain);
  c.ship = { ...shipDefault(), ...(c.ship || {}), ...patch };
  return c;
}

// The review-round WRITER. `setShip` takes an absolute count, so without this a
// successor generation could not tell whether round 1 or round 2 had been spent
// and the "max 2 rounds" cap was unenforceable across a handoff — while `status`
// and the dashboard rendered a permanent 0. A non-integer count (a hand-edited
// chain) reseeds from 0 rather than concatenating a string shipError would reject.
function bumpReviewRound(chain) {
  const n = ((chain && chain.ship) || {}).review_rounds;
  return setShip(chain, { review_rounds: (Number.isInteger(n) ? n : 0) + 1 });
}

// Why the chain stopped, stamped once. Refusing an unknown reason here keeps a
// chain from reaching disk in a shape validateChain would later reject.
function markEnded(chain, { reason, now } = {}) {
  if (!END_REASONS.includes(reason))
    throw new Error(`markEnded: reason '${reason}' is not one of ${END_REASONS.join(', ')}`);
  const c = clone(chain);
  c.ended = { reason, at: now || new Date().toISOString() };
  return c;
}

// The model declares a stop class and ends the turn; the loop driver reads
// `waiting` on row 4 and stops driving until /relay resume clears it. Refusing an
// off-allowlist class HERE keeps a chain from being written into a shape that
// validateChain — and therefore the baton guard — would later skip.
function setWaiting(chain, { class: cls, question, options, now }) {
  if (!WAITING_CLASSES.includes(cls))
    throw new Error(`waiting: class '${cls}' is not one of ${WAITING_CLASSES.join(', ')}`);
  const c = clone(chain);
  // `now` defaults, like logDecision/clearWaiting: schemaTwoError does NOT require
  // `since`, so an omitted timestamp would drop the key, validate clean, and leave
  // /relay status and the dashboard rendering a wait they cannot date.
  c.waiting = { class: cls, question, since: now || new Date().toISOString() };
  if (options !== undefined) c.waiting.options = options;
  return c;
}

// An autonomous decision, numbered D1, D2, … unless the caller pins an id.
function logDecision(chain, d) {
  const c = clone(chain);
  const list = Array.isArray(c.decisions) ? c.decisions : [];
  list.push({
    id: d.id || `D${list.length + 1}`,
    question: d.question, chosen: d.chosen, why: d.why,
    gen: d.gen ?? (c.generation && c.generation.current) ?? 0,
    ts: d.ts || new Date().toISOString(),
  });
  c.decisions = list;
  return c;
}

// /relay resume: the human's answer clears the wait AND becomes a decision, so
// the ledger records why the loop restarted. A chain that was not waiting still
// records the answer rather than throwing — resume must never be a dead end.
function clearWaiting(chain, { answer, now }) {
  const w = chain.waiting || null;
  const c = logDecision(chain, {
    question: w ? w.question : 'resume',
    chosen: answer,
    why: w ? `answered a ${w.class} wait` : 'resumed with no wait pending',
    ts: now,
  });
  c.waiting = null;
  return c;
}

// /relay pause — the kill switch the loop driver honours ahead of every other row.
function setPaused(chain, paused) {
  const c = clone(chain);
  c.paused = paused === true;
  return c;
}

module.exports = { DEFAULT_GENERATION_CAP, DEFAULT_LOOP_CAP, DEFAULT_CHAINS_PER_DAY,
  WAITING_CLASSES, END_REASONS,
  readConfig, configuredCap, configuredLoopCap, configuredChainsPerDay,
  schemaTwoFields, schemaTwoError, shipFields, shipError,
  setWaiting, clearWaiting, logDecision, setPaused,
  setShip, bumpReviewRound, markEnded };
