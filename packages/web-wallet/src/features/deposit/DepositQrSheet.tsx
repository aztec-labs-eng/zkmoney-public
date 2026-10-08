import type { ReactNode } from "react"
import { Modal } from "../../ui/Modal"
import { GradientText, TopNavIconButton } from "@obsidion/web-ds"
import walletLineIcon from "../../assets/deposit/wallet-line.svg"
import { shortAddr } from "../../ui/format"
import { GradientQrCard } from "../../ui/GradientQrCard"

/** White-on-gradient QR of an EIP-681 ERC-20 transfer URI — wallets scan it and pre-fill send. */
export function DepositQrSheet({
  address,
  paymentUri,
  copied,
  title = "Deposit address",
  limits,
  onCopy,
  onClose,
}: {
  address: string
  paymentUri: string
  copied: boolean
  /** Names the address for the flow showing it — a request payer is not depositing. */
  title?: string
  /** The payment's limit, shown right under the code. */
  limits?: ReactNode
  onCopy: () => void
  onClose: () => void
}) {
  return (
    <Modal variant="bare" label={title} className="ww-deposit-warning" onClose={onClose}>
      <div className="ww-deposit-warning__close">
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />
      </div>
      <span className="ww-deposit__connect-icon ww-deposit-warning__icon">
        <img src={walletLineIcon} alt="" width={32} height={29} />
      </span>
      <GradientText size={24} weight={700}>
        {title}
      </GradientText>
      <GradientQrCard
        payload={paymentUri}
        label={shortAddr(address)}
        ariaLabel={`${title} QR code`}
        copied={copied}
        onCopy={onCopy}
      />
      {limits}
    </Modal>
  )
}
