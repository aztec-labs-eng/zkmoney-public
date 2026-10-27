/**
 * Process manually: when no relayer ran a refund of an old-version withdrawal, the user sends it from
 * their own L1 wallet. The refund is rebuilt with the same notes, recipient and tip. Only the tip
 * recipient changes, as a relayer would name itself: the proof and the enclave's signature leave it
 * open. The channel's `target` takes the tip, as in `selfFinalize`.
 */
import { toHex, type Address, type Hex } from "viem"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { OldVersionRefund, OldVersionWithdrawal } from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import { usdAtomicFloor } from "../../ui/format"
import {
  desktopBridgeChannel,
  injectedWalletChannel,
  type L1ExitChannel,
  type L1ExitStage,
} from "../deposit/sipaRecovery"
import {
  noteOldVersionWithdrawn,
  openOldVersionExit,
  withdrawableSourceFor,
  type OldVersionExit,
} from "../migration/oldVersionWithdraw"
import { noteSelfRefunded, settleOldVersionWithdrawal } from "./oldVersionWithdrawals"

const ALREADY_RAN =
  "A relayer sent this withdrawal first and the funds have already reached the recipient."

export interface SelfRefundDeps {
  channel: L1ExitChannel
  /** The refund's source, with `tipRecipient` named to take the tip. */
  open: (tipRecipient: Address) => Promise<OldVersionExit>
  /** Reads which refunds ran and saves them; resolves to the record as saved. */
  settle: (id: string) => Promise<OldVersionWithdrawal | null>
  /** Saves `refund` as run by `hash`. */
  saveRun: (id: string, refund: OldVersionRefund, hash: Hex) => Promise<unknown>
}

/** Send `refund` of `record` from the channel's wallet. Resolves to the L1 tx hash. */
export async function selfRefundOldVersionWithdrawal(
  record: OldVersionWithdrawal,
  refund: OldVersionRefund,
  deps: SelfRefundDeps,
): Promise<Hex> {
  const ran = async () =>
    !!(await deps.settle(record.id))?.refunds.find((r) => r.l2TxHash === refund.l2TxHash)?.l1TxHash
  if (await ran()) throw new Error(ALREADY_RAN)
  const exit = await deps.open(deps.channel.target)
  return await exit.lock(async () => {
    const { candidates } = await exit.runtime.candidates({ fresh: true })
    const picked = refund.ids.map((id) => candidates.find((c) => c.id === id))
    if (picked.some((c) => !c)) {
      if (await ran()) throw new Error(ALREADY_RAN)
      throw new Error(
        "This withdrawal's funds can't be refunded right now. Try again in a little while.",
      )
    }
    const kind = picked[0]!.kind
    if (picked.some((c) => c!.kind !== kind)) throw new Error("This refund mixes kinds of funds")
    let hash: Hex
    try {
      const { operation } = await exit.runtime.build(
        { kind, ids: refund.ids },
        record.to as Address,
        WITHDRAW_RELAYER_TIP,
      )
      hash = await deps.channel.sendTransaction(
        operation.target.toString() as Address,
        toHex(operation.calldata),
      )
    } catch (e) {
      // A relayer that ran it after the read fails the rebuild or the gas estimate.
      if (await ran().catch(() => false)) throw new Error(ALREADY_RAN)
      throw e
    }
    if (!(await deps.channel.waitForReceipt(hash))) {
      if (await ran()) throw new Error(ALREADY_RAN)
      throw new Error(
        `Transaction ${hash} reverted, so nothing moved and the withdrawal can still be sent. Try again in a little while.`,
      )
    }
    await deps.saveRun(record.id, refund, hash)
    return hash
  })
}

export interface SelfRefundOptions {
  /** Injected-wallet mode: pins the submitting (and tipped) account to the app's selection. */
  from?: Hex
  onHelperOpened?: (submitUrl: string) => void
  onStage?: (stage: L1ExitStage) => void
}

/**
 * An injected wallet submits and is tipped. The desktop helper page picks its account only after the
 * calldata is built, so there the tip goes to the withdrawal's own recipient.
 */
async function refundChannel(
  record: OldVersionWithdrawal,
  refund: OldVersionRefund,
  opts: SelfRefundOptions,
): Promise<L1ExitChannel> {
  const config = getConfig()
  if (!isDesktopL1SubmitActive())
    return await injectedWalletChannel(config, { from: opts.from, onStage: opts.onStage })
  return desktopBridgeChannel({
    destination: record.to as Address,
    chainId: config.l1ChainId,
    publicClient: l1PublicClient(config),
    display: {
      title: "Send your zk.money withdrawal",
      lines: [
        ["Amount", usdAtomicFloor(BigInt(refund.usd))],
        ["Recipient", record.to],
      ],
    },
    onHelperOpened: opts.onHelperOpened,
    onStage: opts.onStage,
  })
}

/** Send `refund` of `record` over whichever channel this build has. Resolves to the L1 tx hash. */
export async function selfRefundOldVersion(
  record: OldVersionWithdrawal,
  refund: OldVersionRefund,
  opts: SelfRefundOptions = {},
): Promise<Hex> {
  const source = withdrawableSourceFor(refund.portal)
  if (!source)
    throw new Error("Your old version's funds aren't loaded yet. Try again in a little while.")
  const hash = await selfRefundOldVersionWithdrawal(record, refund, {
    channel: await refundChannel(record, refund, opts),
    open: (tipRecipient) => openOldVersionExit(source, tipRecipient),
    settle: (id) => settleOldVersionWithdrawal(id),
    saveRun: noteSelfRefunded,
  })
  // The old version holds less now: Home and Withdraw read it again.
  noteOldVersionWithdrawn()
  return hash
}
