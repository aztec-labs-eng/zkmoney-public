// Three modes around the bridge build. `snapshot` (after the main build) records every file in
// dist/ with its hash; `verify` (after the bridge build) proves dist/ is unchanged apart from
// bridge.html and then checks the page; `standalone` (the publish preflight, no snapshot to hand)
// checks the page alone. The page must carry everything it needs: a gated tier exempts only that
// path from basic auth, and a frame cannot answer a 401 for a chunk.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const DIST = fileURLToPath(new URL("../dist/", import.meta.url))
const SNAPSHOT = fileURLToPath(
  new URL("../node_modules/.cache/web-wallet/dist-snapshot.json", import.meta.url),
)
const BRIDGE = "bridge.html"

function listDist() {
  const files = {}
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else
        files[relative(DIST, path)] = createHash("sha256").update(readFileSync(path)).digest("hex")
    }
  }
  walk(DIST)
  return files
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

const mode = process.argv[2]
if (!["snapshot", "verify", "standalone"].includes(mode)) {
  fail("usage: assert-bridge-standalone.mjs snapshot | verify | standalone")
}

if (mode === "snapshot") {
  mkdirSync(new URL(".", `file://${SNAPSHOT}`), { recursive: true })
  writeFileSync(SNAPSHOT, JSON.stringify(listDist()))
  process.exit(0)
}

if (mode === "verify") {
  if (!existsSync(SNAPSHOT)) fail("no dist snapshot: run the main build with `snapshot` first")
  const before = JSON.parse(readFileSync(SNAPSHOT, "utf8"))
  const after = listDist()
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (file) => file !== BRIDGE && before[file] !== after[file],
  )
  if (changed.length) fail(`the bridge build changed the main bundle: ${changed.join(", ")}`)
}

const html = readFileSync(join(DIST, BRIDGE), "utf8")
const offenders = [
  [/\ssrc=/, "an external src="],
  [/\/assets\//, "an /assets/ reference"],
  [/\bimport\s*(\(|["'{*])/, "an import"],
  [/<link\s/, "a <link>"],
]
const found = offenders.filter(([pattern]) => pattern.test(html)).map(([, what]) => what)
if (!/<script type="module">/.test(html)) found.push("no inlined script")
if (found.length) fail(`dist/${BRIDGE} is not self-contained: ${found.join(", ")}`)
console.log(`dist/${BRIDGE} is self-contained (${html.length} bytes)`)
