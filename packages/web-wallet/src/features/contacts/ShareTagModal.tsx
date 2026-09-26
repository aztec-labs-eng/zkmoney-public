import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { IssuedConnectStorage, qrPayloadDisplayLabel } from "@obsidion/front-core"
import { GradientText, Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { GradientQrCard } from "../../ui/GradientQrCard"
import { Modal } from "../../ui/Modal"
import { PhoneIcon, type PhoneIconName } from "../../ui/PhoneIcon"
import { usePhoneLayout } from "../../ui/usePhoneLayout"
import { useCopy, useLinkSharing } from "../../ui/hooks"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { mintMyConnectLink } from "./myCode"

function ShareAction({
  phone,
  title,
  icon,
  onClick,
}: {
  phone: boolean
  title: string
  icon?: PhoneIconName
  onClick: () => void
}) {
  if (!phone) {
    return <PrimaryGradientButton title={title} buttonStyle="dark" leadingIcon={icon} onClick={onClick} />
  }
  return (
    <button type="button" className="zkm-btn-reset zkm-pressable ww-share-tag__action" onClick={onClick}>
      {icon && <PhoneIcon name={icon} size={24} color="#fff" />}
      {title}
    </button>
  )
}

/** "Share @tag": a fresh single-use connect QR. One mint per open; retry on failure.
 *
 *  Every affordance carries the connect link — the QR, Share, and both copy controls. Only the
 *  link reaches the scanner with the handshake packet in it; the sharer's handle alone would
 *  identify them but leave nothing to connect back to. The band shows the scheme-stripped link
 *  (CSS-truncated) so the sharer can see what they're handing out. */
export function ShareTagModal({ onClose, onScan }: { onClose: () => void; onScan?: () => void }) {
  const phone = usePhoneLayout()
  const body = useRef<HTMLDivElement>(null)
  const previousLayout = useRef(phone)
  useLayoutEffect(() => {
    // A resized control may unmount; keep keyboard focus in the same dialog session.
    if (previousLayout.current !== phone && document.activeElement === document.body) {
      body.current?.closest<HTMLElement>('[role="dialog"]')?.focus()
    }
    previousLayout.current = phone
  }, [phone])
  const alive = useRef(false)
  const inFlight = useRef(false)
  const [payload, setPayload] = useState<string | null>(null)
  const [error, setError] = useState(false)
  // Two copy states, not one: Share falls back to the clipboard where the Web Share API is
  // missing, and its confirmation belongs on its own button.
  const { copied: shareCopied, share } = useLinkSharing(payload ?? undefined, "My zk.money tag")
  const { copied: linkCopied, copy: copyLink } = useCopy()

  const mint = useCallback(async () => {
    if (!alive.current || inFlight.current) return
    inFlight.current = true
    setPayload(null)
    setError(false)
    try {
      const msk = await getAuthService().getSecretKey()
      if (!alive.current) return
      if (!msk) throw new Error("wallet locked")
      const identity = loadWalletIdentity()
      const next = await mintMyConnectLink({
        ownTag: identity?.handle,
        masterSecret: msk,
        chain: getConfig().network,
        l2Address: identity?.address,
        record: async (uuid) => {
          if (!alive.current) throw new Error("Share closed")
          await IssuedConnectStorage.get().recordHandshake(uuid)
        },
      })
      if (alive.current) setPayload(next)
    } catch (e) {
      if (!alive.current) return
      // Owned here rather than raised to the global error modal: a failed mint is recoverable in
      // place, and stacking a report dialog over this sheet buries the Retry behind it.
      console.warn("[ShareTagModal] mint failed", e)
      setError(true)
    } finally {
      inFlight.current = false
    }
  }, [])

  // The mint writes a handshake uuid to the ledger, so StrictMode's dev double-effect must not
  // run it twice and strand one nobody can connect back to.
  const minted = useRef(false)
  useEffect(() => {
    alive.current = true
    if (!minted.current) {
      minted.current = true
      void mint()
    }
    return () => {
      alive.current = false
    }
  }, [mint])

  return (
    <Modal
      variant={phone ? "bare" : "create"}
      className="ww-share-tag-modal"
      label="Share @tag"
      onClose={onClose}
    >
      <div key="share-body" ref={body} className="ww-create-modal__body ww-share-tag">
        {phone && (
          <button
            type="button"
            className="zkm-btn-reset zkm-pressable ww-share-tag__close"
            aria-label="Close"
            onClick={onClose}
          >
            <PhoneIcon name="x" size={24} />
          </button>
        )}
        <div className="ww-share-tag__head">
          <GradientText size={24} weight={700}>
            Share @tag
          </GradientText>
          <span className="ww-share-tag__subtitle">{phone ? "Let other users find you" : "Let your friends find you"}</span>
        </div>

        {payload ? (
          <>
            <GradientQrCard
              payload={payload}
              label={qrPayloadDisplayLabel(payload)}
              ariaLabel="My connect QR code"
              copied={linkCopied}
              copyIcon={phone ? <PhoneIcon name="copy" size={16} color="#fff" /> : undefined}
              onCopy={() => void copyLink(payload)}
            />
            <div className="ww-share-modal__buttons">
              <ShareAction
                phone={phone}
                title={shareCopied ? "Link copied!" : "Share"}
                icon="share-forward"
                onClick={() => void share()}
              />
              <ShareAction
                phone={phone}
                title={linkCopied ? "Copied!" : "Copy link"}
                onClick={() => void copyLink(payload)}
              />
            </div>
          </>
        ) : error ? (
          <>
            <span className="ww-share-tag__pending">
              Couldn't generate your code. Check your connection and try again.
            </span>
            <PrimaryGradientButton title="Retry" onClick={() => void mint()} />
          </>
        ) : (
          <span className="ww-share-tag__pending">Generating code…</span>
        )}
        {onScan && (
          <button type="button" className="zkm-btn-reset ww-share-tag__scan" onClick={onScan}>
            <span>
              Searching someone? <strong>Scan instead</strong>
            </span>
            {phone ? <PhoneIcon name="scan" size={20} color="#fff" /> : <Icon name="scan" size={20} />}
          </button>
        )}
      </div>
    </Modal>
  )
}
