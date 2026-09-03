#!/usr/bin/env node
'use strict';
// relay-loop-driver.js — Stop hook. This is what makes `mode: autonomous` real:
// while this session holds an autonomous chain's baton and tasks remain open, the
// turn is not allowed to end — the chain, not the human, supplies the next prompt.
// Spec: the relay v2 design note, §"Loop driver".
//
// The decision is pure and lives in lib/relay-loop.js; every byte of I/O is here.
// Protocol: block -> one line {"decision":"block","reason":"…"} on stdout, exit 0.
// Allow -> nothing on stdout, exit 0. ANY read/parse/write failure -> allow,
// silently: a broken driver must never trap a session in an unstoppable turn.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// The sibling libs are required LAZILY, from inside the try/catch that guards the
// whole decision. A runtime hooks/lib that lags this repo — an install that
// predates the sibling split has neither module — would otherwise throw
// MODULE_NOT_FOUND at LOAD time, where no catch of ours can reach, turning every
// single turn-end into a non-zero exit with a stderr trace instead of the spec's
// silent allow. Memoized: still one require per process.
let cached = null;
function lib() {
  if (cached) return cached;
  const chain = require('./lib/relay-chain.js');
  const ctx = require('./lib/relay-context.js');
  cached = { relayDirs: chain.relayDirs, readInstanceToken: chain.readInstanceToken,
    loadChain: chain.loadChain, writeChain: chain.writeChain,
    validateChain: chain.validateChain, configuredLoopCap: chain.configuredLoopCap,
    displayedUsedPct: ctx.displayedUsedPct, staleSeconds: ctx.DEFAULTS.staleSeconds,
    decideLoop: require('./lib/relay-loop.js').decideLoop };
  return cached;
}

// If the host stops reading our stdout the write fails with EPIPE on a LATER
// tick, where try/catch cannot see it (the relay monitor hook guards the same way).
process.stdout.on('error', () => {});
process.stdin.on('error', () => {});

// Chains and instance files live in <repo_root>/.relay AND in the legacy
// RELAY_DIR — both are read, never one as a fallback. An override pins the scan
// to one dir for tests.
const scanDirs = (cwd) => (process.env.RELAY_DIR_OVERRIDE
  ? [process.env.RELAY_DIR_OVERRIDE] : lib().relayDirs(cwd));

const cliPid = () => process.env.CLI_PID_OVERRIDE || String(process.ppid);

// Identity, INSTANCE FIRST. A spawned successor carries CLAUDE_RELAY_TOKEN for
// the whole life of its CLI — but when that same session later runs `/relay
// start` or `/relay next`, the verb mints a NEW token into instance-$PPID.json
// and opens a NEW chain held by it. Env-first then looked for a chain held by
// the stale spawn token, found none, and silently stopped driving the chain this
// session had just started. Both identities are kept and BOTH are tried: an
// unclaimed successor has no instance file yet and resolves only by env. No
// token at all = a stranger, and strangers never see the loop.
const resolveTokens = (dirs) => [...new Set([
  lib().readInstanceToken(dirs, cliPid()), process.env.CLAUDE_RELAY_TOKEN,
].filter(Boolean))];

// Every live chain in `dirs`, newest mtime first. A chain that fails to load or
// validate is skipped, never fatal — the baton guard applies the same rule to
// the same files.
function chainFiles(dirs) {
  const files = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!/^chain-.*\.json$/.test(n) || n.endsWith('.done.json')) continue;
      const file = path.join(dir, n);
      try { files.push({ file, m: fs.statSync(file).mtimeMs }); }
      catch { /* deleted between readdir and stat — skip */ }
    }
  }
  return files.sort((a, b) => b.m - a.m);
}

// The one chain this session is entitled to drive: the chain it currently HOLDS,
// resolved token by token in precedence order. CLAUDE_RELAY_CHAIN is a fast path
// for the ENV token only — it names the chain the spawn was born into, so
// consulting it ahead of the instance token would drive the OLD chain even when
// this session holds a newer one. The matched token travels with the hit:
// decideLoop compares it against baton.holder_token (row 1) and history (row 5).
function heldChain(dirs, tokens) {
  const { loadChain, validateChain } = lib();
  const held = (file, token) => {
    try {
      const r = loadChain(file);
      if (!r.ok || !validateChain(r.chain).ok) return null;
      if (!r.chain.baton || r.chain.baton.holder_token !== token) return null;
      return { file, chain: r.chain, token };
    } catch { return null; }
  };
  const files = chainFiles(dirs);
  for (const token of tokens) {
    if (token === process.env.CLAUDE_RELAY_TOKEN && process.env.CLAUDE_RELAY_CHAIN) {
      const hit = held(process.env.CLAUDE_RELAY_CHAIN, token);
      if (hit) return hit;
    }
    for (const { file } of files) {
      const hit = held(file, token);
      if (hit) return hit;
    }
  }
  return null;
}

// The context meter the statusline already writes, read exactly as the relay
// monitor hook reads it (HOST tmpdir, keyed by session_id).
// CLAUDE_CTX_BRIDGE_OVERRIDE repoints it for tests. Unreadable or malformed
// yields null — which decideLoop treats as "unknown", never as "low".
function displayedPct(sessionId) {
  let file = process.env.CLAUDE_CTX_BRIDGE_OVERRIDE;
  if (!file) {
    // session_id builds a path under tmpdir; a traversal-shaped value could
    // read outside it.
    if (!sessionId || /[/\\]|\.\./.test(sessionId)) return null;
    file = path.join(os.tmpdir(), `claude-ctx-${sessionId}.json`);
  }
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { displayedUsedPct, staleSeconds } = lib();
    // Staleness, honoured exactly as the relay monitor hook honours it via
    // relay-context.js DEFAULTS.staleSeconds. A statusline that stopped writing
    // leaves its last HIGH reading on disk forever; trusting it would spend all
    // three relay nudges and park the chain in the cap row on a number belonging
    // to a session that already ended. timestamp is epoch SECONDS, which is
    // what every statusline that feeds this bridge writes.
    if (typeof m.timestamp !== 'number') return null;
    if (Math.floor(Date.now() / 1000) - m.timestamp > staleSeconds) return null;
    return displayedUsedPct(m.remaining_percentage);
  } catch { return null; }
}

// Verify-after-write: a block reason promises an iteration count, so that count
// must actually be on disk before the turn is trapped. If the write or the
// read-back disagrees, the turn is allowed to end instead — the alternative is a
// session blocked forever on a counter that never advances.
function persisted(file, next) {
  const { loadChain, writeChain } = lib();
  try { writeChain(file, next); } catch { return false; }
  const back = loadChain(file);
  return back.ok && !!back.chain.loop
    && JSON.stringify(back.chain.loop) === JSON.stringify(next.loop);
}

function decide(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== 'object') return null;

  // The hook's own cwd is the CLI's in practice but not by contract; the Stop
  // payload carries the session's cwd explicitly.
  const dirs = scanDirs(data.cwd || process.cwd());
  const tokens = resolveTokens(dirs);
  if (!tokens.length) return null;
  const hit = heldChain(dirs, tokens);
  if (!hit) return null;

  const result = lib().decideLoop(hit.chain, {
    token: hit.token,
    gen: hit.chain.generation.current,
    displayedPct: displayedPct(data.session_id),
    now: new Date().toISOString(),
  }, { cap: lib().configuredLoopCap() });

  if (result.allow) {
    // An allow row may still carry an alert to record (loop cap, nudge cap) —
    // and only on the FIRST turn at that cap: decideLoop returns no `next` once
    // the alert is already on the chain, so a parked loop is not re-written, and
    // its one tell is not buried under duplicates of itself.
    // Best effort only: an allow is an allow whether or not the write landed.
    if (result.next) { try { lib().writeChain(hit.file, result.next); } catch { /* advisory */ } }
    return null;
  }
  if (!persisted(hit.file, result.next)) return null;

  // stop_hook_active is informational — the table is re-evaluated fresh every
  // time, and the cap, not the flag, is what ends an infinite loop.
  const reason = data.stop_hook_active === true
    ? `${result.reason} [resumed]` : result.reason;
  return JSON.stringify({ decision: 'block', reason });
}

let input = '';
// Exit quietly rather than hanging until the host kills us and reports a hook
// error (mirrors the relay monitor hook).
const stdinTimeout = setTimeout(() => process.exit(0), 10000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  let out = null;
  try { out = decide(input); } catch { /* never trap a session */ }
  // No process.exit after the write: on POSIX stdout is an async pipe and
  // exiting immediately can truncate it. Ending naturally also exits 0.
  if (out) process.stdout.write(`${out}\n`);
});
