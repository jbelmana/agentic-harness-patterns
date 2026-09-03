// The board's bootstrap: fetch the ballot, render it, wire the submit bar.
//
// This is a served asset rather than an inline <script> in index.html, and that
// is a CSP requirement, not a style preference. CSP source expressions match
// URLs; an inline script has no URL, so `default-src 'self'` never authorizes
// it — inline execution is a separate check needing 'unsafe-inline', a nonce,
// or a hash, and type="module" is not exempt. Inline, this code silently never
// runs: the board sits on "Loading ballot…" with the violation only in the
// console. External, it is an ordinary same-origin fetch the policy allows,
// which is what lets index.html keep a policy free of 'unsafe-inline'.
//
// The cost of the move is that the failure mode changes rather than vanishing:
// a name missing from the server's ASSETS allowlist 404s this file and produces
// the same stuck "Loading ballot…". tests/server.test.mjs GETs every allowlisted
// asset, this one included, which is the oracle for that mode.
import { renderBoard } from './render.mjs';
import { wireSubmit } from './submit.mjs';

// Resolved before the try so the catch always has somewhere to write.
const mount = document.getElementById('board');
const token = new URLSearchParams(location.search).get('token');

// A rejected fetch — the server timed out or was killed between page load and
// this call — must land in the failure branch. Unhandled, the top-level await
// leaves "Loading ballot…" on screen forever with nothing to act on.
try {
  const res = await fetch('/ballot.json', { headers: { 'X-Ballot-Token': token } });
  if (!res.ok) { mount.textContent = 'Auth failed — reopen from the terminal URL.'; }
  else {
    const ballot = await res.json();
    renderBoard(ballot, mount);
    wireSubmit(ballot, mount, token);
  }
} catch (e) {
  mount.textContent = `Could not reach the ballot server (${e.message}) — it may have timed out. Reopen from the terminal URL.`;
}
