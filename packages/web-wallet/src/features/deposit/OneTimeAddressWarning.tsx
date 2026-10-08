import { Modal } from "../../ui/Modal"
import { deviceStorage } from "../../platform/storage/rollupStorage"
import { useEffect, useState } from "react"
import { GradientText, Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { ADDRESS_RECHECK_NOTE } from "./AddressCapacity"

const HIDE_KEY = "webwallet.hide-one-time-address-warning"

export function isOneTimeAddressWarningHidden(): boolean {
  return deviceStorage.getItem(HIDE_KEY) === "true"
}

export function hideOneTimeAddressWarning(): void {
  deviceStorage.setItem(HIDE_KEY, "true")
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

/**
 * The dialog in front of Copy and Show QR. `capacityWarning` is said every time it is set; the
 * checkbox hides only the privacy points.
 */
export function OneTimeAddressWarning({
  symbol,
  capacityWarning,
  privacy = true,
  onClose,
  onGotIt,
}: {
  symbol: string
  /** Shared capacity is zero or not confirmed for this address. */
  capacityWarning?: string
  /** Show the privacy points and their checkbox; false once the user has hidden them. */
  privacy?: boolean
  onClose: () => void
  onGotIt: () => void
}) {
  const [dontShowAgain, setDontShowAgain] = useState(false)
  // A reading that improves while the dialog is open does not empty it: the last warning stays.
  const [shownWarning, setShownWarning] = useState(capacityWarning)
  useEffect(() => {
    if (capacityWarning) setShownWarning(capacityWarning)
  }, [capacityWarning])

  return (
    <Modal
      variant="bare"
      label={privacy ? "One-time deposit address" : "Network capacity"}
      className="ww-deposit-warning"
      onClose={onClose}
    >
      <div className="ww-deposit-warning__close">
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />
      </div>
      <span className="ww-deposit__connect-icon ww-deposit-warning__icon">
        <Icon name="alert-triangle" size={32} color="#fff" />
      </span>
      <GradientText size={24} weight={700}>
        {privacy ? (
          <>
            This is a unique
            <br />
            one-time address
          </>
        ) : (
          "Before you share this address"
        )}
      </GradientText>
      {shownWarning && (
        <div
          className="ww-deposit-warning__capacity"
          role="alert"
          data-testid="address-capacity-warning"
        >
          <p>{shownWarning}</p>
          <p>{ADDRESS_RECHECK_NOTE}</p>
        </div>
      )}
      {privacy && <OneTimeAddressPoints points={oneTimeAddressPoints(symbol)} />}
      <div className="ww-deposit-warning__actions">
        {privacy && (
          <label className="ww-deposit-warning__again">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
            />
            {shownWarning ? "Don't show the privacy tips again" : "Don't show this again"}
          </label>
        )}
        <PrimaryGradientButton
          title="Got it!"
          onClick={() => {
            if (privacy && dontShowAgain) hideOneTimeAddressWarning()
            onGotIt()
          }}
          style={{ width: 166, height: 48 }}
        />
      </div>
    </Modal>
  )
}
