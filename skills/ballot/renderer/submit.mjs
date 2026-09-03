// Submit flow for the ballot board: progress accounting, the POST to /answers,
// and the two terminal states (sent view, retryable error). Everything the
// payload means is decided in ./logic.mjs — this file moves bytes and swaps
// nodes.
//
// Failure is never terminal here. The server answers 400 (bad json), 403 (stale
// token), or 413 (over the 1 MB cap), and in all three cases nothing was
// written: the board stays live and the button re-enables so the operator can
// retry instead of losing every answer they just entered.
import { buildAnswersPayload, summarizeChanges } from './logic.mjs';

const REASONS = {
  400: 'The server could not read the answers',
  403: 'The board token is no longer valid',
  413: 'The answers are too large to send',
};

const answeredCount = (ballot, state) => (Array.isArray(ballot?.questions) ? ballot.questions : [])
  .filter((q) => (state?.selections?.[q.id] || []).length > 0).length;

function showError(bar, message) {
  let slot = bar.querySelector('.submit-error');
  if (!message) {
    if (slot) slot.remove();
    return;
  }
  if (!slot) {
    slot = document.createElement('p');
    slot.className = 'submit-error';
    slot.setAttribute('role', 'alert');
    bar.appendChild(slot);
  }
  slot.textContent = message;
}

/**
 * Terminal success view. The board is replaced wholesale rather than disabled:
 * the server exits ~500 ms after the 200, so a still-clickable board would be
 * clicking at a socket that is already gone.
 */
function showSent(payload) {
  const { accepted, changed, overridden } = summarizeChanges(payload);
  const sent = document.createElement('section');
  sent.className = 'sent';
  const heading = document.createElement('h1');
  heading.textContent = 'Answers sent';
  const line = document.createElement('p');
  line.className = 'sent-summary';
  line.textContent = `${accepted} accepted as recommended · ${changed} changed · `
    + `${overridden} defaults overridden — answers sent, back to the terminal.`;
  sent.append(heading, line);
  document.body.replaceChildren(sent);
}

async function send(ballot, mount, token, bar, button) {
  // Built at click time, not held live: the payload must be a snapshot of the
  // board as it reads right now — and from the ballot the BOARD rendered, which
  // on the custom_html branch is one with no questions. A ballot carrying both
  // (rejected by validate.mjs, reachable only by hand-editing) would otherwise
  // submit `choice: null` for questions no card was ever built for.
  const payload = buildAnswersPayload(mount.__ballotView || ballot, mount.__ballotState || {});
  button.disabled = true;
  showError(bar, '');

  let res;
  try {
    res = await fetch('/answers', {
      method: 'POST',
      headers: { 'X-Ballot-Token': token || '', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    button.disabled = false;
    return showError(bar, `Could not reach the ballot server (${e.message}). `
      + 'Nothing was sent — your answers are still here, try again.');
  }

  if (!res.ok) {
    button.disabled = false;
    // The status is surfaced verbatim: a 403 and a 413 need different operator
    // responses, and "submission failed" tells them apart for neither.
    return showError(bar, `${REASONS[res.status] || 'The server refused the answers'} `
      + `(HTTP ${res.status}). Nothing was sent — your answers are still here, try again.`);
  }
  return showSent(payload);
}

/**
 * Attach the submit handler and keep the progress counter honest.
 * @param {object} ballot — the same ballot renderBoard drew
 * @param {HTMLElement} mount — carries `__ballotState` from renderBoard
 * @param {string} token — bearer token from the URL; sent as X-Ballot-Token
 */
export function wireSubmit(ballot, mount, token) {
  const bar = document.getElementById('submit-bar');
  if (!bar) return;
  const progress = bar.querySelector('.progress');
  const button = bar.querySelector('button.submit');
  if (!progress || !button) return;

  // Same view the payload is built from, so the counter and the payload can
  // never disagree about how many questions exist.
  const view = mount.__ballotView || ballot;
  const total = (Array.isArray(view?.questions) ? view.questions : []).length;
  progress.setAttribute('aria-live', 'polite');
  const refresh = () => {
    const done = answeredCount(view, mount.__ballotState);
    progress.textContent = `${done} of ${total} answered`;
    bar.classList.toggle('complete', total > 0 && done === total);
  };

  // Delegated on the mount so nothing has to notify the footer: option handlers
  // run on the target first, so the counter always reads post-update state.
  mount.addEventListener('click', refresh);
  mount.addEventListener('input', refresh);
  button.addEventListener('click', () => send(ballot, mount, token, bar, button));
  refresh();
}
