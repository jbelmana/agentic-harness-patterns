---
name: "ballot"
description: "Render a frontload-grade decision battery as a real HTML board in the browser instead of terminal chips — every question visible at once, tradeoffs beside their options, defaults flippable, open questions typeable, all answered in one pass. Writes a validated ballot.json, serves it from an ephemeral loopback server, and ends the turn until answers land or the board times out. Use for the full backward-walk product of frontload, spec ballot resolution, and audit-first Decision Ballots; a 1–2 question mid-flow ask stays as AskUserQuestion chips. Triggers on: '/ballot', 'fire a ballot', 'board this', 'render the battery as a board', 'put the decisions on a page'."
complexity: "medium"
tier: "standalone"
schema: 1
---

# /ballot — One Battery, Rendered as a Board

`AskUserQuestion` caps at four questions and gives each option a label. A
frontload-grade battery is often 6–10 decisions where the *tradeoff* is the
thing actually being weighed. This renders that battery as a page instead.

Same battery, same LOCKED-decision contract — better surface. It is not a
second opinion channel and not a place to re-open settled ground.

**Skill root** (`$B` below): runtime `~/.claude/skills/ballot/` — the symlink
the installer creates, and the only path that resolves when the rail fires from
another repo. Until that install has run the symlink does not exist; use the
canonical `skills/ballot/` inside this repo.

## When to fire

| Situation | Board? |
|---|---|
| Full `frontload` backward walk produced 3+ chips | ✅ Yes |
| Audit-first Decision Ballot before a rework epic | ✅ Yes |
| `/spec` ballot resolution, `/auto` pre-flight gate | ✅ Yes |
| Options whose tradeoffs need side-by-side reading | ✅ Yes |
| 1–2 questions mid-flow, or the `tri` shorthand | ❌ Chips |
| Any single question | ❌ Chips |
| User is not at the machine running this session | ❌ Chips — loopback only |

Below ~3 real decisions the board is slower than chips and reads as ceremony.

## The procedure

### (a) Write the ballot

Write `<scratchpad>/ballot-<slug>/ballot.json` conforming to
`$B/schema/ballot.schema.json` — **read that file for the field contract**, do
not work from memory. Minimum shape:

```json
{
  "meta": { "id": "slug", "title": "…", "task": "what this blocks",
            "rail": "frontload|spec|gsd|auto", "created": "<ISO>" },
  "questions": [{ "id": "q1", "class": "scope", "question": "…",
    "blast_radius": "high",
    "options": [{ "id": "a", "label": "…", "tradeoff": "what it gives up",
                  "recommended": true },
                { "id": "b", "label": "…", "tradeoff": "…" }] }],
  "defaults": [{ "id": "d1", "assumption": "…", "rationale": "…" }],
  "open":     [{ "id": "o1", "question": "…", "why_open": "…" }]
}
```

`tradeoff` is required on every option — an option with no stated cost is a
guess prompt, not a choice. `defaults` and `open` are optional.

A question may also carry `"gates": ["<plan-id>", …]` — the plan ids whose human
gate this question discharges. It is optional and inert unless step (b) is run
with `--phase-dir`; see **Gate inventory** below.

### (b) Validate — one retry, then chips

```
node $B/server/validate.mjs <dir>/ballot.json [--phase-dir <phase-dir>]
```

`0` valid · `1` invalid (errors on stderr, an unrepresented gate included) ·
`2` unreadable or bad usage. Non-zero → fix `ballot.json` and re-validate
**exactly once**. A second non-zero → fall back to `AskUserQuestion` chips this
turn; there is no third attempt. Never launch an unvalidated ballot.

⚠️ The server below speaks a **different** exit vocabulary. Do not conflate.

#### Gate inventory — `--phase-dir` (optional)

When the ballot is the gate for a GSD phase, point the validator at that phase's
directory and it will refuse a ballot that leaves a gate unrepresented, naming
each missing plan. Without the flag nothing changes.

A `*-PLAN.md` counts as a **gate** when its frontmatter carries any of:

| Frontmatter | Gate? |
|---|---|
| `autonomous: false` | ✅ the plan says it needs a human |
| `checkpoint: <anything>` | ✅ an explicit operator checkpoint |
| `gate: FLAG` / `gate: BALLOT` | ✅ confidence gate needing a human |
| `gate: AUTO (…)` | ❌ AUTO is the vocabulary's "no human needed" value |
| `autonomous: true`, no other key | ❌ |

A gate is represented when **some question** names its plan id in `gates`. Ids
come from the filename (`12-02-PLAN.md` → `12-02`), falling back to
frontmatter `phase`+`plan` for a bare `PLAN.md`. Naming a plan that holds no
gate is also an error — it means the ballot still believes in a gate the plan
dropped.

`gates` lives on **questions only**. A gate "represented" by a `defaults` entry
is precisely the failure this check exists for: a ballot once named one plan as
the sole blocker while a sibling plan quietly held a second gate.

### (c) Launch the server in the background

```
node $B/server/ballot-server.mjs \
  --ballot <dir>/ballot.json --out <dir>/answers.json [--timeout-min 30]
```

with `run_in_background: true` — the command detaches and its exit re-invokes
this session. `--out` is the answers **file**; `server-info.json` is written
beside it in the same directory.

**One `--out` directory per ballot.** `server-info.json` is named by the
directory, not by the ballot, so two boards sharing a directory clobber each
other's info file — including a live server's. Never reuse a directory while a
board is still up.

### (d) Read server-info.json, then open the board

`<dir>/server-info.json` (mode 0600) carries `url`, `port`, `token`, `pid`,
`ballot`, `out`, `started`. Missing → retry once after 2 s; still missing →
kill the job and fall back to chips.

```
open "<url>"
```

`open` is macOS-specific. On any other platform — or when it errors — the URL
printed in step (e) is the fallback: the user clicks or copies it themselves.

The URL embeds a bearer token (`?token=…`). Printing it to the launching
terminal is the point; putting it in chat, an issue, or a commit hands the
board over. Loopback-only makes it useless from another machine — it is still
not something to share.

### (e) Tell the user, then END THE TURN

One line plus the URL ("board is up: `<url>`") — **printing it to this terminal
is required**, it is the only fallback when `open` does not fire. Then stop. Do
not poll, do not narrate, do not start adjacent work — the server's exit
re-invokes the session with the answers.

### (f) On wake, branch on the exit code

| Exit | Meaning | Do |
|---|---|---|
| `0`, `questions` ballot | answers submitted | parse `answers.json`, bake LOCKED decisions |
| `0`, `custom_html` board | board seen and dismissed | acknowledgment only — bake **nothing** |
| `2` | timeout, no submission | re-present as chips |
| `3` | could not start | re-present as chips |
| other | crash — **or a board you killed** | chips, unless the kill was deliberate (see Degradation) |

There is no exit `1` — a `1` is a crash, never a success. **Never proceed
silently on any non-zero exit.** A board nobody answered is not consent.

`answers.json` is the POSTed body written verbatim — the server checks only its
**shape** (an object with an `answers` array; `defaults_overridden` /
`open_answers` arrays when present; `ballot_id` a string or null) and rejects
anything else with `400`. It never reshapes or re-validates the content, so its
top level is whatever the board built:

```json
{ "ballot_id": "<meta.id, or null>", "submitted_at": "<ISO>",
  "answers": [ … ], "defaults_overridden": [ … ], "open_answers": [ … ] }
```

Each `answers` entry carries `id` plus `choice` (single) or `choices` (multi,
when `multi: true`), `changed_from_recommended`, and `note` when one was typed.
The other two arrays report **deltas only**:

- `defaults_overridden` — defaults the user flipped. Absent ⇒ the default held.
- `open_answers` — open questions actually typed into. Absent ⇒ still open,
  not dropped.

**The recommended option is pre-selected on render**, so scroll-and-Send is
valid consent — and an untouched row therefore submits
`changed_from_recommended: false`. So does a question that carried no
recommendation at all. `false` is not evidence the row was read.

**`choice: null` means the question was never answered — never bake it.** A
question carrying no `recommended` option renders with nothing pre-selected, so
scrolling past it submits `choice: null` alongside
`changed_from_recommended: false`. That pair reads exactly like an accepted
recommendation and is the opposite: no decision was made. Treat any `null`
`choice` (or an empty `choices` on a `multi` question) as unanswered — re-ask it
as a chip in this turn's reply. The other `null` source is a `custom_html` board,
which posts `choice: null` for every question because none was ever rendered;
that whole payload is acknowledgment, not consent (see below).

Bake every answer as a LOCKED decision in the plan, spec, or close-out. Honor
both delta arrays: reading absence as "unanswered" re-asks a settled question;
reading it as "dropped" bakes a decision the user never made.

### (g) Persist and cite

Copy `ballot.json` + `answers.json` into the target repo's planning tree at
`ballots/YYYY-MM-DD-<slug>/`, falling back to `docs/ballots/YYYY-MM-DD-<slug>/`
when the repo has no planning tree. Cite that
path in the close-out — the ballot is the provenance for every LOCKED decision
it produced.

## Degradation

| Failure | Signal | Response |
|---|---|---|
| Server won't start | exit `3`, no URL ever | chips, this turn |
| `server-info.json` missing | absent after one 2 s retry | kill the job, chips |
| Browser won't open | `open` errors, or nothing appears | hand the user the URL once; unreachable → `kill <pid>`, chips |
| Timeout | exit `2` | chips — never proceed |
| User answers in the terminal first | they typed the decisions | `kill <pid>` from `server-info.json`, say the board was abandoned, bake the terminal answers — the kill wakes you on the `other` row, so do **not** re-ask what you just heard |

The timeout is **absolute from launch**, not idle-based: `--timeout-min`
(default 30) fires unconditionally and can land mid-typing. Expecting long
deliberation → raise it up front, not after.

## Ballot-authored markup — `preview_html` and `custom_html`

The board has exactly two markup sinks: an option's `preview_html`, rendered
inside that option's button, and a whole-board `custom_html`. The same rules
govern both.

- **The fragment is sanitized.** Scripts, event handlers, and
  `javascript:`/`vbscript:` URLs are stripped. Markup that cannot be made safe
  renders as *"`<label>` withheld — markup could not be made safe"*, where
  `<label>` is `preview` for an option preview and `board content` for a custom
  board.
- **Page CSP is `default-src 'self'; img-src 'self' data:`.** Remote images are
  dead by design; `data:` images work. Inline `<script>` never runs regardless
  of what the sanitizer caught.
- **Links do not navigate** — a delegated handler cancels every `<a>` click,
  because navigating away abandons unsent answers. Print URLs as text.
- **Self-contained or nothing** — inline `data:` images, no CDN, no fetch, no
  working links.

## `custom_html` — presentation only, never an answer channel

A board no question class covers — a diff to read, a layout to look at — may
set `custom_html`. It is **exclusive with `questions`**: the validator rejects a
ballot carrying both, and `"questions": []` must still be present because the
field is required.

**A custom board cannot carry a decision back.** The renderer takes the custom
branch and returns before the defaults panel and the open-question textareas
exist, so neither is rendered; and the fragment is inert — nothing inside it is
wired to board state, so a `<textarea>` placed there is typeable and its
contents are silently discarded. Submitting posts the shape above with
`answers`, `defaults_overridden` and `open_answers` all empty — and the server
exits `0` on it, indistinguishably from a real submission.

- **Never bake a LOCKED decision from a custom board's `answers.json`.** Exit
  `0` here means only *the operator saw the board and dismissed it*.
- **Anything that must come back as an answer goes in `questions`.** Use
  `custom_html` to show what a question card cannot show; put the decision
  itself on a normal questions ballot, with `preview_html` on the options when
  the choices need to be seen rather than described.
- **Leave `defaults` and `open` out of a custom ballot.** The header counts them
  (`N decisions · N defaults · N open`) while this branch renders neither, so
  the board announces rows that are not on the page.

## Anti-patterns

- **A board for one question** — that is a chip with a web server attached.
- **Proceeding on timeout** — the one failure this skill must never have. No
  answers means ask again, not assume.
- **Hand-editing `answers.json`** — it is the operator's record. Editing it
  forges consent; if you need a different answer, ask for one.
- **Two boards for one surface** — dribbling with extra steps, and they clobber
  each other's `server-info.json` when they share a directory.
- **Sharing the tokened URL** beyond the launching terminal — chat, an issue, a
  commit. It is a bearer credential; printing it in the terminal is step (e).
- **Baking decisions from a `custom_html` board** — its payload is empty by
  construction, so exit `0` there is acknowledgment, not consent.
- **Skipping validation** because the ballot "looks fine" — two seconds catches
  the duplicate-id and both-branches shapes that render an unanswerable page.
- **Narrating while the board is up** — step (e) ends the turn.

## Relationship to other rails

- **`frontload`** — produces the battery; this renders it. Steps 1–5 unchanged,
  step 6 fires a board instead of chips.
- **`interaction-style.md`** — chips stay the default; the board is the
  escalation when a battery outgrows four questions.
- **`/spec`, `/auto`** — set `meta.rail` to match; the board displays it.
