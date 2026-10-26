import { describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { encodeAbiParameters, encodeEventTopics, erc4626Abi, type Address, type Hex } from "viem"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"
import type { WithdrawalRecord } from "../../../src/core/services/bridge/types"
import { SavingsMoveStorage } from "../../../src/core/services/savings/SavingsMoveStorage"
import { settleSavingsMoves } from "../../../src/core/services/savings/settleSavingsMoves"
import type { SavingsMoveRecord } from "../../../src/core/services/savings/types"

const MAIN = "0x00000000000000000000000000000000000000aa" as Address
const SAVINGS = "0x00000000000000000000000000000000000000bb" as Address
const ESCROW = "0x00000000000000000000000000000000000000ee" as Address
const NONCE = `0x${"01".repeat(32)}` as Hex
const COMMITMENT = `0x${"02".repeat(32)}` as Hex

const move = (extra: Partial<SavingsMoveRecord> = {}): SavingsMoveRecord => ({
  direction: "in",
  withdrawalLocalId: "w1",
  escrow: ESCROW,
  nonce: NONCE,
  recipientCommitment: COMMITMENT,
  amount: "10",
  startTime: 1_000,
  ...extra,
})

const VAULT = "0x00000000000000000000000000000000000000cc" as Address
const RUN_TX = `0x${"ab".repeat(32)}` as Hex
/** The vault's ERC-4626 event as a receipt log: `Deposit(sender, owner, assets, shares)` or `Withdraw(...)`. */
const vaultLog = (
  eventName: "Deposit" | "Withdraw",
  assets: bigint,
  shares: bigint,
  party: Address = ESCROW,
) => ({
  address: VAULT,
  topics: encodeEventTopics({
    abi: erc4626Abi,
    eventName,
    args:
      // viem names the vault's Deposit parties `sender` and `receiver`.
      eventName === "Deposit"
        ? { sender: party, receiver: party }
        : { sender: party, receiver: party, owner: party },
  } as never),
  data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [assets, shares]),
})

const burn = (extra: Partial<WithdrawalRecord> = {}): WithdrawalRecord => ({
  localId: "w1",
  recipient: ESCROW,
  recipientProvenance: "saved-recipient",
  amount: "10",
  rawAmount: "10",
  tokenSymbol: "DAI",
  phase: "done",
  startTime: 2_000,
  skyMove: {
    direction: "out",
    factory: `0x${"f".repeat(40)}` as Address,
    recipientCommitment: COMMITMENT,
    recoveryCommitment: `0x${"03".repeat(32)}` as Hex,
    relayerTip: "1",
    nonce: NONCE,
  },
  ...extra,
})

function harness(deposit = true) {
  const claims = { main: vi.fn(), savings: vi.fn() }
  const claimer = (side: "main" | "savings") => async () => ({
    claimSweptDeposit: async (params: unknown) => void claims[side](params),
  })
  const publicClient = {
    getContractEvents: vi.fn(async () =>
      deposit
        ? [{ args: { index: 12n, amount: 34n }, transactionHash: RUN_TX, blockNumber: 36n }]
        : [],
    ),
    getTransactionReceipt: vi.fn(async () => ({ logs: [vaultLog("Deposit", 33n, 34n)] })),
    getBlockNumber: vi.fn(async () => 100n),
    getBlock: vi.fn(async (arg: { blockTag?: string; blockNumber?: bigint }) =>
      arg.blockNumber !== undefined
        ? { number: arg.blockNumber, timestamp: 1_000_000n - (100n - arg.blockNumber) * 12n }
        : { number: 36n },
    ),
  }
  const store = new SavingsMoveStorage(new InMemoryStorageAdapter())
  const unknown = vi.fn()
  const deps = {
    publicClient: publicClient as never,
    vault: VAULT,
    onVaultUnknown: unknown,
    masterSecret: new Fr(7n),
    recipient: AztecAddress.fromStringUnsafe(`0x${"0".repeat(63)}5`),
    main: { portal: MAIN, token: DAI, claimer: claimer("main") } as {
      portal: Address
      token: Address
      claimer: () => Promise<unknown>
      fromBlock?: bigint
    },
    savings: { portal: SAVINGS, claimer: claimer("savings") },
  }
  return { store, deps, claims, publicClient, unknown }
}
const RELEASE_TX = `0x${"cd".repeat(32)}` as Hex
const DAI = "0x00000000000000000000000000000000000000da" as Address

describe("settleSavingsMoves", () => {
  it("claims a pending move's deposit and stamps when it landed", async () => {
    const { store, deps, claims } = harness()
    await store.load()
    await store.put(move())
    await settleSavingsMoves(
      store,
      deps,
      [],
      () => {},
      () => 5_000,
    )
    expect(claims.savings).toHaveBeenCalledTimes(1)
    expect(store.get("w1")).toMatchObject({
      // The deposit's L1 block time: when the move's shares landed.
      deposit: { inboxIndex: "12", amount: "34", claimed: true, at: (1_000_000 - 64 * 12) * 1000 },
      endTime: 5_000,
    })
  })

  it("stamps a claim stored now, then reads the balances once per claim", async () => {
    const { store, deps } = harness()
    await store.load()
    await store.put(move())
    await store.put(move({ withdrawalLocalId: "w2", direction: "out" }))
    const storedAtRefresh: (number | undefined)[][] = []
    const refreshBalance = vi.fn(async () => {
      storedAtRefresh.push(store.list().map((m) => m.deposit?.storedAt))
    })
    await settleSavingsMoves(
      store,
      { ...deps, refreshBalance },
      [],
      () => {},
      () => 7_000,
    )
    // Each claim is on record, stamped, before the read that should show it.
    expect(storedAtRefresh).toEqual([
      [7_000, undefined],
      [7_000, 7_000],
    ])
  })

  it("claims a deposit the token already holds without a stamp or a read", async () => {
    const { store, deps } = harness()
    await store.load()
    await store.put(move())
    const refreshBalance = vi.fn(async () => {})
    const held = {
      ...deps,
      refreshBalance,
      savings: {
        ...deps.savings,
        claimer: async () => ({
          claimSweptDeposit: async () => {
            throw new Error("Assertion failed: deposit already spent")
          },
        }),
      },
    }
    await settleSavingsMoves(store, held, [])
    expect(store.get("w1")?.deposit).toMatchObject({ claimed: true })
    expect(store.get("w1")?.deposit?.storedAt).toBeUndefined()
    expect(refreshBalance).not.toHaveBeenCalled()
  })

  it("re-reads no balance when the pass claimed nothing", async () => {
    const { store, deps } = harness(false)
    await store.load()
    await store.put(move())
    const refreshBalance = vi.fn(async () => {})
    await settleSavingsMoves(store, { ...deps, refreshBalance }, [])
    expect(refreshBalance).not.toHaveBeenCalled()
  })

  it("adopts a burn the store does not know, from its Sky meta", async () => {
    const { store, deps, claims } = harness()
    await settleSavingsMoves(store, deps, [burn()])
    expect(store.get("w1")).toMatchObject({ direction: "out", escrow: ESCROW, startTime: 2_000 })
    expect(claims.main).toHaveBeenCalledTimes(1)
  })

  it("leaves a failed burn and a settled move alone", async () => {
    const { store, deps, claims, publicClient } = harness()
    await store.load()
    await store.put(move({ withdrawalLocalId: "failed" }))
    // Settled with its figures: nothing left to read for it.
    await store.put(
      move({
        withdrawalLocalId: "done",
        deposit: { inboxIndex: "1", amount: "2", claimed: true, txHash: RUN_TX },
        vault: { txHash: RUN_TX, assets: "1", shares: "2" },
      }),
    )
    await settleSavingsMoves(store, deps, [
      burn({ localId: "failed", phase: "failed", skyMove: undefined }),
    ])
    expect(publicClient.getContractEvents).not.toHaveBeenCalled()
    expect(publicClient.getTransactionReceipt).not.toHaveBeenCalled()
    expect(claims.main).not.toHaveBeenCalled()
    expect(claims.savings).not.toHaveBeenCalled()
  })

  it("reports a refused claim and keeps the found deposit for the next pass", async () => {
    const { store, deps, publicClient } = harness()
    deps.savings.claimer = async () => ({
      claimSweptDeposit: async () => {
        throw new Error("No L1 to L2 message found")
      },
    })
    await store.load()
    await store.put(move())
    const refused = vi.fn()
    await settleSavingsMoves(store, deps, [], refused)
    expect(refused).toHaveBeenCalledWith(
      expect.objectContaining({ withdrawalLocalId: "w1" }),
      expect.objectContaining({ message: "No L1 to L2 message found" }),
    )
    expect(store.get("w1")?.deposit).toEqual({
      inboxIndex: "12",
      amount: "34",
      claimed: false,
      txHash: RUN_TX,
      blockNumber: "36",
      at: (1_000_000 - 64 * 12) * 1000,
    })
    expect(store.get("w1")?.lastCheck?.message).toBe("claim refused: No L1 to L2 message found")
    // The next pass claims without searching again.
    await settleSavingsMoves(store, deps, [], refused)
    expect(publicClient.getContractEvents).toHaveBeenCalledTimes(1)
  })

  it("runs one pass at a time: callers during a pass share one more, on the latest withdrawals", async () => {
    const { store, deps, claims } = harness()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    deps.savings.claimer = async () => ({
      claimSweptDeposit: async (params: unknown) => {
        claims.savings(params)
        await gate
      },
    })
    await store.load()
    await store.put(move())
    const first = settleSavingsMoves(store, deps)
    const second = settleSavingsMoves(store, deps)
    // A burn rebuilt while the first pass runs: the queued pass adopts it.
    const third = settleSavingsMoves(store, deps, [burn({ localId: "w2" })])
    expect(second).not.toBe(first)
    expect(third).toBe(second)
    expect(store.get("w2")).toBeNull()
    release()
    await Promise.all([first, second, third])
    expect(claims.savings).toHaveBeenCalledTimes(1)
    expect(store.get("w1")?.deposit?.claimed).toBe(true)
    expect(claims.main).toHaveBeenCalledTimes(1)
    expect(store.get("w2")?.deposit?.claimed).toBe(true)
    // The next call after the passes is a new pass.
    await store.put(move({ withdrawalLocalId: "w3" }))
    await settleSavingsMoves(store, deps)
    expect(claims.savings).toHaveBeenCalledTimes(2)
  })

  it("never writes a claim back to unclaimed when another writer recorded it during the pass", async () => {
    const { store, deps } = harness()
    deps.savings.claimer = async () => ({
      claimSweptDeposit: async () => {
        await store.put(
          move({ deposit: { inboxIndex: "12", amount: "34", claimed: true }, endTime: 4_000 }),
        )
        throw new Error("Assertion failed: deposit already stored")
      },
    })
    await store.load()
    await store.put(move())
    await settleSavingsMoves(
      store,
      deps,
      [],
      () => {},
      () => 9_000,
    )
    expect(store.get("w1")).toMatchObject({
      deposit: { inboxIndex: "12", amount: "34", claimed: true },
      endTime: 4_000,
      lastCheck: { at: 9_000, message: "claimed" },
    })
  })

  it("keeps the escrow run's hash with the deposit and the vault's figures from its receipt", async () => {
    const { store, deps, publicClient } = harness()
    await store.load()
    await store.put(move())
    await settleSavingsMoves(store, deps)
    const settled = store.get("w1")!
    expect(settled.deposit).toEqual({
      inboxIndex: "12",
      amount: "34",
      claimed: true,
      txHash: RUN_TX,
      blockNumber: "36",
      at: (1_000_000 - 64 * 12) * 1000,
      storedAt: expect.any(Number),
    })
    expect(settled.vault).toEqual({ txHash: RUN_TX, assets: "33", shares: "34" })
    expect(publicClient.getTransactionReceipt).toHaveBeenCalledWith({ hash: RUN_TX })
  })

  it("backfills a move in claimed without the vault's figures: finds its run again from the floor and reads the receipt", async () => {
    const { store, deps, publicClient } = harness()
    await store.load()
    // Claimed by an earlier build: a deposit with no hash, a cursor past it, no figures.
    await store.put(
      move({
        depositScanFrom: "90",
        deposit: { inboxIndex: "12", amount: "34", claimed: true },
        endTime: 5_000,
      }),
    )
    await settleSavingsMoves(store, deps)
    const filled = store.get("w1")!
    expect(filled.deposit?.txHash).toBe(RUN_TX)
    expect(filled.deposit?.blockNumber).toBe("36")
    expect(filled.vault).toEqual({ txHash: RUN_TX, assets: "33", shares: "34" })
    expect(filled.deposit?.claimed).toBe(true)
    // An unreadable receipt leaves the move without figures and says so, for the next pass.
    await store.put(
      move({ withdrawalLocalId: "w2", deposit: { inboxIndex: "13", amount: "1", claimed: true } }),
    )
    publicClient.getTransactionReceipt.mockRejectedValueOnce(new Error("receipt pruned"))
    await settleSavingsMoves(store, deps)
    expect(store.get("w2")?.vault).toBeUndefined()
    expect(store.get("w2")?.deposit?.txHash).toBe(RUN_TX)
    expect(store.get("w2")?.lastCheck?.message).toBe("vault figures unreadable: receipt pruned")
  })

  it("reads a move out's figures from its burn's L1 release, the Withdraw for its shares, once the tracker names it", async () => {
    const { store, deps, publicClient, unknown } = harness()
    await store.load()
    // Its deposit sits far up the chain: the search for the release does not finish in one pass.
    await store.put(
      move({
        direction: "out",
        amount: "100",
        depositScanFloor: "10",
        deposit: { inboxIndex: "12", amount: "106", claimed: true, blockNumber: "500000" },
      }),
    )
    // The tracker has no hash yet and no DAI reached the escrow in the first windows: nothing to
    // read, the move stays in line with its search cursor kept.
    publicClient.getContractEvents.mockImplementation(async () => [])
    await settleSavingsMoves(store, deps, [burn({ phase: "finalizing_l1" })])
    expect(publicClient.getTransactionReceipt).not.toHaveBeenCalled()
    expect(store.get("w1")?.vault).toBeUndefined()
    expect(store.get("w1")?.vaultUnknown).toBeUndefined()
    expect(store.get("w1")?.releaseScanFrom).toBe("200010")
    // Resolved: the release holds the executor's Withdraw for the burned shares beside another.
    publicClient.getTransactionReceipt.mockResolvedValueOnce({
      logs: [vaultLog("Withdraw", 9n, 8n), vaultLog("Withdraw", 107n, 100n)],
    })
    publicClient.getContractEvents.mockClear()
    await settleSavingsMoves(store, deps, [burn({ phase: "done", l1TxHash: RELEASE_TX })])
    expect(publicClient.getTransactionReceipt).toHaveBeenCalledWith({ hash: RELEASE_TX })
    // The tracker's hash is read directly, with no search for the DAI paid to the escrow.
    expect(publicClient.getContractEvents).not.toHaveBeenCalled()
    expect(store.get("w1")?.vault).toEqual({ txHash: RELEASE_TX, assets: "107", shares: "100" })
    expect(unknown).not.toHaveBeenCalled()
  })

  it("backfills missing figures before any claim, and settles a run with no vault event as unknown", async () => {
    const { store, deps, claims, publicClient } = harness()
    await store.load()
    await store.put(move())
    await store.put(
      move({ withdrawalLocalId: "w2", deposit: { inboxIndex: "13", amount: "1", claimed: true } }),
    )
    publicClient.getTransactionReceipt.mockResolvedValueOnce({ logs: [] })
    const { unknown } = { unknown: deps.onVaultUnknown }
    await settleSavingsMoves(store, deps)
    // The claimed move's receipt was read before the pending move's claim.
    expect(publicClient.getTransactionReceipt.mock.invocationCallOrder[0]).toBeLessThan(
      claims.savings.mock.invocationCallOrder[0],
    )
    const filled = store.get("w2")!
    expect(filled.deposit?.txHash).toBe(RUN_TX)
    expect(filled.deposit?.blockNumber).toBe("36")
    expect(filled.vault).toBeUndefined()
    expect(filled.vaultUnknown).toBe(`no vault Deposit for its shares in ${RUN_TX}`)
    expect(unknown).toHaveBeenCalledTimes(1)
    expect(unknown).toHaveBeenCalledWith(
      expect.objectContaining({ withdrawalLocalId: "w2" }),
      RUN_TX,
      `no vault Deposit for its shares in ${RUN_TX}`,
    )
    // Known for good: a later pass reads nothing for it and says nothing again.
    publicClient.getTransactionReceipt.mockClear()
    await settleSavingsMoves(store, deps)
    expect(publicClient.getTransactionReceipt).not.toHaveBeenCalled()
    expect(unknown).toHaveBeenCalledTimes(1)
  })

  it("finds a rebuilt move out's release by the DAI paid to its escrow when the tracker has no hash", async () => {
    const { store, deps, publicClient, unknown } = harness()
    // Deposit logs as before; the DAI transfer to the escrow names the release.
    publicClient.getContractEvents.mockImplementation(
      async ({ eventName, address }: { eventName: string; address: Address }) =>
        eventName === "Transfer" && address === DAI
          ? [{ args: { to: ESCROW, value: 99n }, transactionHash: RELEASE_TX, blockNumber: 40n }]
          : [{ args: { index: 12n, amount: 34n }, transactionHash: RUN_TX, blockNumber: 36n }],
    )
    publicClient.getTransactionReceipt.mockResolvedValueOnce({
      logs: [vaultLog("Withdraw", 107n, 100n)],
    })
    await store.load()
    await store.put(
      move({
        direction: "out",
        amount: "100",
        deposit: { inboxIndex: "12", amount: "106", claimed: true, blockNumber: "60" },
      }),
    )
    await settleSavingsMoves(store, deps, [burn({ phase: "done" })])
    expect(publicClient.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({ address: DAI, eventName: "Transfer", args: { to: ESCROW } }),
    )
    expect(publicClient.getTransactionReceipt).toHaveBeenCalledWith({ hash: RELEASE_TX })
    expect(store.get("w1")?.vault).toEqual({ txHash: RELEASE_TX, assets: "107", shares: "100" })
    expect(store.get("w1")?.vaultLookup).toBe(2)
    expect(unknown).not.toHaveBeenCalled()
  })

  it("settles a move out whose release is nowhere before its deposit as unknown, told once", async () => {
    const { store, deps, publicClient, unknown } = harness()
    publicClient.getContractEvents.mockImplementation(
      async ({ eventName }: { eventName: string }) =>
        eventName === "Transfer"
          ? []
          : [{ args: { index: 12n, amount: 34n }, transactionHash: RUN_TX, blockNumber: 36n }],
    )
    await store.load()
    await store.put(
      move({
        direction: "out",
        amount: "100",
        depositScanFloor: "10",
        deposit: { inboxIndex: "12", amount: "106", claimed: true, blockNumber: "60" },
      }),
    )
    await settleSavingsMoves(store, deps, [burn({ phase: "done" })])
    expect(store.get("w1")?.vaultUnknown).toBe("no release paying its escrow up to block 61")
    expect(store.get("w1")?.vaultLookup).toBe(2)
    expect(unknown).toHaveBeenCalledTimes(1)
    publicClient.getContractEvents.mockClear()
    await settleSavingsMoves(store, deps, [burn({ phase: "done" })])
    expect(publicClient.getContractEvents).not.toHaveBeenCalled()
    expect(unknown).toHaveBeenCalledTimes(1)
  })

  it("reads a move out again whose unknown came from the older lookup, from the release", async () => {
    const { store, deps, publicClient } = harness()
    publicClient.getTransactionReceipt.mockResolvedValueOnce({
      logs: [vaultLog("Withdraw", 107n, 100n)],
    })
    await store.load()
    await store.put(
      move({
        direction: "out",
        amount: "100",
        deposit: { inboxIndex: "12", amount: "106", claimed: true, txHash: RUN_TX },
        vaultUnknown: "no vault event on the escrow run",
      }),
    )
    await settleSavingsMoves(store, deps, [burn({ phase: "done", finalizeTxHash: RELEASE_TX })])
    expect(store.get("w1")?.vault).toEqual({ txHash: RELEASE_TX, assets: "107", shares: "100" })
    expect(store.get("w1")?.vaultUnknown).toBe("no vault event on the escrow run")
    expect(store.get("w1")?.vaultLookup).toBe(2)
  })

  it("keeps the cursor of a move adopted while its burn still proves", async () => {
    const { store, deps, publicClient } = harness(false)
    await settleSavingsMoves(store, deps, [
      burn({ phase: "submitting", skyMove: { ...burn().skyMove!, depositScanFrom: "90" } }),
    ])
    expect(publicClient.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 90n }),
    )
    expect(BigInt(store.get("w1")!.depositScanFrom!)).toBeGreaterThanOrEqual(37n)
  })

  it("keeps the later cursor when the move flow's put lands during a pass", async () => {
    const { store, deps, publicClient } = harness(false)
    publicClient.getContractEvents.mockImplementation(async () => {
      // The flow records the move with the head it read at the burn, the floor of its range.
      await store.put(move({ depositScanFrom: "95", depositScanFloor: "95" }))
      return []
    })
    await settleSavingsMoves(store, deps, [burn({ phase: "submitting" })])
    expect(store.get("w1")?.depositScanFrom).toBe("95")
  })

  it("starts a rebuilt move's search at the destination's first block when the burn's block time is unknown", async () => {
    const { store, deps, publicClient } = harness(false)
    deps.main.fromBlock = 5n
    await settleSavingsMoves(store, deps, [
      burn({
        phase: "done",
        rebuilt: true,
        startTimeEstimated: true,
        startTime: 1_000_000_000_000,
      }),
    ])
    expect(publicClient.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 5n }),
    )
    expect(store.get("w1")?.depositScanFloor).toBe("5")
  })

  it("starts over at the burn's floor for a cursor kept without one, then advances from there", async () => {
    const { store, deps, publicClient } = harness(false)
    // The deposit sits at block 30; an earlier build left the cursor past it.
    publicClient.getContractEvents.mockImplementation(
      async ({ fromBlock }: { fromBlock: bigint }) =>
        fromBlock <= 30n ? [{ args: { index: 12n, amount: 34n } }] : [],
    )
    await store.load()
    await store.put(move({ depositScanFrom: "90" }))
    await settleSavingsMoves(store, deps)
    expect(store.get("w1")?.deposit).toEqual({
      inboxIndex: "12",
      amount: "34",
      claimed: true,
      storedAt: expect.any(Number),
    })
    expect(store.get("w1")?.depositScanFloor).toBe("0")
    // A cursor with its floor is trusted: the search goes on from it.
    await store.put(
      move({ withdrawalLocalId: "w2", depositScanFrom: "90", depositScanFloor: "50" }),
    )
    publicClient.getContractEvents.mockClear()
    await settleSavingsMoves(store, deps)
    expect(publicClient.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 90n }),
    )
    expect(store.get("w2")?.deposit).toBeUndefined()
  })

  it("keeps the scan cursor between passes when nothing has landed", async () => {
    const { store, deps, publicClient } = harness(false)
    await store.load()
    await store.put(move({ depositScanFrom: "10", depositScanFloor: "10" }))
    await settleSavingsMoves(store, deps)
    expect(publicClient.getContractEvents).toHaveBeenCalledTimes(1)
    expect(store.get("w1")?.depositScanFrom).toBe("37")
    expect(store.get("w1")?.deposit).toBeUndefined()
    expect(store.get("w1")?.lastCheck?.message).toMatch(/no deposit .* searched to block 37/)
  })

  it("goes on from where the last backfill search for a claimed move's run ended", async () => {
    const { store, deps, publicClient } = harness(false)
    await store.load()
    await store.put(move({ deposit: { inboxIndex: "12", amount: "34", claimed: true } }))
    await settleSavingsMoves(store, deps)
    expect(store.get("w1")?.runScanFrom).toBe("37")
    publicClient.getContractEvents.mockClear()
    await settleSavingsMoves(store, deps)
    expect(publicClient.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 37n }),
    )
  })

  it("does not bring back a move removed while its pass was searching", async () => {
    const { store, deps, publicClient } = harness(false)
    await store.load()
    await store.put(move())
    publicClient.getContractEvents.mockImplementationOnce(async () => {
      await store.remove("w1")
      return []
    })
    await settleSavingsMoves(store, deps)
    expect(store.get("w1")).toBeNull()
  })

  it("settles the other moves when one move's chain search fails, and says why on that one", async () => {
    const { store, deps, publicClient, claims } = harness()
    await store.load()
    await store.put(move({ withdrawalLocalId: "broken", direction: "out" }))
    await store.put(move({ withdrawalLocalId: "ok" }))
    publicClient.getContractEvents.mockImplementation(async (args: { address?: string }) => {
      if (args.address === MAIN) throw new Error("logs unavailable")
      return [{ args: { index: 12n, amount: 34n }, transactionHash: RUN_TX, blockNumber: 36n }]
    })
    await settleSavingsMoves(store, deps)
    expect(claims.savings).toHaveBeenCalledTimes(1)
    expect(store.get("ok")?.deposit?.claimed).toBe(true)
    expect(store.get("broken")?.lastCheck?.message).toBe("search failed: logs unavailable")
  })

  it("takes the vault event of its own escrow when several escrows ran in one transaction", async () => {
    const { store, deps, publicClient, unknown } = harness()
    const OTHER = "0x00000000000000000000000000000000000000ef" as Address
    await store.load()
    await store.put(move())
    // The deposit lands 34 shares; another escrow's Deposit comes first, and neither matches 34.
    publicClient.getTransactionReceipt.mockResolvedValueOnce({
      logs: [vaultLog("Deposit", 50n, 60n, OTHER), vaultLog("Deposit", 33n, 35n)],
    })
    await settleSavingsMoves(store, deps)
    expect(store.get("w1")?.vault).toEqual({ txHash: RUN_TX, assets: "33", shares: "35" })
    // Two other escrows' events and none of its own: no figure is taken from them.
    await store.put(move({ withdrawalLocalId: "w2" }))
    publicClient.getTransactionReceipt.mockResolvedValueOnce({
      logs: [vaultLog("Deposit", 50n, 60n, OTHER), vaultLog("Deposit", 51n, 61n, OTHER)],
    })
    await settleSavingsMoves(store, deps)
    expect(store.get("w2")?.vault).toBeUndefined()
    expect(unknown).not.toHaveBeenCalled()
  })

  it("searches and claims a move whose factory names an older Savings portal on that portal's deployment", async () => {
    const { store, deps, claims, publicClient } = harness()
    const OLD = "0x00000000000000000000000000000000000000b0" as Address
    const FACTORY = "0x00000000000000000000000000000000000000fa" as Address
    const oldClaim = vi.fn()
    const destinationFor = vi.fn(async () => ({
      portal: OLD,
      claimer: async () => ({
        claimSweptDeposit: async (params: unknown) => void oldClaim(params),
      }),
    }))
    await store.load()
    await store.put(move({ factory: FACTORY }))
    await settleSavingsMoves(store, { ...deps, destinationFor } as never)
    expect(destinationFor).toHaveBeenCalledWith(expect.objectContaining({ factory: FACTORY }))
    expect(publicClient.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({ address: OLD }),
    )
    expect(oldClaim).toHaveBeenCalledTimes(1)
    expect(claims.savings).not.toHaveBeenCalled()
    expect(store.get("w1")?.deposit?.claimed).toBe(true)
    // A move stored before its factory was kept takes it from its burn.
    destinationFor.mockClear()
    await store.put(move({ withdrawalLocalId: "w2" }))
    await settleSavingsMoves(store, { ...deps, destinationFor } as never, [
      burn({
        localId: "w2",
        phase: "done",
        skyMove: { ...burn().skyMove!, direction: "in", factory: FACTORY },
      }),
    ])
    expect(destinationFor).toHaveBeenCalledWith(
      expect.objectContaining({ withdrawalLocalId: "w2", factory: FACTORY }),
    )
  })

  it("keeps the current deployment for a move with no factory", async () => {
    const { store, deps, claims, publicClient } = harness()
    const destinationFor = vi.fn()
    await store.load()
    await store.put(move())
    await settleSavingsMoves(store, { ...deps, destinationFor } as never)
    expect(destinationFor).not.toHaveBeenCalled()
    expect(publicClient.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({ address: SAVINGS }),
    )
    expect(claims.savings).toHaveBeenCalledTimes(1)
  })

  it("settles the other moves when one move's destination cannot be resolved, and says why on that one", async () => {
    const { store, deps, claims } = harness()
    const FACTORY = "0x00000000000000000000000000000000000000fa" as Address
    const destinationFor = vi.fn(async () => {
      throw new Error("timed out after 20000ms")
    })
    await store.load()
    await store.put(move({ withdrawalLocalId: "stalled", factory: FACTORY }))
    await store.put(move({ withdrawalLocalId: "ok" }))
    await settleSavingsMoves(store, { ...deps, destinationFor } as never)
    expect(store.get("ok")?.deposit?.claimed).toBe(true)
    expect(claims.savings).toHaveBeenCalledTimes(1)
    expect(store.get("stalled")?.lastCheck?.message).toBe("search failed: timed out after 20000ms")
    // The next pass tries it again.
    destinationFor.mockClear()
    await settleSavingsMoves(store, { ...deps, destinationFor } as never)
    expect(destinationFor).toHaveBeenCalledTimes(1)
  })
})
