import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useStore } from "@obsidion/front-core"
import type { ContactRow as ContactRowData } from "@obsidion/front-core"
import { useContactDirectory } from "../../../session/contacts"
import { ContactRow, GradientText, Icon, avatarColors } from "@obsidion/web-ds"
import { PaylinkInfoModal, shownVariant } from "../../paylink/PaylinkInfoModal"
import { voucherAvailable } from "../../paylink/sponsoredPaylink"
import { usePaylinkDeps } from "../../paylink/usePaylinkDeps"
import { StableCopy } from "../../../ui/StableCopy"
import { holdOrder, recentPeople } from "../recentPeople"
import { useSession } from "../../../session/session"
import styles from "./SendScreen.module.css"
import copy from "./SendScreen.copy"

const RECENT_COUNT = 4
const SEND_LINE = [copy.paylinkLine.account, copy.paylinkLine.anyone]
const NO_ROWS: readonly ContactRowData[] = []

/** Send entry: paylink shortcut or pick someone recent. */
export function SendScreen() {
  const navigate = useNavigate()
  const { contacts, hydrated, failed } = useContactDirectory()
  const session = useSession()
  const { contactActivity, device } = session
  const sources = useStore(contactActivity)
  const latest = useMemo(() => recentPeople(contacts, sources, RECENT_COUNT), [contacts, sources])
  const ready = (hydrated || failed) && !!sources.hydrated
  // The first complete order stays for this visit, though discovery finds more while it is open.
  const [held, setHeld] = useState({ session, rows: NO_ROWS })
  const shown = held.session === session ? held.rows : NO_ROWS
  const recent = ready ? holdOrder(shown, latest, contacts, RECENT_COUNT) : latest
  if (ready && (held.session !== session || recent !== held.rows))
    setHeld({ session, rows: recent })
  // Hidden until its order is known; "View all" hides too, so it never moves under a finger.
  const pending = ready ? "" : styles.sendRecentPending
  // "first-use" fronts "Send via paylink" until the user hides it; "explain" is the "Open" button.
  const [info, setInfo] = useState<"first-use" | "explain">()
  const newLink = () => navigate("/links/new")
  const deps = usePaylinkDeps()
  // Undefined while the allowance read is in flight.
  const [voucher, setVoucher] = useState<boolean>()
  // eslint-disable-next-line local/effect-hook -- ZKM-1806
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
    <div className={`ww-panel ${styles.panelEntry}`}>
      <div className="ww-panel__head">
        <GradientText size={24} weight={700}>
          {copy.title}
        </GradientText>
      </div>
      <div className="ww-panel__scroll">
        <div className={styles.sendPaylink}>
          <button
            type="button"
            className="zkm-btn-reset ww-send-option"
            onClick={() => (device.get().hidePaylinkInfo ? newLink() : setInfo("first-use"))}
          >
            <span className={styles.sendOptionBody}>
              <span className="ww-send-option__icon">
                <Icon name="link" size={24} color="#fff" />
              </span>
              <span className="ww-send-option__text">
                <span>{copy.paylink}</span>
                <StableCopy variants={SEND_LINE} shown={shownVariant(voucher)} />
              </span>
            </span>
            <Icon name="chevron-right" size={16} color="var(--text-secondary)" />
          </button>
          <button
            type="button"
            className={`zkm-btn-reset ${styles.sendHowto}`}
            onClick={() => setInfo("explain")}
          >
            {copy.howto}
            <span className={styles.sendHowtoCta}>{copy.open}</span>
          </button>
        </div>

        <div className={styles.sendOr}>
          <hr className="ww-divider" />
          <span>{copy.or}</span>
          <hr className="ww-divider" />
        </div>

        <div className="ww-contacts__section">
          <span className="ww-contacts__label">{copy.recent}</span>
          {recent.length === 0 ? (
            <span className={`ww-contacts__label ww-contacts__empty ${pending}`}>{copy.empty}</span>
          ) : (
            <div className={`ww-contacts__group ${pending}`}>
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
            className={`zkm-btn-reset ${styles.sendAll} ${pending}`}
            onClick={() => navigate("/contacts")}
          >
            {copy.viewAll}
          </button>
        </div>
      </div>
      {info && (
        <PaylinkInfoModal
          offerHide={info === "first-use"}
          voucher={voucher}
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
