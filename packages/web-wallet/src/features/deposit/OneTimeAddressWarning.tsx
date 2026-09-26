import { Modal } from "../../ui/Modal"
import { useState } from "react"
import { GradientText, Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"

const HIDE_KEY = "webwallet.hide-one-time-address-warning"

export function isOneTimeAddressWarningHidden(): boolean {
  return localStorage.getItem(HIDE_KEY) === "true"
}

export function hideOneTimeAddressWarning(): void {
  localStorage.setItem(HIDE_KEY, "true")
}

export interface OneTimeAddressPoint {
  id: "loss" | "rotates" | "single-use"
  icon: string
  title: string
  body: string
}

/** What a payer has to know about a single-use SIPA address, wherever one is shown. */
export function oneTimeAddressPoints(symbol: string): OneTimeAddressPoint[] {
  return [
    {
      id: "loss",
      icon: "coins",
      title: "Risk of loss",
      body: `Only send ${symbol} on Ethereum (ERC20). Sending wrong requires manual recovery.`,
    },
    {
      id: "rotates",
      icon: "history-clock",
      title: "This address changes every time",
      body: "A new address is generated each time you open this screen. Don't save it for future use.",
    },
    {
      id: "single-use",
      icon: "shield-check",
      title: "Keep it single use",
      body: "Sending to this address more than once reduces your privacy. Use it only one time.",
    },
  ]
}

export function OneTimeAddressPoints({ points }: { points: OneTimeAddressPoint[] }) {
  return (
    <div className="ww-deposit-warning__points">
      {points.map((p) => (
        <div key={p.id} className="ww-deposit-warning__point">
          <span className="ww-deposit-warning__point-icon">
            <Icon name={p.icon} size={24} color="#fff" />
          </span>
          <span className="ww-deposit__connect-text">
            <b>{p.title}</b>
            <span>{p.body}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

export function OneTimeAddressWarning({
  symbol,
  onClose,
  onGotIt,
}: {
  symbol: string
  onClose: () => void
  onGotIt: () => void
}) {
  const [dontShowAgain, setDontShowAgain] = useState(false)

  return (
    <Modal variant="bare" label="One-time deposit address" className="ww-deposit-warning" onClose={onClose}>
      <div className="ww-deposit-warning__close">
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />
      </div>
      <span className="ww-deposit__connect-icon ww-deposit-warning__icon">
        <Icon name="alert-triangle" size={32} color="#fff" />
      </span>
      <GradientText size={24} weight={700}>
        This is a unique
        <br />
        one-time address
      </GradientText>
      <OneTimeAddressPoints points={oneTimeAddressPoints(symbol)} />
      <div className="ww-deposit-warning__actions">
        <label className="ww-deposit-warning__again">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
          />
          Don't show this again
        </label>
        <PrimaryGradientButton
          title="Got it!"
          onClick={() => {
            if (dontShowAgain) hideOneTimeAddressWarning()
            onGotIt()
          }}
          style={{ width: 166, height: 48 }}
        />
      </div>
    </Modal>
  )
}
