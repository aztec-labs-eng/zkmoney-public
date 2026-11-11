import { Icon } from "@obsidion/web-ds"

/** What the wallet is waiting on the user for, in the callout the sheets use for it. */
export function WalletCallout({ text }: { text: string }) {
  return (
    <div className="ww-deposit-sheet__status ww-deposit-sheet__status--pending" role="status">
      <Icon name="wallet" size={16} color="var(--accent-gold)" />
      <span className="ww-deposit-sheet__status-text">
        <b>{text}</b>
      </span>
    </div>
  )
}
