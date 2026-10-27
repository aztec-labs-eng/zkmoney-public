import { amountError, decimalInput, parseAmount } from "../../ui/format"
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { useActionGuard } from "../actionGate"
import {
  ContactStorage,
  getActiveNetworkId,
  contactRowFromEntry,
  isPaymentContactEntry,
  resolveAssetConstants,
  sameChat,
  selectContactChat,
  updateSavedL1WalletContact,
  useAssetContext,
  useStore,
  type Contact,
  type SIPADepositRecord,
} from "@obsidion/front-core"
import { TRANSFER_MEMO_MAX_BYTES, truncateUtf8 } from "@obsidion/sdk"
import {
  GlassCircleButton,
  GradientInitialAvatar,
  GradientText,
  Icon,
  PrimaryGradientButton,
  Spinner,
  TextField,
  TwoPartyAmountCard,
  avatarColors,
} from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { showReportableError } from "../../errors/errorModal"
import { fireEvent, requestAmountBucket } from "../../lib/analytics"
import { useBack } from "../../ui/hooks"
import { pageBottom, revealAboveKeyboard, useKeyboardInset } from "../../ui/keyboardInset"
import { usePhoneLayout } from "../../ui/usePhoneLayout"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { useSession } from "../../platform/session"
import { wallClock } from "../../lib/clock"
import { ActivityDetailHost, useActivityHost } from "../../ui/activity/ActivityDetailHost"
import { MessagingBanner } from "../../platform/xmtp/MessagingBanner"
import {
  getRequestBroadcaster,
  getXmtpInboxState,
  subscribeXmtpInboxState,
} from "../../platform/xmtp/xmtpLifecycle"
import emptyArt from "../../assets/contacts/empty-txns.webp"
import { ChatBubble } from "./ChatBubble"
import { DepositDetailModal } from "../../ui/screens/DepositDetailModal"
import { TxDetailModal } from "../../ui/screens/TxDetailModal"
import { txNoteFor, txRowView, type ActivityRowView } from "../../ui/screens/activityView"
import { chatContactOf, chatMessageOf, type ChatMessage } from "./contactChat"
import {
  addressKindLabel,
  findContactEntry,
  l1AliasDraft,
  l1ContactHeader,
  l2ContactHeader,
  l2ContactLabel,
  removeIdentityOf,
} from "./contactsView"
import { declineRequestById, resolveXmtpAddress } from "./requestActions"
import { REMIND_TITLE, useRemind } from "./useRemind"
import { announceOutgoingRequest, newOutgoingRequest } from "./requestFlow"
import { RequestDetailModal } from "./RequestDetailModal"
import { recipientNotUpgradedCopy } from "../migration/upgradeCopy"
import { useRecipientUpgraded } from "./useRecipientUpgraded"
import { lookUpUnsavedContact, saveUnsavedContact } from "./unsavedContact"

/** Contact detail: identity header, delete, the payments chat — the chronological R15 record
 *  kinds (transfers, requests, paylinks, SIPA deposits, withdrawals) between the user and this
 *  contact — plus L2 payment-request actions and Send, or L1 Deposit + Withdraw. A registered tag
 *  that is not saved opens here too, with Add contact in place of delete, and so does an unknown
 *  sender's address, with its history only. */
export function ContactDetailScreen() {
  return (
    <ActivityDetailHost>
      <ContactDetail />
    </ActivityDetailHost>
  )
}

function ContactDetail() {
  const session = useSession()
  const navigate = useNavigate()
  const guard = useActionGuard()
  const phone = usePhoneLayout()
  const back = useBack("/contacts")
  const { idOrTag } = useParams()
  const { tokenService } = useAssetContext()
  const [entry, setEntry] = useState<Contact | null | undefined>(undefined)
  const [saved, setSaved] = useState(true)
  const [lookingUp, setLookingUp] = useState(false)
  const [lookupFailed, setLookupFailed] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState("")
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [alias, setAlias] = useState("")
  const [savingAlias, setSavingAlias] = useState(false)
  const [renameError, setRenameError] = useState("")
  /** The open inline request form; undefined when closed, so closing also drops the draft. */
  const [requestDraft, setRequestDraft] = useState<{ amount: string; note: string }>()
  const [submitting, setSubmitting] = useState(false)
  const [requestDetail, setRequestDetail] = useState<{ id: string; step: "detail" | "confirm" }>()
  const host = useActivityHost()
  const { feed } = host
  const requests = feed.csv.requests
  // Kept while the bubbles and their day labels say the same, so a clock tick changes nothing.
  const thread = useStore(
    wallClock,
    (now) => ({
      day: new Date(now).toDateString(),
      items: entry ? selectContactChat(feed, requests, chatContactOf(entry), now) : [],
    }),
    (a, b) => a.day === b.day && sameChat(a.items, b.items),
  )
  const messages = useMemo(() => thread.items.map(chatMessageOf), [thread])
  const [txDetail, setTxDetail] = useState<{ row: ActivityRowView; note?: string }>()
  const [depositDetail, setDepositDetail] = useState<{
    record: SIPADepositRecord
    amount: string
  }>()
  const inboxState = useSyncExternalStore(subscribeXmtpInboxState, getXmtpInboxState)
  const chatBody = useRef<HTMLDivElement>(null)
  const chatFooter = useRef<HTMLDivElement>(null)
  // Route visit count. Add contact reads it when it starts and checks it before each state write,
  // so a late result cannot change a later route, including a return to the same person.
  const routeVisit = useRef(0)
  // Only a new message scrolls the chat to its end.
  const latestMessage = messages.at(-1)?.id
  useEffect(() => {
    const el = chatBody.current
    if (phone) {
      const footer = chatFooter.current
      const latest = footer?.getClientRects().length ? footer : el?.lastElementChild
      latest?.scrollIntoView({ block: "end" })
    } else if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, latestMessage, phone])

  // Phones scroll the page, so the request form and its error can open below the fold.
  const requestAmountError = amountError(requestDraft?.amount ?? "")
  const requestAmountInvalid = Boolean(requestAmountError)
  const requesting = Boolean(requestDraft)
  useEffect(() => {
    if (phone && requesting) chatFooter.current?.scrollIntoView({ block: "end" })
  }, [phone, requesting, requestAmountInvalid])
  // The keyboard covers the page's foot, so the page needs room below the form to scroll it clear.
  const [panel, setPanel] = useState<HTMLDivElement | null>(null)
  useKeyboardInset(
    useMemo(() => ({ current: panel }), [panel]),
    phone,
    pageBottom,
  )
  const requestForm = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    routeVisit.current += 1
    // The previous person's page and its open forms must not survive into this route.
    setEntry(undefined)
    setSaved(true)
    setLookupFailed(false)
    setAdding(false)
    setAddError("")
    setRenaming(false)
    setConfirmingDelete(false)
    setRequestDraft(undefined)
    ;(async () => {
      const found = findContactEntry(await ContactStorage.get().getEntries(), idOrTag ?? "")
      if (found) {
        if (!cancelled) {
          // A row the wallet added is not the user's contact until they add or pay it.
          setSaved(!found.autoAdded)
          setEntry(found)
        }
        return
      }
      setLookingUp(true)
      const unsaved = await lookUpUnsavedContact(idOrTag ?? "")
      if (cancelled) return
      setSaved(!unsaved)
      setEntry(unsaved)
    })()
      .catch((e) => {
        console.warn(e)
        if (cancelled) return
        setLookupFailed(true)
        setEntry(null)
      })
      .finally(() => {
        if (!cancelled) setLookingUp(false)
      })
    // The page stays mounted under its Send flow, which can save this person.
    const unsubscribe = ContactStorage.get().onChange(() => {
      void ContactStorage.get()
        .getEntries()
        .then((entries) => {
          const found = findContactEntry(entries, idOrTag ?? "")
          if (found && !cancelled) {
            setSaved(true)
            setEntry(found)
          }
        })
        .catch(console.warn)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [idOrTag])

  const addToContacts = async () => {
    if (!entry || saved || adding) return
    const visit = routeVisit.current
    const sameVisit = () => routeVisit.current === visit
    setAdding(true)
    setAddError("")
    try {
      const result = await saveUnsavedContact(entry)
      if (!sameVisit()) return
      if (result === "changed") {
        setAddError("This tag's details changed. Search for it again to add it.")
        return
      }
      const stored = findContactEntry(await ContactStorage.get().getEntries(), idOrTag ?? "")
      if (!sameVisit()) return
      if (stored) setEntry(stored)
      setSaved(true)
    } catch (e) {
      console.warn(e)
      if (sameVisit()) setAddError("Couldn't add this contact. Try again.")
    } finally {
      if (sameVisit()) setAdding(false)
    }
  }

  const remove = async () => {
    if (!entry) return
    await ContactStorage.get().removeEntry(removeIdentityOf(entry))
    navigate("/contacts", { replace: true })
  }

  const startRename = () => {
    if (!entry || !saved) return
    const isL1 = entry.addressKind === "ethereum-l1"
    if (!isL1 && !entry.tag) return
    setConfirmingDelete(false)
    setRenameError("")
    setAlias(isL1 ? l1AliasDraft(entry) : l2ContactLabel(entry) ?? "")
    setRenaming(true)
  }

  const saveRename = async () => {
    if (!entry || savingAlias) return
    setSavingAlias(true)
    setRenameError("")
    try {
      if (entry.addressKind === "ethereum-l1") {
        const updated = await updateSavedL1WalletContact({
          originalAddress: entry.address,
          provider: entry.l1Wallet?.provider ?? "unknown",
          address: entry.address,
          name: alias,
        })
        setEntry(updated)
      } else {
        // A 0x… name reads as a messaging address saved before the tag resolved, so it would
        // never show.
        if (/^0x[0-9a-f]+$/i.test(alias.trim())) {
          setRenameError("Use a name, not an address.")
          return
        }
        // Blank goes back to the tag, which is what every zk.money contact saves under.
        const renamed = { ...entry, name: alias.trim() || entry.tag! }
        await ContactStorage.get().modifyEntry(renamed, removeIdentityOf(entry))
        setEntry(renamed)
      }
      setRenaming(false)
    } catch (e) {
      if (e instanceof Error && e.message === "Duplicate entry - name") {
        setRenameError("Another contact already has this name.")
      } else {
        showReportableError(e, "contact:rename")
      }
    } finally {
      setSavingAlias(false)
    }
  }

  // Compose: persist the outgoing row (the chat subscription renders the "Owes you" bubble
  // immediately), then announce over XMTP in the background — delivery is best-effort.
  // A person still on an older zk.money keeps their history here but can't be paid or asked. A
  // request waits for the answer, and a form opened before it closes.
  const upgraded = useRecipientUpgraded(
    entry?.addressKind === "ethereum-l1" ? undefined : entry?.tag,
  )
  const notUpgraded = upgraded === false
  useEffect(() => {
    if (notUpgraded) setRequestDraft(undefined)
  }, [notUpgraded])

  const submitRequest = async () => {
    if (!entry?.tag || !requestDraft || submitting || upgraded !== true) return
    setSubmitting(true)
    try {
      const config = getConfig()
      const walletAsset = resolveAssetConstants(config.network).DAI
      const row = newOutgoingRequest(
        entry.tag,
        requestDraft.amount,
        walletAsset.decimals,
        requestDraft.note,
      )
      if (!row) {
        showReportableError(new Error("Enter a valid amount"), "contact:request-compose")
        return
      }
      await session.requests.add(row)
      fireEvent("request_created", {
        source: "contact",
        amount_bucket: requestAmountBucket(row.amount),
      })
      setRequestDraft(undefined)
      const broadcaster = getRequestBroadcaster()
      const requesterTag = loadWalletIdentity()?.handle
      const tokenAddress = tokenService?.tokenAddress?.toString()
      if (!broadcaster || !requesterTag || !tokenAddress) return
      void announceOutgoingRequest(row, {
        broadcaster,
        resolveXmtpAddress,
        requesterTag,
        // The rollup address published at boot — the wire value peers compare on receive.
        networkId: getActiveNetworkId()!,
        token: {
          address: tokenAddress,
          symbol: walletAsset.symbol,
          decimals: walletAsset.decimals,
        },
      })
    } finally {
      setSubmitting(false)
    }
  }

  // Same route as the activity feed's Send-on-request: ContactPayScreen fulfills the row and
  // signals the requester over XMTP once the transfer lands.
  const payRequest = async (m: ChatMessage) => {
    const row = session.requests.view.get().find((r) => r.id === m.id)
    if (!row) return
    guard("send", () =>
      navigate(`/contacts/${idOrTag}/send`, {
        state: {
          request: { id: row.id, tag: entry?.tag, amount: row.amount, note: row.note },
          from: "detail",
          contact: entry,
          saved,
        },
      }),
    )
  }

  const { remind, stateOf: remindStateOf } = useRemind(tokenService?.tokenAddress?.toString())

  // Every bubble opens its own sheet.
  const openMessage = (m: ChatMessage) => {
    const { source } = m.item
    if (source.kind === "chatRequest")
      return setRequestDetail({ id: source.request.id, step: "detail" })
    if (source.kind === "deposit")
      return setDepositDetail({ record: source.record, amount: m.amount })
    if (source.kind === "withdrawal")
      return host.open({ kind: "withdrawal", id: source.record.localId })
    if (source.kind === "withdrawalGroup")
      return host.open({ kind: "withdrawal", id: source.group.groupId })
    if (source.kind !== "tx" || !entry) return
    const row = txRowView(source)
    setTxDetail({
      row: {
        ...row,
        contact:
          row.contact ?? (isPaymentContactEntry(entry) ? contactRowFromEntry(entry) : undefined),
      },
      note: txNoteFor(row, [...requests]),
    })
  }

  // Open-request buttons: incoming → Decline / Send, outgoing → Cancel / Remind. Cancel runs
  // through the detail modal's confirm step.
  const requestActions = (m: ChatMessage) => {
    if (m.role === "request-in") {
      const decline = {
        label: "Decline",
        onClick: () => void declineRequestById(m.id).catch(console.warn),
        secondary: true,
      }
      if (notUpgraded) return [decline]
      return [decline, { label: "Send", onClick: () => void payRequest(m).catch(console.warn) }]
    }
    if (m.role === "request-out") {
      const state = remindStateOf(m.id, requests.find((r) => r.id === m.id)?.remindedAt)
      return [
        { label: "Cancel", onClick: () => setRequestDetail({ id: m.id, step: "confirm" }) },
        {
          label: REMIND_TITLE[state],
          loading: state === "sending",
          disabled: state === "sent",
          onClick: () => remind(m.id),
        },
      ]
    }
    return undefined
  }

  if (entry === undefined && !lookingUp) return null
  if (!entry) {
    return (
      <div className="ww-panel">
        <div className="ww-chat__head">
          <GlassCircleButton ariaLabel="Back" onClick={back}>
            <Icon name="arrow-left" size={20} color="#fff" />
          </GlassCircleButton>
          <span>Contact</span>
          <span style={{ width: 40 }} />
        </div>
        <div className="ww-empty">
          {entry === undefined ? (
            <Spinner size={20} />
          ) : (
            <span>
              {lookupFailed
                ? "Couldn't look up this contact. Check your connection and try again."
                : "Contact not found."}
            </span>
          )}
        </div>
      </div>
    )
  }

  const isL1 = entry.addressKind === "ethereum-l1"
  const handle = entry.tag ?? entry.name
  const header = isL1 ? l1ContactHeader(entry) : l2ContactHeader(entry)
  const avatarKey = isL1 ? header.title : handle
  const avatarName = isL1 ? header.title : l2ContactLabel(entry) ?? handle
  const renamable = saved && (isL1 || Boolean(entry.tag))
  const ownHandle = loadWalletIdentity()?.handle ?? "me"
  // Payment rails need a completed handshake (payable L2 address) and a tag registered on the
  // current zk.money. L1 contacts are the bridge counterparty — Deposit + Withdraw only.
  const chat = chatContactOf(entry)
  const payable =
    !notUpgraded && chat.addressKind === "aztec-l2" && Boolean(chat.address && entry.tag)
  const parsedAmount = parseAmount(requestDraft?.amount ?? "")
  const validRequestAmount = Number.isFinite(parsedAmount) && parsedAmount > 0
  const inlineCard = confirmingDelete || renaming || !!requestDraft
  return (
    <div className="ww-panel" ref={setPanel}>
      <div className="ww-chat__head">
        <GlassCircleButton ariaLabel="Back" onClick={back}>
          <Icon name="arrow-left" size={20} color="#fff" />
        </GlassCircleButton>
        <span className="ww-chat__who">
          {renamable ? (
            <button
              type="button"
              className="zkm-btn-reset"
              onClick={startRename}
              aria-label="Rename contact"
            >
              <GradientText size={18} weight={600}>
                {header.title}
              </GradientText>
            </button>
          ) : (
            <GradientText size={18} weight={600}>
              {header.title}
            </GradientText>
          )}
          <span>{isL1 ? addressKindLabel(entry) : header.subtitle}</span>
        </span>
        <span className="ww-chat__head-actions">
          {renamable && !renaming && (
            <GlassCircleButton ariaLabel="Rename contact" size={32} onClick={startRename}>
              <Icon name="pencil" size={14} color="#fff" />
            </GlassCircleButton>
          )}
          {saved && !confirmingDelete && (
            <GlassCircleButton
              ariaLabel="Delete contact"
              size={32}
              onClick={() => {
                setRenaming(false)
                setConfirmingDelete(true)
              }}
            >
              <Icon name="trash" size={14} color="#fff" />
            </GlassCircleButton>
          )}
          <GradientInitialAvatar name={avatarName} colors={avatarColors(avatarKey)} size={40} />
        </span>
      </div>

      {!saved && (
        <div className="ww-chat__unsaved">
          <span>Not in your contacts</span>
          {!notUpgraded && entry.tag && (
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-chat__unsaved-add"
              disabled={adding}
              onClick={() => void addToContacts()}
            >
              {adding ? "Adding…" : "Add contact"}
            </button>
          )}
        </div>
      )}
      {addError && (
        <p role="alert" className="ww-chat__unsaved-error">
          {addError}
        </p>
      )}

      <MessagingBanner />

      {inboxState === "catching-up" && !isL1 && (
        <div className="ww-chat__catchup">
          <Spinner size={14} />
          Catching up on messages…
        </div>
      )}

      {messages.length === 0 ? (
        <div className="ww-empty">
          <img src={emptyArt} alt="" width={118} height={121} />
          <GradientText size={18} weight={700}>
            No transactions yet
          </GradientText>
          <span>
            {payable ? "Send or request funds" : isL1 ? "Send or receive funds" : "No activity yet"}
          </span>
        </div>
      ) : (
        <div className="ww-chat__body" ref={chatBody}>
          {messages.map((m, i) => (
            <Fragment key={`${m.id}-${i}`}>
              {(i === 0 || messages[i - 1].dateLabel !== m.dateLabel) && (
                <div className="ww-chat__date">{m.dateLabel}</div>
              )}
              <ChatBubble
                message={m}
                leftName={avatarKey}
                rightName={ownHandle}
                actions={requestActions(m)}
                onOpen={() => openMessage(m)}
              />
            </Fragment>
          ))}
        </div>
      )}

      <div className="ww-chat__foot" ref={chatFooter}>
        {notUpgraded && !inlineCard && (
          <div role="status" className="ww-chat__not-upgraded">
            <strong>{recipientNotUpgradedCopy.title(handle)}</strong>
            <span>{recipientNotUpgradedCopy.chatHint}</span>
          </div>
        )}

        {isL1 && !inlineCard && (
          <>
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-chat__glassbtn"
              onClick={() => guard("deposit", () => navigate("/deposit"))}
            >
              Receive
            </button>
            <PrimaryGradientButton
              title="Send"
              style={{ flex: 1 }}
              onClick={() =>
                guard("withdraw", () =>
                  navigate("/withdraw/existing", {
                    state: { recipient: entry.address, alias: entry.name },
                  }),
                )
              }
            />
          </>
        )}

        {payable && !inlineCard && (
          <>
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-chat__glassbtn"
              onClick={() => guard("receive", () => setRequestDraft({ amount: "", note: "" }))}
            >
              Request
            </button>
            <PrimaryGradientButton
              title="Send"
              style={{ flex: 1 }}
              onClick={() =>
                guard("send", () =>
                  navigate(`/contacts/${idOrTag}/send`, {
                    state: { from: "detail", contact: entry, saved },
                  }),
                )
              }
            />
          </>
        )}

        {requestDraft && (
          <div
            ref={requestForm}
            onFocus={() => {
              if (phone && requestForm.current) void revealAboveKeyboard(requestForm.current)
            }}
            style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12 }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <TwoPartyAmountCard
                role="youRequest"
                cornerStyle="top"
                className={["ww-request-card", requestAmountError && "ww-chat__request-card--error"]
                  .filter(Boolean)
                  .join(" ")}
                person={{ name: handle, handle: `@${handle}`, colors: avatarColors(handle) }}
                amount={
                  <input
                    autoFocus
                    inputMode="decimal"
                    placeholder="0.00"
                    value={requestDraft.amount}
                    onChange={(e) =>
                      setRequestDraft({ ...requestDraft, amount: decimalInput(e.target.value) })
                    }
                    aria-label="Request amount"
                    style={{
                      width: 96,
                      background: "transparent",
                      border: "none",
                      outline: "none",
                      color: "inherit",
                      font: "inherit",
                      fontSize: 20,
                      fontWeight: 700,
                      textAlign: "right",
                    }}
                  />
                }
              />
              <div
                className="zkm-two-party-card ww-request-card"
                style={{ borderRadius: "4px 4px 12px 12px" }}
              >
                <input
                  placeholder="Add note (optional)"
                  value={requestDraft.note}
                  onChange={(e) =>
                    setRequestDraft({
                      ...requestDraft,
                      note: truncateUtf8(e.target.value, TRANSFER_MEMO_MAX_BYTES),
                    })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && validRequestAmount && !submitting) void submitRequest()
                  }}
                  aria-label="Request note"
                  style={{
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    color: "inherit",
                    font: "inherit",
                    fontSize: 15,
                  }}
                />
              </div>
            </div>
            {requestAmountError && (
              <p role="alert" className="zkm-field__error" style={{ margin: 0 }}>
                {requestAmountError}
              </p>
            )}
            <div style={{ display: "flex", gap: 12 }}>
              <button
                type="button"
                className="zkm-btn-reset zkm-pressable ww-chat__glassbtn"
                onClick={() => setRequestDraft(undefined)}
              >
                Cancel
              </button>
              <PrimaryGradientButton
                title={submitting ? "Requesting…" : "Request"}
                style={{ flex: 1 }}
                isDisabled={!validRequestAmount || submitting || upgraded !== true}
                onClick={() => void submitRequest()}
              />
            </div>
          </div>
        )}

        {renaming && (
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, marginBottom: 12 }}>Rename contact</div>
            <TextField
              label="Name"
              placeholder="Contact name"
              autoFocus
              value={alias}
              onChange={setAlias}
              onSubmit={() => void saveRename()}
            />
            <div style={{ color: "var(--text-secondary)", fontSize: 13, marginTop: 8 }}>
              {isL1
                ? "Leave blank to show the address instead."
                : `Leave blank to show @${handle} instead.`}
            </div>
            {renameError && (
              <p role="alert" className="ww-chat__unsaved-error">
                {renameError}
              </p>
            )}
            <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
              <button
                type="button"
                className="zkm-btn-reset zkm-pressable ww-chat__glassbtn"
                disabled={savingAlias}
                onClick={() => setRenaming(false)}
              >
                Cancel
              </button>
              <PrimaryGradientButton
                title={savingAlias ? "Saving…" : "Save"}
                style={{ flex: 1 }}
                isDisabled={savingAlias}
                onClick={() => void saveRename()}
              />
            </div>
          </div>
        )}

        {confirmingDelete && !renaming && (
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Delete {header.title}?</div>
            <div style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 16 }}>
              This only removes them from your device.
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              <button
                type="button"
                className="zkm-btn-reset zkm-pressable ww-chat__glassbtn"
                onClick={() => setConfirmingDelete(false)}
              >
                Keep
              </button>
              <PrimaryGradientButton
                title="Delete"
                buttonStyle="danger"
                style={{ flex: 1 }}
                onClick={() => void remove()}
              />
            </div>
          </div>
        )}
      </div>

      {requestDetail && (
        <RequestDetailModal
          requestId={requestDetail.id}
          initialStep={requestDetail.step}
          tag={handle}
          onClose={() => setRequestDetail(undefined)}
        />
      )}
      {txDetail && (
        <TxDetailModal
          row={txDetail.row}
          note={txDetail.note}
          onClose={() => setTxDetail(undefined)}
        />
      )}
      {depositDetail && (
        <DepositDetailModal
          record={depositDetail.record}
          onClose={() => setDepositDetail(undefined)}
        />
      )}
    </div>
  )
}
