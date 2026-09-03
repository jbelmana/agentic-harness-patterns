#!/usr/bin/env node
'use strict';
// relay-dashboard.js — render a relay chain JSON file into a self-contained
// HTML oversight dashboard. Renders only; the skill layer (Task 6) publishes
// the file via the Artifact tool. Spec: the relay v2 dashboard design note.
// CLI: node scripts/relay-dashboard.js [chain-file]  (default: newest active chain)
//   → writes dash-<chain_id>.html beside the chain, prints the path. Exit 0/1.
const fs = require('node:fs');
const path = require('node:path');
// __dirname-relative so the script works in-repo without a synced ~/.claude copy.
const { loadChain, resolveNewestChain, relayDirs, openTasks } =
  require(path.join(__dirname, '..', 'hooks', 'lib', 'relay-chain.js'));

// Argv-less default: the SAME dir set the guard, the monitor and the loop driver
// scan — up from the cwd to the nearest .relay/, plus the legacy RELAY_DIR.
// Reading RELAY_DIR alone meant the "republish the dashboard on every transition"
// rule silently rendered nothing (or a stale legacy chain) for every chain living
// where chains actually live now, i.e. <repo_root>/.relay. RELAY_DIR_OVERRIDE
// still PINS the scan to one dir, exactly as it does in the three hooks.
const dirs = process.env.RELAY_DIR_OVERRIDE
  ? [process.env.RELAY_DIR_OVERRIDE] : relayDirs(process.cwd());
const file = process.argv[2] || resolveNewestChain(dirs);
if (!file) { console.error('no active chain'); process.exit(1); }
const r = loadChain(file);
if (!r.ok) { console.error(`chain unreadable: ${r.error}`); process.exit(1); }
const c = r.chain;

const esc = (s) => String(s).replace(/[&<>"']/g,
  (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
// loadChain does not validate, so an unknown task state is reachable → default color.
const STATE_COLOR = { open: 'var(--amber)', done: 'var(--blue)', verified: 'var(--green)' };
const stateColor = (s) =>
  (Object.prototype.hasOwnProperty.call(STATE_COLOR, s) ? STATE_COLOR[s] : 'var(--fg)');

const rows = c.tasks.map((t) =>
  `<tr><td>${esc(t.id)}</td><td>${esc(t.desc)}</td>` +
  `<td style="color:${stateColor(t.state)}">${esc(t.state)}</td>` +
  `<td>gen ${esc(t.gen)}</td></tr>`).join('');
const gens = c.history.map((h) =>
  `<li>gen ${esc(h.gen)} · ${esc(h.token).slice(0, 8)}… · released ${esc(h.released)}</li>`).join('') +
  `<li><strong>gen ${esc(c.generation.current)} · ${esc(c.baton.holder_token).slice(0, 8)}… · ` +
  `${esc(c.baton.state)}</strong></li>`;
const alerts = (c.alerts || []).map((a) =>
  `<li style="color:var(--red)">${esc(a.at)} — ${esc(a.msg)}</li>`).join('');

// ── v2.1 oversight ──────────────────────────────────────────────────────────
// This page is the phone-side view of an unattended loop, so every state that
// ends a turn has to be readable at a glance. Badges accumulate rather than
// compete: a chain can be BOTH waiting and paused, and hiding either one would
// send the human to the terminal the dashboard exists to replace. Every v2.1
// field is optional — a schema-1 chain renders exactly as it always did.
const ship = c.ship && typeof c.ship === 'object' ? c.ship : null;
const endedBadge = () => {
  const reason = c.ended && c.ended.reason;
  if (reason === 'cap') return [`ENDED AT CAP — ${openTasks(c).length} remain`, 'amber'];
  if (reason === 'review-stalled')
    return [`REVIEW STALLED — PR ${esc((ship && ship.pr) || 'none')}`, 'red'];
  if (reason === 'complete') return ['ENDED — complete', 'green'];
  return null;
};
const status = [
  c.waiting && [`WAITING — ${esc(c.waiting.class)}: ${esc(c.waiting.question)}`, 'amber'],
  endedBadge(),
  c.paused && ['paused', 'amber'],
  ship && ship.merged === true && [`SHIPPED — ${esc(ship.pr || 'none')}`, 'green'],
].filter(Boolean)
  .map(([text, color]) => `<span style="color:var(--${color})">${text}</span>`).join(' · ');
const shipLine = ship ? `<p>Ship — branch ${esc(ship.branch || 'none')} · `
  + `PR ${esc(ship.pr || 'none')} · merged ${ship.merged ? 'yes' : 'no'} · `
  + `review rounds ${esc(ship.review_rounds ?? 0)}</p>` : '';
const decisions = (c.decisions || []).map((d) =>
  `<li>${esc(d.id)} · ${esc(d.question)} → <strong>${esc(d.chosen)}</strong> · ` +
  `gen ${esc(d.gen)}</li>`).join('');

const html = `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(c.chain_id)}</title><style>
:root{--bg:#fff;--fg:#111;--amber:#b45309;--blue:#1d4ed8;--green:#15803d;--red:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--amber:#fbbf24;--blue:#60a5fa;--green:#4ade80;--red:#f87171}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui;margin:2rem}
table{border-collapse:collapse}td,th{border:1px solid currentColor;padding:.3rem .6rem}
.wrap{overflow-x:auto}</style></head><body>
<h1>${esc(c.chain_id)}</h1>
<p>${esc(c.mode)} · ${esc(c.spawn_policy)} · ${esc(c.repo_root)}</p>
${status ? `<p><strong>${status}</strong></p>` : ''}${shipLine}
<h2>Generations</h2><ol start="0">${gens}</ol>
<h2>Tasks</h2><div class="wrap"><table>
<tr><th>id</th><th>desc</th><th>state</th><th>gen</th></tr>${rows}</table></div>
${decisions ? `<h2>Decisions</h2><ol>${decisions}</ol>` : ''}
${alerts ? `<h2>Alerts</h2><ul>${alerts}</ul>` : ''}
<footer>generation ${esc(c.generation.current)} of cap ${esc(c.generation.cap)} · rendered ${new Date().toISOString()}</footer>
</body></html>`;

const out = path.join(path.dirname(file), `dash-${c.chain_id}.html`);
fs.writeFileSync(out, html);
console.log(out);
