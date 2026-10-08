import { Icon } from "@obsidion/web-ds"
import { useState } from "react"
import { useLeavingLosesTransaction } from "../features/operations/operations"
import { reloadPage } from "../platform/storage/walletStorage"
import "./configNotice.css"

interface NoticeStripProps {
  /** Pink marks a configuration nobody at zk.money vouches for; gold marks a stale but genuine one. */
  tone: "warning" | "danger"
  children: React.ReactNode
  action?: React.ReactNode
}

/**
 * The strip both configuration notices share. Dismissible: it sits above every sheet and drawer
 * (the app shell is its own stacking context), so a phone user must be able to clear it to reach a
 * sheet's action.
 */
function NoticeStrip({ tone, children, action }: NoticeStripProps) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null
  return (
    <div className={`ww-config-notice ww-config-notice--${tone}`} role="status">
      <Icon
        name="alert-circle"
        size={18}
        color={tone === "danger" ? "var(--accent-pink)" : "var(--accent-gold)"}
      />
      <span className="ww-config-notice__text">{children}</span>
      {action}
      <button
        type="button"
        className="zkm-btn-reset ww-config-notice__dismiss"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
      >
        <Icon name="x" size={14} strokeWidth={2.5} />
      </button>
    </div>
  )
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

export interface BakedProfileNoticeProps {
  /** The snapshot's `publishedAt`. */
  publishedAt: string
  /** The host chose the snapshot (the desktop's shipped-configuration setting); nothing was fetched. */
  forced?: boolean
  /** The snapshot has passed its expiry date. */
  expired?: boolean
  /** The host's settings page, offered in place of Reload on a forced boot. */
  settingsPath?: string
  reload?: () => void
}

/**
 * Shown while the wallet runs on the profile baked into this build — because the config service
 * could not be reached, or because the desktop user chose it.
 */
export function BakedProfileNotice({
  publishedAt,
  forced = false,
  expired = false,
  settingsPath,
  reload = () => void reloadPage(),
}: BakedProfileNoticeProps) {
  // A reload would end a running proof.
  const losesTransaction = useLeavingLosesTransaction()
  const date = formatDate(publishedAt)
  const action = forced ? (
    settingsPath && (
      <a className="ww-config-notice__action" href={settingsPath}>
        Settings
      </a>
    )
  ) : (
    <button
      type="button"
      className="zkm-btn-reset ww-config-notice__action"
      onClick={reload}
      disabled={losesTransaction}
    >
      Reload
    </button>
  )
  return (
    <NoticeStrip tone="warning" action={action}>
      {forced ? (
        <>
          This wallet is running on the configuration it shipped with (published {date}
          {expired ? ", now past its expiry date" : ""}) because the shipped-configuration setting
          is on. zk.money may have moved to new addresses since — confirm through a source you trust
          before sending funds.
        </>
      ) : (
        <>
          zk.money's configuration service could not be reached, so this wallet is running on the
          configuration it shipped with (published {date}). That configuration may be outdated and
          some actions may fail — reload to try again before transacting.
        </>
      )}
    </NoticeStrip>
  )
}

export interface CustomProfileNoticeProps {
  /** The address the configuration came from. */
  url: string
  /** The host's settings page, where the address can be cleared. */
  settingsPath?: string
}

/**
 * Shown for as long as the wallet runs on a configuration the user pointed it at. The document is
 * unsigned, so nothing here vouches for the contract addresses it named — the strip is the standing
 * reminder that the wallet is sending funds wherever that address said.
 */
export function CustomProfileNotice({ url, settingsPath }: CustomProfileNoticeProps) {
  return (
    <NoticeStrip
      tone="danger"
      action={
        settingsPath && (
          <a className="ww-config-notice__action" href={settingsPath}>
            Settings
          </a>
        )
      }
    >
      This wallet is using contract addresses from <strong>{url}</strong> instead of zk.money's own.
      Anything you send goes to the contracts listed at that URL. Clear it in Settings unless you
      are certain you trust it.
    </NoticeStrip>
  )
}
