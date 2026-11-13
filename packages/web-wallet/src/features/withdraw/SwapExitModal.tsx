/**
 * The two exits from a swap-on-withdraw escrow no relayer is running, behind one surface, the
 * deposit exit's twin: run the swap yourself (the recipient is paid in the chosen asset, the relayer
 * tip comes back) or recover (`recoverERC20` sends the DAI to an Ethereum address). A stuck escrow
 * offers both, swap first; one whose route cannot fill offers recovery alone.
 *
 * In a browser the connected wallet pays the gas; in the desktop launcher the transaction is
 * approved on a helper page in the user's default browser. The recovery's destination is typed and
 * starts as the withdrawal's own recipient — the address the user already chose to be paid at.
 */
import type { Pace } from "@obsidion/core/cadence"
import { useState } from "react"
import exitCopy from "./SwapExitModal.copy"
import { isAddress, type Address, type Hex } from "viem"
import {
  truncateMiddle,
  WalletError,
  type MoveRecord,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import {
  ConfirmationSheetDetailRow,
  DoubleCheckIcon,
  PrimaryGradientButton,
  Spinner,
  TextField,
  TopNavIconButton,
} from "@obsidion/web-ds"
import { l1ChainFor } from "../../config/env"
import { showReportableError } from "../../errors/errorModal"
import { shortL1Addr, usdAtomicFloor } from "../../ui/format"
import { Modal } from "../../ui/Modal"
import { failureCode, fireEvent, lapTimer } from "../../lib/analytics"
import { withdrawKind } from "./withdrawFunnel"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import { HashRow, l1Links, whenLabel } from "../../ui/detailRows"
import { useCopy } from "../../ui/hooks"
import { ScreeningNotice, useScreenedAddress } from "../../ui/screening"
import { waitedLabel } from "../deposit/DepositExitModal/DepositExitModal"
import { isWalletRejection } from "../../session/l1Wallet"
import { useL1Wallet } from "../../session/useL1Wallet"
import { useSession } from "../../session/session"
import type { L1ExitStage } from "../sipa/l1ExitChannels"
import {
  useWalletPrompt,
  useWalletPromptStall,
  WalletPromptOpenError,
} from "../../session/walletPrompt"
import type { WalletPromptToken } from "../../session/walletPrompt"
import { WalletPromptNote } from "../deposit/WalletPromptNote/WalletPromptNote"
import { ExitWalletRow } from "./ExitWalletRow"
import { executeSwapWithdrawal, recoverSwapWithdrawal, type MoveSendWatch } from "./swapRecovery"
import type { SwapExitReason } from "@obsidion/front-core"
import { escrowHeldSymbol, unswappableCopy } from "./unswappableCopy"
import { fmt } from "../../lib/fmt"

/** Which exit the user is running. */
type ExitAction = "execute" | "recover"

const stageLabel = (run: string): Record<ExitAction, Record<L1ExitStage, string>> => ({
  execute: {
    "signing": `Approve the ${run} in your wallet`,
    "awaiting-browser": `Approve the ${run} in your browser`,
    "confirming": "Waiting for Ethereum confirmation",
  },
  recover: {
    "signing": "Approve the recovery in your wallet",
    "awaiting-browser": "Approve the recovery in your browser",
    "confirming": "Waiting for Ethereum confirmation",
  },
})

const EXECUTE_COPY =
  "No relayer has run this swap. You can run it yourself: the recipient is paid in the asset you chose, the tip this withdrawal set aside for whoever runs it comes back to your wallet, and you pay only the gas. If a relayer gets there first this transaction completes without doing anything."

const RECOVER_SECONDARY_COPY = "Or send the DAI to an Ethereum address instead of swapping it."

export function SwapExitModal({
  record,
  reason,
  linkFragment,
  move,
  pace,
  onClose,
}: {
  reason: SwapExitReason
  /** A paylink visitor's cash-out: the recipient's wallet signs the recovery. */
  linkFragment?: string
  /** The page's: the L1 receipt wait polls at its interval. */
  pace: Pick<Pace, "foreignMs">
  onClose: () => void
} & (
  | { record: WithdrawalRecord; move?: undefined }
  | {
      /** The move's burn, when this device made it. */
      record?: WithdrawalRecord
      /**
       * A stalled Savings move: `run` once its release funded the escrow, which goes on to the
       * move's destination; recovery sends the escrow's DAI back to L1.
       */
      move: { record: MoveRecord; run: boolean }
    }
)) {
  const session = useSession()
  const { config } = session.page
  const { l1TxUrl } = l1Links(config)
  const bridgeMode = isDesktopL1SubmitActive()
  const l1 = useL1Wallet({ expectedChainId: config.l1ChainId, rpcUrl: config.l1RpcUrl })
  const { copied, copy } = useCopy()
  const swap = move ? undefined : record
  const moved = move?.record
  // The tracker may park the escrow `recoverable` while the sheet is open; a swap sent then reverts.
  const canExecute = move ? move.run : reason === "stuck" && swap?.phase === "swapping"
  // A move's burn paid its escrow, so there is no recipient of its own to recover to.
  const moveTo = moved?.direction === "in" ? "Savings" : "Main Account"
  const moveValue = moved && (moved.direction === "in" ? moved.amount : moved.quote?.expectedOut)
  const moveEscrow = moved?.rail === "skyEscrow" ? moved.escrow.address : undefined
  const held = swap ? escrowHeldSymbol(swap) : "DAI"

  const [destination, setDestination] = useState<string>(swap?.recipient ?? "")
  const [phase, setPhase] = useState<"form" | "working" | "done">("form")
  const [action, setAction] = useState<ExitAction>(canExecute ? "execute" : "recover")
  const [stage, setStage] = useState<L1ExitStage>()
  const [submitUrl, setSubmitUrl] = useState<string>()
  const [txHash, setTxHash] = useState<Hex>()
  const [refused, setRefused] = useState<string>()
  const prompt = useWalletPrompt()
  const stalled = useWalletPromptStall(phase === "working" && stage === "signing")
  // Back to the form; the transaction the wallet still holds is handled when it answers.
  const cancelPrompt = () => {
    prompt.cancel()
    setStage(undefined)
    setPhase("form")
  }

  const typedValid = isAddress(destination)
  const target = typedValid ? (destination as Address) : null
  // The recovered-to address is screened like the recipient was at withdraw time.
  const { verdict, cleared, rescreen } = useScreenedAddress(target, "withdraw")
  const amount = swap
    ? `${swap.amount} ${swap.tokenSymbol}`
    : moveValue !== undefined
    ? usdAtomicFloor(moveValue)
    : "the move's funds"
  const connected = bridgeMode || (!!l1.account && !l1.wrongChain)
  const readyToExecute = connected
  const readyToRecover = connected && !!target && cleared
  const startedAt = record?.startTime ?? moved?.startTime ?? 0
  const enteredAt = record?.phaseEnteredAt ?? startedAt

  /**
   * The move's run or recovery, with the account's keys; each opens its own L1 channel, which
   * reports to `watch`.
   */
  const exitMove = async (
    record: MoveRecord,
    next: ExitAction,
    to: Address | null,
    watch: MoveSendWatch,
  ) => {
    const moves = await session.moveCommands?.ready()
    if (!moves) throw new WalletError("account.locked", "moves need a signed-in account")
    if (next === "execute") return moves.run(record.id, watch)
    if (!to) throw new WalletError("invariant", "a recovery needs an address")
    return moves.recover(record.id, to, watch)
  }

  const send = (next: ExitAction, opts: Parameters<typeof executeSwapWithdrawal>[1]) => {
    if (swap)
      return next === "recover"
        ? recoverSwapWithdrawal(swap, opts)
        : executeSwapWithdrawal(swap, opts)
    if (!moved) throw new WalletError("invariant", "an exit needs a withdrawal or a move")
    return exitMove(moved, next, target, { ...opts, burn: record })
  }

  const submit = async (next: ExitAction) => {
    if (prompt.openElsewhere) {
      setRefused(prompt.openElsewhere)
      return
    }
    setAction(next)
    setRefused(undefined)
    setPhase("working")
    setStage(undefined)
    setSubmitUrl(undefined)
    const elapsed = lapTimer()
    let request: WalletPromptToken | undefined
    const opts = {
      wagmi: l1.wagmi,
      destination: target ?? undefined,
      from: l1.account ?? undefined,
      linkFragment,
      session,
      onHelperOpened: setSubmitUrl,
      pace,
      // Confirming means the wallet answered; the slot frees before the receipt lands.
      onStage: (next: L1ExitStage) => {
        setStage(next)
        if (next === "confirming") prompt.settle(request)
      },
    }
    try {
      request = prompt.begin()
      const hash = await send(next, opts)
      setTxHash(hash)
      setPhase("done")
      // Reason and timing only — the addresses are as identifying as the withdrawal itself.
      fireEvent(next === "execute" ? "withdrawal_swap_executed" : "withdrawal_swap_recovered", {
        duration_ms: elapsed(),
        reason,
        kind: swap ? withdrawKind(swap) : "savings",
      })
    } catch (e) {
      setPhase("form")
      if (e instanceof WalletPromptOpenError) {
        // eslint-disable-next-line local/message-in-state -- debt
        setRefused(e.message)
        return
      }
      if (prompt.cancelled(request) || isPasskeyCancelled(e) || isWalletRejection(e)) return
      const scope = next === "execute" ? "withdrawal:swap-execute" : "withdrawal:swap-recover"
      fireEvent("action_failed", { action: scope, code: failureCode(e) })
      showReportableError(e, next === "execute" ? "withdrawal:swap" : "withdrawal:recovery", {
        title: next === "execute" ? (move ? "Move failed" : "Swap failed") : "Recovery failed",
      })
    } finally {
      prompt.settle(request)
    }
  }

  const title = move
    ? phase === "done"
      ? action === "execute"
        ? exitCopy.moveSent
        : "Move recovered"
      : "Move taking too long"
    : phase === "done"
    ? action === "execute"
      ? "Swap complete"
      : "Withdrawal recovered"
    : canExecute
    ? "Swap taking too long"
    : "Recover withdrawal"

  return (
    <Modal variant="bare" label={title} onClose={phase === "working" ? undefined : onClose}>
      <>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <span className="zkm-type-title-sm" style={{ color: "var(--text-primary)" }}>
            {title}
          </span>
          {phase !== "working" && <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />}
        </div>

        {phase === "form" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <p style={{ color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.5, margin: 0 }}>
              {move
                ? move.run
                  ? fmt(exitCopy.moveRun, { to: moveTo })
                  : exitCopy.moveRecover
                : swap && (canExecute ? EXECUTE_COPY : unswappableCopy(swap))}
            </p>

            {!bridgeMode && <ExitWalletRow l1={l1} chainName={config.l1Chain.name} />}
            {refused && (
              <p role="alert" className="ww-sheet__note" data-testid="swap-exit-refused">
                {refused}
              </p>
            )}

            <div>
              <ConfirmationSheetDetailRow label="Amount" value={amount} />
              <ConfirmationSheetDetailRow label={exitCopy.started} value={whenLabel(startedAt)} />
              <ConfirmationSheetDetailRow
                label="Waiting"
                value={waitedLabel(Date.now() - enteredAt)}
              />
              {(moveEscrow ?? swap?.swapEscrow) && (
                <ConfirmationSheetDetailRow
                  label="Escrow"
                  value={shortL1Addr(moveEscrow ?? swap!.swapEscrow!)}
                />
              )}
              {swap ? (
                <ConfirmationSheetDetailRow
                  label="Recipient"
                  value={`${swap.swapOutput} to ${
                    swap.recipientAlias ?? truncateMiddle(swap.recipient, 12)
                  }`}
                />
              ) : (
                <ConfirmationSheetDetailRow label={exitCopy.to} value={moveTo} />
              )}
              <ConfirmationSheetDetailRow
                label="Network"
                value={l1ChainFor(config.l1ChainId).name}
              />
            </div>

            {canExecute && (
              <PrimaryGradientButton
                title={move ? exitCopy.runMove : exitCopy.runSwap}
                isDisabled={!readyToExecute}
                onClick={() => void submit("execute")}
              />
            )}

            {canExecute && (
              <p
                style={{ color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.5, margin: 0 }}
              >
                {move ? exitCopy.moveRecoverInstead : RECOVER_SECONDARY_COPY}
              </p>
            )}
            <TextField
              label={`Recover ${held} to`}
              placeholder="0x…"
              value={destination}
              onChange={setDestination}
              error={destination && !typedValid ? "That isn't a valid Ethereum address" : undefined}
            />
            <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
              Anyone can submit the transaction, but only this address receives the {held}, so check
              it carefully.
            </span>
            {target && !cleared && (
              <ScreeningNotice
                verdict={verdict}
                checkingCopy="Checking address…"
                blockedFallback="This address can't be used here. Use a different one."
                errorCopy="Couldn't verify this address. Check your internet connection or try another address."
                onRetry={rescreen}
              />
            )}
            <PrimaryGradientButton
              title={target ? `Recover ${held} to ${shortL1Addr(target)}` : `Recover ${held}`}
              buttonStyle={canExecute ? "secondary" : undefined}
              isDisabled={!readyToRecover}
              onClick={() => void submit("recover")}
            />
          </div>
        )}

        {phase === "working" && (
          <div style={{ padding: "24px 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Spinner size={20} />
              <span style={{ fontSize: 15 }}>
                {stage ? stageLabel(move ? "move" : "swap")[action][stage] : "Preparing…"}
              </span>
            </div>
            {stalled && <WalletPromptNote walletName={l1.walletName} onCancel={cancelPrompt} />}
            {stage === "awaiting-browser" && submitUrl && (
              <p
                style={{
                  color: "var(--text-secondary)",
                  fontSize: 13,
                  lineHeight: 1.5,
                  margin: "12px 0 0 32px",
                }}
              >
                A page opened in your regular browser at{" "}
                <span style={{ fontFamily: "monospace" }}>{submitUrl}</span>. If nothing appeared,{" "}
                <span
                  role="button"
                  onClick={() => copy(submitUrl)}
                  style={{ color: "var(--accent-green, #6c9)", cursor: "pointer" }}
                >
                  {copied ? "copied" : "copy link"}
                </span>{" "}
                and open it there yourself.
              </p>
            )}
          </div>
        )}

        {phase === "done" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ textAlign: "center", padding: "16px 0 0" }}>
              <DoubleCheckIcon size={40} />
              <p
                style={{
                  color: "var(--text-secondary)",
                  fontSize: 14,
                  lineHeight: 1.45,
                  margin: "12px 0 0",
                }}
              >
                {action === "execute" && swap
                  ? `Swapped to ${swap.swapOutput} and sent to ${
                      swap.recipientAlias ?? truncateMiddle(swap.recipient, 12)
                    }.`
                  : action === "execute"
                  ? fmt(exitCopy.moveSentTo, { to: moveTo })
                  : `${amount} sent to ${target ? shortL1Addr(target) : "the address you chose"}.`}
              </p>
            </div>
            {txHash && <HashRow label="Transaction ID" hash={txHash} url={l1TxUrl(txHash)} />}
            <PrimaryGradientButton title="Done" onClick={onClose} />
          </div>
        )}
      </>
    </Modal>
  )
}
