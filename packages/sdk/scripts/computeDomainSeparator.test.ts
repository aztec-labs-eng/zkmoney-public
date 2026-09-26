import { describe, it } from "vitest"
import { keccak256 } from "@aztec/foundation/crypto/keccak"

// pnpm test -- scripts/computeDomainSeparator.test.ts

/**
 * Computes domain separators using first 4 bytes of keccak256(moduleName).
 *
 * Similar to Ethereum function selectors, this gives a deterministic u32 value
 * that works in both Noir (u32) and TypeScript (number).
 */
export async function computeDomainSeparator() {
  const domainStrings = [
    "MpkJwtRecoveryModule",
    "AutoShielder",
    "mpkHash",
    "mpkPreimage",
    "mpkJwtRecoveryCapsuleSlot",
  ]

  console.log("\n=== Domain Separators (4-byte selectors) ===\n")

  for (const str of domainStrings) {
    const buffer = Buffer.from(new TextEncoder().encode(str))
    const hash = keccak256(buffer)

    // Take first 4 bytes (32 bits) - fits in u32/number
    const selector = hash.slice(0, 4)
    const hexValue = "0x" + Buffer.from(selector).toString("hex")
    const decimalValue = parseInt(hexValue, 16)

    // Convert to constant name format
    const constName =
      str
        .replace(/([A-Z])/g, "_$1")
        .toUpperCase()
        .replace(/^_/, "") + "_DOMAIN_SEPARATOR"

    console.log(`// keccak256("${str}")[0:4]`)
    console.log(`// Noir:`)
    console.log(`global ${constName}: u32 = ${hexValue};`)
    console.log(`// TypeScript:`)
    console.log(`const ${constName} = ${hexValue} // ${decimalValue}\n`)
  }
}

describe("Script", async () => {
  it("script", async () => {
    await computeDomainSeparator()
  })
})
