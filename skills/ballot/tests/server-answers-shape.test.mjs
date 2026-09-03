// POST /answers shape gate. The route is reachable by anything holding the
// token and the file it writes is the operator's consent record, so an
// off-contract body must 400 rather than be persisted — and must not crash the
// server on its way there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { postAnswers, startServer } from './lib/server-harness.mjs';

test('an off-contract /answers payload gets 400 and writes nothing', async () => {
  const { info, proc, dir } = await startServer('minimal');
  try {
    for (const bad of [
      [],               // a top-level array is an object to typeof, not to us
      'just a string',
      null,
      { ballot_id: 'minimal-ballot' },              // no answers array at all
      { ballot_id: 'minimal-ballot', answers: {} }, // answers present, wrong type
      { ballot_id: 7, answers: [] },
      { ballot_id: 'minimal-ballot', answers: [], open_answers: 'nope' },
      { ballot_id: 'minimal-ballot', answers: [], defaults_overridden: 1 },
    ]) {
      const res = await postAnswers(info, bad);
      assert.equal(res.status, 400, `should have been rejected: ${JSON.stringify(bad)}`);
    }
    // A rejection must not take the process down — the board is still up, so the
    // operator can correct and resubmit.
    assert.equal((await fetch(`http://127.0.0.1:${info.port}/ballot.json`,
      { headers: { 'X-Ballot-Token': info.token } })).status, 200);
    assert.equal(existsSync(path.join(dir, 'answers.json')), false);
    assert.equal(existsSync(path.join(dir, 'answers.json.tmp')), false);
  } finally {
    proc.kill();
  }
});

test('the documented delta shape is accepted — absent deltas, empty answers, null id', async () => {
  // SKILL.md documents defaults_overridden/open_answers as DELTA arrays whose
  // absence is meaningful ("the default held" / "still open"), documents
  // ballot_id as "<meta.id, or null>", and a custom_html board posts
  // `answers: []`. Requiring any of those would 400 a legitimate submission —
  // this is the guard on the guard.
  const { info, proc, dir } = await startServer('minimal');
  const payload = { ballot_id: null, submitted_at: new Date().toISOString(), answers: [] };
  try {
    const exited = new Promise((r) => proc.on('exit', r));
    assert.equal((await postAnswers(info, payload)).status, 200);
    assert.equal(await exited, 0);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'answers.json'), 'utf8')), payload);
  } finally {
    proc.kill();
  }
});
