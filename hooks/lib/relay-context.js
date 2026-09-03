'use strict';
// Pure context math + relay decision. No I/O, no process access.
//
// Gating uses remaining_percentage, never used_pct: the bridge's used_pct means
// two different things depending on which statusline wrote it. One statusline
// writes the buffer-normalized number shown to the user; another deliberately
// writes the raw one to match native /context. Both write remaining_percentage
// raw, so converting here keeps this hook correct under either statusline.

const AUTO_COMPACT_BUFFER_PCT = 16.5; // mirrors the statusline's buffer constant

function displayedUsedPct(remaining) {
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return null;
  const usable = Math.max(
    0,
    ((remaining - AUTO_COMPACT_BUFFER_PCT) / (100 - AUTO_COMPACT_BUFFER_PCT)) * 100
  );
  return Math.max(0, Math.min(100, Math.round(100 - usable)));
}

const DEFAULTS = {
  triggerDisplayedPct: 40, // displayed meter %, not remaining_percentage
  triggerAbsoluteTokens: 300000, // absolute-token arm (a teammate's observed knee), OR'd with displayed
  maxInjections: 3,        // then permanently silent — relay is advice, not a cage
  debounceCalls: 10,       // tool uses between injections
  maxGeneration: 3,        // relay chain depth ceiling — see generationCeiling
  staleSeconds: 60,        // ignore bridge metrics older than this
};

// ONE ceiling, two key names. The relay monitor hook spreads
// ~/.claude/relay.config.json straight into `config`, and the chain writers read
// `generationCap` out of that same file (see relay-chain-state.js) — so
// `{"generationCap": 5}` created cap-5 chains while this hook silently refused to
// propose a handoff past 3. `generationCap` is the documented key; `maxGeneration`
// stays a legacy alias. Deliberately NOT a DEFAULTS entry: a default would make
// `cfg.generationCap` always defined, short-circuit the alias, and ignore a
// config that sets only `maxGeneration` — the same defect inverted.
// Each candidate is VALIDATED, not merely non-nullish — the same guard `capOr`
// applies in relay-chain-state.js, because the two readers of this key must
// agree on malformed input. A bare `??` chain would let `{"generationCap":
// "lots"}` through as the ceiling, where `n >= "lots"` is NaN-false and the cap
// never fires again; `0` would silence the relay permanently.
const valid = (v) => (Number.isInteger(v) && v >= 1 ? v : null);
const generationCeiling = (cfg) =>
  valid(cfg.generationCap) ?? valid(cfg.maxGeneration) ?? DEFAULTS.maxGeneration;

// Absolute-arm threshold (settled by design ballot): at most ONE fire per
// session by latch, structurally zero on windows under 300K, and it consumes a
// shared maxInjections slot — the phase adds no directive budget. `false`
// disables the arm; an integer >= 1 is honoured; anything else falls back.
const absoluteThreshold = (cfg) =>
  cfg.triggerAbsoluteTokens === false
    ? null : valid(cfg.triggerAbsoluteTokens) ?? DEFAULTS.triggerAbsoluteTokens;

// Returns the injection decision AND the sentinel value to persist. Callers
// always write result.sentinel — the call counter must advance even on the
// silent paths, or debounce never elapses. Guard order is fixed by design: caps
// first, then BOTH trigger arms evaluated (OR, no suppression).
function shouldRelay({ metrics, sentinel, generation, now, config, released, absoluteTokens }) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const prev = sentinel || {};
  // Floor both counters at 0: a sentinel corrupted to a negative injections
  // count keeps `counted.injections >= cfg.maxInjections` false forever, which
  // disables the cap and lets the relay nag for the life of the session.
  // absoluteFiredAt rides through every path or the latch evaporates.
  const counted = {
    injections: Math.max(0, Number(prev.injections) || 0),
    callsSinceInject: Math.max(0, Number(prev.callsSinceInject) || 0) + 1,
    ...(prev.absoluteFiredAt != null ? { absoluteFiredAt: prev.absoluteFiredAt } : {}),
  };
  const quiet = (reason) => ({ inject: false, reason, sentinel: counted });

  // First guard: a released baton means a successor already owns this work.
  if (released) return quiet('baton-released');
  if ((Number(generation) || 0) >= generationCeiling(cfg)) return quiet('generation-cap');
  if (counted.injections >= cfg.maxInjections) return quiet('injection-cap');

  const absT = absoluteThreshold(cfg);
  const absValid = Number.isInteger(absoluteTokens) && Number.isFinite(absoluteTokens);
  const absOver = absT !== null && absValid && absoluteTokens >= absT;
  const absoluteCrossed = absOver && prev.absoluteFiredAt == null;

  const metricsBad = !metrics || typeof metrics.timestamp !== 'number' ? 'no-metrics'
    : now - metrics.timestamp > cfg.staleSeconds ? 'stale' : null;
  const displayed = metricsBad ? null : displayedUsedPct(metrics.remaining_percentage);
  const displayedCrossed = !metricsBad && displayed !== null
    && displayed >= cfg.triggerDisplayedPct;

  if (!absoluteCrossed && !displayedCrossed) {
    if (metricsBad) return quiet(metricsBad);
    if (displayed === null) return quiet('bad-metrics');
    return quiet(absOver ? 'absolute-latched' : 'below-threshold');
  }

  const isFirst = counted.injections === 0;
  if (!isFirst && counted.callsSinceInject < cfg.debounceCalls) return quiet('debounce');

  return {
    inject: true,
    reason: absoluteCrossed ? 'absolute' : 'relay',
    displayed,
    absoluteTokens: absValid ? absoluteTokens : null,
    sentinel: {
      injections: counted.injections + 1,
      callsSinceInject: 0,
      ...(absoluteCrossed ? { absoluteFiredAt: now }
        : prev.absoluteFiredAt != null ? { absoluteFiredAt: prev.absoluteFiredAt } : {}),
    },
  };
}

// absoluteThreshold is exported so the monitor's directive text derives the
// printed threshold from the SAME validator the gate used (a design review
// caught a malformed config rendering "past the NaNK mark" while the gate
// correctly fell back).
module.exports = { AUTO_COMPACT_BUFFER_PCT, DEFAULTS, displayedUsedPct, shouldRelay, absoluteThreshold };
