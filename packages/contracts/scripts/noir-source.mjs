// The Noir packages build_contracts.sh compiles and the digest of their source closure, shared by
// the per-package compile cache (.github/scripts/noir-cache.mjs) and the pinned artifacts
// (pinned-contracts.mjs).

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim()

// Mirrors build_contracts.sh SEARCH_ROOTS.
const SEARCH_ROOTS = [
  "packages/contracts/contracts",
  "packages/contracts/circuits",
  "vendor/oxide/noir-projects/oxide_token_contract",
  "vendor/oxide/noir-projects/broadcaster_contract",
]
// ...and the paths its find(1) prunes.
const EXCLUDE_PARTS = ["/node_modules/", "/libs/", "/lib/", "/.git/"]

// build_contracts.sh compiles these two with a non-default inliner setting so the bytecode
// matches the contract class ids oxide deployed; different flags, different output.
const OXIDE_FLAG_PKGS = new Set(["oxide_token_contract", "broadcaster_contract"])
export const compileFlags = (name) =>
  OXIDE_FLAG_PKGS.has(name) ? "--inliner-aggressiveness 0" : ""

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "flags") {
  console.log(compileFlags(process.argv[3]))
}

export const sha = (b) => createHash("sha256").update(b).digest("hex")
const fileDigest = (p) => sha(readFileSync(p))
const manifestOf = (d) => path.join(d, "Nargo.toml")

export function packageType(d) {
  const m = readFileSync(manifestOf(d), "utf8").match(/^\s*type\s*=\s*"?(\w+)"?/m)
  return m ? m[1] : ""
}

// Dependency entries are single-line inline tables in every manifest we compile,
// so a line scan avoids vendoring a TOML parser.
function declaredDeps(d) {
  const text = readFileSync(manifestOf(d), "utf8")
  const local = []
  const git = []
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (line.startsWith("#")) continue
    const p = line.match(/path\s*'?\s*=\s*'?"?([^'"]+)['"]/)
    if (p) local.push(path.normalize(path.join(d, p[1])))
    const g = line.match(/git\s*=\s*['"]([^'"]+)['"]/)
    if (g) {
      const t = line.match(/tag\s*=\s*['"]([^'"]+)['"]/)
      const sub = line.match(/directory\s*=\s*['"]([^'"]+)['"]/)
      git.push(`${g[1].replace(/\/+$/, "")}@${t ? t[1] : "?"}:${sub ? sub[1] : ""}`)
    }
  }
  return { local, git }
}

// The package and its local `path` dependencies, transitively, plus every git dependency they
// name. Git dependencies are tag-pinned and therefore immutable, so their coordinate stands in
// for their content.
export function closure(root) {
  const seen = new Set()
  const gits = new Set()
  const stack = [root]
  while (stack.length) {
    const d = stack.pop()
    if (seen.has(d)) continue
    if (!existsSync(manifestOf(d))) {
      throw new Error(`missing Nargo.toml for path dependency: ${path.relative(repoRoot, d)}`)
    }
    seen.add(d)
    const { local, git } = declaredDeps(d)
    git.forEach((g) => gits.add(g))
    stack.push(...local)
  }
  return { pkgs: [...seen].sort(), gits: [...gits].sort() }
}

// A package's own Nargo.toml and src/**/*.nr. `manifest` can normalize the Nargo.toml first.
export function sourceDigest(pkgdir, manifest) {
  const h = createHash("sha256")
  const text = readFileSync(manifestOf(pkgdir), "utf8")
  h.update(`M:${sha(manifest ? manifest(text) : text)}`)
  const src = path.join(pkgdir, "src")
  const found = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith(".nr")) found.push(p)
    }
  }
  walk(src)
  for (const f of found.sort()) {
    h.update(`${path.relative(pkgdir, f)}:${fileDigest(f)}`)
  }
  return h.digest("hex")
}

function findPackages() {
  const out = []
  for (const root of SEARCH_ROOTS) {
    const abs = path.join(repoRoot, root)
    if (!existsSync(abs)) continue
    if (existsSync(manifestOf(abs))) {
      out.push(abs)
      continue
    }
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        const p = path.join(dir, e.name)
        if (EXCLUDE_PARTS.some((x) => `${p}/`.includes(x))) continue
        if (existsSync(manifestOf(p))) out.push(p)
        walk(p)
      }
    }
    walk(abs)
  }
  return [...new Set(out)].sort()
}

export function compilablePackages() {
  const pkgs = findPackages().filter((p) => ["contract", "bin"].includes(packageType(p)))
  if (pkgs.length === 0) {
    throw new Error("no compilable Noir packages found — is the oxide submodule initialised?")
  }
  const names = pkgs.map((p) => path.basename(p))
  // build_contracts.sh keys its output directory and its -e matching on the
  // basename, so a collision would silently alias two packages' artifacts.
  const dupes = names.filter((n, i) => names.indexOf(n) !== i)
  if (dupes.length)
    throw new Error(`duplicate package basenames: ${[...new Set(dupes)].join(", ")}`)
  return pkgs
}
