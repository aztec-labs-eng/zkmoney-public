#!/usr/bin/env node
// The v5 bundle compiles no Noir. The v5 wallet's own artifacts are pinned in pinned/, built once
// from the pinned wallet commit with the Aztec v5 toolchain. Oxide's v5 token, broadcaster and
// refund circuits come from Oxide's pin (noir-projects/pinned-noir-artifacts.tar.gz) at
// source.json's oxidePin commit. Each pinned file stores its source paths under the bundle's fixed
// roots, so the bundle is the same as one built from source.
//
// Usage:
//   GENERATION_V5_SOURCE=<checkout> pins.mjs pin   # re-pin from a from-source build of the commit
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const WALLET_ARCHIVE = path.join(pkg, "pinned/v5-wallet-artifacts.tar.gz")
export const WALLET_MANIFEST = path.join(pkg, "pinned/v5-wallet-artifacts.json")
const { walletCommit, oxidePin } = JSON.parse(readFileSync(path.join(pkg, "source.json"), "utf8"))

// The Oxide contracts the v5 wallet bundles and the refund circuits it proves with.
const OXIDE_CONTRACTS = ["oxide_token_contract", "broadcaster_contract"]
const OXIDE_CIRCUITS = [
  "frozen_notes_refund",
  "frozen_deposit_refund",
  "unprocessed_deposit_refund",
]

/** The roots the bundle names source paths from, so its digests do not depend on the checkout. */
export const pathRoots = (source) => [
  [`${source}/`, "v5-wallet/"],
  [`${path.join(homedir(), "nargo")}/`, "nargo/"],
]
export const fixPaths = (source, text) =>
  pathRoots(source).reduce((out, [from, to]) => out.replaceAll(from, to), text)
// Oxide's pin holds paths relative to the Oxide checkout, which the v5 wallet vendors here.
const fromOxide = (text) =>
  text.replaceAll('"noir-projects/', '"v5-wallet/vendor/oxide/noir-projects/')

const sha256 = (data) => createHash("sha256").update(data).digest("hex")
const targetOf = (source) => path.join(source, "packages/contracts/src/artifacts/target")

const headOf = (source) =>
  execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()

const readMember = (archive, member) =>
  execFileSync("tar", ["-xzOf", archive, `./${member}`], { maxBuffer: 1 << 30 })

const oxideFile = (source, file) =>
  execFileSync(
    "git",
    ["-C", path.join(source, "vendor/oxide"), "show", `${oxidePin.commit}:noir-projects/${file}`],
    { maxBuffer: 1 << 30 },
  )

// Calls fn with a reader of Oxide's v5 pin that checks each file against Oxide's manifest.
function withOxidePin(source, fn) {
  const vendor = path.join(source, "vendor/oxide")
  execFileSync("git", ["-C", vendor, "fetch", "--quiet", "origin", oxidePin.commit])
  // Oxide's v5-pinned branch builds on the Oxide commit that the wallet commit vendors.
  try {
    execFileSync("git", [
      "-C",
      vendor,
      "merge-base",
      "--is-ancestor",
      headOf(vendor),
      oxidePin.commit,
    ])
  } catch {
    throw new Error(`oxidePin ${oxidePin.commit} does not descend from ${source}'s vendor/oxide`)
  }
  const archive = path.join(mkdtempSync(path.join(tmpdir(), "oxide-v5-pin-")), "pin.tar.gz")
  writeFileSync(archive, oxideFile(source, "pinned-noir-artifacts.tar.gz"))
  try {
    const manifest = JSON.parse(oxideFile(source, "pinned-noir-artifacts.json").toString("utf8"))
    fn(manifest, (key) => {
      const bytes = readMember(archive, key)
      if (sha256(bytes) !== manifest[key]?.sha256)
        throw new Error(`Oxide's v5 pin: ${key} differs from its manifest`)
      return Buffer.from(fromOxide(bytes.toString("utf8")))
    })
  } finally {
    rmSync(path.dirname(archive), { recursive: true, force: true })
  }
}

/** Writes the wallet's and Oxide's pinned contracts where the v5 contracts build reads them. */
export function extractContracts(source) {
  const target = targetOf(source)
  const wallet = JSON.parse(readFileSync(WALLET_MANIFEST, "utf8"))
  if (wallet.walletCommit !== walletCommit)
    throw new Error(
      `pinned/ holds ${wallet.walletCommit}'s artifacts, not ${walletCommit}'s: re-pin`,
    )
  for (const [member, { sha256: expected }] of Object.entries(wallet.artifacts)) {
    const bytes = readMember(WALLET_ARCHIVE, member)
    if (sha256(bytes) !== expected) throw new Error(`pinned/${member} differs from its manifest`)
    mkdirSync(path.dirname(path.join(target, member)), { recursive: true })
    writeFileSync(path.join(target, member), bytes)
  }
  withOxidePin(source, (manifest, member) => {
    for (const name of OXIDE_CONTRACTS) {
      for (const key of Object.keys(manifest).filter((k) => k.startsWith(`${name}/`))) {
        mkdirSync(path.join(target, name), { recursive: true })
        writeFileSync(path.join(target, key), member(key))
      }
    }
  })
}

/**
 * Writes Oxide's pinned refund circuits into the vendor tree. build-oxide-tee.mjs clears them on its
 * first run, so this runs after it, and its required mode then finds them stamped and compiles none.
 */
export function extractRefundCircuits(source) {
  const vendor = path.join(source, "vendor/oxide")
  const vendorSha = headOf(vendor)
  withOxidePin(source, (_, member) => {
    for (const name of OXIDE_CIRCUITS) {
      const dir = path.join(vendor, "noir-projects", name, "target")
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, `${name}.json`), member(`${name}/${name}.json`))
      writeFileSync(path.join(dir, ".vendor-sha"), `${vendorSha}\n`)
    }
  })
}

/** Re-pins the v5 wallet's own artifacts from a checkout that built them from source. */
async function pin(source) {
  if (headOf(source) !== walletCommit)
    throw new Error(`${source} is not at walletCommit ${walletCommit}`)
  const target = targetOf(source)
  const require = createRequire(path.join(source, "packages/contracts/package.json"))
  const { loadContractArtifact } = await import(require.resolve("@aztec/stdlib/abi"))
  const { getContractClassFromArtifact } = await import(require.resolve("@aztec/stdlib/contract"))
  const stage = mkdtempSync(path.join(tmpdir(), "v5-wallet-pin-"))
  try {
    const artifacts = {}
    for (const name of readdirSync(target).sort()) {
      if (name.startsWith(".") || OXIDE_CONTRACTS.includes(name)) continue
      for (const file of readdirSync(path.join(target, name)).sort()) {
        if (!file.endsWith(".json")) continue
        const bytes = Buffer.from(
          fixPaths(source, readFileSync(path.join(target, name, file), "utf8")),
        )
        mkdirSync(path.join(stage, name), { recursive: true })
        writeFileSync(path.join(stage, name, file), bytes)
        const entry = { sha256: sha256(bytes) }
        const json = JSON.parse(bytes.toString("utf8"))
        if (json.functions)
          entry.classId = (
            await getContractClassFromArtifact(loadContractArtifact(json))
          ).id.toString()
        artifacts[`${name}/${file}`] = entry
      }
    }
    mkdirSync(path.dirname(WALLET_ARCHIVE), { recursive: true })
    // Fixed order, owners, modes and times, so re-pinning the same output gives the same bytes.
    const tar = execFileSync(
      "tar",
      [
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--mode=u=rwX,go=rX",
        "--format=gnu",
        "-C",
        stage,
        "-cf",
        "-",
        ".",
      ],
      { maxBuffer: 1 << 30 },
    )
    writeFileSync(WALLET_ARCHIVE, execFileSync("gzip", ["-9n"], { input: tar, maxBuffer: 1 << 30 }))
    writeFileSync(WALLET_MANIFEST, `${JSON.stringify({ walletCommit, artifacts }, null, 2)}\n`)
    console.log(`pinned ${Object.keys(artifacts).length} v5 wallet artifacts`)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const source = process.env.GENERATION_V5_SOURCE
  if (process.argv[2] !== "pin" || !source || !existsSync(targetOf(source))) {
    console.error("usage: GENERATION_V5_SOURCE=<checkout built from source> pins.mjs pin")
    process.exit(1)
  }
  await pin(path.resolve(source))
}
