import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useContactsDirectory } from "@obsidion/front-core"
import { ContactRow, GradientText, Icon, avatarColors } from "@obsidion/web-ds"
import { PaylinkInfoModal, isPaylinkInfoHidden } from "../paylink/PaylinkInfoModal"
import { voucherAvailable } from "../paylink/sponsoredPaylink"
import { usePaylinkDeps } from "../paylink/usePaylinkDeps"
import { recentPeople } from "./recentPeople"
import { useContactActivity } from "./useContactActivity"

const RECENT_COUNT = 4

/** Send entry: paylink shortcut or pick someone recent. */
export function SendScreen() {
  const navigate = useNavigate()
  const { contacts } = useContactsDirectory()
  const sources = useContactActivity(true)
  const recent = useMemo(() => recentPeople(contacts, sources, RECENT_COUNT), [contacts, sources])
  // "first-use" fronts "Send via paylink" until the user hides it; "explain" is the "Open" button.
  const [info, setInfo] = useState<"first-use" | "explain">()
  const newLink = () => navigate("/links/new")
  const deps = usePaylinkDeps()
  // Undefined while the allowance read is in flight.
  const [voucher, setVoucher] = useState<boolean>()
  useEffect(() => {
    setVoucher(undefined)
    if (!deps) return
    let stale = false
    void voucherAvailable(deps).then((ok) => !stale && setVoucher(ok))
    return () => {
      stale = true
    }
  }, [deps])

  return (
    <div className="ww-panel ww-panel--entry">
      <div className="ww-panel__head">
        <GradientText size={24} weight={700}>
          Send
        </GradientText>
      </div>
      <div className="ww-panel__scroll">
        <div className="ww-send-paylink">
          <button
            type="button"
            className="zkm-btn-reset ww-send-option"
            onClick={() => (isPaylinkInfoHidden() ? newLink() : setInfo("first-use"))}
          >
            <span className="ww-send-option__body">
              <span className="ww-send-option__icon">
                <Icon name="link" size={24} color="#fff" />
              </span>
              <span className="ww-send-option__text">
                <span>Send via paylink</span>
                <span>
                  {voucher
                    ? "Pay anyone, no account needed. They claim to zk.money or any ETH address."
                    : "Pay anyone via paylink. They'll need a zk.money account to claim."}
                </span>
              </span>
            </span>
            <Icon name="chevron-right" size={16} color="var(--text-secondary)" />
          </button>
          <button
            type="button"
            className="zkm-btn-reset ww-send-howto"
            onClick={() => setInfo("explain")}
          >
            What is a paylink?
            <span className="ww-send-howto__cta">Open</span>
          </button>
        </div>

        <div className="ww-send-or">
          <hr className="ww-divider" />
          <span>or pick someone</span>
          <hr className="ww-divider" />
        </div>

        <div className="ww-contacts__section">
          <span className="ww-contacts__label">Recent</span>
          {recent.length === 0 ? (
            <span className="ww-contacts__label ww-contacts__empty">
              No one yet. Search a @tag above, or use a paylink.
            </span>
          ) : (
            <div className="ww-contacts__group">
              {recent.map((c) => {
                const l1 = c.addressKind === "ethereum-l1"
                const base = `/contacts/${encodeURIComponent(c.id)}`
                return (
                  <ContactRow
                    key={c.id}
                    tag={c.tag}
                    name={c.name}
                    isL1={l1}
                    colors={avatarColors(c.tag)}
                    onClick={() => navigate(l1 ? base : `${base}/send`)}
                  />
                )
              })}
            </div>
          )}
          <button
            type="button"
            className="zkm-btn-reset ww-send-all"
            onClick={() => navigate("/contacts")}
          >
            View all contacts
          </button>
        </div>
      </div>
      {info && (
        <PaylinkInfoModal
          offerHide={info === "first-use"}
          voucher={voucher === true}
          onClose={() => setInfo(undefined)}
          onGotIt={() => {
            setInfo(undefined)
            if (info === "first-use") newLink()
          }}
        />
      )}
    </div>
  )
}
