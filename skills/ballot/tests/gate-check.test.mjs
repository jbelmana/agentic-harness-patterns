// Gate inventory. The case being closed:
// a ballot named one blocker while a second plan held an unrepresented gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGates, collectGatedPlans, gateReason } from '../server/gate-check.mjs';

const CLI = fileURLToPath(new URL('../server/validate.mjs', import.meta.url));
const minimal = () => JSON.parse(readFileSync(new URL('./fixtures/minimal.json', import.meta.url)));

/** Build a throwaway phase tree: { '12-01': 'autonomous: true', … }. */
function phaseTree(plans) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'ballot-gates-'));
  const dir = path.join(root, '184-example-phase');
  mkdirSync(dir);
  for (const [id, fm] of Object.entries(plans)) {
    writeFileSync(path.join(dir, `${id}-PLAN.md`),
      `---\nphase: 184-example-phase\nplan: ${id.split('-')[1]}\n${fm}\n---\n\n# body\n`);
  }
  return root;
}

const ballotWithGates = (...ids) => {
  const b = minimal();
  b.questions[0].gates = ids;
  return b;
};

test('autonomous: false, checkpoint: and non-AUTO gate: are gates; AUTO is not', () => {
  assert.equal(gateReason({ autonomous: 'false' }), 'autonomous: false');
  assert.equal(gateReason({ checkpoint: 'operator sign-off' }), 'checkpoint: operator sign-off');
  assert.equal(gateReason({ gate: 'BALLOT' }), 'gate: BALLOT');
  assert.equal(gateReason({ gate: 'FLAG' }), 'gate: FLAG');
  // AUTO is the vocabulary's "no human needed" value, parentheticals included.
  assert.equal(gateReason({ gate: 'AUTO' }), null);
  assert.equal(gateReason({ gate: 'AUTO (M-effort, spec locked)' }), null);
  assert.equal(gateReason({ autonomous: 'true' }), null);
  assert.equal(gateReason(null), null);
});

test('all gates represented → ok', () => {
  const root = phaseTree({
    '12-01': 'autonomous: false',
    '12-02': 'autonomous: true\ncheckpoint: operator confirms the migration',
    '12-03': 'autonomous: true\ngate: AUTO (routine)',
  });
  try {
    const r = checkGates(ballotWithGates('12-01', '12-02'), root);
    assert.equal(r.ok, true, r.errors.join(' | '));
    assert.equal(r.gated.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('one missing gate fails and names the plan', () => {
  const root = phaseTree({ '12-01': 'autonomous: false', '12-02': 'gate: BALLOT' });
  try {
    const r = checkGates(ballotWithGates('12-01'), root);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /12-02/);
    assert.match(r.errors[0], /gate: BALLOT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a gates entry naming a plan with no gate is reported', () => {
  const root = phaseTree({ '12-01': 'autonomous: false', '12-03': 'autonomous: true' });
  try {
    const r = checkGates(ballotWithGates('12-01', '12-03'), root);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' | '), /no gate.*12-03/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a colon-key lookalike inside must_haves is not read as frontmatter', () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'ballot-gates-'));
  const dir = path.join(root, '184-p');
  mkdirSync(dir);
  writeFileSync(path.join(dir, '12-09-PLAN.md'),
    '---\nphase: 184-p\nplan: 09\nautonomous: true\nmust_haves:\n  truths:\n' +
    '    - "the doc says autonomous: false somewhere"\n---\n');
  try {
    assert.deepEqual(collectGatedPlans(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a bare PLAN.md still gets a non-empty id', () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'ballot-gates-'));
  const dir = path.join(root, '42-batch-execute');
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'PLAN.md'), '---\nphase: 42\nplan: 01\ngate: FLAG\n---\n');
  try {
    const gated = collectGatedPlans(root);
    assert.equal(gated.length, 1);
    assert.equal(gated[0].id, '42-01');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- CLI wiring -------------------------------------------------------------

const runCli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

function withBallot(ballot, fn) {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'ballot-cli-gates-'));
  const p = path.join(dir, 'ballot.json');
  writeFileSync(p, JSON.stringify(ballot));
  try { return fn(p); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('CLI without --phase-dir is unchanged — no gate check runs', () => {
  withBallot(minimal(), (p) => {
    const r = runCli([p]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'valid');
  });
});

test('CLI --phase-dir exits 1 naming the unrepresented plan', () => {
  const root = phaseTree({ '12-01': 'autonomous: false', '12-02': 'checkpoint: sign-off' });
  try {
    withBallot(ballotWithGates('12-01'), (p) => {
      const r = runCli([p, '--phase-dir', root]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /unrepresented gate: 12-02/);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI --phase-dir exits 0 when every gate is represented', () => {
  const root = phaseTree({ '12-01': 'autonomous: false', '12-02': 'autonomous: true' });
  try {
    withBallot(ballotWithGates('12-01'), (p) => {
      const r = runCli([p, '--phase-dir', root]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /1 gate\(s\) represented/);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI exits 2 on an unreadable --phase-dir, not 0 and not 1', () => {
  withBallot(minimal(), (p) => {
    const r = runCli([p, '--phase-dir', path.join(realpathSync(tmpdir()), 'no-such-phase-dir-xyz')]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /phase dir unreadable/);
  });
});

test('CLI exits 2 on --phase-dir with no value', () => {
  withBallot(minimal(), (p) => {
    assert.equal(runCli([p, '--phase-dir']).status, 2);
  });
});

test('a gates value of the wrong type is a schema error, caught before the gate walk', () => {
  const b = minimal();
  b.questions[0].gates = '12-01';
  withBallot(b, (p) => {
    const r = runCli([p, '--phase-dir', realpathSync(tmpdir())]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /gates must be an array/);
  });
});
