/** The pieces every activity detail modal repeats: a timestamp label and a hash linked to its explorer. */
import { formatDateLabel, formatTimeLabel, truncateMiddle } from "@obsidion/front-core"
import { ConfirmationSheetDetailRow, Icon } from "@obsidion/web-ds"
import { sepolia } from "viem/chains"
import type { WebWalletConfig } from "../config/env"
import { isDemoMode } from "../dev/demoFlag"
import { l1AddressUrl as etherscanAddress, l1TxUrl as etherscanTx } from "../lib/explorer"
import { useSession } from "../session/session"
import { useCopy } from "./hooks"

export const whenLabel = (ms: number) => `${formatDateLabel(ms)}, ${formatTimeLabel(ms)}`

/**
 * The L1's explorer links, undefined on an L1 with no public explorer: the row then shows the bare
 * hash or address. Demo mode runs on the local chain, which has no explorer, so it borrows one: the
 * links are there to show the UI, not to resolve.
 */
export function l1Links({ l1ChainId }: Pick<WebWalletConfig, "l1ChainId">) {
  const chainId = etherscanTx(l1ChainId, "0x") === null && isDemoMode() ? sepolia.id : l1ChainId
  return {
    l1TxUrl: (hash: string) => etherscanTx(chainId, hash) ?? undefined,
    l1AddressUrl: (address: string) => etherscanAddress(chainId, address) ?? undefined,
  }
}

/** The session L1's {@link l1Links}. */
export const useL1Links = () => l1Links(useSession().page.config)

/**
 * A row for a fact the record is expected to carry but has not read yet. It holds its place so the
 * sheet keeps the same shape once the sync fills the value in.
 */
export function DetectingRow({ label }: { label: string }) {
  return <ConfirmationSheetDetailRow label={label} value="Detecting…" />
}

/** An L1 address linked to its Etherscan page. */
export function AddressRow({ label, address }: { label: string; address: string }) {
  return <HashRow label={label} hash={address} url={useL1Links().l1AddressUrl(address)} />
}

/** A detail-row value that copies its full text on tap, with a brief "Copied" swap. */
export function CopyableValue({ text }: { text: string }) {
  const { copied, copy } = useCopy()
  return (
    <button
      type="button"
      className="zkm-btn-reset zkm-pressable ww-copy-value"
      aria-label="Copy deposit address"
      onClick={() => copy(text)}
    >
      {truncateMiddle(text, 12)}
      {copied ? (
        <Icon name="check-circle" size={14} color="var(--accent-green)" />
      ) : (
        <Icon name="copy" size={14} color="var(--text-secondary)" />
      )}
    </button>
  )
}

export function HashRow({ label, hash, url }: { label: string; hash: string; url?: string }) {
  const text = truncateMiddle(hash, 12)
  return (
    <ConfirmationSheetDetailRow
      label={label}
      value={
        url ? (
          <a href={url} target="_blank" rel="noreferrer" style={{ color: "var(--text-primary)" }}>
            {text}
          </a>
        ) : (
          text
        )
      }
    />
  )
}
