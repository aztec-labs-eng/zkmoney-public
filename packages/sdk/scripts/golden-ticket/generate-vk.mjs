// Pin the golden ticket circuit's UltraHonk verification key as GOLDEN_TICKET_VK_BASE64 in
// @obsidion/core and write it beside the circuit (target/vk/vk), the way zkJWT's is.
//
// `scripts/build_contracts.sh` runs this on every circuit build with `--in` (the artifact it just
// compiled), `--out` (the constants file) and `--circuit golden_ticket`, so the pin cannot fall
// behind the artifact the sdk proves with. Standalone, with no `--in`, it compiles the circuit first
// and copies the artifact to packages/contracts. `--check` derives the key and fails on a pin that
// differs, writing nothing.
import { execSync } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js"

const CIRCUIT = "golden_ticket"
const VK_BYTES = 115 * 32
const PIN = /\/\/ GOLDEN_TICKET_VK_BASE64_START\n[\s\S]*?\/\/ GOLDEN_TICKET_VK_BASE64_END/
const PINNED = /export const GOLDEN_TICKET_VK_BASE64 =\n\s*"([A-Za-z0-9+/=]*)"/

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "../../../..")
const circuitDir = resolve(root, "packages/contracts/circuits/golden_ticket")
const vkPath = resolve(circuitDir, "target/vk/vk")

function parseArgs(argv) {
  const args = { in: null, out: null, circuit: CIRCUIT, check: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--in") args.in = argv[++i]
    else if (a === "--out") args.out = argv[++i]
    else if (a === "--circuit") args.circuit = argv[++i]
    else if (a === "--check") args.check = true
    else throw new Error(`unknown argument ${a}`)
  }
  if (args.circuit !== CIRCUIT)
    throw new Error(`this generator pins ${CIRCUIT}, not ${args.circuit}`)
  return args
}

const args = parseArgs(process.argv.slice(2))
const constants = resolve(args.out ?? resolve(root, "packages/core/src/constants/index.ts"))
let compiled = args.in ? resolve(args.in) : resolve(circuitDir, "target/golden_ticket.json")
if (!args.in) {
  execSync(`${process.env.NARGO ?? "aztec-nargo"} compile`, { cwd: circuitDir, stdio: "inherit" })
  const canonical = resolve(
    root,
    "packages/contracts/src/artifacts/target/golden_ticket/golden_ticket.json",
  )
  mkdirSync(dirname(canonical), { recursive: true })
  copyFileSync(compiled, canonical)
}

const { bytecode } = JSON.parse(readFileSync(compiled, "utf-8"))
if (typeof bytecode !== "string" || !bytecode) throw new Error(`${compiled} has no bytecode`)
const src = readFileSync(constants, "utf-8")
if (!PIN.test(src)) throw new Error(`GOLDEN_TICKET_VK_BASE64 markers not found in ${constants}`)

const api = await Barretenberg.new({})
try {
  const vk = await new UltraHonkBackend(bytecode, api).getVerificationKey()
  if (vk.length !== VK_BYTES) {
    throw new Error(`verification key is ${vk.length} bytes, expected ${VK_BYTES}`)
  }
  const b64 = Buffer.from(vk).toString("base64")
  if (args.check) {
    const pinned = src.match(PINNED)?.[1]
    if (pinned !== b64) {
      console.error(
        `GOLDEN_TICKET_VK_BASE64 in ${constants} does not match the key derived from ${compiled}; ` +
          "rerun without --check to re-pin it",
      )
      process.exit(1)
    }
    console.log(`GOLDEN_TICKET_VK_BASE64 matches ${compiled}`)
  } else {
    mkdirSync(dirname(vkPath), { recursive: true })
    writeFileSync(vkPath, vk)
    writeFileSync(
      constants,
      src.replace(
        PIN,
        `// GOLDEN_TICKET_VK_BASE64_START\nexport const GOLDEN_TICKET_VK_BASE64 =\n  "${b64}"\n// GOLDEN_TICKET_VK_BASE64_END`,
      ),
    )
    console.log(`vk: ${vk.length} bytes → ${vkPath}; pinned in ${constants}`)
  }
} finally {
  await api.destroy()
}
