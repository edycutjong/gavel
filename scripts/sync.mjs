#!/usr/bin/env node
/**
 * gavel — scripts/sync.mjs
 *
 * Generates the `gavel-drain` workflow JSON with `src/assemble.mjs` injected verbatim
 * into the Code node, so the canvas and the repo cannot drift. There is exactly one
 * copy of the decision logic in this project, and it is the file the unit tests run.
 *
 * Chain-aware, and it has to be. The Safe plugin's on-chain reads accept only
 * 1 | 10 | 8453 | 42161 — mainnets — while the queue read also serves Sepolia
 * (see specs/spike-results.md P7, filed upstream as DX-6). So:
 *
 *   chain 8453      -> safe/get-threshold, safe/get-owners, safe/get-nonce
 *   chain 11155111  -> web3/read-contract against the Safe's own view functions
 *
 * The judged artifact runs on 8453 and uses the safe/* actions; the rehearsal
 * substitutes read-contract. Same graph, same code node, same everything else.
 *
 *   node scripts/sync.mjs --chain 8453
 *   node scripts/sync.mjs --chain 11155111 --safe-integration <id> [--discord-integration <id>]
 *   node scripts/sync.mjs --chain 11155111 --safe-integration <id> --push
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'src', 'manifest.json'), 'utf8'));
const ROSTER = JSON.parse(readFileSync(join(ROOT, 'src', 'roster.json'), 'utf8'));

const flags = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) {
    const k = process.argv[i].slice(2);
    const n = process.argv[i + 1];
    if (!n || n.startsWith('--')) flags[k] = true; else { flags[k] = n; i++; }
  }
}

const chainId = String(flags.chain ?? '');
const chain = MANIFEST.chains[chainId];
if (!chain) {
  console.error(`--chain must be one of ${Object.keys(MANIFEST.chains).join(', ')}`);
  process.exit(1);
}

/** The Safe ABI fragments we need. execTransaction is the only manual ABI in the project. */
const EXEC_ABI = [{
  inputs: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' }, { name: 'signatures', type: 'bytes' },
  ],
  name: 'execTransaction', outputs: [{ name: 'success', type: 'bool' }],
  stateMutability: 'payable', type: 'function',
}];

const VIEW_ABI = (name, outType) => JSON.stringify([
  { inputs: [], name, outputs: [{ type: outType }], stateMutability: 'view', type: 'function' },
]);

/**
 * The Code node body: assemble.mjs verbatim, with ESM `export` keywords stripped
 * (the sandbox evaluates a plain script, not a module), plus a call wired to the
 * upstream template references.
 *
 * Stripping is textual and deliberately narrow — only `export ` at line start. If
 * assemble.mjs ever grows an import, this must fail loudly rather than emit a body
 * that silently drops it.
 */
function buildCodeBody() {
  const src = readFileSync(join(ROOT, 'src', 'assemble.mjs'), 'utf8');
  if (/^\s*import\s/m.test(src)) {
    console.error('assemble.mjs contains an import — it must stay dependency-free (invariant I10).');
    process.exit(1);
  }
  const stripped = src
    .replace(/^export default assemble;\s*$/m, '')
    .replace(/^export /gm, '');

  const roster = JSON.stringify(ROSTER.byChain?.[chainId] ?? ROSTER.safes ?? []);
  if (JSON.parse(roster).length === 0) {
    console.error(`roster is empty for chain ${chainId} — invariant I3 would refuse every Safe.\n  Run: node scripts/seed.mjs roster --chain ${chainId} --yes`);
    process.exit(1);
  }
  return `${stripped}
// ---- injected by scripts/sync.mjs — do not edit in the canvas ----
// The roster is embedded here, not read at runtime. Invariant I3: roster-1 builds
// the list, and this re-checks it, because the public Marketplace listing is a
// caller-open door and the first check is bypassable through it.
const ROSTER = ${roster};

const __hydrated = {{@hydrate-1:Hydrate Signatures.data}};
const __transactions = (__hydrated && __hydrated.results) ? __hydrated.results : [];

return assemble({
  safeAddress: "{{@trigger-1:Webhook.safeAddress}}",
  roster: ROSTER,
  queue: { transactions: __transactions, count: __transactions.length },
  onchainNonce: ${chainId === '8453'
    ? '"{{@nonce-1:Safe Nonce.nonce}}"'
    : '"{{@nonce-1:Read Nonce.result}}"'},
  onchainThreshold: ${chainId === '8453'
    ? '"{{@threshold-1:Safe Threshold.threshold}}"'
    : '"{{@threshold-1:Read Threshold.result}}"'},
  onchainOwners: ${chainId === '8453'
    ? '{{@owners-1:Safe Owners.owners}}'
    : '{{@owners-1:Read Owners.result}}'},
});`;
}

const SAFE_ADDR = '{{@trigger-1:Webhook.safeAddress}}';
const node = (id, label, type, config, x, y) => ({
  id, type: type === 'trigger' ? 'trigger' : 'action',
  position: { x, y },
  data: { label, type: type === 'trigger' ? 'trigger' : 'action', config },
});

/** The three on-chain reads, in the dialect the chain supports. */
function readNodes() {
  if (chainId === '8453') {
    return [
      node('threshold-1', 'Safe Threshold', 'action',
        { actionType: 'safe/get-threshold', network: chainId, contractAddress: SAFE_ADDR }, 750, 0),
      node('owners-1', 'Safe Owners', 'action',
        { actionType: 'safe/get-owners', network: chainId, contractAddress: SAFE_ADDR }, 1000, 0),
      // read LAST, closest to the write: smallest race window
      node('nonce-1', 'Safe Nonce', 'action',
        { actionType: 'safe/get-nonce', network: chainId, contractAddress: SAFE_ADDR }, 1250, 0),
    ];
  }
  const rc = (id, label, fn, out, x) => node(id, label, 'action', {
    actionType: 'web3/read-contract', network: chainId,
    contractAddress: SAFE_ADDR, abi: VIEW_ABI(fn, out), abiFunction: fn,
  }, x, 0);
  return [
    rc('threshold-1', 'Read Threshold', 'getThreshold', 'uint256', 750),
    rc('owners-1', 'Read Owners', 'getOwners', 'address[]', 1000),
    rc('nonce-1', 'Read Nonce', 'nonce', 'uint256', 1250),
  ];
}

const safeIntegration = flags['safe-integration'];
if (!safeIntegration || safeIntegration === true) {
  console.error('--safe-integration <id> is required (the Safe connection; see GET /api/integrations)');
  process.exit(1);
}
const discord = flags['discord-integration'] && flags['discord-integration'] !== true
  ? flags['discord-integration'] : null;
const web3Integration = flags['web3-integration'];
if (!web3Integration || web3Integration === true) {
  console.error('--web3-integration <id> is required (the wallet that signs execTransaction)');
  process.exit(1);
}

const nodes = [
  node('trigger-1', 'Webhook', 'trigger', { triggerType: 'Webhook' }, 0, 0),

  node('queue-1', 'Safe Queue', 'action', {
    actionType: 'safe/get-pending-transactions', network: chainId,
    safeAddress: SAFE_ADDR, integrationId: safeIntegration,
  }, 250, 0),

  // Δ1 (RATIFIED, complexity.md §4a). Without it every idle sweep runs three
  // on-chain reads and the Code node, then posts "skipped: no work" — ~720 idle
  // messages a day across a 5-Safe roster, and the live feed stops being readable.
  node('gate-0', 'Has Work', 'action', {
    actionType: 'Condition', condition: '{{@queue-1:Safe Queue.count}} > 0',
  }, 500, 0),

  ...readNodes(),

  // Baseline architecture, not a fallback: the plugin projection omits safeTxGas,
  // baseGas, gasPrice, gasToken and refundReceiver — five of execTransaction's ten
  // arguments, two of which are the hostile-refund vector (DX-1). Verified live.
  node('hydrate-1', 'Hydrate Signatures', 'action', {
    actionType: 'HTTP Request', httpMethod: 'GET',
    endpoint: `${chain.txService}/safes/${SAFE_ADDR}/multisig-transactions/?executed=false&limit=20`,
    timeout: 10, failOnError: false,
  }, 1500, 0),

  node('assemble-1', 'Assemble', 'action', {
    actionType: 'code/run-code', code: buildCodeBody(), timeout: 30,
  }, 1750, 0),

  node('gate-1', 'Executable', 'action', {
    actionType: 'Condition', condition: '{{@assemble-1:Assemble.result.executable}} === true',
  }, 2000, 0),

  // failOnError:false is deliberate. A Safe revert must become a NAMED, LOGGED
  // outcome, not a dead run — GS026 is an expected result, not a crash.
  node('exec-1', 'Exec Transaction', 'action', {
    actionType: 'web3/write-contract', network: chainId,
    contractAddress: SAFE_ADDR,
    integrationId: web3Integration,
    abi: JSON.stringify(EXEC_ABI), abiFunction: 'execTransaction',
    functionArgs: `["{{@assemble-1:Assemble.result.to}}","{{@assemble-1:Assemble.result.value}}","{{@assemble-1:Assemble.result.data}}",{{@assemble-1:Assemble.result.operation}},"{{@assemble-1:Assemble.result.safeTxGas}}","{{@assemble-1:Assemble.result.baseGas}}","{{@assemble-1:Assemble.result.gasPrice}}","{{@assemble-1:Assemble.result.gasToken}}","{{@assemble-1:Assemble.result.refundReceiver}}","{{@assemble-1:Assemble.result.signatures}}"]`,
    failOnError: false,
  }, 2250, -100),
];

const edges = [
  { id: 'e-trigger-queue', source: 'trigger-1', target: 'queue-1' },
  { id: 'e-queue-gate0', source: 'queue-1', target: 'gate-0' },
  { id: 'e-gate0-threshold', source: 'gate-0', target: 'threshold-1', sourceHandle: 'true' },
  { id: 'e-threshold-owners', source: 'threshold-1', target: 'owners-1' },
  { id: 'e-owners-nonce', source: 'owners-1', target: 'nonce-1' },
  { id: 'e-nonce-hydrate', source: 'nonce-1', target: 'hydrate-1' },
  { id: 'e-hydrate-assemble', source: 'hydrate-1', target: 'assemble-1' },
  { id: 'e-assemble-gate1', source: 'assemble-1', target: 'gate-1' },
  { id: 'e-gate1-exec', source: 'gate-1', target: 'exec-1', sourceHandle: 'true' },
];

if (discord) {
  nodes.push(
    node('report-exec-1', 'Report Executed', 'action', {
      actionType: 'discord/send-message', integrationId: discord,
      message: 'gavel · {{@trigger-1:Webhook.safeAddress}} · nonce {{@assemble-1:Assemble.result.nonce}}\nEXECUTED → {{@exec-1:Exec Transaction.transactionHash}}',
    }, 2500, -100),
    node('report-skip-1', 'Report Skipped', 'action', {
      actionType: 'discord/send-message', integrationId: discord,
      message: 'gavel · {{@trigger-1:Webhook.safeAddress}} · nonce {{@assemble-1:Assemble.result.nonce}}\nNOT executed → {{@assemble-1:Assemble.result.reason}}\n{{@assemble-1:Assemble.result.detail}}',
    }, 2250, 100),
  );
  edges.push(
    { id: 'e-exec-report', source: 'exec-1', target: 'report-exec-1' },
    { id: 'e-gate1-skip', source: 'gate-1', target: 'report-skip-1', sourceHandle: 'false' },
  );
}

const workflow = {
  name: `gavel-drain-${chainId}`,
  description: 'Executes Safe transactions that already reached their signature threshold but were never executed. Generated by scripts/sync.mjs — do not hand-edit in the canvas.',
  nodes, edges,
};
if (MANIFEST.projectId) workflow.projectId = MANIFEST.projectId;

mkdirSync(join(ROOT, 'workflows'), { recursive: true });
const out = join(ROOT, 'workflows', `gavel-drain-${chainId}.json`);
writeFileSync(out, JSON.stringify(workflow, null, 2));

console.log(`\n  ${chain.name} (${chainId}) — ${nodes.length} nodes, ${edges.length} edges`);
console.log(`  reads via ${chainId === '8453' ? 'safe/* plugin actions' : 'web3/read-contract (DX-6 workaround)'}`);
console.log(`  discord   ${discord ? 'wired' : 'omitted (no --discord-integration)'}`);
console.log(`  written   ${out.replace(ROOT, 'build')}\n`);

if (flags.push) {
  const key = readFileSync(join(homedir(), '.config', 'keeperhub', 'env'), 'utf8')
    .match(/^KH_API_KEY=(.+)$/m)?.[1].trim().replace(/['"]/g, '');
  if (!key) { console.error('KH_API_KEY not found in ~/.config/keeperhub/env'); process.exit(1); }
  const res = await fetch('https://app.keeperhub.com/api/workflows/create', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(workflow),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error(`  create failed HTTP ${res.status}`);
    console.error(JSON.stringify(body, null, 2).slice(0, 2000));
    process.exit(1);
  }
  console.log(`  pushed    workflow id ${body.id}\n`);
}
