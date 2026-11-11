// @vitest-environment node
/** A bridge-out's run deposits to the bridge: the record bridges until the fill or refund lands. */
import { describe, expect, it, vi } from "vitest"
import { TxStatus } from "@aztec-labs/stdlib/tx"
import type { Address, Hex } from "viem"
import {
  acrossBridgeEscrowArgs,
  encodeAcrossBridgeEscrowDeploy,
  predictAcrossBridgeEscrowAddressLocally,
  type SwapEscrowReader,
  type WithdrawalFinalizationReader,
} from "@obsidion/sdk"
import { canRecoverSwap } from "../../src/core/services/bridge/withdrawalPhases"
import type { WithdrawalDeployment, WithdrawalRecord } from "../../src/core/services/bridge/types"
import type { BridgeInStatus } from "../../src/core/services/crossChain/types"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { memoryStore } from "../../src/engine/store"
import { createWithdrawals, type Withdrawals } from "../../src/engine/withdrawals"
import {
  withdrawalStepper,
  type TrackerWiring,
  type WithdrawalTrackerNode,
} from "../../src/engine/withdrawalTracker"
import type { OnNetwork } from "../../src/types/networkStamp"

const L2TX_1 = ("0x" + "11".repeat(32)) as Hex
const WID_1 = ("0x" + "ab".repeat(32)) as Hex
const FACTORY = `0x${"fa".repeat(20)}` as Address
const RECIPIENT = "0x1234567890abcdef1234567890abcdef12345678" as Address
const BRIDGE_OUT = {
  provider: "across" as const,
  chainId: 8453,
  chainName: "Base",
  minReceived: "499000000",
  acrossFee: "500000",
  nonce: `0x${"0a".repeat(32)}` as Hex,
  recoveryCommitment: `0x${"0c".repeat(32)}` as Hex,
  relayerTip: "1",
}
const ACROSS_ARGS = acrossBridgeEscrowArgs("USDC", 8453, {
  recipient: RECIPIENT,
  acrossFee: 500_000n,
  recoveryCommitment: BRIDGE_OUT.recoveryCommitment,
  relayerTip: 1n,
  nonce: BRIDGE_OUT.nonce,
})!
const ESCROW = predictAcrossBridgeEscrowAddressLocally(FACTORY, ACROSS_ARGS)
const EXEC_TX = ("0x" + "5e".repeat(32)) as Hex

const DEPLOYMENT: WithdrawalDeployment = {
  portal: ("0x" + "aa".repeat(20)) as Hex,
  // Parsed as an AztecAddress, so it must sit below the field modulus.
  l2Token: "0x" + "0b".repeat(32),
}

/** The tracker's pass over `store` on the live deployment; each `syncOnce` runs one. */
function stepper({ store, ...wiring }: Partial<TrackerWiring> & { store: Withdrawals }) {
  const full = {
    deployment: DEPLOYMENT,
    withdrawalIds: (async () => [
      { withdrawalId: { toString: () => WID_1 } },
    ]) as unknown as TrackerWiring["withdrawalIds"],
    live: memoryStore<ReadonlySet<string>>(new Set()).readonly,
    ...wiring,
  } as TrackerWiring
  return { syncOnce: withdrawalStepper(store, full, () => Date.now()) }
}

function makeReader(
  overrides: Partial<WithdrawalFinalizationReader> = {},
): WithdrawalFinalizationReader {
  return {
    isSpent: vi.fn(async () => false),
    resolveL1TxHash: vi.fn(async () => undefined),
    ...overrides,
  }
}

/** A funded escrow whose swap fills: the state right after the release. */
function makeEscrowReader(): SwapEscrowReader {
  return {
    daiBalance: vi.fn(async () => 95n * 10n ** 18n),
    tokenBalance: vi.fn(async () => 0n),
    isDeployed: vi.fn(async () => false),
    deploySimulates: vi.fn(async () => true),
    executedTxHash: vi.fn(async () => undefined),
    recoveredTxHash: vi.fn(async () => undefined),
  }
}

function makeNode(status: TxStatus): WithdrawalTrackerNode {
  return { getTxReceipt: vi.fn(async () => ({ status })) } as unknown as WithdrawalTrackerNode
}

async function seedStore(): Promise<Withdrawals> {
  const store = createWithdrawals({ db: openDatabase(memoryBackend()), now: () => Date.now() })
  await store.ready
  return store
}

function submittingRecord(localId: string): OnNetwork<WithdrawalRecord> {
  return {
    localId,
    networkId: "0xnet",
    recipient: RECIPIENT,
    recipientProvenance: "saved-recipient",
    amount: "1.0",
    tokenSymbol: "DAI",
    tokenDecimals: 18,
    phase: "submitting",
    startTime: 1_700_000_000_000,
  }
}

describe("withdrawal tracker bridge-out", () => {
  const FILL_TX = `0x${"f1".repeat(32)}` as Hex
  const bridgeOut = BRIDGE_OUT

  /** A bridge-out released to its escrow, tracked with `reader` and the bridge's `status`. */
  async function releasedBridge(
    reader: SwapEscrowReader,
    status: () => Promise<BridgeInStatus | undefined> = async () => ({ status: "pending" }),
    fill: (
      chainId: number,
      fillTxHash: Hex,
      recipient: Address,
    ) => Promise<bigint | undefined> = async () => undefined,
  ) {
    const store = await seedStore()
    await store.create({
      ...submittingRecord("w1"),
      swapOutput: "USDC",
      swapEscrow: ESCROW,
      swapEscrowFactory: FACTORY,
      bridgeOut,
    })
    await store.apply("w1", {
      type: "mined",
      l2TxHash: L2TX_1,
      blockNumber: 100,
      rawAmount: "1000000",
    })
    const provider = { id: "across" as const, status: vi.fn(status), fill: vi.fn(fill) }
    const tracker = stepper({
      store,
      node: makeNode(TxStatus.PROVEN),
      finalizationReader: makeReader({ isSpent: vi.fn(async () => true) }),
      swapEscrowReader: reader,
      bridgeOut: (id) => (id === "across" ? provider : null),
    })
    await tracker.syncOnce()
    await tracker.syncOnce()
    return { store, tracker, provider }
  }

  /** A bridge-out released to its escrow, whose run then empties it. */
  async function ranBridge(
    status: () => Promise<BridgeInStatus | undefined>,
    fill?: (chainId: number, fillTxHash: Hex, recipient: Address) => Promise<bigint | undefined>,
  ) {
    const reader = makeEscrowReader()
    const ran = await releasedBridge(reader, status, fill)
    ;(reader.daiBalance as ReturnType<typeof vi.fn>).mockResolvedValue(0n)
    ;(reader.isDeployed as ReturnType<typeof vi.fn>).mockResolvedValue(true)
    ;(reader.executedTxHash as ReturnType<typeof vi.fn>).mockResolvedValue(EXEC_TX)
    await ran.tracker.syncOnce()
    return { ...ran, reader }
  }

  it("a run deposits to the bridge: bridging until the fill lands, then done with the fill", async () => {
    let filled = false
    const { store, tracker, provider } = await ranBridge(async () =>
      filled ? { status: "filled", fillTxHash: FILL_TX } : { status: "pending" },
    )
    expect(await store.get("w1")).toMatchObject({
      phase: "bridging",
      swapExecuteTxHash: EXEC_TX,
    })
    expect(provider.status).toHaveBeenCalledWith(EXEC_TX)

    filled = true
    await tracker.syncOnce()
    expect(await store.get("w1")).toMatchObject({
      phase: "done",
      bridgeOut: { ...bridgeOut, fillTxHash: FILL_TX },
    })
  })

  it("stays bridging until the fill's amount is read", async () => {
    const fill = vi.fn(async () => 499_500_000n)
    fill.mockRejectedValueOnce(new Error("rpc down"))
    const { store, tracker } = await ranBridge(
      async () => ({ status: "filled", fillTxHash: FILL_TX }),
      fill,
    )
    expect((await store.get("w1"))?.phase).toBe("bridging")
    await tracker.syncOnce()
    expect(await store.get("w1")).toMatchObject({
      phase: "done",
      bridgeOut: { fillTxHash: FILL_TX, filledAmount: "499500000" },
    })
  })

  it("a refunded deposit parks recoverable with a leg to recover, until the recovery empties it", async () => {
    const { store, tracker, reader } = await ranBridge(async () => ({ status: "refunded" }))
    const parked = (await store.get("w1"))!
    expect(parked.phase).toBe("recoverable")
    expect(canRecoverSwap(parked)).toBe(true)

    // The refund sits at the escrow in the bridge's input token; the record stays parked.
    await tracker.syncOnce()
    expect(await store.get("w1")).toMatchObject({
      phase: "recoverable",
      phaseEnteredAt: parked.phaseEnteredAt,
    })
    ;(reader.recoveredTxHash as ReturnType<typeof vi.fn>).mockResolvedValue({
      txHash: FILL_TX,
      target: RECIPIENT,
    })
    await tracker.syncOnce()
    expect(await store.get("w1")).toMatchObject({
      phase: "recovered",
      recoveryTxHash: FILL_TX,
      recoveryTarget: RECIPIENT,
    })
  })

  it("a funded escrow whose run reverts parks recoverable, simulated with its own factory's run", async () => {
    const reader = makeEscrowReader()
    ;(reader.deploySimulates as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    const { store } = await releasedBridge(reader)
    expect((await store.get("w1"))?.phase).toBe("recoverable")
    expect(reader.deploySimulates).toHaveBeenCalledWith(
      FACTORY,
      encodeAcrossBridgeEscrowDeploy(ACROSS_ARGS),
      RECIPIENT,
    )
  })
})
