#!/usr/bin/env node
// Builds dist/: the v5 source generation bundle. It checks out the pinned v5 wallet commit in its
// own worktree with its own install, builds that commit with the Aztec v5 toolchain, then compiles
// the adapter there. Nothing resolves through this checkout's packages or vendor/oxide.
//
// Env:
//   GENERATION_V5_SOURCE  checkout to build in (default: .source beside this package)
//   AZTEC_V5_HOME         the v5 toolchain (default: ~/.aztec/versions/<aztecVersion>)
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { boundaryFile, inputsHash, protocol } from "./check.mjs"

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repo = path.resolve(pkg, "../..")
const { walletCommit, aztecVersion } = JSON.parse(
  readFileSync(path.join(pkg, "source.json"), "utf8"),
)
const source = path.resolve(process.env.GENERATION_V5_SOURCE ?? path.join(pkg, ".source"))
const toolchain = process.env.AZTEC_V5_HOME ?? path.join(homedir(), ".aztec/versions", aztecVersion)
const dist = path.join(pkg, "dist")

const env = {
  ...process.env,
  CI: "1",
  PATH: [
    path.join(toolchain, "bin"),
    path.join(toolchain, "internal-bin"),
    path.join(toolchain, "node_modules/.bin"),
    process.env.PATH,
  ].join(path.delimiter),
}

const run = (cmd, args, cwd = source) => {
  console.error(`> ${cmd} ${args.join(" ")}   (cwd: ${cwd})`)
  execFileSync(cmd, args, { cwd, env, stdio: "inherit" })
}
const read = (cmd, args, cwd = source) =>
  execFileSync(cmd, args, { cwd, env, encoding: "utf8" }).trim()

if (!existsSync(path.join(toolchain, "bin/aztec")))
  throw new Error(
    `No Aztec ${aztecVersion} toolchain at ${toolchain}: aztec-up install ${aztecVersion}`,
  )

if (!existsSync(source)) {
  run("git", ["fetch", "origin", walletCommit], repo)
  run("git", ["worktree", "add", "--detach", source, walletCommit], repo)
}
if (read("git", ["rev-parse", "HEAD"]) !== walletCommit)
  throw new Error(`${source} is not at the pinned v5 commit ${walletCommit}`)
run("git", ["submodule", "update", "--init", "--recursive", "vendor/oxide"])

// The heavy steps run once per pinned commit.
const stamp = path.join(source, ".generation-v5-built")
if (!existsSync(stamp) || readFileSync(stamp, "utf8") !== walletCommit) {
  run("pnpm", ["install", "--frozen-lockfile"])
  run("pnpm", ["build-contracts"])
  run("pnpm", ["--filter", "@obsidion/oxide-build", "build:refund-circuits"])
  run("pnpm", ["build:web-deps"])
  writeFileSync(stamp, walletCommit)
}

// The adapter compiles beside the v5 wallet, against the protocol this checkout declares.
const adapter = path.join(source, "packages/web-wallet/generation-adapter")
cpSync(path.join(pkg, "adapter"), adapter, { recursive: true })
const boundary = readFileSync(boundaryFile, "utf8")
writeFileSync(
  path.join(adapter, "protocol.ts"),
  boundary.replace('"./index.js"', '"@obsidion/core/types"'),
)
// The Noir artifacts embed the absolute paths of their sources. The bundle names them from fixed
// roots instead, so its manifest digest does not depend on the checkout or the home directory.
const pathRoots = [
  [`${source}/`, "v5-wallet/"],
  [`${path.join(homedir(), "nargo")}/`, "nargo/"],
]
const fixPaths = (text) => pathRoots.reduce((out, [from, to]) => out.replaceAll(from, to), text)
const webWallet = path.join(source, "packages/web-wallet")
run("pnpm", ["exec", "tsc", "--noEmit", "-p", "generation-adapter/tsconfig.json"], webWallet)
execFileSync("pnpm", ["exec", "vite", "build", "--config", "generation-adapter/vite.config.ts"], {
  cwd: webWallet,
  env: {
    ...env,
    GENERATION_OUT_DIR: dist,
    GENERATION_PATH_ROOTS: JSON.stringify(pathRoots),
    NODE_OPTIONS: "--max-old-space-size=8192",
  },
  stdio: "inherit",
})

const digest = (data) => createHash("sha256").update(data).digest("hex")
const sha256 = (file) => digest(readFileSync(file))
const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? files(full) : [full]
  })
const circuits = ["frozen_notes_refund", "frozen_deposit_refund", "unprocessed_deposit_refund"]
mkdirSync(dist, { recursive: true })
writeFileSync(
  path.join(dist, "manifest.json"),
  `${JSON.stringify(
    {
      protocol,
      inputs: inputsHash,
      aztecVersion,
      walletCommit,
      oxideCommit: read("git", ["rev-parse", "HEAD"], path.join(source, "vendor/oxide")),
      refundCircuits: Object.fromEntries(
        circuits.map((name) => [
          name,
          digest(
            fixPaths(
              readFileSync(
                path.join(source, `vendor/oxide/noir-projects/${name}/target/${name}.json`),
                "utf8",
              ),
            ),
          ),
        ]),
      ),
      files: Object.fromEntries(
        files(dist)
          .filter((file) => !file.endsWith("manifest.json"))
          .map((file) => [path.relative(dist, file), sha256(file)]),
      ),
    },
    null,
    2,
  )}\n`,
)
console.error(`v5 source generation built at ${dist}`)
console.error(`manifest sha256: ${sha256(path.join(dist, "manifest.json"))}`)
