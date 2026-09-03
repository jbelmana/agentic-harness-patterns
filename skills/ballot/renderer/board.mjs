// Page-level DOM for the ballot board: the shared element helpers, the header,
// the defaults panel, the open-questions section, and the submit-bar scaffold.
// Question cards live in ./render.mjs — the split is a 200-LOC one, so keep the
// seam at "page furniture vs. a question card" rather than moving pieces across
// it opportunistically.
//
// Nothing here decides anything: every function either builds nodes or writes a
// keystroke into `state`. All comparison, ordering, and payload logic stays in
// ./logic.mjs so it remains unit-testable without a DOM.
import { sanitizeFragment } from './logic.mjs';

/**
 * Build an element. `text` always goes through textContent — the board renders
 * ballot-authored strings, and an innerHTML sink here would defeat the point of
 * sanitizing the two fields that genuinely need markup.
 */
export function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/**
 * Fill `node` with sanitized markup, or with a muted placeholder when the
 * sanitizer fails closed.
 *
 * sanitizeFragment returns '' both for input it could not prove inert (the
 * pass-cap bail-out) and for input that was entirely strippable. The two are
 * indistinguishable from here and want the same treatment: say the content was
 * withheld. An empty div would instead read as "this option has no preview",
 * which is a quieter and worse lie.
 */
export function sanitizeInto(node, html, label = 'preview') {
  const clean = sanitizeFragment(html);
  if (!clean && String(html ?? '').trim()) {
    node.appendChild(el('p', 'withheld', `${label} withheld — markup could not be made safe`));
    return node;
  }
  node.innerHTML = clean;
  // sanitizeFragment strips javascript:/vbscript: URLs but leaves ordinary
  // http(s) hrefs by design, and the page CSP governs subresources — it does
  // NOT block navigation.
  //
  // The guard goes on every sanitizeInto target, which is BOTH of the board's
  // markup sinks: an option's preview_html and a whole-board custom_html
  // (render.mjs). The reason is the same in each — a link navigates the one
  // page the board lives on, abandoning every unsent answer — so a custom
  // board cannot offer a working link either. That is deliberate, not an
  // oversight of the escape hatch: losing unsent answers is the worse failure,
  // and a ballot author who needs a URL read can print it as text.
  //
  // Only the default action is swallowed. Inside a preview the click still
  // selects the option the preview sits inside.
  node.addEventListener('click', (e) => {
    if (e?.target?.closest?.('a')) e.preventDefault();
  });
  return node;
}

export function header(ballot) {
  const meta = ballot?.meta || {};
  const counts = [
    (ballot?.questions || []).length,
    (ballot?.defaults || []).length,
    (ballot?.open || []).length,
  ];
  const head = el('header', 'board-head');
  head.appendChild(el('h1', 'title', meta.title || 'Ballot'));
  if (meta.task) head.appendChild(el('p', 'task', meta.task));
  const chips = el('div', 'chips');
  if (meta.rail) chips.appendChild(el('span', 'chip rail', meta.rail));
  if (meta.repo) chips.appendChild(el('span', 'chip repo', meta.repo));
  head.appendChild(chips);
  head.appendChild(el('p', 'counts',
    `${counts[0]} decisions · ${counts[1]} defaults · ${counts[2]} open`));
  return head;
}

/**
 * One default row. Collapsed by default and silent unless challenged — that is
 * the whole contract of a default, and the flip is what turns it into a payload
 * entry (`defaultsFlipped[id] = {stance: 'overridden', note}`).
 */
function defaultRow(d, state) {
  const row = el('div', 'default');
  row.dataset.did = d.id;
  row.appendChild(el('p', 'assumption', d.assumption));
  row.appendChild(el('p', 'rationale', d.rationale));

  const note = el('textarea', 'default-note');
  note.placeholder = 'What should happen instead?';
  note.setAttribute('aria-label', `What should happen instead of: ${d.assumption}`);
  note.hidden = true;
  const flip = el('button', 'challenge', 'Challenge this');
  flip.type = 'button';
  flip.setAttribute('aria-pressed', 'false');

  flip.addEventListener('click', () => {
    const on = !row.classList.contains('flipped');
    row.classList.toggle('flipped', on);
    note.hidden = !on;
    flip.textContent = on ? 'Keep the default' : 'Challenge this';
    flip.setAttribute('aria-pressed', String(on));
    // Un-flipping deletes the key rather than writing a 'kept' stance: the
    // payload lists overrides only, so a lingering key would report a default
    // as challenged after the operator changed their mind.
    if (on) {
      state.defaultsFlipped[d.id] = { stance: 'overridden', note: note.value.trim() };
      note.focus();
    } else {
      delete state.defaultsFlipped[d.id];
    }
  });
  note.addEventListener('input', () => {
    const entry = state.defaultsFlipped[d.id];
    if (entry) entry.note = note.value.trim();
  });

  row.append(flip, note);
  return row;
}

export function defaultsPanel(defaults, state) {
  const rows = Array.isArray(defaults) ? defaults : [];
  if (!rows.length) return null;
  const panel = el('details', 'defaults');
  panel.appendChild(el('summary', null,
    `${rows.length} default${rows.length === 1 ? '' : 's'} — applied unless challenged`));
  rows.forEach((d) => panel.appendChild(defaultRow(d, state)));
  return panel;
}

export function openSection(open, state) {
  const rows = Array.isArray(open) ? open : [];
  if (!rows.length) return null;
  const section = el('section', 'open');
  section.appendChild(el('h2', null, 'Still open'));
  rows.forEach((o) => {
    const wrap = el('div', 'open-q');
    wrap.appendChild(el('p', 'open-question', o.question));
    if (o.why_open) wrap.appendChild(el('p', 'why-open', o.why_open));
    const answer = el('textarea', 'open-answer');
    answer.dataset.oid = o.id;
    answer.placeholder = 'Answer, or leave blank to keep it open';
    answer.setAttribute('aria-label', `Answer to: ${o.question}`);
    // Untrimmed on the way in: buildAnswersPayload trims and drops blanks, and
    // trimming per keystroke would eat the space between two words as it is typed.
    answer.addEventListener('input', () => { state.openTexts[o.id] = answer.value; });
    wrap.appendChild(answer);
    section.appendChild(wrap);
  });
  return section;
}

/**
 * Sticky footer scaffold. The handler is attached by ./submit.mjs — this file
 * knows nothing about the wire, and submit.mjs knows nothing about layout.
 */
export function submitBar(total) {
  const bar = el('footer');
  bar.id = 'submit-bar';
  bar.appendChild(el('span', 'progress', `0 of ${total} answered`));
  const button = el('button', 'submit', 'Send answers');
  button.type = 'button';
  bar.appendChild(button);
  return bar;
}
