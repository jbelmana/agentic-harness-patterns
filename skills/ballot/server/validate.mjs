// Ballot validator — enforcement half of the contract in ../schema/ballot.schema.json.
// Keep the two in lockstep; the schema is the human-readable mirror of these rules.
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGates } from './gate-check.mjs';

const CLASSES = ['scope', 'irreversibility', 'naming', 'placement', 'tradeoff',
  'spend', 'outward', 'locked', 'ceremony', 'blast'];
const BLAST = ['high', 'med', 'low'];
const RAILS = ['frontload', 'spec', 'gsd', 'auto'];

const isText = (v) => typeof v === 'string' && v.length > 0;
// Optional fields still have a declared type in ballot.schema.json. Absent is
// always fine; present-and-wrong is not — the renderer is defensive today, so a
// truthy `multi: "yes"` silently changes the board's shape while every check
// passes. `undefined` short-circuits so callers can write one guard per field.
const optType = (v, t) => v === undefined || typeof v === t;

/**
 * Validate a ballot object against the ballot contract.
 * @param {unknown} b — parsed ballot JSON
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateBallot(b) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  if (!b || typeof b !== 'object') return { ok: false, errors: ['ballot must be an object'] };

  const m = b.meta;
  need(m && typeof m === 'object', 'meta required');
  if (m && typeof m === 'object') {
    for (const f of ['id', 'title', 'task', 'rail', 'created']) {
      need(isText(m[f]), `meta.${f} required string`);
    }
    if (typeof m.rail === 'string') {
      need(RAILS.includes(m.rail), `meta.rail must be one of ${RAILS.join('|')}`);
    }
  }

  need(Array.isArray(b.questions), 'questions must be an array');
  const qs = Array.isArray(b.questions) ? b.questions : [];
  need(qs.length > 0 || isText(b.custom_html),
    'questions must be non-empty unless custom_html is present');
  // Exclusive, not merely sufficient. The board takes the custom branch and
  // returns before a single question card exists, so a ballot carrying both
  // would render nothing the operator could answer and still submit an answer
  // per question — `choice: null`, flagged as a deviation from the
  // recommendation. Rejecting the shape here is the only place that closes it
  // for every consumer at once.
  need(!(qs.length > 0 && isText(b.custom_html)),
    'custom_html and questions are mutually exclusive');
  need(b.custom_html === null || optType(b.custom_html, 'string'),
    'custom_html must be a string or null');

  const ids = new Set();
  qs.forEach((q, i) => {
    const at = `questions[${i}]`;
    if (!q || typeof q !== 'object') { errors.push(`${at} must be an object`); return; }
    need(isText(q.id), `${at}.id required`);
    if (isText(q.id)) {
      need(!ids.has(q.id), `${at}.id duplicate: ${q.id}`);
      ids.add(q.id);
    }
    need(CLASSES.includes(q.class), `${at}.class invalid: ${q.class}`);
    need(isText(q.question), `${at}.question required`);
    need(BLAST.includes(q.blast_radius), `${at}.blast_radius invalid`);
    need(optType(q.multi, 'boolean'), `${at}.multi must be a boolean`);
    need(optType(q.allow_note, 'boolean'), `${at}.allow_note must be a boolean`);
    // Plan ids whose human gate this question discharges. Lives on
    // questions only — a gate "represented" by a defaults entry is the
    // documented failure mode wearing a checkmark.
    if (q.gates !== undefined) {
      need(Array.isArray(q.gates), `${at}.gates must be an array of plan ids`);
      if (Array.isArray(q.gates)) {
        need(q.gates.every(isText), `${at}.gates entries must be non-empty strings`);
      }
    }

    const opts = Array.isArray(q.options) ? q.options : [];
    need(opts.length >= 2, `${at}.options needs at least 2`);
    const oids = new Set();
    opts.forEach((o, j) => {
      const oat = `${at}.options[${j}]`;
      if (!o || typeof o !== 'object') { errors.push(`${oat} must be an object`); return; }
      need(isText(o.id) && !oids.has(o.id), `${oat}.id required and unique`);
      oids.add(o.id);
      need(isText(o.label), `${oat}.label required`);
      need(isText(o.tradeoff), `${oat}.tradeoff required`);
      need(optType(o.recommended, 'boolean'), `${oat}.recommended must be a boolean`);
      need(optType(o.preview_html, 'string'), `${oat}.preview_html must be a string`);
    });
    need(opts.filter(o => o && o.recommended === true).length <= 1,
      `${at}: at most one recommended option`);
  });

  for (const [key, fields] of [['defaults', ['id', 'assumption', 'rationale']],
    ['open', ['id', 'question', 'why_open']]]) {
    // Absent is fine (both are optional), but a present non-array — null
    // included — is rejected, matching the schema's "type": "array".
    if (b[key] === undefined) continue;
    const arr = b[key];
    need(Array.isArray(arr), `${key} must be an array`);
    if (!Array.isArray(arr)) continue;
    arr.forEach((d, i) => {
      if (!d || typeof d !== 'object') { errors.push(`${key}[${i}] must be an object`); return; }
      fields.forEach(f => need(isText(d[f]), `${key}[${i}].${f} required`));
    });
  }

  return { ok: errors.length === 0, errors };
}

// CLI: node validate.mjs <path> [--phase-dir <dir>]
//   0 valid / 1 invalid (schema errors, or an unrepresented gate) / 2 unreadable
//   or usage.
// NOTE: ./ballot-server.mjs speaks a DIFFERENT exit vocabulary (0 answers ·
// 2 timeout · 3 could not start). They are independent entry points; do not
// conflate them when wiring either into a caller.
const USAGE = 'usage: node validate.mjs <ballot.json> [--phase-dir <dir>]';

// Compare realpaths on BOTH sides: ~/.claude/skills/ reaches every pack skill
// through a directory symlink, and path.resolve does not follow links — so a
// resolve-vs-realpath comparison never matches there and the gate fails open.
const realpathOrNull = (p) => { try { return realpathSync(p); } catch { return null; } };

/**
 * Is this process running validate.mjs as its entry point?
 * Exported so the fail-open branch is testable: when node runs a file argv[1] is
 * always resolvable, so a spawned test can never reach the realpath-null case.
 * Previously that case answered "not direct" and the CLI silently exited 0 —
 * validation skipped, no output, success. Now an unresolvable argv[1] falls back
 * to a basename comparison and the CLI RUNS; a false positive costs one extra
 * validation, a false negative costs a silently unvalidated ballot.
 */
export function shouldRunCli(argv1, selfUrl) {
  const self = realpathOrNull(fileURLToPath(selfUrl));
  if (!argv1) return false;
  const entry = realpathOrNull(argv1);
  if (entry !== null && self !== null) return entry === self;
  return path.basename(argv1) === path.basename(fileURLToPath(selfUrl));
}

function runCli(argv) {
  const target = argv[2];
  if (!target || target.startsWith('--')) { console.error(USAGE); return 2; }
  let phaseDir;
  for (let i = 3; i < argv.length; i += 2) {
    if (argv[i] !== '--phase-dir') { console.error(`unknown argument: ${argv[i]}\n${USAGE}`); return 2; }
    phaseDir = argv[i + 1];
    if (phaseDir === undefined || phaseDir.startsWith('--')) { console.error(USAGE); return 2; }
  }
  let obj;
  try {
    obj = JSON.parse(readFileSync(target, 'utf8'));
  } catch (e) {
    console.error(`unreadable: ${e.message}`);
    return 2;
  }
  const r = validateBallot(obj);
  if (!r.ok) { r.errors.forEach(e => console.error(e)); return 1; }
  // Gate inventory is opt-in. Without --phase-dir nothing below runs and the
  // behavior is byte-identical to the CLI before gate-checking existed.
  if (phaseDir !== undefined) {
    let g;
    try {
      g = checkGates(obj, phaseDir);
    } catch (e) {
      console.error(`phase dir unreadable: ${e.message}`);
      return 2;
    }
    if (!g.ok) { g.errors.forEach(e => console.error(e)); return 1; }
    console.log(`valid — ${g.gated.length} gate(s) represented`);
    return 0;
  }
  console.log('valid');
  return 0;
}

// Any throw escaping the CLI must be exit 2, never node's default. An uncaught
// throw here used to surface as exit 1 — the "invalid ballot" code — which reads
// to a caller as a validation verdict rather than a broken run.
if (shouldRunCli(process.argv[1], import.meta.url)) {
  let code;
  try {
    code = runCli(process.argv);
  } catch (e) {
    console.error(`validator error: ${e.message}`);
    code = 2;
  }
  process.exit(code);
}
