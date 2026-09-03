import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBallot, shouldRunCli } from '../server/validate.mjs';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url)));

test('minimal ballot validates', () => {
  assert.deepEqual(validateBallot(fx('minimal')), { ok: true, errors: [] });
});
test('multi + preview ballot validates', () => {
  assert.equal(validateBallot(fx('multi')).ok, true);
});
test('duplicate question ids rejected', () => {
  const r = validateBallot(fx('invalid-dup-id'));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('duplicate')));
});
test('empty questions without custom_html rejected', () => {
  assert.equal(validateBallot(fx('invalid-empty')).ok, false);
});
test('custom_html excuses empty questions', () => {
  assert.equal(validateBallot(fx('custom-html')).ok, true);
});
test('custom_html alongside questions is rejected, not merely tolerated', () => {
  // The board renders the custom branch and returns before building a single
  // question card, then submits `choice: null` for every question the operator
  // never saw — and summarizeChanges reports each one as a deviation from the
  // recommendation. The shape has to die at the validator.
  const b = fx('minimal');
  b.custom_html = '<h2>Exotic</h2>';
  const r = validateBallot(b);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('mutually exclusive')), r.errors.join(' | '));
  // A null custom_html is the normal ballot's own value — it must stay legal.
  b.custom_html = null;
  assert.equal(validateBallot(b).ok, true);
});
test('two recommended options rejected', () => {
  const b = fx('minimal');
  b.questions[0].options.forEach(o => o.recommended = true);
  assert.equal(validateBallot(b).ok, false);
});
test('bad class rejected', () => {
  const b = fx('minimal');
  b.questions[0].class = 'vibes';
  assert.equal(validateBallot(b).ok, false);
});

// CLI contract: exit 0 valid / 1 invalid (errors on stderr) / 2 unreadable.
const CLI = fileURLToPath(new URL('../server/validate.mjs', import.meta.url));
const fxPath = (n) => fileURLToPath(new URL(`./fixtures/${n}.json`, import.meta.url));
const run = (arg) => spawnSync(process.execPath, [CLI, arg], { encoding: 'utf8' });

test('CLI exits 0 on a valid ballot', () => {
  assert.equal(run(fxPath('minimal')).status, 0);
});
test('CLI exits 1 and reports errors on stderr for an invalid ballot', () => {
  const r = run(fxPath('invalid-dup-id'));
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('duplicate'));
});
test('CLI exits 2 on an unreadable file', () => {
  assert.equal(run(fxPath('does-not-exist')).status, 2);
});
test('CLI still gates when invoked through a symlink', () => {
  // ~/.claude/skills/ reaches every pack skill through a directory symlink, so
  // the linked path — not the realpath — is the live consumption path.
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'ballot-cli-'));
  try {
    const link = path.join(dir, 'validate.mjs');
    symlinkSync(CLI, link);
    const r = spawnSync(process.execPath, [link, fxPath('invalid-dup-id')], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('duplicate'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('CLI exits 2 with usage when given no path', () => {
  const r = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^usage:/m);
});
test('the CLI guard does not fail open when argv[1] cannot be realpath-resolved', () => {
  // The live hole: realpathSync(argv[1]) throwing answered "not a direct
  // invocation", so the CLI silently exited 0 having validated nothing. A
  // spawned test cannot reach it — node always hands argv[1] a real path — so
  // the decision is unit-tested directly.
  const self = fileURLToPath(new URL('../server/validate.mjs', import.meta.url));
  assert.equal(shouldRunCli(self, new URL('../server/validate.mjs', import.meta.url).href), true);
  assert.equal(shouldRunCli('/nowhere/at/all/validate.mjs',
    new URL('../server/validate.mjs', import.meta.url).href), true, 'basename fallback must RUN');
  assert.equal(shouldRunCli('/nowhere/at/all/ballot-server.mjs',
    new URL('../server/validate.mjs', import.meta.url).href), false);
  assert.equal(shouldRunCli(undefined, new URL('../server/validate.mjs', import.meta.url).href), false);
});

test('optional fields the schema types are type-checked here too', () => {
  const bad = (mutate) => {
    const b = fx('minimal');
    mutate(b);
    return validateBallot(b);
  };
  assert.equal(bad(b => { b.questions[0].multi = 'yes'; }).ok, false);
  assert.equal(bad(b => { b.questions[0].allow_note = 1; }).ok, false);
  assert.equal(bad(b => { b.questions[0].options[0].recommended = 'true'; }).ok, false);
  assert.equal(bad(b => { b.questions[0].options[0].preview_html = 42; }).ok, false);
  assert.equal(bad(b => { b.custom_html = 7; }).ok, false);
  assert.equal(bad(b => { b.questions[0].gates = 'plan-1'; }).ok, false);
  assert.equal(bad(b => { b.questions[0].gates = ['ok', 3]; }).ok, false);
  // Correctly-typed values still pass, absent still passes.
  assert.equal(bad(b => {
    b.questions[0].multi = true;
    b.questions[0].allow_note = false;
    b.questions[0].gates = ['184-02'];
    b.questions[0].options[0].preview_html = '<b>x</b>';
  }).ok, true);
});

test('null defaults and open are rejected, matching the schema', () => {
  const b = fx('minimal');
  b.defaults = null;
  assert.equal(validateBallot(b).ok, false);
  const c = fx('minimal');
  c.open = null;
  assert.equal(validateBallot(c).ok, false);
});
