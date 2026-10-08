import { Modal } from "../../ui/Modal"
/**
 * The one exit from a withdrawal the relayer has not released: submit its release yourself. There
 * is nothing to choose — the burn fixed the recipient and the amount — so this is a confirm sheet,
 * not a form: the copy, the three facts, and a button.
 *
 * The node and the TEE signer come from React context, which is why `selfFinalize` takes them as
 * an argument.
 */
import { useState } from "react"
import type { Hex } from "viem"
import {
  truncateMiddle,
  useAssetContext,
  useAztecContext,
  withdrawalRecipients,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import {
  ConfirmationSheetDetailRow,
  DoubleCheckIcon,
  PrimaryGradientButton,
  Spinner,
  TopNavIconButton,
} from "@obsidion/web-ds"
import { getConfig, l1ChainFor } from "../../config/env"
import { showReportableError } from "../../errors/errorModal"
import { failureCode, fireEvent, lapTimer } from "../../lib/analytics"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import { HashRow, l1TxUrl } from "../../ui/detailRows"
import { useCopy } from "../../ui/hooks"
import { isWalletRejection, useL1Wallet } from "../deposit/l1Wallet"
import type { L1ExitStage } from "../deposit/sipaRecovery"
import {
  useWalletPrompt,
  useWalletPromptStall,
  WalletPromptNote,
  WalletPromptOpenError,
  type WalletPromptToken,
} from "../deposit/walletPrompt"
import { ExitWalletRow } from "./ExitWalletRow"
import { selfFinalize } from "./selfFinalize"

const STAGE_LABEL: Record<L1ExitStage, string> = {
  "signing": "Approve the transaction in your wallet",
  "awaiting-browser": "Approve the transaction in your browser",
  "confirming": "Waiting for Ethereum confirmation",
}

const WALLET_LEAD = "This withdrawal has already been deducted from your Aztec balance. "
const PAYLINK_LEAD = "The link's funds have already left Aztec. "

const EXPLAINER =
  "All that's left is one Ethereum transaction that sends the funds to the recipient, and you can send it yourself. You pay the gas, the tip this withdrawal set aside for whoever sends it comes back to your wallet, and the funds go to the address the withdrawal already named, so nobody can redirect them. If a relayer gets there first, your transaction fails without moving anything and the withdrawal still finishes."

// The desktop helper page picks its account after the calldata is built, so the tip goes to the recipient.
const DESKTOP_EXPLAINER =
  "All that's left is one Ethereum transaction that sends the funds to the recipient, and you can send it yourself. You pay the gas; the funds, and the tip this withdrawal set aside for whoever sends it, go to the address the withdrawal already named, so nobody can redirect them. If a relayer gets there first, your transaction fails without moving anything and the withdrawal still finishes."

// A swap withdrawal burned to a counterfactual escrow, so this transaction releases DAI THERE, not
// to the recipient and not in the asset they chose. A separate L1 operation deploys the escrow and
// runs the swap; finalizing here does not do it.
const SWAP_EXPLAINER =
  "All that's left is one Ethereum transaction, and you can send it yourself. It releases the DAI to the swap escrow this withdrawal committed to — not to your recipient directly. The swap into your chosen asset is a separate step a relayer runs once the escrow is funded, so the recipient is paid after that, not by this transaction."

export function WithdrawalExitModal({
  record,
  onClose,
}: {
  record: WithdrawalRecord
  onClose: () => void
}) {
  const config = getConfig()
  const amount = `${record.amount} ${record.tokenSymbol}`
  const recipient = record.recipientAlias ?? truncateMiddle(record.recipient, 12)
  const { release, viaEscrow } = withdrawalRecipients(record)
  const swap = viaEscrow ? record.swapOutput : undefined
  const releasedTo = viaEscrow ? truncateMiddle(release, 12) : recipient
  const { obsidionWallet } = useAztecContext()
  const { teeSigner } = useAssetContext()
  const { copied, copy } = useCopy()
  const bridgeMode = isDesktopL1SubmitActive()
  const l1 = useL1Wallet({ expectedChainId: config.l1ChainId, rpcUrl: config.l1RpcUrl })
  const ready = bridgeMode || (!!l1.account && !l1.wrongChain)

  const [phase, setPhase] = useState<"form" | "working" | "done">("form")
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

  const submit = async () => {
    if (prompt.openElsewhere) {
      setRefused(prompt.openElsewhere)
      return
    }
    setRefused(undefined)
    setPhase("working")
    setStage(undefined)
    setSubmitUrl(undefined)
    const elapsed = lapTimer()
    let request: WalletPromptToken | undefined
    // Confirming means the wallet answered; the slot frees before the receipt lands.
    const onStage = (next: L1ExitStage) => {
      setStage(next)
      if (next === "confirming") prompt.settle(request)
    }
    try {
      request = prompt.begin()
      // Null when the session is locked or still connecting; `selfFinalize` refuses it, except in
      // the dev demo, whose stubbed builder needs no wallet at all.
      const wallet =
        obsidionWallet && teeSigner ? { node: obsidionWallet.node, signer: teeSigner } : null
      const hash = await selfFinalize(record, wallet, {
        from: l1.account ?? undefined,
        onHelperOpened: setSubmitUrl,
        onStage,
      })
      setTxHash(hash)
      setPhase("done")
      // Timing only — the recipient is as identifying as the withdrawal itself.
      fireEvent("withdrawal_self_finalized", { duration_ms: elapsed() })
    } catch (e) {
      setPhase("form")
      if (e instanceof WalletPromptOpenError) {
        setRefused(e.message)
        return
      }
      if (prompt.cancelled(request) || isWalletRejection(e)) return
      fireEvent("action_failed", { action: "withdrawal:self-finalize", code: failureCode(e) })
      showReportableError(e, "withdrawal:finalize", { title: "Finalization failed" })
    } finally {
      prompt.settle(request)
    }
  }

  return (
    <Modal
      variant="bare"
      label="Withdrawal recovery"
      onClose={phase === "working" ? undefined : onClose}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <span className="zkm-type-title-sm" style={{ color: "var(--text-primary)" }}>
          {phase === "done" ? "Withdrawal released" : "Withdrawal taking too long"}
        </span>
        {phase !== "working" && <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />}
      </div>

      {phase === "form" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <p style={{ color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.5, margin: 0 }}>
            {record.source === "paylink" ? PAYLINK_LEAD : WALLET_LEAD}
            {swap ? SWAP_EXPLAINER : bridgeMode ? DESKTOP_EXPLAINER : EXPLAINER}
          </p>
          <div>
            <ConfirmationSheetDetailRow label="Amount" value={amount} />
            <ConfirmationSheetDetailRow
              label={swap ? "Released to" : "Recipient"}
              value={releasedTo}
            />
            {swap && (
              <ConfirmationSheetDetailRow
                label="Then swapped to"
                value={`${swap} for ${recipient}`}
              />
            )}
            <ConfirmationSheetDetailRow label="Network" value={l1ChainFor(config.l1ChainId).name} />
          </div>
          {!bridgeMode && <ExitWalletRow l1={l1} chainName={config.l1Chain.name} />}
          {refused && (
            <p role="alert" className="ww-sheet__note" data-testid="withdrawal-exit-refused">
              {refused}
            </p>
          )}
          <PrimaryGradientButton
            title="Finalize this withdrawal"
            isDisabled={!ready}
            onClick={() => void submit()}
          />
        </div>
      )}

      {phase === "working" && (
        <div style={{ padding: "24px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Spinner size={20} />
            <span style={{ fontSize: 15 }}>{stage ? STAGE_LABEL[stage] : "Preparing…"}</span>
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
              {swap
                ? `${amount} released to the swap escrow. Your recipient is paid in ${swap} once a relayer runs the swap.`
                : `${amount} released to ${recipient}.`}
            </p>
          </div>
          {txHash && <HashRow label="Transaction ID" hash={txHash} url={l1TxUrl(txHash)} />}
          <PrimaryGradientButton title="Done" onClick={onClose} />
        </div>
      )}
    </Modal>
  )
}
