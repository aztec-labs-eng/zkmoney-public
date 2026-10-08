import { useId, useState, type ReactNode } from "react"
import { Outlet, useNavigate } from "react-router-dom"
import { GradientText, Icon, NumberedStepRow } from "@obsidion/web-ds"
import walletIcon from "../../assets/deposit/wallet-line.svg"
import spyIcon from "../../assets/withdraw/spy-line.svg"
import { useFreshAddressAvailable } from "./freshAddressAvailability"

/** How to add a history-free account in the wallets users most often already hold. */
const WALLET_GUIDES = [
  {
    name: "MetaMask",
    steps: [
      "Open MetaMask and click the account name at the top.",
      "Choose Add account or hardware wallet, then Add a new account.",
      "Copy the new address and paste it on the next step.",
    ],
  },
  {
    name: "Rainbow",
    steps: [
      "Open Rainbow and tap the account name at the top.",
      "Choose Add another wallet, then Create a new wallet.",
      "Copy the new address and paste it on the next step.",
    ],
  },
  {
    name: "Rabby",
    steps: [
      "Open Rabby and click the address at the top.",
      "Choose Add an address, then Add from current seed phrase.",
      "Copy the new address and paste it on the next step.",
    ],
  },
] as const

/** A card that opens its branch; the recommended one is framed. */
function MethodOption({
  icon,
  title,
  body,
  recommended = false,
  onOpen,
  children,
}: {
  icon: ReactNode
  title: string
  body: string
  recommended?: boolean
  onOpen: () => void
  children?: ReactNode
}) {
  return (
    <button
      type="button"
      className={
        "zkm-btn-reset zkm-pressable ww-deposit__connect" +
        (recommended ? " ww-paymethod--best" : "")
      }
      style={{ position: "relative" }}
      onClick={onOpen}
    >
      <span className="ww-deposit__connect-icon" style={{ alignSelf: "flex-start" }}>
        {icon}
      </span>
      <span className="ww-deposit__connect-text">
        <b>{title}</b>
        <span style={{ lineHeight: 1.4 }}>{body}</span>
        {children}
      </span>
      <span style={{ marginLeft: "auto", flexShrink: 0, display: "flex" }}>
        <Icon name="chevron-right" size={16} color="var(--text-secondary)" />
      </span>
    </button>
  )
}

function FreshAddressHowTo() {
  const [open, setOpen] = useState(false)
  const [guide, setGuide] = useState<(typeof WALLET_GUIDES)[number]>(WALLET_GUIDES[0])
  const bodyId = useId()
  return (
    <div className="ww-deposit__facts ww-withdraw__howto">
      <button
        type="button"
        className="zkm-btn-reset ww-sheet__fact"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((current) => !current)}
      >
        Need a fresh address? See how to create one.
        <Icon name={open ? "chevron-up" : "chevron-down"} size={16} />
      </button>
      {open && (
        <div id={bodyId} className="ww-deposit__fields">
          <div className="zkm-amount-chips" role="tablist" aria-label="Wallet">
            {WALLET_GUIDES.map((g) => (
              <button
                key={g.name}
                type="button"
                role="tab"
                aria-selected={g === guide}
                className={
                  "zkm-btn-reset zkm-pressable zkm-amount-chip zkm-amount-chip--flat" +
                  (g === guide ? " zkm-amount-chip--selected" : "")
                }
                onClick={() => setGuide(g)}
              >
                {g.name}
              </button>
            ))}
          </div>
          <div className="ww-deposit__fields" role="tabpanel">
            {guide.steps.map((step, i) => (
              <NumberedStepRow key={step} index={i + 1}>
                {step}
              </NumberedStepRow>
            ))}
          </div>
          <p className="ww-sheet__note">
            A new account in a wallet you already own is fine: onchain it has no history. Your main
            account does.
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * The method step of `/withdraw`, and the panel the existing-address sheet opens over. Each card
 * opens its branch. A deployment without the swap stack offers the existing address alone.
 */
export function WithdrawMethodScreen() {
  const available = useFreshAddressAvailable()
  const navigate = useNavigate()

  return (
    <div className="ww-panel ww-withdraw">
      <h2 className="ww-chat__head ww-invite-modal-title">
        <GradientText weight={700}>Select withdrawal method</GradientText>
      </h2>
      {available !== undefined && (
        <div className="ww-panel__scroll">
          <div className="ww-paymethods" style={{ gap: 24 }}>
            {available && (
              <div className="ww-contacts__section">
                <MethodOption
                  icon={<img src={spyIcon} alt="" width={24} height={24} />}
                  title="Withdraw to a fresh address"
                  body="Withdraw to a new address and add gas simultaneously. No onchain history connects it back to you."
                  recommended
                  onOpen={() => navigate("/withdraw/fresh")}
                >
                  <span className="ww-withdraw__tags">
                    <span className="ww-withdraw__tag ww-withdraw__tag--private">
                      Fully private
                    </span>
                    <span className="ww-withdraw__tag ww-withdraw__tag--recommended">
                      <GradientText gradient="brand" size={11} weight={600}>
                        Recommended
                      </GradientText>
                    </span>
                  </span>
                </MethodOption>
                <FreshAddressHowTo />
              </div>
            )}
            <MethodOption
              icon={<img src={walletIcon} alt="" width={19} height={17} />}
              title="Withdraw to an existing address"
              body="The destination address may have transaction history on the blockchain."
              onOpen={() => navigate("/withdraw/existing")}
            />
          </div>
        </div>
      )}
      <Outlet />
    </div>
  )
}
