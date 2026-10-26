/**
 * The frozen exit's runtimes and records on this deployment: Main's and Savings' portals, the refund
 * batches as Activity rows, and the open links a complete refund includes.
 */
import { AztecAddress, EthAddress } from "@aztec/aztec.js/addresses"
import { DEFAULT_DECIMALS, WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import {
  createFrozenRefundRuntime,
  isPortalFrozen,
  TokenService,
  type ObsidionAccount,
  type ObsidionWallet,
} from "@obsidion/sdk"
import { isPaylinkTransaction, TransactionStorage } from "@obsidion/front-core"
import { formatUnits, getAddress, parseUnits, type Address, type Hex } from "viem"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { getConfig } from "../../config/env"
import { getOxideTuple, l1PublicClient } from "../../config/oxideTuple"
import { connectSavingsSigner, getSavingsTuple } from "../savings/savingsGateway"
import { currentDeployment, getWithdrawalStore } from "./withdrawGateway"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { getActiveStorageId } from "../../platform/storage/activeStorage"
import { SessionChangedError } from "../../platform/auth/sessionErrors"
import { historicTokenContext } from "../migration/historicTokenContext"
import { frozenSourceReads } from "../migration/frozenSourceReads"

export type FrozenPortalRuntime = Awaited<ReturnType<typeof createFrozenRefundRuntime>>

/**
 * `recipient` is paid each refund and, as its submitter, the deployment's withdrawal subsidy. A
 * runtime without one only reads.
 */
export async function frozenExitRuntime(
  chain: { wallet: ObsidionWallet; account: ObsidionAccount },
  recipient?: Address,
): Promise<FrozenPortalRuntime> {
  const config = getConfig()
  const client = l1PublicClient(config)
  const tuple = await getOxideTuple(config)
  const storageId = getActiveStorageId()
  const masterSecret = await getAuthService().getSecretKey()
  if (!storageId || !masterSecret) throw new SessionChangedError()
  const { tokenService, teeSigner } = await historicTokenContext(chain.wallet, chain.account, tuple)
  return createFrozenRefundRuntime({
    client,
    tuple,
    chain,
    token: await tokenService.getTokenContract(),
    teeSigner,
    ...frozenSourceReads({ chain, tuple, current: tuple, client, masterSecret, storageId }),
    tipRecipient: recipient ? EthAddress.fromString(recipient) : EthAddress.ZERO,
  })
}

/**
 * The Savings portal's runtime, or undefined where the profile lists no Savings or its portal is
 * live. Savings has its own enclave, and refunds pay out its underlying token.
 */
export async function frozenSavingsRuntime(
  chain: { wallet: ObsidionWallet; account: ObsidionAccount },
  recipient?: Address,
): Promise<FrozenPortalRuntime | undefined> {
  const config = getConfig()
  const client = l1PublicClient(config)
  const tuple = await getSavingsTuple(config)
  if (!tuple || !(await isPortalFrozen(client, tuple.portal as Address))) return undefined
  const teeSigner = await connectSavingsSigner(chain.wallet, tuple)
  const tokenService = await TokenService.create(
    chain.wallet,
    chain.account,
    AztecAddress.fromStringUnsafe(tuple.l2Token),
    teeSigner,
  )
  return createFrozenRefundRuntime({
    client,
    tuple,
    chain,
    token: await tokenService.getTokenContract(),
    teeSigner,
    // Savings takes no deposits and opens no links.
    depositDescriptors: async () => [],
    tipRecipient: recipient ? EthAddress.fromString(recipient) : EthAddress.ZERO,
  })
}

/**
 * A refund batch as a settled withdrawal, so Activity and the bell show what left. `usd` is its
 * dollar value where the token is not a dollar.
 */
export async function recordFrozenRefund(o: {
  hash: Hex
  amount: bigint
  to: Address
  usd?: bigint
  symbol?: string
  /** When it landed, ms; now by default. */
  at?: number
}) {
  const now = o.at ?? Date.now()
  await getWithdrawalStore().create({
    localId: refundLocalId(o.hash),
    recipient: getAddress(o.to),
    recipientProvenance: "saved-recipient",
    amount: formatUnits(o.usd ?? o.amount, DEFAULT_DECIMALS),
    rawAmount: o.amount.toString(),
    // Self-submitted: no relayer tip and no cut.
    relayerTip: "0",
    fpcFundingCut: "0",
    tokenSymbol: o.symbol ?? WALLET_TOKEN_SYMBOL,
    phase: "done",
    startTime: now,
    endTime: now,
    l1TxHash: o.hash,
    deployment: await currentDeployment(),
  })
}

/**
 * Records the Main refund batches L1 already paid that this device has no row for: sent before it
 * recorded batches, or from another device.
 */
export async function recordSentFrozenRefunds(runtime: FrozenPortalRuntime) {
  const config = getConfig()
  const client = l1PublicClient(config)
  const tuple = await getOxideTuple(config)
  const store = getWithdrawalStore()
  await store.load()
  const sent = await runtime.refundsSent(client, BigInt(tuple.deployedAtBlock ?? 0))
  for (const { hash, amount, recipient, blockNumber } of sent) {
    if (!recipient || store.get(refundLocalId(hash))) continue
    const { timestamp } = await client.getBlock({ blockNumber })
    await recordFrozenRefund({ hash, amount, to: recipient, at: Number(timestamp) * 1000 })
  }
}

const refundLocalId = (hash: Hex) => `wdraw_refund_${hash.toLowerCase()}`

/** What this browser's open payment links hold, by its rows: what a complete refund includes. */
export async function openLinksHeld(): Promise<bigint> {
  const rows = (await TransactionStorage.get(webStorage).getTransactions()) ?? []
  return rows
    .filter(isPaylinkTransaction)
    .filter(
      (row) =>
        row.emailPaymentAction === "Pay To Email" &&
        row.status === "success" &&
        !row.isClaimed &&
        !row.isRefunded,
    )
    .reduce((sum, row) => sum + parseUnits(String(row.token?.amount ?? 0), DEFAULT_DECIMALS), 0n)
}

/** Whether `record` is a frozen refund batch. */
export const isFrozenRefundRecord = (record: { localId: string }) =>
  record.localId.startsWith("wdraw_refund_")
