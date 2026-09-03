'use strict';
// relay-loop-driver.test.js — the Stop hook SHELL: identity resolution, the
// context-bridge read, the stdout protocol, verify-after-write, and the
// fail-open contract. The decision table itself is tested in relay-loop.test.js.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOOK = path.join(__dirname, '..', 'relay-loop-driver.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'loopdrv-'));
const NOW = '2026-08-27T00:00:00.000Z';
const task = (id, state = 'open') => ({ id, desc: `do ${id}`, acceptance: 'x', state, gen: 1 });

const chain = (over = {}) => JSON.stringify({
  chain_id: 'c', created: NOW, repo_root: '/r', spawn_policy: 'shared',
  mode: 'autonomous', artifact_url: '', schema: 2, model: 'claude-opus-5',
  paused: false, waiting: null, decisions: [],
  loop: { cap: 30, iterations: {}, relayNudges: 0 },
  generation: { current: 1, cap: 3 },
  baton: { holder_token: 'tok-1', state: 'held', offered_at: null, claimed_at: NOW },
  handoff_doc: '', tasks: [task('T1'), task('T2')], history: [], alerts: [], ...over });

// A bridge file whose remaining_percentage lands on the wanted displayed meter.
// 100 remaining -> 0% displayed (loop); 60 -> 48%; 25 -> 90% (both relay).
// `ts` is epoch SECONDS, as both statuslines write it; it defaults to now because
// the driver ignores a reading older than relay-context.js DEFAULTS.staleSeconds.
const bridge = (dir, remaining, ts = Math.floor(Date.now() / 1000)) => {
  const f = path.join(dir, 'ctx.json');
  fs.writeFileSync(f, JSON.stringify({ remaining_percentage: remaining, timestamp: ts }));
  return f;
};

// Ambient relay env is dropped before layering per-test env — a suite running
// inside a real relay successor would otherwise resolve that session's chain.
// CLAUDE_RELAY_CONFIG is pinned absent so the machine's real loopCap cannot leak in.
function run(dir, pid, payload, env = {}) {
  const base = { ...process.env };
  for (const k of ['CLAUDE_RELAY_TOKEN', 'CLAUDE_RELAY_CHAIN', 'CLAUDE_CTX_BRIDGE_OVERRIDE']) delete base[k];
  let status = 0; let stdout = '';
  try {
    stdout = execFileSync('node', [HOOK], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8',
      env: { ...base, RELAY_DIR_OVERRIDE: dir, CLI_PID_OVERRIDE: String(pid),
        CLAUDE_RELAY_CONFIG: path.join(os.tmpdir(), 'relay-config-absent.json'), ...env },
    });
  } catch (e) { status = e.status; stdout = String(e.stdout); }
  return { status, stdout };
}

// The standard fixture: a chain held by tok-1, this session's instance file, and
// a bridge reading 0% displayed — i.e. the state that must block on row 9.
function fixture(over = {}, remaining = 100) {
  const d = tmp();
  const file = path.join(d, 'chain-c.json');
  fs.writeFileSync(file, chain(over));
  fs.writeFileSync(path.join(d, 'instance-4242.json'), JSON.stringify({ token: 'tok-1' }));
  return { d, file, ctxFile: bridge(d, remaining) };
}
const reload = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const reasonOf = (d, sid, env) =>
  JSON.parse(run(d, 4242, { session_id: sid, cwd: d }, env).stdout).reason;

test('block: prints exactly one decision JSON line, exit 0, counter incremented on disk', () => {
  const { d, file, ctxFile } = fixture();
  const r = run(d, 4242, { session_id: 's1', cwd: d, stop_hook_active: false },
    { CLAUDE_CTX_BRIDGE_OVERRIDE: ctxFile });
  assert.strictEqual(r.status, 0);
  const lines = r.stdout.trim().split('\n');
  assert.strictEqual(lines.length, 1);
  const out = JSON.parse(lines[0]);
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /^LOOP: chain c gen 1 — 2 open \(T1, T2\)/);
  assert.strictEqual(reload(file).loop.iterations['1'], 1);
});

test('stop_hook_active only appends the [resumed] suffix — the table is re-evaluated', () => {
  const { d, ctxFile } = fixture();
  const out = JSON.parse(run(d, 4242, { session_id: 's1', cwd: d, stop_hook_active: true },
    { CLAUDE_CTX_BRIDGE_OVERRIDE: ctxFile }).stdout);
  assert.match(out.reason, / \[resumed\]$/);
  assert.match(out.reason, /^LOOP: chain c/);
});

test('allow: paused chain prints nothing and leaves the counter alone', () => {
  const { d, file, ctxFile } = fixture({ paused: true });
  const r = run(d, 4242, { session_id: 's1', cwd: d }, { CLAUDE_CTX_BRIDGE_OVERRIDE: ctxFile });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.deepStrictEqual(reload(file).loop.iterations, {});
});

test('allow: a session with no relay identity is silent (strangers never see the loop)', () => {
  const { d, ctxFile } = fixture();
  const r = run(d, 9999, { session_id: 's1', cwd: d }, { CLAUDE_CTX_BRIDGE_OVERRIDE: ctxFile });
  assert.strictEqual(r.stdout, '');
});

test('allow: an instance token that holds no chain is silent', () => {
  const { d, ctxFile } = fixture({ baton: { holder_token: 'tok-other', state: 'held',
    offered_at: null, claimed_at: NOW } });
  assert.strictEqual(run(d, 4242, { session_id: 's1', cwd: d },
    { CLAUDE_CTX_BRIDGE_OVERRIDE: ctxFile }).stdout, '');
});

test('relay nudge: a bridge past 40% displayed blocks with chain-create, nudge persisted', () => {
  const { d, file, ctxFile } = fixture({}, 60);
  const out = JSON.parse(run(d, 4242, { session_id: 's1', cwd: d },
    { CLAUDE_CTX_BRIDGE_OVERRIDE: ctxFile }).stdout);
  assert.match(out.reason, /RELAY: offer the held chain via \/relay chain-create now/);
  const back = reload(file);
  assert.strictEqual(back.loop.relayNudges, 1);
  assert.deepStrictEqual(back.loop.iterations, {});
});

test('alerts on an allow row are persisted too (loop cap), still no stdout', () => {
  const { d, file, ctxFile } = fixture({ loop: { cap: 30, iterations: { 1: 30 }, relayNudges: 0 } });
  const r = run(d, 4242, { session_id: 's1', cwd: d }, { CLAUDE_CTX_BRIDGE_OVERRIDE: ctxFile });
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(reload(file).alerts[0].msg, 'loop cap reached, 2 open');
  // One-shot on disk: the cap state never changes on its own, so a second Stop
  // must not bury the only tell that the loop died under a copy of itself.
  // mtime, not just alerts.length: writeChain is idempotent on identical content,
  // so an unchanged alert count alone would not prove the file was left alone.
  const before = fs.statSync(file).mtimeMs;
  run(d, 4242, { session_id: 's1', cwd: d }, { CLAUDE_CTX_BRIDGE_OVERRIDE: ctxFile });
  assert.strictEqual(reload(file).alerts.length, 1);
  assert.strictEqual(fs.statSync(file).mtimeMs, before);
});

test('env identity: CLAUDE_RELAY_TOKEN/CHAIN block without any instance file', () => {
  const { d, file, ctxFile } = fixture();
  fs.unlinkSync(path.join(d, 'instance-4242.json'));
  const out = JSON.parse(run(d, 4242, { session_id: 's1', cwd: d },
    { CLAUDE_RELAY_TOKEN: 'tok-1', CLAUDE_RELAY_CHAIN: file,
      CLAUDE_CTX_BRIDGE_OVERRIDE: ctxFile }).stdout);
  assert.match(out.reason, /^LOOP: chain c/);
});

test('schema-1 chain: loops anyway, seeding loop on disk without promoting schema', () => {
  const one = JSON.parse(chain());
  for (const k of ['schema', 'model', 'paused', 'waiting', 'loop', 'decisions']) delete one[k];
  const d = tmp();
  const file = path.join(d, 'chain-c.json');
  fs.writeFileSync(file, JSON.stringify(one));
  fs.writeFileSync(path.join(d, 'instance-4242.json'), JSON.stringify({ token: 'tok-1' }));
  const out = JSON.parse(run(d, 4242, { session_id: 's1', cwd: d },
    { CLAUDE_CTX_BRIDGE_OVERRIDE: bridge(d, 100) }).stdout);
  assert.match(out.reason, /^LOOP: chain c/);
  const back = reload(file);
  assert.strictEqual(back.loop.iterations['1'], 1);
  assert.strictEqual('schema' in back, false);
});

// ── the context bridge, read the way the relay monitor hook reads it ──
test('no override: the bridge is found in the host tmpdir by session_id', () => {
  const { d, file } = fixture();
  const sid = `loopdrv-${process.pid}`;
  const real = path.join(os.tmpdir(), `claude-ctx-${sid}.json`);
  fs.writeFileSync(real, JSON.stringify({ remaining_percentage: 60,
    timestamp: Math.floor(Date.now() / 1000) }));
  try {
    const out = JSON.parse(run(d, 4242, { session_id: sid, cwd: d }).stdout);
    assert.match(out.reason, /RELAY: offer the held chain via \/relay chain-create now/);
    assert.strictEqual(reload(file).loop.relayNudges, 1);
  } finally { fs.unlinkSync(real); }
});

test('a missing, malformed, or traversal-shaped bridge reads as null and loops', () => {
  const { d, file } = fixture();
  assert.match(reasonOf(d, 'no-such-bridge'), /^LOOP: chain c/);
  assert.strictEqual(reload(file).loop.relayNudges, 0);
  const bad = path.join(d, 'bad-ctx.json');
  fs.writeFileSync(bad, '{nope');
  assert.match(reasonOf(d, 's1', { CLAUDE_CTX_BRIDGE_OVERRIDE: bad }), /^LOOP: chain c/);
  // A traversal-shaped session_id never builds a bridge path in the first place.
  assert.match(reasonOf(d, '../../etc/x'), /^LOOP: chain c/);
});

// session-relay-monitor ignores metrics older than staleSeconds (relay-context.js
// DEFAULTS) — the driver must too. A statusline that stopped writing leaves its
// last HIGH reading on disk forever; trusting it spends all three relay nudges and
// parks the chain in the cap row on a number from a session that already ended.
// Same reading, two timestamps: the pair proves the gate, not the arithmetic.
test('a stale bridge reads as unknown — the same 90% loops instead of nudging', () => {
  const { d, file, ctxFile } = fixture({}, 25);   // remaining 25 -> 90% displayed
  const env = { CLAUDE_CTX_BRIDGE_OVERRIDE: ctxFile };
  assert.match(reasonOf(d, 's1', env), /RELAY: offer the held chain via \/relay chain-create now/);
  fs.writeFileSync(file, chain());                // fresh ledger, nudges back at 0
  bridge(d, 25, 1);                               // same reading, epoch-1 timestamp
  assert.match(reasonOf(d, 's1', env), /^LOOP: chain c/);
  assert.strictEqual(reload(file).loop.relayNudges, 0);
});

// ── fail OPEN: a broken driver must never trap a session ─────────────────────
test('corrupt chain, absent dir, and malformed stdin all exit 0 with no stdout', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'chain-bad.json'), '{nope');
  fs.writeFileSync(path.join(d, 'instance-4242.json'), JSON.stringify({ token: 'tok-1' }));
  assert.deepStrictEqual(run(d, 4242, { session_id: 's1', cwd: d }), { status: 0, stdout: '' });

  const gone = path.join(tmp(), 'not-there');
  assert.deepStrictEqual(run(gone, 4242, { session_id: 's1', cwd: gone }), { status: 0, stdout: '' });

  const { d: d2 } = fixture();
  assert.deepStrictEqual(run(d2, 4242, 'not json at all'), { status: 0, stdout: '' });
  assert.deepStrictEqual(run(d2, 4242, ''), { status: 0, stdout: '' });
});

// The sibling libs load lazily inside the guarded decision, so a runtime hooks/lib
// that lags this repo cannot turn every turn-end into a MODULE_NOT_FOUND trace.
// The contract is silence — exit 0 AND an empty stderr, not merely exit 0.
test('a driver with no lib/ beside it fails OPEN — exit 0, no stdout, no stderr', () => {
  const solo = path.join(tmp(), 'relay-loop-driver.js');
  fs.copyFileSync(HOOK, solo);
  const r = spawnSync('node', [solo], { encoding: 'utf8', input: JSON.stringify(
    { session_id: 's1', cwd: path.dirname(solo) }) });
  assert.deepStrictEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr },
    { status: 0, stdout: '', stderr: '' });
});

test('a corrupt instance file is not an identity — silent, not fatal', () => {
  const { d, ctxFile } = fixture();
  fs.writeFileSync(path.join(d, 'instance-4242.json'), '{nope');
  assert.deepStrictEqual(run(d, 4242, { session_id: 's1', cwd: d },
    { CLAUDE_CTX_BRIDGE_OVERRIDE: ctxFile }), { status: 0, stdout: '' });
});

test('an unwritable chain file allows the turn to end rather than blocking on a stale count', () => {
  const { d, file, ctxFile } = fixture();
  fs.chmodSync(d, 0o500);                       // no write in the dir -> rename fails
  try {
    const r = run(d, 4242, { session_id: 's1', cwd: d }, { CLAUDE_CTX_BRIDGE_OVERRIDE: ctxFile });
    assert.deepStrictEqual(r, { status: 0, stdout: '' });
    assert.deepStrictEqual(reload(file).loop.iterations, {});
  } finally { fs.chmodSync(d, 0o700); }
});

// The Stop hook's own timeout is 10 s; a driver that hangs on a stdin that never
// closes would burn it every turn. Deliberately a real ~10 s wait — it is the only
// assertion that proves the guard fires.
test('stdin that never closes still exits 0 via the guard', { timeout: 20000 }, async () => {
  const { d } = fixture();
  const code = await new Promise((resolve) => {
    const child = spawn('node', [HOOK], { stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, RELAY_DIR_OVERRIDE: d, CLI_PID_OVERRIDE: '4242' } });
    child.on('exit', resolve);                  // stdin held open on purpose
  });
  assert.strictEqual(code, 0);
});
