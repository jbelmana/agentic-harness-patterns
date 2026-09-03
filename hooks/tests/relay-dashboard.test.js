'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'relay-dashboard.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));

const CHAIN = {
  chain_id: 'demo-chain', repo_root: '/r', spawn_policy: 'worktree',
  mode: 'autonomous', artifact_url: '', generation: { current: 2, cap: 5 },
  baton: { holder_token: 'tok-2', state: 'held', offered_at: null, claimed_at: 't2' },
  handoff_doc: '', alerts: [{ at: 't3', msg: 'ack timeout after 300s — baton reverted to predecessor' }],
  tasks: [
    { id: 'T1', desc: 'build thing', acceptance: 'tests pass', state: 'verified', gen: 1 },
    { id: 'T2', desc: 'wire thing', acceptance: 'grep call site', state: 'done', gen: 2 },
    { id: 'T3', desc: 'ship thing', acceptance: 'pushed', state: 'open', gen: 2 } ],
  history: [{ gen: 0, token: 'tok-0', released: 't1' },
            { gen: 1, token: 'tok-1', released: 't2' }] };

function render(dir, chainFile) {
  const out = execFileSync('node', [SCRIPT, chainFile], { encoding: 'utf8',
    env: { ...process.env, RELAY_DIR_OVERRIDE: dir } });
  return out.trim();
}

test('renders all sections from a fixture chain', () => {
  const d = tmp();
  const f = path.join(d, 'chain-demo-chain.json');
  fs.writeFileSync(f, JSON.stringify(CHAIN));
  const htmlPath = render(d, f);
  assert.equal(htmlPath, path.join(d, 'dash-demo-chain.html'));
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /<title>demo-chain<\/title>/);
  for (const s of ['T1', 'T2', 'T3', 'verified', 'done', 'open',
    'tok-2', 'ack timeout', 'generation 2 of cap 5', 'gen 0', 'gen 1'])
    assert.ok(html.includes(s), `missing: ${s}`);
  assert.ok(!/src=|href="http/.test(html), 'must be self-contained');
});

test('escapes HTML in task descriptions', () => {
  const d = tmp();
  const c = JSON.parse(JSON.stringify(CHAIN));
  c.tasks[0].desc = '<script>alert(1)</script>';
  const f = path.join(d, 'chain-demo-chain.json');
  fs.writeFileSync(f, JSON.stringify(c));
  const html = fs.readFileSync(render(d, f), 'utf8');
  assert.ok(!html.includes('<script>alert'), 'raw script tag leaked');
  assert.ok(html.includes('&lt;script&gt;'), 'escaped form expected');
});

// ── v2.1: the oversight half — statuses, decisions, ship ─────────────────────
// The dashboard is the phone-side view (design: "Oversight while away"), so every
// state a chain can end a turn in has to be visible without a terminal.
const schemaTwo = (over = {}) => ({ ...JSON.parse(JSON.stringify(CHAIN)),
  schema: 2, model: 'claude-opus-5', paused: false, waiting: null,
  loop: { cap: 30, iterations: { 2: 4 }, relayNudges: 0 }, decisions: [],
  ship: { branch: null, pr: null, review_rounds: 0, merged: false }, ended: null,
  ...over });

const renderChain = (c) => {
  const d = tmp();
  const f = path.join(d, 'chain-demo-chain.json');
  fs.writeFileSync(f, JSON.stringify(c));
  return fs.readFileSync(render(d, f), 'utf8');
};

test('each v2.1 chain status renders its own line', () => {
  const cases = [
    [{ waiting: { class: 'spend', question: 'raise chains_per_day?', since: 't4' } },
      'WAITING — spend: raise chains_per_day?'],
    [{ ended: { reason: 'cap', at: 't5' } }, 'ENDED AT CAP — 2 remain'],
    [{ ended: { reason: 'review-stalled', at: 't5' },
      ship: { branch: 'relay/x', pr: 'example/repo#12', review_rounds: 2,
        merged: false } }, 'REVIEW STALLED — PR example/repo#12'],
    [{ paused: true }, 'paused'],
    [{ ended: { reason: 'complete', at: 't5' } }, 'ENDED — complete'],
    [{ ship: { branch: 'relay/x', pr: 'example/repo#12', review_rounds: 1,
      merged: true } }, 'SHIPPED — example/repo#12'],
  ];
  for (const [over, expected] of cases)
    assert.ok(renderChain(schemaTwo(over)).includes(expected), `missing: ${expected}`);
});

test('decisions and the ship record render', () => {
  const html = renderChain(schemaTwo({
    decisions: [{ id: 'D1', question: 'which cap?', chosen: '30',
      why: 'recommended default', gen: 2, ts: 't4' }],
    ship: { branch: 'relay/x', pr: 'o/r#3', review_rounds: 1, merged: false } }));
  for (const s of ['Decisions', 'D1', 'which cap?', '30', 'gen 2',
    'Ship', 'relay/x', 'o/r#3', 'merged no'])
    assert.ok(html.includes(s), `missing: ${s}`);
});

test('escapes HTML in a decision question', () => {
  const html = renderChain(schemaTwo({ decisions: [{ id: 'D1',
    question: '<script>alert(1)</script>', chosen: 'ok', why: 'w', gen: 2, ts: 't4' }] }));
  assert.ok(!html.includes('<script>alert'), 'raw script tag leaked');
  assert.ok(html.includes('&lt;script&gt;'), 'escaped form expected');
});

// A schema-1 chain has no ship/decisions/ended at all — the renderer must skip
// those sections, not throw and take the whole dashboard down with it.
test('renders a schema-1 chain with no v2.1 fields', () => {
  const html = renderChain(CHAIN);
  assert.ok(html.includes('demo-chain'));
  for (const s of ['Decisions', 'Ship —', 'ENDED', 'WAITING'])
    assert.ok(!html.includes(s), `schema-1 chain should not render: ${s}`);
});

test('exit 1 when no chain resolvable', () => {
  const d = tmp();
  try {
    execFileSync('node', [SCRIPT], { encoding: 'utf8',
      env: { ...process.env, RELAY_DIR_OVERRIDE: d } });
    assert.fail('should exit 1');
  } catch (e) { assert.equal(e.status, 1); }
});
