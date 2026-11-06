import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const { assetName, inputsHash, protocol } = await import(
  `${repo}/packages/generation-v5/scripts/check.mjs`
)
const { walletCommit } = JSON.parse(
  readFileSync(`${repo}/packages/generation-v5/source.json`, "utf8"),
)
const tag = assetName.replace(/\.tar\.zst$/, "")
const OLD = "generation-v5-0000000000000000000000000000000000000000-protocol-1-000000000000"
const LINK = "// https://linear.app/team/issue/AB-1/x\n"

const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
repo=public args=()
while [ $# -gt 0 ]; do
  case "$1" in -R) repo=private; shift 2 ;; -p) pattern=$2; shift 2 ;; -D) dir=$2; shift 2 ;; *) args+=("$1"); shift ;; esac
done
case "\${args[1]}" in
  list) cat "$FAKE/list" ;;
  download) [ -f "$FAKE/$repo/\${args[2]}/\${pattern:?}" ] && cp "$FAKE/$repo/\${args[2]}/$pattern" "$dir" ;;
  create) echo "\${args[*]}" > "$FAKE/created" ;;
esac
`

function pack(dest, name, files) {
  const dir = mkdtempSync(path.join(tmpdir(), "bundle-"))
  const digests = {}
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, file), content)
    digests[file] = createHash("sha256").update(content).digest("hex")
  }
  const manifest = { files: digests, walletCommit, protocol, inputs: inputsHash }
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest))
  mkdirSync(dest, { recursive: true })
  execFileSync("tar", ["--zstd", "-cf", path.join(dest, name), "-C", dir, "."])
}

function copy({ listed = [OLD], source }) {
  const root = mkdtempSync(path.join(tmpdir(), "copy-"))
  for (const part of [
    "packages/generation-v5",
    "packages/core/src/types",
    ".claude/skills/wallet-sync",
  ])
    cpSync(path.join(repo, part), path.join(root, part), {
      recursive: true,
      filter: (file) => !/\/(dist|node_modules|\.source)$/.test(file),
    })
  const fake = path.join(root, "fake")
  mkdirSync(path.join(fake, "bin"), { recursive: true })
  writeFileSync(path.join(fake, "bin/gh"), FAKE_GH)
  chmodSync(path.join(fake, "bin/gh"), 0o755)
  writeFileSync(path.join(fake, "list"), `desktop-v0.9.0\n${listed.join("\n")}\n`)
  pack(path.join(fake, "public", OLD), `${OLD}.tar.zst`, { "a-1.js": LINK })
  if (source) pack(path.join(fake, "private/source-generations"), assetName, source)
  const env = {
    ...process.env,
    PATH: `${fake}/bin:${process.env.PATH}`,
    FAKE: fake,
    SOURCE_TOKEN: "t",
  }
  const script = path.join(root, ".claude/skills/wallet-sync/copy-bundle.sh")
  const { status, stdout, stderr } = spawnSync(script, { encoding: "utf8", env })
  const createdFile = path.join(fake, "created")
  const created = existsSync(createdFile) && readFileSync(createdFile, "utf8")
  return { status, log: stdout + stderr, created }
}

test("does nothing when this repository has the release", () => {
  const { status, created } = copy({ listed: [OLD, tag], source: { "b-2.js": "ABC-123" } })
  assert.deepEqual({ status, created }, { status: 0, created: false })
})

test("stops before the release when the private release has no asset", () => {
  const { status, log, created } = copy({})
  assert.deepEqual({ status, created }, { status: 1, created: false })
  assert.match(log, /has no \S+ in its source-generations release/)
})

test("stops before the release when the scan finds an item", () => {
  const { status, log, created } = copy({ source: { "a-2.js": LINK, "b-2.js": "// ABC-123\n" } })
  assert.deepEqual({ status, created }, { status: 1, created: false })
  assert.match(log, /1 forbidden items/)
  assert.doesNotMatch(log, /ABC-123/)
})

test("creates a pre-release that is not latest with the private asset", () => {
  const { status, created } = copy({ source: { "a-2.js": LINK, "b-2.js": "clean\n" } })
  assert.equal(status, 0)
  assert.match(created, new RegExp(`^release create ${tag} \\S+/${assetName} --target main`))
  const notes = `bundle for wallet commit ${walletCommit.slice(0, 10)}, protocol ${protocol} and inputs hash ${inputsHash}.`
  assert.ok(created.includes(`--prerelease --latest=false --title v5 bundle ${inputsHash} `))
  assert.ok(created.trimEnd().endsWith(notes))
})
