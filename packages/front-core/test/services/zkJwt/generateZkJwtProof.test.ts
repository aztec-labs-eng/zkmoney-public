import { beforeEach, describe, expect, it, vi } from "vitest"
import { generateZkJwtProof } from "../../../src/core/services/zkJwt/generateZkJwtProof"

const prepare = vi.hoisted(() => vi.fn())
vi.mock("@obsidion/sdk", () => ({
  PublicKeyRegistry: class {},
  prepareJwtFromProvider: (...args: unknown[]) => prepare(...args),
}))
const publicInputs = ["0x01", "0x02", "0x03", "0x04", "0x05", "0x06", "0x07"]

beforeEach(() => prepare.mockResolvedValue({ input: {}, jwk_id: "key", email: "a@example.com" }))

describe("storage-free zkJWT generation", () => {
  it("returns the proof and metadata without a cache or account", async () => {
    const prover = {
      prove: vi.fn().mockResolvedValue({ proof: ["proof"], vkey: ["key"], publicInputs }),
    }
    const result = await generateZkJwtProof(prover, "jwt", "google", 2n, "0x01")
    expect(prover.prove).toHaveBeenCalledWith({}, "0x01")
    expect(result.publicInputs).toEqual(publicInputs)
    expect(result.metadata).toMatchObject({ callerAddress: "0x01", email: "a@example.com" })
  })

  it("rejects malformed public inputs and propagates proving failures", async () => {
    await expect(
      generateZkJwtProof(
        { prove: vi.fn().mockResolvedValue({ publicInputs: [] }) },
        "jwt",
        "google",
        2n,
        "0x01",
      ),
    ).rejects.toThrow(/public inputs/)
    await expect(
      generateZkJwtProof(
        { prove: vi.fn().mockRejectedValue(new Error("failed")) },
        "jwt",
        "google",
        2n,
        "0x01",
      ),
    ).rejects.toThrow("failed")
  })
})
