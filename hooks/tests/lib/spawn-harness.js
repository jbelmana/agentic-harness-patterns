'use strict';
// spawn-harness.js — fixtures for the relay-spawn.sh / relay-await-ack.sh suite.
// Extracted from relay-spawn.test.js when that file reached the 200-LOC ceiling;
// sibling of skills/ballot/tests/lib/server-harness.mjs, same idea. Lives under
// tests/lib/ rather than tests/ so the `*.test.js` glob never runs it as a suite.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..', '..', '..');
const SPAWN = path.join(ROOT, 'scripts', 'relay-spawn.sh');
const ACK = path.join(ROOT, 'scripts', 'relay-await-ack.sh');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spawn2-'));

// Hermetic HOME: the trust gate reads CLAUDE_RELAY_TRUSTED_ROOTS, and earlier
// tests mkdtemp'd inside a real checkout under the operator's own layout —
// absent on CI runners, so every trust-gate test died on ENOENT before
// asserting anything. Each spawn test now builds a throwaway $HOME with a
// Projects/ and .claude/relay, and passes BOTH $HOME and the trusted root
// explicitly, so no test depends on where the machine keeps its repos.
// The gates under test are IDENTICAL — only the fixture location moved.
function fakeHome() {
  // realpathSync: macOS tmpdir sits behind the /var -> /private/var symlink; the
  // script trust-gates `pwd -P` (physical) paths, so $HOME must be physical too.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spawn2home-')));
  fs.mkdirSync(path.join(home, 'Projects'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'relay'), { recursive: true });
  return home;
}
const trustedRoot = (home) => path.join(home, 'Projects');
const trustedDir = (home) =>
  fs.mkdtempSync(path.join(trustedRoot(home), '.tmp-spawn2-'));

const CHAIN = (over = {}) => JSON.stringify(Object.assign({
  chain_id: 't', repo_root: '', spawn_policy: 'shared', mode: 'autonomous',
  artifact_url: '', generation: { current: 0, cap: 5 },
  baton: { holder_token: 'tok-0', state: 'offered', offered_at: '2026-08-26T00:00:00Z', claimed_at: 't' },
  handoff_doc: '', tasks: [], history: [], alerts: [] }, over));

function run(cmd, args, cwd, env = {}) {
  try {
    const out = execFileSync('bash', [cmd, ...args], { cwd, encoding: 'utf8',
      env: { ...process.env, CLAUDE_RELAY_TERM: 'ghostty', ...env } });
    return { code: 0, out };
  } catch (e) { return { code: e.status, out: String(e.stdout), err: String(e.stderr) }; }
}
const runHome = (home, args, cwd, env = {}) =>
  run(SPAWN, args, cwd,
    { HOME: home, CLAUDE_RELAY_TRUSTED_ROOTS: trustedRoot(home), ...env });

module.exports = { ROOT, SPAWN, ACK, tmp, fakeHome, trustedRoot, trustedDir, CHAIN, run, runHome };
