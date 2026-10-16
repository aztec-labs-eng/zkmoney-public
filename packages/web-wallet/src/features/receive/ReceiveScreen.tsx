import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "react-router-dom"
import { GradientText, Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { useAssetContext } from "@obsidion/front-core"
import { PAYMENT_REQUEST_NOTE_MAX_LEN } from "@obsidion/sdk"
import { fireEvent, requestAmountBucket } from "../../lib/analytics"
import { BrandLockup } from "../../ui/BrandLockup"
import { StyledQr } from "../../ui/StyledQr"
import { usePhoneLayout } from "../../ui/usePhoneLayout"
import { useBack, useLinkSharing, useWakeLock } from "../../ui/hooks"
import { requestShareText } from "../requests/shareView"
import { useRegistrationDepositOwed } from "../onboarding/openRegistration"
import { REQUESTS_PATH } from "../requests/nonContactView"
import { requestFromContact } from "../contacts/contactPay"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { PrintedCard, printedCodeHost, useSaveCard } from "./PrintedCard"
import { CODE_LOGO, ReceiveCodeCard, ReceivePaid, WaitingLine } from "./ReceiveCodeFace"
import { parseRequestAmount } from "./receiveView"
import { RequestContactPicker } from "./RequestContactPicker"
import { useCodeForm } from "./useCodeForm"
import { useReceiveCode } from "./useReceiveCode"

/**
 * New request, routed at /receive: the amount and note, then who from. A contact gets it in their
 * Received list; anyone else scans the code or opens the link. Full screen shows the live code and
 * saves or prints the permanent one.
 */
export function ReceiveScreen() {
  const navigate = useNavigate()
  const back = useBack(REQUESTS_PATH)
  // A request names the tag as payee, so until the name is activated the way on is the deposit.
  const awaitingActivation = useRegistrationDepositOwed()
  const { tag, code, payment, setAmount, showCode } = useReceiveCode(!awaitingActivation)
  const { copied, copy, share } = useLinkSharing(
    code?.url,
    "Pay me",
    requestShareText(code?.amount ?? 0),
  )
  const [full, setFull] = useState(false)
  useWakeLock(!!code && !payment)

  const enterFull = () => {
    setFull(true)
    document.documentElement.requestFullscreen?.().catch(() => {})
  }
  const exitFull = () => {
    setFull(false)
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  }
  // A payment closes full screen onto the paid state; the next code shows only after Show code.
  useEffect(() => {
    if (payment) exitFull()
  }, [payment])
  // Leaving browser full screen leaves ours too, and Escape closes ours where there is none.
  useEffect(() => {
    if (!full) return
    const onChange = () => !document.fullscreenElement && setFull(false)
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false)
    document.addEventListener("fullscreenchange", onChange)
    document.addEventListener("keydown", onKey)
    const overflow = document.documentElement.style.overflow
    document.documentElement.style.overflow = "hidden"
    return () => {
      document.documentElement.style.overflow = overflow
      document.removeEventListener("fullscreenchange", onChange)
      document.removeEventListener("keydown", onKey)
    }
  }, [full])

  const form = useCodeForm(code, setAmount)
  const phone = usePhoneLayout()
  const card = useSaveCard(tag ?? "")
  const { tokenService } = useAssetContext()
  const [who, setWho] = useState<"contact" | "anyone">("anyone")
  const [sending, setSending] = useState<string>()
  const [sendError, setSendError] = useState("")
  const [shake, setShake] = useState(false)
  const amountInput = useRef<HTMLInputElement>(null)
  const amount = parseRequestAmount(form.amount)

  const requestContact = async (contact: string) => {
    const requesterTag = loadWalletIdentity()?.handle
    if (!amount) {
      setShake(true)
      amountInput.current?.focus()
      return
    }
    if (!tokenService || !requesterTag) return
    setSending(contact)
    setSendError("")
    try {
      await requestFromContact(
        { tokenService },
        {
          tag: contact,
          requesterTag,
          amountDisplay: String(amount),
          note: form.note.trim() || undefined,
        },
      )
      fireEvent("request_created", {
        source: "contact",
        amount_bucket: requestAmountBucket(amount),
      })
      navigate(REQUESTS_PATH)
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Couldn't send the request")
      setSending(undefined)
    }
  }

  const tab = (value: typeof who, label: string, icon: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={who === value}
      className="zkm-btn-reset ww-request-who__tab"
      onClick={() => setWho(value)}
    >
      <Icon name={icon} size={18} />
      {label}
    </button>
  )

  const content = payment ? (
    <ReceivePaid payment={payment} next={code} onShowCode={showCode} />
  ) : awaitingActivation || !tag ? (
    <div className="ww-receive__card">
      <span className="ww-receive__eyebrow">Scan to pay</span>
      <button
        type="button"
        className="zkm-btn-reset ww-receive__qr ww-receive__qr--empty"
        onClick={() => navigate("/deposit")}
      >
        Your code shows once your name is active.
      </button>
    </div>
  ) : (
    <>
      <section className="ww-request-form">
        <label className="zkm-field">
          <span className="zkm-field__label">Amount</span>
          <span
            className="zkm-field__box ww-request-form__amount"
            data-shake={shake || undefined}
            onAnimationEnd={() => setShake(false)}
          >
            <span className="ww-request-form__currency">$</span>
            <input
              ref={amountInput}
              className="zkm-field__input"
              aria-label="Amount"
              placeholder="0.00"
              inputMode="decimal"
              value={form.amount}
              onChange={(e) => form.setAmount(e.target.value.replace(/^\$/, ""))}
            />
            <span className="ww-request-form__unit">USD</span>
          </span>
        </label>
        <label className="zkm-field">
          <span className="zkm-field__label ww-request-form__label">
            Note <i>Optional</i>
          </span>
          <span className="zkm-field__box">
            <input
              className="zkm-field__input"
              aria-label="Note"
              maxLength={PAYMENT_REQUEST_NOTE_MAX_LEN}
              placeholder="What's it for?"
              value={form.note}
              onChange={(e) => form.setNote(e.target.value)}
            />
          </span>
        </label>
        {form.error && <span className="ww-receive__error">{form.error}</span>}
      </section>
      <span className="ww-receive__who">Who from?</span>
      <div className="ww-request-who" role="tablist" aria-label="Who from" data-who={who}>
        {tab("contact", "A contact", "person")}
        {tab("anyone", "Anyone", "link")}
      </div>
      {who === "anyone" ? (
        <div role="tabpanel" className="ww-request-anyone">
          <div className="ww-request-anyone__code">
            <button
              type="button"
              className={`zkm-btn-reset ww-request-anyone__qr${
                code ? "" : " ww-deposit-sheet__qr--pulse"
              }`}
              aria-label="Fill the screen with your code"
              disabled={!code}
              onClick={enterFull}
            >
              {code && (
                <StyledQr value={code.url} icon={CODE_LOGO} label="Your pay code" size={128} />
              )}
            </button>
            <span className="ww-request-anyone__text">
              <b>Scan or share</b>
              <span>Pay from zk.money or any Ethereum wallet</span>
              <button
                type="button"
                className="zkm-btn-reset ww-receive__full"
                disabled={!code}
                onClick={enterFull}
              >
                <Icon name="qr-code" size={14} />
                Full screen
              </button>
            </span>
          </div>
          <WaitingLine code={code} />
        </div>
      ) : (
        <div role="tabpanel">
          <RequestContactPicker
            sending={sending}
            dimmed={!amount}
            onRequest={(tag) => void requestContact(tag)}
          />
          {sendError && <span className="ww-receive__error">{sendError}</span>}
        </div>
      )}
      {who === "anyone" && (
        <section className="ww-receive__rows">
          <PrimaryGradientButton
            title={phone ? "Share link" : copied ? "Copied" : "Copy link"}
            leadingIcon={phone ? "share" : copied ? "check" : "copy"}
            isDisabled={!code}
            onClick={() => void (phone ? share() : copy())}
          />
        </section>
      )}
    </>
  )

  return (
    <div className="ww-panel ww-receive">
      <div className="ww-panel__head ww-modal__head">
        <span className="ww-modal__head-slot">
          <TopNavIconButton icon="arrow-left" ariaLabel="Back" onClick={back} />
        </span>
        <span className="ww-modal__head-title">
          <GradientText size={24} weight={700}>
            New request
          </GradientText>
        </span>
        <span className="ww-modal__head-slot" />
      </div>
      <div className="ww-panel__scroll ww-receive__body">{content}</div>

      {full &&
        !payment &&
        tag &&
        code &&
        createPortal(
          <div className="ww-receive-full" role="dialog" aria-label="Your code">
            <div className="ww-receive-full__bar">
              <BrandLockup />
              <TopNavIconButton icon="x" ariaLabel="Close full screen" onClick={exitFull} />
            </div>
            <ReceiveCodeCard tag={tag} code={code} />
            <WaitingLine code={code} />
            <div className="ww-receive-full__print">
              <div className="ww-receive__actions">
                <PrimaryGradientButton
                  title="Save"
                  buttonStyle="dark"
                  leadingIcon="download"
                  isLoading={card.saving}
                  onClick={() => void card.save()}
                />
                <PrimaryGradientButton
                  title="Print"
                  buttonStyle="dark"
                  leadingIcon="print"
                  onClick={() => window.print()}
                />
              </div>
              <span className="ww-receive-full__note">
                Save and Print use {printedCodeHost(tag)}, which never expires.
              </span>
            </div>
            <PrintedCard tag={tag} />
          </div>,
          document.body,
        )}
    </div>
  )
}
