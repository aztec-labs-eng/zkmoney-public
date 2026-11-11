/**
 * A deposit another device bridged in reaches this one replayed from chain, with no bridge-in
 * record. The rebuild reads its funding transaction for a bridge fill, stamps what it found on the
 * deposit, and rebuilds the bridge-in from the fill and the provider's record of it.
 */
import { createPace } from "@obsidion/core/cadence"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"
import type { AcrossFill } from "../../src/core/services/crossChain/acrossFill"
import type { BridgeInDeposit, BridgeInRecord } from "../../src/core/services/crossChain/types"
import {
  bridgeInRebuild,
  rebuildBridgeIn,
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
const E18 = 10n ** 18n
const L1_DAI = `0x${"da".repeat(20)}` as Address
const L1_USDC = `0x${"c1".repeat(20)}` as Address

const replayed = (over: Partial<SipaDeposit> = {}): SipaDeposit =>
  ({
    sipaAddress: ADDRESS,
    phase: "claimed",
    amount: "20",
    tokenSymbol: "DAI",
    tokenDecimals: 18,
    fundingTokenSymbol: "DAI",
    fundingTxHash: FUNDING,
    replayed: true,
    startTime: 9_000,
    ...over,
  } as SipaDeposit)

const FILL: AcrossFill = {
  originChainId: 8453,
  depositId: "77",
  depositor: `0x${"a1".repeat(20)}`,
  inputToken: USDC,
  inputAmount: 20_500_000n,
  token: L1_DAI,
  value: 20n * E18,
}

const filled = (fillTxHash: Hex = FUNDING): BridgeInDeposit => ({
  originTxHash: ORIGIN,
  status: { status: "filled", fillTxHash },
})

function harness(deposits: SipaDeposit[] = [replayed()], bridge = true) {
  const db = openDatabase(memoryBackend())
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
    async apply(address, event) {
      const current = store.get().records.find((d) => d.sipaAddress === address)
      const next = current && sipaDepositTransition(current, event, 0)
      if (!current || !next) return undefined
      store.update((s) => ({ ...s, records: s.records.map((d) => (d === current ? next : d)) }))
      return next
    },
  }
  const deps = {
    deposits: sipaDeposits,
    bridgeIns: createBridgeIns({ db, newId: () => "r1" }),
    fills: { fill: vi.fn(async () => FILL as AcrossFill | undefined) },
    provider: () => (bridge ? across : undefined),
    origin: { token: vi.fn(async () => ({ symbol: "USDbC", decimals: 6 })) },
    listedSymbol: (chainId: number, token: Address) =>
      chainId === 8453 && token === USDC ? "USDC" : undefined,
    landingDecimals: vi.fn(async (token: Address) => ({ [L1_DAI]: 18, [L1_USDC]: 6 }[token]!)),
  } satisfies BridgeInRebuildDeps
  return { db, deps, across, store }
}

const fundingOf = (h: ReturnType<typeof harness>) => h.store.get().records[0].funding

describe("the fundingRead transition", () => {
  it("sets funding once and leaves a set one as it is", () => {
    const read = (funding: "transfer" | "bridge") => ({ type: "fundingRead", funding } as const)
    expect(sipaDepositTransition(replayed(), read("bridge"), 0)).toMatchObject({
      funding: "bridge",
      phase: "claimed",
    })
    expect(
      sipaDepositTransition(replayed({ funding: "bridge" }), read("transfer"), 0),
    ).toBeUndefined()
  })
})

describe("rebuildBridgeIn", () => {
  it("rebuilds a filled bridge-in from the fill, the provider and the deposit, off the origin chain", async () => {
    const h = harness()
    const record = await rebuildBridgeIn(replayed(), h.deps)
    const expected: BridgeInRecord = {
      id: "bridge-in:r1",
      originTxHash: ORIGIN,
      originChainId: 8453,
      depositor: FILL.depositor,
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
    expect(record).toEqual(expected)
    expect(await h.deps.bridgeIns.get("bridge-in:r1")).toEqual(expected)
    expect(h.across.statusById).toHaveBeenCalledWith(8453, "77")
    expect(h.deps.origin.token).toHaveBeenCalledWith(8453, USDC)
    expect(h.store.get().records[0]).toMatchObject({ funding: "bridge", phase: "claimed" })
  })

  it("counts a fill in its landing token's decimals, not the swept deposit's", async () => {
    const h = harness()
    h.deps.fills.fill.mockResolvedValue({ ...FILL, token: L1_USDC, value: 20_000_000n })
    const record = await rebuildBridgeIn(
      replayed({ fundingTokenSymbol: "USDC", tokenDecimals: 18 }),
      h.deps,
    )
    expect(record).toMatchObject({
      outputSymbol: "USDC",
      outputAmount: "20000000",
      outputDecimals: 6,
      fee: "500000",
    })
  })

  it("saves nothing while the landing token's decimals cannot be read", async () => {
    const h = harness()
    const down = new Error("rpc down")
    h.deps.landingDecimals.mockRejectedValueOnce(down)
    await expect(rebuildBridgeIn(replayed(), h.deps)).rejects.toBe(down)
    expect(await h.deps.bridgeIns.all()).toEqual([])
  })

  it("takes the chain's symbol for a token the profile does not list", async () => {
    const h = harness()
    h.deps.listedSymbol = () => undefined
    expect(await rebuildBridgeIn(replayed(), h.deps)).toMatchObject({ symbol: "USDbC" })
  })

  it("reads a token the provider does not list on its chain, and charges no fee below zero", async () => {
    const h = harness()
    h.deps.fills.fill.mockResolvedValue({
      ...FILL,
      inputToken: `0x${"ee".repeat(20)}`,
      value: 21n * E18,
    })
    const record = await rebuildBridgeIn(replayed(), h.deps)
    expect(record).toMatchObject({
      symbol: "USDbC",
      fee: "0",
      outputAmount: (21n * E18).toString(),
    })
    expect(h.deps.origin.token).toHaveBeenCalledWith(8453, `0x${"ee".repeat(20)}`)
  })

  it("stamps a deposit no fill paid as a transfer", async () => {
    const h = harness()
    h.deps.fills.fill.mockResolvedValue(undefined)
    expect(await rebuildBridgeIn(replayed(), h.deps)).toBeUndefined()
    expect(fundingOf(h)).toBe("transfer")
    expect(h.across.statusById).not.toHaveBeenCalled()
  })

  it("rebuilds nothing when the provider's fill is another transaction, or it knows none", async () => {
    for (const found of [filled(`0x${"99".repeat(32)}`), undefined]) {
      const h = harness()
      h.across.statusById.mockResolvedValue(found)
      expect(await rebuildBridgeIn(replayed(), h.deps)).toBeUndefined()
      expect(await h.deps.bridgeIns.all()).toEqual([])
      expect(fundingOf(h)).toBe("bridge")
    }
  })

  it("matches the provider's fill hash without case", async () => {
    const h = harness()
    h.across.statusById.mockResolvedValue(filled(FUNDING.toUpperCase().replace("0X", "0x") as Hex))
    expect(await rebuildBridgeIn(replayed(), h.deps)).toBeDefined()
  })

  it("saves nothing while a read fails", async () => {
    const h = harness()
    h.deps.fills.fill.mockRejectedValue(new Error("rpc down"))
    await expect(rebuildBridgeIn(replayed(), h.deps)).rejects.toThrow()
    expect(fundingOf(h)).toBeUndefined()
    const across = harness()
    across.across.statusById.mockRejectedValue(new Error("across down"))
    await expect(rebuildBridgeIn(replayed(), across.deps)).rejects.toThrow()
    expect(await across.deps.bridgeIns.all()).toEqual([])
  })
})

describe("bridgeInRebuild task", () => {
  const runtimes: Runtime[] = []
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.stop()
  })

  function run(h: ReturnType<typeof harness>) {
    const task = bridgeInRebuild(h.deps)
    const runtime = startRuntime([task], {
      db: h.db,
      milestones: { after: async () => true, reached: () => false },
      visible: memoryStore(true).readonly,
      pace: createPace(),
      now: () => Date.now(),
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
    expect(fundingOf(h)).toBe("transfer")
  })

  it("never changes a stamped funding", async () => {
    const h = harness([replayed({ funding: "bridge" })])
    h.deps.fills.fill.mockResolvedValue(undefined)
    await run(h)()
    expect(h.deps.fills.fill).toHaveBeenCalledTimes(1)
    expect(fundingOf(h)).toBe("bridge")
  })

  it("reads again a fill whose bridge-in is not rebuilt yet, and stops once it is", async () => {
    const h = harness()
    h.across.statusById.mockResolvedValueOnce(undefined)
    const wake = run(h)
    await wake()
    expect(await h.deps.bridgeIns.all()).toEqual([])
    expect(fundingOf(h)).toBe("bridge")
    await wake()
    expect(await h.deps.bridgeIns.all()).toHaveLength(1)
    await wake()
    expect(h.deps.fills.fill).toHaveBeenCalledTimes(2)
  })

  it("leaves alone deposits this device sent, unfunded ones, ones not plain, and transfers", async () => {
    const deposits = [
      replayed({ replayed: undefined }),
      replayed({ fundingTxHash: undefined }),
      replayed({ intent: "registration" }),
      replayed({ direct: { recipientCommitment: "0x01" } }),
      replayed({ funding: "transfer" }),
    ]
    const h = harness(deposits)
    await run(h)()
    expect(h.deps.fills.fill).not.toHaveBeenCalled()
    expect(h.store.get().records).toEqual(deposits)
    expect(await h.deps.bridgeIns.all()).toEqual([])
  })

  it("never reads again a bridge-stamped deposit where this build has no provider", async () => {
    const h = harness([replayed({ funding: "bridge" })], false)
    await run(h)()
    expect(h.deps.fills.fill).not.toHaveBeenCalled()
    const unread = harness(undefined, false)
    await run(unread)()
    expect(fundingOf(unread)).toBe("bridge")
  })

  it("leaves alone a deposit a bridge-in already pays, and waits for the deposits to load", async () => {
    const h = harness()
    await rebuildBridgeIn(replayed(), h.deps)
    const paid = await h.deps.bridgeIns.all()
    const deposits = h.store.get().records
    h.deps.fills.fill.mockClear()
    await run(h)()
    expect(h.deps.fills.fill).not.toHaveBeenCalled()
    expect(h.store.get().records).toEqual(deposits)
    expect(await h.deps.bridgeIns.all()).toEqual(paid)
    const loading = harness()
    loading.store.set({ records: [replayed()], loaded: false, failed: false })
    await run(loading)()
    expect(loading.deps.fills.fill).not.toHaveBeenCalled()
    expect(fundingOf(loading)).toBeUndefined()
    expect(await loading.deps.bridgeIns.all()).toEqual([])
  })
})
