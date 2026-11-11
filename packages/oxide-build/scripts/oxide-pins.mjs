#!/usr/bin/env node
// Oxide commits the compiled artifacts of the Noir packages the wallet builds as one archive,
// vendor/oxide/noir-projects/pinned-noir-artifacts.tar.gz, with a manifest of each file's sha256
// (its noir-projects/pin.sh). Oxide's own build and codegen read <package>/target/, so this copies a
// pinned package there instead of compiling it.
//
// Usage: oxide-pins.mjs <package...>

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const NOIR_PROJECTS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../vendor/oxide/noir-projects",
)
const ARCHIVE = resolve(NOIR_PROJECTS, "pinned-noir-artifacts.tar.gz")
const MANIFEST = resolve(NOIR_PROJECTS, "pinned-noir-artifacts.json")

const manifest = () => (existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : {})

/** The files Oxide pins for a package, as `{ <file>: { sha256, classId? } }`. */
export function oxidePinFiles(pkg) {
  const prefix = `${pkg}/`
  return Object.fromEntries(
    Object.entries(manifest())
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, entry]) => [key.slice(prefix.length), entry]),
  )
}

export const hasOxidePin = (pkg) => Object.keys(oxidePinFiles(pkg)).length > 0

/** Fails when the vendor tree has no Oxide pin at all, which a re-pin cannot fix. */
export function requireOxidePin() {
  if (!existsSync(MANIFEST) || !existsSync(ARCHIVE)) {
    throw new Error(
      "vendor/oxide/noir-projects has no pinned-noir-artifacts.tar.gz and .json: check out " +
        "vendor/oxide at the commit this tree names (`git submodule update vendor/oxide`)",
    )
  }
}

/** One pinned file's bytes, checked against Oxide's manifest. */
export function readOxidePin(pkg, file) {
  const entry = oxidePinFiles(pkg)[file]
  if (!entry) throw new Error(`vendor/oxide/noir-projects: Oxide pins no ${pkg}/${file}`)
  const bytes = execFileSync("tar", ["-xzOf", ARCHIVE, `./${pkg}/${file}`], {
    maxBuffer: 1 << 30,
  })
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
    throw new Error(`vendor/oxide/noir-projects: ${pkg}/${file} differs from Oxide's manifest`)
  }
  return bytes
}

// Writes only changed files, so an unchanged pin keeps target/ mtimes.
export function extractOxidePin(pkg) {
  const files = Object.keys(oxidePinFiles(pkg)).filter((f) => f.endsWith(".json"))
  if (!files.length) throw new Error(`vendor/oxide/noir-projects/${pkg} has no pinned artifact`)
  const target = resolve(NOIR_PROJECTS, pkg, "target")
  mkdirSync(target, { recursive: true })
  for (const file of files) {
    const bytes = readOxidePin(pkg, file)
    const out = resolve(target, file)
    if (!existsSync(out) || !readFileSync(out).equals(bytes)) writeFileSync(out, bytes)
  }
  return files
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const pkgs = process.argv.slice(2)
  if (!pkgs.length) {
    console.error("usage: oxide-pins.mjs <package...>")
    process.exit(1)
  }
  try {
    for (const pkg of pkgs)
      console.log(`extracted Oxide pin ${pkg}: ${extractOxidePin(pkg).join(", ")}`)
  } catch (err) {
    console.error(`oxide-pins: ${err.message}`)
    process.exit(1)
  }
}
