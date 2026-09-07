#!/usr/bin/env node
/**
 * gavel — scripts/sweep.mjs
 *
 * The volume harness. Runs the closed loop unattended:
 *
 *   recycle (PAYEE -> O1)  ->  fund  ->  stage  ->  drain  ->  repeat
 *
 * It orchestrates seed.mjs and drain.mjs rather than reimplementing them, so
 * there is exactly one copy of every decision and this file cannot drift from
 * the thing it is driving.
 *
 * Why it exists: a single execution is a demonstration. The audit invariant --
 * audit.mjs refusing every receiptsEligible:false row -- only becomes evidence
 * once it has held hundreds of times under load. Drains are gas-sponsored
 * through KeeperHub, and recycle closes the USDC loop, so the only cost of
 * another cycle is wall-clock.
 *
 * Every Safe swept is one we deployed. This is MECHANISM volume, disclosed as
 * such, and it is never summed with third-party volume.
 *
 * Usage
 *   node scripts/sweep.mjs --chain 11155111 --cycles 5            # dry, prints the plan
 *   node scripts/sweep.mjs --chain 11155111 --cycles 5 --yes      # runs
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = join(HERE, 'seed.mjs');
const DRAIN = join(HERE, 'drain.mjs');

const flags = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) {
    const k = process.argv[i].slice(2);
    const n = process.argv[i + 1];
    flags[k] = !n || n.startsWith('--') ? true : n;
  }
}
const chain = String(flags.chain ?? '11155111');
const cycles = Number(flags.cycles ?? 1);
const wanted = String(flags.safes ?? 'VOL_1,VOL_2,VOL_3,VOL_4').split(',');
const live = flags.yes === true;

const run = (file, args) =>
  spawnSync('node', [file, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Resolve id -> address from seed.mjs's own status output. One source of truth. */
function roster() {
  const r = run(SEED, ['status', '--chain', chain]);
  const map = {};
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = /^\s{2}([A-Z_0-9]+)\s+(0x[0-9a-fA-F]{40})\s+(yes|no)\s/.exec(line);
    if (m) map[m[1]] = m[2];
  }
  return map;
}

const addr = roster();
const missing = wanted.filter((w) => !addr[w]);
if (missing.length) {
  console.error(`  cannot resolve ${missing.join(', ')} from seed.mjs status — is the cast deployed?`);
  process.exit(1);
}

console.log(`\n  sweep — chain ${chain} · ${cycles} cycle(s) x ${wanted.length} Safe(s) = ${cycles * wanted.length} executions`);
wanted.forEach((w) => console.log(`    ${w.padEnd(8)} ${addr[w]}`));
if (!live) {
  console.log(`\n  Dry run. Re-run with --yes to execute.\n`);
  process.exit(0);
}

let executed = 0, refused = 0, failed = 0;
const started = Date.now();

for (let c = 1; c <= cycles; c++) {
  console.log(`\n  -- cycle ${c}/${cycles} ${'-'.repeat(40)}`);

  // 1 · close the loop, then refill. recycle is a no-op when PAYEE is empty.
  run(SEED, ['recycle', '--chain', chain, '--yes']);
  const f = run(SEED, ['fund', '--chain', chain, '--only', wanted.join(','), '--yes']);
  if (/ERROR|insufficient/i.test(f.stdout + f.stderr)) {
    console.error(`  fund failed — stopping.\n${(f.stdout + f.stderr).slice(-400)}`);
    break;
  }

  for (const id of wanted) {
    // 2 · manufacture the condition: signed to threshold, deliberately unexecuted.
    const s = run(SEED, ['stage', '--chain', chain, '--safe', id, '--yes']);
    if (!/THRESHOLD MET/.test(s.stdout ?? '')) {
      console.log(`    ${id.padEnd(8)} stage skipped — ${(s.stdout ?? '').trim().split('\n').pop()?.slice(0, 70)}`);
      continue;
    }
    // 3 · and drain it, through KeeperHub, from a wallet that owns none of it.
    const d = run(DRAIN, ['--chain', chain, '--address', addr[id], '--execute']);
    const out = d.stdout ?? '';
    const tx = /tx\s+(\S+)/.exec(out)?.[1];
    if (/EXECUTED through KeeperHub/.test(out)) {
      executed++;
      console.log(`    ${id.padEnd(8)} EXECUTED  ${tx ?? ''}`);
    } else if (/REFUSED|not-next-nonce|below-threshold/.test(out)) {
      refused++;
      console.log(`    ${id.padEnd(8)} refused   ${/reason\s+(\S+)/.exec(out)?.[1] ?? 'see log'}`);
    } else {
      failed++;
      console.log(`    ${id.padEnd(8)} FAILED    ${out.trim().split('\n').pop()?.slice(0, 70)}`);
    }
  }
}

const mins = ((Date.now() - started) / 60000).toFixed(1);
console.log(`\n  ${executed} executed · ${refused} refused · ${failed} failed · ${mins} min`);
console.log(`  Run scripts/audit.mjs to pull the rows KeeperHub recorded for these.\n`);
