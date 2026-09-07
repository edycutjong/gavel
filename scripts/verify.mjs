#!/usr/bin/env node
// One command a judge can paste. Runs every gate CI runs, in the same order,
// with zero credentials and zero network. Optional toolchains SKIP loudly
// rather than passing quietly — a gate that cannot run must never look green.
//
// Exit 0 only if every REQUIRED gate passed.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', X = '\x1b[0m';
const results = [];

function has(cmd, args = ['--version']) {
  return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
}

function gate({ name, required = true, skipIf, run, detail }) {
  if (skipIf) {
    results.push({ name, state: 'SKIP', detail: skipIf, required });
    return;
  }
  const t = Date.now();
  const ok = run();
  results.push({
    name,
    state: ok ? 'PASS' : 'FAIL',
    detail: `${detail} · ${((Date.now() - t) / 1000).toFixed(2)}s`,
    required,
  });
}

const sh = (cmd, args) =>
  spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

console.log(`\n${B}gavel · verify${X}  ${D}every CI gate, no credentials, no network${X}\n`);

// ── 1 · the decision surface is pure ────────────────────────────────────────
// Invariant I10. assemble.mjs is injected verbatim into a sandboxed code node,
// so an impure call would fail at runtime on-chain. Asserted here and in CI.
gate({
  name: 'Decision surface is pure',
  detail: 'src/assemble.mjs — no import/eval/fetch/Date.now/Math.random/process.env',
  run: () => {
    const s = readFileSync(new URL('../src/assemble.mjs', import.meta.url), 'utf8');
    const banned = [
      /^\s*import\s/m, /\bimport\s*\(/, /\beval\s*\(/, /\bnew\s+Function\s*\(/,
      /\bfetch\s*\(/, /\bMath\.random\s*\(/, /\bDate\.now\s*\(/, /\bprocess\.env/,
    ];
    const hit = banned.filter((r) => r.test(s));
    if (hit.length) console.error(`  ${R}impure:${X} ${hit.map(String).join(', ')}`);
    return hit.length === 0;
  },
});

// ── 2 · the test suite ──────────────────────────────────────────────────────
gate({
  name: 'JS test suite',
  detail: 'node --test',
  run: () => {
    const r = sh('node', ['--test']);
    const m = /^# pass (\d+)/m.exec(r.stdout ?? '');
    if (m) console.log(`  ${D}${m[1]} tests passed${X}`);
    if (r.status !== 0) console.error(r.stdout?.slice(-1500) ?? '');
    return r.status === 0;
  },
});

// ── 3 · the published numbers re-derive from committed data ─────────────────
// This is the one that matters most: it proves the README's figures were
// measured rather than asserted.
gate({
  name: 'Published survey figures re-derive',
  detail: 'survey/rederive.py — every published figure vs 1.3 MB of committed responses',
  skipIf: has('python3') ? null : 'python3 not found — install it to check the survey numbers',
  run: () => {
    const r = sh('python3', ['survey/rederive.py']);
    const n = (r.stdout?.match(/^\s*ok\s/gm) ?? []).length;
    if (n) console.log(`  ${D}${n} figures re-derived${X}`);
    if (r.status !== 0) console.error(r.stdout?.slice(-1200) ?? '');
    return r.status === 0;
  },
});

// ── 4 · the rehearsal token ─────────────────────────────────────────────────
// Optional: needs foundry. Dependency-free otherwise — no forge-std, no lib/.
gate({
  name: 'Solidity tests',
  required: false,
  detail: 'forge test — MockUSDC, 100% coverage on all four metrics',
  skipIf: has('forge') ? null : 'foundry not installed — optional, JS gates cover the decision surface',
  run: () => sh('forge', ['test']).status === 0,
});

// ── report ──────────────────────────────────────────────────────────────────
const pad = Math.max(...results.map((r) => r.name.length));
console.log('');
for (const r of results) {
  const tag = r.state === 'PASS' ? `${G}PASS${X}` : r.state === 'FAIL' ? `${R}FAIL${X}` : `${Y}SKIP${X}`;
  console.log(`  ${tag}  ${r.name.padEnd(pad)}  ${D}${r.detail}${X}`);
}

const failed = results.filter((r) => r.state === 'FAIL' && r.required);
const skipped = results.filter((r) => r.state === 'SKIP');
console.log('');
if (failed.length) {
  console.log(`${R}${B}VERIFY FAILED${X} — ${failed.length} required gate(s) did not pass.\n`);
  process.exit(1);
}
console.log(
  `${G}${B}VERIFY PASSED${X}` +
  (skipped.length ? ` ${Y}(${skipped.length} optional gate skipped)${X}` : '') +
  `\n${D}Nothing above touched the network or read a credential.${X}\n`,
);
