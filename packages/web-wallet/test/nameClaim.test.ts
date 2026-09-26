import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Hex } from "viem"
import { AccountServiceError, NameClaimStore, type NameClaimRecord } from "@obsidion/front-core"
import { webStorage } from "../src/platform/storage/WebStorageAdapter"
import { CLAIM_WAIT_NOTICE, requireNameClaim } from "../src/features/onboarding/nameClaim"
import {
  loadRegistrationTerms,
  saveRegistrationTerms,
} from "../src/features/onboarding/registrationTerms"

const mocks = vi.hoisted(() => ({ signDomain: vi.fn() }))

vi.mock("../src/features/onboarding/oxideOnboarding", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  accountServiceFor: () => ({ signDomain: mocks.signDomain }),
}))
vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getConfig: () => ({}),
}))

const RECORD = {
  account: "0x00000000000000000000000000000000000000aa",
  tag: "alice",
  nameHash: `0x${"77".repeat(32)}` as Hex,
  l2Address: `0x${"cd".repeat(32)}` as Hex,
}

const KEYS = { secretKey: {} as never }

function cachedClaim(overrides: Partial<NameClaimRecord> = {}): NameClaimRecord {
  return {
    address: RECORD.l2Address,
    handle: "alice",
    nameHash: RECORD.nameHash,
    signature: "0xcafe",
    nonce: "1",
    deadline: String(Math.floor(Date.now() / 1000) + 3600),
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.clear()
  NameClaimStore.resetForTests()
  NameClaimStore.get(webStorage)
  mocks.signDomain.mockReset()
})

describe("requireNameClaim", () => {
  it("keeps the reservation the screen shows in step with a re-issued claim", async () => {
    saveRegistrationTerms({
      account: RECORD.account,
      tag: "alice",
      deadline: 1,
      fee: "1",
      minDeposit: "4",
      feeWaived: true,
      depositAmount: "5",
    })
    const deadline = String(Math.floor(Date.now() / 1000) + 3600)
    mocks.signDomain.mockResolvedValue({
      signature: "0xbeef",
      nonce: "2",
      deadline,
      terms: { fee: "1", minDeposit: "4", nonce: "2", deadline, signature: "0xcd", reduced: true },
    })
    await requireNameClaim({ ...RECORD, fee: "1" }, KEYS)
    expect(loadRegistrationTerms(RECORD.account, "alice")).toMatchObject({
      deadline: Number(deadline),
      fee: "1",
      feeWaived: true,
      depositAmount: "5",
    })
  })

  it("leaves the stored terms alone when the re-issued quote prices another fee", async () => {
    saveRegistrationTerms({ account: RECORD.account, tag: "alice", deadline: 1, feeWaived: false })
    mocks.signDomain.mockResolvedValue({
      signature: "0xbeef",
      nonce: "2",
      deadline: "9999999999",
      terms: { fee: "2", minDeposit: "4", nonce: "2", deadline: "9999999999", signature: "0xcd" },
    })
    await requireNameClaim({ ...RECORD, fee: "1" }, KEYS)
    expect(loadRegistrationTerms(RECORD.account, "alice")?.deadline).toBe(1)
  })

  it("keeps the signed schedule when the re-issued claim carries none", async () => {
    saveRegistrationTerms({
      account: RECORD.account,
      tag: "alice",
      deadline: 1,
      fee: "1",
      minDeposit: "4",
      feeWaived: true,
      depositAmount: "5",
    })
    const deadline = String(Math.floor(Date.now() / 1000) + 3600)
    mocks.signDomain.mockResolvedValue({ signature: "0xbeef", nonce: "2", deadline })
    await requireNameClaim({ ...RECORD, fee: "1" }, KEYS)
    // A claim with no terms is not evidence the earlier ones were wrong; only the deadline moves.
    expect(loadRegistrationTerms(RECORD.account, "alice")).toMatchObject({
      deadline: Number(deadline),
      fee: "1",
      minDeposit: "4",
      feeWaived: true,
      depositAmount: "5",
    })
  })

  it("returns a live matching cached claim without touching the server", async () => {
    await NameClaimStore.get().put(cachedClaim())
    const claim = await requireNameClaim(RECORD, KEYS)
    expect(claim.signature).toBe("0xcafe")
    expect(mocks.signDomain).not.toHaveBeenCalled()
  })

  it("treats a cached claim with no schedule as a miss for a record with a committed fee", async () => {
    await NameClaimStore.get().put(cachedClaim())
    mocks.signDomain.mockResolvedValue({
      signature: "0xbeef",
      nonce: "2",
      deadline: "9999999999",
      terms: { fee: "1", minDeposit: "4", nonce: "2", deadline: "9999999999", signature: "0xcd" },
    })
    // The cached claim prices nothing, and the controller prices another fee, so it cannot
    // register an address committed to this one.
    const claim = await requireNameClaim({ ...RECORD, fee: "1" }, KEYS, { controllerFee: 9n })
    expect(claim.terms?.fee).toBe("1")
    expect(mocks.signDomain).toHaveBeenCalledTimes(1)
  })

  it("does not reuse the old quote for a replacement address with a different committed fee", async () => {
    await NameClaimStore.get().put(
      cachedClaim({
        terms: {
          fee: "10",
          minDeposit: "5",
          nonce: "1",
          deadline: "9999999999",
          signature: "0xab",
        },
      }),
    )
    mocks.signDomain.mockResolvedValue({
      signature: "0xbeef",
      nonce: "2",
      deadline: "9999999999",
      terms: { fee: "1", minDeposit: "4", nonce: "2", deadline: "9999999999", signature: "0xcd" },
    })
    expect((await requireNameClaim({ ...RECORD, fee: "1" }, KEYS)).terms?.fee).toBe("1")
    expect(mocks.signDomain).toHaveBeenCalledTimes(1)
  })

  it("re-requests on a cache miss and re-caches the replayed claim", async () => {
    mocks.signDomain.mockResolvedValue({
      signature: "0xbeef",
      nonce: "2",
      deadline: String(Math.floor(Date.now() / 1000) + 3600),
      terms: { fee: "5", minDeposit: "10", nonce: "3", deadline: "9", signature: "0xdd" },
    })
    const claim = await requireNameClaim(RECORD, KEYS)
    expect(mocks.signDomain).toHaveBeenCalledWith({
      nameHash: RECORD.nameHash,
      userAddress: RECORD.account,
    })
    expect(claim.signature).toBe("0xbeef")
    expect(claim.terms?.fee).toBe("5")
    expect((await NameClaimStore.get().get(RECORD.l2Address))?.signature).toBe("0xbeef")
  })

  it("re-requests past an expired or mismatched cached claim", async () => {
    mocks.signDomain.mockResolvedValue({ signature: "0xbeef", nonce: "2", deadline: "9999999999" })
    await NameClaimStore.get().put(cachedClaim({ deadline: "1" }))
    expect((await requireNameClaim(RECORD, KEYS)).signature).toBe("0xbeef")
    await NameClaimStore.get().put(cachedClaim({ nameHash: `0x${"88".repeat(32)}` }))
    expect((await requireNameClaim(RECORD, KEYS)).signature).toBe("0xbeef")
  })

  it("surfaces the server's refusal behind a stable message", async () => {
    mocks.signDomain.mockRejectedValue(new Error("a still-live NameClaim binds this device/name"))
    await expect(requireNameClaim(RECORD, KEYS)).rejects.toThrow(
      "Couldn't refresh the reservation for this name: a still-live NameClaim binds this device/name",
    )
  })
})

/** A terms-less claim: the controller's own fee is the only thing that can price one. */
describe("requireNameClaim against a terms-less cache", () => {
  const OFFLINE = new Error("connection refused")
  const withTerms = (fee: string) => ({
    terms: { fee, minDeposit: "4", nonce: "1", deadline: "9999999999", signature: "0xab" },
  })
  const priced = (fee: string) => ({
    signature: "0xbeef",
    nonce: "2",
    deadline: "9999999999",
    ...withTerms(fee),
  })

  it("sweeps the committed fee off the controller's own fee, with no request", async () => {
    await NameClaimStore.get().put(cachedClaim())

    const claim = await requireNameClaim({ ...RECORD, fee: "1" }, KEYS, { controllerFee: 1n })

    expect(claim.signature).toBe("0xcafe")
    expect(mocks.signDomain).not.toHaveBeenCalled()
  })

  it("re-signs when the controller prices another fee, and caches what lands", async () => {
    await NameClaimStore.get().put(cachedClaim())
    mocks.signDomain.mockResolvedValue(priced("1"))

    const claim = await requireNameClaim({ ...RECORD, fee: "1" }, KEYS, { controllerFee: 9n })

    expect(claim.signature).toBe("0xbeef")
    expect(claim.terms?.fee).toBe("1")
    expect((await NameClaimStore.get().get(RECORD.l2Address))?.signature).toBe("0xbeef")
  })

  it("throws when that re-sign fails: the cache prices nothing either", async () => {
    await NameClaimStore.get().put(cachedClaim())
    mocks.signDomain.mockRejectedValue(OFFLINE)

    await expect(
      requireNameClaim({ ...RECORD, fee: "1" }, KEYS, { controllerFee: 9n }),
    ).rejects.toMatchObject({ cause: OFFLINE })
  })

  it("re-signs while the controller's fee is unread", async () => {
    await NameClaimStore.get().put(cachedClaim())
    mocks.signDomain.mockResolvedValue(priced("1"))

    expect((await requireNameClaim({ ...RECORD, fee: "1" }, KEYS)).signature).toBe("0xbeef")
    expect(mocks.signDomain).toHaveBeenCalledTimes(1)
  })

  it("serves a cache priced at the record's fee without a request", async () => {
    await NameClaimStore.get().put(cachedClaim(withTerms("1")))
    expect((await requireNameClaim({ ...RECORD, fee: "1" }, KEYS)).signature).toBe("0xcafe")
    expect(mocks.signDomain).not.toHaveBeenCalled()
  })

  it("does not fall back to a cache priced at another fee", async () => {
    await NameClaimStore.get().put(cachedClaim(withTerms("10")))
    mocks.signDomain.mockRejectedValue(OFFLINE)

    await expect(requireNameClaim({ ...RECORD, fee: "1" }, KEYS)).rejects.toMatchObject({
      cause: OFFLINE,
    })
  })

  it("does not serve an expired cache the controller's fee would price", async () => {
    await NameClaimStore.get().put(cachedClaim({ deadline: "1" }))
    mocks.signDomain.mockRejectedValue(OFFLINE)

    await expect(
      requireNameClaim({ ...RECORD, fee: "1" }, KEYS, { controllerFee: 1n }),
    ).rejects.toMatchObject({ cause: OFFLINE })
  })
})

/** The three 409s the service classes wait-and-retry, against everything else it can refuse with. */
describe("requireNameClaim refusal handling", () => {
  const refusal = (status: number, reason: string) =>
    new AccountServiceError(status, "refused", { error: "refused", reason })

  const CLAIM = {
    signature: "0xbeef",
    nonce: "2",
    deadline: String(Math.floor(Date.now() / 1000) + 3600),
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("waits out a claim_conflict, telling the caller it is waiting, and caches what lands", async () => {
    mocks.signDomain
      .mockRejectedValueOnce(refusal(409, "claim_conflict"))
      .mockResolvedValueOnce(CLAIM)
    const onNotice = vi.fn()

    const pending = requireNameClaim(RECORD, KEYS, { onNotice })
    await vi.advanceTimersByTimeAsync(1_000)

    expect((await pending).signature).toBe("0xbeef")
    expect(mocks.signDomain).toHaveBeenCalledTimes(2)
    expect(onNotice.mock.calls).toEqual([[CLAIM_WAIT_NOTICE]])
    expect((await NameClaimStore.get().get(RECORD.l2Address))?.signature).toBe("0xbeef")
  })

  it("fails fast on a terminal refusal, with no wait and no second request", async () => {
    mocks.signDomain.mockRejectedValue(refusal(409, "name_reserved"))
    const onNotice = vi.fn()

    await expect(requireNameClaim(RECORD, KEYS, { onNotice })).rejects.toThrow(
      "Couldn't refresh the reservation for this name: refused",
    )
    expect(mocks.signDomain).toHaveBeenCalledTimes(1)
    expect(onNotice).not.toHaveBeenCalled()
  })

  it("blames the hold, not the name, once the wait runs out", async () => {
    mocks.signDomain.mockRejectedValue(refusal(409, "claim_conflict"))

    const pending = requireNameClaim(RECORD, KEYS).then(
      () => {
        throw new Error("expected the refusal to outlast the wait")
      },
      (e: Error) => e,
    )
    await vi.advanceTimersByTimeAsync(60_000)
    const err = await pending

    expect(err.message).toMatch(/reserved to another address on this device/)
    expect(err.message).toMatch(/clears by itself/)
    expect(err.message).not.toMatch(/taken|reserved by another user/)
  })
})
