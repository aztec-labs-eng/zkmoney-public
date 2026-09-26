#!/usr/bin/env node
// Build glue for vendored `@oxide/*` packages. Workspace packages import these
// via `"./*": "./dest/*"` exports maps, so each package's dest/ must exist
// before tsc / vitest run.
//
// The vendored yarn-project packages have a yarn `packageManager`
// declaration that prevents `pnpm --filter` from running their build scripts.
// We compile each directly with the locally-hoisted tsc instead.
//
// Builds the full subset needed by oxide-client::submit():
//   1. `yarn install` inside vendor/oxide/l1-contracts (pulls @aztec/l1-artifacts
//      whose sources @oxide/l1-contracts and OxidePortal.sol consume via remappings).
//   2. `forge build` inside vendor/oxide/l1-contracts/lib/nitro-validator/
//      (produces CertManager.json + NitroValidator.json that gen_abis.mjs reads).
//   3. `forge build` inside vendor/oxide/l1-contracts/ (OxidePortal artifacts).
//   4. `node gen_abis.mjs` inside vendor/oxide/yarn-project/l1-contracts/
//      (emits src/abis/*.ts from the Foundry JSON).
//   5. Stub the three refund-circuit artifacts under
//      `vendor/oxide/noir-projects/{frozen_notes_refund,frozen_deposit_refund,unprocessed_deposit_refund}/target/`
//      — needed only because oxide-client's index re-exports modules that
//      JSON-import these. The frozen-archive refund path isn't exercised here;
//      runtime values are unused.
//   6. tsc-build each yarn-project/ package in topological order.
//
// Steps 1-5 are gated by sentinel files so subsequent runs short-circuit;
// the script is idempotent and a full from-cold run is ~60-120s.

import { execFileSync } from "node:child_process"
import {
  existsSync,
  statSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "..")
const VENDOR_ROOT = resolve(REPO_ROOT, "vendor/oxide")
const YARN_PROJECT = resolve(VENDOR_ROOT, "yarn-project")
const L1_CONTRACTS = resolve(VENDOR_ROOT, "l1-contracts")
const NITRO = resolve(L1_CONTRACTS, "lib/nitro-validator")

// The ABI .ts files gen_abis.mjs writes — derived from its own TARGETS map so
// the sentinel never under-covers when oxide adds a contract. gen_abis.mjs
// emits one `<sym>.ts` per TARGETS key; its generation loop runs at module
// load, so we parse the keys from its source instead of importing it. The
// completeness check matters because gen_abis.mjs writes one file at a time:
// a partial run (crashed on a missing forge artifact) must not let a later run
// skip ABI generation entirely.
const GEN_ABIS = resolve(YARN_PROJECT, "l1-contracts/scripts/gen_abis.mjs")
const ABI_TARGETS = (() => {
  const src = readFileSync(GEN_ABIS, "utf8")
  const start = src.indexOf("const TARGETS = {")
  const block = src.slice(start, src.indexOf("\n};", start))
  const targets = [...block.matchAll(/(\w+):\s*\{/g)].map((m) => `${m[1]}.ts`)
  if (targets.length === 0) {
    console.error(`ERROR: could not derive ABI targets from ${GEN_ABIS}`)
    process.exit(1)
  }
  return targets
})()
const ABI_DIR = resolve(YARN_PROJECT, "l1-contracts/src/abis")

// Sentinel files that mark each upstream-build step as done.
const SENTINELS = {
  yarnInstall: resolve(L1_CONTRACTS, "node_modules/.yarn-state.yml"),
  nitroForge: resolve(NITRO, "out/CertManager.sol/CertManager.json"),
  l1Forge: resolve(L1_CONTRACTS, "out/OxidePortal.sol/OxidePortal.json"),
  frozenNotesRefundArtifact: resolve(
    VENDOR_ROOT,
    "noir-projects/frozen_notes_refund/target/frozen_notes_refund.json",
  ),
  frozenDepositRefundArtifact: resolve(
    VENDOR_ROOT,
    "noir-projects/frozen_deposit_refund/target/frozen_deposit_refund.json",
  ),
  unprocessedDepositRefundArtifact: resolve(
    VENDOR_ROOT,
    "noir-projects/unprocessed_deposit_refund/target/unprocessed_deposit_refund.json",
  ),
}

// Topological order: leaves first. oxide-lib has no @oxide/* deps; everything
// else depends on it (attestation verification now lives at oxide-lib/src/attestation/).
// resolver-lib mirrors resolver_circuit/content_hash.nr (SIPA-resolution parity) and depends on oxide-lib.
// tee-enclave hosts LocalTeeSigner (the sandbox in-process signer) and depends on oxide-lib.
// refund-proof bundles the frozen/unprocessed refund circuits oxide-client re-exports.
const PACKAGES = [
  "oxide-lib",
  "resolver-lib",
  "tee-enclave",
  "l1-contracts",
  "refund-proof",
  "oxide-client",
]

function newestMtime(dir) {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name)
    const m = entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs
    if (m > newest) newest = m
  }
  return newest
}

function run(cmd, args, cwd) {
  console.error(`> ${cmd} ${args.join(" ")}   (cwd: ${cwd})`)
  execFileSync(cmd, args, { cwd, stdio: "inherit" })
}

// --- Upstream-build steps (idempotent) -------------------------------------

// The forge/ABI sentinels are existence-based and the tsc step below is mtime-based, so a vendor
// pin bump would otherwise leave stale L1 artifacts (and gen_abis crashing on interfaces the
// stale `out/` lacks). Stamp the submodule SHA; on mismatch, invalidate the forge outputs,
// generated ABIs and every package's `dest/` so they rebuild against the new pin.
// A container build has no repo to ask — `.dockerignore` excludes `.git` — and no
// stale artifacts either, since the stage starts clean. So a missing SHA means
// "nothing to invalidate", not a build failure. `OXIDE_VENDOR_SHA` supplies it
// where git is unavailable but the stamp is still wanted.
const VENDOR_SHA_STAMP = resolve(L1_CONTRACTS, "out/.vendor-sha")
const vendorSha =
  process.env.OXIDE_VENDOR_SHA?.trim() ||
  (() => {
    try {
      return execFileSync("git", ["-C", VENDOR_ROOT, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
    } catch {
      console.error("vendor/oxide is not a git checkout — skipping the pin-bump invalidation")
      return ""
    }
  })()
if (
  vendorSha &&
  (!existsSync(VENDOR_SHA_STAMP) || readFileSync(VENDOR_SHA_STAMP, "utf8").trim() !== vendorSha)
) {
  console.error(`vendor/oxide pin moved (or first build) — clearing forge outputs, ABIs and dest/`)
  rmSync(resolve(L1_CONTRACTS, "out"), { recursive: true, force: true })
  rmSync(resolve(NITRO, "out"), { recursive: true, force: true })
  rmSync(ABI_DIR, { recursive: true, force: true })
  // tsc emits into dest/ without pruning it, so a module the old pin had and the new one dropped
  // survives as an orphan importing symbols the regenerated modules no longer export — and the
  // mtime check below sees a dest/ newer than src/ and skips the package entirely. Neither the
  // failure nor the skip is visible here: it surfaces later as a SyntaxError from a consumer.
  for (const pkg of PACKAGES) {
    rmSync(resolve(YARN_PROJECT, pkg, "dest"), { recursive: true, force: true })
  }
}

if (!existsSync(SENTINELS.yarnInstall)) {
  console.error("vendor/oxide/l1-contracts: yarn install (pulls @aztec/l1-artifacts)")
  run("yarn", ["install"], L1_CONTRACTS)
}

if (!existsSync(SENTINELS.nitroForge)) {
  console.error("vendor/oxide/l1-contracts/lib/nitro-validator: forge build")
  run("forge", ["build"], NITRO)
}

if (!existsSync(SENTINELS.l1Forge)) {
  console.error("vendor/oxide/l1-contracts: forge build")
  run("forge", ["build"], L1_CONTRACTS)
}

const allAbisExist = ABI_TARGETS.every((name) => existsSync(resolve(ABI_DIR, name)))
if (!allAbisExist) {
  console.error("vendor/oxide/yarn-project/l1-contracts: gen_abis.mjs")
  run("node", ["scripts/gen_abis.mjs"], resolve(YARN_PROJECT, "l1-contracts"))
}

// Everything pin-derived is now in place — stamp the pin so the next run
// short-circuits (and a future pin bump invalidates again). With no SHA there is
// nothing to compare against later, so writing a stamp would only be misleading.
if (vendorSha) writeFileSync(VENDOR_SHA_STAMP, `${vendorSha}\n`)

// Stub the three refund-circuit artifacts that @oxide/refund-proof
// JSON-imports (frozen_notes_refund, frozen_deposit_refund,
// unprocessed_deposit_refund). Runtime values are unused here — the
// frozen-archive refund path isn't exercised by the wallet.
for (const stub of [
  SENTINELS.frozenNotesRefundArtifact,
  SENTINELS.frozenDepositRefundArtifact,
  SENTINELS.unprocessedDepositRefundArtifact,
]) {
  if (!existsSync(stub)) {
    console.error(`Stubbing ${stub} (frozen-archive path; unused here)`)
    mkdirSync(dirname(stub), { recursive: true })
    writeFileSync(stub, "{}\n")
  }
}

// --- tsc build per package -------------------------------------------------

// Resolve a tsc binary from any sibling workspace that has typescript hoisted.
// We avoid `pnpm exec tsc` because the vendored yarn-project package.json
// pins `packageManager: yarn@*` which makes pnpm bail.
const tscCandidates = [
  resolve(REPO_ROOT, "node_modules/.bin/tsc"),
  resolve(REPO_ROOT, "packages/core/node_modules/.bin/tsc"),
  resolve(REPO_ROOT, "packages/sdk/node_modules/.bin/tsc"),
]
const tsc = tscCandidates.find((p) => existsSync(p))
if (!tsc) {
  console.error("ERROR: no hoisted tsc binary found; run `pnpm install` first.")
  process.exit(1)
}

// Write a sibling tsconfig.build.json that extends the vendored tsconfig but
// excludes *.test.ts. The vendored packages don't ship @types/jest at the
// pnpm-workspace level (oxide's CI yarn-install does), so test files trip
// "Cannot find name 'describe'". The override is idempotent and lives inside
// the submodule tree (untracked); cleaner than editing the vendored tsconfig.
//
// EXTRA_EXCLUDES drops files that pull in an @oxide package we deliberately
// don't build. oxide-client's broadcaster.ts and sipa_events.ts import the
// generated @oxide/noir-contracts.js bindings, and the barrel index.ts
// re-exports them, so all three drop out. Consumers import oxide-client's
// bindings-free subpaths (broadcaster_calls.js, sipa_event_calls.js,
// swap_on_withdraw.js, …), never the barrel.
//
// tee-enclave's src/testing/ holds worker entrypoints that only its own *.test.ts
// spawn, by URL, for Node to run under native type stripping — so they import with
// explicit .ts extensions, which tsc rejects unless allowImportingTsExtensions is on
// (and that in turn forbids emit). Excluding the whole directory keeps them out of a
// build that emits, and covers any worker oxide adds later.
const EXTRA_EXCLUDES = {
  "oxide-client": ["src/broadcaster.ts", "src/sipa_events.ts", "src/index.ts"],
  "tee-enclave": ["src/testing/**"],
}

function writeBuildConfig(pkgDir, pkg) {
  const overridePath = resolve(pkgDir, "tsconfig.build.json")
  writeFileSync(
    overridePath,
    JSON.stringify(
      {
        extends: "./tsconfig.json",
        exclude: ["**/*.test.ts", ...(EXTRA_EXCLUDES[pkg] ?? [])],
      },
      null,
      2,
    ) + "\n",
  )
  return overridePath
}

for (const pkg of PACKAGES) {
  const dir = resolve(YARN_PROJECT, pkg)
  const dest = resolve(dir, "dest")
  const src = resolve(dir, "src")
  if (existsSync(dest) && newestMtime(src) <= newestMtime(dest)) {
    continue
  }
  console.error(`Building @oxide/${pkg} dest/ ...`)
  const buildConfig = writeBuildConfig(dir, pkg)
  try {
    execFileSync(tsc, ["-p", buildConfig], { stdio: "inherit" })
  } catch (err) {
    // tsc emits what it could before failing, which leaves dest/ newer than src/ — the
    // staleness check above would then treat the half-built package as current and skip it,
    // so a second run reports success over a broken build. Drop the partial output.
    rmSync(dest, { recursive: true, force: true })
    throw err
  }
}
