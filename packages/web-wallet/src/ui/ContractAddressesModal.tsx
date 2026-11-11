import { GradientText } from "@obsidion/web-ds"
import { serviceStatus, UNREAD, useStore } from "@obsidion/front-core"
import { errorMessage } from "../errors/catalog"
import { fmt } from "../lib/fmt"
import copy from "./ContractAddressesModal.copy"
import { Modal } from "./Modal"
import { useCopy } from "./hooks"
import type { Row } from "../session/contractAddresses"
import { useSession } from "../session/session"

function AddressRow({ row }: { row: Row }) {
  const { copied, copy: copyValue } = useCopy()
  const head = (
    <span className="ww-addresses__head">
      <span className="ww-addresses__label">{row.label}</span>
      <span className="ww-addresses__chain">{row.chain}</span>
      {copied && <span className="ww-addresses__copied">{copy.copied}</span>}
    </span>
  )
  if (!row.value) {
    return (
      <div className="ww-addresses__row ww-addresses__row--unresolved">
        {head}
        <code className="ww-addresses__value">{copy.unresolved}</code>
      </div>
    )
  }
  const value = row.value
  return (
    <button
      type="button"
      className="zkm-btn-reset ww-addresses__row"
      aria-label={fmt(copy.copyRow, { label: row.label })}
      onClick={() => void copyValue(value)}
    >
      {head}
      <code className="ww-addresses__value">{value}</code>
    </button>
  )
}

/** Deployment contracts the wallet points at: profile L2 set, oxide manifest tuple, Aztec protocol. */
export function ContractAddressesModal({ onClose }: { onClose: () => void }) {
  const session = useSession()
  const contracts = useStore(session.contractService, serviceStatus) === "ready"
  const walletBuilt = useStore(session.wallet, serviceStatus) === "ready"
  const state = useStore(contracts ? session.contractAddresses(walletBuilt) : UNREAD)
  const groups = !contracts ? [] : state.status === "ready" ? state.value : undefined

  return (
    <Modal variant="create" label={copy.title} onClose={onClose} className="ww-feedback">
      <GradientText gradient="title" size={24} weight={700} style={{ textAlign: "center" }}>
        {copy.title}
      </GradientText>
      <div className="ww-addresses">
        {state.status === "failed" ? (
          <p className="ww-supportid__note">{errorMessage(state.error)}</p>
        ) : (
          groups === undefined && <p className="ww-supportid__note">{copy.loading}</p>
        )}
        {groups?.length === 0 && <p className="ww-supportid__note">{copy.noService}</p>}
        {groups?.map((group) => (
          <section key={group.title} className="ww-contacts__section">
            <span className="ww-contacts__label">{group.title}</span>
            <div className="ww-contacts__group ww-addresses__group">
              {group.rows.map((row) => (
                <AddressRow key={row.label} row={row} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </Modal>
  )
}
