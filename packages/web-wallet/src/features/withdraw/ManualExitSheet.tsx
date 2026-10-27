import { Modal } from "../../ui/Modal"
/**
 * The confirm sheet for sending, from the user's own L1 wallet, a withdrawal no relayer sent. The
 * withdrawal already fixed the recipient and the amount, so there is nothing to choose: the copy,
 * the facts, and a button.
 */
import { useState, type ReactNode } from "react"
import type { Hex } from "viem"
import { DoubleCheckIcon, PrimaryGradientButton, Spinner, TopNavIconButton } from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { lapTimer } from "../../lib/analytics"
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

const STAGE_LABEL: Record<L1ExitStage, string> = {
  "signing": "Approve the transaction in your wallet",
  "awaiting-browser": "Approve the transaction in your browser",
  "confirming": "Waiting for Ethereum confirmation",
}

export interface ManualExitRunOptions {
  /** The connected injected wallet, which submits and takes the tip. */
  from?: Hex
  onHelperOpened: (submitUrl: string) => void
  onStage: (stage: L1ExitStage) => void
}

export function ManualExitSheet({
  label,
  title,
  doneTitle,
  explainer,
  facts,
  buttonTitle,
  run,
  onSent,
  onError,
  done,
  onClose,
}: {
  label: string
  title: string
  doneTitle: string
  explainer: ReactNode
  facts: ReactNode
  buttonTitle: string
  /** Sends the transaction; resolves to its L1 hash. */
  run: (opts: ManualExitRunOptions) => Promise<Hex>
  onSent?: (elapsedMs: number) => void
  /** Reports a failure the user did not cause by cancelling. */
  onError: (e: unknown) => void
  done: ReactNode
  onClose: () => void
}) {
  const config = getConfig()
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
      const hash = await run({
        from: (l1.account as Hex | null) ?? undefined,
        onHelperOpened: setSubmitUrl,
        onStage,
      })
      setTxHash(hash)
      setPhase("done")
      onSent?.(elapsed())
    } catch (e) {
      setPhase("form")
      if (e instanceof WalletPromptOpenError) {
        setRefused(e.message)
        return
      }
      if (prompt.cancelled(request) || isWalletRejection(e)) return
      onError(e)
    } finally {
      prompt.settle(request)
    }
  }

  return (
    <Modal variant="bare" label={label} onClose={phase === "working" ? undefined : onClose}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <span className="zkm-type-title-sm" style={{ color: "var(--text-primary)" }}>
          {phase === "done" ? doneTitle : title}
        </span>
        {phase !== "working" && <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />}
      </div>

      {phase === "form" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <p style={{ color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.5, margin: 0 }}>
            {explainer}
          </p>
          <div>{facts}</div>
          {!bridgeMode && <ExitWalletRow l1={l1} chainName={config.l1Chain.name} />}
          {refused && (
            <p role="alert" className="ww-sheet__note" data-testid="withdrawal-exit-refused">
              {refused}
            </p>
          )}
          <PrimaryGradientButton
            title={buttonTitle}
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
              {done}
            </p>
          </div>
          {txHash && <HashRow label="Transaction ID" hash={txHash} url={l1TxUrl(txHash)} />}
          <PrimaryGradientButton title="Done" onClick={onClose} />
        </div>
      )}
    </Modal>
  )
}
