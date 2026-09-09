#!/usr/bin/env node
/**
 * gavel — scripts/outcomes.mjs
 *
 * Renders the coverage table: for each of the twelve reasons gavel can refuse
 * on, is it covered by a unit test, has it been OBSERVED in a real run, and does
 * a durable row exist for it.
 *
 * The distinction the table exists to make is "asserted" vs "observed". A
 * refusal branch covered only by a unit test is a claim about a pure function.
 * A refusal branch with a row in docs/outcomes-<chain>.jsonl is a claim about
 * this software running against a real Safe and a real chain. Those are not the
 * same evidence and the table must never let them look the same.
 *
 *   node scripts/outcomes.mjs [--chain 11155111] [--markdown]
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TAXONOMY } from './outcome-log.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const markdown = args.includes('--markdown');
const only = args.includes('--chain') ? args[args.indexOf('--chain') + 1] : null;

// ---- what the tests cover -------------------------------------------------
// A reason counts as unit-tested when its literal name appears in test/. That is
// deliberately a weak check: it proves a test mentions the branch, never that the
// assertion is meaningful. The table says "named in test/" for that reason.
const testDir = join(ROOT, 'test');
const testText = readdirSync(testDir)
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => readFileSync(join(testDir, f), 'utf8'))
  .join('\n');

// ---- what actually happened ----------------------------------------------
const docs = join(ROOT, 'docs');
const logs = existsSync(docs)
  ? readdirSync(docs).filter((f) => /^outcomes-\d+\.jsonl$/.test(f))
  : [];

const rows = [];
for (const f of logs) {
  const chainId = f.match(/outcomes-(\d+)\.jsonl/)[1];
  if (only && chainId !== only) continue;
  for (const line of readFileSync(join(docs, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a truncated tail is not a crash */ }
  }
}

const seen = new Map();
for (const r of rows) {
  const cur = seen.get(r.outcome) ?? { n: 0, first: null, chains: new Set(), tx: null, execId: null };
  cur.n += 1;
  cur.first ??= r.at;
  cur.chains.add(r.chainId);
  cur.tx ??= r.tx;
  cur.execId ??= r.executionId;
  seen.set(r.outcome, cur);
}

const order = Object.entries(TAXONOMY).sort((a, b) => (a[1].n ?? 99) - (b[1].n ?? 99));

if (markdown) {
  console.log('| # | outcome | decided by | named in `test/` | observed live | rows |');
  console.log('|---|---|---|---|---|---|');
  for (const [name, meta] of order) {
    const s = seen.get(name);
    console.log(
      `| ${meta.n ?? '—'} | \`${name}\` | ${meta.decidedBy} | ` +
      `${testText.includes(name) ? '✅' : '❌'} | ` +
      `${meta.unreachable ? '**n/a**' : (s ? '✅' : '❌')} | ${s ? s.n : 0} |`,
    );
  }
} else {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n  gavel · outcome coverage${only ? ` · chain ${only}` : ''}`);
  console.log(`  ${rows.length} recorded row(s) across ${logs.length} log file(s)\n`);
  console.log(`  ${pad('#', 3)} ${pad('outcome', 22)} ${pad('decided', 9)} ${pad('tested', 7)} ${pad('observed', 9)} rows`);
  for (const [name, meta] of order) {
    const s = seen.get(name);
    console.log(
      `  ${pad(meta.n ?? '-', 3)} ${pad(name, 22)} ${pad(meta.decidedBy, 9)} ` +
      `${pad(testText.includes(name) ? 'yes' : 'NO', 7)} ` +
      `${pad(meta.unreachable ? 'n/a' : (s ? 'yes' : 'no'), 9)} ${s ? s.n : 0}`,
    );
  }
  const reachable = order.filter(([, m]) => !m.unreachable);
  const observed = reachable.filter(([n]) => seen.has(n)).length;
  console.log(`\n  ${observed}/${reachable.length} REACHABLE outcomes observed in a real run.`);
  const blocked = order.filter(([, m]) => m.unreachable);
  if (blocked.length) {
    console.log(`\n  ${blocked.length} outcome(s) cannot be produced through the production data source.`);
    console.log(`  The guard stays either way — assemble.mjs is source-agnostic.\n`);
    for (const [name, m] of blocked) console.log(`    ${name}\n      ${m.unreachable}\n`);
  }
}
