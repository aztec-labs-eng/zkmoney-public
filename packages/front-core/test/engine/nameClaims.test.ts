import { describe, expect, it } from "vitest"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend, type MemoryBackend } from "../../src/engine/memoryBackend"
import {
  LEGACY_NAME_CLAIMS_KEY,
  createNameClaims,
  type NameClaimRecord,
} from "../../src/engine/nameClaims"

const NS = "obsidion.ns."
const PENDING = "0x00000000000000000000000000000000000000000000000000000000000000A1"
const CONFIRMED = "0x00000000000000000000000000000000000000000000000000000000000000b2"

const claim = (address: string, over: Partial<NameClaimRecord> = {}): NameClaimRecord => ({
  address,
  handle: "alice",
  signature: "0xsig",
  nonce: "1",
  deadline: "2",
  ...over,
})
const TERMS = { fee: "1", minDeposit: "2", nonce: "3", deadline: "4", signature: "0xterms" }

function open(backend: MemoryBackend) {
  return createNameClaims({ db: openDatabase(backend).scoped(NS) })
}

describe("createNameClaims", () => {
  it("carries an older build's pending claims and leaves the confirmed ones to the log", async () => {
    const backend = memoryBackend()
    const pending = claim(PENDING, { terms: TERMS })
    backend.entries.set(
      NS + LEGACY_NAME_CLAIMS_KEY,
      JSON.stringify({
        [PENDING.toLowerCase()]: pending,
        [CONFIRMED.toLowerCase()]: claim(CONFIRMED),
      }),
    )
    const claims = open(backend)
    await claims.ready

    expect(await claims.get(PENDING)).toEqual(pending)
    expect(await claims.get(CONFIRMED)).toBeUndefined()
  })

  it.each([
    ["a blob that does not parse", "{not json"],
    ["a blob that is not a claim map", JSON.stringify([claim(PENDING)])],
    ["a claim that is not one", JSON.stringify({ a: { address: PENDING } })],
    [
      "a pending claim with unreadable terms",
      JSON.stringify({ a: claim(PENDING, { terms: { fee: 1 } as never }) }),
    ],
  ])("fails the open over %s and keeps its bytes", async (_, blob) => {
    const backend = memoryBackend()
    backend.entries.set(NS + LEGACY_NAME_CLAIMS_KEY, blob)
    const claims = open(backend)

    await expect(claims.ready).rejects.toMatchObject({ code: "unknown" })
    expect(backend.entries.get(NS + LEGACY_NAME_CLAIMS_KEY)).toBe(blob)
  })

  it("keeps one claim per account, whatever the address's case", async () => {
    const claims = open(memoryBackend())
    await claims.ready

    await claims.put(claim(PENDING))
    await claims.put(claim(PENDING.toLowerCase(), { signature: "0xnew" }))
    expect((await claims.get(PENDING))?.signature).toBe("0xnew")
  })
})
