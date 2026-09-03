---
name: "relay"
description: "Human and session interface to the relay-chain machinery (relay-chain.js, relay-next.js, relay-loop-driver.js, relay-spawn.sh, relay-await-ack.sh, relay-dashboard.js) — the eight subcommands status, start, next, chain-create, claim, pause, resume, and spike WIRE those artifacts together, they are NOT reimplemented here. Use to start an autonomous loop in this session, start the next chain from the repo backlog once the previous one shipped, inspect running baton chains, hand the current session's remaining work to a fresh successor, claim the baton as a spawned successor, pause or resume a running loop, or smoke-test the relay end to end. Triggers on: '/relay', 'relay status', 'relay next', 'claim the baton', 'start a relay chain', 'start the loop', 'start the next chain', 'pause the loop', 'resume the loop', 'hand off to a successor session', 'is a relay chain running'."
complexity: "medium"
triggers:
  - "manual"
  - "relay"
  - "baton"
  - "successor"
  - "loop"
requires:
  - "tool:Bash"
pairs_with:
  - "handoff"
tier: "standalone"
schema: 1
dimensions:
  code: false
  infra: true
  research: false
  generative: false
  review: false
  external: false
  multi_repo: true
---

# Relay — Baton Chain Interface

`/relay` is the human-and-session interface to the relay-chain machinery. It has
eight subcommands — **`status`**, **`start`**, **`next`**, **`chain-create`**,
**`claim`**, **`pause`**, **`resume`**, **`spike`** — and it does exactly one
thing: it **wires the existing relay artifacts together**. It never reimplements
the ledger, the loop driver, the spawn, the ack poll, or the dashboard.

Three of them open a chain. **`start`** opens one this session HOLDS and then
loops on (a fresh session, 0% context); **`chain-create`** hands an already-full
session's remaining work to a spawned successor; **`next`** picks the following
chain's work off this repo's backlog once the previous chain's PR has merged —
that merge is what closes the loop and lets the machine keep building.

## What it consumes (by exact name — never reimplement)

| Artifact | Role |
|----------|------|
| `~/.claude/hooks/lib/relay-chain.js` | Ledger API — `RELAY_DIR`, `defaultChainDirs`, `uniqueChainId`, `createChainFileExclusive`, `loadChain`, `resolveNewestChain`, `createChain`, `offerBaton`, `claimVerified`, `addTask`, `markDone`, `markVerified`, `openTasks`, `isComplete`, `retireChain`, `writeChain` |
| `~/.claude/hooks/lib/relay-chain-state.js` | Schema-2 state API, re-exported from `relay-chain.js` — `setPaused(chain, bool)`, `setWaiting(chain, {class, question, options, now})`, `clearWaiting(chain, {answer, now})`, `logDecision(chain, d)`, `WAITING_CLASSES`, `configuredLoopCap()` |
| `~/.claude/hooks/lib/relay-dirs.js` | Chain-home API, re-exported from `relay-chain.js` — `relayDir(repoRoot)`, `findRelayDir(cwd)`, `relayDirs(cwd)`, `allChainDirs()`, `readInstanceToken(dirs, pid)`, `legacyRelayDir()` |
| `~/.claude/hooks/lib/relay-next.js` | Backlog picker for `next`, required **directly** (not via `relay-chain.js`) — `chainsToday(dirs, todayISO)`, `resolvePrevChain(dirs\|home)` → `{file, chain, retired, readable}`, `pickNext(source, items, {chainsToday, cap, root, isDone})`, `nextRefusal({nextEnabled, prevChain, prevRetired, prevReadable, chainsToday, cap})` — **`prevReadable` defaults to `false`**, so state what you read. `root` + `isDone` are the actionability filters: out-of-repo locations are skipped, and so is any entry whose acceptance already passes. Ship state lives in `relay-chain-state.js` — `setShip(chain, {branch\|pr\|review_rounds\|merged})`, `bumpReviewRound(chain)`, `markEnded(chain, {reason, now})`, `configuredChainsPerDay()` |
| `~/.claude/hooks/relay-loop-driver.js` | **Stop hook** — what makes `mode: autonomous` real. While this session holds the baton, the chain is autonomous, not paused, not waiting, and tasks are open, it blocks turn-end and supplies the next prompt. Never invoked by hand |
| `~/.claude/scripts/relay-spawn.sh` | Spawns the successor. Prints `TOKEN=…` on stdout; exit `64` = generation cap reached, `2` = cwd/chain outside trusted roots, `3` = handoff missing, `4` = handoff rejected, `5` = no successor opened, `6` = chain missing/invalid, `7` = worktree add failed, `8` = no spawnable terminal — the composed prompt is printed to stdout and copied to the clipboard; paste it into a terminal you open yourself (`3` keeps its own meaning: the handoff file is missing) |
| `~/.claude/scripts/relay-await-ack.sh` | `<chain> <my-token> [timeout=300]` — exit `0` a successor claimed, exit `1` timeout (offer reverted to `held` + alert appended) |
| `~/.claude/scripts/relay-dashboard.js` | Renders the HTML dashboard; prints the file path on stdout |
| instance file | `instance-$PPID.json` in the chain home — `findRelayDir($PWD)`, i.e. `<repo_root>/.relay`, falling back to the legacy `RELAY_DIR` when the repo has none — written from the holder token |

The baton guard (`hooks/relay-baton-guard.js`) enforces write authority — once the
baton is handed over, this session must stop writing repos. Respect it, do not fight it.

---

## status

Run this, verbatim:

```bash
node -e '
const rc = require(process.env.HOME + "/.claude/hooks/lib/relay-chain.js");
const fs = require("fs"), path = require("path");
// Every repo-local .relay on the machine, then this repo and the legacy dir.
// `rc.allChainDirs &&` keeps status working against a runtime copy that predates
// the helper — the repo is canonical, ~/.claude is a forward copy that can lag.
const dirs = [...new Set([
  ...(rc.allChainDirs ? rc.allChainDirs() : []), ...rc.defaultChainDirs()])];
let found = 0;
for (const dir of dirs) {
  const names = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((n) => /^chain-.*\.json$/.test(n) && !n.endsWith(".done.json"));
  for (const n of names) {
    const r = rc.loadChain(path.join(dir, n)); if (!r.ok) continue;
    // Loadable is not the same as well formed: a hand-edited chain with a null
    // holder_token parses fine and then throws at .slice(0,8) below, taking the
    // whole listing down over ONE bad file. The guard, the monitor and the
    // driver all skip a chain that fails validateChain; status does too.
    if (!rc.validateChain(r.chain).ok) continue;
    found++;
    const c = r.chain;
    console.log(`${c.chain_id} · gen ${c.generation.current}/${c.generation.cap} · baton ${c.baton.state} (${c.baton.holder_token.slice(0,8)}…) · mode ${c.mode}${c.model ? " · " + c.model : ""} · ${path.join(dir, n)}`);
    // v2.1 loop state — the kill switch, the declared stop, the iteration count.
    const loop = c.loop || {};
    const iters = Object.entries(loop.iterations || {})
      .map(([g, i]) => `gen ${g}: ${i}/${loop.cap === undefined ? "?" : loop.cap}`).join(", ");
    const nudges = loop.relayNudges ? ` · relay nudges ${loop.relayNudges}` : "";
    if (c.paused) console.log("  ⏸ PAUSED — /relay resume to continue");
    if (c.waiting) console.log(`  ⏳ WAITING — ${c.waiting.class}: ${c.waiting.question}`);
    if (iters) console.log(`  ↻ loop ${iters}${nudges}`);
    // v2.1 review pathway — where the chain is on the way to a merged PR.
    if (c.ended) console.log(`  ■ ENDED — ${c.ended.reason} at ${c.ended.at}`);
    const sh = c.ship || {};
    if (sh.branch || sh.pr) console.log(`  ⇪ ship ${sh.branch || "(no branch)"} · PR ${sh.pr || "none"} · rounds ${sh.review_rounds || 0} · merged ${sh.merged ? "yes" : "no"}`);
    for (const t of rc.openTasks(c)) console.log(`  [${t.state}] ${t.id}: ${t.desc}`);
    for (const d of (c.decisions||[])) console.log(`  · ${d.id} ${d.question} → ${d.chosen}`);
    for (const a of (c.alerts||[])) console.log(`  ⚠ ${a.msg}`);
  }
}
if (!found) console.log("no active chains");'
```

Render the output as a table (chain · generation · baton state · holder · mode ·
model, then the v2.1 loop rows, then the **PR column** — `ship.branch` ·
`ship.pr` · rounds · merged — then one row per open task, then any decisions,
then any alerts). Call out **PAUSED**, **WAITING — `<class>`: `<question>`**,
**ENDED — `<reason>`**, and `loop.iterations` explicitly — those four are the difference between "a chain
exists" and "a chain is driving a session right now". A `loop cap reached` alert
means **ENDED AT CAP**. If a `dash-<chain_id>.html` file exists beside a listed
chain, mention its path so the human can open the live dashboard.

With no chains present the command prints `no active chains` and exits 0.

---

## chain-create

The predecessor's orchestration entry. Called by `/handoff --relay` (after Task 9),
and callable directly before that. The skill mandates these steps, **in order**:

**Step 0 — REUSE a chain this session already holds. Never create a second one.**
The loop driver fires this verb at 40% displayed context (`RELAY: offer the held
chain via /relay chain-create now`), and a session that reached 40% while looping
is a session that already **holds** a chain. Minting a new one beside it orphans
the held chain `held` forever — its `ship.branch`, its `decisions[]`, its
`review_rounds` and its `T-ship` task all stay on a ledger nobody drives, and the
successor is handed a chain with no ship task. So look first:

```bash
CLI_PID="$PPID" node -e '
  const rc = require(process.env.HOME + "/.claude/hooks/lib/relay-chain.js");
  const fs = require("fs"), path = require("path");
  // Preflight, and the loudest one in this file: on a lagging runtime the probe
  // below would throw and print NOTHING — which reads exactly like "none" to the
  // rule underneath, so a held chain would be orphaned by the second chain this
  // whole step exists to prevent. Refuse out loud instead.
  if (!rc.relayDirs || !rc.readInstanceToken || !rc.validateChain) {
    console.error("the installed relay-chain.js predates v2.1 — re-run the relay library install step");
    process.exit(1);
  }
  const dirs = rc.relayDirs(process.cwd());
  const token = rc.readInstanceToken(dirs, process.env.CLI_PID);
  let held = null;
  if (token) for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!/^chain-.*\.json$/.test(n) || n.endsWith(".done.json")) continue;
      const f = path.join(dir, n);
      const r = rc.loadChain(f);
      if (!r.ok || !rc.validateChain(r.chain).ok) continue;
      if (r.chain.baton.holder_token === token) held = f;
    }
  }
  console.log(held || "none");
'
```

- **Non-zero exit** means the runtime lags this repo — run the live batch and
  re-run step 0. Never treat "no output" as `none`; that is how the second chain
  gets created.
- A **path** means REUSE: first `let c = rc.loadChain(<that file>).chain` (the
  chain on disk is the source — never rebuild it from memory), then
  `c = rc.addTask(c, …)` for each piece of remaining work on THAT chain, then
  `c = rc.offerBaton(c, { now })`, then `rc.writeChain(<that file>, c)`. Keep the
  token, keep the `chain_id`, keep `ship`. Skip steps 1–3 entirely and go to
  step 4 (handoff doc), then step 5 (re-render the dashboard and pass the chain's
  existing `artifact_url` to the Artifact tool so the URL is kept), then spawn
  with **that** chain file at step 6.
- **`none`** means this session holds nothing — steps 1–3 below create a chain.
- `$PPID` in a Bash tool call is the Claude CLI process, the same pid the hooks
  resolve with `process.ppid`; it is passed in as `CLI_PID` because inside
  `node -e` the parent is the shell, not the CLI.

1. **Derive `chain_id`** = `rc.uniqueChainId("<repo-slug>")` — date + slug + a
   random 4-hex suffix. NEVER hand-compose `<date>-<slug>`: two same-day chains
   in one repo collided live (2026-08-26), each clobbering the other's chain file
   AND dashboard artifact.

2. **Build the task array** from the CURRENT session's remaining work. Every task
   MUST carry a concrete `acceptance` — a command to run or an observable to check,
   **never** the word "works". A test-suite acceptance greps the runner's SUMMARY
   line (`Tests  N passed …`, no `failed` token in that line) — never the whole log
   for `" failed"`: tests that exercise failure paths log that word, so the clause
   fails on a green baseline (chain 2026-08-28-example-app-cfc6, D5). Set `NO_COLOR=1`
   when the output is redirected, or ANSI codes split the token.

3. **Run in ONE Bash invocation** (atomicity — this is the collision lesson;
   never split it across calls):
   ```bash
   TOKEN=$(uuidgen)
   # write instance-$PPID.json from $TOKEN into the chain home — the same dir the
   # chain goes in, i.e. rc.relayDir(repoRoot) / findRelayDir($PWD) — then, in the
   # SAME invocation:
   node -e '
     const rc = require(process.env.HOME + "/.claude/hooks/lib/relay-chain.js");
     const now = new Date().toISOString();
     let c = rc.createChain({ now, /* chainId: rc.uniqueChainId(slug), holderToken: TOKEN,
       mode: <session mode>, model: <this session model id>, repoRoot, handoffDoc,
       spawnPolicy: "worktree" for a code repo | "shared" for a planning repo */ });
     // EVERY helper below is clone-then-return — ASSIGN the result, never call it
     // bare. `c = rc.addTask(c, …)` once per task, THEN `c = rc.offerBaton(c, { now })`.
     // A bare `rc.offerBaton(c, { now });` leaves the baton `held`, and the
     // claimBaton the successor runs then throws "claim: baton not offered".
     // Then create the file EXCLUSIVELY at <repo_root>/.relay/chain-<chainId>.json:
     //   rc.createChainFileExclusive(rc.chainPath(chainId, rc.relayDir(repoRoot)), c)
     // — the create also seeds a .gitignore of "*" in that dir on first use.
     // — { ok:false, error:"exists…" } means an id collision: STOP, derive a new id.
     // Later UPDATES to the same file go through rc.writeChain.
   '
   ```
   **`now` is an ISO string on EVERY call that takes one** — `createChain` and
   `offerBaton` included, not just `claim`. Leaving it out (or passing
   `Date.now()`) lands a raw epoch number in `offered_at` and `history[].released`,
   which `expireOffer` then feeds to `Date.parse` for `NaN` arithmetic. Observed
   live on a chain whose `history[0].released` read `1700000000000`.
   `model` is this session's own model id, verbatim from its system prompt (e.g.
   `claude-opus-5`, `claude-fable-5`). The chain is the single source for it —
   design decision q6 is that a successor always inherits the predecessor's model,
   and `relay-spawn.sh` does not read it yet, so a wrong value here is what a
   later generation would inherit.
   `mode` comes from the session's current mode (autonomous | interactive).
   `spawn_policy` is `worktree` when the repo is a code repo, `shared` for a
   planning repo.
   **Chain location:** `<repo_root>/.relay/` — the one directory both the
   predecessor (cwd) and a sandboxed successor (launched in the repo) can write.
   `relay-spawn.sh` accepts a chain ONLY from there or from `~/.claude/relay`
   (the legacy home, still scanned by status/guard/monitor); a chain anywhere
   else exits 2. `createChainFileExclusive` gitignores the dir on first use.

4. **Write the narrative handoff** doc per the `handoff` skill's six-section
   template, leaving `## Resume prompt` as a single placeholder line. Then run
   `bash ~/.claude/scripts/relay-spawn.sh <handoff> <gen+1> <chain> --print-prompt`,
   paste its output **verbatim** as the blockquote under `## Resume prompt`, and
   pipe the same output to `pbcopy` — one composition feeds the doc, the
   clipboard, and (in step 6) the launcher, so the doc can never drift from what
   actually runs. Set `handoff_doc` on the chain.

5. **Render the dashboard** — `node ~/.claude/scripts/relay-dashboard.js <chain>` —
   and **publish it via the Artifact tool**. If the chain already carries a non-empty
   `artifact_url`, pass it to the Artifact tool so the same URL is reused; otherwise
   store the returned url back onto the chain with `writeChain`.

6. **Spawn the successor:**
   ```bash
   bash ~/.claude/scripts/relay-spawn.sh <handoff> <gen+1> <chain>
   ```
   The `TOKEN=…` line this prints is the SUCCESSOR's token — it is irrelevant to
   the predecessor; do not claim with it.

   The script picks the terminal itself: `CLAUDE_RELAY_TERM` when set, else
   `$TERM_PROGRAM` (Orca → `orca terminal create` bound to the MAIN checkout
   with a `cd` into the launch dir; Ghostty → `open -na`; anything else →
   Ghostty). `CLAUDE_RELAY_NO_FOCUS=1` keeps an Orca tab unfocused. Exit `8`
   means no launcher was available — paste the printed prompt into a terminal
   you open yourself. Never hand-roll `orca terminal create` from a skill body
   and never close a tab the script opened (the 2026-08-19 five-spawn kill
   loop was a hand-rolled spawn).

7. **Await the ack:**
   ```bash
   bash ~/.claude/scripts/relay-await-ack.sh <chain> <my-token> 300
   ```
   - **exit 0** — announce handover complete, republish the dashboard, and **STOP
     writing repos** (the baton guard enforces this).
   - **exit 1** — announce "successor never claimed — baton retained", surface the
     alert the script appended, and **continue working**.

---

## claim

The successor's first act — its handoff / system prompt tells it to run this.
In ONE Bash invocation:

1. **Assert the environment.** `$CLAUDE_RELAY_TOKEN` and `$CLAUDE_RELAY_CHAIN`
   MUST both be set. If either is absent, refuse: "not a relay successor" — stop.

2. **Write `instance-$PPID.json`** from `$CLAUDE_RELAY_TOKEN`, into the chain
   home — `rc.findRelayDir(process.cwd())`, i.e. `<repo_root>/.relay`, with the
   legacy `RELAY_DIR` as the fallback. The guard and the monitor read both dirs,
   so either location arms them; the repo-local one is inside a sandboxed
   successor's write allowlist, which `RELAY_DIR` is not.

3. **Claim, verified:**
   ```bash
   node -e '
     const rc = require(process.env.HOME + "/.claude/hooks/lib/relay-chain.js");
     const r = rc.claimVerified(process.env.CLAUDE_RELAY_CHAIN, {
       token: process.env.CLAUDE_RELAY_TOKEN,
       gen: Number(process.env.CLAUDE_RELAY_GENERATION),
       now: new Date().toISOString(),
     });
     if (!r.ok) { console.error(r.error || "claim failed"); process.exit(1); }
   '
   ```
   `now` is ISO, never `Date.now()`: every other ledger timestamp is ISO and
   `expireOffer` compares them with `Date.parse`, which yields `NaN` for a raw
   epoch number — a numeric `claimed_at` makes the offer arithmetic meaningless
   (a logged incident: "ack timeout after 0s").
   On `{ ok: false }`: print the error and **STOP** — a failed claim means the
   offer expired; check `/relay status`.

4. **On success:** republish the dashboard, read `handoff_doc` + the open tasks,
   then proceed **in `mode`**:
   - **autonomous** → work the ledger.
   - **interactive** → present the state and wait for the human.

**Task completion rule:** call `markDone` when the work lands; call `markVerified`
**only after** actually running the task's `acceptance` and reading its output.
Both are clone-then-return, so both are `c = rc.markDone(c, id, { gen })` followed
by `rc.writeChain(f, c)` — a bare call changes nothing on disk and the task stays
open forever. Republish the dashboard on **every** state transition.

**Chain complete** (`isComplete` returns true) → render and **publish** the final
dashboard, prune the `.wt-relay-g*` worktrees (`git worktree remove …`), then
`retireChain`. Retiring is a full cleanup: besides renaming the chain to
`.done.json` it deletes the chain's own `instance-*.json` files (so no session
stays write-blocked by a dead chain) and its local `dash-<chain_id>.html`.
Publish before retiring — the published artifact survives, the local HTML does not.

**Then start the next chain — this is the trigger, not a suggestion.** After
`retireChain`, read `<repo>/.relay/config.json`: if it has `"next_enabled": true`,
run **`/relay next`** before this turn ends. The loop driver then drives the new
chain from its first turn. Nothing else fires `next` — the flag is read by the
`next` verb itself, so without this line the machine stops dead at every chain
boundary and waits for a human, which is precisely what the review pathway exists
to remove. If `next` refuses, print its refusal verbatim and stop; a refusal is a
budget or a state, never a reason to hand-start a chain.

**At-cap rule (spec §Lifecycle 5):** when the spawn exits **64** (generation cap)
with tasks still unverified, do NOT retire silently. First **file every open task**
into the repo's durable tracker (`/found-issues:log`, or the planning backlog), then
republish the dashboard with an **"ended at cap, N remain"** alert, and only THEN
`retireChain`. Nothing evaporates at the cap.

---

## spike

Manufacture a throwaway test chain to smoke-test the relay end to end. Used once
by Task 8.

1. Work in a scratch location under one of `CLAUDE_RELAY_TRUSTED_ROOTS`.
2. Build **2 tasks** whose `acceptance` values are trivially checkable (e.g.
   "file X exists", "`echo ok` prints ok").
3. Run `chain-create` with the spawn in **`--dry-run`** first
   (`relay-spawn.sh <handoff> <gen+1> <chain> --dry-run` prints the launch
   command and TOKEN without opening a session).
4. On approval, run the **real** spawn (drop `--dry-run`) and walk the chain
   through claim → markDone → markVerified → retire.

---

## start

Opens a chain **held by THIS session**, with **no spawn and no successor**, and
lets the Stop hook drive it. `start` is how an autonomous loop begins in a fresh
session at 0% context; `chain-create` is the other end of the same machinery, for
a session already too full to continue.

```
/relay start [--interactive] "T1: <desc> | accept: <cmd>" "T2: <desc> | accept: <cmd>" …
```

Each argument is one task: an id, a description, and — after `| accept:` — a
concrete acceptance command or observable. **Never** the word "works". Mode is
`autonomous` unless `--interactive` is passed.

**Deviation from the spec, stated plainly.** The v2.1 addendum (:207) lists
`start [--interactive] [--from <source>] …`. `--from` was never built: pulling
work from a backlog source became its own verb, **`next`**, so that the gates
(`next_enabled`, predecessor merged, `chains_per_day`) sit on the one path that
opens a chain without a human typing the task. `start` therefore takes
`[--interactive]` only, and `/relay next` is `--from` by another name.

**Run from the REPO ROOT.** `$ROOT` below is `git rev-parse --show-toplevel`,
which inside a `.wt-relay-g*` worktree resolves to the WORKTREE, not the repo —
the chain home then lands in a directory that disappears with
`git worktree remove`, taking the ledger and its instance file with it. Start
chains from the checkout the repo lives in.

**Run in ONE Bash invocation** — the same atomicity rule as `chain-create`, and
for the same reason (a half-written identity is a chain nobody holds):

```bash
TOKEN=$(uuidgen)
ROOT=$(git rev-parse --show-toplevel)
mkdir -p "$ROOT/.relay"
# Self-ignore FIRST: the instance file lands before the chain does, and
# createChainFileExclusive would only seed this on the create that follows.
[ -f "$ROOT/.relay/.gitignore" ] || printf '*\n' > "$ROOT/.relay/.gitignore"
printf '{"token":"%s"}\n' "$TOKEN" > "$ROOT/.relay/instance-$PPID.json"
RELAY_TOKEN="$TOKEN" RELAY_ROOT="$ROOT" node -e '
  const rc = require(process.env.HOME + "/.claude/hooks/lib/relay-chain.js");
  // Preflight: ~/.claude/hooks/lib is a forward COPY of this repo and can lag it.
  // Without this the block dies on an undefined-is-not-a-function trace halfway
  // through, after the instance file is already on disk — an identity with no
  // chain. Refuse cleanly instead. `status` guards the same way.
  if (!rc.setShip || !rc.relayDir) {
    console.error("the installed relay-chain.js predates v2.1 — re-run the relay library install step");
    process.exit(1);
  }
  const root = process.env.RELAY_ROOT, home = rc.relayDir(root);
  const now = new Date().toISOString();
  const chainId = rc.uniqueChainId("<repo-slug>");
  let c = rc.createChain({ chainId, repoRoot: root, now, handoffDoc: "",
    spawnPolicy: "<worktree|shared>", mode: "<autonomous|interactive>",
    model: "<this session model id>", holderToken: process.env.RELAY_TOKEN });
  // one `c = rc.addTask(c, { id, desc, acceptance })` per argument — assigned, as
  // addTask is clone-then-return — THEN the ship task:
  c = rc.addTask(c, { id: "T-ship",
    desc: "ship this chain — branch relay/" + chainId + "; /ship (PR); review rail: "
      + "the reviewer agent + /review (coderabbit); fix findings as chain tasks, max 2 "
      + "rounds; CI delta vs baseline clean → self-merge via gh (owned repos only, "
      + "standing auth)",
    acceptance: "gh pr view <pr> --json mergedAt → non-null" });
  // Validate BEFORE the create: createChainFileExclusive does not, and the
  // driver skips any chain that fails validateChain. An invalid chain would land
  // on disk, report success here, and then silently never loop.
  const v = rc.validateChain(c);
  if (!v.ok) { console.error("invalid chain: " + v.error); process.exit(1); }
  const file = rc.chainPath(chainId, home);
  const r = rc.createChainFileExclusive(file, c);
  if (!r.ok) { console.error(r.error); process.exit(1); }
  console.log(file);
'
```

- **`$PPID`** in a Bash tool call is the Claude CLI process — the same pid the
  Stop hook resolves with `process.ppid`. Writing the instance file anywhere else,
  or under any other pid, leaves the driver seeing a stranger and silently not
  looping.
- **`model`** is this session's own model id, verbatim from its system prompt
  (e.g. `claude-opus-5`, `claude-fable-5`). The chain is the single source for it;
  a successor inherits the predecessor's model by design (q6).
- **`spawn_policy`** is `worktree` for a code repo, `shared` for a planning
  repo — as in `chain-create`.
- **`T-ship` is appended automatically, always, and last.** Every chain ends by
  shipping what it built, through the review rail that already exists — see
  **`next`** below for the full pathway and the two-round cap. The loop directive
  lists `T-ship` last among the open ids, so the model never ships ahead of the
  work. Record the branch on the chain as soon as it exists:
  `c = rc.setShip(c, { branch: "relay/" + chainId })`.
- **Never `offerBaton` here.** The baton stays `held` by this session — that is
  the whole point of `start`. An offered baton makes the driver stand down.
- **Then render and publish the dashboard**, exactly as `chain-create` step 5 does,
  and store the returned url back onto the chain with `writeChain`.

**What happens next is not a command.** From the next turn on, the Stop hook
(`relay-loop-driver.js`) re-reads the chain every time the turn tries to end. While
this session holds the baton, the chain is autonomous, `paused` is false, `waiting`
is null and a task is still open, it blocks the stop and supplies the next
directive. Work the ledger: `markDone` when the work lands, `markVerified` only
after running the task's `acceptance` and reading its output. The loop ends by
itself on the last `markVerified` (`complete`), at `loop.cap` iterations, or when
a human runs `/relay pause`.

---

## next

Starts the **next** chain from this repo's backlog, once the previous one has
shipped. It is the only verb that opens a chain without a human typing the task,
so it is the only one that **refuses out loud** — every gate prints its reason
and exits non-zero. A silent no-op here looks exactly like a working loop.

```
/relay next
```

**The gates, in the order they are checked.** The first failure is printed
verbatim and nothing else runs:

| Gate | Printed refusal |
|---|---|
| `<repo>/.relay/config.json` has `"next_enabled": true` (missing file ⇒ not enabled) | `next_enabled false` |
| the newest chain across **both** of this repo's chain homes (`rc.relayDirs($ROOT)` = `<repo>/.relay` + the legacy `RELAY_DIR`) — ranked by its own `created`, not by mtime — is retired (`chain-*.done.json`) **and** either `ship.merged === true` or `ended.reason === "review-stalled"`; a chain that exists but fails `loadChain`/`validateChain` refuses too (**fail closed** — an unreadable predecessor is not "no predecessor", and neither is one the scan never looked at) | `previous chain not ended` |
| chains created today (active **and** retired) `< chainsPerDay` | `chains_per_day reached (3)` |
| the configured source produced a pickable item that this repo can still act on — an out-of-repo location (`~/…`, or an absolute path outside `$ROOT`) is skipped, and so is an entry whose acceptance command already exits 0 | `source empty` |

**The day budget is machine-wide, not per repo.** `chainsToday` scans every
repo-local `.relay` on the machine plus the legacy dir, because `chainsPerDay`
lives in the global `~/.claude/relay.config.json` and the thing being rationed is
dollars — three chains in three different repos cost the same as three here.

**`ended.reason === "complete"` with `ship.merged === false` does NOT open the
gate.** That is the owned-repos-only path where `T-ship` stopped at "PR opened":
a human merges that PR, and the next run sees `merged: true`. A stalled chain
*does* open it — the findings are already filed and the next chain must not
re-touch that PR.

**Backlog sources** — per repo, `.relay/config.json` `"source"`:

| Source | Backend command | Task it emits |
|---|---|---|
| `found-issues` | `rg -n '^- \[open\]' DOCs/found-issues.md` — criticals (`- [open] [!]`) first, then plain opens; `[deferred]`/`[fixed]` never | `FI-<line>: fix <path:line> — <symptom> \| accept: rg -q …` (the sync flips `[open]`→`[fixed]` on merge, so the acceptance is "the entry closed") |
| `gsd-next` | `node ~/.claude/gsd-core/bin/gsd-tools.cjs smart-entry --json` → `.signals.current_phase`. That payload carries **no phase name**, so the name comes from the `### Phase <N>:` heading in the planning tree's `ROADMAP.md` | `P<N>: /gsd-execute-phase <N> \| accept: <planning>/phases/<N>-*/VERIFICATION.md exists` |

**Gate and pick in ONE Bash invocation** — the checks are only meaningful
together, and the picked item is written to `<repo>/.relay/next-pick.json` so the
`start` block below consumes it without the task ever crossing a shell quote (the
found-issues acceptance contains single quotes and would close a `node -e '…'`
block early):

```bash
ROOT=$(git rev-parse --show-toplevel)
PLANNING="${CLAUDE_RELAY_PLANNING_DIR:-.planning}"   # the GSD planning tree
# The backlog readers run in the SHELL and are passed in: relay-next.js is pure,
# so every refusal string and every emitted task is covered by a test instead of
# by prose here. Run only the one your .relay/config.json "source" names.
ITEMS=$(rg -n '^- \[open\]' "$ROOT/DOCs/found-issues.md" 2>/dev/null || true)
PHASE=$(node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" smart-entry --json 2>/dev/null \
  | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).signals.current_phase' 2>/dev/null || true)
NAME=$(rg -m1 -N "^#+ Phase ${PHASE}[: ]" "$ROOT/$PLANNING/ROADMAP.md" 2>/dev/null \
  | sed "s/^#* Phase [0-9]*:* *//" || true)
ROOT="$ROOT" ITEMS="$ITEMS" PHASE="$PHASE" NAME="$NAME" node -e '
  const rc = require(process.env.HOME + "/.claude/hooks/lib/relay-chain.js");
  const rn = require(process.env.HOME + "/.claude/hooks/lib/relay-next.js");
  const fs = require("fs"), path = require("path"), cp = require("child_process");
  // Preflight: ~/.claude/hooks/lib is a forward COPY of this repo and can lag it.
  // Every symbol probed here is one this block actually calls below.
  if (!rn.resolvePrevChain || !rc.configuredChainsPerDay || !rc.relayDirs) {
    console.error("the installed relay-chain.js predates v2.1 — re-run the relay library install step");
    process.exit(1);
  }
  const root = process.env.ROOT, home = rc.relayDir(root);
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")); }
  catch { /* no per-repo config yet — the next_enabled gate refuses below */ }
  // Newest chain in this repo, active OR retired: the predecessor to gate on.
  // Resolved by the LIB, never by a sort written here — ordering is by the chain
  // OWN created field, never mtime (a long-retired .done.json touched by a backup
  // must not out-rank the live chain), and a chain that exists but fails to load
  // comes back readable:false, which fails the gate CLOSED.
  // BOTH homes are scanned, exactly as the guard, monitor and driver scan them:
  // a predecessor sitting in the legacy RELAY_DIR is invisible to a single-dir
  // scan, and an invisible predecessor reads as "first chain".
  const prev = rn.resolvePrevChain(rc.relayDirs(root));
  const budget = { cap: rc.configuredChainsPerDay(),
    chainsToday: rn.chainsToday(
      [...new Set([...rc.allChainDirs(), ...rc.defaultChainDirs()])],
      new Date().toISOString().slice(0, 10)) };
  const gate = rn.nextRefusal({ ...budget, nextEnabled: cfg.next_enabled === true,
    prevChain: prev.chain, prevRetired: prev.retired, prevReadable: prev.readable });
  if (gate) { console.error(gate.message); process.exit(1); }
  const items = cfg.source === "gsd-next"
    ? { phase: process.env.PHASE, name: process.env.NAME }
    : String(process.env.ITEMS || "").split("\n").filter(Boolean);
  // ACTIONABILITY (R3). `root` drops ledger entries this repo cannot act on —
  // an upstream `~/.claude/gsd-core/…` path appears on real ledgers and no chain
  // here can close it. `isDone` runs the emitted acceptance once: exit 0
  // means the entry is already fixed and only the ledger line lags, so the chain
  // would open with nothing to do. Either one burns a chain to loop.cap without a
  // commit. The acceptance carries single quotes and is passed to execSync as a
  // JS string — it never crosses a quote in this document.
  const r = rn.pickNext(cfg.source, items, { ...budget, root,
    isDone: (p) => {
      try { cp.execSync(p.acceptance, { cwd: root, stdio: "ignore" }); return true; }
      catch { return false; }
    } });
  if (r.refused) { console.error(r.message); process.exit(1); }
  // Stamped, and consumed exactly once: the start block deletes it after addTask.
  fs.writeFileSync(path.join(home, "next-pick.json"),
    JSON.stringify({ ...r, picked_at: new Date().toISOString() }, null, 2));
  console.log(`${r.label} → ${r.task}`);
  console.log(`chain ${budget.chainsToday + 1} of ${budget.cap} today`);
'
```

**Then run the `start` block above, unchanged except for the task line** — that
is the whole point of `next`: it picks, `start` creates, and `T-ship` is appended
by `start` exactly once, in one place. Substitute the per-argument `addTask` line
with:

```js
  const pickFile = home + "/next-pick.json";
  const p = JSON.parse(require("fs").readFileSync(pickFile, "utf8"));
  c = rc.addTask(c, { id: p.id, desc: p.desc, acceptance: p.acceptance });
  require("fs").unlinkSync(pickFile);   // single-use — see the rule below
```

**`next-pick.json` is single-use.** The gate writes it stamped with `picked_at`
and the `start` block **deletes it immediately after `addTask`**, in the same
invocation. A pick is a claim on today's budget, so a leftover file is exactly
how the same backlog item gets started twice, or how a chain starts from a pick
taken before the item was fixed. If the file is absent when `start` runs, that is
not a state to recover from — re-run `/relay next`.

`mode` is `autonomous` and `spawn_policy` matches the repo, as in `start`. Report
the refusal or the new chain id — never both, never neither.

A `"source"` outside those two **throws** rather than refusing: a refusal is a
budget or a state, a misspelled source is a broken `.relay/config.json` and
should be loud. `.relay/.gitignore` is `*`, so `config.json` and `next-pick.json`
are local-only by design — print the config when starting a chain by hand so the
per-repo choice stays visible.

### The ship pathway a chain ends on

No new review machinery: `T-ship` wires the rails that already exist.

1. **Branch at start.** `relay/<chain_id>` — record it with
   `c = rc.setShip(c, { branch: … })`.
2. **`/ship`** opens the PR → `c = rc.setShip(c, { pr: "<org/repo#N>" })`.
3. **Review** — the 4-tier reviewer agent plus coderabbit `/review`. Findings
   become chain tasks, and **each round is counted on the chain before the fixes
   start**: `c = rc.bumpReviewRound(c)`, then `rc.writeChain(f, c)`. **Max 2
   rounds.** The count is the only thing that survives a handoff — without it a
   successor generation cannot tell whether round 1 or round 2 was already spent,
   so the cap is unenforceable and `status` / the dashboard show a permanent 0.
   **Give the lanes a time budget and start them early:** dispatch the reviewers
   right after the first commit (in parallel with the full-suite gate, not after
   it); at ~10 min `SendMessage` them "return findings as-is, skip further test
   runs"; at ~15 min with no report `TaskStop` both and re-dispatch with a
   narrower brief. Subagent reports land only in the session that spawned them,
   so a round still running when the 40% hand-off fires is burned — the
   successor pays for it again as round 2 (2026-08-28, chain
   `2026-08-28-example-svc-4c2d`: both lanes ran >30 min without returning; the
   CodeRabbit lane had barely started when stopped).
4. **CI delta vs baseline clean ⇒ self-merge** with `gh pr merge` under the
   8/26 standing authorization — **owned repos only**. Then
   `c = rc.setShip(c, { merged: true })` and
   `c = rc.markEnded(c, { reason: "complete" })`.
5. **Round 2 still unresolved ⇒** `/found-issues:log` every finding,
   `c = rc.markEnded(c, { reason: "review-stalled" })`, **leave the PR open**
   (the dashboard shows it in red), then `rc.retireChain(file)`.

### Cost — quoted, with the cheaper variant

Spend scales with **chains/day × generations × context refills**, not task count.
On API billing a chain costs several dollars of tokens, so the daily bill is
roughly `chainsPerDay` × that; a pricier inherited model multiplies it. Quote
the number for YOUR model and plan before raising the cap. The cheaper variant
is `chainsPerDay: 1`, overnight only, giving up daytime throughput. **On a
subscription plan the constraint is the rate window rather than dollars**: an
always-on loop will hit it, and the loop cap/alert path handles the stall.

**`chainsPerDay` is not raised above 3 without the operator confirming the plan
type.** That is the one number the quote above is missing, and it decides whether
the limit is dollars or a rate window. Raising it is a `spend`-class `waiting`, not
an autonomous decision.

---

## pause

The kill switch. It outranks every other row of the driver's decision table, so a
paused chain never blocks a turn — the ledger stays exactly as it is.

```bash
node -e '
  const rc = require(process.env.HOME + "/.claude/hooks/lib/relay-chain.js");
  if (!rc.setPaused || !rc.relayDirs) {
    console.error("the installed relay-chain.js predates v2.1 — re-run the relay library install step");
    process.exit(1);
  }
  const f = process.env.CHAIN || rc.resolveNewestChain(rc.relayDirs(process.cwd()));
  if (!f) { console.error("no active chain"); process.exit(1); }
  const r = rc.loadChain(f); if (!r.ok) { console.error(r.error); process.exit(1); }
  rc.writeChain(f, rc.setPaused(r.chain, true));
  console.log("paused " + f);
'
```

Then republish the dashboard and report the open tasks — a pause is a checkpoint,
not an ending. Nothing is retired and no task changes state.

`resolveNewestChain(rc.relayDirs(process.cwd()))` is the **hooks-identical** walk:
up from the cwd to the nearest `.relay/`, plus the legacy `RELAY_DIR`. The bare
`resolveNewestChain()` is not the same thing — it looks only at `$PWD/.relay`, so
run from a subdirectory it silently finds nothing and the kill switch reports "no
active chain" on a chain that is running. From anywhere ambiguous — or with more
than one chain live — set `CHAIN=<path to chain-*.json>` first and skip the guess.
The same applies to `resume` below.

---

## resume

```
/relay resume [--choose <option>|--answer <text>]
```

Un-pauses, and — when the chain was stopped on a declared `waiting` class —
clears the wait with the human's answer, which is appended to `decisions[]` so the
ledger records why the loop restarted. `--choose` picks one of the recorded
`waiting.options`; `--answer` is free text. With neither, `resume` only un-pauses.

**A `waiting` chain needs an answer, not just an un-pause.** The driver stands
down on `waiting` (row 4) independently of `paused` (row 3), so clearing only the
pause leaves the loop down while the human believes they resumed it. The block
below therefore **refuses** rather than half-resuming: it prints the pending class
and question and exits 1, so ask the human, then re-run with the answer.

```bash
ANSWER="<the chosen option or the answer text, empty for a plain unpause>" node -e '
  const rc = require(process.env.HOME + "/.claude/hooks/lib/relay-chain.js");
  if (!rc.setPaused || !rc.clearWaiting || !rc.relayDirs) {
    console.error("the installed relay-chain.js predates v2.1 — re-run the relay library install step");
    process.exit(1);
  }
  const f = process.env.CHAIN || rc.resolveNewestChain(rc.relayDirs(process.cwd()));
  if (!f) { console.error("no active chain"); process.exit(1); }
  const r = rc.loadChain(f); if (!r.ok) { console.error(r.error); process.exit(1); }
  const w = r.chain.waiting;
  if (w && !process.env.ANSWER) {
    console.error(`still WAITING — ${w.class}: ${w.question}`);
    if (w.options) console.error("options: " + w.options.join(" | "));
    console.error("re-run with --answer <text> or --choose <option>");
    process.exit(1);
  }
  let c = rc.setPaused(r.chain, false);
  if (process.env.ANSWER)
    c = rc.clearWaiting(c, { answer: process.env.ANSWER, now: new Date().toISOString() });
  rc.writeChain(f, c);
  console.log(JSON.stringify({ paused: c.paused, waiting: c.waiting,
    decisions: (c.decisions || []).length }));
'
```

Republish the dashboard, then **act on the answer** — it was a real decision, and
the next loop iteration is the first turn that can honour it.

---

## Rules

- **Wire, never reimplement.** Every mutation goes through `relay-chain.js`; every
  spawn through `relay-spawn.sh`; every ack through `relay-await-ack.sh`.
- **`markVerified` demands evidence.** Never mark a task verified without running
  its `acceptance` and reading the output — a changed file is not a verified task.
- **Republish the dashboard on every transition** so the human view never lies.
- **Push only the chain's own branch.** `git push` of `relay/<chain_id>`, the PR,
  and `gh pr merge` proceed under the repository's standing authorizations in its
  `CLAUDE.md` (owned repos only) — that is what `T-ship` runs on, and
  the review pathway cannot close its loop without it. Everything else stays
  prohibited without explicit authorization: `push --force`, `rebase`,
  `reset --hard`, local `merge`, and any push to `master`. (Ruled 2026-08-29 after
  chain 2026-08-28-example-app-cfc6 D6; the spawn prompt in `relay-spawn.sh` says the same.)
- **Branch at start — the ONE authorized branch creation.** Creating
  `relay/<chain_id>` at the top of the chain is authorized because `T-ship` is
  the chain's terminal task and a PR is its rollback handle; record it in
  `ship.branch`. The standing prohibition on every OTHER branch, `rebase`,
  `reset --hard`, and `merge` command stands unchanged.
- **Two review rounds, then it stops being the chain's problem.** Count each
  round on the chain as it starts (`c = rc.bumpReviewRound(c)` — ship pathway
  step 3); that count is what makes the cap survive a handoff. If round 2
  leaves findings unresolved: `/found-issues:log` each one, then
  `c = rc.markEnded(c, { reason: "review-stalled" })`, **leave the PR open** so a
  human can finish it, let the dashboard show it in red, and `retireChain`.
  Nothing evaporates — a stalled chain still counts as ended, and `/relay next`
  is allowed to move on precisely because the findings are filed.
- **Owned repos only for self-merge.** `gh pr merge` under that standing
  authorization applies to repos the operator owns or leads. Anywhere else `T-ship`
  stops at "PR opened": `markEnded({ reason: "complete" })` with
  `ship.merged: false`, and `/relay next` correctly refuses until a human merges.
- **One holder writes.** After a successful handover (await-ack exit 0) this
  session stops writing repos; the baton guard enforces it — do not work around it.
- **Nothing evaporates at the cap.** File open tasks into a durable tracker before
  retiring an at-cap chain.
- **Every ledger helper is clone-then-return — assign the result.** `addTask`,
  `offerBaton`, `markDone`, `markVerified`, `setPaused`, `setWaiting`,
  `clearWaiting`, `logDecision`, `setShip`, `bumpReviewRound`, and `markEnded`
  all return a NEW chain and leave the caller's
  untouched. Spell them `c = rc.<helper>(c, …)` and finish with
  `rc.writeChain(f, c)`, or pass the return straight into `writeChain`. A bare
  `rc.offerBaton(c, { now });` writes a chain whose baton is still `held`; the
  successor's `claimBaton` throws `claim: baton not offered` and
  `relay-await-ack.sh` times out on a handover that never happened.
- **In an autonomous loop, decisions are logged, not asked.** Take the recommended
  default and append it with `c = rc.logDecision(c, { question, chosen, why, ts })`
  followed by `rc.writeChain(f, c)`, then keep going. Only the four declared stop classes end a turn — `spend`
  (metered / paid), `outward` (a send that leaves the machine), `money-path` (a
  write that moves or reports money), `ask-rule` (an irreversible the permission
  layer still gates). For one of those, write the wait and stop:
  ```bash
  node -e '
    const rc = require(process.env.HOME + "/.claude/hooks/lib/relay-chain.js");
    // Same walk the hooks use, and both results checked: an unresolved chain
    // (null f) threw ERR_INVALID_ARG_TYPE inside loadChain, and an unreadable one
    // threw at r.chain — either way the wait was never written and the loop kept
    // driving straight through the decision that was supposed to stop it.
    const f = rc.resolveNewestChain(rc.relayDirs(process.cwd()));
    if (!f) { console.error("no active chain"); process.exit(1); }
    const r = rc.loadChain(f);
    if (!r.ok) { console.error(r.error); process.exit(1); }
    rc.writeChain(f, rc.setWaiting(r.chain, { class: "<one of rc.WAITING_CLASSES>",
      question: "<what the human must decide>", options: ["<a>", "<b>"],
      now: new Date().toISOString() }));
  '
  ```
  `setWaiting` throws on a class outside `rc.WAITING_CLASSES` rather than writing a
  chain the baton guard would later skip. The driver reads `waiting` and stands
  down; `/relay resume --answer …` clears it. Mirrors
  `rules/interaction-style.md` § Interactive triage.
