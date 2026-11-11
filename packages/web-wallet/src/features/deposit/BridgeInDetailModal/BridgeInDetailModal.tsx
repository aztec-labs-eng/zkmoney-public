import { useNavigate } from "react-router-dom"
import { useStore } from "@obsidion/front-core"
import { CornerButton } from "../../../ui/flow/CornerButton/CornerButton"
import { Modal } from "../../../ui/Modal"
import { useSession } from "../../../session/session"
import { BridgeInStatus, bridgeInStatusSheet } from "../BridgeInStatus/BridgeInStatus"
import { profileBridge } from "../../../session/walletChains"
import { useDepositTokens } from "../../sipa/loadDepositFacts"
import copy from "../sendFromWallet.copy"

/** A bridge-in opened from Activity or the bell: the bridge sheet's status, over the page. */
export function BridgeInDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const navigate = useNavigate()
  const { bridgeIns, page } = useSession()
  const record = useStore(bridgeIns.list, ({ records }) => records.find((r) => r.id === id))
  const coins = useDepositTokens()?.offered ?? []
  if (!record) return null
  const { l1Chain } = page.config
  const { pays } = record
  const chain = profileBridge(page.config)?.chains.find((c) => c.chainId === record.originChainId)
  return (
    <Modal
      variant="bare"
      label={copy.bridgeTitle}
      className={`ww-deposit-warning ww-deposit-sheet ww-bridge-sheet ${bridgeInStatusSheet}`}
      onClose={onClose}
    >
      <div className="ww-deposit-warning__close">
        <CornerButton kind="close" onClick={onClose} />
      </div>
      <BridgeInStatus
        record={record}
        coins={coins}
        chainName={chain?.name ?? ""}
        l1ChainName={l1Chain.name}
        payee={pays?.payee}
        onTryAgain={() => {
          onClose()
          // A payment starts over on its payee's pay page, with the wallet-pay sheet.
          if (pays)
            navigate(`/pay/${encodeURIComponent(pays.payee)}`, { state: { external: true } })
          else navigate("/deposit", { state: { startDeposit: true } })
        }}
        onClose={onClose}
      />
    </Modal>
  )
}
