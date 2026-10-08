/**
 * The last check before a transfer, over a real front-core store: under `proceed` only a fee change, known capacity
 * that cannot take the deposit, or a deployment capacity cannot be read for stops it; under `hold` only a fresh fit
 * lets it through.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createPortalCapacityStore,
  type PortalCapacityStore,
  type RequiredCredit,
} from "@obsidion/front-core"
import { PortalCapacityUnsupportedError, type PortalCapacitySnapshot } from "@obsidion/sdk"
import {
  FundingPreflightError,
  runFundingPreflight,
  PROCEED_READ_WAIT_MS,
} from "../src/features/deposit/fundingPreflight"
import { RECHECK_BUDGET_MS } from "../src/platform/desktopBridge"

const DAI = 10n ** 18n
const KEY = {
  chainId: 1,
  portal: "0x1111111111111111111111111111111111111111",
  token: "0x2222222222222222222222222222222222222222",
} as const
const UNKNOWN: RequiredCredit = { status: "unknown" }
const known = (whole: bigint): RequiredCredit => ({
  status: "known",
  atomic: whole * DAI,
  token: KEY.token,
  decimals: 18,
})

type Read = () => Promise<PortalCapacitySnapshot>
const snapshot = (availableAtomic: bigint, blockAgeS = 0): PortalCapacitySnapshot => ({
  ...KEY,
  decimals: 18,
  blockNumber: 1n,
  blockTimestamp: BigInt(Math.floor(Date.now() / 1000) - blockAgeS),
  rateAtomicPerSecond: DAI,
  globalLimitAtomic: 50_000n * DAI,
  availableAtomic,
})
const storeWith = (read: Read): PortalCapacityStore =>
  createPortalCapacityStore(KEY, {
    read,
    visibility: { isVisible: () => true, onResume: () => () => {} },
  })
const available = (atomic: bigint) => storeWith(async () => snapshot(atomic))

const refusal = (promise: Promise<void>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  )

afterEach(() => {
  vi.useRealTimers()
})

describe("runFundingPreflight under proceed", () => {
  const proceed = (store: PortalCapacityStore | undefined, required: RequiredCredit) =>
    runFundingPreflight({
      store,
      required,
      unknownCapacity: "proceed",
      shownFee: "0.5",
      freshFee: "0.5",
    })

  it("lets a conversion credit through a full or a low, nonzero bucket", async () => {
    await expect(proceed(available(50_000n * DAI), UNKNOWN)).resolves.toBeUndefined()
    await expect(proceed(available(1n), UNKNOWN)).resolves.toBeUndefined()
  })

  it("lets the deposit through when the bucket is not known", async () => {
    await expect(proceed(undefined, UNKNOWN)).resolves.toBeUndefined()
  })

  it("lets the deposit through when the read fails or is out of date", async () => {
    const failing = storeWith(async () => {
      throw new Error("rpc down")
    })
    await expect(proceed(failing, known(10n))).resolves.toBeUndefined()
    // An hour-old block by this device's clock: the head is not current, so the empty bucket proves nothing.
    const old = storeWith(async () => snapshot(0n, 3_600))
    await expect(proceed(old, known(10n))).resolves.toBeUndefined()
  })

  it("stops waiting for a read that does not answer, and lets the deposit through", async () => {
    vi.useFakeTimers()
    const hung = storeWith(() => new Promise(() => {}))
    let settled = false
    const check = proceed(hung, known(10n)).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(PROCEED_READ_WAIT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await check
    expect(settled).toBe(true)
  })

  /** Each read waits until the test settles `pending[i]`. */
  const controlled = () => {
    const pending: {
      resolve: (s: PortalCapacitySnapshot) => void
      reject: (e: unknown) => void
    }[] = []
    const store = storeWith(
      () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    )
    return { store, pending }
  }

  describe("when its own read fails after another read answered", () => {
    it.each([
      ["a known shortfall", known(10n), "exceeds-available"],
      ["an empty bucket and a conversion credit", UNKNOWN, "amount-unknown"],
    ] as const)("stops on %s that is still current", async (_case, required, kind) => {
      const { store, pending } = controlled()
      void store.refresh()
      const check = refusal(proceed(store, required))
      pending[0]!.resolve(snapshot(0n))
      await Promise.resolve()
      pending[1]!.reject(new Error("rpc down"))
      expect(await check).toMatchObject({ reason: "capacity", eligibility: { kind } })
      expect(store.getState()).toMatchObject({ status: "unavailable", lastWasFresh: true })
    })

    it("lets the deposit through after a fit, or after a shortfall whose head was not current", async () => {
      for (const answer of [snapshot(50_000n * DAI), snapshot(0n, 3_600)]) {
        const { store, pending } = controlled()
        void store.refresh()
        const check = proceed(store, known(10n))
        pending[0]!.resolve(answer)
        await Promise.resolve()
        pending[1]!.reject(new Error("rpc down"))
        await expect(check).resolves.toBeUndefined()
        expect(store.getState()).toMatchObject({ status: "unavailable", lastSnapshot: answer })
      }
    })

    it("lets the deposit through once that shortfall is no longer current", async () => {
      vi.useFakeTimers()
      const { store, pending } = controlled()
      const first = store.refresh()
      pending[0]!.resolve(snapshot(0n))
      await first
      await vi.advanceTimersByTimeAsync(store.policy.staleAfterMs)
      const check = proceed(store, known(10n))
      pending[1]!.reject(new Error("rpc down"))
      await expect(check).resolves.toBeUndefined()
    })
  })

  describe("when its own read does not answer in time", () => {
    it("stops on a current shortfall that another read published meanwhile", async () => {
      vi.useFakeTimers()
      const { store, pending } = controlled()
      void store.refresh()
      const check = refusal(proceed(store, known(10n)))
      await vi.advanceTimersByTimeAsync(1_000)
      pending[0]!.resolve(snapshot(0n))
      await vi.advanceTimersByTimeAsync(PROCEED_READ_WAIT_MS)
      expect(pending).toHaveLength(2)
      expect(await check).toMatchObject({
        reason: "capacity",
        eligibility: { kind: "exceeds-available" },
      })
    })

    it("stops on a mismatch that another read published meanwhile", async () => {
      vi.useFakeTimers()
      const { store, pending } = controlled()
      void store.refresh()
      const check = refusal(proceed(store, UNKNOWN))
      pending[0]!.reject(
        new PortalCapacityUnsupportedError("chain-mismatch", "RPC serves chain 5, not 1"),
      )
      await vi.advanceTimersByTimeAsync(PROCEED_READ_WAIT_MS)
      expect(await check).toMatchObject({
        reason: "capacity",
        eligibility: { kind: "unsupported" },
      })
    })

    it("lets the deposit through on a shortfall that is no longer current", async () => {
      vi.useFakeTimers()
      const { store, pending } = controlled()
      const first = store.refresh()
      pending[0]!.resolve(snapshot(0n))
      await first
      await vi.advanceTimersByTimeAsync(store.policy.staleAfterMs)
      const check = proceed(store, known(10n))
      await vi.advanceTimersByTimeAsync(PROCEED_READ_WAIT_MS)
      await expect(check).resolves.toBeUndefined()
    })
  })

  it("lets the deposit through when the portal has no capacity getters", async () => {
    const noGetters = storeWith(async () => {
      throw new PortalCapacityUnsupportedError("no-capacity-getters", "portal returned no data")
    })
    await expect(proceed(noGetters, known(10n))).resolves.toBeUndefined()
    await expect(proceed(noGetters, UNKNOWN)).resolves.toBeUndefined()
  })

  it("gives up well inside the desktop helper's recheck budget", () => {
    expect(PROCEED_READ_WAIT_MS).toBeLessThan(RECHECK_BUDGET_MS)
  })

  it.each([
    ["a known shortfall", available(500n * DAI), known(2_000n), "exceeds-available"],
    ["an empty bucket and a conversion credit", available(0n), UNKNOWN, "amount-unknown"],
    ["an empty bucket and a known credit", available(0n), known(10n), "exceeds-available"],
  ] as const)("stops %s", async (_case, store, required, kind) => {
    const error = await refusal(proceed(store, required))
    expect(error).toBeInstanceOf(FundingPreflightError)
    expect(error).toMatchObject({ reason: "capacity", eligibility: { kind } })
  })

  it("stops an amount above the per-operation cap, even when the read fails", async () => {
    const failing = storeWith(async () => {
      throw new Error("rpc down")
    })
    for (const store of [available(50_000n * DAI), failing]) {
      const error = await refusal(proceed(store, known(3_000n)))
      expect(error).toMatchObject({
        reason: "capacity",
        eligibility: { kind: "exceeds-operation-cap" },
      })
    }
  })

  it("stops a node that follows another chain, but not a node that has not synced", async () => {
    const withReference = (l1ChainId: number, synced = true) =>
      createPortalCapacityStore(KEY, {
        read: async () => snapshot(50_000n * DAI),
        reference: async () => ({
          l1ChainId,
          l1Timestamp: synced ? BigInt(Math.floor(Date.now() / 1000)) : undefined,
        }),
        visibility: { isVisible: () => true, onResume: () => () => {} },
      })
    const error = await refusal(proceed(withReference(11155111), UNKNOWN))
    expect(error).toMatchObject({ reason: "capacity", eligibility: { kind: "unavailable" } })
    await expect(proceed(withReference(KEY.chainId, false), UNKNOWN)).resolves.toBeUndefined()
    await expect(proceed(withReference(KEY.chainId), UNKNOWN)).resolves.toBeUndefined()
  })

  it("stops a chain mismatch", async () => {
    const wrongChain = storeWith(async () => {
      throw new PortalCapacityUnsupportedError("chain-mismatch", "RPC serves chain 5, not 1")
    })
    const error = await refusal(proceed(wrongChain, UNKNOWN))
    expect(error).toMatchObject({ reason: "capacity", eligibility: { kind: "unsupported" } })
  })

  it("stops a changed fee before reading capacity", async () => {
    const read = vi.fn(async () => snapshot(50_000n * DAI))
    const error = await refusal(
      runFundingPreflight({
        store: storeWith(read),
        required: UNKNOWN,
        unknownCapacity: "proceed",
        shownFee: "0.5",
        freshFee: "0.6",
      }),
    )
    expect(error).toMatchObject({ reason: "quote-changed" })
    expect(read).not.toHaveBeenCalled()
  })
})

describe("runFundingPreflight under hold", () => {
  it("needs a fresh fit", async () => {
    await expect(
      runFundingPreflight({ store: available(500n * DAI), required: known(10n) }),
    ).resolves.toBeUndefined()
    for (const [store, required] of [
      [available(50_000n * DAI), UNKNOWN],
      [undefined, known(10n)],
      [
        storeWith(async () => {
          throw new Error("rpc down")
        }),
        known(10n),
      ],
    ] as const) {
      const error = await refusal(runFundingPreflight({ store, required }))
      expect(error).toMatchObject({ reason: "capacity" })
    }
  })
})
