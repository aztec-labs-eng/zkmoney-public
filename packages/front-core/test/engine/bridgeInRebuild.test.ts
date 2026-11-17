/**
 * A deposit a bridge funded outside this device's bridge-in sheet has no bridge-in record. The
 * rebuild reads its funding transaction for a bridge fill, rebuilds the bridge-in from the fill,
 * stamps what it found on the deposit, and asks the bridge for the fill's origin call.
 */
import { createPace } from "@obsidion/core/cadence"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"
import type {
  BridgeFill,
  BridgeInDeposit,
  BridgeInRecord,
} from "../../src/core/services/crossChain/types"
import {
  bridgeInRebuild,
  FILL_LOOKUP_GRACE_MS,
  FILL_LOOKUP_WAIT_MS,
  FUNDING_READS_PER_PASS,
  readFunding,
  type BridgeInRebuildDeps,
} from "../../src/engine/bridgeInRebuild"
import { createBridgeIns } from "../../src/engine/bridgeIns"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import type { RecordSet } from "../../src/engine/persistentStore"
import { startRuntime, type Runtime } from "../../src/engine/runtime"
import { sipaDepositTransition, type SipaDeposit } from "../../src/engine/sipaDeposits"
import { memoryStore } from "../../src/engine/store"

const ADDRESS = `0x${"d1".repeat(20)}` as Address
const FUNDING = `0x${"f1".repeat(32)}` as Hex
const ORIGIN = `0x${"0a".repeat(32)}` as Hex
const USDC = `0x${"c0".repeat(20)}` as Address
const RELAYER = `0x${"ee".repeat(20)}` as Address
const DEPOSITOR = `0x${"a1".repeat(20)}` as Address
const E18 = 10n ** 18n
const L1_DAI = `0x${"da".repeat(20)}` as Address
const L1_USDC = `0x${"c1".repeat(20)}` as Address
const UNTIL = 10_000 + FILL_LOOKUP_GRACE_MS

const funded = (over: Partial<SipaDeposit> = {}): SipaDeposit =>
  ({
    sipaAddress: ADDRESS,
    phase: "claimed",
    amount: "20",
    tokenSymbol: "DAI",
    tokenDecimals: 18,
    fundingTokenSymbol: "DAI",
    fundingTxHash: FUNDING,
    fundingFromAddress: RELAYER,
    walletAddress: RELAYER,
    startTime: 9_000,
    ...over,
  } as SipaDeposit)

const FILL: BridgeFill = {
  provider: "across",
  originChainId: 8453,
  depositId: "77",
  depositor: DEPOSITOR,
  inputToken: USDC,
  inputAmount: 20_500_000n,
  deadline: 10_000,
  token: L1_DAI,
  value: 20n * E18,
}

/** The bridge-in the fill alone rebuilds. */
const REBUILT: BridgeInRecord = {
  id: "bridge-in:r1",
  originChainId: 8453,
  depositor: DEPOSITOR,
  recipient: ADDRESS,
  symbol: "USDC",
  inputAmount: "20500000",
  outputAmount: (20n * E18).toString(),
  fee: "500000",
  inputDecimals: 6,
  outputSymbol: "DAI",
  outputDecimals: 18,
  status: "filled",
  fillTxHash: FUNDING,
  startTime: 9_000,
  endTime: 9_000,
  replayed: true,
}

const filled = (fillTxHash: Hex = FUNDING): BridgeInDeposit => ({
  originTxHash: ORIGIN,
  status: { status: "filled", fillTxHash },
})

function harness(deposits: SipaDeposit[] = [funded()], bridge = true) {
  const db = openDatabase(memoryBackend())
  const clock = { now: 0 }
  const across = {
    statusById: vi.fn(async () => filled() as BridgeInDeposit | undefined),
  }
  const store = memoryStore<RecordSet<SipaDeposit>>({
    records: deposits,
    loaded: true,
    failed: false,
  })
  const sipaDeposits: BridgeInRebuildDeps["deposits"] = {
    view: store.readonly,
    async apply(address, event, w) {
      const current = store.get().records.find((d) => d.sipaAddress === address)
      const next = current && sipaDepositTransition(current, event, 0)
      if (!current || !next) return undefined
      const show = () =>
        store.update((s) => ({ ...s, records: s.records.map((d) => (d === current ? next : d)) }))
      // Inside a write, the change shows once the write commits; the put makes it one that does.
      if (!w) show()
      else {
        w.put(`deposit/${address}`, "staged")
        const off = db.onCommit(() => {
          off()
          show()
        })
      }
      return next
    },
  }
  const deps = {
    db,
    deposits: sipaDeposits,
    bridgeIns: createBridgeIns({ db, newId: () => "r1" }),
    fills: {
      fill: vi.fn(async (_hash: Hex, _recipient: Address) => FILL as BridgeFill | undefined),
    },
    provider: (id: BridgeFill["provider"]) => (bridge && id === "across" ? across : undefined),
    origin: { token: vi.fn(async () => ({ symbol: "USDbC", decimals: 6 })) },
    listsChain: (chainId: number) => chainId === 8453,
    listedSymbol: (chainId: number, token: Address) =>
      chainId === 8453 && token === USDC ? "USDC" : undefined,
    landingDecimals: vi.fn(async (token: Address) => ({ [L1_DAI]: 18, [L1_USDC]: 6 }[token]!)),
    now: () => clock.now,
  } satisfies BridgeInRebuildDeps
  const deposit = () => store.get().records[0]
  const bridgeIn = async () => (await deps.bridgeIns.all())[0]
  return { db, deps, across, store, clock, deposit, bridgeIn }
}

describe("the fundingRead transition", () => {
  const fill = { type: "fundingRead", funding: "bridge" } as const

  it("sets funding once and leaves a set one as it is", () => {
    expect(sipaDepositTransition(funded(), fill, 0)).toMatchObject({
      funding: "bridge",
      phase: "claimed",
    })
    expect(
      sipaDepositTransition(funded({ funding: "bridge" }), { ...fill, funding: "plain" }, 0),
    ).toBeUndefined()
  })

  it("drops a wallet that is a fill's relayer, and keeps one the sheet named", () => {
    const read = sipaDepositTransition(funded(), fill, 0)
    expect(read).toMatchObject({ fundingFromAddress: RELAYER })
    expect(read).not.toHaveProperty("walletAddress")
    const sheet = `0x${"5e".repeat(20)}` as Address
    expect(sipaDepositTransition(funded({ walletAddress: sheet }), fill, 0)).toMatchObject({
      walletAddress: sheet,
    })
    expect(
      sipaDepositTransition(funded(), { type: "fundingRead", funding: "plain" }, 0),
    ).toMatchObject({ walletAddress: RELAYER })
  })
})

describe("readFunding", () => {
  it("rebuilds the bridge-in from the fill alone, before the bridge has recorded it", async () => {
    const h = harness()
    h.across.statusById.mockResolvedValue(undefined)
    expect(await readFunding(funded(), h.deps)).toBe("waiting")
    expect(await h.bridgeIn()).toEqual(REBUILT)
    expect(h.deposit()).toMatchObject({
      funding: "bridge",
      fundingLookupUntil: UNTIL,
      fundingFromAddress: RELAYER,
    })
    expect(h.deps.origin.token).toHaveBeenCalledWith(8453, USDC)
  })

  it("waits while the bridge reports the fill pending", async () => {
    const h = harness()
    h.across.statusById.mockResolvedValue({ originTxHash: ORIGIN, status: { status: "pending" } })
    expect(await readFunding(funded(), h.deps)).toBe("waiting")
    expect(await h.bridgeIn()).toEqual(REBUILT)
  })

  it("names the origin call once the bridge has recorded the fill, and asks no more", async () => {
    const h = harness()
    expect(await readFunding(funded(), h.deps)).toBeUndefined()
    expect(await h.bridgeIn()).toEqual({ ...REBUILT, originTxHash: ORIGIN })
    expect(h.across.statusById).toHaveBeenCalledWith(8453, "77")
    expect(h.deposit()).not.toHaveProperty("fundingLookupUntil")
  })

  it("matches the bridge's fill hash without case", async () => {
    const h = harness()
    h.across.statusById.mockResolvedValue(filled(FUNDING.toUpperCase().replace("0X", "0x") as Hex))
    await readFunding(funded(), h.deps)
    expect(await h.bridgeIn()).toMatchObject({ originTxHash: ORIGIN })
  })

  it("keeps the bridge-in without an origin call when the bridge's record disagrees", async () => {
    const refunded: BridgeInDeposit = { originTxHash: ORIGIN, status: { status: "refunded" } }
    for (const found of [filled(`0x${"99".repeat(32)}`), refunded]) {
      const h = harness()
      h.across.statusById.mockResolvedValue(found)
      expect(await readFunding(funded(), h.deps)).toBeUndefined()
      expect(await h.bridgeIn()).toEqual(REBUILT)
      expect(h.deposit()).toMatchObject({ funding: "bridge" })
      expect(h.deposit()).not.toHaveProperty("fundingLookupUntil")
    }
  })

  it("counts a fill in its landing token's decimals, not the swept deposit's", async () => {
    const h = harness()
    h.deps.fills.fill.mockResolvedValue({ ...FILL, token: L1_USDC, value: 20_000_000n })
    await readFunding(funded({ fundingTokenSymbol: "USDC", tokenDecimals: 18 }), h.deps)
    expect(await h.bridgeIn()).toMatchObject({
      outputSymbol: "USDC",
      outputAmount: "20000000",
      outputDecimals: 6,
      fee: "500000",
    })
  })

  it("takes the chain's symbol for a token the profile does not list, and charges no fee below zero", async () => {
    const h = harness()
    h.deps.fills.fill.mockResolvedValue({
      ...FILL,
      inputToken: `0x${"ee".repeat(20)}`,
      value: 21n * E18,
    })
    await readFunding(funded(), h.deps)
    expect(await h.bridgeIn()).toMatchObject({
      symbol: "USDbC",
      fee: "0",
      outputAmount: (21n * E18).toString(),
    })
  })

  it("counts what landed for a fill from a chain the profile does not list, with no read of it", async () => {
    const h = harness()
    h.deps.fills.fill.mockResolvedValue({ ...FILL, originChainId: 10 })
    await readFunding(funded(), h.deps)
    expect(await h.bridgeIn()).toMatchObject({
      originChainId: 10,
      depositor: DEPOSITOR,
      symbol: "DAI",
      inputAmount: (20n * E18).toString(),
      inputDecimals: 18,
      fee: "0",
    })
    expect(h.deps.origin.token).not.toHaveBeenCalled()
  })

  it("stamps a deposit no fill paid as a transfer", async () => {
    const h = harness()
    h.deps.fills.fill.mockResolvedValue(undefined)
    expect(await readFunding(funded(), h.deps)).toBeUndefined()
    expect(h.deposit()).toMatchObject({ funding: "plain", walletAddress: RELAYER })
    expect(await h.deps.bridgeIns.all()).toEqual([])
    expect(h.across.statusById).not.toHaveBeenCalled()
  })

  it("saves nothing while a read the bridge-in needs fails", async () => {
    const down = new Error("rpc down")
    const receipt = harness()
    receipt.deps.fills.fill.mockRejectedValue(down)
    const decimals = harness()
    decimals.deps.landingDecimals.mockRejectedValueOnce(down)
    const token = harness()
    token.deps.origin.token.mockRejectedValue(down)
    for (const h of [receipt, decimals, token]) {
      await expect(readFunding(funded(), h.deps)).rejects.toBe(down)
      expect(h.deposit().funding).toBeUndefined()
      expect(await h.deps.bridgeIns.all()).toEqual([])
    }
  })

  it("saves no bridge-in when the stamp it commits with cannot be written", async () => {
    const h = harness()
    const locked = new Error("store locked")
    h.deps.deposits.apply = async () => Promise.reject(locked)
    await expect(readFunding(funded(), h.deps)).rejects.toBe(locked)
    expect(await h.deps.bridgeIns.all()).toEqual([])
  })

  it("keeps the bridge-in and the stamp while the bridge cannot be asked", async () => {
    const h = harness()
    h.across.statusById.mockRejectedValue(new Error("across down"))
    await expect(readFunding(funded(), h.deps)).rejects.toThrow()
    expect(await h.bridgeIn()).toEqual(REBUILT)
    expect(h.deposit()).toMatchObject({ funding: "bridge", fundingLookupUntil: UNTIL })
  })
})

describe("bridgeInRebuild task", () => {
  const runtimes: Runtime[] = []
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.stop()
  })

  function run(h: Pick<ReturnType<typeof harness>, "db"> & { deps: BridgeInRebuildDeps }) {
    const task = bridgeInRebuild(h.deps)
    const runtime = startRuntime([task], {
      db: h.db,
      milestones: { after: async () => true, reached: () => false },
      visible: memoryStore(true).readonly,
      pace: createPace(),
      now: () => Date.now(),
      sinceLoad: () => performance.now(),
    })
    runtimes.push(runtime)
    return async () => {
      // The task runs once the bridge-ins load.
      await h.deps.bridgeIns.all()
      await runtime.wake(task)
    }
  }

  it("never reads again a deposit a transfer funded", async () => {
    const h = harness()
    h.deps.fills.fill.mockResolvedValue(undefined)
    const wake = run(h)
    await wake()
    await wake()
    expect(h.deps.fills.fill).toHaveBeenCalledTimes(1)
    expect(h.deps.fills.fill).toHaveBeenCalledWith(FUNDING, ADDRESS)
    expect(h.deposit().funding).toBe("plain")
  })

  it("asks the bridge again for a fill it has not recorded, and stops once it has", async () => {
    const h = harness()
    h.across.statusById.mockResolvedValueOnce(undefined)
    const wake = run(h)
    await wake()
    expect(await h.bridgeIn()).toEqual(REBUILT)
    await wake()
    expect(await h.bridgeIn()).toMatchObject({ originTxHash: ORIGIN })
    await wake()
    expect(h.across.statusById).toHaveBeenCalledTimes(2)
  })

  it("asks again after its longer wait while the bridge has not recorded the fill", async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      h.across.statusById.mockResolvedValue(undefined)
      await run(h)()
      expect(h.across.statusById).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(FILL_LOOKUP_WAIT_MS - 1)
      expect(h.across.statusById).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(h.across.statusById).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("ends the asking past the fill's deadline with no read, and never asks again", async () => {
    const h = harness()
    h.across.statusById.mockResolvedValue(undefined)
    const wake = run(h)
    await wake()
    h.clock.now = UNTIL
    await wake()
    await wake()
    expect(h.deps.fills.fill).toHaveBeenCalledTimes(1)
    expect(h.across.statusById).toHaveBeenCalledTimes(1)
    expect(h.deposit()).not.toHaveProperty("fundingLookupUntil")
    expect(await h.bridgeIn()).toEqual(REBUILT)
  })

  it("never asks again a bridge whose record disagreed", async () => {
    const h = harness()
    h.across.statusById.mockResolvedValue(filled(`0x${"99".repeat(32)}`))
    const wake = run(h)
    await wake()
    await wake()
    expect(h.across.statusById).toHaveBeenCalledTimes(1)
  })

  it("asks about a fill with no deadline for an hour from its read", async () => {
    const h = harness()
    h.clock.now = 5_000
    h.deps.fills.fill.mockResolvedValue({ ...FILL, deadline: undefined })
    h.across.statusById.mockResolvedValue(undefined)
    await run(h)()
    expect(h.deposit()).toMatchObject({ fundingLookupUntil: 5_000 + FILL_LOOKUP_GRACE_MS })
    expect(await h.bridgeIn()).toEqual(REBUILT)
  })

  it("rebuilds a fill whose bridge this build cannot ask, and reads it once", async () => {
    const h = harness(undefined, false)
    const wake = run(h)
    await wake()
    await wake()
    expect(h.deps.fills.fill).toHaveBeenCalledTimes(1)
    expect(await h.bridgeIn()).toEqual(REBUILT)
    expect(h.deposit()).not.toHaveProperty("fundingLookupUntil")
  })

  it("reads a bounded number of deposits a pass, newest first, and the rest on the next", async () => {
    const address = (i: number) => `0x${i.toString(16).padStart(40, "0")}` as Address
    const many = Array.from({ length: FUNDING_READS_PER_PASS + 2 }, (_, i) =>
      funded({ sipaAddress: address(i + 1), startTime: i }),
    )
    const h = harness(many)
    h.deps.fills.fill.mockResolvedValue(undefined)
    const wake = run(h)
    await wake()
    expect(h.deps.fills.fill).toHaveBeenCalledTimes(FUNDING_READS_PER_PASS)
    const unread = h.store.get().records.filter((d) => !d.funding)
    expect(unread.map((d) => d.startTime)).toEqual([0, 1])
    await wake()
    expect(h.deps.fills.fill).toHaveBeenCalledTimes(FUNDING_READS_PER_PASS + 2)
    expect(h.store.get().records.every((d) => d.funding === "plain")).toBe(true)
  })

  it("gives older deposits a turn while the newest keep failing", async () => {
    const address = (i: number) => `0x${i.toString(16).padStart(40, "0")}` as Address
    const many = Array.from({ length: FUNDING_READS_PER_PASS + 2 }, (_, i) =>
      funded({ sipaAddress: address(i + 1), startTime: i }),
    )
    const h = harness(many)
    const old = [address(1), address(2)]
    h.deps.fills.fill.mockImplementation(async (_hash, recipient) => {
      if (!old.includes(recipient)) throw new Error("rpc down")
      return undefined
    })
    const wake = run(h)
    await wake()
    expect(h.store.get().records.some((d) => d.funding)).toBe(false)
    await wake()
    const read = h.store.get().records.filter((d) => d.funding === "plain")
    expect(read.map((d) => d.sipaAddress)).toEqual(old)
  })

  it("leaves alone unfunded deposits, ones not plain, and transfers", async () => {
    const deposits = [
      funded({ fundingTxHash: undefined }),
      funded({ intent: "registration" }),
      funded({ direct: { recipientCommitment: "0x01" } }),
      funded({ funding: "plain" }),
    ]
    const h = harness(deposits)
    await run(h)()
    expect(h.deps.fills.fill).not.toHaveBeenCalled()
    expect(h.store.get().records).toEqual(deposits)
    expect(await h.deps.bridgeIns.all()).toEqual([])
  })

  it("stamps nothing where the profile names no bridge to read fills of", async () => {
    const h = harness()
    const deposits = h.store.get().records
    await run({ db: h.db, deps: { ...h.deps, fills: undefined } })()
    expect(h.store.get().records).toEqual(deposits)
    expect(await h.deps.bridgeIns.all()).toEqual([])
  })

  it("stamps a deposit the sheet's bridge-in filled, with no read", async () => {
    const h = harness()
    const { id: _, replayed: __, ...sent } = REBUILT
    await h.deps.bridgeIns.rebuild({ ...sent, originTxHash: ORIGIN })
    await run(h)()
    expect(h.deps.fills.fill).not.toHaveBeenCalled()
    expect(h.across.statusById).not.toHaveBeenCalled()
    expect(h.deposit()).toMatchObject({ funding: "bridge" })
    expect(h.deposit()).not.toHaveProperty("walletAddress")
  })

  it("waits for the fill of a bridge-in that pays it, and for the deposits to load", async () => {
    const h = harness()
    const { id: _, ...sent } = REBUILT
    await h.deps.bridgeIns.rebuild({
      ...sent,
      originTxHash: ORIGIN,
      status: "pending",
      fillTxHash: undefined,
    })
    await run(h)()
    expect(h.deps.fills.fill).not.toHaveBeenCalled()
    expect(h.deposit().funding).toBeUndefined()
    const loading = harness()
    loading.store.set({ records: [funded()], loaded: false, failed: false })
    await run(loading)()
    expect(loading.deps.fills.fill).not.toHaveBeenCalled()
    expect(loading.deposit().funding).toBeUndefined()
  })
})
