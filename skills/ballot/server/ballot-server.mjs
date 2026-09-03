// Ephemeral ballot board server. Binds loopback on a random port, hands the
// operator one tokenized URL, and exits the moment answers land — it is a
// single-use surface, not a daemon. Validation lives in ./validate.mjs and the
// board's markup in ../renderer/; this file is transport only.
//
// Exit codes: 0 answers received · 2 timeout · 3 could not start — bad usage or
// malformed args, unreadable ballot, a ballot that fails validation, a listen
// failure, or a server-info write failure.
// NOTE: ./validate.mjs speaks a DIFFERENT exit vocabulary (0 valid · 1 invalid ·
// 2 unreadable/usage). They are independent entry points; do not conflate them.
import http from 'node:http';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBallot } from './validate.mjs';

const USAGE = 'usage: --ballot <path> --out <path> [--port N] [--timeout-min N]';
const FLAGS = new Set(['ballot', 'out', 'port', 'timeout-min']);
const BODY_CAP = 1_048_576; // bytes on the wire — NOT UTF-16 code units

const fail = (msg) => { console.error(msg); process.exit(3); };
const die = (msg) => { console.error(`${msg}\n${USAGE}`); process.exit(3); };

// Validate each pair rather than stepping blindly: a valueless flag would
// otherwise slide every later token one slot left and be read as a value
// (`--out Y --port` used to yield Number(undefined) || 0 — a silent random port).
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const tok = process.argv[i];
  const key = tok.startsWith('--') ? tok.slice(2) : null;
  if (!key || !FLAGS.has(key)) die(`unknown or malformed argument: ${tok}`);
  const val = process.argv[i + 1];
  if (val === undefined || val.startsWith('--')) die(`--${key} needs a value`);
  args[key] = val;
}
if (!args.ballot || !args.out) die('missing --ballot or --out');

const outPath = path.resolve(args.out);
const infoPath = path.join(path.dirname(outPath), 'server-info.json');
// Clear a previous run's file the moment --out is known, and BEFORE any of the
// validations below can die(). A stale server-info.json naming a dead pid — or
// a recycled port now owned by an unrelated process — is strictly worse than no
// file at all, and every start failure exits before writing a replacement. The
// earlier arg-parse failures cannot reach here because --out is not yet known;
// those cases never had a directory to clean.
//
// KNOWN, pre-existing: server-info.json is named by --out's DIRECTORY, so two
// boards sharing one --out dir clobber each other's file — this unlink deletes
// a concurrently-running server's live info, and a successful start overwrites
// it just the same. Nothing here can distinguish the two, and this process
// cannot know about the other one. The rule is one --out directory per ballot,
// which the skill doc mandates; concurrent boards on a shared dir are operator
// error rather than a case to reconcile.
try {
  unlinkSync(infoPath);
} catch (e) {
  if (e.code !== 'ENOENT') fail(`cannot clear ${infoPath}: ${e.message}`);
}

// A falsy-guard default (`Number(x) || 30`) silently turns 0 into 30 minutes.
// Positive fractions are legal: 0.02 ≈ 1.2 s, which is what the timeout test uses.
const timeoutMin = args['timeout-min'] === undefined ? 30 : Number(args['timeout-min']);
if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) {
  die('--timeout-min must be a positive number of minutes');
}
const timeoutMs = timeoutMin * 60_000;

// Digits only, not Number(): `Number('abc')` is NaN and `Number('')` is 0, and
// both reach `Number(args.port) || 0` at listen() as "bind a random port" — the
// operator asked for a specific port and silently got a different one. Same
// falsy-guard class as the timeout above. An explicit `--port 0` still means
// random, which is the documented way to ask for one.
if (args.port !== undefined && (!/^\d+$/.test(args.port) || Number(args.port) > 65535)) {
  die(`--port must be an integer from 0 to 65535: ${args.port}`);
}

let ballot;
try {
  ballot = JSON.parse(readFileSync(args.ballot, 'utf8'));
} catch (e) {
  fail(`unreadable ballot: ${e.message}`);
}
const v = validateBallot(ballot);
if (!v.ok) {
  v.errors.forEach(e => console.error(e));
  process.exit(3);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.join(here, '..', 'renderer');
const MIME = { '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
// Every module the board imports, transitively: index.html loads boot.mjs,
// which imports render.mjs and submit.mjs, and render.mjs imports board.mjs. A
// name missing here 404s the browser's ESM import while every server-side check
// still passes. boot.mjs is the load-bearing one — it is the shell's only
// script, so its absence leaves the board on "Loading ballot…" exactly as an
// inline-blocking CSP would. tests/server.test.mjs asserts the whole list.
const ASSETS = new Set(['boot.mjs', 'logic.mjs', 'render.mjs', 'board.mjs', 'submit.mjs', 'styles.css']);
const token = randomBytes(16).toString('hex');

const authed = (req, u) =>
  u.searchParams.get('token') === token || req.headers['x-ballot-token'] === token;

// A renderer file can be absent — the allowlist is written ahead of the files
// themselves — and an uncaught readFileSync throw inside a request handler
// takes the whole process down. Missing means 404, never a crash.
function sendFile(res, file, type) {
  let body;
  try {
    body = readFileSync(file);
  } catch {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': type });
  return res.end(body);
}

/** @returns {string|null} why this payload is off-contract, or null when it fits. */
function answersShapeError(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'answers payload must be an object';
  if (!Array.isArray(p.answers)) return 'answers must be an array';
  for (const k of ['defaults_overridden', 'open_answers']) {
    if (p[k] !== undefined && !Array.isArray(p[k])) return `${k} must be an array when present`;
  }
  // ballot_id is documented as "<meta.id, or null>" — null stays legal.
  if (p.ballot_id !== undefined && p.ballot_id !== null && typeof p.ballot_id !== 'string') {
    return 'ballot_id must be a string or null';
  }
  return null;
}

function receiveAnswers(req, res) {
  const chunks = [];
  let bytes = 0;
  let over = false;
  req.on('data', (c) => {
    if (over) return;
    bytes += c.length; // Buffer byte length — nothing is decoded yet
    if (bytes > BODY_CAP) {
      over = true;
      chunks.length = 0;
      res.writeHead(413, { 'Content-Type': 'text/plain', Connection: 'close' });
      res.end('payload too large');
      return req.resume(); // drain without buffering; never a bare socket destroy
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (over) return;
    let payload;
    // Decode ONCE over the joined buffer. A per-chunk toString() mangles any
    // UTF-8 sequence straddling a socket-read boundary (~64 KB) into U+FFFD —
    // and the result still parses as JSON, so the corruption ships silently.
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400);
      return res.end('bad json');
    }
    // Shape gate. The renderer is the only intended producer, but the route is
    // reachable by anything holding the token, and the file it writes is the
    // operator's consent record. Check the contract SKILL.md documents — and
    // only that: `defaults_overridden` and `open_answers` are DELTA arrays whose
    // absence is meaningful ("the default held" / "still open"), so requiring
    // them would 400 legitimate submissions. `answers: []` is legitimate too —
    // that is exactly what a custom_html board posts.
    const badShape = answersShapeError(payload);
    if (badShape) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end(badShape);
    }
    // tmp+rename so a reader never observes a half-written answers file.
    const tmp = `${outPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2));
    renameSync(tmp, outPath);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    // Let the response flush before tearing the process down.
    setTimeout(() => process.exit(0), 500);
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  // /assets/* is exempt from token auth: browser subresource requests
  // (stylesheet links, ESM imports) cannot carry a token, and these files are
  // generic renderer code holding no ballot content. The allowlist below — not
  // the token — is what keeps the route from serving arbitrary paths.
  const isAsset = req.method === 'GET' && u.pathname.startsWith('/assets/');
  if (!isAsset && !authed(req, u)) {
    res.writeHead(403);
    return res.end('forbidden');
  }

  if (req.method === 'GET' && u.pathname === '/') {
    return sendFile(res, path.join(RENDERER, 'index.html'), 'text/html');
  }
  if (req.method === 'GET' && u.pathname === '/ballot.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(ballot));
  }
  if (isAsset) {
    const name = u.pathname.slice('/assets/'.length);
    if (!ASSETS.has(name)) {
      res.writeHead(404);
      return res.end();
    }
    return sendFile(res, path.join(RENDERER, name), MIME[path.extname(name)] || 'text/plain');
  }
  if (req.method === 'POST' && u.pathname === '/answers') return receiveAnswers(req, res);
  res.writeHead(404);
  res.end();
});

// Without this, EADDRINUSE on an explicit --port surfaces as an uncaught throw
// and exit 1 — outside the vocabulary this file documents and Task 3 consumes.
server.on('error', (e) => fail(`listen failed: ${e.message}`));

server.listen(Number(args.port) || 0, '127.0.0.1', () => {
  const port = server.address().port;
  const info = {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    token,
    pid: process.pid,
    ballot: path.resolve(args.ballot),
    out: outPath,
    started: new Date().toISOString(),
  };
  try {
    // 0600 — this file carries the bearer token. The unlink above guarantees a
    // fresh create, which is the only time writeFileSync honours `mode`.
    writeFileSync(infoPath, JSON.stringify(info, null, 2), { mode: 0o600 });
  } catch (e) {
    fail(`cannot write ${infoPath}: ${e.message}`);
  }
  console.log(JSON.stringify(info));
});

setTimeout(() => {
  console.error('ballot timeout — no submission');
  process.exit(2);
}, timeoutMs);
