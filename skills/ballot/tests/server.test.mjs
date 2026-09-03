// Integration tests for the ephemeral ballot server. These bind a real loopback
// socket and drive it over HTTP — they exercise the wire contract Task 3 depends
// on, not the handler functions in isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { postAnswers, postSplit, startServer } from './lib/server-harness.mjs';

test('serves the board, accepts answers atomically, then exits 0', async () => {
  const { info, proc, dir } = await startServer('minimal');
  assert.ok(existsSync(path.join(dir, 'server-info.json')));
  assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{32}$/);
  // The file carries the bearer token, so it must not be world-readable.
  assert.equal(statSync(path.join(dir, 'server-info.json')).mode & 0o777, 0o600);

  assert.equal((await fetch(info.url)).status, 200);

  const bj = await fetch(`http://127.0.0.1:${info.port}/ballot.json`,
    { headers: { 'X-Ballot-Token': info.token } });
  assert.equal(bj.status, 200);
  assert.equal((await bj.json()).meta.id, 'minimal-ballot');

  // Attach the exit listener BEFORE the POST: the server exits 500 ms after
  // responding, and a listener attached afterwards can miss the event entirely.
  const exited = new Promise((r) => proc.on('exit', r));
  const post = await postAnswers(info, { ballot_id: 'minimal-ballot', answers: [] });
  assert.equal(post.status, 200);
  assert.deepEqual(await post.json(), { ok: true });
  assert.equal(await exited, 0);

  const out = path.join(dir, 'answers.json');
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).ballot_id, 'minimal-ballot');
  assert.equal(existsSync(`${out}.tmp`), false, 'tmp+rename left residue behind');
});

test('rejects a bad or missing token with 403', async () => {
  const { info, proc } = await startServer('minimal');
  try {
    const base = `http://127.0.0.1:${info.port}`;
    assert.equal((await fetch(`${base}/ballot.json?token=nope`)).status, 403);
    assert.equal((await fetch(`${base}/ballot.json`)).status, 403);
  } finally {
    proc.kill();
  }
});

test('an invalid ballot exits 3 before listening', async () => {
  await assert.rejects(() => startServer('invalid-empty'), (e) => {
    assert.equal(e.code, 3);
    assert.match(e.stderr, /questions must be non-empty/);
    return true;
  });
});

test('assets bypass token auth; an unknown asset 404s rather than 403s', async () => {
  const { info, proc } = await startServer('minimal');
  try {
    const base = `http://127.0.0.1:${info.port}`;
    // Browsers cannot attach the token to stylesheet links or ESM imports, so
    // /assets/* is exempt from auth — the files are generic renderer code with
    // no ballot content. A 403 here would prove the gate still fronts the route.
    assert.equal((await fetch(`${base}/assets/nope.js`)).status, 404);
    // ...while every ballot-bearing route stays gated.
    assert.equal((await fetch(`${base}/`)).status, 403);
    // Every module the board actually imports must serve 200 with no token at
    // all. An allowlist that drifts from the renderer directory 404s the
    // browser's ESM import while every other server-side check stays green.
    // boot.mjs is the shell's whole bootstrap — it is external precisely so the
    // page CSP need not allow inline script — so dropping it from the allowlist
    // reproduces the stuck "Loading ballot…" this loop exists to catch.
    for (const name of ['boot.mjs', 'logic.mjs', 'render.mjs', 'board.mjs', 'submit.mjs', 'styles.css']) {
      assert.equal((await fetch(`${base}/assets/${name}`)).status, 200, `asset must serve: ${name}`);
    }
    const css = await fetch(`${base}/assets/styles.css`);
    assert.match(css.headers.get('content-type'), /text\/css/);
  } finally {
    proc.kill();
  }
});

test('a body split mid-UTF-8-sequence decodes intact, not into U+FFFD', async () => {
  const { info, proc, dir } = await startServer('minimal');
  // Deterministic, unlike padding to some size and hoping a socket read lands
  // badly: cut between byte 1 and 2 of an em-dash (E2 80 94) so the server is
  // guaranteed a read ending mid-character. Verified to corrupt the pre-fix
  // build at 190 bytes, where a 120 KB payload happened to survive intact.
  const note = '—'.repeat(50);
  // `answers` is present because the route now shape-checks the payload; the
  // decoding behaviour under test is unchanged by it.
  const body = Buffer.from(JSON.stringify({ ballot_id: 'minimal-ballot', answers: [], note }), 'utf8');
  const cut = body.indexOf(0xe2) + 1;
  assert.equal(body[cut], 0x80, 'cut must land inside a multi-byte sequence');

  // finally-killed: the server exits on its own after a 200, but a failing
  // assertion before that leaves it listening and wedges `node --test`.
  try {
    const exited = new Promise((r) => proc.on('exit', r));
    assert.equal(await postSplit(info, body, cut), 200);
    assert.equal(await exited, 0);

    // Decoding each read separately turns the straddling character into
    // replacement chars — and the result still parses as JSON, so a per-chunk
    // decode returns 200 and ships the corruption with nothing reporting it.
    const written = JSON.parse(readFileSync(path.join(dir, 'answers.json'), 'utf8'));
    assert.equal(written.note.includes('�'), false, 'body was decoded per-chunk');
    assert.equal(written.note, note);
  } finally {
    proc.kill();
  }
});

test('a large multibyte body round-trips byte-identical', async () => {
  const { info, proc, dir } = await startServer('minimal');
  // ~120 KB of 3-byte characters — several socket reads' worth of volume.
  const note = '—'.repeat(40_000);
  const payload = { ballot_id: 'minimal-ballot', answers: [{ id: 'q-output-path', note }] };

  try {
    const exited = new Promise((r) => proc.on('exit', r));
    assert.equal((await postAnswers(info, payload)).status, 200);
    assert.equal(await exited, 0);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'answers.json'), 'utf8')), payload);
  } finally {
    proc.kill();
  }
});

test('an over-cap body gets 413 and writes nothing', async () => {
  const { info, proc, dir } = await startServer('minimal');
  try {
    // 400k em-dashes: 1.2 MB on the wire but only 400k UTF-16 code units. A cap
    // measured on string .length would read this as ~0.4 MB and let it through.
    const res = await postAnswers(info, { ballot_id: 'minimal-ballot', pad: '—'.repeat(400_000) });
    assert.equal(res.status, 413);
    assert.equal(existsSync(path.join(dir, 'answers.json')), false);
    assert.equal(existsSync(path.join(dir, 'answers.json.tmp')), false);
  } finally {
    proc.kill();
  }
});

test('a port already in use exits 3, not an uncaught throw', async () => {
  const first = await startServer('minimal');
  try {
    await assert.rejects(
      () => startServer('minimal', { extraArgs: ['--port', String(first.info.port)] }),
      (e) => {
        assert.equal(e.code, 3);
        assert.match(e.stderr, /EADDRINUSE|address already in use/);
        assert.match(e.stderr, new RegExp(String(first.info.port)));
        return true;
      },
    );
  } finally {
    first.proc.kill();
  }
});

test('no submission before the deadline exits 2', async () => {
  // 0.02 min = 1.2 s. Fractions are legal precisely so this stays cheap.
  const { proc, stderr } = await startServer('minimal', { timeoutMin: '0.02' });
  const code = await new Promise((r) => proc.on('exit', r));
  assert.equal(code, 2);
  assert.match(stderr(), /ballot timeout/);
});
