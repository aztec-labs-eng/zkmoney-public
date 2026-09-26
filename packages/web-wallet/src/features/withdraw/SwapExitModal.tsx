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
import { useState } from "react"
import { isAddress, type Address, type Hex } from "viem"
import { truncateMiddle, type WithdrawalRecord } from "@obsidion/front-core"
import {
  ConfirmationSheetDetailRow,
  DoubleCheckIcon,
  PrimaryGradientButton,
  Spinner,
  TextField,
  TopNavIconButton,
} from "@obsidion/web-ds"
import { getConfig, l1ChainFor } from "../../config/env"
import { showReportableError } from "../../errors/errorModal"
import { Modal } from "../../ui/Modal"
import { failureCode, fireEvent, lapTimer } from "../../lib/analytics"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import { HashRow, l1TxUrl, whenLabel } from "../../ui/detailRows"
import { useCopy } from "../../ui/hooks"
import { ScreeningNotice, useScreenedAddress } from "../../ui/screening"
import { waitedLabel } from "../deposit/DepositExitModal"
import { useL1Wallet } from "../deposit/l1Wallet"
import type { L1ExitStage } from "../deposit/sipaRecovery"
import { executeSwapWithdrawal, recoverSwapWithdrawal, type SwapExitReason } from "./swapRecovery"
import { unswappableCopy } from "./unswappableCopy"

/** Which exit the user is running. */
type ExitAction = "execute" | "recover"

const STAGE_LABEL: Record<ExitAction, Record<L1ExitStage, string>> = {
  execute: {
    "signing": "Approve the swap in your wallet",
    "awaiting-browser": "Approve the swap in your browser",
    "confirming": "Waiting for L1 confirmation",
  },
  recover: {
    "signing": "Approve the recovery in your wallet",
    "awaiting-browser": "Approve the recovery in your browser",
    "confirming": "Waiting for L1 confirmation",
  },
}

const EXECUTE_COPY =
  "No relayer has run this swap. You can run it yourself: the recipient is paid in the asset you chose, the tip this withdrawal set aside for whoever runs it comes back to your wallet, and you pay only the gas. If a relayer gets there first this transaction completes without doing anything."

const RECOVER_SECONDARY_COPY = "Or send the DAI to an Ethereum address instead of swapping it."

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export function SwapExitModal({
  record,
  reason,
  onClose,
}: {
  record: WithdrawalRecord
  reason: SwapExitReason
  onClose: () => void
}) {
  const config = getConfig()
  const bridgeMode = isDesktopL1SubmitActive()
  const l1 = useL1Wallet({ expectedChainId: config.l1ChainId, rpcUrl: config.l1RpcUrl })
  const { copied, copy } = useCopy()
  const canExecute = reason === "stuck"

  const [destination, setDestination] = useState<string>(record.recipient)
  const [phase, setPhase] = useState<"form" | "working" | "done">("form")
  const [action, setAction] = useState<ExitAction>(canExecute ? "execute" : "recover")
  const [stage, setStage] = useState<L1ExitStage>()
  const [submitUrl, setSubmitUrl] = useState<string>()
  const [txHash, setTxHash] = useState<Hex>()

  const typedValid = isAddress(destination)
  const target = typedValid ? (destination as Address) : null
  // The recovered-to address is screened like the recipient was at withdraw time.
  const { verdict, cleared, rescreen } = useScreenedAddress(target, "withdraw")
  const amount = `${record.amount} ${record.tokenSymbol}`
  const connected = bridgeMode || (!!l1.account && !l1.wrongChain)
  const readyToExecute = connected
  const readyToRecover = connected && !!target && cleared
  const enteredAt = record.phaseEnteredAt ?? record.startTime

  const submit = async (next: ExitAction) => {
    setAction(next)
    setPhase("working")
    setStage(undefined)
    setSubmitUrl(undefined)
    const elapsed = lapTimer()
    const opts = {
      destination: target ?? undefined,
      from: l1.account ?? undefined,
      onHelperOpened: setSubmitUrl,
      onStage: setStage,
    }
    try {
      const hash =
        next === "recover"
          ? await recoverSwapWithdrawal(record, opts)
          : await executeSwapWithdrawal(record, opts)
      setTxHash(hash)
      setPhase("done")
      // Reason and timing only — the addresses are as identifying as the withdrawal itself.
      fireEvent(next === "execute" ? "withdrawal_swap_executed" : "withdrawal_swap_recovered", {
        duration_ms: elapsed(),
        reason,
      })
    } catch (e) {
      setPhase("form")
      const scope = next === "execute" ? "withdrawal:swap-execute" : "withdrawal:swap-recover"
      fireEvent("action_failed", { action: scope, code: failureCode(e) })
      showReportableError(e, next === "execute" ? "withdrawal:swap" : "withdrawal:recovery", {
        title: next === "execute" ? "Swap failed" : "Recovery failed",
      })
    }
  }

  const title =
    phase === "done"
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
              {canExecute ? EXECUTE_COPY : unswappableCopy(record)}
            </p>

            {!bridgeMode && !l1.account ? (
              <PrimaryGradientButton
                title={l1.connecting ? "Connecting…" : "Connect wallet"}
                isLoading={l1.connecting}
                onClick={l1.connect}
              />
            ) : !bridgeMode && l1.wrongChain ? (
              <PrimaryGradientButton
                title={l1.connecting ? "Switching…" : `Switch to ${config.l1Chain.name}`}
                buttonStyle="dark"
                isLoading={l1.connecting}
                onClick={l1.switchNetwork}
              />
            ) : null}

            <div>
              <ConfirmationSheetDetailRow label="Amount" value={amount} />
              <ConfirmationSheetDetailRow label="Started" value={whenLabel(record.startTime)} />
              <ConfirmationSheetDetailRow
                label="Waiting"
                value={waitedLabel(Date.now() - enteredAt)}
              />
              {record.swapEscrow && (
                <ConfirmationSheetDetailRow label="Escrow" value={short(record.swapEscrow)} />
              )}
              <ConfirmationSheetDetailRow
                label="Recipient"
                value={`${record.swapOutput} to ${
                  record.recipientAlias ?? truncateMiddle(record.recipient, 12)
                }`}
              />
              <ConfirmationSheetDetailRow
                label="Network"
                value={l1ChainFor(config.l1ChainId).name}
              />
            </div>

            {canExecute && (
              <PrimaryGradientButton
                title="Run the swap now"
                isDisabled={!readyToExecute}
                onClick={() => void submit("execute")}
              />
            )}

            {canExecute && (
              <p
                style={{ color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.5, margin: 0 }}
              >
                {RECOVER_SECONDARY_COPY}
              </p>
            )}
            <TextField
              label="Recover DAI to"
              placeholder="0x…"
              value={destination}
              onChange={setDestination}
              error={destination && !typedValid ? "That isn't a valid Ethereum address" : undefined}
            />
            <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
              Anyone can submit the transaction, but only this address receives the DAI, so check it
              carefully.
            </span>
            {target && !cleared && (
              <ScreeningNotice
                verdict={verdict}
                checkingCopy="Checking address…"
                blockedFallback="This address can't be used here. Use a different one."
                errorCopy="Couldn't verify this address."
                onRetry={rescreen}
              />
            )}
            <PrimaryGradientButton
              title={target ? `Recover DAI to ${short(target)}` : "Recover DAI"}
              buttonStyle={canExecute ? "dark" : undefined}
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
                {stage ? STAGE_LABEL[action][stage] : "Preparing…"}
              </span>
            </div>
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
                {action === "execute"
                  ? `Swapped to ${record.swapOutput} and sent to ${
                      record.recipientAlias ?? truncateMiddle(record.recipient, 12)
                    }.`
                  : `${amount} sent to ${target ? short(target) : "the address you chose"}.`}
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
