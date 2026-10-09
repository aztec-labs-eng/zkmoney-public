import { Modal } from "../ui/Modal"
import { useEffect, useRef, useState } from "react"
import { PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { showReportableError, subscribeErrorModal, type ErrorModalPayload } from "./errorModal"
import { copyErrorReport, sendErrorReport } from "./shareErrorReport"
import { isExtensionError } from "./extensionError"
import { isWalletConnectChainSwitchError } from "./walletConnectError"

const WALLETCONNECT_PROPOSAL_EXPIRED = "Proposal expired"
const BROWSER_NOTICES = new Set([
  "Script error.",
  "ResizeObserver loop completed with undelivered notifications.",
])

/** Uncaught errors and promise rejections — nothing caught them, so no screen Toast owns them. */
function surfaceUncaught(raw: unknown): void {
  showReportableError(raw, "unhandled")
}

/**
 * Global mount for the unified error/info modal. Lives at the root (over every
 * route); catch blocks surface reportable failures via `showReportableError()`.
 */
export function ErrorModalHost() {
  const [payload, setPayload] = useState<ErrorModalPayload | null>(null)
  const [copyLabel, setCopyLabel] = useState("Copy")
  const [reportLabel, setReportLabel] = useState("Report")
  // Errors arriving while one is visible queue behind it instead of replacing
  // a message the user is reading.
  const queueRef = useRef<ErrorModalPayload[]>([])
  useEffect(
    () =>
      subscribeErrorModal((next) => {
        if (next === null) {
          setPayload(queueRef.current.shift() ?? null)
          return
        }
        setPayload((current) => {
          if (current) {
            if (queueRef.current.length < 3) queueRef.current.push(next)
            return current
          }
          return next
        })
      }),
    [],
  )

  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      if (isExtensionError(e.filename, e.error)) return
      if (e.error == null && BROWSER_NOTICES.has(e.message)) return
      surfaceUncaught(e.error ?? e.message)
    }
    const onRejection = (e: PromiseRejectionEvent) => {
      if (isExtensionError(undefined, e.reason)) return
      e.preventDefault() // handled: keep the default console spam down
      if (e.reason instanceof Error && e.reason.message === WALLETCONNECT_PROPOSAL_EXPIRED) return
      if (isWalletConnectChainSwitchError(e.reason)) return
      surfaceUncaught(e.reason)
    }
    window.addEventListener("error", onError)
    window.addEventListener("unhandledrejection", onRejection)
    return () => {
      window.removeEventListener("error", onError)
      window.removeEventListener("unhandledrejection", onRejection)
    }
  }, [])

  if (!payload) return null

  const dismiss = () => {
    setCopyLabel("Copy")
    setReportLabel("Report")
    setPayload(queueRef.current.shift() ?? null)
  }
  const copy = async () => {
    try {
      await copyErrorReport(payload)
      setCopyLabel("Copied")
    } catch {
      // Clipboard denied — leave the label alone.
    }
  }
  const report = async () => {
    setReportLabel("Sending…")
    setReportLabel((await sendErrorReport(payload)) ? "Sent" : "Failed")
  }

  return (
    <Modal variant="bare" role="alertdialog" label={payload.title} className="ww-error-modal" onClose={dismiss}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span
            className="zkm-type-title-sm"
            style={{ color: "var(--text-primary)", fontFamily: "var(--font-display)" }}
          >
            {payload.title}
          </span>
          <TopNavIconButton icon="x" ariaLabel="Close" onClick={dismiss} />
        </div>
        <span
          style={{
            color: "var(--text-secondary)",
            fontFamily: "var(--font-body)",
            fontSize: 15,
            // RPC and viem messages routinely carry a URL or a 66-character hash.
            overflowWrap: "anywhere",
          }}
        >
          {payload.message}
        </span>
        {payload.link && (
          <a
            href={payload.link.href}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--text-primary)", fontFamily: "var(--font-body)", fontSize: 15 }}
          >
            {payload.link.label}
          </a>
        )}
        {payload.detail && (
          <span
            style={{
              color: "var(--text-secondary)",
              opacity: 0.7,
              fontFamily: "var(--font-body)",
              fontSize: 12,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 120,
              overflowY: "auto",
            }}
          >
            {payload.detail}
          </span>
        )}
        {payload.retry && (
          <PrimaryGradientButton
            title={payload.retry.label}
            onClick={() => {
              const { run } = payload.retry!
              dismiss()
              run()
            }}
          />
        )}
        {payload.showReport && (
          <>
            <div style={{ display: "flex", gap: 12 }}>
              <PrimaryGradientButton
                title={copyLabel}
                buttonStyle="dark"
                onClick={() => void copy()}
                style={{ flex: 1 }}
              />
              <PrimaryGradientButton
                title={reportLabel}
                isDisabled={reportLabel !== "Report"}
                onClick={() => void report()}
                style={{ flex: 1 }}
              />
            </div>
            <span
              style={{
                color: "var(--text-secondary)",
                fontFamily: "var(--font-body)",
                fontSize: 12,
              }}
            >
              The report includes your device type, OS, browser and passkey provider.
            </span>
          </>
        )}
    </Modal>
  )
}
