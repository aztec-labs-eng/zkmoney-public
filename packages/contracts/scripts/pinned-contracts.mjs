#!/usr/bin/env node
// Committed compiled artifacts of every Noir package the wallet builds. Builds extract them instead
// of compiling, so an Aztec bump (compiler, aztec-nr, PXE) never moves a deployed class id or a
// circuit's verification key. A change to a pinned package's own source fails until someone re-pins
// it. An `upstream` pin names a package in Oxide's pinned archive; Oxide checks that pin against
// its source, and the wallet checks only the bytes and the class id.
// See docs/conventions/pinned-contracts.md.
//
// Usage:
//   pinned-contracts.mjs extract         # check sources and bytes, write src/artifacts/target/<pkg>/,
//                                        # and note pins built with older dependencies
//   pinned-contracts.mjs check           # the same checks, no writes
//   pinned-contracts.mjs verify          # check, plus recompute every class id
//   pinned-contracts.mjs dirs            # one pinned package dir per line
//   pinned-contracts.mjs pin [pkg ...]   # compile from source and re-pin (default: every pin)

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync, gzipSync } from "node:zlib"

import {
  closure,
  compilablePackages,
  compileFlags,
  packageType,
  repoRoot,
  sha,
  sourceDigest,
} from "./noir-source.mjs"
import {
  oxidePinFiles,
  readOxidePin,
  requireOxidePin,
} from "../../oxide-build/scripts/oxide-pins.mjs"

const PIN_DIR = path.join(repoRoot, "packages/contracts/pinned")
const PINS = path.join(PIN_DIR, "pins.json")
const TARGET = path.join(repoRoot, "packages/contracts/src/artifacts/target")
const SOURCE_SCHEMA = "pin-v2"

export const readPins = () => JSON.parse(readFileSync(PINS, "utf8"))

const treeAztecVersion = () =>
  readFileSync(path.join(repoRoot, "package.json"), "utf8").match(
    /--newVersion v?([0-9a-zA-Z.-]+)/,
  )[1]

// A git dependency coordinate is `<url>@<tag>:<directory>`; this drops the tag.
const untagged = (g) => {
  const at = g.lastIndexOf("@")
  const rest = g.slice(at + 1)
  return `${g.slice(0, at)}:${rest.slice(rest.indexOf(":") + 1)}`
}

// The same, inside a Nargo.toml.
const untagManifest = (text) =>
  text
    .split("\n")
    .map((line) => (/git\s*=/.test(line) ? line.replace(/tag\s*=\s*['"][^'"]*['"]/, "tag") : line))
    .join("\n")

const gitDeps = (dir) => closure(path.join(repoRoot, dir)).gits

// Our own Noir sources, local path dependencies included, and the compile flags. Like the compiler,
// the version of each git dependency (aztec-nr, the noir-lang libraries) is toolchain: a bump keeps
// the pin, and pins.json records the versions it was built with.
export function sourceKey(dir) {
  const abs = path.join(repoRoot, dir)
  const { pkgs, gits } = closure(abs)
  const parts = [`${SOURCE_SCHEMA}|flags=${compileFlags(path.basename(abs))}`]
  for (const d of pkgs)
    parts.push(`${path.relative(repoRoot, d)}=${sourceDigest(d, untagManifest)}`)
  // Deduped: mid-bump, the vendored oxide manifests can still name the old tag of the same crate.
  for (const g of [...new Set(gits.map(untagged))].sort()) parts.push(`git:${g}`)
  return sha(parts.join("|"))
}

// Pins built with an older toolchain or dependency than the tree names. Not an error: keeping a
// deployed class across a bump is the point of pinning.
export function toolchainDrift(pins = readPins()) {
  const tree = treeAztecVersion()
  const notes = []
  for (const [name, pin] of Object.entries(pins)) {
    if (pin.upstream) continue
    const changes = []
    if (pin.aztecVersion !== tree) changes.push(`Aztec ${pin.aztecVersion} -> ${tree}`)
    const tag = (g) => g.slice(g.lastIndexOf("@") + 1).split(":")[0]
    const crate = (g) =>
      untagged(g)
        .replace(/\/+$|:$/g, "")
        .split(/[/:]/)
        .pop()
    const pinned = new Map(pin.deps.map((g) => [untagged(g), g]))
    for (const g of new Set(gitDeps(pin.dir))) {
      const was = pinned.get(untagged(g))
      if (was && was !== g) changes.push(`${crate(g)} ${tag(was)} -> ${tag(g)}`)
    }
    if (changes.length) notes.push(`${name}: pinned with ${changes.join(", ")}`)
  }
  return notes
}

// What a re-pin changes: a contract's class id or a circuit's verification key.
const repin = (name, pin) => {
  const effect =
    packageType(path.join(repoRoot, pin.dir)) === "contract"
      ? "a new class id deploys a new class"
      : "this changes the circuit's verification key"
  // The zkJWT key lives in @obsidion/core/constants, which only recompile:paylinks refreshes.
  const steps =
    name === "zkJWT"
      ? ["recompile:paylinks", "pin:contracts zkJWT paylink_email paylink_direct"]
      : [`pin:contracts ${name}`]
  const run = steps.map((s) => `\`pnpm --filter @obsidion/contracts ${s}\``).join(" and then ")
  return `run ${run} to re-pin it (${effect}; see docs/conventions/pinned-contracts.md)`
}

const pinnedBytes = (name, pin, file) => {
  if (!pin.upstream) return gunzipSync(readFileSync(path.join(PIN_DIR, name, `${file}.gz`)))
  requireOxidePin()
  if (!oxidePinFiles(pin.upstream)[file]) {
    throw new Error(`${name}: Oxide pins no ${file}; ${repin(name, pin)}`)
  }
  return readOxidePin(pin.upstream, file)
}

// Every pinned artifact as bytes, after checking its source key and its sha256.
function* checkedArtifacts(pins = readPins()) {
  for (const [name, pin] of Object.entries(pins)) {
    if (!pin.upstream && sourceKey(pin.dir) !== pin.source) {
      throw new Error(
        `${name}: ${pin.dir} differs from the source it was pinned from; ${repin(name, pin)}`,
      )
    }
    for (const [file, { sha256 }] of Object.entries(pin.artifacts)) {
      const json = pinnedBytes(name, pin, file)
      if (sha(json) !== sha256) {
        const why = pin.upstream
          ? `Oxide re-pinned it; ${repin(name, pin)}`
          : "bytes differ from pins.json; restore packages/contracts/pinned/ from git"
        throw new Error(`${name}/${file}: ${why}`)
      }
      yield { name, file, json }
    }
  }
}

export function extract() {
  const written = new Set()
  for (const { name, file, json } of checkedArtifacts()) {
    const dir = path.join(TARGET, name)
    if (!written.has(name)) {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      written.add(name)
    }
    writeFileSync(path.join(dir, file), json)
  }
  return [...written]
}

export function check() {
  for (const _ of checkedArtifacts());
}

// @aztec-labs/stdlib loads lazily: extract runs before the workspace is installed in CI.
async function classIdOf(json) {
  const require = createRequire(path.join(repoRoot, "packages/contracts/package.json"))
  const { loadContractArtifact } = await import(require.resolve("@aztec-labs/stdlib/abi"))
  const { getContractClassFromArtifact } = await import(
    require.resolve("@aztec-labs/stdlib/contract")
  )
  const artifact = loadContractArtifact(JSON.parse(json.toString("utf8")))
  return (await getContractClassFromArtifact(artifact)).id.toString()
}

export async function verify() {
  const pins = readPins()
  for (const { name, file, json } of checkedArtifacts(pins)) {
    // Circuits have no class id.
    if (packageType(path.join(repoRoot, pins[name].dir)) !== "contract") continue
    const expected = pins[name].artifacts[file].classId
    if (!expected) throw new Error(`${name}/${file}: pins.json records no class id for a contract`)
    const actual = await classIdOf(json)
    if (actual !== expected) {
      throw new Error(`${name}/${file}: derives class ${actual}, pins.json says ${expected}`)
    }
  }
}

// The compiler writes absolute source paths into an artifact's file_map: this checkout's and nargo's
// dependency cache in $HOME. Pins keep them relative, so they carry no local path and re-pinning on
// another machine gives the same bytes. Class ids do not depend on them.
const relativePaths = (buf) =>
  Buffer.from(
    buf
      .toString("utf8")
      .replaceAll(`"${repoRoot}/`, '"')
      .replace(/"[^"]*\/nargo\/github\.com\//g, '"nargo/github.com/'),
  )

// gzip with a fixed header (no mtime, unix OS byte), so re-pinning identical output changes no bytes.
const gzip = (buf) => {
  const out = gzipSync(buf, { level: 9 })
  out[9] = 3
  return out
}

// pins.json records the tree's version, so only that toolchain compiles.
function toolchainBin() {
  const version = treeAztecVersion()
  const bin = path.join(os.homedir(), ".aztec", "versions", version, "bin")
  if (!existsSync(path.join(bin, "aztec"))) {
    throw new Error(`no Aztec ${version} toolchain at ${bin}; run pnpm bootstrap to install it`)
  }
  return bin
}

async function pin(names) {
  const pins = existsSync(PINS) ? readPins() : {}
  const dirs = new Map(
    compilablePackages().map((p) => [path.basename(p), path.relative(repoRoot, p)]),
  )
  const selected = names.length ? names : Object.keys(pins)
  for (const name of selected) {
    if (!dirs.has(name)) throw new Error(`${name}: no compilable Noir package has that name`)
  }
  for (const name of selected.filter((n) => pins[n]?.upstream)) {
    const { upstream } = pins[name]
    const artifacts = {}
    requireOxidePin()
    const files = Object.keys(oxidePinFiles(upstream)).filter((f) => f.endsWith(".json"))
    if (!files.length) throw new Error(`${name}: Oxide pins no artifact for ${upstream}`)
    for (const file of files) {
      const json = readOxidePin(upstream, file)
      artifacts[file] = { sha256: sha(json), classId: await classIdOf(json) }
      console.log(`pinned ${name}/${file} from Oxide, class ${artifacts[file].classId}`)
    }
    pins[name] = { dir: dirs.get(name), upstream, artifacts }
  }
  const compiled = selected.filter((n) => !pins[n]?.upstream)
  for (const name of compiled) rmSync(path.join(TARGET, name), { recursive: true, force: true })
  if (compiled.length) {
    execFileSync("bash", ["packages/contracts/scripts/build_contracts.sh"], {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        PATH: `${toolchainBin()}${path.delimiter}${process.env.PATH}`,
        PIN_REBUILD: compiled.join(" "),
      },
    })
  }
  for (const name of compiled) {
    const files = readdirSync(path.join(TARGET, name))
      .filter((f) => f.endsWith(".json"))
      .sort()
    if (!files.length) throw new Error(`${name}: the compile produced no artifact`)
    rmSync(path.join(PIN_DIR, name), { recursive: true, force: true })
    mkdirSync(path.join(PIN_DIR, name), { recursive: true })
    const dir = dirs.get(name)
    const contract = packageType(path.join(repoRoot, dir)) === "contract"
    const artifacts = {}
    for (const file of files) {
      const json = relativePaths(readFileSync(path.join(TARGET, name, file)))
      writeFileSync(path.join(PIN_DIR, name, `${file}.gz`), gzip(json))
      artifacts[file] = { sha256: sha(json) }
      if (contract) artifacts[file].classId = await classIdOf(json)
      console.log(`pinned ${name}/${file}${contract ? ` class ${artifacts[file].classId}` : ""}`)
    }
    pins[name] = {
      dir,
      source: sourceKey(dir),
      aztecVersion: treeAztecVersion(),
      deps: gitDeps(dir),
      artifacts,
    }
  }
  const sorted = Object.fromEntries(Object.entries(pins).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(PINS, `${JSON.stringify(sorted, null, 2)}\n`)
  // codegen reads target/, so an upstream re-pin refreshes it.
  if (compiled.length < selected.length) extract()
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [cmd, ...rest] = process.argv.slice(2)
  try {
    if (cmd === "extract") {
      console.log(`extracted pinned ${extract().join(", ")}`)
      for (const note of toolchainDrift()) {
        console.error(`notice: ${note}; the pinned artifact stays, re-pin to adopt`)
      }
    } else if (cmd === "check") check()
    else if (cmd === "verify") await verify()
    else if (cmd === "dirs") for (const p of Object.values(readPins())) console.log(p.dir)
    else if (cmd === "pin") await pin(rest)
    else if (cmd === "toolchain") console.log(toolchainBin())
    else
      throw new Error(
        "usage: pinned-contracts.mjs extract|check|verify|dirs|toolchain|pin [pkg ...]",
      )
  } catch (err) {
    console.error(`pinned-contracts ${cmd ?? ""}: ${err.message}`)
    process.exit(1)
  }
}
