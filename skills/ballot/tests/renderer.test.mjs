// Static guards on the renderer's non-JS surfaces. The board's DOM behaviour is
// unreachable from here — this repo has no jsdom and takes no dependency to get
// one — but two of its defences live in files a reader can delete without any
// test noticing. Both are asserted by source inspection rather than by rendering.
//
// Neither replaces looking at the board: rendered visibility and actual
// navigation behaviour belong to the dogfood pass. These catch the silent
// deletion, which is the failure mode nothing else here covers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const asset = (n) => readFileSync(new URL(`../renderer/${n}`, import.meta.url), 'utf8');

test('the stylesheet keeps hidden elements hidden, !important included', () => {
  // board.mjs hides the default-note textarea with `note.hidden = true`, which
  // relies on the UA stylesheet's `[hidden] { display: none }`. The author-origin
  // `display: block` on `.default-note, .open-answer` beats UA origin regardless
  // of specificity, so without an author `[hidden]` rule carrying !important,
  // every note textarea renders visible before its row is challenged — and the
  // input handler silently discards anything typed into an un-flipped note.
  assert.match(asset('styles.css'), /\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/);
});

test('the shell declares a same-origin CSP that still allows data: images', () => {
  // preview_html is ballot-authored and keeps its ordinary src/href URLs — the
  // sanitizer only strips javascript:/vbscript:. default-src 'self' stops an
  // <img src="http://…"> beacon from a board that is otherwise fully offline.
  // `img-src 'self' data:` re-admits self-contained data URIs, which have
  // nowhere to phone, so an inline diagram in a preview still renders.
  const html = asset('index.html');
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(html, /content="default-src 'self'; img-src 'self' data:"/);
  // CSP does not block navigation, so the anchor guard is the other half.
  assert.match(asset('board.mjs'), /closest\?\.\('a'\)\)\s*e\.preventDefault\(\)/);
});

test('the shell carries no inline script or style for that CSP to block', () => {
  // The policy above has no 'unsafe-inline', and CSP source expressions match
  // URLs — an inline script has none, so 'self' cannot authorize it and
  // type="module" is not exempt. An inline bootstrap here therefore never runs
  // and the board sits on "Loading ballot…" with the violation only in the
  // console: green tests over a page that does not boot. This is the oracle for
  // that, so it asserts the shape rather than the presence of a string — the
  // shell's only <script> is the external module reference, with an empty body.
  const html = asset('index.html');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  assert.equal(scripts.length, 1, 'the shell must carry exactly one script tag');
  assert.match(scripts[0][1], /type="module"\s+src="\/assets\/boot\.mjs"/);
  assert.equal(scripts[0][2].trim(), '', 'that script tag must have no inline body');
  // style-src falls back to default-src 'self', so inline style would die too.
  assert.doesNotMatch(html, /<style[\s>]|\sstyle="/i);
});
