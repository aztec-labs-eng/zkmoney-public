import { Modal } from "../../ui/Modal"
import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useBalance, parseEscrowAmount, TxInFlightError } from "@obsidion/front-core"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import { PAYLINK_MEMO_MAX_BYTES, truncateUtf8 } from "@obsidion/sdk"
import {
  ConfirmationSheetDetailRow,
  GradientToggle,
  Icon,
  PrimaryGradientButton,
  TextField,
} from "@obsidion/web-ds"
import { showReportableError } from "../../errors/errorModal"
import { failureCode, fireEvent } from "../../lib/analytics"
import { SendScreen } from "../contacts/SendScreen"
import type { CreateStage, PaymentLink } from "./types"
import {
  DEFAULT_CLAIM_WINDOW_DAYS,
  createSponsoredLink,
  hasPendingDeposits,
  voucherAvailable,
} from "./sponsoredPaylink"
import { usePaylinkDeps } from "./usePaylinkDeps"
import { useGoldenTicketOffer } from "./goldenTicketOffer"
import {
  linkBaseUnits,
  linkTicketEligibility,
  TICKET_GRANT_COPY,
  ticketThresholdHint,
  ticketThresholdLabel,
} from "./ticketThreshold"
import { PayModalChrome } from "../../ui/PayModalChrome"
import { TeeSignerNotice } from "../../ui/TeeSignerNotice"
import { useBack, useProvingOutcome } from "../../ui/hooks"
import { useUserFlowActive } from "../provingGate"
import { amountError, decimalInput, floorToCents, parseAmount, usd } from "../../ui/format"
import { emailLockedLinksEnabled } from "../../config/features"
import { useBusyLabel } from "../operations/operations"
import { OperationHandOff } from "../operations/OperationHandOff"
import { SponsoredActionNotice, useSponsoredActionBlock } from "../allowance/SponsoredActionNotice"

type Phase = "amount" | "options" | "confirm" | "working"

const PREVIOUS_PHASE: Partial<Record<Phase, Phase>> = { options: "amount", confirm: "options" }
const EXPIRY_DAYS = [1, 7, 30]
const MIN_AMOUNT = 1

/**
 * Create a payment link as a modal over Send: amount → expiry/protect → review → passkey → share.
 * Sponsored, so the fee row reads free. The link exists before the passkey prompt, so as the
 * ceremony ends the link's own detail sheet opens over Activity with the URL ready to copy, and the
 * deposit proves under the bell.
 */
export function NewLinkScreen() {
  const navigate = useNavigate()
  const back = useBack("/send")
  const deps = usePaylinkDeps()
  const { walletAsset, walletBalance, assetsLoaded } = useBalance()

  const [phase, setPhase] = useState<Phase>("amount")
  const previousPhase = PREVIOUS_PHASE[phase]
  const [amount, setAmount] = useState("")
  const [note, setNote] = useState("")
  const [expiryDays, setExpiryDays] = useState(DEFAULT_CLAIM_WINDOW_DAYS)
  const [protectEnabled, setProtectEnabled] = useState(false)
  const [email, setEmail] = useState("")
  const [stage, setStage] = useState<CreateStage>("building")
  const [failedOnce, setFailedOnce] = useState(false)
  // Whether the link will carry a cash-out voucher; undefined while the allowance read is in flight.
  const [voucher, setVoucher] = useState<boolean>()
  // Cancel is honoured only before proving starts; the sponsored rail can't abort a proof.
  const cancelled = useRef(false)
  const left = useRef(false)
  const link = useRef<PaymentLink | null>(null)

  useEffect(() => fireEvent("paylink_create_opened"), [])
  const outcome = useProvingOutcome("paylink-create")

  const leave = () => {
    left.current = true
    outcome.finish()
    const state = link.current ? { openPaylink: link.current.url } : undefined
    navigate("/activity", { replace: true, state })
  }

  const parsed = parseAmount(amount)
  const validAmount = Number.isFinite(parsed) && parsed >= MIN_AMOUNT
  const belowMin = Number.isFinite(parsed) && parsed < MIN_AMOUNT
  const trimmedEmail = email.trim()
  // Minimal address-shape check; the SDK enforces the 64-byte cap at create.
  const validEmail =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail) &&
    new TextEncoder().encode(trimmedEmail).length <= 64
  const emailLocked = protectEnabled && !!trimmedEmail
  // Only a KNOWN shortfall blocks: a balance still loading reads 0 and would flag every amount, and
  // parked deposits are spendable here without ever reaching `assets` (create redeems them itself).
  // Past those, a $0 account blocks too — the escrow it can't fund reverts a minute into proving,
  // after the passkey prompt, and the link never exists.
  const overspent =
    assetsLoaded &&
    !hasPendingDeposits() &&
    (validAmount ? parseEscrowAmount(amount, walletAsset?.decimals ?? 0).atomic : 0n) >
      (walletAsset?.balanceAtomic ?? 0n)
  const canNext = validAmount && !overspent
  const canConfirm = !protectEnabled || validEmail
  // The asset layer connects async after mount; the CTA waits for the full deps set.
  const ready = !!deps
  const busy = useUserFlowActive()
  const busyLabel = useBusyLabel()
  const unsponsored = useSponsoredActionBlock(phase === "confirm")
  // Resolved on the review sheet, so the row promises exactly what the create will do.
  useEffect(() => {
    if (phase !== "confirm" || !deps) return
    let stale = false
    setVoucher(undefined)
    void voucherAvailable(deps).then((ok) => !stale && setVoucher(ok))
    return () => {
      stale = true
    }
  }, [phase, deps])
  const voucherKnown = voucher !== undefined
  // The visitor page reads the same offer and amount: a link at the threshold, carrying a voucher,
  // pays a new user's tag.
  const { offer } = useGoldenTicketOffer()
  const decimals = walletAsset?.decimals
  const ticketMinimum =
    offer && decimals !== undefined ? ticketThresholdLabel(offer.threshold, decimals) : undefined
  const amountUnits =
    validAmount && decimals !== undefined ? linkBaseUnits(amount, decimals) : undefined
  // The voucher is read on the review sheet: only there can the link itself be promised.
  const grantsTicket = linkTicketEligibility(offer, amountUnits, voucher === true) === "eligible"

  // Input complete (amount + options), review sheet next — email_locked is decided by here.
  const toConfirm = () => {
    fireEvent("paylink_create_amount_confirmed", { email_locked: emailLocked })
    setPhase("confirm")
  }

  const create = async () => {
    fireEvent("paylink_create_submitted", { email_locked: emailLocked })
    if (failedOnce) fireEvent("retry_clicked", { flow: "paylink-create" })
    outcome.start("building")
    setPhase("working")
    setStage("building")
    const cancellation = new Error("Cancelled")
    cancelled.current = false
    link.current = null
    try {
      // The raw string goes through — parseEscrowAmount keeps full precision
      // at the token's decimals. The CTA gates on `ready`, so deps is present here.
      await createSponsoredLink(
        deps!,
        amount,
        (s) => {
          if (s === "proving" && cancelled.current) throw cancellation
          outcome.updateStage(s)
          setStage(s)
        },
        {
          email: emailLocked ? trimmedEmail : undefined,
          expiryDays,
          memo: note.trim() || undefined,
          onLink: (l) => {
            link.current = l
          },
          voucher: voucher === true,
        },
      )
      outcome.finish()
    } catch (e) {
      if (e === cancellation || isPasskeyCancelled(e)) {
        outcome.cancel()
        setPhase("confirm")
        return
      }
      // Reached the node: the chain settles the operation. A failure here would put a retry under a
      // link that may well exist.
      if (e instanceof TxInFlightError) {
        outcome.finish()
        return
      }
      outcome.finish()
      fireEvent("action_failed", { action: "paylink:create", code: failureCode(e) })
      // Past the hand-off the create's operation row reports it.
      if (left.current) return
      showReportableError(e, "paylink:create")
      setFailedOnce(true)
      setPhase("confirm")
    }
  }

  const feeRows = (
    <div className="ww-pay__summary">
      <ConfirmationSheetDetailRow label="Fee" value="Free" />
    </div>
  )

  return (
    <>
      <SendScreen />
      <Modal
        variant="bare"
        label="Send via paylink"
        className="ww-pay"
        onClose={phase === "working" ? undefined : back}
      >
        {phase === "working" ? (
          <OperationHandOff
            onLeave={leave}
            onCancel={
              stage === "building"
                ? () => {
                    cancelled.current = true
                  }
                : undefined
            }
          />
        ) : (
          <>
            <PayModalChrome
              title="Send via paylink"
              subtitle=""
              onClose={back}
              onBack={previousPhase && (() => setPhase(previousPhase))}
              avatar={
                <span className="ww-send-option__icon">
                  <Icon name="link" size={24} color="#fff" />
                </span>
              }
            />
            <TeeSignerNotice />

            {phase === "amount" && (
              <div className="ww-pay__form">
                <div className="ww-pay__field">
                  <span className="ww-pay__available">
                    Available: <b>${walletBalance}</b>
                  </span>
                  <TextField
                    label="Amount"
                    placeholder={`Minimum $${MIN_AMOUNT}`}
                    inputMode="decimal"
                    autoFocus
                    className="ww-autofocus"
                    value={amount}
                    onChange={(v) => setAmount(decimalInput(v))}
                    onSubmit={() => canNext && setPhase("options")}
                    error={
                      overspent
                        ? "Balance not enough"
                        : (amountError(amount) ??
                          (belowMin ? `Amount too small (minimum $${MIN_AMOUNT})` : undefined))
                    }
                    trailing={
                      <button
                        type="button"
                        className="zkm-btn-reset ww-pay__max"
                        onClick={() =>
                          walletAsset &&
                          setAmount(floorToCents(walletAsset.balanceAtomic, walletAsset.decimals))
                        }
                      >
                        MAX
                      </button>
                    }
                  />
                </div>
                <TextField
                  label="Add note (optional)"
                  placeholder="e.g. dinner"
                  value={note}
                  onChange={(v) => setNote(truncateUtf8(v, PAYLINK_MEMO_MAX_BYTES))}
                  onSubmit={() => canNext && setPhase("options")}
                />
                {feeRows}
                {ticketMinimum !== undefined && (
                  <span className="zkm-type-body-sm" style={{ color: "var(--text-secondary)" }}>
                    {ticketThresholdHint(ticketMinimum)}
                  </span>
                )}
                <PrimaryGradientButton
                  title="Next"
                  isDisabled={!canNext}
                  onClick={() => setPhase("options")}
                />
              </div>
            )}

            {phase === "options" && (
              <div className="ww-pay__form">
                <label className="zkm-field">
                  <span className="zkm-field__label">Link expiry</span>
                  <span className="zkm-field__box ww-select">
                    <select
                      value={expiryDays}
                      onChange={(e) => setExpiryDays(Number(e.target.value))}
                    >
                      {EXPIRY_DAYS.map((d) => (
                        <option key={d} value={d}>
                          Expire in {d} {d === 1 ? "day" : "days"}
                        </option>
                      ))}
                    </select>
                    <Icon name="chevron-down" size={16} color="var(--text-primary)" />
                  </span>
                </label>
                {emailLockedLinksEnabled && (
                  <div className="zkm-field">
                    <span className="zkm-field__label" title="Only the owner of this email can claim">
                      Protect payment
                    </span>
                    <div className="ww-pay__summary">
                      <div className="ww-pay__protect">
                        <span>Require email to claim</span>
                        <GradientToggle isOn={protectEnabled} onChange={setProtectEnabled} />
                      </div>
                      {protectEnabled && (
                        <TextField
                          placeholder="recipient@example.com"
                          type="email"
                          inputMode="email"
                          autoFocus
                          value={email}
                          onChange={setEmail}
                          error={
                            trimmedEmail && !validEmail ? "Enter a valid email address" : undefined
                          }
                          onSubmit={() => canConfirm && toConfirm()}
                        />
                      )}
                      {protectEnabled && (
                        <span className="zkm-type-body-sm" style={{ color: "var(--text-secondary)" }}>
                          This address needs a Google account: the recipient claims by signing in with
                          Google as this exact email.
                        </span>
                      )}
                    </div>
                  </div>
                )}
                <PrimaryGradientButton
                  title="Confirm"
                  isDisabled={!canConfirm}
                  onClick={toConfirm}
                />
              </div>
            )}

            {phase === "confirm" && (
              <div className="ww-pay__form">
                <div className="ww-pay__summary">
                  <ConfirmationSheetDetailRow label="Amount" value={usd(parsed)} />
                  <ConfirmationSheetDetailRow label="Fee" value="Free" />
                  <ConfirmationSheetDetailRow
                    label="Expiry"
                    value={`${expiryDays} ${expiryDays === 1 ? "day" : "days"}`}
                  />
                  {emailLocked && (
                    <ConfirmationSheetDetailRow label="Validation" value={trimmedEmail} />
                  )}
                  {note.trim() && <ConfirmationSheetDetailRow label="Note" value={note.trim()} />}
                  <ConfirmationSheetDetailRow
                    label="Recipient"
                    value={
                      voucher === undefined
                        ? "Checking…"
                        : voucher
                        ? "No account needed"
                        : "Needs a zk.money account"
                    }
                  />
                </div>
                {grantsTicket && (
                  <span className="zkm-type-body-sm" style={{ color: "var(--text-secondary)" }}>
                    {TICKET_GRANT_COPY}
                  </span>
                )}
                {/* Reachable when the balance lands after Next — the CTA is dead without this. */}
                {overspent && <span className="ww-pay__error">Balance not enough</span>}
                <SponsoredActionNotice reason={unsponsored} />
                <PrimaryGradientButton
                  testId="paylink-create"
                  title={
                    busy ? busyLabel : ready && voucherKnown ? "Create paylink" : "Connecting…"
                  }
                  isDisabled={!ready || !voucherKnown || overspent || busy || !!unsponsored}
                  onClick={create}
                />
              </div>
            )}
          </>
        )}
      </Modal>
    </>
  )
}
