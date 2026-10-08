import { beforeEach, describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec/aztec.js/fields"
import { getAddress, type Hash, type Hex } from "viem"
import { planSwapOnWithdraw, type ScannedWithdrawEvent } from "@obsidion/sdk"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../../__test-helpers__/resetSingleton"
import { WithdrawalStorage } from "../../../src/core/services/bridge/WithdrawalStorage"
import { rebuildWithdrawals } from "../../../src/core/services/bridge/withdrawalRescan"
import { globalEventEmitter } from "../../../src/core/services/GlobalEventEmitter"
import { swapEscrowTarget } from "../../../src/core/services/bridge/swapEscrowArgs"
import { withdrawalRecipients } from "../../../src/core/services/bridge/withdrawalRecipients"

const RECIPIENT = getAddress(`0x${"b0".repeat(20)}`)
const FACTORY = getAddress(`0x${"fa".repeat(20)}`)
const RECOVERY = { account: getAddress(`0x${"5a".repeat(20)}`), salt: new Fr(9n) }
const NONCE = `0x${"77".repeat(32)}` as Hex
const TIP = 5n * 10n ** 18n
const DIRECT_TX = `0x${"11".repeat(32)}` as Hash
const SWAP_TX = `0x${"22".repeat(32)}` as Hash
const KNOWN_TX = `0x${"33".repeat(32)}` as Hash
const DEPLOYMENT = {
  portal: `0x${"70".repeat(20)}` as Hex,
  pool: `0x${"90".repeat(20)}` as Hex,
  l2Token: "0xl2",
}

const plan = planSwapOnWithdraw({
  swapEscrowFactory: FACTORY,
  output: "USDC",
  l1Recipient: RECIPIENT,
  recovery: RECOVERY,
  amount: 100n * 10n ** 18n,
  withdrawalRelayerTip: 0n,
  proverTip: 0n,
  fpcFundingCut: 0n,
  relayerTip: TIP,
  nonce: NONCE,
})

const EVENTS: ScannedWithdrawEvent[] = [
  {
    txHash: SWAP_TX,
    blockNumber: 20,
    l1Recipient: plan.escrow,
    amount: 100n * 10n ** 18n,
    swap: {
      output: "USDC",
      recipient: RECIPIENT,
      factory: FACTORY,
      recoveryCommitment: plan.escrowArgs.recoveryCommitment,
      relayerTip: TIP,
      nonce: NONCE,
    },
  },
  { txHash: DIRECT_TX, blockNumber: 10, l1Recipient: RECIPIENT, amount: 25n * 10n ** 17n },
  { txHash: KNOWN_TX, blockNumber: 30, l1Recipient: RECIPIENT, amount: 10n ** 18n },
]

function makeSource(
  events = EVENTS,
  times: Record<number, number | undefined> = { 10: 1_000, 20: 2_000 },
) {
  return {
    headBlock: vi.fn(async () => 40),
    listWithdrawals: vi.fn(async () => events),
    blockTimestampMs: vi.fn(async (block: number) => times[block]),
  }
}

async function newStore(): Promise<WithdrawalStorage> {
  resetSingleton(WithdrawalStorage as unknown as { instance: WithdrawalStorage | null })
  const store = WithdrawalStorage.get(new InMemoryStorageAdapter())
  await store.load()
  return store
}

describe("rebuildWithdrawals", () => {
  it("joins an in-progress chain catch-up until its rows are written", async () => {
    const store = await newStore()
    let open!: () => void
    const gate = new Promise<number>((resolve) => (open = () => resolve(1_000)))
    const source = makeSource()
    source.blockTimestampMs.mockImplementation(() => gate)
    const endScan = globalEventEmitter.beginSyncCatchUp()
    const rebuild = rebuildWithdrawals({ source, store, tokenSymbol: "DAI" })
    await vi.waitFor(() => expect(source.blockTimestampMs).toHaveBeenCalled())
    endScan()
    expect(globalEventEmitter.isSyncCatchingUp()).toBe(true) // the rescan still holds it
    open()
    await rebuild
    expect(globalEventEmitter.isSyncCatchingUp()).toBe(false)

    // Without a catch-up in progress the rescan never starts one.
    await rebuildWithdrawals({ source: makeSource(), store: await newStore(), tokenSymbol: "DAI" })
    expect(globalEventEmitter.isSyncCatchingUp()).toBe(false)
  })

  beforeEach(() => {
    resetSingleton(WithdrawalStorage as unknown as { instance: WithdrawalStorage | null })
  })

  it("creates a mined record per unknown burn, oldest first, and leaves stored ones alone", async () => {
    const store = await newStore()
    await store.create({
      localId: "known",
      l2TxHash: KNOWN_TX,
      recipient: RECIPIENT,
      recipientProvenance: "saved-recipient",
      amount: "1",
      tokenSymbol: "DAI",
      phase: "done",
      startTime: 5,
    })
    const source = makeSource()

    const rebuilt = await rebuildWithdrawals({
      source,
      store,
      tokenSymbol: "DAI",
      deployment: DEPLOYMENT,
      now: () => 9_999,
    })

    expect(source.listWithdrawals).toHaveBeenCalledWith(1, 41)
    expect(rebuilt.map((r) => r.l2TxHash)).toEqual([DIRECT_TX, SWAP_TX])
    expect(store.list()).toHaveLength(3)
    expect(store.get("known")?.phase).toBe("done")

    const direct = store.getByL2TxHash(DIRECT_TX)!
    expect(direct).toMatchObject({
      phase: "l2_mined",
      blockNumber: 10,
      recipient: RECIPIENT,
      amount: "2.5",
      rawAmount: "2500000000000000000",
      tokenSymbol: "DAI",
      startTime: 1_000,
      deployment: DEPLOYMENT,
      rebuilt: true,
      recipientProvenance: "saved-recipient",
    })
    expect(direct.swapOutput).toBeUndefined()
    expect(withdrawalRecipients(direct).viaEscrow).toBe(false)
  })

  it("rebuilds a swap record whose escrow args reproduce the burn's escrow", async () => {
    const store = await newStore()
    await rebuildWithdrawals({ source: makeSource(), store, tokenSymbol: "DAI" })

    const swap = store.getByL2TxHash(SWAP_TX)!
    expect(swap).toMatchObject({
      phase: "l2_mined",
      recipient: RECIPIENT,
      swapOutput: "USDC",
      swapEscrow: plan.escrow,
      swapEscrowFactory: FACTORY,
      swapNonce: NONCE,
      swapRecoveryCommitment: plan.escrowArgs.recoveryCommitment,
      swapRelayerTip: TIP.toString(),
      startTime: 2_000,
      rebuilt: true,
    })
    expect(swap.deployment).toBeUndefined()
    expect(withdrawalRecipients(swap)).toEqual({
      release: plan.escrow,
      final: RECIPIENT,
      viaEscrow: true,
    })
    expect(swapEscrowTarget(swap)).toEqual({
      factory: FACTORY,
      escrow: plan.escrow,
      args: plan.escrowArgs,
    })
  })

  it("regroups the legs of a fresh-address withdrawal", async () => {
    const store = await newStore()
    const GROUP_ID = `0x${"c1".repeat(16)}` as Hex
    const GAS_TX = `0x${"55".repeat(32)}` as Hash
    const source = makeSource([
      { ...EVENTS[0]!, group: { id: GROUP_ID, leg: "funds" } },
      {
        txHash: GAS_TX,
        blockNumber: 18,
        l1Recipient: RECIPIENT,
        amount: 10n ** 18n,
        group: { id: GROUP_ID, leg: "gas" },
      },
      EVENTS[1]!,
    ])

    await rebuildWithdrawals({ source, store, tokenSymbol: "DAI" })

    expect(store.getByL2TxHash(GAS_TX)).toMatchObject({ groupId: GROUP_ID, groupLeg: "gas" })
    expect(store.getByL2TxHash(SWAP_TX)).toMatchObject({
      groupId: GROUP_ID,
      groupLeg: "funds",
      swapEscrow: plan.escrow,
    })
    const direct = store.getByL2TxHash(DIRECT_TX)!
    expect(direct.groupId).toBeUndefined()
    expect(direct.groupLeg).toBeUndefined()
  })

  it("skips a burn whose meta names no L1 address", async () => {
    const store = await newStore()
    const NO_RECIPIENT_TX = `0x${"44".repeat(32)}` as Hash
    const source = makeSource([
      { txHash: NO_RECIPIENT_TX, blockNumber: 15, amount: 10n ** 18n },
      EVENTS[1]!,
    ])

    const rebuilt = await rebuildWithdrawals({ source, store, tokenSymbol: "DAI" })

    expect(rebuilt.map((r) => r.l2TxHash)).toEqual([DIRECT_TX])
    expect(store.getByL2TxHash(NO_RECIPIENT_TX)).toBeNull()
  })

  it("stamps the fallback time on a burn whose block cannot be read, and creates nothing twice", async () => {
    const store = await newStore()
    const source = makeSource(EVENTS, {})
    const first = await rebuildWithdrawals({ source, store, tokenSymbol: "DAI", now: () => 4_242 })
    expect(first.every((r) => r.startTime === 4_242)).toBe(true)

    const again = await rebuildWithdrawals({ source, store, tokenSymbol: "DAI", now: () => 4_242 })
    expect(again).toEqual([])
    expect(store.list()).toHaveLength(3)
  })
})
