#!/usr/bin/env node
// pre-tool-use-loc-check.js — 200 LOC hard rule enforcement
//
// Blocks Write/Edit tool calls that would produce a code file exceeding 200
// non-blank, non-comment lines. Inspired by a teammate's codebase discipline:
// "MAX 200 LOC per file — keeps single-responsibility honest and every file
// fits in an AI subagent's working context."
//
// Escape hatches:
//   1. Non-code extensions (.md, .json, .yaml, .txt, .html, .svg, .csv, locks)
//   2. Generated/vendored paths (node_modules, .next, dist, build, etc.)
//   3. Per-project `.loc-exceptions` file with explicit path globs
//
// Rule source: ~/.claude/rules/code-standards.md (formerly modular-design.md)
// Adopted: 2026-04-15

const fs = require('fs');
const path = require('path');

const LOC_LIMIT = 200;

const SKIP_EXTENSIONS = new Set([
  '.md', '.mdx', '.json', '.yaml', '.yml', '.txt', '.html',
  '.svg', '.csv', '.lock', '.toml', '.ini', '.env', '.xml',
]);

const EXEMPT_PATH_PATTERNS = [
  /[\\/]node_modules[\\/]/,
  /[\\/]\.next[\\/]/,
  /[\\/]dist[\\/]/,
  /[\\/]build[\\/]/,
  /[\\/]\.turbo[\\/]/,
  /[\\/]prisma[\\/]migrations[\\/]/,
  /\.generated\./,
  /\.min\./,
  /[\\/]package-lock\.json$/,
  /[\\/]yarn\.lock$/,
  /[\\/]pnpm-lock\.yaml$/,
  /[\\/]\.git[\\/]/,
];

// Line-comment markers by extension. Block comments handled separately.
const LINE_COMMENT_MARKERS = {
  '.ts': ['//'], '.tsx': ['//'], '.js': ['//'], '.jsx': ['//'],
  '.mjs': ['//'], '.cjs': ['//'], '.go': ['//'], '.rs': ['//'],
  '.java': ['//'], '.c': ['//'], '.cpp': ['//'], '.h': ['//'],
  '.py': ['#'], '.rb': ['#'], '.sh': ['#'], '.bash': ['#'],
  '.ex': ['#'], '.exs': ['#'], '.elixir': ['#'],
  '.sql': ['--'], '.lua': ['--'],
};

function isExemptByPath(filePath) {
  return EXEMPT_PATH_PATTERNS.some(re => re.test(filePath));
}

function isSkippedExtension(filePath) {
  return SKIP_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function countEffectiveLines(content, ext) {
  if (!content) return 0;
  const markers = LINE_COMMENT_MARKERS[ext.toLowerCase()] || [];
  const lines = content.split(/\r?\n/);
  let inBlockComment = false;
  let count = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    if (markers.some(m => line.startsWith(m))) continue;
    count++;
  }
  return count;
}

function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/\*\*/g, '__DS__').replace(/\*/g, '[^/\\\\]*').replace(/__DS__/g, '.*');
  return new RegExp('^' + pattern + '$');
}

function readLocExceptions(startDir) {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, '.loc-exceptions');
    try {
      if (fs.existsSync(candidate)) {
        const body = fs.readFileSync(candidate, 'utf8');
        return { base: dir, patterns: body.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')) };
      }
    } catch { /* ignore */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function isExemptByLocFile(filePath) {
  const exceptions = readLocExceptions(path.dirname(filePath));
  if (!exceptions) return false;
  const rel = path.relative(exceptions.base, filePath).replace(/\\/g, '/');
  return exceptions.patterns.some(pattern => {
    if (pattern === rel) return true;
    try { return globToRegex(pattern).test(rel); } catch { return false; }
  });
}

function applyEdit(existingContent, oldString, newString, replaceAll) {
  if (replaceAll) return existingContent.split(oldString).join(newString);
  const idx = existingContent.indexOf(oldString);
  if (idx === -1) return existingContent;
  return existingContent.slice(0, idx) + newString + existingContent.slice(idx + oldString.length);
}

function main() {
  let input = '';
  const timeout = setTimeout(() => process.exit(0), 4000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => input += c);
  process.stdin.on('end', () => {
    clearTimeout(timeout);
    try {
      const data = JSON.parse(input);
      const toolName = data.tool_name;
      if (toolName !== 'Write' && toolName !== 'Edit') return process.exit(0);
      const filePath = data.tool_input?.file_path || '';
      if (!filePath) return process.exit(0);
      if (isSkippedExtension(filePath)) return process.exit(0);
      if (isExemptByPath(filePath)) return process.exit(0);
      if (isExemptByLocFile(filePath)) return process.exit(0);

      let projected = '';
      if (toolName === 'Write') {
        projected = data.tool_input?.content || '';
      } else {
        let existing = '';
        try { existing = fs.readFileSync(filePath, 'utf8'); } catch { return process.exit(0); }
        const { old_string, new_string, replace_all } = data.tool_input || {};
        if (typeof old_string !== 'string' || typeof new_string !== 'string') return process.exit(0);
        projected = applyEdit(existing, old_string, new_string, !!replace_all);
      }

      const ext = path.extname(filePath);
      const loc = countEffectiveLines(projected, ext);
      if (loc <= LOC_LIMIT) return process.exit(0);

      const rel = filePath.replace(/\\/g, '/');
      const msg = [
        `BLOCKED by the 200 LOC hard rule (see the harness's code-standards rule)`,
        ``,
        `  File:  ${rel}`,
        `  LOC:   ${loc} (limit ${LOC_LIMIT}, non-blank non-comment)`,
        ``,
        `Options:`,
        `  1. Extract a module. Pull cohesive sections into a sibling file; re-import.`,
        `  2. Split by responsibility, not technical layer — files that change together stay together.`,
        `  3. If this file is an unavoidable exception (generated, vendored, legacy pending refactor):`,
        `       echo "${path.basename(rel)}" >> .loc-exceptions`,
        `     Then re-run the edit. Add a comment above the entry justifying why.`,
        ``,
        `A codebase held to this limit stays almost entirely compliant — small files are reusable by default.`,
      ].join('\n');
      process.stderr.write(msg + '\n');
      process.exit(2);
    } catch (err) {
      // Never block on hook errors — fail open.
      process.stderr.write(`[loc-check] hook error (fail-open): ${err.message}\n`);
      process.exit(0);
    }
  });
}

main();
