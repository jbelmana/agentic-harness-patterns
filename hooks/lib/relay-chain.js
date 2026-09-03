'use strict';
// relay-chain.js — pure chain/ledger/baton logic for relay v2.
// Spec: the relay v2 design note.
// Pattern-sibling: relay-context.js (pure module, no I/O beyond fs on request).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
// Directory layout lives next door (this file is at the 200-LOC ceiling) and is
// re-exported below: T11-T14 resolve chain homes through relay-chain.js.
const dirs = require('./relay-dirs.js');
// Operator config + the schema-2 state helpers live next door for the same
// reason, and are re-exported below so callers still need one require.
const state = require('./relay-chain-state.js');

// RELAY_DIR is the legacy instance-file and chain home. Chains themselves live
// in <repo_root>/.relay by preference — see relay-dirs.js for why.
const RELAY_DIR = dirs.RELAY_DIR;
const BATON_STATES = ['held', 'offered'];
const TASK_STATES = ['open', 'done', 'verified'];

// The caps bound the whole relay, so their defaults are operator config rather
// than literals — read via relay-chain-state.js (generationCap + loopCap, one
// file read, never throws).
const configuredCap = state.configuredCap;

// Where chain files are looked for, in priority order: the repo-local .relay of
// the current working directory first, then RELAY_DIR (legacy / default).
const defaultChainDirs = () => [path.join(process.cwd(), '.relay'), RELAY_DIR];

const chainPath = (chainId, dir = RELAY_DIR) => path.join(dir, `chain-${chainId}.json`);

// Same-day date+slug ids collided in practice: two chains created the same day
// for the same repo shared an id and clobbered each other AND each other's
// dashboard artifact. A 4-hex suffix makes the id unique per creation.
function uniqueChainId(slug, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return `${day}-${slug}-${crypto.randomBytes(2).toString('hex')}`;
}

function createChain({ chainId, repoRoot, spawnPolicy, mode, holderToken,
  handoffDoc, now, model = null, cap = configuredCap(), generation = 0 }) {
  return {
    chain_id: chainId, created: now, repo_root: repoRoot,
    spawn_policy: spawnPolicy, mode, artifact_url: '',
    generation: { current: generation, cap },
    baton: { holder_token: holderToken, state: 'held',
             offered_at: null, claimed_at: now },
    handoff_doc: handoffDoc, tasks: [], history: [], alerts: [],
    ...state.schemaTwoFields(model), // schema 2: model/paused/waiting/loop/decisions
  };
}

function validateChain(c) {
  const fail = (m) => ({ ok: false, error: m });
  if (!c || typeof c !== 'object') return fail('not an object');
  for (const k of ['chain_id', 'created', 'repo_root', 'spawn_policy', 'mode',
    'artifact_url', 'baton', 'generation', 'handoff_doc', 'tasks', 'history',
    'alerts']) if (!(k in c)) return fail(`missing ${k}`);
  if (!c.generation || typeof c.generation.current !== 'number') return fail('generation.current');
  if (!c.baton || typeof c.baton !== 'object') return fail('baton not an object');
  if (!Array.isArray(c.tasks)) return fail('tasks not an array');
  if (!BATON_STATES.includes(c.baton.state)) return fail('baton.state invalid');
  if (!['worktree', 'shared'].includes(c.spawn_policy)) return fail('spawn_policy');
  if (!['autonomous', 'interactive'].includes(c.mode)) return fail('mode');
  for (const t of c.tasks)
    if (!TASK_STATES.includes(t.state)) return fail(`task ${t.id} state`);
  // Schema 2 is additive: only a file that CLAIMS it is held to it, so every
  // schema-1 chain on disk keeps validating exactly as it did before.
  if (c.schema === 2) { const e = state.schemaTwoError(c); if (e) return fail(e); }
  return { ok: true };
}

function writeChain(file, chain) {
  const tmpFile = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmpFile, JSON.stringify(chain, null, 2));
  fs.renameSync(tmpFile, file); // atomic on same volume
}

// Creation-only write: refuses to clobber an existing chain file (flag 'wx').
// writeChain stays the update path; this is the id-collision backstop — a second
// same-id createChain must fail loudly, never silently replace a live chain.
function createChainFileExclusive(file, chain) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  // A chain ledger is per-machine runtime state, never committed. Seeding the
  // ignore beside the FIRST chain means any repo can host one without landing a
  // .gitignore edit first. 'wx' so an operator-written ignore is never clobbered;
  // a failure here must not block the create.
  try { fs.writeFileSync(path.join(dir, '.gitignore'), '*\n', { flag: 'wx' }); }
  catch { /* already present, or unwritable — the chain still matters more */ }
  try { fs.writeFileSync(file, JSON.stringify(chain, null, 2), { flag: 'wx' }); }
  catch (e) {
    if (e.code === 'EEXIST') return { ok: false, error: `exists: ${file}` };
    return { ok: false, error: `write: ${e.code || e.message}` };
  }
  return { ok: true };
}

function loadChain(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { ok: false, error: `read: ${e.code}` }; }
  try { return { ok: true, chain: JSON.parse(raw) }; }
  catch { return { ok: false, error: 'parse: invalid JSON' }; }
}

// Accepts a single dir (back-compat) or a list; scans all, newest mtime wins
// across the whole set — a repo-local chain and a legacy RELAY_DIR chain are
// one namespace, not two.
function resolveNewestChain(dirs = defaultChainDirs()) {
  const list = typeof dirs === 'string' ? [dirs] : dirs;
  const byMtime = [];
  for (const dir of list) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!/^chain-.*\.json$/.test(n) || n.endsWith('.done.json')) continue;
      try { byMtime.push({ f: path.join(dir, n), m: fs.statSync(path.join(dir, n)).mtimeMs }); }
      catch { /* deleted between readdir and stat — skip */ }
    }
  }
  if (!byMtime.length) return null;
  byMtime.sort((a, b) => b.m - a.m);
  return byMtime[0].f;
}

// ── transitions ────────────────────────────────────────────────────────────
const clone = (c) => JSON.parse(JSON.stringify(c));

// Options-object validation lives in relay-args.js: every helper below takes its
// trailing argument as an OPTIONS OBJECT, and a positional scalar destructures to
// `undefined` on every field while the call SUCCEEDS. See that file for the
// measured failure modes (FINDINGS.md F6, ruling D-8).
const { opts, requireGen } = require('./relay-args.js');

function offerBaton(chain, o) {
  const { now } = opts(o, ['now'], 'offerBaton');
  if (chain.baton.state !== 'held') throw new Error('offer: baton not held');
  const c = clone(chain);
  c.baton.state = 'offered'; c.baton.offered_at = now;
  return c;
}

function claimBaton(chain, o) {
  const { token, gen, now } = opts(o, ['token', 'gen', 'now'], 'claimBaton');
  if (chain.baton.state !== 'offered') throw new Error('claim: baton not offered');
  const c = clone(chain);
  c.history.push({ gen: c.generation.current, token: c.baton.holder_token,
    released: now });
  c.baton = { holder_token: token, state: 'held', offered_at: null,
    claimed_at: now };
  c.generation.current = gen;
  return c;
}

// reportSec: the humanly-true timeout for the alert text. A caller that already
// waited its full window passes timeoutSec:0 (any standing offer is expired by
// definition) — without reportSec the alert would then lie ("ack timeout after
// 0s", observed live 2026-08-26).
function expireOffer(chain, o) {
  const { now, timeoutSec = 300, reportSec } =
    opts(o, ['now', 'timeoutSec', 'reportSec'], 'expireOffer');
  if (chain.baton.state !== 'offered') return chain;
  const age = (Date.parse(now) - Date.parse(chain.baton.offered_at)) / 1000;
  if (!(age > timeoutSec)) return chain;
  const c = clone(chain);
  c.baton.state = 'held'; c.baton.offered_at = null;
  c.alerts.push({ at: now, msg: `ack timeout after ${reportSec ?? timeoutSec}s — baton reverted to predecessor` });
  return c;
}

function addTask(chain, o) {
  const { id, desc, acceptance } = opts(o, ['id', 'desc', 'acceptance'], 'addTask');
  const c = clone(chain);
  if (c.tasks.some((t) => t.id === id)) throw new Error(`task ${id}: duplicate id`);
  c.tasks.push({ id, desc, acceptance, state: 'open', gen: c.generation.current });
  return c;
}

function transitionTask(chain, id, from, to, gen) {
  const c = clone(chain);
  const t = c.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`task ${id}: not found`);
  if (t.state !== from) throw new Error(`task ${id}: not ${from}`);
  t.state = to; t.gen = gen;
  return c;
}

const markDone = (c, id, o) =>
  transitionTask(c, id, 'open', 'done',
    requireGen(opts(o, ['gen'], 'markDone').gen, 'markDone'));
const markVerified = (c, id, o) =>
  transitionTask(c, id, 'done', 'verified',
    requireGen(opts(o, ['gen'], 'markVerified').gen, 'markVerified'));
const openTasks = (c) => c.tasks.filter((t) => t.state !== 'verified');
const isComplete = (c) => c.tasks.length > 0 && openTasks(c).length === 0;
const isReleasedToken = (c, token) => (c.history || []).some((h) => h && h.token === token);

function claimVerified(file, { token, gen, now }) {
  const r = loadChain(file);
  if (!r.ok) return r;
  let next;
  try { next = claimBaton(r.chain, { token, gen, now }); }
  catch (e) { return { ok: false, error: e.message }; }
  try { writeChain(file, next); }
  catch (e) { return { ok: false, error: `write: ${e.code || e.message}` }; }
  const back = loadChain(file);            // verify-after-write
  if (!back.ok || back.chain.baton.holder_token !== token)
    return { ok: false, error: 'verify-after-write failed' };
  return { ok: true, chain: back.chain };
}

// Deletes every instance-*.json in `dir` whose token is one of `tokens`. A
// stranger's file — any other chain's identity — is left exactly where it is.
function unlinkInstances(dir, tokens) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!/^instance-.*\.json$/.test(n)) continue;
    const f = path.join(dir, n);
    try {
      if (tokens.has(JSON.parse(fs.readFileSync(f, 'utf8')).token)) fs.unlinkSync(f);
    } catch { /* unreadable or foreign shape — not ours to delete */ }
  }
}

// Retiring a chain also retires its satellites. An instance file carrying a
// retired chain's token would keep blocking that session's writes forever, and a
// leftover dashboard keeps being served as live. The rename happens FIRST and
// unconditionally: a chain we cannot parse still gets retired.
function retireChain(file) {
  const loaded = loadChain(file);
  const done = file.replace(/\.json$/, '.done.json');
  fs.renameSync(file, done);
  const chain = loaded.ok ? loaded.chain : null;
  if (!chain || !chain.baton) return done;
  const tokens = new Set([chain.baton.holder_token,
    ...(chain.history || []).map((h) => h && h.token)].filter(Boolean));
  const dir = path.dirname(file);
  for (const d of new Set([dir, dirs.legacyRelayDir()])) unlinkInstances(d, tokens);
  try { fs.unlinkSync(path.join(dir, `dash-${chain.chain_id}.html`)); }
  catch { /* no dashboard rendered for this chain */ }
  return done;
}

module.exports = { RELAY_DIR, BATON_STATES, TASK_STATES, chainPath,
  defaultChainDirs, uniqueChainId, createChainFileExclusive,
  createChain, validateChain, writeChain, loadChain, resolveNewestChain,
  offerBaton, claimBaton, expireOffer, addTask, markDone, markVerified,
  openTasks, isComplete, isReleasedToken, claimVerified, retireChain,
  // Chain-home helpers, re-exported so callers need one require (T11-T14).
  relayDir: dirs.relayDir, findRelayDir: dirs.findRelayDir,
  allChainDirs: dirs.allChainDirs, relayDirs: dirs.relayDirs,
  readInstanceToken: dirs.readInstanceToken, legacyRelayDir: dirs.legacyRelayDir,
  // Operator config + schema-2 state helpers, likewise re-exported (T11).
  ...state };
