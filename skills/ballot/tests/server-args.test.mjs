// Start-up contract for the ballot server: every way an invocation can be
// rejected, and what it must leave behind on disk when it is. Split out of
// server.test.mjs, which binds real sockets and was at the 200-line ceiling —
// nothing here listens, so the two files have genuinely different shapes.
//
// Exit 3 covers every start failure, so each case also asserts the usage line:
// a wrong-reason exit 3 would otherwise pass silently.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = fileURLToPath(new URL('..', import.meta.url));
const SERVER = path.join(SKILL, 'server', 'ballot-server.mjs');
const fixturePath = (n) => path.join(SKILL, 'tests', 'fixtures', `${n}.json`);

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function scratchDir() {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'ballot-args-'));
  tmpDirs.push(dir);
  return dir;
}

test('malformed args, non-positive timeouts and non-numeric ports exit 3 with usage', () => {
  const dir = scratchDir();
  // Assert the fixture before trusting any exit code: a missing ballot exits 3
  // as well, and would let every case below pass for the wrong reason.
  assert.ok(existsSync(fixturePath('minimal')), 'fixture missing: minimal.json');
  const base = ['--ballot', fixturePath('minimal'), '--out', path.join(dir, 'answers.json')];
  const cases = [
    ['--timeout-min', '0'],    // the falsy-guard trap: used to mean 30 minutes
    ['--timeout-min', '-5'],
    ['--timeout-min', 'abc'],
    ['--bogus', 'x'],
    ['--port'],                // trailing valueless flag: used to mean random port
    ['--out'],                 // value missing, next token absent
    ['--port', 'abc'],         // Number('abc') is NaN — used to mean random port
    ['--port', ''],            // Number('') is 0 — the same trap, one class over
    ['--port', '70000'],       // out of range: EINVAL at listen, not a usage error
  ];
  for (const bad of cases) {
    const r = spawnSync(process.execPath, [SERVER, ...base, ...bad], { encoding: 'utf8' });
    assert.equal(r.status, 3, `expected exit 3 for ${bad.join(' ')} — got ${r.status}`);
    assert.match(r.stderr, /^usage:/m, `expected usage line for ${bad.join(' ')}`);
  }
  // A failed start must never CREATE a server-info.json a later reader could
  // trust. Removal of a pre-existing one is the test below — this directory has
  // never held a successful run, so there is nothing here to remove.
  assert.equal(existsSync(path.join(dir, 'server-info.json')), false);
});

test('a failed start removes a stale server-info.json from a previous run', () => {
  const dir = scratchDir();
  assert.ok(existsSync(fixturePath('minimal')), 'fixture missing: minimal.json');
  const infoPath = path.join(dir, 'server-info.json');
  // What a previous run leaves behind when it is killed rather than submitted
  // to: a live-looking URL whose pid is long dead and whose port may since have
  // been recycled by an unrelated process. Reading it is worse than finding
  // nothing, so a failing start has to clear it even though it writes no
  // replacement.
  writeFileSync(infoPath, JSON.stringify({
    url: 'http://127.0.0.1:1/?token=stale', port: 1, token: 'stale', pid: 999_999,
  }));
  assert.ok(existsSync(infoPath), 'stale file was not seeded');

  // --timeout-min 0 dies AFTER --out is parsed, which is the only class of
  // failure that knows where the file is. An arg-parse failure (--bogus) never
  // learns the directory and cannot be expected to clean it.
  const r = spawnSync(process.execPath, [SERVER, '--ballot', fixturePath('minimal'),
    '--out', path.join(dir, 'answers.json'), '--timeout-min', '0'], { encoding: 'utf8' });

  assert.equal(r.status, 3, `expected exit 3 — got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /--timeout-min must be a positive number/);
  assert.equal(existsSync(infoPath), false, 'stale server-info.json survived a failed start');
});
