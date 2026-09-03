'use strict';
// relay-chain-io.test.js — the on-disk half of relay-chain.js: writing, reading,
// resolving, and retiring chain files. Split from relay-chain.test.js (which
// keeps the pure ledger transitions) when the chain-home work pushed that file
// past the 200-LOC rule.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const rc = require('../lib/relay-chain.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relay-chain-io-'));
const mkChain = (over = {}) => rc.createChain(Object.assign({
  chainId: 'a', repoRoot: '/r', spawnPolicy: 'shared', mode: 'autonomous',
  holderToken: 't0', handoffDoc: '', now: 't0' }, over));

test('writeChain is atomic and loadChain round-trips', (t) => {
  const d = tmp();
  const realRename = fs.renameSync;
  t.after(() => { fs.renameSync = realRename; });
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const f = path.join(d, 'chain-a.json');
  const c = mkChain({ spawnPolicy: 'worktree' });
  const renames = [];
  fs.renameSync = (src, dest) => { renames.push([src, dest]); return realRename(src, dest); };
  rc.writeChain(f, c);
  fs.renameSync = realRename;
  assert.strictEqual(renames.length, 1);
  assert.match(path.basename(renames[0][0]), /\.tmp-\d+$/);
  assert.strictEqual(path.dirname(renames[0][0]), path.dirname(f));
  assert.strictEqual(renames[0][1], f);
  const back = rc.loadChain(f);
  assert.strictEqual(back.ok, true);
  assert.deepStrictEqual(back.chain, c);
});

test('loadChain classifies missing vs corrupt', (t) => {
  const d = tmp();
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  assert.strictEqual(rc.loadChain(path.join(d, 'nope.json')).ok, false);
  const f = path.join(d, 'chain-b.json');
  fs.writeFileSync(f, '{not json');
  const r = rc.loadChain(f);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /parse/i);
});

test('resolveNewestChain returns newest active, ignores retired', (t) => {
  const d = tmp();
  const empty = tmp();
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const mk = (name, ts) => { const f = path.join(d, name);
    fs.writeFileSync(f, '{}'); fs.utimesSync(f, ts, ts); return f; };
  mk('chain-old.json', 1000);
  const newest = mk('chain-new.json', 2000);
  mk('chain-done.done.json', 3000);
  assert.strictEqual(rc.resolveNewestChain(d), newest);
  assert.strictEqual(rc.resolveNewestChain(empty), null);
});

test('resolveNewestChain skips entries that vanish between readdir and stat', (t) => {
  const d = tmp();
  const realStat = fs.statSync;
  t.after(() => { fs.statSync = realStat; });
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const mk = (name, ts) => { const f = path.join(d, name);
    fs.writeFileSync(f, '{}'); fs.utimesSync(f, ts, ts); return f; };
  const ghost = mk('chain-ghost.json', 3000);
  const survivor = mk('chain-live.json', 1000);
  fs.statSync = (p, ...rest) => {
    if (p === ghost) { const e = new Error('ENOENT: vanished'); e.code = 'ENOENT'; throw e; }
    return realStat(p, ...rest);
  };
  assert.strictEqual(rc.resolveNewestChain(d), survivor);
  fs.statSync = realStat;
});

// Chains live repo-local (<repo_root>/.relay) or in the legacy RELAY_DIR — one
// namespace: the newest mtime must win ACROSS the dirs, not per-dir.
test('resolveNewestChain scans a dir list and the newest chain wins across dirs', (t) => {
  const d1 = tmp(); const d2 = tmp();
  t.after(() => { for (const d of [d1, d2]) fs.rmSync(d, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(d1, 'chain-old.json'), '{}');
  fs.writeFileSync(path.join(d2, 'chain-new.json'), '{}');
  const past = Date.now() / 1000 - 3600;
  fs.utimesSync(path.join(d1, 'chain-old.json'), past, past);
  assert.strictEqual(rc.resolveNewestChain([d1, d2]), path.join(d2, 'chain-new.json'));
  // string arg keeps working (back-compat with single-dir callers)
  assert.strictEqual(rc.resolveNewestChain(d1), path.join(d1, 'chain-old.json'));
  // a missing dir in the list is skipped, not fatal
  assert.strictEqual(rc.resolveNewestChain([path.join(d1, 'nope'), d2]),
    path.join(d2, 'chain-new.json'));
});

test('createChainFileExclusive refuses to clobber an existing chain file', (t) => {
  const d = tmp();
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const f = path.join(d, 'chain-x.json');
  const c = mkChain({ chainId: 'x' });
  assert.strictEqual(rc.createChainFileExclusive(f, c).ok, true);
  const again = rc.createChainFileExclusive(f, c);
  assert.strictEqual(again.ok, false);
  assert.match(again.error, /exists/);
  // the original content survived the refused second create
  assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).chain_id, 'x');
});

test('claimVerified writes then re-reads and confirms the holder', (t) => {
  const d = tmp(); const f = path.join(d, 'chain-g.json');
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  rc.writeChain(f, rc.offerBaton(mkChain({ chainId: 'g' }), { now: 't1' }));
  const r = rc.claimVerified(f, { token: 't1', gen: 1, now: 't2' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(rc.loadChain(f).chain.baton.holder_token, 't1');
});

test('claimVerified surfaces a write failure as an error and never throws', (t) => {
  const d = tmp(); const f = path.join(d, 'chain-w.json');
  const realRename = fs.renameSync;
  t.after(() => { fs.renameSync = realRename; fs.rmSync(d, { recursive: true, force: true }); });
  rc.writeChain(f, rc.offerBaton(mkChain({ chainId: 'w' }), { now: 't1' }));
  fs.renameSync = () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; };
  const r = rc.claimVerified(f, { token: 't1', gen: 1, now: 't2' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /write/);
});

test('retireChain renames to .done.json', (t) => {
  const d = tmp(); const f = path.join(d, 'chain-h.json');
  // retireChain sweeps instance files out of BOTH the chain dir and
  // legacyRelayDir(). Unpinned that second dir is the operator's real
  // ~/.claude/relay: a shape change upstream of the `!chain.baton` early return
  // would have this test readdir — and unlink inside — live relay state.
  // RELAY_DIR_OVERRIDE points the legacy arm at the fixture instead.
  process.env.RELAY_DIR_OVERRIDE = d;
  t.after(() => {
    delete process.env.RELAY_DIR_OVERRIDE;
    fs.rmSync(d, { recursive: true, force: true });
  });
  fs.writeFileSync(f, '{}');
  const done = rc.retireChain(f);
  assert.strictEqual(done, f.replace(/\.json$/, '.done.json'));
  assert.strictEqual(fs.existsSync(done), true);
  assert.strictEqual(fs.existsSync(f), false);
});

// ── Task 10: chain home, cap config, retire cleanup ────────────────────────

// A chain ledger is per-machine runtime state. Writing the ignore alongside the
// FIRST chain means no repo can accidentally commit one, without every repo
// having to land a .gitignore edit first (chains moved into the repo to stay
// inside a sandboxed successor's write allowlist).
test('createChainFileExclusive seeds .gitignore="*" in a fresh chain home, never clobbering one', (t) => {
  const d = tmp();
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const home = rc.relayDir(d);
  const c = mkChain({ chainId: 'gi', repoRoot: d });
  assert.strictEqual(rc.createChainFileExclusive(rc.chainPath('gi', home), c).ok, true);
  assert.strictEqual(fs.readFileSync(path.join(home, '.gitignore'), 'utf8'), '*\n');
  fs.writeFileSync(path.join(home, '.gitignore'), '# operator-owned\n*\n');
  assert.strictEqual(rc.createChainFileExclusive(rc.chainPath('gi2', home), c).ok, true);
  assert.strictEqual(fs.readFileSync(path.join(home, '.gitignore'), 'utf8'),
    '# operator-owned\n*\n');
});

// The cap bounds the relay loop, so its default belongs in config, not in a
// literal. A missing, unreadable, or malformed config must never throw — the
// built-in default stands.
test('createChain cap defaults to 3 and honours CLAUDE_RELAY_CONFIG', (t) => {
  const d = tmp();
  t.after(() => {
    delete process.env.CLAUDE_RELAY_CONFIG;
    fs.rmSync(d, { recursive: true, force: true });
  });
  const cfg = path.join(d, 'relay.config.json');
  process.env.CLAUDE_RELAY_CONFIG = path.join(d, 'absent.json');
  assert.strictEqual(mkChain().generation.cap, 3);
  process.env.CLAUDE_RELAY_CONFIG = cfg;
  fs.writeFileSync(cfg, JSON.stringify({ generationCap: 2 }));
  assert.strictEqual(mkChain().generation.cap, 2);
  fs.writeFileSync(cfg, '{not json');
  assert.strictEqual(mkChain().generation.cap, 3);
  fs.writeFileSync(cfg, JSON.stringify({ generationCap: 'lots' }));
  assert.strictEqual(mkChain().generation.cap, 3);
  assert.strictEqual(mkChain({ cap: 7 }).generation.cap, 7);   // explicit still wins
});

// Retiring a chain must not leave its satellites behind: an instance file
// carrying a retired chain's token would block that session's writes forever,
// and a stale dashboard would keep being served as live.
test('retireChain removes its own instance files (both dirs) and dashboard, sparing strangers', (t) => {
  const home = tmp(); const legacy = tmp();
  t.after(() => {
    delete process.env.RELAY_DIR_OVERRIDE;
    for (const d of [home, legacy]) fs.rmSync(d, { recursive: true, force: true });
  });
  process.env.RELAY_DIR_OVERRIDE = legacy;
  const f = path.join(home, 'chain-r.json');
  const c = mkChain({ chainId: 'r', holderToken: 'tok-1' });
  c.history = [{ gen: 0, token: 'tok-0', released: 't1' }];
  rc.writeChain(f, c);
  fs.writeFileSync(path.join(home, 'instance-1.json'), '{"token":"tok-1"}');   // holder, beside the chain
  fs.writeFileSync(path.join(legacy, 'instance-2.json'), '{"token":"tok-0"}'); // history, legacy dir
  fs.writeFileSync(path.join(home, 'instance-3.json'), '{"token":"tok-other"}');
  fs.writeFileSync(path.join(legacy, 'instance-4.json'), '{not json');
  fs.writeFileSync(path.join(home, 'dash-r.html'), '<p>x</p>');
  assert.strictEqual(fs.existsSync(rc.retireChain(f)), true);
  assert.strictEqual(fs.existsSync(path.join(home, 'instance-1.json')), false);
  assert.strictEqual(fs.existsSync(path.join(legacy, 'instance-2.json')), false);
  assert.strictEqual(fs.existsSync(path.join(home, 'instance-3.json')), true);
  assert.strictEqual(fs.existsSync(path.join(legacy, 'instance-4.json')), true);
  assert.strictEqual(fs.existsSync(path.join(home, 'dash-r.html')), false);
});

test('retireChain still renames when the chain carries no history and no dashboard', (t) => {
  const d = tmp();
  t.after(() => {
    delete process.env.RELAY_DIR_OVERRIDE;
    fs.rmSync(d, { recursive: true, force: true });
  });
  process.env.RELAY_DIR_OVERRIDE = d;
  const f = path.join(d, 'chain-nohist.json');
  fs.writeFileSync(f, JSON.stringify({ chain_id: 'nohist', baton: { holder_token: 'tok-h' } }));
  fs.writeFileSync(path.join(d, 'instance-9.json'), '{"token":"tok-h"}');
  assert.strictEqual(rc.retireChain(f), f.replace(/\.json$/, '.done.json'));
  assert.strictEqual(fs.existsSync(path.join(d, 'instance-9.json')), false);
});
