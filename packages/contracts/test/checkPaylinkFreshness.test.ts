import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { Fr } from "@aztec/aztec.js/fields"
import { ZKJWT_VKEY_HASH, ZKJWT_VK_BASE64 } from "@obsidion/core/constants"
import {
  DriftError,
  assertHexAddress,
  checkVkeyHash,
  sameAddress,
} from "../scripts/check-paylink-freshness.js"

const TOKEN = "0x0c633683d7c5fa6559f0f57839ddc2976dc9d0fa5ffa2329a9a9905f820e7517"
describe("sameAddress / assertHexAddress", () => {
  it("treats case and leading-zero padding as equal", () => {
    expect(sameAddress("0x0C63", "0x0c63")).toBe(true)
    expect(sameAddress("0x00ff", "0xff")).toBe(true)
    expect(sameAddress("0x01", "0x02")).toBe(false)
  })

  it("rejects empty, non-hex, and short values before any comparison", () => {
    expect(() => assertHexAddress("", "slot")).toThrow(DriftError)
    expect(() => assertHexAddress("not-hex", "slot")).toThrow(DriftError)
    expect(() => assertHexAddress(undefined, "slot")).toThrow(DriftError)
    expect(() => assertHexAddress("0x", "slot")).toThrow(DriftError)
    // Full-width only — every producer emits 64 nibbles; shorter is malformed
    // input, not a comparison candidate.
    expect(() => assertHexAddress("0x1", "slot")).toThrow(DriftError)
    expect(assertHexAddress(TOKEN, "slot")).toBe(TOKEN)
  })

  it("sameAddress raises DriftError (not a bare SyntaxError) on invalid input", () => {
    expect(() => sameAddress("not-hex", "0x01")).toThrow(DriftError)
  })
})

describe("checkVkeyHash (Check D)", () => {
  // Two arbitrary 32-byte big-endian fields → a 64-byte vk buffer. The real vk
  // is 115 fields; the hashing logic is length-agnostic, so a 2-field stand-in
  // exercises the same parse → Poseidon2 → compare path without bundling a
  // 3680-byte fixture.
  const vkBuffer = Buffer.concat([
    Buffer.from("11".repeat(32), "hex"),
    Buffer.from("22".repeat(32), "hex"),
  ])

  // Mirrors checkVkeyHash's own parse so the fixture's "fresh" constant is
  // derived the same way deploy.ts derives ZKJWT_VKEY_HASH from the circuit vk.
  async function hashOf(buf: Buffer): Promise<string> {
    const { poseidon2Hash } = await import("@aztec/foundation/crypto/poseidon")
    const fields: Fr[] = []
    for (let i = 0; i < buf.length; i += 32) fields.push(Fr.fromBuffer(buf.subarray(i, i + 32)))
    return (await poseidon2Hash(fields)).toString()
  }

  it("passes when the expected hash matches the supplied vk fields", async () => {
    expect(await checkVkeyHash({ vkBuffer, expected: await hashOf(vkBuffer) })).toEqual([])
  })

  it("keeps the committed zkJWT vk and both core pins in sync", async () => {
    const committedVk = readFileSync(new URL("../circuits/zkJWT/target/vk/vk", import.meta.url))

    expect(
      await checkVkeyHash({
        vkBuffer: committedVk,
        expected: ZKJWT_VKEY_HASH,
        vkBase64: ZKJWT_VK_BASE64,
      }),
    ).toEqual([])
  })

  it("reports Check D drift when the constant no longer matches the vk", async () => {
    // A different field set (extra zero field) → a different, still-well-formed hash.
    const staleHash = await hashOf(Buffer.concat([vkBuffer, Buffer.alloc(32)]))
    const drifts = await checkVkeyHash({ vkBuffer, expected: staleHash })
    expect(drifts).toHaveLength(1)
    expect(drifts[0].check).toBe("D")
    expect(drifts[0].message).toContain("ZKJWT_VKEY_HASH")
    expect(drifts[0].fix).toContain("recompile:paylinks")
  })

  it("throws on a malformed vk (empty or not a 32-byte multiple), never an inequality", async () => {
    await expect(checkVkeyHash({ vkBuffer: Buffer.alloc(0), expected: TOKEN })).rejects.toThrow(
      DriftError,
    )
    await expect(checkVkeyHash({ vkBuffer: Buffer.alloc(33), expected: TOKEN })).rejects.toThrow(
      DriftError,
    )
  })

  it("throws when the expected constant is malformed (not 64-nibble hex)", async () => {
    await expect(checkVkeyHash({ vkBuffer, expected: "0x1" })).rejects.toThrow(DriftError)
  })
})
