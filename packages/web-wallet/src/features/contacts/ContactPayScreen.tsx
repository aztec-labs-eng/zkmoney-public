import { floorToCents, parseAmount } from "../../ui/format"
import { Modal } from "../../ui/Modal"
import { useCallback, useEffect, useRef, useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router-dom"
import {
  ContactStorage,
  useAccountContext,
  useAssetContext,
  useAztecContext,
  useBalance,
  useContractServiceContext,
  TxInFlightError,
  type Contact,
} from "@obsidion/front-core"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import { Icon } from "@obsidion/web-ds"
import { showReportableError } from "../../errors/errorModal"
import {
  amountBucket,
  failureCode,
  fireEvent,
  lapTimer,
  requestAmountBucket,
} from "../../lib/analytics"
import { MessagingBanner } from "../../platform/xmtp/MessagingBanner"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { PayModalChrome } from "../../ui/PayModalChrome"
import { TeeSignerNotice } from "../../ui/TeeSignerNotice"
import { useBack, useProvingOutcome } from "../../ui/hooks"
import { OperationHandOff } from "../operations/OperationHandOff"
import { runContactPay, type PayStage } from "./contactPay"
import { useUserFlowActive } from "../provingGate"
import { findContactEntry } from "./contactsView"
import { lookUpUnsavedContact } from "./unsavedContact"
import { PayAmountForm } from "./PayAmountForm"
import { PayConfirmForm } from "./PayConfirmForm"
import { PayWorking } from "./PayWorking"
import { ContactDetailScreen } from "./ContactDetailScreen"
import { SendScreen } from "./SendScreen"

/** Router state: a fulfilling send carries the request (activity-row Send, or a decoded request
 *  link via `/request`); `from` marks entry from the contact detail, which stays as the backdrop
 *  and is popped back to on success instead of pushed again. Link requests add: `source:"link"`
 *  (no local row — the fulfilled signal must not require one), the packet's `requesterAddress`
 *  pin, and the note. amount 0 = any-amount link (starts on the amount phase). */
interface PayScreenState {
  request?: {
    id: string
    tag?: string
    amount: number
    source?: "link"
    requesterAddress?: string
    note?: string
    /** The request link's own hash, so the payer can switch to the Ethereum route on the landing. */
    hash?: string
  }
  from?: "detail"
}

type Phase = "amount" | "confirm" | "working" | "sent"

/** Send to / request from a contact as a modal over the page it was opened from: amount →
 *  confirm → progress, then straight into the contact chat. A fulfilling send (activity-row Send on an
 *  incoming request) also works for an unsaved requester tag — the send rail registry-resolves the
 *  tag itself — starts on confirm with the requested amount, and on success fulfills the request
 *  and saves the requester as a contact. A plain send to a tag opened unsaved from search saves
 *  nothing. */
export function ContactPayScreen({ mode }: { mode: "send" | "request" }) {
  // A new recipient is a new flow: nothing typed or confirmed for the last one may carry over.
  const { idOrTag } = useParams()
  return <ContactPayFlow key={idOrTag} mode={mode} />
}

function ContactPayFlow({ mode }: { mode: "send" | "request" }) {
  const navigate = useNavigate()
  const { idOrTag } = useParams()
  const routerState = useLocation().state as PayScreenState | null
  const request = routerState?.request
  const { obsidionWallet } = useAztecContext()
  const { obsidionAccount } = useAccountContext()
  const { tokenService } = useAssetContext()
  const { contractService } = useContractServiceContext()
  const { walletAsset, walletBalance, assetsLoaded } = useBalance()

  const [entry, setEntry] = useState<Contact | null | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>(request && request.amount > 0 ? "confirm" : "amount")
  const [amount, setAmount] = useState(request && request.amount > 0 ? String(request.amount) : "")
  const [note, setNote] = useState(request?.note ?? "")
  const [stage, setStage] = useState<PayStage>("resolving")
  const [failedOnce, setFailedOnce] = useState(false)
  // Cancel is honoured only before proving starts; the sponsored rail can't abort a proof.
  const cancelled = useRef(false)
  const left = useRef(false)

  useEffect(() => {
    let current = true
    ContactStorage.get()
      .getEntries()
      .then(async (entries) => {
        const found = findContactEntry(entries, idOrTag ?? "")
        const next = found ?? (request ? null : await lookUpUnsavedContact(idOrTag ?? ""))
        if (current) setEntry(next)
      })
      .catch((e) => {
        console.warn(e)
        if (current) setEntry(null)
      })
    return () => {
      current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the request is fixed for this entry
  }, [idOrTag])

  // Funnel top: a fulfilling send is the payer opening a request; a plain send starts at the
  // contact pick. Fires once per screen entry.
  useEffect(() => {
    if (request) {
      fireEvent("request_opened", {
        source: request.source ?? "contact",
        amount_bucket: requestAmountBucket(request.amount),
      })
    } else if (mode === "send") {
      fireEvent("send_contact_selected")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only funnel entry
  }, [])

  const outcome = useProvingOutcome("send")

  const parsed = parseAmount(amount)
  const validAmount = Number.isFinite(parsed) && parsed > 0
  const isSend = mode === "send"
  // Only a KNOWN shortfall blocks: a balance still loading reads 0 and would flag every amount.
  const overspent = isSend && assetsLoaded && parsed > (walletAsset?.balance ?? 0)
  const targetTag = entry?.tag ?? (isSend ? request?.tag : undefined)
  const ready = isSend
    ? !!(obsidionWallet && obsidionAccount && tokenService && contractService)
    : !!tokenService
  const busy = useUserFlowActive()
  // Abandoning the flow: pop history so the close returns wherever the user came from.
  const back = useBack(entry ? `/contacts/${idOrTag}` : "/send")
  // Finishing the flow: replace so the next back reaches the true origin, not the finished flow.
  const finish = useCallback(() => {
    if (routerState?.from === "detail") navigate(-1)
    else navigate(entry ? `/contacts/${idOrTag}` : "/activity", { replace: true })
  }, [navigate, routerState, entry, idOrTag])

  // Past the hand-off the send outlives this screen: its operation's row reports the end.
  const leave = () => {
    left.current = true
    outcome.finish()
    finish()
  }

  // Brief success beat before the chat takes over; cleanup cancels it if the user leaves first.
  useEffect(() => {
    if (phase !== "sent") return
    const timer = setTimeout(finish, 1500)
    return () => clearTimeout(timer)
  }, [phase, finish])

  const toConfirm = () => {
    // Plain sends only: a fulfilling send belongs to the request funnel, and letting it enter the
    // contact-send funnel mid-way would fabricate step-2/3 conversions with no step 1.
    if (isSend && !request) fireEvent("send_amount_confirmed")
    setPhase("confirm")
  }

  const submit = async () => {
    if (failedOnce) fireEvent("retry_clicked", { flow: isSend ? "send" : "request" })
    if (isSend) outcome.start("resolving")
    setPhase("working")
    setStage("resolving")
    const cancellation = new Error("Cancelled")
    cancelled.current = false
    const elapsed = lapTimer()
    try {
      const tag = targetTag
      // Behind WalletGate, which already applied the stricter onboarded-identity read.
      const senderTag = loadWalletIdentity()?.handle
      if (!tag || !senderTag) throw new Error("Contact or wallet identity unavailable")
      const result = await runContactPay(
        isSend
          ? {
              mode: "send",
              // The confirm CTA gates on `ready`, so the four context values are present here.
              deps: {
                wallet: obsidionWallet!,
                account: obsidionAccount!,
                tokenService: tokenService!,
                contractService: contractService!,
              },
              tag,
              senderTag,
              amountDisplay: amount,
              note: note.trim() || undefined,
              request,
              saveUnsavedRequester: !entry,
            }
          : {
              mode: "request",
              deps: { tokenService: tokenService! },
              tag,
              senderTag,
              amountDisplay: amount,
              note: note.trim() || undefined,
            },
        (s) => {
          // Only here. `submitting` lands after the send has mined, and cancelling there would
          // leave the row pending and skip the request it fulfilled.
          if (s === "proving" && cancelled.current) throw cancellation
          outcome.updateStage(s)
          setStage(s)
        },
      )
      outcome.finish()
      // sendToContact waits for the mine, so duration spans confirm → mine; the per-phase
      // split rides tx_timing (flow "send"). Range only — never the exact amount or tag.
      if (result.txHash) {
        fireEvent("send_submitted", {
          duration_ms: elapsed(),
          amount_bucket: amountBucket(BigInt(Math.floor(parsed)), 0),
          // Lets the contact-send funnel exclude fulfilling sends (they enter via request_opened,
          // not send_contact_selected) while volume counts keep every send.
          fulfills_request: !!request,
        })
        if (request) {
          fireEvent("request_paid", {
            source: request.source ?? "contact",
            amount_bucket: requestAmountBucket(parsed),
          })
        }
      }
      if (!isSend) {
        fireEvent("request_created", {
          source: "contact",
          amount_bucket: requestAmountBucket(parsed),
        })
      }
      if (!isSend) setPhase("sent")
    } catch (e) {
      if (e === cancellation || isPasskeyCancelled(e)) {
        outcome.cancel()
        setPhase("confirm")
        return
      }
      // Reached the node, outcome unknown: the chain settles the operation. No error modal — there is
      // no error to report yet.
      if (e instanceof TxInFlightError) {
        outcome.finish()
        return
      }
      outcome.finish()
      fireEvent("action_failed", {
        action: isSend ? "contact:send" : "contact:request",
        code: failureCode(e),
      })
      if (left.current) return
      showReportableError(e, isSend ? "contact:send" : "contact:request")
      setFailedOnce(true)
      setPhase("confirm")
    }
  }

  if (entry === undefined && !request) return null

  const notFound = entry === null && !request
  const handle = targetTag ?? (entry ? entry.tag ?? entry.name : "")
  const title = isSend ? "Send" : "Request"

  return (
    <>
      {routerState?.from === "detail" ? <ContactDetailScreen /> : <SendScreen />}
      <Modal
        variant="bare"
        label={title}
        className="ww-pay"
        onClose={
          phase === "working" || phase === "sent"
            ? undefined
            : () => (phase === "confirm" && !request ? setPhase("amount") : back())
        }
      >
        {phase === "sent" ? (
          <div className="ww-pay__working">
            <Icon name="check" size={36} color="var(--accent-green)" strokeWidth={2.5} />
            <span className="ww-pay__title">Request sent</span>
          </div>
        ) : phase === "working" && isSend ? (
          <OperationHandOff
            onLeave={leave}
            onCancel={
              stage === "resolving"
                ? () => {
                    cancelled.current = true
                  }
                : undefined
            }
          />
        ) : phase === "working" ? (
          <PayWorking beat="preparing" />
        ) : (
          <>
            <PayModalChrome
              title={title}
              subtitle={`@${handle}.zk.money`}
              name={handle}
              onClose={() => (phase === "confirm" && !request ? setPhase("amount") : back())}
            />
            {/* Requests hard-fail without a live XMTP leader; surface the state before submit. */}
            {!isSend && <MessagingBanner />}
            {isSend && <TeeSignerNotice />}

            {notFound && <div className="ww-pay__handle">Contact not found.</div>}

            {!notFound && phase === "amount" && (
              <PayAmountForm
                amount={amount}
                note={note}
                isSend={isSend}
                walletBalance={walletBalance}
                maxAmount={
                  walletAsset
                    ? floorToCents(walletAsset.balanceAtomic, walletAsset.decimals)
                    : undefined
                }
                overspent={overspent}
                validAmount={validAmount}
                onAmount={setAmount}
                onNote={setNote}
                onContinue={toConfirm}
              />
            )}

            {!notFound && phase === "confirm" && (
              <PayConfirmForm
                title={title}
                amount={parsed}
                note={note}
                ready={ready}
                busy={busy}
                overspent={overspent}
                isSend={isSend}
                onConfirm={submit}
              />
            )}
            {!notFound && phase === "confirm" && request?.source === "link" && request.hash && (
              <button
                type="button"
                className="zkm-btn-reset ww-claim-modal__alt"
                onClick={() =>
                  navigate({ pathname: "/request", hash: request.hash }, { state: { external: true } })
                }
              >
                Pay with an Ethereum wallet instead
              </button>
            )}
          </>
        )}
      </Modal>
    </>
  )
}
