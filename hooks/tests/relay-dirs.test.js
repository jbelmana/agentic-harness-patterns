'use strict';
// relay-dirs.test.js — where relay state lives on disk (hooks/lib/relay-dirs.js).
// Every test pins its roots/legacy dir at a tmp fixture via
// CLAUDE_RELAY_TRUSTED_ROOTS: this suite must never read or write the real
// ~/.claude/relay or any real checkout.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const rd = require('../lib/relay-dirs.js');
const rc = require('../lib/relay-chain.js');

// realpath: macOS tmpdir sits behind the /var -> /private/var symlink, and
// findRelayDir walks resolved parents.
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-dirs-')));
const mkdir = (...p) => { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; };

test('relayDir names <repoRoot>/.relay', () => {
  assert.strictEqual(rd.relayDir('/r'), path.join('/r', '.relay'));
  assert.strictEqual(rd.relayDir('/r/sub'), path.join('/r', 'sub', '.relay'));
});

test('findRelayDir walks up to the nearest .relay, else falls back to the legacy dir', (t) => {
  const repo = tmp();
  const legacy = tmp();
  t.after(() => {
    delete process.env.RELAY_DIR_OVERRIDE;
    for (const d of [repo, legacy]) fs.rmSync(d, { recursive: true, force: true });
  });
  process.env.RELAY_DIR_OVERRIDE = legacy;
  const deep = mkdir(repo, 'sub', 'dir');
  assert.strictEqual(rd.findRelayDir(deep), legacy);        // nothing up the tree yet
  const home = mkdir(repo, '.relay');
  assert.strictEqual(rd.findRelayDir(deep), home);          // found from a nested cwd
  assert.strictEqual(rd.findRelayDir(repo), home);          // and from the repo root itself
  // A FILE named .relay is not a chain home — keep walking, then fall back.
  const other = tmp();
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.writeFileSync(path.join(other, '.relay'), 'not a dir');
  assert.strictEqual(rd.findRelayDir(other), legacy);
});

test('relayDirs returns the repo-local home AND the legacy dir, deduplicated', (t) => {
  const repo = tmp();
  const legacy = tmp();
  t.after(() => {
    delete process.env.RELAY_DIR_OVERRIDE;
    for (const d of [repo, legacy]) fs.rmSync(d, { recursive: true, force: true });
  });
  process.env.RELAY_DIR_OVERRIDE = legacy;
  const home = mkdir(repo, '.relay');
  // Both, in priority order — a released predecessor's instance file may sit in
  // the legacy dir while the repo already carries its own .relay.
  assert.deepStrictEqual(rd.relayDirs(repo), [home, legacy]);
  // When the repo has no .relay the fallback IS the legacy dir: one entry, not two.
  const bare = tmp();
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  assert.deepStrictEqual(rd.relayDirs(bare), [legacy]);
});

test('readInstanceToken finds the instance file in either dir and tolerates junk', (t) => {
  const a = tmp(); const b = tmp();
  t.after(() => { for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(b, 'instance-42.json'), JSON.stringify({ token: 'tok-b' }));
  assert.strictEqual(rd.readInstanceToken([a, b], 42), 'tok-b');   // second dir wins when first is empty
  fs.writeFileSync(path.join(a, 'instance-42.json'), JSON.stringify({ token: 'tok-a' }));
  assert.strictEqual(rd.readInstanceToken([a, b], 42), 'tok-a');   // first dir has priority
  fs.writeFileSync(path.join(a, 'instance-43.json'), '{not json');
  assert.strictEqual(rd.readInstanceToken([a, b], 43), null);      // corrupt: no token, no throw
  assert.strictEqual(rd.readInstanceToken([a, b], 99), null);      // absent everywhere
});

test('allChainDirs lists existing .relay dirs at depth 1 and 2 under each root only', (t) => {
  const a = tmp(); const b = tmp();
  t.after(() => {
    delete process.env.CLAUDE_RELAY_TRUSTED_ROOTS;
    for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true });
  });
  const depth1 = mkdir(a, 'repo', '.relay');
  const depth2 = mkdir(a, 'container', 'repo', '.relay');
  mkdir(a, 'too', 'deep', 'down', '.relay');   // depth 3 — out of range
  const other = mkdir(b, 'proj', '.relay');
  mkdir(b, 'plain');                           // no .relay of its own
  process.env.CLAUDE_RELAY_TRUSTED_ROOTS = `${a}:${b}`;
  assert.deepStrictEqual(rd.allChainDirs().sort(), [depth1, depth2, other].sort());
  // A missing root is skipped, not fatal.
  process.env.CLAUDE_RELAY_TRUSTED_ROOTS = `${path.join(a, 'nope')}:${b}`;
  assert.deepStrictEqual(rd.allChainDirs(), [other]);
});

// T11-T14 call these through relay-chain.js; the re-export is part of the contract.
test('relay-chain re-exports the directory helpers under their exact names', () => {
  for (const name of ['relayDir', 'findRelayDir', 'allChainDirs', 'relayDirs',
    'readInstanceToken', 'legacyRelayDir']) {
    assert.strictEqual(typeof rc[name], 'function', `relay-chain must re-export ${name}`);
  }
  assert.strictEqual(rc.relayDir('/r'), rd.relayDir('/r'));
});
