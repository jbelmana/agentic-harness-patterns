// Gate inventory — does this ballot represent every human gate the
// phase actually holds?
//
// The failure this closes: a ballot named one plan as
// the phase's sole blocker while plan 184-02 held a second, unrepresented gate.
// Nothing checked, so the phase ran with one gate silently discharged.
//
// Enforcement is opt-in: `validate.mjs --phase-dir <dir>`. Without the flag the
// validator behaves exactly as before.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// A "gate" is a plan that cannot proceed without a human. Three frontmatter
// tells, in the roadmap's own words plus one exclusion:
//   autonomous: false  — the plan declares it needs a human
//   checkpoint: <any>  — an explicit operator checkpoint
//   gate: <not AUTO>   — deep-spec confidence gate; FLAG/BALLOT need a human
// `gate: AUTO` is deliberately NOT a gate — AUTO is the vocabulary's "no human
// needed" value (CLAUDE.md, "confidence-gated phases (AUTO/FLAG/BALLOT)"), and
// counting it would fail every phase containing a routine plan, which is how a
// detector gets bypassed. Values carry parentheticals ("AUTO (M-effort, …)"),
// so compare the first token, case-insensitively.
const NON_GATING_GATE_VALUES = new Set(['auto']);

/** Extract the leading `---` fenced block's top-level `key: value` pairs. */
function frontmatter(text) {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;
  const out = {};
  for (const line of lines.slice(1, end)) {
    // Top level only — zero indentation. Nested `must_haves.truths` entries are
    // quoted prose that can contain a colon-key lookalike.
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** @returns {string|null} why this plan is a gate, or null when it is not. */
export function gateReason(fm) {
  if (!fm) return null;
  if (fm.autonomous === 'false') return 'autonomous: false';
  if (fm.checkpoint !== undefined) return `checkpoint: ${fm.checkpoint || '(empty)'}`;
  if (fm.gate !== undefined) {
    const first = String(fm.gate).trim().split(/[\s(]/)[0].toLowerCase();
    if (!NON_GATING_GATE_VALUES.has(first)) return `gate: ${fm.gate}`;
  }
  return null;
}

// `<phase>-<plan>-PLAN.md` -> `<phase>-<plan>`. A bare `PLAN.md` (Phase 42 ships
// one) has no stem to strip, so fall back to frontmatter phase+plan and finally
// to the containing directory name — a planId must never come back empty, or the
// failure message names nothing.
function planId(file, fm) {
  const base = path.basename(file, '.md');
  if (base !== 'PLAN') return base.replace(/-PLAN$/, '');
  if (fm?.phase && fm?.plan) return `${fm.phase}-${fm.plan}`;
  return path.basename(path.dirname(file));
}

/**
 * Walk a phase directory (one level of phase subdirectories, or a single phase
 * dir) and return every *-PLAN.md that holds a human gate.
 * @returns {{id: string, file: string, reason: string}[]}
 */
export function collectGatedPlans(phaseDir) {
  const files = [];
  const walk = (dir, depth) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth > 0) walk(p, depth - 1); continue; }
      if (/PLAN\.md$/.test(e.name)) files.push(p);
    }
  };
  if (!statSync(phaseDir).isDirectory()) {
    throw new Error(`--phase-dir is not a directory: ${phaseDir}`);
  }
  walk(phaseDir, 1);
  const gated = [];
  for (const f of files.sort()) {
    const fm = frontmatter(readFileSync(f, 'utf8'));
    const reason = gateReason(fm);
    if (reason) gated.push({ id: planId(f, fm), file: f, reason });
  }
  return gated;
}

/** Plan ids this ballot claims to represent, from every question's `gates`. */
export function representedGates(ballot) {
  const out = new Set();
  const qs = Array.isArray(ballot?.questions) ? ballot.questions : [];
  for (const q of qs) {
    if (Array.isArray(q?.gates)) for (const g of q.gates) if (typeof g === 'string') out.add(g);
  }
  return out;
}

/**
 * @returns {{ok: boolean, errors: string[], gated: object[]}}
 */
export function checkGates(ballot, phaseDir) {
  const gated = collectGatedPlans(phaseDir);
  const claimed = representedGates(ballot);
  const missing = gated.filter(g => !claimed.has(g.id));
  const errors = missing.map(g =>
    `unrepresented gate: ${g.id} (${g.reason}) — ${path.relative(phaseDir, g.file)}`);
  // A `gates` entry naming a plan that holds no gate is a stale claim, not a
  // blocker: it means the ballot still believes in a gate the plan dropped.
  const known = new Set(gated.map(g => g.id));
  for (const c of [...claimed].sort()) {
    if (!known.has(c)) errors.push(`gates names a plan with no gate in ${phaseDir}: ${c}`);
  }
  return { ok: errors.length === 0, errors, gated };
}
