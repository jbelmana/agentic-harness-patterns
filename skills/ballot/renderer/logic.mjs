// Pure renderer logic for the ballot board. No DOM, no `node:` imports, no
// dependencies — the same file is served to the browser as /assets/logic.mjs
// and imported by the node test runner, so anything platform-specific belongs
// in the DOM modules instead.
//
// sanitizeFragment is defence-in-depth over ballot-authored markup (custom_html
// and option preview_html) before it reaches an innerHTML sink. It is NOT a
// general-purpose sanitizer and must not be reused as one — the board is a
// single-use loopback surface rendering a ballot the local session just wrote.
//
// KNOWN LIMITS, both accepted by ruling rather than overlooked:
//   1. No HTML-entity decoding, so `java&#9;script:` slips through.
//   2. The attribute passes are not tag-scoped, so an `on<word>=` sequence in
//      TEXT loses that phrase (`<code>const onClose = () =></code>` drops
//      `onClose = ()`). Scoping the passes to `<...>` tokens was measured and
//      rejected: `<[^>]*>` stops at the first `>`, so `<img src="x>"
//      onerror=alert(1)>` puts the handler outside every tag token and back in
//      the clear. Cosmetic loss beats a live handler.
//
// It errs toward over-stripping: an attribute merely spelled like a handler or a
// URL (`only="1"`, `href="/only=1"`) loses that segment. The unquoted-value
// class forbids quotes so the trim is always BALANCED — it can shorten a URL,
// but it can never swallow the closing quote and the tag's `>` and take the
// rest of the fragment with it.

const SCRIPT_BLOCK = /<script\b[\s\S]*?<\/script\s*>/gi;
const SCRIPT_TAG = /<\/?script\b[^>]*>/gi;
// Whitespace is not the only attribute separator. After `<svg`, a `/` followed
// by anything but `>` puts the tokenizer back in before-attribute-name state
// (`<svg/onload=alert(1)>`); and after a QUOTED value, any character other than
// whitespace, `/`, or `>` is a missing-whitespace-between-attributes parse error
// that also reconsumes there (`<a href="#"onclick=alert(1)>`). Both leave the
// next attribute live, so the class covers all three separators.
//
// The separator is CAPTURED, not consumed, and put back by the replacement:
// widening the class without restoring it eats the preceding attribute's closing
// quote and trades one corruption for another. `(?:[\w-]+:)?` admits the
// namespace form SVG anchors honour, `xlink:href`. The unquoted-value class
// excludes quotes because a legal unquoted HTML5 value cannot contain one —
// without that, `[^\s>]+` runs through the closing quote AND the tag's `>`,
// which is corruption rather than over-stripping.
const EVENT_ATTR = /(["'\s/])on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>"']+)/gi;
const URL_ATTR = /(["'\s/])(?:[\w-]+:)?(?:href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>"']+)/gi;
const SCRIPT_URL = /^(?:javascript|vbscript):/i;
const NON_PRINTING = /[^!-~]+/g;
const MAX_PASSES = 5;

// Strip the quotes and everything a URL parser ignores before sniffing the
// scheme: `java\tscript:` and `java script:` are the same vector. Only printable
// ASCII survives, which is all a scheme can legally contain. The result is a
// throwaway probe copy — never the value written back into the markup, so
// unwrapping more than a strict parser would can only ever strip more.
// Backticks are in the class for that reason: HTML5 does not treat one as a
// quote, but legacy IE did, so ``href=`javascript:...` `` is worth catching.
const unwrapUrl = (raw) => String(raw)
  .replace(/^\s*(["'`])([\s\S]*)\1\s*$/, '$2')
  .replace(NON_PRINTING, '');

export function sanitizeFragment(html = '') {
  let out = html == null ? '' : String(html);
  // A single pass is not enough: deleting the inner element of `<scr<script>`
  // rejoins the outer halves into a live `<script>`. Run to a fixpoint, capped
  // so a pathological input cannot spin.
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const before = out;
    out = out
      .replace(SCRIPT_BLOCK, '')
      .replace(SCRIPT_TAG, '')
      .replace(EVENT_ATTR, '$1')
      .replace(URL_ATTR, (match, sep, value) => (SCRIPT_URL.test(unwrapUrl(value)) ? sep : match));
    if (out === before) return out;
  }
  // Clean markup settles on the first pass. Still mutating at the cap means a
  // nest deep enough that we cannot prove the result inert — fail closed rather
  // than hand a half-stripped fragment to an innerHTML sink.
  return '';
}

const BLAST_RANK = { high: 0, med: 1, low: 2 };
// An unrecognised blast radius sorts last rather than poisoning the comparator
// with NaN, which would silently degrade the whole sort to class order.
const rankOf = (q) => BLAST_RANK[q?.blast_radius] ?? 3;
const classOf = (q) => (typeof q?.class === 'string' ? q.class : '');

export function orderQuestions(questions) {
  if (!Array.isArray(questions)) return [];
  return questions
    .map((q, i) => ({ q, i }))
    .sort((a, b) => (rankOf(a.q) - rankOf(b.q))
      || classOf(a.q).localeCompare(classOf(b.q))
      || (a.i - b.i))
    .map(({ q }) => q);
}

// A bare string would index into characters — `chosen[0]` on 'o-tmp' is 'o',
// which submits silently wrong data rather than failing.
const asArray = (value) => {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || value === '' ? [] : [value];
};

const recommendedId = (q) => (Array.isArray(q?.options) ? q.options : [])
  .find((o) => o?.recommended === true)?.id;

function buildAnswer(q, chosen, note) {
  const rec = recommendedId(q);
  const answer = { id: q.id };
  if (q.multi) {
    // Copy: `chosen` is the caller's live selections array, and a payload that
    // aliases board state stops being a snapshot the moment anyone clicks again.
    answer.choices = [...chosen];
    // Binding semantics: unchanged only when the selection is exactly the one
    // recommended option. Selecting nothing is a change, not an acceptance.
    answer.changed_from_recommended = rec === undefined
      ? false
      : !(chosen.length === 1 && chosen[0] === rec);
  } else {
    const choice = chosen[0] ?? null;
    answer.choice = choice;
    answer.changed_from_recommended = rec === undefined ? false : choice !== rec;
  }
  if (note) answer.note = note;
  return answer;
}

// `state` is the renderer's live board state, and this destructure IS its
// contract: selections {qid: string[]}, notes {qid: string},
// defaultsFlipped {did: {stance, note}}, openTexts {oid: string}.
export function buildAnswersPayload(ballot, state) {
  const { selections = {}, notes = {}, defaultsFlipped = {}, openTexts = {} } = state || {};
  const questions = Array.isArray(ballot?.questions) ? ballot.questions : [];
  return {
    ballot_id: ballot?.meta?.id ?? null,
    submitted_at: new Date().toISOString(),
    answers: questions.map((q) => buildAnswer(
      q,
      asArray(selections[q.id]),
      String(notes[q.id] ?? '').trim(),
    )),
    // Spread first so the map key stays authoritative: a value-side `id` must
    // never outrank the key that identifies which default was flipped.
    defaults_overridden: Object.entries(defaultsFlipped)
      .map(([id, v]) => ({ ...v, id })),
    open_answers: Object.entries(openTexts)
      .filter(([, text]) => typeof text === 'string' && text.trim())
      .map(([id, text]) => ({ id, text: text.trim() })),
  };
}

export function summarizeChanges(payload) {
  const answers = Array.isArray(payload?.answers) ? payload.answers : [];
  const overridden = Array.isArray(payload?.defaults_overridden)
    ? payload.defaults_overridden.length
    : 0;
  const changed = answers.filter((a) => a?.changed_from_recommended).length;
  return { accepted: answers.length - changed, changed, overridden };
}
