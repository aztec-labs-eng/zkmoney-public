/**
 * Paylink freshness drift guard over the paylink pipeline (core constants → committed vk):
 *
 *   D. ZKJWT_VKEY_HASH constant matches the Poseidon2 hash of the committed
 *      zkJWT verification key (the email deposit binds vkey_hash from this
 *      constant). Both sides are committed, so D runs in a clean checkout.
 *
 * No paylink address is baked into bytecode — the token, OIDC key registry,
 * and zkJWT vkey hash are all per-deposit note bindings read at claim — so a
 * token redeploy never moves a paylink class id and there is no hardcoded
 * Noir address to check.
 *
 * Run from packages/contracts:
 *   pnpm exec tsx scripts/check-paylink-freshness.ts
 */
import { readFileSync, existsSync } from "fs"
import { resolve } from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { Fr } from "@aztec/aztec.js/fields"
// Core constants is a leaf module (type-only @aztec imports), so importing
// the TS source directly lets this developer CLI run without building another package.
import { ZKJWT_VKEY_HASH, ZKJWT_VK_BASE64 } from "../../core/src/constants/index.js"

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../../")

const RECOMPILE_FIX = "cd packages/contracts && pnpm recompile:paylinks"

export class DriftError extends Error {}

/** Reject malformed values BEFORE any comparison — a malformed value is its
 *  own loud failure, never a comparison input. Strict 64-nibble form, matching
 *  the L2_ADDRESS validation in OxideEnvRegistryClient: every producer in this
 *  pipeline emits full-width addresses, so anything
 *  shorter is malformed input, not a candidate for comparison. */
export function assertHexAddress(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new DriftError(
      `${label} is not a 0x-prefixed 64-nibble hex address (got ${JSON.stringify(value)})`,
    )
  }
  return value
}

/** Field-element equality: case-insensitive, leading-zero tolerant. */
export function sameAddress(a: string, b: string): boolean {
  try {
    return BigInt(a) === BigInt(b)
  } catch {
    throw new DriftError(`sameAddress: invalid hex input — "${a}" / "${b}"`)
  }
}

interface Drift {
  check: string
  message: string
  fix: string
}

/** Check D: ZKJWT_VKEY_HASH constant vs the Poseidon2 hash of the committed
 *  zkJWT verification key. The vkey hash is a per-deposit note binding sourced from this
 *  constant (never baked into bytecode), so a circuit change that regenerates the vk without
 *  refreshing the constant strands every email-paylink deposit on a stale key. Both sides are
 *  committed, so this runs in a clean CI checkout.
 *
 *  Mirrors deploy.ts `refreshZkJwtVkeyHash`: the vk file is the raw
 *  concatenation of 32-byte big-endian field elements (the same array bb
 *  emits as `--output_format json`), and the hash is PLAIN Poseidon2 over
 *  those fields — NOT poseidon2HashWithSeparator, which would prepend the
 *  field count and produce a different value. */
export async function checkVkeyHash(args: {
  vkBuffer: Buffer
  expected: string
  /** ZKJWT_VK_BASE64 pin; when supplied it must be exactly the vk file's bytes. */
  vkBase64?: string
}): Promise<Drift[]> {
  const { vkBuffer } = args
  if (vkBuffer.length === 0 || vkBuffer.length % 32 !== 0) {
    // Malformed input is its own loud failure, never a comparison input —
    // same philosophy as assertHexAddress. A non-multiple-of-32 vk means the
    // committed file is not a field-element array at all.
    throw new DriftError(
      `zkJWT vk is ${vkBuffer.length} bytes — expected a non-empty multiple of 32 ` +
        "(concatenated 32-byte big-endian field elements). The committed vk is malformed.",
    )
  }
  const expected = assertHexAddress(args.expected, "ZKJWT_VKEY_HASH")
  const { poseidon2Hash } = await import("@aztec/foundation/crypto/poseidon")
  const fields: Fr[] = []
  for (let i = 0; i < vkBuffer.length; i += 32) {
    fields.push(Fr.fromBuffer(vkBuffer.subarray(i, i + 32)))
  }
  const computed = (await poseidon2Hash(fields)).toString()
  const drifts: Drift[] = []
  if (!sameAddress(computed, expected)) {
    drifts.push({
      check: "D",
      message:
        `ZKJWT_VKEY_HASH = ${expected} but the committed zkJWT vk hashes to ${computed} — ` +
        "the circuit changed and the ZKJWT_VKEY_HASH constant was not refreshed",
      fix: RECOMPILE_FIX,
    })
  }
  // The pinned vk fields (what claims send on-chain) must be the SAME bytes as the committed
  // file — a refreshed vk with a stale base64 pin fails every email claim on vkey-hash mismatch.
  if (args.vkBase64 !== undefined && args.vkBase64 !== vkBuffer.toString("base64")) {
    drifts.push({
      check: "D",
      message:
        "ZKJWT_VK_BASE64 does not match the committed circuits/zkJWT/target/vk/vk bytes — " +
        "the vk was regenerated without refreshing the constant",
      fix: RECOMPILE_FIX,
    })
  }
  return drifts
}

function report(drifts: Drift[]): void {
  if (drifts.length === 0) {
    console.log("✅ paylink freshness checks passed")
    return
  }
  for (const d of drifts) {
    console.error(`❌ [Check ${d.check}] ${d.message}`)
    console.error(`   Fix: ${d.fix}\n`)
  }
  process.exit(1)
}

async function main(): Promise<void> {
  // The zkJWT vk is committed, so a missing file is a broken checkout — a
  // loud error, never a skip.
  const vkPath = resolve(repoRoot, "packages/contracts/circuits/zkJWT/target/vk/vk")
  if (!existsSync(vkPath)) {
    throw new DriftError(
      `zkJWT vk not found at ${vkPath} — it is committed, so a missing file is a broken ` +
        "checkout, not a Check D skip.",
    )
  }
  const vkBuffer = readFileSync(vkPath)

  report(await checkVkeyHash({ vkBuffer, expected: ZKJWT_VKEY_HASH, vkBase64: ZKJWT_VK_BASE64 }))
}

// Only run as a CLI — the test file imports the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`❌ ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  })
}
