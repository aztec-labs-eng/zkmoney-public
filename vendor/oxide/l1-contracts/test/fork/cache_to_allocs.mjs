#!/usr/bin/env node
// Converts a foundry RPC cache file (~/.foundry/cache/rpc/mainnet/<block>) into the two fixtures the offline fork
// tests load: a genesis-allocs JSON for `vm.loadAllocs` and a small block-env sidecar the fixture pins the EVM
// from. Run only when repinning (see test/fork/repin.sh), never at test time.
//
//   node cache_to_allocs.mjs <cache-file> <allocs-out.json> <env-out.json>
import { readFileSync, writeFileSync } from 'node:fs';

const [cachePath, allocsPath, envPath] = process.argv.slice(2);
if (!cachePath || !allocsPath || !envPath) {
  console.error('usage: cache_to_allocs.mjs <cache-file> <allocs-out.json> <env-out.json>');
  process.exit(1);
}

const cache = JSON.parse(readFileSync(cachePath, 'utf8'));

// forge-std's cheatcode + console pseudo-accounts leak into the cache (the cheatcode address holds the test-failed
// flag); loading them would clobber live cheatcode state.
const SKIP = new Set(['0x7109709ecfa91a80626ff3989d68f67f5b1dd12d', '0x000000000000000000636f6e736f6c652e6c6f67']);

const pad32 = (hex) => '0x' + BigInt(hex).toString(16).padStart(64, '0');

// Cached bytecode is revm-analyzed (zero-padded); slice back to the raw runtime code, empty for EOAs.
function codeOf(account) {
  const analyzed = account?.code?.LegacyAnalyzed;
  if (!analyzed || analyzed.original_len === 0) return '0x';
  return analyzed.bytecode.slice(0, 2 + 2 * analyzed.original_len);
}

const addresses = new Set([...Object.keys(cache.accounts), ...Object.keys(cache.storage)].map((a) => a.toLowerCase()));

const allocs = {};
for (const addr of [...addresses].sort()) {
  if (SKIP.has(addr)) continue;
  const account = cache.accounts[addr] ?? {};
  const slots = cache.storage[addr] ?? {};
  const entry = { nonce: '0x' + (account.nonce ?? 0).toString(16), balance: account.balance ?? '0x0' };
  const code = codeOf(account);
  if (code !== '0x') entry.code = code;
  if (Object.keys(slots).length) {
    entry.storage = {};
    for (const [slot, value] of Object.entries(slots)) entry.storage[pad32(slot)] = pad32(value);
  }
  allocs[addr] = entry;
}

const b = cache.meta.block_env;
const env = {
  number: b.number,
  timestamp: b.timestamp,
  basefee: '0x' + BigInt(b.basefee).toString(16),
  coinbase: b.beneficiary,
  prevrandao: b.prevrandao,
};

writeFileSync(allocsPath, JSON.stringify(allocs, null, 1) + '\n');
writeFileSync(envPath, JSON.stringify(env, null, 1) + '\n');
console.log(`wrote ${Object.keys(allocs).length} accounts -> ${allocsPath}`);
console.log(`wrote block env (number ${env.number}) -> ${envPath}`);
