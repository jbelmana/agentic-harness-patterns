'use strict';
// relay-dirs.js — the on-disk homes for relay state, and the identity file read
// from them. Split out of relay-chain.js, which sits at the 200-LOC ceiling.
//
// Chain HOME is <repo_root>/.relay: the one directory BOTH sides of a handover
// can write — the predecessor's cwd is the repo, and a shared-policy successor is
// launched there too, so its claim write lands inside its sandbox allowlist.
// Before that, chains lived in ~/.claude/relay or a sibling scratch dir, both
// outside that allowlist, and claimVerified failed with write:EPERM.
//
// ~/.claude/relay stays the LEGACY home and is never demoted to a fallback:
// instance files written before the move still live there, so a released
// predecessor whose identity sits in the legacy dir must stay blocked even once
// its repo has grown a .relay/. Every lookup therefore reads BOTH.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const homeRelay = () => path.join(os.homedir(), '.claude', 'relay');

// Module-load constant: the legacy dir as the rest of the library has always
// seen it. Kept for the callers (and tests) that treat it as a fixed path.
const RELAY_DIR = process.env.CLAUDE_RELAY_DIR || homeRelay();

// Call-time read of the same location. RELAY_DIR_OVERRIDE lets an in-process
// test repoint the legacy dir without spawning a child, which the module-load
// constant cannot do.
const legacyRelayDir = () => process.env.RELAY_DIR_OVERRIDE
  || process.env.CLAUDE_RELAY_DIR || homeRelay();

// The chain home for a known repo root. T11-T14 call this by name.
const relayDir = (repoRoot) => path.join(repoRoot, '.relay');

// The chain home for an UNKNOWN repo root: walk up from startCwd to the nearest
// existing .relay/ so a hook fired deep inside a repo still finds it. Falls back
// to the legacy dir, so the result is always a usable path.
function findRelayDir(startCwd = process.cwd()) {
  let dir = path.resolve(startCwd);
  for (;;) {
    const candidate = path.join(dir, '.relay');
    try { if (fs.statSync(candidate).isDirectory()) return candidate; }
    catch { /* absent here — keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) return legacyRelayDir();
    dir = parent;
  }
}

// Both homes, in priority order, deduplicated — the scan set for chains AND for
// instance files. One entry when the repo-local home resolved to the legacy dir.
const relayDirs = (startCwd) => [...new Set([findRelayDir(startCwd), legacyRelayDir()])];

// The relay token this CLI process was issued, from the first dir that has its
// instance file. A missing or corrupt file is not an error: the caller treats a
// null token as "stranger", and a guard must never brick a session.
function readInstanceToken(dirs, cliPid) {
  for (const dir of dirs) {
    try {
      const token = JSON.parse(fs.readFileSync(
        path.join(dir, `instance-${cliPid}.json`), 'utf8')).token;
      if (token) return token;
    } catch { /* not in this dir — try the next */ }
  }
  return null;
}

// Roots scanned for repo-local chain homes. Set CLAUDE_RELAY_TRUSTED_ROOTS
// (colon-separated) to match wherever this operator keeps repos — the same
// variable the spawner's trust gate reads, so the two can never disagree. Tests
// set it so they never glob a real checkout.
const chainRoots = () => (process.env.CLAUDE_RELAY_TRUSTED_ROOTS
  ? process.env.CLAUDE_RELAY_TRUSTED_ROOTS.split(':').filter(Boolean)
  : [path.join(os.homedir(), 'Projects')]);

const subdirs = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => path.join(dir, e.name));
  } catch { return []; }
};

// Every repo-local chain home on this machine: depth 1 (<root>/<repo>/.relay) and
// depth 2 (<root>/<container>/<repo>/.relay — some repos sit one level deeper,
// inside a container directory). Deeper than that is not a repo layout we spawn
// from, so the walk stops there rather than becoming a whole-disk crawl.
function allChainDirs() {
  const found = [];
  const push = (p) => {
    try { if (fs.statSync(p).isDirectory()) found.push(p); } catch { /* absent */ }
  };
  for (const root of chainRoots()) {
    for (const level1 of subdirs(root)) {
      push(relayDir(level1));
      for (const level2 of subdirs(level1)) push(relayDir(level2));
    }
  }
  return [...new Set(found)];
}

module.exports = { RELAY_DIR, legacyRelayDir, relayDir, findRelayDir, relayDirs,
  readInstanceToken, allChainDirs };
