'use strict';
// relay-args.js — argument validation for the relay ledger helpers.
//
// WHY THIS EXISTS (2026-08-27): every options-taking helper in relay-chain.js
// destructured its trailing parameter inline. Passing a scalar positionally
// destructures to `undefined` on every field and the call SUCCEEDS. The failure
// mode is inverted -- omitting the argument throws, mistyping it is silent.
//
// Measured, not theorised:
//   markDone(c, id, 2)      -> task transitioned to 'done', gen: undefined,
//                              JSON.stringify DROPPED the key, validateChain ok.
//                              A live chain carried 4 tasks transitioned with no gen.
//   addTask(chain, 'T9')    -> appended a GHOST TASK, id/desc/acceptance all
//                              undefined, and validateChain returned ok on it.
//   claimBaton(chain,'tok') -> silent once the baton is offered.
//
// Six helpers were silent. Extracted here (rather than inlined) because
// relay-chain.js sits at the 200-LOC hard rule and validation is a distinct
// responsibility from transition logic.
//
// Evidence: a harness research pass found six validators failing silently.
// Ruling:   fix all silent helpers, caller sweep first.

// Allowlist gate. Rejects a non-object (the positional-call case) and rejects
// unknown keys, so a typo fails at the call site rather than silently on disk.
function opts(got, allowed, fn) {
  if (got === null || typeof got !== 'object' || Array.isArray(got)) {
    throw new TypeError(
      `${fn}: expected an options object like { ${allowed[0]} }, got ${
        Array.isArray(got) ? 'array' : typeof got}. ` +
      'Positional arguments are silently dropped — pass an object.');
  }
  const unknown = Object.keys(got).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw new TypeError(
      `${fn}: unknown option(s) ${unknown.join(', ')}. Expected: ${allowed.join(', ')}`);
  }
  return got;
}

// `gen` reaches disk as a task field and feeds generation accounting, so a
// non-integer is a corrupt record, not a cosmetic slip. Named separately because
// the positional-call case yields `undefined` specifically, and that message is
// the one an operator needs to see.
function requireGen(gen, fn) {
  if (!Number.isInteger(gen)) {
    throw new TypeError(`${fn}: gen must be an integer, got ${
      gen === undefined ? 'undefined (positional call?)' : JSON.stringify(gen)}`);
  }
  return gen;
}

module.exports = { opts, requireGen };
