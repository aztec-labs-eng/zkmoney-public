import { ContactRow, Icon, RowChevron, Spinner } from "@obsidion/web-ds"
import { fmt } from "../../../lib/fmt"
import { shortL1Addr } from "../../../ui/format"
import type { SavedL1Wallet } from "../../../session/savedL1Wallets"
import type { useL1Wallet } from "../../../session/useL1Wallet"
import { WalletPill } from "../../../ui/flow/WalletPill/WalletPill"
import { useStore } from "@obsidion/front-core"
import { useScreenFlow } from "../../../ui/useScreenFlow"
import { useSession } from "../../../session/session"
import { openChangeWalletFlow } from "./changeWalletFlow"
import copy from "./ChangeWalletPicker.copy"
import flowStyles from "../../../ui/flow/flow.module.css"
import styles from "./ChangeWalletPicker.module.css"

type L1Wallet = ReturnType<typeof useL1Wallet>

type Saved =
  | { saved: readonly SavedL1Wallet[]; onSaved: (wallet: SavedL1Wallet) => void }
  | { saved?: undefined; onSaved?: undefined }

/** A saved wallet row's trailing view when it is the connected account. */
export function ConnectedTrailing() {
  return (
    <span className="ww-move-landing__trailing">
      <span className="ww-move-landing__connected">
        {copy.connected}
        <Icon name="link-unlink" size={11} />
      </span>
      <RowChevron />
    </span>
  )
}

/**
 * A flow's wallet picker: another account in the same wallet, another wallet, or a saved
 * wallet. The sheet under it follows the account the wallet then sends from.
 */
export function ChangeWalletPicker({
  l1,
  saved = [],
  onSaved,
  onPicked,
  switchable = true,
}: {
  l1: Pick<L1Wallet, "account" | "walletName" | "switchAccount" | "openPicker" | "pickerShown">
  /** Offers another account of the connected wallet. */
  switchable?: boolean
  /** `changed` when the wallet was asked for another account or another wallet. */
  onPicked: (changed?: boolean) => void
} & Saved) {
  const wallet = l1.walletName ?? copy.walletFallback
  const { l1Wallet } = useSession().page
  const flow = useScreenFlow({ l1, onPicked }, (latest) =>
    openChangeWalletFlow({ l1Wallet }, latest),
  )
  // Open while the wallet's account dialog is up; a refusal stays here.
  const { waiting } = useStore(flow.state)
  const action = (
    testId: string,
    icon: string,
    title: string,
    detail: string,
    onClick: () => void,
    busy = false,
  ) => (
    <button
      type="button"
      className={`zkm-btn-reset zkm-pressable ww-move-landing__new ww-move-landing__new--wallet ${flowStyles.row}`}
      data-testid={testId}
      disabled={waiting}
      aria-busy={busy || undefined}
      onClick={onClick}
    >
      <span className="ww-move-landing__plus">
        {busy ? <Spinner size={20} /> : <Icon name={icon} size={20} />}
      </span>
      <span>
        <b>{title}</b>
        <small>{detail}</small>
      </span>
      {!waiting && <RowChevron />}
    </button>
  )
  const isConnected = (address: string) => address.toLowerCase() === l1.account?.toLowerCase()
  return (
    <div className={styles.wallets}>
      {/* Another account needs a connected wallet to ask. */}
      {switchable && l1.account && (
        <div className={styles.accountRow}>
          {action(
            "change-wallet-switch",
            "refresh",
            copy.switchAccount,
            fmt(waiting ? copy.waiting : copy.switchAccountDetail, { wallet }),
            () => void flow.switchAccount(),
            waiting,
          )}
          <WalletPill
            className={styles.accountPill}
            wallet={l1.walletName ?? copy.pillFallback}
            address={shortL1Addr(l1.account)}
          />
        </div>
      )}
      <div className={styles.walletsSaved} inert={waiting}>
        {saved.length > 0 && <span className={styles.walletsHead}>{copy.saved}</span>}
        <div className={styles.wallets}>
          {action(
            "change-wallet-another",
            "wallet",
            copy.another,
            copy.anotherDetail,
            flow.connectAnother,
          )}
          {saved.length > 0 && (
            <div className="ww-move-landing__list">
              {saved.map((row) => (
                <ContactRow
                  key={row.address}
                  name={row.name}
                  tag={shortL1Addr(row.address)}
                  isL1
                  trailing={isConnected(row.address) ? <ConnectedTrailing /> : undefined}
                  onClick={() => (isConnected(row.address) ? onPicked() : onSaved?.(row))}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
