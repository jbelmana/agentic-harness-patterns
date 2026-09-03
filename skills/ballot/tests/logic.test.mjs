// Renderer pure-logic tests. Kept out of ballot.test.mjs (schema + CLI) because
// the merged file would clear the 200-effective-line ceiling; the runner glob
// skills/ballot/tests/*.test.mjs already picks this up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  sanitizeFragment, orderQuestions, buildAnswersPayload, summarizeChanges,
} from '../renderer/logic.mjs';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url)));

test('sanitizeFragment strips scripts and handlers', () => {
  const dirty = `<div onclick="x()"><script>evil()</script><a href="javascript:y()">z</a><b>ok</b></div>`;
  const clean = sanitizeFragment(dirty);
  assert.ok(!/script|onclick|javascript:/i.test(clean));
  assert.ok(clean.includes('<b>ok</b>'));
});

test('sanitizeFragment re-runs until stable, so a split tag cannot reassemble', () => {
  // One pass over `<scr<script>ipt>` deletes the inner element and rejoins the
  // outer halves into a live `<script>`. Only a fixpoint loop catches it.
  assert.ok(!/<script/i.test(sanitizeFragment('<scr<script>ipt>evil()</script>ipt>')));
  assert.ok(!/onclick/i.test(sanitizeFragment('<div onclick=" onclick=x() ">hi</div>')));
  // Deeper than the pass cap: must fail closed, never emit a half-stripped tag.
  const nested = `${'<scr'.repeat(9)}<script>evil()</script>${'ipt>'.repeat(9)}`;
  assert.ok(!/<script/i.test(sanitizeFragment(nested)));
});

test('sanitizeFragment catches unquoted and whitespace-obfuscated script URLs', () => {
  assert.ok(!/javascript:/i.test(sanitizeFragment('<a href=javascript:evil()>z</a>')));
  assert.ok(!/script/i.test(sanitizeFragment('<img src="java\tscript:evil()">')));
  assert.ok(!/vbscript:/i.test(sanitizeFragment(`<a href='vbscript:evil()'>z</a>`)));
  // Not a quote in HTML5, but legacy IE read it as one.
  assert.ok(!/javascript:/i.test(sanitizeFragment('<a href=`javascript:evil()`>z</a>')));
  // `/` separates attributes too, so `<svg/onload=…>` is a live handler.
  assert.ok(!/onload/i.test(sanitizeFragment('<svg/onload=alert(1)>')));
  assert.ok(!/onerror/i.test(sanitizeFragment('<img/onerror=alert(1) src=x>')));
  assert.ok(!/javascript:/i.test(sanitizeFragment('<a/href=javascript:evil()>z</a>')));
});

test('a quote ends an attribute, so a no-space next attribute still strips', () => {
  // After a quoted value, anything but whitespace / `/` / `>` is a parse error
  // that reconsumes in before-attribute-name state — the next attribute is live.
  const vectors = [
    '<a href="#"onclick=alert(1)>z</a>',
    `<a href='#'onclick=alert(1)>z</a>`,
    '<img src="x"onerror=alert(1)>',
    '<a title="t"href="javascript:evil()">z</a>',
    '<svg><a xlink:href="javascript:alert(1)">z</a></svg>', // namespace prefix
  ];
  for (const v of vectors) {
    const clean = sanitizeFragment(v);
    assert.ok(!/\bon\w+\s*=/i.test(clean), `handler survived: ${clean}`);
    assert.ok(!/javascript:/i.test(clean), `script url survived: ${clean}`);
    assert.equal((clean.match(/"/g) || []).length % 2, 0, `unbalanced quotes: ${clean}`);
  }
});

test('a benign URL is trimmed at worst, never corrupted', () => {
  // No handler-shaped segment in the URL: byte-identical.
  const untouched = '<p>See <a href="https://docs.test/two=1">docs</a> for details.</p>';
  assert.equal(sanitizeFragment(untouched), untouched);
  // `/one=` does collide with the `on<word>=` shape, so that segment goes — but
  // the trim must stay balanced. This is the regression guard: while the
  // unquoted-value class allowed quotes, this ate the closing quote AND the
  // tag's `>`, taking every following element with it.
  const collide = '<img src="/one=2.png"> trailing text and <b>more markup</b>';
  const out = sanitizeFragment(collide);
  assert.equal((out.match(/"/g) || []).length % 2, 0, `unbalanced quotes: ${out}`);
  assert.ok(out.endsWith('> trailing text and <b>more markup</b>'), out);
});

test('sanitizeFragment keeps benign markup and tolerates junk input', () => {
  const preview = fx('multi').questions[2].options[0].preview_html;
  assert.equal(sanitizeFragment(preview), preview);
  assert.equal(sanitizeFragment('<a href="https://x.test/a?b=1">ok</a>'),
    '<a href="https://x.test/a?b=1">ok</a>');
  assert.equal(sanitizeFragment(), '');
  assert.equal(sanitizeFragment(null), '');
});

test('orderQuestions ranks high blast first, stable within rank', () => {
  const qs = [
    { id: 'a', class: 'naming', blast_radius: 'low' },
    { id: 'b', class: 'irreversibility', blast_radius: 'high' },
    { id: 'c', class: 'scope', blast_radius: 'high' },
  ];
  assert.deepEqual(orderQuestions(qs).map(q => q.id), ['b', 'c', 'a']);
});

test('orderQuestions breaks ties by class, then by original index', () => {
  // Index order and class order disagree here, so this pins the class tiebreak
  // that the ranking case above cannot distinguish from plain index order.
  const qs = [
    { id: 'a', class: 'scope', blast_radius: 'high' },
    { id: 'b', class: 'irreversibility', blast_radius: 'high' },
    { id: 'c', class: 'scope', blast_radius: 'high' },
    { id: 'd', class: 'scope', blast_radius: 'med' },
  ];
  assert.deepEqual(orderQuestions(qs).map(q => q.id), ['b', 'a', 'c', 'd']);
});

test('orderQuestions returns a new array and leaves the input untouched', () => {
  const qs = fx('multi').questions;
  const before = qs.map(q => q.id);
  const out = orderQuestions(qs);
  assert.notEqual(out, qs);
  assert.deepEqual(qs.map(q => q.id), before);
  assert.deepEqual(out.map(q => q.id), ['q-scope', 'q-packs', 'q-spend']);
});

test('buildAnswersPayload flags deviation from recommended', () => {
  const ballot = JSON.parse(JSON.stringify(fx('minimal')));
  const [q] = ballot.questions;
  const rec = q.options.find(o => o.recommended).id;
  const other = q.options.find(o => !o.recommended).id;
  const state = { selections: { [q.id]: [other] }, notes: {}, defaultsFlipped: {}, openTexts: {} };
  const p = buildAnswersPayload(ballot, state);
  assert.equal(p.ballot_id, ballot.meta.id);
  assert.equal(p.answers[0].choice, other);
  assert.equal(p.answers[0].changed_from_recommended, true);
  state.selections[q.id] = [rec];
  assert.equal(buildAnswersPayload(ballot, state).answers[0].changed_from_recommended, false);
});

test('buildAnswersPayload stamps a parseable ISO submitted_at', () => {
  const p = buildAnswersPayload(fx('minimal'), {});
  assert.match(p.submitted_at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.ok(Number.isFinite(Date.parse(p.submitted_at)));
});

test('buildAnswersPayload never flags a question that has no recommended option', () => {
  const ballot = fx('multi');
  const byId = Object.fromEntries(buildAnswersPayload(ballot, {
    selections: { 'q-packs': ['o-auto'] },
  }).answers.map(a => [a.id, a]));
  assert.equal(byId['q-packs'].changed_from_recommended, false);
  assert.deepEqual(byId['q-packs'].choices, ['o-auto']);
  // Single-select with no selection AND no recommendation is likewise unchanged.
  const nq = fx('minimal');
  delete nq.questions[0].options[0].recommended;
  assert.equal(buildAnswersPayload(nq, {}).answers[0].changed_from_recommended, false);
});

test('multi changed_from_recommended is NOT(chosen is exactly the recommended one)', () => {
  const ballot = fx('multi');
  const q = ballot.questions.find(x => x.multi);
  q.options[0].recommended = true;
  const rec = q.options[0].id;
  const changedFor = (choices) => buildAnswersPayload(ballot, { selections: { [q.id]: choices } })
    .answers.find(a => a.id === q.id).changed_from_recommended;
  assert.equal(changedFor([rec]), false);
  assert.equal(changedFor([rec, q.options[1].id]), true);
  assert.equal(changedFor([q.options[1].id]), true);
  assert.equal(changedFor([]), true, 'selecting nothing is not accepting the recommendation');
});

test('buildAnswersPayload trims notes and omits the key when blank', () => {
  const ballot = fx('minimal');
  const id = ballot.questions[0].id;
  const withNote = buildAnswersPayload(ballot, {
    selections: { [id]: ['o-tmp'] }, notes: { [id]: '  keep the scratch out of git  ' },
  });
  assert.deepEqual(withNote.answers[0], {
    id, choice: 'o-tmp', changed_from_recommended: false, note: 'keep the scratch out of git',
  });
  const blank = buildAnswersPayload(ballot, { selections: { [id]: ['o-tmp'] }, notes: { [id]: '   ' } });
  assert.deepEqual(Object.keys(blank.answers[0]), ['id', 'choice', 'changed_from_recommended']);
});

test('buildAnswersPayload maps flipped defaults and non-empty open answers', () => {
  const p = buildAnswersPayload(fx('multi'), {
    defaultsFlipped: { 'd-theme': { stance: 'overridden', note: 'force dark' } },
    openTexts: { 'op-mobile': '  yes, tunnel it  ', 'op-blank': '   ' },
  });
  assert.deepEqual(p.defaults_overridden, [{ id: 'd-theme', stance: 'overridden', note: 'force dark' }]);
  assert.deepEqual(p.open_answers, [{ id: 'op-mobile', text: 'yes, tunnel it' }]);
  // The map key identifies the default; a value-side id must not outrank it.
  const clobbered = buildAnswersPayload(fx('minimal'), {
    defaultsFlipped: { 'd-port': { stance: 'overridden', note: 'n', id: 'spoofed' } },
  });
  assert.equal(clobbered.defaults_overridden[0].id, 'd-port');
});

test('buildAnswersPayload survives an empty questions array and stray selection shapes', () => {
  const empty = buildAnswersPayload(fx('custom-html'), {});
  assert.deepEqual(empty.answers, []);
  assert.deepEqual(summarizeChanges(empty), { accepted: 0, changed: 0, overridden: 0 });
  // A bare string must not be indexed into characters — `chosen[0]` would be 'o'.
  const ballot = fx('minimal');
  const id = ballot.questions[0].id;
  assert.equal(buildAnswersPayload(ballot, { selections: { [id]: 'o-tmp' } }).answers[0].choice, 'o-tmp');
  assert.equal(buildAnswersPayload(ballot, {}).answers[0].choice, null);
  assert.equal(buildAnswersPayload(ballot).answers[0].choice, null);
  assert.equal(buildAnswersPayload(ballot, null).answers[0].choice, null);
  // The payload is a snapshot: later board clicks must not reach back into it.
  const live = ['o-frontload'];
  const p = buildAnswersPayload(fx('multi'), { selections: { 'q-packs': live } });
  live.push('o-spec');
  assert.deepEqual(p.answers.find(a => a.id === 'q-packs').choices, ['o-frontload']);
});

test('summarizeChanges counts accepted vs changed vs overridden', () => {
  const p = { answers: [{ changed_from_recommended: true }, { changed_from_recommended: false }],
    defaults_overridden: [{ id: 'd1' }], open_answers: [] };
  assert.deepEqual(summarizeChanges(p), { accepted: 1, changed: 1, overridden: 1 });
  assert.deepEqual(summarizeChanges({}), { accepted: 0, changed: 0, overridden: 0 });
});
