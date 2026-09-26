#!/usr/bin/env node
// Generates the TypeScript + Solidity mirrors of the shared constants from the single Noir source
// of truth `noir-projects/oxide_lib/src/constants.nr`. Run by `l1-contracts/bootstrap.sh generate`
// and `yarn-project/bootstrap.sh build`; the outputs are committed and a CI `git diff` guard fails
// if they drift from this generator.
//
// Supported `global` initializers: integer / hex literals (with `_` separators), `[u8; N]` byte
// arrays, `NAME + n` / `NAME - n` arithmetic over an earlier constant, `sha256_to_field("s".as_bytes())`,
// and `compute_secret_hash([NAME])` (single-element secret only). Any other expression aborts the build.
//
// The TypeScript mirror carries every constant. The Solidity mirror carries only the constants the
// Solidity sources reference as `OxideConstants.NAME`, so the L1 library does not grow with every
// Noir-only or TS-only value.
import { sha256ToField } from '@aztec/foundation/crypto/sha256';
import { Fr } from '@aztec/foundation/curves/bn254';
import { computeSecretHash } from '@aztec/stdlib/hash';

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const SRC = join(REPO, 'noir-projects', 'oxide_lib', 'src', 'constants.nr');
const TS_OUT = join(REPO, 'yarn-project', 'oxide-lib', 'src', 'oxide_constants.gen.ts');
const SOL_OUT = join(REPO, 'l1-contracts', 'src', 'generated', 'OxideConstants.gen.sol');
const SOL_LIB = 'OxideConstants';
// Solidity trees scanned for `OxideConstants.NAME` references. `src/generated` is skipped: it holds the output.
const SOL_SCAN_DIRS = ['src', 'test', 'script'].map(d => join(REPO, 'l1-contracts', d));
const SOL_SKIP_DIR = join(REPO, 'l1-contracts', 'src', 'generated');

const GLOBAL_RE = /pub\s+global\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^=]+?)\s*=\s*([\s\S]*?);/g;

// Parse one global's RHS into a normalized record. `prev` maps already-parsed names to their BigInt
// value, used by arithmetic and `compute_secret_hash`.
async function parseExpr(name, type, expr, prev) {
  // [u8; N] byte array -> TS Buffer only (no Solidity consumer).
  const arr = type.match(/^\[\s*u8\s*;\s*(\d+)\s*\]$/);
  if (arr) {
    const bytes = (expr.match(/0x[0-9a-fA-F]+|\d+/g) ?? []).map(t => Number(BigInt(t)));
    if (bytes.length !== Number(arr[1])) {
      throw new Error(`${name}: expected ${arr[1]} bytes, parsed ${bytes.length}`);
    }
    return { name, kind: 'bytes', bytes };
  }

  let m;
  // sha256_to_field("...".as_bytes())
  if ((m = expr.match(/^sha256_to_field\(\s*"([^"]*)"\s*\.as_bytes\(\)\s*\)$/))) {
    return { name, kind: 'fieldHash', value: sha256ToField([Buffer.from(m[1])]).toBigInt() };
  }
  // compute_secret_hash([NAME]) — a single-element secret hashes the same preimage as the TS scalar
  // computeSecretHash, so it evaluates with the Fr overload below.
  if ((m = expr.match(/^compute_secret_hash\(\s*\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]\s*\)$/))) {
    if (!prev.has(m[1])) throw new Error(`${name}: compute_secret_hash references unknown ${m[1]}`);
    return { name, kind: 'fieldHash', value: (await computeSecretHash(new Fr(prev.get(m[1])))).toBigInt() };
  }
  // integer / hex literal
  if ((m = expr.match(/^(0x[0-9a-fA-F]+|\d[\d_]*)$/))) {
    const hex = m[1].startsWith('0x');
    return { name, kind: 'int', type, hex, value: BigInt(m[1].replace(/_/g, '')) };
  }
  // NAME +/- n
  if ((m = expr.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*([+\-])\s*(\d+)$/))) {
    if (!prev.has(m[1])) throw new Error(`${name}: arithmetic references unknown ${m[1]}`);
    const base = prev.get(m[1]);
    const value = m[2] === '+' ? base + BigInt(m[3]) : base - BigInt(m[3]);
    return { name, kind: 'int', type, hex: false, value };
  }
  throw new Error(`${name}: unsupported initializer \`${expr}\``);
}

const UINT_BITS = { u8: 8, u16: 16, u32: 32, u64: 64, u128: 128 };

function tsValue(c) {
  if (c.kind === 'bytes')
    return `Buffer.from([${c.bytes.map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}])`;
  if (c.kind === 'fieldHash') return `0x${c.value.toString(16)}n`;
  // int: Field-typed or sized-uint literal. Emit bigint for values that exceed 2^53 or u128 limbs.
  const big = c.type === 'u128' || c.value >= 1n << 53n;
  if (big) return `0x${c.value.toString(16)}n`;
  return c.hex ? `0x${c.value.toString(16)}` : c.value.toString();
}

function solDecl(c) {
  if (c.kind === 'bytes') return null; // TS-only
  if (c.kind === 'fieldHash') {
    return `  bytes32 internal constant ${c.name} = bytes32(0x${c.value.toString(16).padStart(64, '0')});`;
  }
  const bits = UINT_BITS[c.type] ?? 256; // Field literal -> uint256
  const lit = c.hex || c.value >= 1n << 32n ? `0x${c.value.toString(16)}` : c.value.toString();
  return `  uint${bits} internal constant ${c.name} = ${lit};`;
}

const source = readFileSync(SRC, 'utf8');
// Strip line comments so `//` text never confuses the matcher (our values contain no `//`).
const stripped = source.replace(/^\s*\/\/.*$/gm, '');

const consts = [];
const prev = new Map();
for (const match of stripped.matchAll(GLOBAL_RE)) {
  const [, name, type, rawExpr] = match;
  const expr = rawExpr.replace(/\s+/g, ' ').trim();
  const c = await parseExpr(name, type.trim(), expr, prev);
  if (c.kind !== 'bytes') prev.set(name, c.value);
  consts.push(c);
}
if (consts.length === 0) throw new Error(`No constants parsed from ${SRC}`);

const tsBody = consts.map(c => `export const ${c.name} = ${tsValue(c)};`).join('\n');
const ts = `/* eslint-disable */
// GENERATED from noir-projects/oxide_lib/src/constants.nr by yarn-project/oxide-lib/scripts/gen_constants.mjs.
// Do not edit by hand. Field-valued constants are emitted as bigint; wrap with \`new Fr(...)\` at use sites.

${tsBody}
`;

// Collect the constant names the Solidity sources reference and emit only those. Constant names are upper case, so
// the pattern skips the `OxideConstants.gen.sol` import paths.
function solFiles(dir) {
  if (dir === SOL_SKIP_DIR) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap(e => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return solFiles(path);
    return e.name.endsWith('.sol') ? [path] : [];
  });
}
const solRefs = new Set();
for (const file of SOL_SCAN_DIRS.flatMap(solFiles)) {
  for (const m of readFileSync(file, 'utf8').matchAll(new RegExp(`\\b${SOL_LIB}\\.([A-Z][A-Z0-9_]*)\\b`, 'g'))) {
    solRefs.add(m[1]);
  }
}
const known = new Set(consts.map(c => c.name));
const unknownRefs = [...solRefs].filter(n => !known.has(n));
if (unknownRefs.length > 0) {
  throw new Error(`Solidity references constants missing from ${SRC}: ${unknownRefs.join(', ')}`);
}
const solConsts = consts.filter(c => solRefs.has(c.name));
if (solConsts.length === 0) throw new Error(`No Solidity references to ${SOL_LIB} found under l1-contracts`);
const solBody = solConsts.map(solDecl).filter(Boolean).join('\n');
const sol = `// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

// GENERATED from noir-projects/oxide_lib/src/constants.nr by yarn-project/oxide-lib/scripts/gen_constants.mjs.
// Do not edit by hand. Only the constants the Solidity sources reference are mirrored here.
library ${SOL_LIB} {
${solBody}
}
`;

mkdirSync(dirname(TS_OUT), { recursive: true });
mkdirSync(dirname(SOL_OUT), { recursive: true });
writeFileSync(TS_OUT, ts);
writeFileSync(SOL_OUT, sol);
console.log(`gen_constants: wrote ${consts.length} constants to ${TS_OUT}`);
console.log(`gen_constants: wrote ${solConsts.length} Solidity-referenced constants to ${SOL_OUT}`);
