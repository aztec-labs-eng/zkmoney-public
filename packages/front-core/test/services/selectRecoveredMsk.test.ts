import { describe, expect, it, vi } from "vitest"
import type { RecoverPasskeyResult } from "@obsidion/sdk"
import {
  StoredAddressMismatchError,
  selectRecoveredMsk,
} from "../../src/core/services/selectRecoveredMsk"

// Sentinel "MSK" candidates — selectRecoveredMsk never calls Fr methods; it
// returns the chosen candidate and hands each to `deriveAddress`.
const mskFirst = { tag: "first-msk" } as never
const mskSecond = { tag: "second-msk" } as never

function result(partial: Partial<RecoverPasskeyResult>): RecoverPasskeyResult {
  return {
    authProvider: {} as never,
    credentialId: "cred",
    pubkey: "pub",
    candidates: {},
    preferredSlot: "first",
    hasPersistedSlot: false,
    candidateSource: "webauthn",
    ...partial,
  } as RecoverPasskeyResult
}

describe("selectRecoveredMsk (R10 verify-before-commit)", () => {
  it("test source: commits the single minted candidate WITHOUT an address check", async () => {
    const derive = vi.fn()
    const chosen = await selectRecoveredMsk(
      result({
        candidateSource: "test",
        candidates: { first: mskFirst },
        expectedAddress: undefined,
      }),
      derive,
    )
    expect(chosen).toBe(mskFirst)
    expect(derive).not.toHaveBeenCalled()
  })

  it("webauthn: commits the preferred-slot candidate when its address matches", async () => {
    const derive = vi.fn(async (m: never) => (m === mskSecond ? "0xACCT" : "0xother"))
    const chosen = await selectRecoveredMsk(
      result({
        preferredSlot: "second",
        candidates: { first: mskFirst, second: mskSecond },
        expectedAddress: "0xacct",
      }),
      derive,
    )
    expect(chosen).toBe(mskSecond)
  })

  it("webauthn: falls back to the OTHER slot when the preferred address mismatches (GPM lost-slot)", async () => {
    // preferred "first" mismatches; "second" matches → must fall back.
    const derive = vi.fn(async (m: never) => (m === mskSecond ? "0xacct" : "0xwrong"))
    const chosen = await selectRecoveredMsk(
      result({
        preferredSlot: "first",
        candidates: { first: mskFirst, second: mskSecond },
        expectedAddress: "0xacct",
      }),
      derive,
    )
    expect(chosen).toBe(mskSecond)
  })

  it("webauthn: FAILS CLOSED when no candidate matches the stored address", async () => {
    const derive = vi.fn(async () => "0xnope")
    await expect(
      selectRecoveredMsk(
        result({ candidates: { first: mskFirst, second: mskSecond }, expectedAddress: "0xacct" }),
        derive,
      ),
    ).rejects.toThrow(StoredAddressMismatchError)
  })

  it("a derivation that rejects keeps its own error, not the mismatch", async () => {
    const derive = vi.fn(async () => {
      throw new Error("node down")
    })
    const attempt = selectRecoveredMsk(
      result({ candidates: { first: mskFirst }, expectedAddress: "0xacct" }),
      derive,
    )
    await expect(attempt).rejects.toThrow(/node down/)
    await expect(attempt).rejects.not.toBeInstanceOf(StoredAddressMismatchError)
  })

  it("webauthn: FAILS CLOSED when expectedAddress is absent (record not yet synced)", async () => {
    const derive = vi.fn()
    await expect(
      selectRecoveredMsk(
        result({ candidates: { first: mskFirst }, expectedAddress: undefined }),
        derive,
      ),
    ).rejects.toThrow(/no stored account address/i)
    expect(derive).not.toHaveBeenCalled()
  })

  it("webauthn: requires an address match even when only ONE slot came back (not count-based)", async () => {
    const derive = vi.fn(async () => "0xnope")
    await expect(
      selectRecoveredMsk(
        result({ candidates: { first: mskFirst }, expectedAddress: "0xacct" }),
        derive,
      ),
    ).rejects.toThrow(/does not match the stored account address/i)
  })

  it("address comparison is canonical / case-insensitive", async () => {
    const derive = vi.fn(async () => "0xABCDEF")
    const chosen = await selectRecoveredMsk(
      result({ candidates: { first: mskFirst }, expectedAddress: "0xabcdef" }),
      derive,
    )
    expect(chosen).toBe(mskFirst)
  })

  it("security-key no-anchor: commits the preferred-slot candidate WITHOUT an address when no record exists", async () => {
    // A hardware key has a single deterministic slot, so "open the wallet this
    // key roots" is safe — no wrong-slot ambiguity. (The orchestrator guards
    // this against overwriting an existing wallet.)
    const derive = vi.fn()
    const chosen = await selectRecoveredMsk(
      result({
        authenticatorType: "security-key",
        candidates: { first: mskFirst },
        expectedAddress: undefined,
      }),
      derive,
    )
    expect(chosen).toBe(mskFirst)
    expect(derive).not.toHaveBeenCalled()
  })

  it("security-key WITH an address still requires the match (mandatory when anchored)", async () => {
    const derive = vi.fn(async () => "0xnope")
    await expect(
      selectRecoveredMsk(
        result({
          authenticatorType: "security-key",
          candidates: { first: mskFirst },
          expectedAddress: "0xacct",
        }),
        derive,
      ),
    ).rejects.toThrow(/does not match the stored account address/i)
  })
})
