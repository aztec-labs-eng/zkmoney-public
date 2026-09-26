#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// VENDORED from oxide@bd42c7c `yarn-project/end-to-end-oxide/src/test_utils/gen_test_attestation.ts`.
//
// Upstream made the `@oxide/end-to-end-oxide` package un-exported (test-internal), so obsidion can
// no longer import `generateTestAttestation` / `TestAttestationFixture` / `RootArgs` /
// `deployTestCertManager` from it. We vendor the test-only attestation generator here, mirroring the
// `packages/sdk/src/oxide/` vendoring rationale. Re-sync this file (and its sibling
// `deploy_test_cert_manager.ts`) on the next oxide bump.
// ─────────────────────────────────────────────────────────────────────────────
// gen_test_attestation.ts — produce a fake-Nitro attestation document signed by a self-issued
// (root, leaf) chain.
//
// Two surfaces:
//
//   (a) Library: `generateTestAttestation(opts)` returns buffers + JSON-shaped objects in memory.
//       Use this from tests / scripts that need a fresh attestation without polluting the disk.
//   (b) CLI: pass `--out <dir>` to additionally serialise the same content to disk in the layout
//       the Solidity test fixtures and `@oxide/oxide-lib/src/attestation/fixtures/generated/` expect:
//
//         <out>/attestation.cose       — COSE_Sign1 ready to feed to NitroValidator.validateAttestation
//         <out>/root.der               — Test root CA cert (P-384 self-signed)
//         <out>/leaf.der               — Leaf cert that signed the COSE_Sign1
//         <out>/cabundle/NN.der        — Intermediate CA chain root → … → leaf parent
//         <out>/root_args.json         — TestCertManager constructor args (constants of the test root)
//         <out>/summary.json           — Signing keys + PCR0 + timestamp + user_data + cabundleCount
//
// Compiled to `dest/src/test_utils/gen_test_attestation.js` (inside @oxide/end-to-end-oxide).
// From `yarn-project/end-to-end-oxide/`:
//
//   node dest/src/test_utils/gen_test_attestation.js \
//     [--cabundleCount N]               (default: 0; produces a chain root → int_0 → … → int_{N-1} → leaf)
//     [--pubKeyX 0x...32-byte...]       (default: X from a fresh secp256k1 keypair; mirrored to L2)
//     [--pubKeyY 0x...32-byte...]       (default: paired Y; must be supplied together with --pubKeyX)
//     [--encPubKeyX 0x...32-byte...]    (default: random 32 bytes)
//     [--encPubKeyY 0x...32-byte...]    (default: random 32 bytes)
//     [--pcr0 0x...96 hex chars...]     (default: SHA-384 of "oxide-test-pcr0" / 48 bytes)
//     [--out <dir>]                     (omit → no disk writes; the CLI prints summary.json to stdout)
//
// The user_data hash is computed via `computeAttestationUserData` so the script and the
// on-chain validator (and the TS verifier) bind the exact same 140-byte preimage. Portal-context
// fields (portal, chainId, l2Portal, rollupVersion) are intentionally absent — they're compiled
// into the enclave image, so PCR0 already commits to them. The L1 eth address used as the
// `$teeBindings` storage key is derived from `(pubKeyX || pubKeyY)` via keccak on registration.
//
// Requires: `openssl` on PATH.
import { Buffer32 } from '@aztec/foundation/buffer';
import { keccak256 } from '@aztec/foundation/crypto/keccak';
import { EthAddress } from '@aztec/foundation/eth-address';

import { cborArray, cborBytes, cborText, cborUint } from '@oxide/oxide-lib/attestation/nitro_attestation/parsers.js';
import { computeAttestationUserData } from '@oxide/oxide-lib/attestation/user_data.js';

import { execFileSync } from 'node:child_process';
import { createHash, createSign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

// ──────────────────────────────────────────────────────────────────────────────
// OpenSSL config templates — declared up here so the helpers below can reference them.
// They enforce BasicConstraints + KeyUsage exactly the way CertManager._verifyExtensions wants.
// ──────────────────────────────────────────────────────────────────────────────

const ROOT_CNF = `
[req]
distinguished_name = dn
prompt = no

[dn]
CN = oxide-test-root

[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, digitalSignature, cRLSign, keyCertSign
`;

const LEAF_CNF = `
[req]
distinguished_name = dn
prompt = no

[dn]
CN = oxide-test-leaf

[v3_leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
`;

function cabundleCnf(commonName: string): string {
  return `
[req]
distinguished_name = dn
prompt = no

[dn]
CN = ${commonName}

[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, digitalSignature, cRLSign, keyCertSign
`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

export interface TestAttestationOptions {
  /** Number of intermediate CAs between root and leaf. Default 0. */
  cabundleCount?: number;
  /** Secp256k1 pubkey X (32 bytes big-endian). Defaults to a coordinate from a fresh secp256k1
   *  keypair so the fixture has a real on-curve point. Must be supplied together with `pubKeyY`. */
  pubKeyX?: Buffer32;
  /** Secp256k1 pubkey Y (32 bytes big-endian). Default: paired with the auto-generated `pubKeyX`. */
  pubKeyY?: Buffer32;
  /** P-256 encryption pubkey X coordinate (32 bytes BE). Default `Buffer32.random()`. */
  encPubKeyX?: Buffer32;
  /** P-256 encryption pubkey Y coordinate (32 bytes BE). Default `Buffer32.random()`. */
  encPubKeyY?: Buffer32;
  /** 48-byte PCR0 measurement. Default SHA-384 of `"oxide-test-pcr0"`. (Foundation has no
   *  `Buffer48`, so this stays as a raw `Buffer`.) */
  pcr0?: Buffer;
  /** Attestation timestamp in milliseconds (the COSE payload `timestamp` field). Default
   *  `Date.now()`. Tests with a warped L1 chain should pass `block.timestamp * 1000n` so the
   *  on-chain `StaleTEEAttestation` check (which compares against `block.timestamp`, not
   *  wall-clock) sees a fresh attestation. */
  timestampMillis?: number;
  /** Reuse a chain already deployed on L1 so a second enclave attests under the same root. */
  chain?: TestCertChain;
}

/**
 * The test root's TestCertManager constructor args.
 */
export interface RootArgs {
  certHash: Buffer32;
  notAfter: number;
  maxPathLen: number;
  subjectHash: Buffer32;
  /** Raw 96-byte uncompressed P-384 pubkey (X || Y, no `0x04` prefix). */
  pubKey: Buffer;
}

/**
 * The fixture metadata.
 */
export interface Summary {
  timestampMillis: number;
  moduleId: string;
  pcr0: Buffer;
  teePubKeyX: Buffer32;
  teePubKeyY: Buffer32;
  /** Derived from `(teePubKeyX || teePubKeyY)` via the same keccak shape `OxidePortal.sol::registerTee`
   *  uses on L1. Kept in the summary for human-readable test fixtures. */
  teeEthAddress: EthAddress;
  encPubKeyX: Buffer32;
  encPubKeyY: Buffer32;
  userData: Buffer32;
  rootCertNotAfter: number;
  rootCertHash: Buffer32;
  cabundleCount: number;
}

/** Bundle of buffers + JSON-shaped objects produced by one fixture run. */
export interface TestAttestationFixture {
  attestationCose: Buffer;
  rootDer: Buffer;
  leafDer: Buffer;
  cabundleDers: Buffer[];
  rootArgs: RootArgs;
  summary: Summary;
  /** The chain (with signing keys) this fixture was minted under; pass it back to attest another enclave. */
  chain: TestCertChain;
}

/** PCR0 measurement used by the local-mode TEE. Stable across calls so the on-chain
 *  approved-PCR0 allowlist entry stays valid across enclave restarts. The exact bytes don't
 *  matter — `MockNitroValidator` doesn't care about PCR0 content, only that the operator
 *  pre-allowlists `keccak256(pcr0)`. Picking a fixed dev constant gives us a stable identity. */
export const LOCAL_DEV_PCR0 = sha384(Buffer.from('oxide-test-pcr0'));

export interface TestCertChain {
  /** Self-signed root P-384 cert, PEM-encoded. */
  rootPem: Buffer;
  /** Root EC private key, PEM-encoded. */
  rootKey: Buffer;
  /** Same root cert, DER-encoded — embedded into the Nitro cabundle. */
  rootDer: Buffer;
  /** Leaf P-384 cert that signs the COSE_Sign1 attestation, PEM-encoded. */
  leafPem: Buffer;
  /** Leaf EC private key, PEM-encoded. Held in-memory and used per `signCoseAttestation` call. */
  leafKey: Buffer;
  /** Same leaf cert, DER-encoded — embedded as the COSE `certificate` field. */
  leafDer: Buffer;
  /** Intermediate CA PEMs, ordered root-→-leafParent. Empty when `cabundleCount = 0`. */
  cabundlePems: Buffer[];
  /** Intermediate CA private keys, matches `cabundlePems` by index. */
  cabundleKeys: Buffer[];
  /** Intermediate CAs, DER-encoded — appended to the Nitro `cabundle` after `rootDer`. */
  cabundleDers: Buffer[];
  /** Forward-compat `TestCertManager` constructor args. The off-chain mock validator doesn't
   *  read these; persisting them keeps the door open to flipping to real on-chain validation. */
  rootArgs: RootArgs;
}

export interface GenerateTestCertChainOptions {
  /** Number of intermediate CAs between root and leaf. Default 0. */
  cabundleCount?: number;
}

/**
 * Mint a (root, [cabundle...], leaf) P-384 cert chain via openssl. Returns everything in-memory;
 * no disk side effects past a transient tmpdir that's cleaned up before return.
 *
 * Use {@link writeCertChainToDir} to persist for re-use across processes (e.g. dev-box
 * → local enclave handoff), and {@link loadCertChainFromDir} to read it back.
 */
export function generateTestCertChain(opts: GenerateTestCertChainOptions = {}): TestCertChain {
  const cabundleCount = opts.cabundleCount ?? 0;
  if (!Number.isInteger(cabundleCount) || cabundleCount < 0) {
    throw new Error(`cabundleCount must be a non-negative integer (got ${cabundleCount})`);
  }

  const work = mkdtempSync(join(tmpdir(), 'oxide-attestation-'));
  try {
    // 1. Root: P-384 self-signed, BasicConstraints CA:TRUE, KeyUsage keyCertSign
    writeFileSync(`${work}/root.cnf`, ROOT_CNF);
    runOpenssl(['ecparam', '-name', 'secp384r1', '-genkey', '-noout', '-out', `${work}/root.key`]);
    // prettier-ignore
    runOpenssl([
      'req', '-x509', '-new',
      '-key', `${work}/root.key`,
      '-config', `${work}/root.cnf`,
      '-extensions', 'v3_ca',
      '-days', '3650',
      '-sha384',
      '-out', `${work}/root.pem`,
    ]);

    // 2. Cabundle entries (CA, signed by previous): produces a chain root → int_0 → int_1 → ... that
    //    `verifyTeeCACert` can stage one cert per tx before the final `registerTee` call.
    const cabundlePems: Buffer[] = [];
    const cabundleKeys: Buffer[] = [];
    const cabundleDers: Buffer[] = [];
    let parentPem = `${work}/root.pem`;
    let parentKey = `${work}/root.key`;
    for (let i = 0; i < cabundleCount; i++) {
      const cnfPath = `${work}/int_${i}.cnf`;
      writeFileSync(cnfPath, cabundleCnf(`oxide-test-int-${i}`));
      runOpenssl(['ecparam', '-name', 'secp384r1', '-genkey', '-noout', '-out', `${work}/int_${i}.key`]);
      // prettier-ignore
      runOpenssl([
        'req', '-new',
        '-key', `${work}/int_${i}.key`,
        '-config', cnfPath,
        '-sha384',
        '-out', `${work}/int_${i}.csr`,
      ]);
      // prettier-ignore
      runOpensslSignCertWithCanonicalRS([
        'x509', '-req',
        '-in', `${work}/int_${i}.csr`,
        '-CA', parentPem,
        '-CAkey', parentKey,
        '-CAcreateserial',
        '-extfile', cnfPath,
        '-extensions', 'v3_ca',
        '-days', '3650',
        '-sha384',
        '-out', `${work}/int_${i}.pem`,
      ], `${work}/int_${i}.pem`);
      cabundlePems.push(readFileSync(`${work}/int_${i}.pem`));
      cabundleKeys.push(readFileSync(`${work}/int_${i}.key`));
      cabundleDers.push(pemToDer(`${work}/int_${i}.pem`));
      parentPem = `${work}/int_${i}.pem`;
      parentKey = `${work}/int_${i}.key`;
    }

    // 3. Leaf: signed by the last cabundle entry (or the root if cabundleCount=0).
    writeFileSync(`${work}/leaf.cnf`, LEAF_CNF);
    runOpenssl(['ecparam', '-name', 'secp384r1', '-genkey', '-noout', '-out', `${work}/leaf.key`]);
    // prettier-ignore
    runOpenssl([
      'req', '-new',
      '-key', `${work}/leaf.key`,
      '-config', `${work}/leaf.cnf`,
      '-sha384',
      '-out', `${work}/leaf.csr`,
    ]);
    // prettier-ignore
    runOpensslSignCertWithCanonicalRS([
      'x509', '-req',
      '-in', `${work}/leaf.csr`,
      '-CA', parentPem,
      '-CAkey', parentKey,
      '-CAcreateserial',
      '-extfile', `${work}/leaf.cnf`,
      '-extensions', 'v3_leaf',
      '-days', '3650',
      '-sha384',
      '-out', `${work}/leaf.pem`,
    ], `${work}/leaf.pem`);

    const rootPem = readFileSync(`${work}/root.pem`);
    const rootKey = readFileSync(`${work}/root.key`);
    const rootDer = pemToDer(`${work}/root.pem`);
    const leafPem = readFileSync(`${work}/leaf.pem`);
    const leafKey = readFileSync(`${work}/leaf.key`);
    const leafDer = pemToDer(`${work}/leaf.pem`);

    const rootMeta = parseTestRoot(rootDer);
    const rootArgs: RootArgs = {
      certHash: Buffer32.fromBuffer(keccak256(rootDer)),
      notAfter: rootMeta.notAfter,
      maxPathLen: -1,
      subjectHash: Buffer32.fromBuffer(keccak256(rootMeta.subjectContent)),
      pubKey: rootMeta.pubKey,
    };

    return { rootPem, rootKey, rootDer, leafPem, leafKey, leafDer, cabundlePems, cabundleKeys, cabundleDers, rootArgs };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface SignCoseAttestationOptions {
  /** 48-byte PCR0 measurement to embed. */
  pcr0: Buffer;
  /** 32-byte user_data hash to embed (e.g. `computeAttestationUserData(...)`). */
  userData: Buffer;
  /** COSE payload timestamp in milliseconds. Defaults to `Date.now()`. The on-chain
   *  `TEE_ATTESTATION_MAX_AGE` check is against `block.timestamp`, so callers driving a warped
   *  L1 chain should pass `block.timestamp * 1000n`. */
  timestampMillis?: number;
  /** Override the Nitro `module_id` field. Default is a fresh `i-test-<base36>` per call. */
  moduleId?: string;
  /** Overrides for non-zero PCRs other than PCR0. Indexes not listed default to 48 zero bytes. */
  extraPcrs?: Record<number, Buffer>;
}

/**
 * Build and sign a fresh COSE_Sign1 Nitro attestation against an existing {@link TestCertChain}.
 * Cheap (~ms) — only the payload + Sig_structure1 + ES384 signature are rebuilt per call. The
 * chain is loaded once.
 */
export function signCoseAttestation(chain: TestCertChain, opts: SignCoseAttestationOptions): Buffer {
  if (opts.pcr0.length !== 48) {
    throw new Error(`pcr0 must be 48 bytes (got ${opts.pcr0.length})`);
  }
  if (opts.userData.length !== 32) {
    throw new Error(`userData must be 32 bytes (got ${opts.userData.length})`);
  }

  const pcrs: Record<number, Buffer> = { 0: opts.pcr0, ...(opts.extraPcrs ?? {}) };
  for (let i = 1; i < 16; i++) {
    pcrs[i] ??= Buffer.alloc(48);
  }

  const timestampMillis = opts.timestampMillis ?? Date.now();
  const moduleId = opts.moduleId ?? `i-test-${Date.now().toString(36)}`;

  const payload = encodePayload({
    moduleId,
    timestampMillis,
    pcrs,
    certificate: chain.leafDer,
    cabundle: [chain.rootDer, ...chain.cabundleDers],
    userData: opts.userData,
  });

  // ES384 protected header: {1: -35}
  const protectedHdr = cborMap([[cborUint(0, 1), cborInt(-35)]]);

  // Sig_structure1 = ["Signature1", protected, b"", payload]
  const sigStructure = cborArray([
    cborText('Signature1'),
    cborBytes(protectedHdr),
    cborBytes(Buffer.alloc(0)),
    cborBytes(payload),
  ]);

  const signature = signES384(chain.leafKey, sigStructure);

  // COSE_Sign1 = [protected_bstr, unprotected_map (empty), payload_bstr, signature_bstr]
  return cborArray([cborBytes(protectedHdr), cborMap([]), cborBytes(payload), cborBytes(signature)]);
}

/**
 * Persist a {@link TestCertChain} to `dir` so a later process can rehydrate it via
 * {@link loadCertChainFromDir}.
 *
 * Layout:
 *   dir/root.{pem,key,der}
 *   dir/leaf.{pem,key,der}
 *   dir/cabundle/NN.{pem,key,der}   (only when cabundleCount > 0)
 *   dir/root_args.json
 */
export function writeCertChainToDir(dir: string, chain: TestCertChain): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'root.pem'), chain.rootPem);
  writeFileSync(join(dir, 'root.key'), chain.rootKey, { mode: 0o600 });
  writeFileSync(join(dir, 'root.der'), chain.rootDer);
  writeFileSync(join(dir, 'leaf.pem'), chain.leafPem);
  writeFileSync(join(dir, 'leaf.key'), chain.leafKey, { mode: 0o600 });
  writeFileSync(join(dir, 'leaf.der'), chain.leafDer);
  if (chain.cabundlePems.length > 0) {
    const cabundleDir = join(dir, 'cabundle');
    mkdirSync(cabundleDir, { recursive: true });
    for (let i = 0; i < chain.cabundlePems.length; i++) {
      const idx = String(i).padStart(2, '0');
      writeFileSync(join(cabundleDir, `${idx}.pem`), chain.cabundlePems[i]);
      writeFileSync(join(cabundleDir, `${idx}.key`), chain.cabundleKeys[i], { mode: 0o600 });
      writeFileSync(join(cabundleDir, `${idx}.der`), chain.cabundleDers[i]);
    }
  }
  writeFileSync(join(dir, 'root_args.json'), JSON.stringify(rootArgsToJson(chain.rootArgs), null, 2) + '\n');
}

/**
 * Inverse of {@link writeCertChainToDir}. Throws a clear error if the directory is missing, so
 * the local enclave fails fast at startup rather than later during signing.
 */
export function loadCertChainFromDir(dir: string): TestCertChain {
  if (!existsSync(dir)) {
    throw new Error(
      `local TEE cert chain not found at ${dir} — write one with writeCertChainToDir, ` +
        `or point OXIDE_TEE_LOCAL_CERTS_DIR at an existing chain.`,
    );
  }
  const rootPem = readFileSync(join(dir, 'root.pem'));
  const rootKey = readFileSync(join(dir, 'root.key'));
  const rootDer = readFileSync(join(dir, 'root.der'));
  const leafPem = readFileSync(join(dir, 'leaf.pem'));
  const leafKey = readFileSync(join(dir, 'leaf.key'));
  const leafDer = readFileSync(join(dir, 'leaf.der'));

  const cabundlePems: Buffer[] = [];
  const cabundleKeys: Buffer[] = [];
  const cabundleDers: Buffer[] = [];
  const cabundleDir = join(dir, 'cabundle');
  if (existsSync(cabundleDir)) {
    const pemEntries = readdirSync(cabundleDir)
      .filter(name => name.endsWith('.pem'))
      .sort();
    for (const pemName of pemEntries) {
      const idx = pemName.replace(/\.pem$/, '');
      cabundlePems.push(readFileSync(join(cabundleDir, `${idx}.pem`)));
      cabundleKeys.push(readFileSync(join(cabundleDir, `${idx}.key`)));
      cabundleDers.push(readFileSync(join(cabundleDir, `${idx}.der`)));
    }
  }

  const rootArgsJson = JSON.parse(readFileSync(join(dir, 'root_args.json'), 'utf8')) as {
    certHash: string;
    notAfter: number;
    maxPathLen: number;
    subjectHash: string;
    pubKey: string;
  };
  const rootArgs: RootArgs = {
    certHash: Buffer32.fromString(rootArgsJson.certHash),
    notAfter: rootArgsJson.notAfter,
    maxPathLen: rootArgsJson.maxPathLen,
    subjectHash: Buffer32.fromString(rootArgsJson.subjectHash),
    pubKey: Buffer.from(rootArgsJson.pubKey.replace(/^0x/, ''), 'hex'),
  };

  return { rootPem, rootKey, rootDer, leafPem, leafKey, leafDer, cabundlePems, cabundleKeys, cabundleDers, rootArgs };
}

/**
 * Produce a fake-Nitro attestation in memory. Defaults give a fresh random TEE — pin specific
 * fields (e.g. for "same TEE, foreign root" tests) via `opts`.
 *
 * Thin wrapper over {@link generateTestCertChain} + {@link signCoseAttestation} for callers that
 * want both in one shot — fixture generation, e2e portal factories. Callers that re-use a
 * persistent chain (the local enclave) should call those two directly.
 */
export function generateTestAttestation(opts: TestAttestationOptions = {}): TestAttestationFixture {
  if (Boolean(opts.pubKeyX) !== Boolean(opts.pubKeyY)) {
    throw new Error('pubKeyX and pubKeyY must be supplied together');
  }

  let publicKeyX: Buffer32;
  let publicKeyY: Buffer32;
  if (opts.pubKeyX && opts.pubKeyY) {
    publicKeyX = opts.pubKeyX;
    publicKeyY = opts.pubKeyY;
  } else {
    const fresh = freshSecpPubKey();
    publicKeyX = fresh.x;
    publicKeyY = fresh.y;
  }
  const encPubKeyX = opts.encPubKeyX ?? Buffer32.random();
  const encPubKeyY = opts.encPubKeyY ?? Buffer32.random();
  const ethAddress = ethAddressFromSecpPubKey(publicKeyX, publicKeyY);
  const pcr0 = opts.pcr0 ?? LOCAL_DEV_PCR0;
  // Default sits 2s ahead of wall-clock to dodge a subsecond race against openssl's `notBefore`,
  // which rounds up to the next whole second. Without this margin the embedded COSE timestamp can
  // land before the leaf cert is valid and `assertCertificateTime` rejects it. Callers driving a
  // warped L1 chain pass an explicit `timestampMillis` and override this.
  const timestampMillis = opts.timestampMillis ?? Date.now() + 2_000;

  const chain = opts.chain ?? generateTestCertChain({ cabundleCount: opts.cabundleCount });

  const userData = computeAttestationUserData({
    publicKeyX,
    publicKeyY,
    encPubKeyX,
    encPubKeyY,
  });

  const attestationCose = signCoseAttestation(chain, {
    pcr0,
    userData,
    timestampMillis,
    moduleId: 'see attestation.cose',
  });

  const summary: Summary = {
    timestampMillis,
    moduleId: 'see attestation.cose',
    pcr0,
    teePubKeyX: publicKeyX,
    teePubKeyY: publicKeyY,
    teeEthAddress: ethAddress,
    encPubKeyX,
    encPubKeyY,
    userData: Buffer32.fromBuffer(userData),
    rootCertNotAfter: chain.rootArgs.notAfter,
    rootCertHash: chain.rootArgs.certHash,
    cabundleCount: chain.cabundleDers.length,
  };

  return {
    attestationCose,
    rootDer: chain.rootDer,
    leafDer: chain.leafDer,
    cabundleDers: chain.cabundleDers,
    rootArgs: chain.rootArgs,
    summary,
    chain,
  };
}

/**
 * Persist a `TestAttestationFixture` to disk in the layout the Solidity tests + the in-package
 * `src/fixtures/generated/` expect. Aztec-typed fields are flattened to their canonical hex /
 * decimal forms here so the in-memory shape can stay typed while consumers of the JSON
 * (Solidity, jest fixtures) keep parsing the same string format. Trailing newlines on the JSON
 * files keep `prettier` from marking them dirty.
 */
export interface WriteTestAttestationOptions {
  /** Extra CLI flags to echo into the README's regenerate command, in display order. */
  extraFlags?: { name: string; value: string }[];
  /** Working directory the regenerate command should be run from, displayed in the README.
   *  Defaults to `process.cwd()` — the CLI passes this so the README mirrors the actual
   *  invocation. */
  cwd?: string;
  /** Literal `--out` argument to display in the README's regenerate command. Defaults to `out`
   *  itself; the CLI passes the user's exact typed string so things like `./src/fixtures/generated`
   *  appear verbatim instead of being normalised. */
  outArg?: string;
}

export function writeTestAttestation(
  out: string,
  fixture: TestAttestationFixture,
  opts: WriteTestAttestationOptions = {},
): void {
  mkdirSync(out, { recursive: true });
  mkdirSync(join(out, 'cabundle'), { recursive: true });
  writeFileSync(join(out, 'attestation.cose'), fixture.attestationCose);
  writeFileSync(join(out, 'root.der'), fixture.rootDer);
  writeFileSync(join(out, 'leaf.der'), fixture.leafDer);
  for (let i = 0; i < fixture.cabundleDers.length; i++) {
    writeFileSync(join(out, 'cabundle', `${String(i).padStart(2, '0')}.der`), fixture.cabundleDers[i]);
  }
  writeFileSync(join(out, 'root_args.json'), JSON.stringify(rootArgsToJson(fixture.rootArgs), null, 2) + '\n');
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summaryToJson(fixture.summary), null, 2) + '\n');
  writeFileSync(
    join(out, 'README.md'),
    buildReadme(fixture, {
      extraFlags: opts.extraFlags ?? [],
      cwd: opts.cwd ?? process.cwd(),
      outArg: opts.outArg ?? out,
    }),
  );
}

/** Render the human-readable README that ships alongside the generated fixture. The regenerate
 *  command faithfully echoes the cwd, `--out` argument, and any extra flags the caller supplied,
 *  so it's copy-pasteable regardless of where the script was invoked from. */
function buildReadme(
  fixture: TestAttestationFixture,
  ctx: { extraFlags: { name: string; value: string }[]; cwd: string; outArg: string },
): string {
  const cabundleCount = fixture.summary.cabundleCount;
  // Match the visual column widths of the rest of the Files table (col1 18 / col2 74).
  const cabundleRows = Array.from({ length: cabundleCount }, (_, i) => {
    const idx = String(i).padStart(2, '0');
    const desc =
      i === 0
        ? 'Intermediate CA, signed by root'
        : `Intermediate CA, signed by \`cabundle/${String(i - 1).padStart(2, '0')}.der\``;
    const col1 = `\`cabundle/${idx}.der\``.padEnd(18, ' ');
    const col2 = desc.padEnd(74, ' ');
    return `| ${col1}  | ${col2}|`;
  }).join('\n');
  const cabundleTable = cabundleCount > 0 ? cabundleRows + '\n' : '';

  // Script path relative to the cwd the user actually invoked node from. The script lives at
  // `<repo>/yarn-project/tee-attestation/dest/fixtures/gen_test_attestation.js`, so 5 `..` from
  // the script file gives the repo root — which we use to display the cwd in a stable form.
  const scriptPath = fileURLToPath(import.meta.url);
  const repoRoot = resolve(scriptPath, '..', '..', '..', '..', '..');
  const cwdAbs = resolve(ctx.cwd);
  const cwdRel = relative(repoRoot, cwdAbs);
  // If cwd is inside the repo, show the repo-relative path (or `.` for the repo root itself);
  // otherwise fall back to the absolute path.
  const cwdLabel = cwdRel === '' ? '.' : cwdRel.startsWith('..') ? cwdAbs : cwdRel;
  const relScript = relative(cwdAbs, scriptPath);

  // `--cabundleCount` is always emitted (it's how the table rows are sized). Any other flag the
  // user supplied is echoed back verbatim, in CLI order.
  const flagLines = [
    `  --cabundleCount ${cabundleCount} \\`,
    ...ctx.extraFlags.map(({ name, value }) => `  --${name} ${value} \\`),
    `  --out ${ctx.outArg}`,
  ].join('\n');

  return `# Auto-generated test attestation fixture

**Everything in this directory is generated by
\`yarn-project/tee-attestation/dest/fixtures/gen_test_attestation.js\`.** Do not edit any of the files
by hand — re-run the script if you need a fresh fixture.

## How to regenerate

After \`yarn-project/bootstrap.sh build\` (so the script is compiled to
\`dest/fixtures/gen_test_attestation.js\`), from \`${cwdLabel}\`:

\`\`\`sh
rm -rf ${ctx.outArg}
node ${relScript} \\
${flagLines}
\`\`\`

\`--cabundleCount ${cabundleCount}\` mints ${cabundleCount} intermediate CA${cabundleCount === 1 ? '' : 's'} between the test root and the leaf so the test
exercises the \`verifyTeeCACert\` staging path. Keep in sync with whatever the test loops over
(\`cabundleCount\` is recorded in \`summary.json\` and read back by the test).

The signing pubkey (\`teePubKeyX/Y\`), P-256 encryption key (\`encPubKeyX/Y\`), and PCR0 default to
fresh values on each run; pass \`--pubKeyX\`/\`--pubKeyY\`/\`--encPubKeyX\`/\`--encPubKeyY\`/\`--pcr0\` to
pin them. The L1 eth address (\`teeEthAddress\`) is always derived from the signing pubkey via
keccak.

The generated \`user_data\` only commits to \`(domain, pubKeyX, pubKeyY, encPubKeyX, encPubKeyY)\` —
portal-context fields (portal, chainId, l2Portal, rollupVersion) are intentionally NOT bound, because the
enclave bakes them into its image and PCR0 already commits to them. As a result the test deploys
the portal with arbitrary portal wiring; only the PCR0 hash + signing keys need to match the
fixture.

Requires \`openssl\` on \`PATH\`.

## Files

| File                | What it is                                                                |
| ------------------- | ------------------------------------------------------------------------- |
| \`attestation.cose\`  | Self-issued COSE_Sign1 document, CBOR-encoded — the input to \`registerTee\`|
| \`root.der\`          | Test root CA cert (P-384, self-signed). Pre-saved by \`TestCertManager\`    |
${cabundleTable}| \`leaf.der\`          | Leaf cert that signed the COSE_Sign1, signed by the last intermediate     |
| \`root_args.json\`    | \`TestCertManager\` constructor args (root cert hash / notAfter / pubkey)   |
| \`summary.json\`      | Signing keys, PCR0, timestamp, user_data, root cert hash, cabundle count  |
`;
}

/** Flatten the Aztec-typed `RootArgs` into the on-disk JSON shape. */
function rootArgsToJson(args: RootArgs): Record<string, unknown> {
  return {
    certHash: args.certHash.toString(),
    notAfter: args.notAfter,
    maxPathLen: args.maxPathLen,
    subjectHash: args.subjectHash.toString(),
    pubKey: '0x' + args.pubKey.toString('hex'),
  };
}

/** Flatten the Aztec-typed `Summary` into the on-disk JSON shape. `timestampMillis` is emitted
 *  as a decimal string for compatibility with existing Solidity fixture consumers that read it
 *  via `vm.parseUint(summary.readString(...))`. */
function summaryToJson(s: Summary): Record<string, unknown> {
  return {
    timestampMillis: s.timestampMillis.toString(),
    moduleId: s.moduleId,
    pcr0: '0x' + s.pcr0.toString('hex'),
    teePubKeyX: s.teePubKeyX.toString(),
    teePubKeyY: s.teePubKeyY.toString(),
    teeEthAddress: s.teeEthAddress.toString(),
    encPubKeyX: s.encPubKeyX.toString(),
    encPubKeyY: s.encPubKeyY.toString(),
    userData: s.userData.toString(),
    rootCertNotAfter: s.rootCertNotAfter,
    rootCertHash: s.rootCertHash.toString(),
    cabundleCount: s.cabundleCount,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// CLI entry — only runs when this file is invoked directly (`node dest/.../this.js`).
// Importing the module returns the public API without auto-executing.
// ──────────────────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

function main(): void {
  const args = parseArgs(argv.slice(2));
  const opts: TestAttestationOptions = {
    cabundleCount: args.cabundleCount ? parseInt(args.cabundleCount, 10) : undefined,
    pubKeyX: args.pubKeyX ? Buffer32.fromBuffer(parseHex(args.pubKeyX, 32, '--pubKeyX')) : undefined,
    pubKeyY: args.pubKeyY ? Buffer32.fromBuffer(parseHex(args.pubKeyY, 32, '--pubKeyY')) : undefined,
    encPubKeyX: args.encPubKeyX ? new Buffer32(parseHex(args.encPubKeyX, 32, '--encPubKeyX')) : undefined,
    encPubKeyY: args.encPubKeyY ? new Buffer32(parseHex(args.encPubKeyY, 32, '--encPubKeyY')) : undefined,
    pcr0: args.pcr0 ? parseHex(args.pcr0, 48, '--pcr0') : undefined,
  };

  const fixture = generateTestAttestation(opts);

  if (args.out) {
    // Echo every flag the user actually typed (other than `--cabundleCount` and `--out`, which
    // the README handles itself) into the README's regenerate command. cwd + the literal --out
    // string are passed through so the README mirrors the actual invocation verbatim.
    const extraFlags = Object.entries(args)
      .filter(([k]) => k !== 'out' && k !== 'cabundleCount')
      .map(([name, value]) => ({ name, value }));
    writeTestAttestation(args.out, fixture, { extraFlags, cwd: process.cwd(), outArg: args.out });
    console.log(`Wrote ${args.out}/attestation.cose (${fixture.attestationCose.length} bytes)`);
    console.log(`user_data:        ${fixture.summary.userData.toString()}`);
    console.log(`tee eth addr:     ${fixture.summary.teeEthAddress.toString()}`);
    console.log(`root cert hash:   ${fixture.summary.rootCertHash.toString()}`);
    console.log(
      `root notAfter:    ${fixture.summary.rootCertNotAfter}` +
        ` (${new Date(fixture.summary.rootCertNotAfter * 1000).toISOString()})`,
    );
  } else {
    // No --out: print summary.json (in its on-disk JSON shape) so the user still sees what was
    // generated. `JSON.stringify` against the in-memory typed `Summary` would produce nonsense
    // for the Aztec wrappers, so route through `writeTestAttestation`'s flattener.
    console.log(JSON.stringify(summaryToJson(fixture.summary), null, 2));
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function parseArgs(arr: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (!a.startsWith('--')) {
      bail(`unexpected positional arg: ${a}`);
    }
    const key = a.slice(2);
    const val = arr[i + 1];
    if (val === undefined || val.startsWith('--')) {
      bail(`missing value for ${a}`);
    }
    o[key] = val;
    i++;
  }
  return o;
}

function bail(msg: string): never {
  console.error('error:', msg);
  exit(1);
}

function parseHex(s: string, lenBytes: number, label: string): Buffer {
  const stripped = s.startsWith('0x') ? s.slice(2) : s;
  if (stripped.length !== lenBytes * 2) {
    bail(`${label} must be ${lenBytes} bytes (got ${stripped.length / 2})`);
  }
  return Buffer.from(stripped, 'hex');
}

function runOpenssl(args: string[]): Buffer {
  return execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function pemToDer(pemPath: string): Buffer {
  return runOpenssl(['x509', '-in', pemPath, '-outform', 'DER']);
}

/**
 * Returns true when the outer ECDSA signature on `certDer` has both R and S
 * encoded such that `Asn1Decode.uint384At` (in the nitro-validator lib used by
 * `CertManager._verifyCertSignature`) decodes them correctly — i.e. after the
 * decoder strips an optional leading 0x00 (high-bit padding), the remaining
 * INTEGER body is exactly 48 bytes.
 *
 * `uint384At` is hard-coded for P-384's 48-byte scalars: it reads the first 16
 * bytes of the value into the high uint128 and the rest into the low uint256.
 * When the natural INTEGER body is <48 bytes (~1/256 of random ECDSA outputs
 * per scalar — when the high bit of the scalar is in a leading zero byte), the
 * positional read shifts the bytes by one and the decoded scalar is wrong,
 * which surfaces as `"invalid sig"` from `_verifySignature` in CertManager.
 *
 * The upstream cabundle from real Nitro Enclave certs always lands on 48-byte
 * scalars in production, so the bug never bites there; openssl-signed test
 * fixtures with a fresh random `k` per cert hit it ~1.5% of the time per
 * chain. Generators that need every cert sig to pass on-chain must retry
 * until this predicate holds.
 */
function isCertSigCanonical(certDer: Buffer): boolean {
  // Certificate SEQUENCE → { tbsCertificate, signatureAlgorithm, signatureValue }
  const cert = parseTLV(certDer, 0);
  if (cert.tag !== 0x30) {
    return false;
  }
  const tbs = parseTLV(certDer, cert.contentOff);
  const sigAlgo = parseTLV(certDer, cert.contentOff + tbs.totalLen);
  const sigBitString = parseTLV(certDer, cert.contentOff + tbs.totalLen + sigAlgo.totalLen);
  if (sigBitString.tag !== 0x03) {
    return false;
  }
  // BIT STRING content = 1 byte "unused bits" (always 0 for cert sigs) + DER payload.
  const sigSeq = parseTLV(certDer, sigBitString.contentOff + 1);
  if (sigSeq.tag !== 0x30) {
    return false;
  }
  const r = parseTLV(certDer, sigSeq.contentOff);
  const s = parseTLV(certDer, sigSeq.contentOff + r.totalLen);
  if (r.tag !== 0x02 || s.tag !== 0x02) {
    return false;
  }
  // After the uint384At rule: if the leading byte is 0x00, it's sign-bit
  // padding and gets stripped; the remaining body must be 48 bytes. Length
  // 49 with a leading 0x00 → 48 after strip. Length 48 with high bit clear
  // → 48. Anything else fails to round-trip through uint384At.
  const rEffectiveLen = certDer[r.contentOff] === 0x00 ? r.len - 1 : r.len;
  const sEffectiveLen = certDer[s.contentOff] === 0x00 ? s.len - 1 : s.len;
  return rEffectiveLen === 48 && sEffectiveLen === 48;
}

/**
 * Runs `openssl x509 -req …` with `args` and retries the whole signing step
 * until the resulting cert's outer ECDSA signature serializes to 48-byte R/S
 * (see {@link isCertSigCanonical}). ECDSA sign uses a fresh random k each
 * call, so retries are independent — empirically converges within a handful
 * of attempts.
 */
function runOpensslSignCertWithCanonicalRS(args: string[], outPath: string): void {
  const MAX_ATTEMPTS = 32; // 1 - (255/256)^32 ≈ 88% per scalar; both scalars 48-byte ≈ 99.5% within 32.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    runOpenssl(args);
    const der = pemToDer(outPath);
    if (isCertSigCanonical(der)) {
      return;
    }
  }
  throw new Error(
    `openssl x509 -req emitted a non-48-byte R/S on every one of ${MAX_ATTEMPTS} attempts — extraordinarily unlikely; rerun the test.`,
  );
}

function sha384(buf: Buffer): Buffer {
  return createHash('sha384').update(buf).digest();
}

/** Mint a fresh secp256k1 keypair via openssl and return the pubkey as 32-byte (X, Y). */
function freshSecpPubKey(): { x: Buffer32; y: Buffer32 } {
  const work = mkdtempSync(join(tmpdir(), 'oxide-tee-'));
  try {
    runOpenssl(['ecparam', '-name', 'secp256k1', '-genkey', '-noout', '-out', `${work}/tee.pem`]);
    const ethPub = pemPubXYFromPriv(`${work}/tee.pem`);
    return { x: Buffer32.fromBuffer(ethPub.x), y: Buffer32.fromBuffer(ethPub.y) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Derive an L1 eth address from a secp256k1 pubkey. Mirrors `OxidePortal.sol::registerTee`'s
 *  on-chain derivation. */
function ethAddressFromSecpPubKey(x: Buffer32, y: Buffer32): EthAddress {
  return new EthAddress(ethAddressFromPubXY(x.toBuffer(), y.toBuffer()));
}

// ──────────────────────────────────────────────────────────────────────────────
// CBOR encoding — `cborText` / `cborBytes` / `cborArray` / `cborUint(major, n)` come from
// `../nitro_attestation/parsers.js`. The encoders below cover the subset COSE_Sign1 needs that
// the parsers module doesn't currently export (negative ints, maps, null).
// ──────────────────────────────────────────────────────────────────────────────

function cborInt(n: number): Buffer {
  return n >= 0 ? cborUint(0, n) : cborNeg(n);
}

function cborNeg(n: number): Buffer {
  return cborUint(1, -1 - n);
}

function cborMap(entries: Buffer[][]): Buffer {
  return Buffer.concat([cborUint(5, entries.length), ...entries.flat()]);
}

function cborNull(): Buffer {
  return Buffer.from([0xf6]);
}

function encodePayload({
  moduleId,
  timestampMillis,
  pcrs,
  certificate,
  cabundle,
  userData,
}: {
  moduleId: string;
  timestampMillis: number;
  pcrs: Record<number, Buffer>;
  certificate: Buffer;
  cabundle: Buffer[];
  userData: Buffer;
}): Buffer {
  const pcrEntries: Buffer[][] = [];
  for (let i = 0; i < 16; i++) {
    pcrEntries.push([cborUint(0, i), cborBytes(pcrs[i])]);
  }
  return cborMap([
    [cborText('module_id'), cborText(moduleId)],
    [cborText('digest'), cborText('SHA384')],
    [cborText('timestamp'), cborUint(0, timestampMillis)],
    [cborText('pcrs'), cborMap(pcrEntries)],
    [cborText('certificate'), cborBytes(certificate)],
    [cborText('cabundle'), cborArray(cabundle.map(c => cborBytes(c)))],
    [cborText('public_key'), cborNull()],
    [cborText('user_data'), cborBytes(userData)],
    [cborText('nonce'), cborNull()],
  ]);
}

// ──────────────────────────────────────────────────────────────────────────────
// secp256k1 helper: extract X || Y from a `EC PRIVATE KEY` PEM file.
// ──────────────────────────────────────────────────────────────────────────────

function pemPubXYFromPriv(pemPath: string): { x: Buffer; y: Buffer } {
  // openssl ec -in priv.pem -pubout -outform DER  -> SubjectPublicKeyInfo
  // Inside SPKI: SEQUENCE { algo, BIT STRING { 00 04 X Y } }
  const spkiDer = runOpenssl(['ec', '-in', pemPath, '-pubout', '-outform', 'DER']);
  const spki = parseTLV(spkiDer, 0);
  // children: SEQUENCE algorithm, BIT STRING subjectPublicKey
  const algo = parseTLV(spkiDer, spki.contentOff);
  const bs = parseTLV(spkiDer, spki.contentOff + algo.totalLen);
  const end = bs.contentOff + bs.len;
  // For secp256k1 / P-256 the curve produces 32-byte coords (64 bytes total).
  return { x: spkiDer.slice(end - 64, end - 32), y: spkiDer.slice(end - 32, end) };
}

function ethAddressFromPubXY(x: Buffer, y: Buffer): Buffer {
  return keccak256(Buffer.concat([x, y])).slice(12);
}

// ──────────────────────────────────────────────────────────────────────────────
// Sign Sig_structure1 with the leaf P-384 key, return raw (r || s) 96 bytes.
// ──────────────────────────────────────────────────────────────────────────────

function signES384(keyPem: Buffer, msg: Buffer): Buffer {
  const sign = createSign('SHA384');
  sign.update(msg);
  sign.end();
  const der = sign.sign({ key: keyPem, dsaEncoding: 'der' });
  // SEQUENCE { r INTEGER, s INTEGER }
  const seq = parseTLV(der, 0);
  const r = parseTLV(der, seq.contentOff);
  const s = parseTLV(der, seq.contentOff + r.totalLen);
  return Buffer.concat([
    padInt(der.slice(r.contentOff, r.contentOff + r.len), 48),
    padInt(der.slice(s.contentOff, s.contentOff + s.len), 48),
  ]);
}

function padInt(buf: Buffer, len: number): Buffer {
  if (buf.length === len) {
    return buf;
  }
  // Strip leading 0 (sign-bit padding from DER INTEGER).
  if (buf.length > len && buf[0] === 0) {
    return buf.slice(buf.length - len);
  }
  if (buf.length < len) {
    return Buffer.concat([Buffer.alloc(len - buf.length), buf]);
  }
  throw new Error(`unexpected integer length ${buf.length} (want ${len})`);
}

// ──────────────────────────────────────────────────────────────────────────────
// ASN.1 / X.509 parsing — enough to extract subject content + notAfter + pubkey
// from a freshly-generated root cert.
// ──────────────────────────────────────────────────────────────────────────────

interface TLV {
  tag: number;
  len: number;
  headerLen: number;
  totalLen: number;
  contentOff: number;
}

function parseTLV(buf: Buffer, off: number): TLV {
  const tag = buf[off];
  const lenByte = buf[off + 1];
  let len: number;
  let lenLen: number;
  if (lenByte < 0x80) {
    len = lenByte;
    lenLen = 1;
  } else {
    const n = lenByte & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) {
      len = (len << 8) | buf[off + 2 + i];
    }
    lenLen = 1 + n;
  }
  const headerLen = 1 + lenLen;
  return { tag, len, headerLen, totalLen: headerLen + len, contentOff: off + headerLen };
}

function parseTestRoot(rootDer: Buffer): { notAfter: number; subjectContent: Buffer; pubKey: Buffer } {
  // outer Certificate SEQUENCE
  const cert = parseTLV(rootDer, 0);
  // tbsCertificate SEQUENCE
  const tbs = parseTLV(rootDer, cert.contentOff);
  let off = tbs.contentOff;
  // [0] EXPLICIT version
  if (rootDer[off] === 0xa0) {
    off += parseTLV(rootDer, off).totalLen;
  }
  off += parseTLV(rootDer, off).totalLen; // serial
  off += parseTLV(rootDer, off).totalLen; // sigAlgo
  off += parseTLV(rootDer, off).totalLen; // issuer
  // validity SEQUENCE
  const validity = parseTLV(rootDer, off);
  let voff = validity.contentOff;
  voff += parseTLV(rootDer, voff).totalLen; // notBefore
  const naTlv = parseTLV(rootDer, voff);
  const notAfter = parseAsn1Time(
    rootDer.slice(naTlv.contentOff, naTlv.contentOff + naTlv.len).toString('ascii'),
    naTlv.tag,
  );
  off = validity.contentOff + validity.len;
  // subject SEQUENCE
  const subj = parseTLV(rootDer, off);
  const subjectContent = rootDer.slice(subj.contentOff, subj.contentOff + subj.len);
  off = subj.contentOff + subj.len;
  // subjectPublicKeyInfo SEQUENCE -> {AlgorithmIdentifier, BIT STRING}
  const spki = parseTLV(rootDer, off);
  const algo = parseTLV(rootDer, spki.contentOff);
  const bs = parseTLV(rootDer, spki.contentOff + algo.totalLen);
  // BIT STRING content: 1 byte unused-bits, then 0x04 || X(48) || Y(48). Last 96 bytes = X||Y.
  const bsEnd = bs.contentOff + bs.len;
  const pubKey = rootDer.slice(bsEnd - 96, bsEnd);
  return { notAfter, subjectContent, pubKey };
}

function parseAsn1Time(s: string, tag: number): number {
  if (tag === 0x17) {
    const yy = parseInt(s.slice(0, 2), 10);
    const year = yy >= 50 ? 1900 + yy : 2000 + yy;
    return (
      Date.UTC(
        year,
        parseInt(s.slice(2, 4)) - 1,
        parseInt(s.slice(4, 6)),
        parseInt(s.slice(6, 8)),
        parseInt(s.slice(8, 10)),
        parseInt(s.slice(10, 12)),
      ) / 1000
    );
  }
  if (tag === 0x18) {
    return (
      Date.UTC(
        parseInt(s.slice(0, 4)),
        parseInt(s.slice(4, 6)) - 1,
        parseInt(s.slice(6, 8)),
        parseInt(s.slice(8, 10)),
        parseInt(s.slice(10, 12)),
        parseInt(s.slice(12, 14)),
      ) / 1000
    );
  }
  throw new Error(`unsupported ASN.1 time tag 0x${tag.toString(16)}`);
}
