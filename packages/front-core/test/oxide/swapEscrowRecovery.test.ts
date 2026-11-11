import { memoryBackend } from "../../src/engine/memoryBackend"
import { openDatabase } from "../../src/engine/database"
import { describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { escrowERC20RecoveryDigest } from "@oxide/l1-contracts/escrow.js"
import { SwapEscrowAbi } from "@oxide/l1-contracts"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import {
  acrossBridgeEscrowArgs,
  encodeAcrossBridgeEscrowDeploy,
  encodeSwapEscrowExecute,
  predictAcrossBridgeEscrowAddressLocally,
  predictSwapEscrow,
} from "@obsidion/sdk"
import { decodeFunctionData, multicall3Abi, type Address, type Hex } from "viem"
import { runSwapEscrowExecute, runSwapEscrowRecovery } from "../../src/oxide/swapEscrowRecovery"
import { createWithdrawals } from "../../src/engine/withdrawals"
import type { WithdrawalRecord } from "../../src/core/services/bridge/types"
import type { OnNetwork } from "../../src/types/networkStamp"

const FACTORY = "0xfafafafafafafafafafafafafafafafafafafafa"
const RECOVERY = {
  account: "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a",
  salt: new Fr(0x5a17n),
} as const
const COMMITMENT = deriveRecoveryCommitment(
  RECOVERY.salt,
  EthAddress.fromString(RECOVERY.account),
).toString()
const SIGNATURE = `0x${"cd".repeat(65)}`
const RECIPIENT = "0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0"
const TARGET = "0x2e45a4e5d9100a4e8cb94f81257b5a1eba05a29b"
const DAI = "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b"
const NONCE = `0x${"77".repeat(32)}`
const L2TX = `0x${"11".repeat(32)}`
const HASH = `0x${"ab".repeat(32)}`
const CHAIN_NOW = 1_800_000_000n
const DEADLINE = 1_800_003_600n
const RECOVERY_NONCE = `0x${"07".repeat(32)}` as const

const ARGS = {
  route: 0,
  recipient: RECIPIENT,
  recoveryCommitment: COMMITMENT as Hex,
  relayerTip: 5000000000000000000n,
  nonce: NONCE as Hex,
}
const COMMITTED = { layout: "legacy", args: ARGS } as const
const ESCROW = predictSwapEscrow(FACTORY, COMMITTED)

/** A bridge-out to USDC on Base, refunded by Across after its escrow ran. */
const ACROSS_ARGS = acrossBridgeEscrowArgs("USDC", 8453, {
  recipient: RECIPIENT,
  acrossFee: 250_000n,
  recoveryCommitment: COMMITMENT as Hex,
  relayerTip: 2n * 10n ** 18n,
  nonce: NONCE as Hex,
})!
const BRIDGE_ESCROW = predictAcrossBridgeEscrowAddressLocally(FACTORY, ACROSS_ARGS)
const REFUNDED_BRIDGE = {
  localId: "w1",
  l2TxHash: L2TX,
  phase: "recoverable",
  reorgEpoch: 2,
  recipient: RECIPIENT,
  swapOutput: "USDC",
  swapEscrow: BRIDGE_ESCROW,
  swapEscrowFactory: FACTORY,
  swapExecuteTxHash: HASH,
  bridgeOut: {
    provider: "across" as const,
    chainId: 8453,
    chainName: "Base",
    minReceived: "98000000",
    acrossFee: "250000",
    nonce: NONCE,
    recoveryCommitment: COMMITMENT,
    relayerTip: "2000000000000000000",
  },
}

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"

const lower = (values: readonly unknown[]) =>
  values.map((v) => (typeof v === "string" ? v.toLowerCase() : v))

/**
 * The `recoverERC20` a sent call makes, on the escrow or after its deploy in a Multicall3;
 * addresses lowercased.
 */
function recoveryOf(to: string, data: Hex) {
  if (to !== MULTICALL3) {
    const { args } = decodeFunctionData({ abi: SwapEscrowAbi, data })
    return { escrow: to.toLowerCase(), args: lower(args) }
  }
  const [calls] = decodeFunctionData({ abi: multicall3Abi, data }).args as readonly [
    readonly { target: Address; callData: Hex }[],
  ]
  const recover = decodeFunctionData({ abi: SwapEscrowAbi, data: calls[1]!.callData })
  return {
    deploy: calls[0]!.target.toLowerCase(),
    escrow: calls[1]!.target.toLowerCase(),
    args: lower(recover.args),
  }
}

async function makeDeps(overrides: Record<string, unknown> = {}) {
  const store = createWithdrawals({ db: openDatabase(memoryBackend()), now: () => Date.now() })
  const reader = {
    tokenBalance: vi.fn(async () => 95n * 10n ** 18n),
    isDeployed: vi.fn(async () => false),
  }
  const channel = {
    sendTransaction: vi.fn(async () => HASH),
    waitForReceipt: vi.fn(async () => true),
  }
  const signAccount = vi.fn(async () => SIGNATURE)
  const deps = {
    record: {
      localId: "w1",
      l2TxHash: L2TX,
      phase: "recoverable",
      reorgEpoch: 2,
      recipient: RECIPIENT,
      swapOutput: "USDC",
      swapEscrow: ESCROW,
      swapEscrowFactory: FACTORY,
      swapNonce: NONCE,
      swapRecoveryCommitment: COMMITMENT,
      swapRelayerTip: "5000000000000000000",
    },
    channel,
    reader,
    store,
    recovery: RECOVERY,
    signAccount,
    target: TARGET,
    dai: DAI,
    chainId: 11155111,
    makeNonce: () => new Uint8Array(32).fill(7),
    chainNow: async () => CHAIN_NOW,
    ...overrides,
  }
  const seeded = { amount: "95", tokenSymbol: "DAI", tokenDecimals: 18, startTime: 1 }
  await store.create({
    ...seeded,
    ...deps.record,
    networkId: "0xnet",
  } as OnNetwork<WithdrawalRecord>)
  return { deps: deps as never, store, reader, channel, signAccount }
}

describe("runSwapEscrowExecute", () => {
  it("submits factory.deployAndExecute for the record's args and settles the record done", async () => {
    const { deps, store, channel } = await makeDeps()
    await expect(runSwapEscrowExecute(deps)).resolves.toBe(HASH)
    expect(channel.sendTransaction).toHaveBeenCalledWith(FACTORY, encodeSwapEscrowExecute(COMMITTED))
    expect(await store.get(L2TX)).toMatchObject({
      phase: "done",
      swapExecuteTxHash: HASH,
      reorgEpoch: 2,
    })
  })

  it("runs a bridge-out's escrow and leaves it bridging until its fill", async () => {
    const { swapExecuteTxHash: _, ...record } = { ...REFUNDED_BRIDGE, phase: "swapping" }
    const { deps, store, channel } = await makeDeps({ record })
    await runSwapEscrowExecute(deps)
    expect(channel.sendTransaction).toHaveBeenCalledWith(
      FACTORY,
      encodeAcrossBridgeEscrowDeploy(ACROSS_ARGS),
    )
    expect(await store.get(L2TX)).toMatchObject({ phase: "bridging", swapExecuteTxHash: HASH })
  })

  it("refuses an emptied escrow before any wallet prompt", async () => {
    const { deps, channel, reader } = await makeDeps()
    reader.tokenBalance.mockResolvedValue(0n)
    await expect(runSwapEscrowExecute(deps)).rejects.toThrow(/already completed/)
    expect(channel.sendTransaction).not.toHaveBeenCalled()
  })

  it("refuses a record that cannot rebuild its args", async () => {
    const { deps: base } = await makeDeps()
    const record = { ...(base as { record: object }).record, swapRecoveryCommitment: undefined }
    const { deps, channel } = await makeDeps({ record })
    await expect(runSwapEscrowExecute(deps)).rejects.toThrow(/weren't stored/)
    expect(channel.sendTransaction).not.toHaveBeenCalled()
  })

  it("leaves the record alone when the transaction reverts", async () => {
    const { deps, store, channel } = await makeDeps()
    channel.waitForReceipt.mockResolvedValue(false)
    await expect(runSwapEscrowExecute(deps)).rejects.toThrow(/reverted/)
    expect((await store.get(L2TX))?.phase).toBe("recoverable")
  })
})

describe("runSwapEscrowRecovery", () => {
  it("signs the escrow's recovery digest as the recovery account, deploys and recovers, and flips the record to recovered", async () => {
    const { deps, store, channel, signAccount } = await makeDeps()
    await expect(runSwapEscrowRecovery(deps)).resolves.toBe(HASH)

    expect(signAccount).toHaveBeenCalledWith(
      RECOVERY.account,
      escrowERC20RecoveryDigest(ESCROW, 11155111n, TARGET, DAI, RECOVERY_NONCE, DEADLINE),
    )
    const [to, data] = channel.sendTransaction.mock.calls[0] as unknown as [string, Hex]
    const sent = recoveryOf(to, data)
    expect(sent).toMatchObject({ deploy: FACTORY, escrow: ESCROW.toLowerCase() })
    expect(sent.args.slice(2)).toEqual([SIGNATURE, TARGET, DAI, RECOVERY_NONCE, DEADLINE])
    expect(await store.get(L2TX)).toMatchObject({
      phase: "recovered",
      recoveryTxHash: HASH,
      recoveryTarget: TARGET,
      reorgEpoch: 2,
    })
  })

  it("recovers a refunded bridge-out's input token from its deployed escrow", async () => {
    const { deps, store, channel, reader, signAccount } = await makeDeps({
      record: REFUNDED_BRIDGE,
    })
    reader.isDeployed.mockResolvedValue(true)
    await expect(runSwapEscrowRecovery(deps)).resolves.toBe(HASH)

    const usdc = ACROSS_ARGS.acrossInputToken
    expect(reader.tokenBalance).toHaveBeenCalledWith(usdc, BRIDGE_ESCROW)
    expect(signAccount).toHaveBeenCalledWith(
      RECOVERY.account,
      escrowERC20RecoveryDigest(BRIDGE_ESCROW, 11155111n, TARGET, usdc, RECOVERY_NONCE, DEADLINE),
    )
    const [to, data] = channel.sendTransaction.mock.calls[0] as unknown as [string, Hex]
    expect(recoveryOf(to, data)).toEqual({
      escrow: BRIDGE_ESCROW.toLowerCase(),
      args: lower([
        RECOVERY.salt.toString(),
        RECOVERY.account,
        SIGNATURE,
        TARGET,
        usdc,
        RECOVERY_NONCE,
        DEADLINE,
      ]),
    })
    expect((await store.get(L2TX))?.phase).toBe("recovered")
  })

  it.each([
    ["account", { ...RECOVERY, account: TARGET }],
    ["salt", { ...RECOVERY, salt: new Fr(0x5a18n) }],
  ])("fails closed on a %s that does not open the committed recovery", async (_, recovery) => {
    const { deps, channel, reader, signAccount } = await makeDeps({ recovery })
    await expect(runSwapEscrowRecovery(deps)).rejects.toThrow(
      "This wallet's account is not the recovery account of this withdrawal's escrow",
    )
    expect(reader.tokenBalance).not.toHaveBeenCalled()
    expect(signAccount).not.toHaveBeenCalled()
    expect(channel.sendTransaction).not.toHaveBeenCalled()
  })

  it("surfaces a signer refusal without submitting", async () => {
    const { deps, store, channel, signAccount } = await makeDeps()
    signAccount.mockRejectedValue(
      new Error("Finish setting up your account's passkey, then try again"),
    )
    await expect(runSwapEscrowRecovery(deps)).rejects.toThrow(/passkey/)
    expect(channel.sendTransaction).not.toHaveBeenCalled()
    expect((await store.get(L2TX))?.phase).toBe("recoverable")
  })

  it("refuses an emptied escrow before any wallet prompt", async () => {
    const { deps, channel, reader, signAccount } = await makeDeps()
    reader.tokenBalance.mockResolvedValue(0n)
    await expect(runSwapEscrowRecovery(deps)).rejects.toThrow(/already completed/)
    expect(signAccount).not.toHaveBeenCalled()
    expect(channel.sendTransaction).not.toHaveBeenCalled()
  })

  it("leaves the record alone when the transaction reverts", async () => {
    const { deps, store, channel } = await makeDeps()
    channel.waitForReceipt.mockResolvedValue(false)
    await expect(runSwapEscrowRecovery(deps)).rejects.toThrow(/reverted/)
    expect((await store.get(L2TX))?.phase).toBe("recoverable")
  })
})
