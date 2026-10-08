import { useState } from "react"
import { PrimaryGradientButton } from "@obsidion/web-ds"
import { clearAllEndpointOverrides } from "../config/endpointOverrides"
import { getConfig } from "../config/env"
import { reloadPage } from "../platform/storage/walletStorage"
import { EndpointsModal, PreWalletEndpointsModal } from "./EndpointsModal"
import type { BootError } from "./PxeBoot"

/**
 * A boot that stopped: why, a retry, and the ways out the endpoints allow. `walletOpen` is false for
 * a boot that failed before the wallet database opened.
 */
export function BootErrorScreen({
  error,
  onRetry,
  walletOpen,
}: {
  error?: BootError
  onRetry: () => void
  walletOpen: boolean
}) {
  return (
    <div
      role="alert"
      data-testid="boot-error"
      data-kind={error?.kind}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: "24px 16px",
        maxWidth: 430,
        margin: "0 auto",
      }}
    >
      {error && (
        <>
          {/* Both can carry a user's endpoint URL, which has no break point of its own. */}
          <span className="zkm-type-card-title" style={{ overflowWrap: "anywhere" }}>
            {error.title}
          </span>
          <span
            className="zkm-type-body"
            style={{ color: "var(--text-secondary)", overflowWrap: "anywhere" }}
          >
            {error.message}
          </span>
        </>
      )}
      <PrimaryGradientButton title="Retry" onClick={onRetry} />
      <BootRecovery walletOpen={walletOpen} />
    </div>
  )
}

/**
 * The ways out of a boot the endpoints may have caused, since Settings is behind the boot: clear the
 * saved overrides, or open the editor (even with nothing saved, for a dead default node).
 */
function BootRecovery({ walletOpen }: { walletOpen: boolean }) {
  const [clearError, setClearError] = useState<string>()
  const [editing, setEditing] = useState(false)
  const { endpoints } = getConfig()
  // The boot reads only the node and the RPC, so clearing a custom enclave cannot fix it.
  const fromSettings = [endpoints.node, endpoints.l1Rpc].some(
    (e) => e.source === "settings" && !e.isDefault,
  )
  const useDefaults = () => {
    const { ok } = clearAllEndpointOverrides()
    if (ok) void reloadPage()
    else
      setClearError(
        "The saved endpoints could not be cleared. Clear this site's data in your browser, then reload.",
      )
  }
  const Editor = walletOpen ? EndpointsModal : PreWalletEndpointsModal
  return (
    <>
      {fromSettings && (
        <PrimaryGradientButton
          title="Use default endpoints"
          buttonStyle="dark"
          testId="boot-use-default-endpoints"
          onClick={useDefaults}
        />
      )}
      <PrimaryGradientButton
        title="Change endpoints"
        buttonStyle="dark"
        testId="boot-change-endpoints"
        onClick={() => setEditing(true)}
      />
      {editing && <Editor onClose={() => setEditing(false)} />}
      {clearError && (
        <span
          className="zkm-type-body-sm"
          style={{ color: "var(--accent-pink)" }}
          data-testid="boot-clear-error"
        >
          {clearError}
        </span>
      )}
      <span
        className="zkm-type-body-sm"
        style={{ color: "var(--text-secondary)" }}
        data-testid="boot-contact-operator"
      >
        If this keeps happening, contact the operator of this wallet.
      </span>
    </>
  )
}
