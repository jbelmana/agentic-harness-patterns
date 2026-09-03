// Ballot board renderer — question cards, options, previews, and the top-level
// renderBoard the page shell imports. Page furniture (header, defaults, open
// questions, submit bar) lives in ./board.mjs; ordering and payload shape live
// in ./logic.mjs. This file only turns a ballot into nodes and keystrokes into
// `state`.
//
// The board is a single-use local surface: no framework, no build step, no
// reactive layer. State is the plain object buildAnswersPayload consumes, kept
// on `mount.__ballotState` so ./submit.mjs can read it at submit time without a
// second wiring path between the two modules.
import { orderQuestions } from './logic.mjs';
import { el, sanitizeInto, header, defaultsPanel, openSection, submitBar } from './board.mjs';

const setSelected = (btn, on) => {
  btn.classList.toggle('selected', on);
  btn.setAttribute('aria-pressed', String(on));
};

// Read selection back out of the DOM rather than tracking it in parallel: the
// `.selected` class is what the operator can actually see, so sourcing the
// payload from it makes a divergence between the two impossible by construction.
const syncSelection = (card, q, state) => {
  state.selections[q.id] = [...card.querySelectorAll('button.option.selected')]
    .map((b) => b.dataset.oid);
};

function toggle(q, btn, state) {
  const card = btn.closest('article.question');
  if (q.multi) {
    setSelected(btn, !btn.classList.contains('selected'));
  } else {
    // Single-select: re-clicking the current choice is a no-op rather than a
    // deselect. Leaving a question answerless by mis-click is the worse outcome
    // — an empty single-select submits `choice: null`.
    card.querySelectorAll('button.option').forEach((b) => setSelected(b, b === btn));
  }
  syncSelection(card, q, state);
}

function optionButton(q, o, state) {
  const btn = el('button', 'option');
  btn.type = 'button';
  btn.dataset.oid = o.id;
  btn.setAttribute('aria-pressed', 'false');

  const head = el('div', 'option-head');
  head.appendChild(el('span', 'option-label', o.label));
  if (o.recommended === true) head.appendChild(el('span', 'recommended', 'Recommended'));
  btn.appendChild(head);
  // The tradeoff is always visible, never a tooltip or a disclosure. A ballot
  // whose costs are one interaction away is a ballot answered without them.
  btn.appendChild(el('p', 'tradeoff', o.tradeoff));
  if (o.preview_html) {
    btn.appendChild(sanitizeInto(el('div', 'preview'), o.preview_html, 'preview'));
  }

  btn.addEventListener('click', () => toggle(q, btn, state));
  return btn;
}

/**
 * One question card: class + blast badges, the question, the option row, and an
 * optional note field. Seeds `state.selections[q.id]` — with the recommended
 * option pre-selected when there is one, so accepting the whole ballot is a
 * single click on Send rather than N clicks reproducing the recommendation.
 */
export function questionCard(q, state) {
  const card = el('article', 'question');
  card.dataset.qid = q.id;

  const head = el('div', 'q-head');
  head.appendChild(el('span', 'class-label', q.class));
  head.appendChild(el('span', `blast blast-${q.blast_radius}`, `${q.blast_radius} blast`));
  if (q.multi) head.appendChild(el('span', 'multi-hint', 'pick any'));
  card.appendChild(head);
  card.appendChild(el('h2', 'q-text', q.question));

  const row = el('div', 'options');
  // The recommended button is captured while building instead of re-queried by
  // id: option ids are ballot-authored and would need CSS escaping in a selector.
  let recommended = null;
  (Array.isArray(q.options) ? q.options : []).forEach((o) => {
    const btn = optionButton(q, o, state);
    if (o?.recommended === true) recommended = btn;
    row.appendChild(btn);
  });
  card.appendChild(row);

  state.selections[q.id] = [];
  if (recommended) {
    setSelected(recommended, true);
    syncSelection(card, q, state);
  }

  if (q.allow_note) {
    const note = el('input', 'q-note');
    note.type = 'text';
    note.dataset.qid = q.id;
    note.placeholder = 'Add a note (optional)';
    // A placeholder is not an accessible name — it disappears on first keystroke.
    note.setAttribute('aria-label', `Note on: ${q.question}`);
    note.addEventListener('input', () => { state.notes[q.id] = note.value; });
    card.appendChild(note);
  }
  return card;
}

/**
 * Render the whole board into `mount` and return the state object it maintains.
 * @param {object} ballot — a validated ballot (see ../schema/ballot.schema.json)
 * @param {HTMLElement} mount — cleared before rendering; carries `__ballotState`
 */
export function renderBoard(ballot, mount) {
  const state = { selections: {}, notes: {}, defaultsFlipped: {}, openTexts: {} };
  mount.__ballotState = state;
  mount.replaceChildren();

  const questions = Array.isArray(ballot?.questions) ? ballot.questions : [];
  // The ballot as the SUBMIT path must see it. Normally the ballot itself; on
  // the custom branch, one with no questions.
  mount.__ballotView = ballot;
  mount.appendChild(header(ballot));

  if (ballot?.custom_html) {
    // Escape hatch for boards no question class covers. The submit bar is still
    // rendered — even a withheld custom board must be dismissable, or the
    // operator is left with a dead page and a server counting down to timeout.
    //
    // Defence in depth against a ballot carrying BOTH custom_html and questions:
    // validate.mjs rejects that shape, but a hand-edited ballot that bypassed
    // the validator would otherwise submit `choice: null` for every question no
    // card was ever built for. Zero on the counter, zero in the payload.
    mount.__ballotView = { ...ballot, questions: [] };
    mount.appendChild(sanitizeInto(el('section', 'custom'), ballot.custom_html, 'board content'));
    mount.appendChild(submitBar(0));
    return state;
  }

  const list = el('div', 'questions');
  // Highest blast radius first: the decisions that are expensive to get wrong
  // get the attention that is still fresh.
  orderQuestions(questions).forEach((q) => list.appendChild(questionCard(q, state)));
  mount.appendChild(list);

  const panel = defaultsPanel(ballot?.defaults, state);
  if (panel) mount.appendChild(panel);
  const open = openSection(ballot?.open, state);
  if (open) mount.appendChild(open);

  mount.appendChild(submitBar(questions.length));
  return state;
}
