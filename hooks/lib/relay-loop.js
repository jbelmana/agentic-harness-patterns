'use strict';
// relay-loop.js — the PURE decision behind the Stop hook that keeps an autonomous
// relay chain looping. No I/O, no process access, no mutation of the input chain:
// every result that must be persisted comes back as `next`, a fresh clone.
// Spec: the relay v2 design note, §"Loop driver" (decision table, first
//   match wins).
// Pattern-sibling: relay-context.js — same shape, same require-free purity.
//
// decideLoop(chain, ctx, opts)
//   ctx  = { token, displayedPct: number|null, gen, now? }
//   opts = { cap, relayNudgeCap, triggerDisplayedPct }
//   ->   { allow: true, reason }            allow the turn to end
//        { allow: true, reason, next }      allow, and persist an appended alert
//        { allow: false, reason, next }     block the turn; persist `next` first

const DEFAULTS = {
  cap: 30,                 // loop iterations per generation (relay.config.json loopCap)
  relayNudgeCap: 3,        // chain-create nudges before the turn is let go
  triggerDisplayedPct: 40, // displayed meter %, matching relay-context.js
};

// The terminal ship task reads LAST in the directive however it sits in the
// array, so the model never picks "ship" ahead of the work it ships.
const SHIP_TASK = 'T-ship';

const clone = (c) => JSON.parse(JSON.stringify(c));
const allow = (reason, next) => (next ? { allow: true, reason, next } : { allow: true, reason });

// Mirrors relay-chain.js openTasks exactly — anything not yet verified is still
// work. Duplicated rather than required so this module stays require-free.
const openTasks = (c) => (c.tasks || []).filter((t) => t && t.state !== 'verified');

const openIds = (tasks) => {
  const ids = tasks.map((t) => t.id);
  return [...ids.filter((i) => i !== SHIP_TASK), ...ids.filter((i) => i === SHIP_TASK)];
};

const posInt = (n, fallback) => (Number.isInteger(n) && n >= 1 ? n : fallback);

// The chain records its own cap at creation, exactly like generation.cap — "the
// chain is the single source". Operator config only supplies the default.
const capOf = (chain, opts) => posInt(chain.loop && chain.loop.cap, opts.cap);

// A clone with the loop block whole. Schema-1 chains predate every loop field, so
// the counters are seeded here on first write; `schema` is deliberately NOT
// promoted — that would claim keys (model, waiting, decisions) the file lacks.
function seeded(chain, cap) {
  const c = clone(chain);
  if (!c.loop || typeof c.loop !== 'object') c.loop = {};
  if (!c.loop.iterations || typeof c.loop.iterations !== 'object') c.loop.iterations = {};
  if (!Number.isInteger(c.loop.relayNudges) || c.loop.relayNudges < 0) c.loop.relayNudges = 0;
  c.loop.cap = posInt(c.loop.cap, cap);
  if (!Array.isArray(c.alerts)) c.alerts = [];
  return c;
}

// Both cap rows describe states that never change on their own — `relayNudges`
// stays at the cap, `iterations[gen]` stays at the cap — so pushing on every
// turn-end would bury the ONLY tell that the loop stopped driving under copies of
// itself (`/relay status` prints every alert). The flag lives on `loop` so it
// persists beside the counters; de-duplicating on the message text instead would
// leak a copy each time the nudge alert's embedded meter reading drifted.
// Returns true when something new was appended, i.e. when there is a `next` worth
// persisting at all.
function alertOnce(next, flag, now, msg) {
  if (next.loop[flag] === true) return false;
  next.loop[flag] = true;
  next.alerts.push({ at: now, msg });
  return true;
}

// The mirror of alertOnce: an operator who raises the cap re-arms the alert. A
// `delete` rather than `= false` so the normal rows add no key at all.
const rearm = (next, flag) => { delete next.loop[flag]; };

function decideLoop(chain, ctx, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const c = ctx || {};

  // 1 — no chain, or this session is not the holder. Strangers never see the loop.
  if (!chain || !chain.baton || chain.baton.holder_token !== c.token) return allow('not-holder');
  // 2 — only an autonomous chain drives its own session.
  if (chain.mode !== 'autonomous') return allow('interactive');
  // 3 — /relay pause is the kill switch and outranks every later row.
  if (chain.paused === true) return allow('paused');
  // 4 — a declared stop class (spend / outward / money-path / ask-rule) ends the turn.
  if (chain.waiting) return allow(`waiting:${chain.waiting.class || 'unknown'}`);
  // 5 — the baton is in flight, or already handed on: the successor owns the loop.
  if (chain.baton.state !== 'held') return allow('baton-offered');
  if ((chain.history || []).some((h) => h && h.token === c.token)) return allow('baton-released');
  // 6 — nothing left to do. The model retires the chain via /relay.
  const open = openTasks(chain);
  if (open.length === 0) return allow('complete');

  const now = c.now || new Date().toISOString();
  const gen = String(c.gen ?? (chain.generation && chain.generation.current) ?? 0);
  const cap = capOf(chain, o);
  const next = seeded(chain, cap);

  // 7 — context is nearly spent: relaying now beats looping into a compaction.
  // A null displayedPct (no bridge file, or unreadable) is NOT a low reading — it
  // falls through to the loop rather than faking a nudge.
  if (typeof c.displayedPct === 'number' && c.displayedPct >= o.triggerDisplayedPct) {
    if (next.loop.relayNudges >= o.relayNudgeCap) {
      const first = alertOnce(next, 'nudgeCapAlerted', now,
        `relay nudge cap reached at ${c.displayedPct}% displayed, ${open.length} open`);
      return first ? allow('relay-nudge-cap', next) : allow('relay-nudge-cap');
    }                                          // advice, not a cage
    rearm(next, 'nudgeCapAlerted');
    next.loop.relayNudges += 1;
    // "OFFER the held chain", not a bare "run chain-create". Row 7 only ever
    // fires on a session that already HOLDS this chain, and the unqualified verb
    // reads as "create a second one" — which leaves this chain `held` forever
    // (its ship.branch, decisions and review_rounds stranded) and hands the
    // successor a fresh ledger with no T-ship. SKILL.md § chain-create step 0 is
    // the other half: reuse the held chain instead of minting a new id. The spec
    // (addendum :184) states the directive's INTENT, not a frozen string.
    return { allow: false, next, reason:
      `RELAY: offer the held chain via /relay chain-create now — context at `
      + `${c.displayedPct}% (displayed), past the ${o.triggerDisplayedPct}% mark. Hand the `
      + `${open.length} open task(s) on THIS chain to a fresh successor (reuse this chain, `
      + `do not create a second one), then this session stops. `
      + `Nudge ${next.loop.relayNudges}/${o.relayNudgeCap}.` };
  }

  // 8 — the loop cap. Nothing evaporates: the open count goes into the ledger.
  const iterations = Math.max(0, Number(next.loop.iterations[gen]) || 0);
  if (iterations >= cap) {
    const first = alertOnce(next, 'capAlerted', now, `loop cap reached, ${open.length} open`);
    return first ? allow('loop-cap', next) : allow('loop-cap');
  }

  // 9 — keep going.
  rearm(next, 'capAlerted');
  const i = iterations + 1;
  next.loop.iterations[gen] = i;
  return { allow: false, next, reason:
    `LOOP: chain ${chain.chain_id} gen ${gen} — ${open.length} open (${openIds(open).join(', ')}). `
    + 'Next: pick one, do it, run its acceptance, mark done→verified via /relay. '
    + `Iteration ${i}/${cap}. /relay pause to stop.` };
}

module.exports = { DEFAULTS, SHIP_TASK, decideLoop, openTasks, openIds };
