import { useState } from "react"
import { GradientText, PrimaryGradientButton } from "@obsidion/web-ds"
import { getConfig } from "../config/env"
import { useLeavingLosesTransaction } from "../features/operations/operations"
import type { EndpointKind } from "../config/endpointOverrides"
import { reloadPage } from "../platform/storage/walletStorage"
import { EndpointFields, defaultHost, useEndpointEditor } from "./endpointsEditor"
import { Modal } from "./Modal"

export { customEndpointsLabel } from "./endpointsEditor"

const CONFIG_KEYS: Record<EndpointKind, "nodeUrl" | "l1RpcUrl" | "enclaveUrl"> = {
  node: "nodeUrl",
  l1Rpc: "l1RpcUrl",
  enclave: "enclaveUrl",
}
const BUSY =
  "A transaction is still being sent, and saving reloads the wallet. Wait for it to finish."

type EndpointsModalProps = { onClose: () => void; reload?: () => void }

/**
 * Edits the node (with its API key), L1 RPC and enclave overrides for this browser. Nothing is
 * probed here: the boot gate checks the node against the RPC after the reload, and the enclave is
 * checked against L1 on first use.
 */
export function EndpointsModal(props: EndpointsModalProps) {
  // Read live: the block lifts by itself once the transaction settles.
  return <EndpointsDialog {...props} losesTransaction={useLeavingLosesTransaction()} />
}

/** For a boot that failed before the wallet opened: nothing can be sending. */
export function PreWalletEndpointsModal(props: EndpointsModalProps) {
  return <EndpointsDialog {...props} losesTransaction={false} />
}

function EndpointsDialog({
  onClose,
  reload = () => void reloadPage(),
  losesTransaction,
}: EndpointsModalProps & { losesTransaction: boolean }) {
  const config = getConfig()
  const [saveError, setSaveError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const editor = useEndpointEditor({ onEdit: () => setSaveError(undefined) })
  const canSave = editor.dirty && editor.valid && !losesTransaction

  // A custom URL hides the default it replaced.
  const defaults: Partial<Record<EndpointKind, string>> = {}
  for (const kind of Object.keys(CONFIG_KEYS) as EndpointKind[]) {
    const host = config.endpoints[kind].isDefault
      ? defaultHost(config[CONFIG_KEYS[kind]])
      : undefined
    if (host) defaults[kind] = host
  }

  const save = () => {
    if (!canSave) return
    setSaving(true)
    const result = editor.commit()
    if (result.ok) {
      reload()
      return
    }
    setSaveError(result.message)
    setSaving(false)
  }

  return (
    <Modal variant="create" label="Endpoints" onClose={onClose} className="ww-feedback">
      <GradientText gradient="title" size={24} weight={700} style={{ textAlign: "center" }}>
        Endpoints
      </GradientText>
      <p className="ww-endpoints__intro">Leave a field empty to use the default.</p>
      <div className="ww-feedback__body">
        <EndpointFields editor={editor} defaults={defaults} disabled={saving} />
        {losesTransaction && (
          <p className="ww-feedback__error" role="alert" data-testid="endpoints-busy">
            {BUSY}
          </p>
        )}
        {saveError && (
          <p className="ww-feedback__error" role="alert" data-testid="endpoints-save-error">
            {saveError}
          </p>
        )}
      </div>
      <PrimaryGradientButton
        title="Save & reload"
        isLoading={saving}
        isDisabled={!canSave}
        onClick={save}
      />
      <PrimaryGradientButton title="Cancel" buttonStyle="dark" onClick={onClose} />
    </Modal>
  )
}
