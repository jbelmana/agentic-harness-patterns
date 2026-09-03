# agentic-harness-patterns

Patterns from a production agent harness — the systems that let one engineer run a multi-product portfolio with AI coding agents, extracted and curated from a private monorepo (fresh-history publication).

The thesis: **agent reliability is an engineering problem, not a prompting problem.** Everything here enforces behavior with code — deterministic hooks that block at tool-time, decision gates rendered as real UI, and session-handoff machinery for the hardest practical constraint in long-horizon agent work: context exhaustion.

## Components

| Component | What it is |
|---|---|
| [`hooks/`](hooks/) | **Code-enforced guardrails.** `pre-tool-use-loc-check.js` blocks any file write that exceeds a 200-LOC budget — at tool time, before the write lands. `adhd-summary-enforce.js` validates the structure of an agent's close-out report before the turn may end. `relay-loop-driver.js` is a Stop-hook loop driver: while a session holds a relay baton with open tasks, it blocks turn-end and supplies the next directive. |
| [`skills/relay/`](skills/relay/) + [`hooks/lib/`](hooks/lib/) + [`scripts/`](scripts/) | **Baton-passing session relay.** When an agent session's context fills, it writes a task ledger with per-task acceptance commands, offers a "baton," spawns a successor session, and awaits a verified claim — leases, handoff, and split-brain guards, applied to LLM sessions. `relay-chain.js` is the ledger API; `relay-next.js` picks the next chain's work off a repo backlog once the previous chain's PR merges. |
| [`skills/ballot/`](skills/ballot/) | **Human-in-the-loop decision batching.** Instead of an agent dribbling questions mid-execution, a backward walk over the plan harvests every real decision up front and renders ONE battery as an HTML board served over an ephemeral loopback server — tradeoffs beside options, defaults flippable, submission wakes the agent. Schema-validated; sanitized markup; bearer-token URL. |
| [`skills/search-first/`](skills/search-first/) | **Open-source-first gate.** Before building any component, a structured prior-art search (native → local → open source) produces an ADOPT/ADAPT/BUILD ledger that gates the build proposal. Its `--deep` mode hands off to a heavier research pipeline that is not included here (see Provenance). |

## Running the tests

```bash
node --test hooks/tests/*.test.js skills/ballot/tests/*.test.mjs
```

Prerequisites: Node ≥ 22, bash, git, [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`), and jq. The relay tooling emits `rg` acceptance commands and the scripts use `jq`; the terminal-spawn arms additionally expect Orca, tmux, or macOS `osascript`, and are exercised in dry-run only.

The relay tests drive the ledger API, loop driver, dashboard, and spawn script against throwaway chain files in a temp directory. The same suite runs in [GitHub Actions](.github/workflows/tests.yml) on Linux, where a missing exec bit or an unloadable module fails instead of hiding, and gitleaks scans the full history in the same workflow.

## Design principles

1. **Hard gates beat instructions.** A rule an agent can rationalize past is a suggestion; a PreToolUse hook that returns deny is a boundary. The 200-LOC gate has survived every model upgrade unchanged.
2. **A check that inspects zero items fails — never passes.** Vacuous green is the most dangerous output an automated checker can produce.
3. **Verify the agent's claims against ground truth.** Completion claims ("merged #42", "pushed abc123") are extracted from transcripts and checked against git/GitHub reality. Companion project: [closeout-truth](https://github.com/jbelmana/closeout-truth).
4. **Every task carries an acceptance command.** "Works" is not an acceptance. A relay task is verified only when its acceptance command has been run and its output read.
5. **Decisions are batched, recorded, and cited.** Ballot answers bake into plans as locked decisions with provenance paths.

## Provenance & credits

- Curated from a private monorepo; published with fresh history. Internal cross-references (slash commands, private rules paths) may dangle by design.
- Two components of the private harness are deliberately **not** included: a research pipeline (`deep-research`) and a golden-task eval runner, both adapted from a collaborator's prior work. They are held back until that credit can be recorded with their author's agreement; `search-first` still references the research pipeline's interface.
- The 200-LOC discipline enforced by `pre-tool-use-loc-check.js` was adopted from a teammate's codebase; the hook itself is original.
- The workflow engine these tools orchestrate around is the open-source [open-gsd/gsd-core](https://github.com/open-gsd/gsd-core) — deliberately **not** included here; it is third-party work and the credit is theirs. This repo is the tooling layer built around it.
- `.gitleaks.toml` extends gitleaks' default rules (`useDefault = true`) rather than replacing them — a config that omitted `extend` would load *zero* rules and report a vacuous all-clear (principle 2, above). Gitleaks runs over the full history in the same workflow as the tests — on every push to `main` and every pull request.

## License

MIT © 2026 Jason Belmana
