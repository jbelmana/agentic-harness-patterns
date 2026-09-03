// Shared harness for the ballot-server integration tests. Extracted so the
// wire-contract suites can grow past one file without either of them crossing
// the 200-LOC rule; the cleanup semantics below are the reason it is shared
// rather than copied.
import { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL = fileURLToPath(new URL('../..', import.meta.url));
export const SERVER = path.join(SKILL, 'server', 'ballot-server.mjs');
export const fixturePath = (n) => path.join(SKILL, 'tests', 'fixtures', `${n}.json`);

// Tracked rather than removed per-test: a run that rejects during startup never
// hands its directory back to the caller, so a `finally` in each test would miss it.
// Spawned servers are tracked for the same reason, and for one more: a test that
// fails its assertions before the server self-exits leaves it listening, and the
// child's open stdio pipes keep `node --test` alive. Killing them here covers the
// startup-rejection cases a per-test `finally` structurally cannot reach.
// `after` is registered at import time, so it attaches to the importing file's
// root suite — one registration per test file, which is what we want.
const tmpDirs = [];
const procs = [];
after(() => {
  for (const p of procs) p.kill();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

export function scratchDir() {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'ballot-'));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Spawn the server against a throwaway copy of `fixture` and resolve once it
 * prints its startup JSON. Rejects with `{code, stderr}` if it exits first.
 * Exit 3 covers every start failure, so callers discriminate on stderr rather
 * than trusting the code alone — and the fixture paths are asserted before the
 * spawn so a bad copy can never masquerade as a real validation failure.
 */
export function startServer(fixture, { timeoutMin = '5', extraArgs = [] } = {}) {
  const src = fixturePath(fixture);
  assert.ok(existsSync(src), `fixture missing: ${src}`);
  const dir = scratchDir();
  const ballot = path.join(dir, 'ballot.json');
  cpSync(src, ballot);
  assert.ok(existsSync(ballot), `fixture copy failed: ${ballot}`);

  const proc = spawn(process.execPath, [SERVER, '--ballot', ballot,
    '--out', path.join(dir, 'answers.json'), '--timeout-min', timeoutMin, ...extraArgs]);
  procs.push(proc);

  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => reject(new Error('no startup JSON')), 5000);
    timer.unref();
    proc.stderr.on('data', (d) => { err += d; });
    proc.stdout.on('data', (d) => {
      out += d;
      let info;
      try { info = JSON.parse(out); } catch { return; } // still a partial write
      clearTimeout(timer);
      resolve({ info, proc, dir, stderr: () => err });
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      const e = new Error(`early exit ${code}: ${err.trim()}`);
      e.code = code;
      e.stderr = err;
      reject(e); // no-op once the startup JSON has already resolved this
    });
  });
}

// Send `body` as two writes split at byte offset `cut`, so the server sees a
// socket read ending mid-character. fetch() offers no control over write
// boundaries, hence the raw http.request.
export function postSplit(info, body, cut) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: info.port, path: '/answers', method: 'POST',
      headers: { 'X-Ballot-Token': info.token, 'Content-Type': 'application/json' },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.write(body.subarray(0, cut));
    setTimeout(() => req.end(body.subarray(cut)), 120);
  });
}

export const postAnswers = (info, payload) =>
  fetch(`http://127.0.0.1:${info.port}/answers`, {
    method: 'POST',
    headers: { 'X-Ballot-Token': info.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
