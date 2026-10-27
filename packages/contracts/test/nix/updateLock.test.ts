import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const inContainer = fileURLToPath(new URL("../../nix/in-container.sh", import.meta.url))
const hash = "sha256-AAAA"

describe("in-container.sh lock", () => {
  let bin: string
  beforeAll(() => {
    bin = mkdtempSync(join(tmpdir(), "nix-lock-"))
    // Both record their arguments. `nix eval` answers `missing` with $MISSING until `found` holds the hash `nix-build`
    // names, and echoes `found` back as gitDeps.
    const stubs = {
      "nix": `const found = args[args.indexOf("found") + 1]
if (args.includes("lock.aztecToolchainNpmDeps")) console.log("sha256-npm")
else if (args.includes("missing")) {
  if (!found.includes("${hash}")) console.log(process.env.MISSING)
}
else console.log(found)`,
      "nix-build": `console.log("got:    ${hash}")`,
    }
    for (const [name, body] of Object.entries(stubs)) {
      writeFileSync(
        join(bin, name),
        `#!/usr/bin/env node
const args = process.argv.slice(2)
require("fs").appendFileSync(process.env.LOG, JSON.stringify(args) + "\\n")
${body}
`,
      )
      chmodSync(join(bin, name), 0o755)
    }
  })
  afterAll(() => rmSync(bin, { recursive: true, force: true }))

  it("hands Nix a dependency's manifest fields as data, never as source", () => {
    const tag = 'v1"; x = ${builtins.getEnv "NIMBUS_AUTH_TOKEN"}; y = "'
    const entry = {
      gitKey: `github.com/a/b/${tag}`,
      owner: "a",
      repo: "b",
      sparseCheckout: [],
      tag,
    }
    const log = join(bin, "log")
    const result = spawnSync("bash", [inContainer, "lock", '["pkg"]'], {
      encoding: "utf8",
      timeout: 60_000,
      env: { PATH: `${bin}:${process.env.PATH}`, LOG: log, MISSING: JSON.stringify(entry) },
    })
    expect(result.status, result.stderr).toBe(0)

    const calls = readFileSync(log, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    for (const args of calls) {
      args.forEach((arg, i) => {
        if (arg.includes("NIMBUS_AUTH_TOKEN")) expect(args[i - 2], arg).toBe("--argstr")
      })
    }
    const probe = calls.find((args) => args.includes("entry"))!
    expect(JSON.parse(probe[probe.indexOf("entry") + 1])).toEqual(entry)
    expect(JSON.parse(result.stdout).gitDeps).toEqual([{ ...entry, hash }])
  })
})
