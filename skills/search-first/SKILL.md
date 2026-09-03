---
name: "search-first"
description: "Prior-art scan before building anything: rings 0-2 (native Claude Code, our harness, open source via gh / npm / PyPI / crates / HN / arXiv) as parallel free lanes, a scorecard (fit, license, maintenance, adoption, footprint, security, integration cost), and an ADOPT / ADAPT / BUILD verdict with a search ledger that /build, /plan, /spec and /cto require before new code lands. Use when the user asks 'is there a library or tool for X', before any new component over ~30 lines, and as deep-research Layer 0. Triggers on: '/search-first', 'is there a library for', 'does something already exist', 'has anyone built', 'before we build this', 'open source options for'."
complexity: "medium"
tier: "standalone"
schema: 1
triggers:
  - "manual"
  - "/search-first"
  - "is there a library for"
  - "does something already exist"
  - "has anyone built"
  - "open source options for"
chained_by:
  - "research"
  - "deep-research"
  - "build"
pairs_with:
  - "exa-search"
  - "docs-lookup"
  - "vault-search"
  - "deep-research"
requires:
  - "tool:Bash"
  - "tool:WebSearch"
  - "tool:WebFetch"
  - "cli:gh"
dimensions:
  code: false
  infra: false
  research: true
  generative: false
  review: false
  external: true
  multi_repo: false
---

# Search First — Prior Art Before New Code

Executes `rules/open-source-first.md`: before building, find what already exists — in Claude Code, in our harness, in the open. Produces a **search ledger** and an `ADOPT` / `ADAPT` / `BUILD` verdict. The standing rule behind it: always see what is already available — in Claude Code, in the harness, on GitHub, in the registries — before building from scratch.

## When

- Any new component of ~30 lines or more: script, hook, skill, lib, service, integration, CLI, parser, scraper, scheduler
- "is there a library / tool / action / plugin for X" · "has anyone built" · "open source options for"
- Layer 0 of `deep-research` for technology, vendor, and build-vs-buy topics
- NOT for: glue under ~30 lines, changes inside an existing module, pure configuration

## Modes

| Mode | Budget | Lanes | Use for |
|---|---|---|---|
| `--quick` | ≤5 min, 1 subagent | Ring 0–1 local checks + GitHub lane | helpers, hooks, small scripts |
| default | ≤15 min, 3–4 parallel `model: "opus"` subagents | all four lanes below | modules, integrations, skills |
| `--deep` | hand to `deep-research` with Layer 0 | the full net (`deep-research/references/source-net.md`) | architecture, platform, vendor choices |

## Procedure

### Step 0 — Frame the capability (main loop, 1 min)

Write one line: *"We need X that does Y under constraints Z."* Then derive the search vocabulary: the generic problem name, the incumbent product everyone names, 2–3 synonyms, and the ecosystem (npm / PyPI / crates / Homebrew / GitHub Action / Claude plugin). Bad vocabulary is the #1 reason a search "finds nothing".

### Step 1 — Ring 0 + Ring 1: native and harness (inline, ≤2 min)

- **Native:** `gh api repos/anthropics/claude-code/contents/CHANGELOG.md --jq .content | base64 -d | rg -n -i "<term>" | head` · `claude mcp list` · `ls ~/.claude/skills ~/.claude/commands` · `enabledPlugins` in `~/.claude/settings.json` · marketplace `~/.claude/plugins/marketplaces/*/`
- **Harness:** the harness's own component catalog · `~/.claude/rules` · memory index · `vault-search "<term>"` · `git log --oneline -S"<term>"` in the target repo

A hit here ends the search: use it, cite it in the ledger.

### Step 2 — Ring 2 lanes (parallel, read-only, `model: "opus"`)

Each lane returns ≤10 candidates as `name | url | stars-or-downloads | last push | license | one-line fit note`. Full invocations and fallbacks live in `deep-research/references/source-net.md` § Section: Code & Open Source.

| Lane | Primary (free) | Also |
|---|---|---|
| GitHub | `gh search repos "<q>" --sort stars --limit 20 --json fullName,description,stargazersCount,pushedAt,license,url,isArchived` · add `--updated ">$(date -v-6m +%Y-%m-%d)"` to bias live projects · `gh search code "<pattern>" --limit 20` for pattern-level prior art · `gh search repos "awesome <topic>" --sort stars --limit 3` then WebFetch the README | GitHub Actions: WebSearch `site:github.com/marketplace/actions <q>` |
| Registries | npm `npm search <q> --json \| jq '.[:10]'` + `npm view <pkg> version time.modified license dependencies --json` · PyPI `curl -s https://pypi.org/pypi/<pkg>/json` · crates `curl -s -A agentic-harness-patterns "https://crates.io/api/v1/crates?q=<q>&per_page=10"` · `brew search <q>` | downloads `curl -s https://api.npmjs.org/downloads/point/last-month/<pkg>` |
| Discourse | HN `curl -s "https://hn.algolia.com/api/v1/search?query=<q>&tags=story&hitsPerPage=20"` (`&tags=comment` for verdicts) · Reddit via WebSearch `site:reddit.com <q>` · `gh search issues "<q>" --sort reactions --limit 20` for the pain the README hides | Exa via `exa-search` (metered) only when free lanes return < 3 candidates |
| Docs / papers | official docs via `docs-lookup` or WebFetch · arXiv `curl -s "http://export.arxiv.org/api/query?search_query=all:<q>&max_results=10"` for technique-level prior art | Semantic Scholar `https://api.semanticscholar.org/graph/v1/paper/search?query=<q>&limit=10&fields=title,year,citationCount,url` |

Lane discipline: free lanes open; Exa / Tavily are metered and close, never open. A lane that errors is **logged as skipped with the error text** — a silent skip is exactly the leak this skill exists to close.

### Step 3 — Scorecard (main loop)

Score the top 3–5 candidates:

| Dimension | Pass | Flag | Fail |
|---|---|---|---|
| Fit | ≥80% of the need, our stack | 50–80% (ADAPT territory) | <50% |
| License | MIT / Apache-2 / BSD / ISC / MPL | LGPL, CC-BY-SA, custom | GPL/AGPL inside a product, or none |
| Maintenance | push < 6 mo, or "done" with issues answered | 6–18 mo quiet | archived, > 18 mo, unanswered CVEs |
| Adoption | ≥500 stars, ≥10k monthly downloads, or a known maintainer | niche but alive | single author, zero users |
| Footprint | deps + size proportionate to the need | heavy but tree-shakeable | 40 MB for 20 lines |
| Security | OSV clean: `curl -s -X POST https://api.osv.dev/v1/query -d '{"package":{"name":"<pkg>","ecosystem":"npm"}}'` returns `{}` | old, fixed advisories | open critical advisory |
| Integration | hours; fits existing patterns | needs a wrapper | rewrites callers |

Bus factor: `gh api "repos/<o>/<r>/contributors?per_page=5" --jq '[.[].contributions]'` — one number dominating is a flag, not a fail.

### Step 4 — Verdict

- **ADOPT** — use as-is; pin the version; record upstream version or SHA in the ledger.
- **ADAPT** — fork / wrap / vendor a subset; state WHY upstream cannot serve as-is and what the wrapper owns.
- **BUILD** — nothing fits at ≥50%. Still name the closest candidate and what we **borrow**: interface shape, edge-case tests, fixtures, naming, data files.

Ties go ADOPT > ADAPT > BUILD. Fit is judged on the problem you have this week, not a hypothetical later one.

### Step 5 — Ledger (the gate artifact)

Write to `research/search-first-<slug>.md` under the project's planning tree when it has one, else inline in the plan / spec / proposal:

```
# search-first: <capability> — <YYYY-MM-DD>
Verdict: ADOPT <name@version> | ADAPT <name> (fork|wrap|vendor — why) | BUILD (why nothing fit)
Vocabulary: <terms searched>
Lanes: github ✓ · registries ✓ · discourse ✓ · docs ✓ · exa — skipped (free lanes sufficient)
| candidate | stars/dl | last push | license | fit | keep/reject — why |
Borrow: <what we lift from the closest candidate>
Security: OSV <clean | advisory ids>
Cost of search: <minutes; metered calls, if any>
```

`/build`, `/plan`, `/spec`, `/cto` treat a missing ledger on a ≥100-line build as a grill-fail (`investigation-discipline.md` § Check prior art).

## Degradation

`gh` unavailable → WebSearch `site:github.com <q>` · HN Algolia down → WebSearch `site:news.ycombinator.com <q>` · registries down → WebSearch `site:npmjs.com` / `site:pypi.org` · no network → Ring 0–1 only, verdict tagged `[Inferred]`, ledger says so.

## What NOT to do

- Conclude "nothing exists" from one vocabulary — retry with the incumbent's name, "alternatives to <incumbent>", "awesome-<topic>", "self-hosted <topic>".
- Adopt the first hit, an archived repo, or an unpinned dependency.
- Open with a metered lane, or drop a lane without a logged reason.
- Let the search become the project: hit the mode budget, write the ledger, decide.
