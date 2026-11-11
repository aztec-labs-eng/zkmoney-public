import { useState } from "react"
import { NumberedStepRow } from "@obsidion/web-ds"
import { Modal } from "../../ui/Modal"
import { savePrefs } from "../../platform/storage/deviceKeys"
import { useSession } from "../../session/session"
import envelope from "../../assets/paylink/paylink-envelope.webp"
import { StableCopy } from "../../ui/StableCopy"

/** Without a sponsored cash-out to Ethereum, then with one. */
const LEAD = [
  "A private link that carries funds. Share it with anyone. They'll need a zk.money account to claim.",
  "A private link that carries funds. Share it with anyone, no zk.money account needed.",
]
const RECEIVE = [
  "With a zk.money account, receive free and instantly in zk.money, or to any Ethereum address for a fee.",
  "Free and instant to zk.money, or to any Ethereum address for a fee.",
]

/** Which variant to show: none while the sponsorship read is in flight. */
export function shownVariant(voucher: boolean | undefined): number | undefined {
  return voucher === undefined ? undefined : Number(voucher)
}

const steps = (voucher: boolean | undefined) =>
  [
    [
      "Set an amount, share the link",
      "Message, email or QR code. The funds wait in the link, privately.",
    ],
    ["They choose how to receive", <StableCopy variants={RECEIVE} shown={shownVariant(voucher)} />],
    ["Not claimed? Take it back", "Only you can reclaim the funds while the link is unclaimed."],
  ] as const

/**
 * Explains paylinks. `offerHide` adds "Don't show this again", saved on "Got it!" only. Without
 * `voucher` (a sponsored cash-out to Ethereum), the claimer needs a zk.money account. Lines that depend on
 * `voucher` keep the height of their tallest wording and stay blank until it is known.
 */
export function PaylinkInfoModal({
  offerHide,
  voucher,
  onClose,
  onGotIt,
}: {
  offerHide: boolean
  voucher: boolean | undefined
  onClose: () => void
  onGotIt: () => void
}) {
  const [dontShowAgain, setDontShowAgain] = useState(true)
  const { database } = useSession()

  return (
    <Modal
      variant="create"
      className="ww-paylink-info"
      label="Send funds via paylink"
      onClose={onClose}
    >
      <div className="ww-create-modal__body">
        <div className="ww-paylink-info__intro">
          <div className="ww-invite-modal-head">
            <img src={envelope} alt="" width={120} height={102} />
            <h2 className="ww-invite-modal-title ww-invite-modal-title--lg">
              Send funds via paylink
            </h2>
            <p className="ww-paylink-info__lead">
              <StableCopy variants={LEAD} shown={shownVariant(voucher)} />
            </p>
          </div>
          {steps(voucher).map(([title, body], i) => (
            <NumberedStepRow key={title} index={i + 1}>
              <b>{title}</b>
              {body}
            </NumberedStepRow>
          ))}
        </div>
        {offerHide && (
          <label className="ww-deposit-warning__again">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
            />
            Don't show this again
          </label>
        )}
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-deposit__btn"
          onClick={() => {
            if (offerHide && dontShowAgain) savePrefs(database, { hidePaylinkInfo: "true" })
            onGotIt()
          }}
        >
          Got it!
        </button>
      </div>
    </Modal>
  )
}
