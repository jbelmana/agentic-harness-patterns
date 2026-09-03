'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
// Fixtures live in tests/lib/ (sibling of the ballot suite's server-harness.mjs):
// this file sits at the 200-LOC ceiling, and the harness is shared, not per-test.
const { ACK, tmp, fakeHome, trustedRoot, trustedDir, CHAIN, run, runHome } =
  require('./lib/spawn-harness.js');

test('dry-run in trusted cwd exits 0 and prints TOKEN + env exports', () => {
  const home = fakeHome();
  try {
    const d = trustedDir(home);
    const h = path.join(d, 'HO.md'); fs.writeFileSync(h, 'x');
    const c = path.join(d, 'chain-t.json'); fs.writeFileSync(c, CHAIN({ repo_root: d }));
    const r = runHome(home, [h, '1', c, '--dry-run'], d);
    assert.equal(r.code, 0);
    assert.match(r.out, /TOKEN=[0-9a-fA-F-]{36}/);
    assert.match(r.out, /CLAUDE_RELAY_CHAIN=/);
    assert.match(r.out, /CLAUDE_RELAY_GENERATION=1/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('missing chain file exits 6; cap reached exits 64', () => {
  const home = fakeHome();
  try {
    const d = trustedDir(home);
    const h = path.join(d, 'HO.md'); fs.writeFileSync(h, 'x');
    assert.equal(runHome(home, [h, '1', path.join(d, 'nope.json'), '--dry-run'], d).code, 6);
    const c = path.join(d, 'chain-t.json');
    fs.writeFileSync(c, CHAIN({ repo_root: d, generation: { current: 4, cap: 5 } }));
    assert.equal(runHome(home, [h, '5', c, '--dry-run'], d).code, 64);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// An EMPTY segment in CLAUDE_RELAY_TRUSTED_ROOTS used to disable the gate
// outright: `read -a` keeps ":/nope" as ["", "/nope"], and an empty root reaches
// `case "$candidate/" in "$root"/*)` as the pattern `/*` — which matches EVERY
// absolute path. One stray colon turned the allowlist into "everything", and what
// it guards is the launch directory of a --dangerously-skip-permissions session.
//
// The chain is placed in $HOME/.claude/relay, which the CHAIN gate trusts on its
// own separate arm, so ONLY the cwd + handoff gates decide the outcome. Putting
// the chain in the untrusted dir instead lets the chain-location gate refuse
// first and the test passes for the wrong reason — that is exactly how the leak
// hid. The trusted-cwd leg is not decoration either: a gate that refused
// everything would satisfy the negative legs alone.
test('empty segments in CLAUDE_RELAY_TRUSTED_ROOTS never widen the trust gate', () => {
  const home = fakeHome();
  const d = tmp(); // os.tmpdir -> under NO trusted root
  const R = trustedRoot(home);
  try {
    const h = path.join(d, 'HO.md'); fs.writeFileSync(h, 'x');
    const c = path.join(home, '.claude', 'relay', 'chain-t.json');
    fs.writeFileSync(c, CHAIN());
    const at = (cwd, ho, roots) => runHome(home, [ho, '1', c, '--dry-run'], cwd,
      { CLAUDE_RELAY_TRUSTED_ROOTS: roots }).code;
    for (const roots of [':/nope', `:${R}`, ':', '/nope::'])
      assert.equal(at(d, h, roots), 2, `untrusted cwd accepted with roots=${roots}`);
    const ok = trustedDir(home);
    fs.writeFileSync(path.join(ok, 'HO.md'), 'x');
    assert.equal(at(ok, path.join(ok, 'HO.md'), `:${R}:`), 0,
      'dropping empty segments must not drop the real root beside them');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('untrusted cwd still exits 2 (v1 rail intact)', () => {
  const home = fakeHome();
  const d = tmp(); // os.tmpdir is outside TRUSTED_ROOTS
  try {
    const h = path.join(d, 'HO.md'); fs.writeFileSync(h, 'x');
    const c = path.join(d, 'chain-t.json'); fs.writeFileSync(c, CHAIN());
    assert.equal(runHome(home, [h, '1', c, '--dry-run'], d).code, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('await-ack: exits 0 on claim, 1 + revert on timeout', () => {
  const d = tmp();
  const c = path.join(d, 'chain-t.json');
  fs.writeFileSync(c, CHAIN({ baton: { holder_token: 'tok-1', state: 'held',
    offered_at: null, claimed_at: 't' } }));
  assert.equal(run(ACK, [c, 'tok-0', '1'], d).code, 0);      // already claimed
  fs.writeFileSync(c, CHAIN());                               // stale offer
  const r = run(ACK, [c, 'tok-0', '1'], d);                   // 1s timeout
  assert.equal(r.code, 1);
  const after = JSON.parse(fs.readFileSync(c, 'utf8'));
  assert.equal(after.baton.state, 'held');
  assert.match(after.alerts[0].msg, /ack timeout/);
});

// A logged incident: the ack ran 5m30+ past its 300s window while its alert
// claimed "ack timeout after 0s". The loop is now bounded by a wall-clock
// deadline computed once, and the alert names the REAL window.
test('await-ack: deadline is wall-clock and the alert names the real timeout', () => {
  const d = tmp();
  const c = path.join(d, 'chain-t.json');
  fs.writeFileSync(c, CHAIN());                               // standing offer
  const started = Date.now();
  const r = run(ACK, [c, 'tok-0', '2'], d);
  const elapsed = (Date.now() - started) / 1000;
  assert.equal(r.code, 1);
  assert.ok(elapsed < 15, `poll must end near its 2s window, took ${elapsed}s`);
  const after = JSON.parse(fs.readFileSync(c, 'utf8'));
  assert.equal(after.baton.state, 'held');
  assert.match(after.alerts[0].msg, /ack timeout after 2s/);  // honest window, not "0s"
});

// A logged incident: the chain gate refused the relay library's OWN default
// chain home (~/.claude/relay), so /relay chain-create could never spawn as
// documented. The CHAIN gate — and only the chain gate — now also trusts
// $HOME/.claude/relay.
test('chain under $HOME/.claude/relay passes the chain gate (dry-run exits 0)', () => {
  const home = fakeHome();
  try {
    const d = trustedDir(home);
    const h = path.join(d, 'HO.md'); fs.writeFileSync(h, 'x');
    const c = path.join(home, '.claude', 'relay', 'chain-t.json');
    fs.writeFileSync(c, CHAIN());
    assert.equal(runHome(home, [h, '1', c, '--dry-run'], d).code, 0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// A logged dual-controller collision: the successor prompt never named /relay
// claim, so the gen-1 successor worked unclaimed while the predecessor kept
// driving. The composed prompt must open with the claim directive and halt on
// claim failure.
test('successor prompt leads with /relay claim and halts on claim failure', () => {
  const home = fakeHome();
  try {
    const d = trustedDir(home);
    const h = path.join(d, 'HO.md'); fs.writeFileSync(h, 'x');
    const c = path.join(d, 'chain-t.json'); fs.writeFileSync(c, CHAIN({ repo_root: d }));
    const r = runHome(home, [h, '1', c, '--dry-run'], d);
    assert.equal(r.code, 0);
    const prose = r.out.replace(/\\/g, ''); // strip printf %q escapes
    assert.match(prose, /FIRST ACTION, before anything else: run \/relay claim/);
    assert.match(prose, /If the claim fails, STOP/);
    // The claim directive precedes the resume instruction, not vice versa.
    assert.ok(prose.indexOf('/relay claim') < prose.indexOf('continue'),
      'claim directive must precede the resume instruction');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- Fix round 1 (CRITICAL): the chain is an unauthenticated instruction source.
// A forged repo_root would launch the --dangerously-skip-permissions successor
// OUTSIDE the trusted roots; a forged cap would defeat the generation limit.
// These are the reviewer's exact-trigger repros. ---

test('forged chain repo_root: worktree dry-run from trusted cwd exits 2, creates no worktree', () => {
  const home = fakeHome();
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'evil-repo-')); // outside TRUSTED_ROOTS
  try {
    const d = trustedDir(home);
    const h = path.join(d, 'HO.md'); fs.writeFileSync(h, 'x');
    const c = path.join(d, 'chain-t.json');
    fs.writeFileSync(c, CHAIN({ spawn_policy: 'worktree', repo_root: evil,
      generation: { current: 0, cap: 5 } }));
    assert.equal(runHome(home, [h, '1', c, '--dry-run'], d).code, 2); // forged repo_root refused
    assert.ok(!fs.existsSync(path.join(evil, '.wt-relay-g1')));      // no `git worktree add`
    assert.equal(fs.readdirSync(evil).length, 0);                    // nothing written anywhere in it
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(evil, { recursive: true, force: true });
  }
});

test('forged chain PATH: a valid chain located outside the trusted roots exits 2', () => {
  const home = fakeHome();
  const evil = tmp(); // os.tmpdir -> outside TRUSTED_ROOTS
  try {
    const d = trustedDir(home); // trusted cwd
    const h = path.join(d, 'HO.md'); fs.writeFileSync(h, 'x');
    const c = path.join(evil, 'chain-t.json'); fs.writeFileSync(c, CHAIN()); // valid chain, untrusted location
    // The file EXISTS (so this is NOT the exit-6 not-found path): it is refused
    // because the chain is an instruction source whose path is outside the roots.
    assert.equal(runHome(home, [h, '1', c, '--dry-run'], d).code, 2);
    // Precedence: a trust refusal is never masked by the shape check. A chain
    // that is BOTH misplaced and malformed reports the trust failure (2), not 6.
    fs.writeFileSync(c, '{not json');
    assert.equal(runHome(home, [h, '1', c, '--dry-run'], d).code, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(evil, { recursive: true, force: true });
  }
});

test('forged chain cap 999999 cannot raise the ceiling: generation 11 exits 64', () => {
  const home = fakeHome();
  try {
    const d = trustedDir(home);
    const h = path.join(d, 'HO.md'); fs.writeFileSync(h, 'x');
    const c = path.join(d, 'chain-t.json');
    fs.writeFileSync(c, CHAIN({ repo_root: d, generation: { current: 11, cap: 999999 } }));
    // cap clamps 999999 -> HARD_MAX_GENERATION (10); 11 is NOT < 10 -> cap reached.
    assert.equal(runHome(home, [h, '11', c, '--dry-run'], d).code, 64);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// Task 10: the chain is an unauthenticated instruction source, so "anywhere under
// a trusted root" was too wide a home. A chain has exactly two accepted
// locations now: its OWN resolved repo_root (which must itself be trusted) and
// the legacy $HOME/.claude/relay. Otherwise a chain planted in one repo could
// hand a permission-free successor a ledger nobody in the launch repo wrote.
test('chain under a trusted root but outside its own repo_root exits 2', () => {
  const home = fakeHome();
  try {
    const d = trustedDir(home);        // cwd + the misplaced chain live here
    const owner = trustedDir(home);    // ...but the chain names THIS repo_root
    const h = path.join(d, 'HO.md'); fs.writeFileSync(h, 'x');
    const stray = path.join(d, 'chain-t.json');
    fs.writeFileSync(stray, CHAIN({ repo_root: owner }));
    assert.equal(runHome(home, [h, '1', stray, '--dry-run'], d).code, 2);
    // The same chain in its repo's own .relay/ — the v2.1 home — is accepted.
    const relay = path.join(owner, '.relay'); fs.mkdirSync(relay);
    const proper = path.join(relay, 'chain-t.json');
    fs.writeFileSync(proper, CHAIN({ repo_root: owner }));
    assert.equal(runHome(home, [h, '1', proper, '--dry-run'], d).code, 0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('cap clamp does not break a legit low generation: worktree dry-run, generation 0 exits 0', () => {
  const home = fakeHome();
  try {
    const d = trustedDir(home);
    const h = path.join(d, 'HO.md'); fs.writeFileSync(h, 'x');
    const c = path.join(d, 'chain-t.json');
    // Trusted repo_root + worktree policy: exercises the repo_root gate's PASS path
    // AND A3 resolving an as-yet-uncreated dry-run worktree. cap 999999 clamps to 10.
    fs.writeFileSync(c, CHAIN({ spawn_policy: 'worktree', repo_root: d,
      generation: { current: 0, cap: 999999 } }));
    assert.equal(runHome(home, [h, '0', c, '--dry-run'], d).code, 0); // 0 < 10 -> proceeds
    assert.ok(!fs.existsSync(path.join(d, '.wt-relay-g0')));         // dry-run stays pure
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('await-ack: non-integer timeout exits 64 without reverting the baton', () => {
  const d = tmp();
  const c = path.join(d, 'chain-t.json');
  fs.writeFileSync(c, CHAIN());                                       // baton.state === 'offered'
  assert.equal(run(ACK, [c, 'tok-0', 'abc'], d).code, 64);           // usage error, not a timeout
  assert.equal(JSON.parse(fs.readFileSync(c, 'utf8')).baton.state, 'offered'); // NOT reverted
});
