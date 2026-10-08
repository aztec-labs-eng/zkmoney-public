import { amountError, decimalInput, parseAmount } from "../../ui/format"
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useNavigate, useParams } from "react-router-dom"
import {
  ContactStorage,
  TransactionStorage,
  RequestStorage,
  getActiveNetworkId,
  globalEventEmitter,
  contactRowFromEntry,
  isPaymentContactEntry,
  resolveAssetConstants,
  updateSavedL1WalletContact,
  useAssetContext,
  useContactsDirectory,
  type ChatMessage,
  type Contact,
  type SIPADepositRecord,
  type WithdrawalRecord,
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
import { useBack } from "../../ui/hooks"
import { usePhoneLayout } from "../../ui/usePhoneLayout"
import { getSipaDepositGateway } from "../deposit/sipaGateway"
import { getWithdrawalStore } from "../withdraw/withdrawGateway"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
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
import { WithdrawalDetailModal } from "../../ui/screens/WithdrawalDetailModal"
import { buildActivityRows, txNoteFor, type ActivityRowView } from "../../ui/screens/activityView"
import {
  buildContactChat,
  chatMessageSource,
  selectedContactOf,
  type ContactChatSources,
} from "./contactChat"
import {
  addressKindLabel,
  findContactEntry,
  l1AliasDraft,
  l1ContactHeader,
  l2ContactHeader,
  l2ContactLabel,
  removeIdentityOf,
} from "./contactsView"
import { declineRequestById, remindRequestById, resolveXmtpAddress } from "./requestActions"
import { announceOutgoingRequest, newOutgoingRequest } from "./requestFlow"
import { RequestDetailModal } from "./RequestDetailModal"
import { lookUpUnsavedContact, saveUnsavedContact } from "./unsavedContact"

/** Contact detail: identity header, delete, the payments chat — the chronological R15 record
 *  kinds (transfers, requests, paylinks, SIPA deposits, withdrawals) between the user and this
 *  contact — plus L2 payment-request actions and Send, or L1 Deposit + Withdraw. A registered tag
 *  that is not saved opens here too, with Add contact in place of delete. */
export function ContactDetailScreen() {
  const navigate = useNavigate()
  const phone = usePhoneLayout()
  const back = useBack("/contacts")
  const { idOrTag } = useParams()
  const { tokenService } = useAssetContext()
  const directory = useContactsDirectory()
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
  const [remindedIds, setRemindedIds] = useState<ReadonlySet<string>>(new Set())
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sources, setSources] = useState<ContactChatSources>({})
  const [txDetail, setTxDetail] = useState<{ row: ActivityRowView; note?: string }>()
  const [depositDetail, setDepositDetail] = useState<{
    record: SIPADepositRecord
    amount: string
  }>()
  const [withdrawalDetail, setWithdrawalDetail] = useState<{
    record: WithdrawalRecord
    amount: string
  }>()
  const inboxState = useSyncExternalStore(subscribeXmtpInboxState, getXmtpInboxState)
  const chatBody = useRef<HTMLDivElement>(null)
  const chatFooter = useRef<HTMLDivElement>(null)
  // Route visit count. Add contact reads it when it starts and checks it before each state write,
  // so a late result cannot change a later route, including a return to the same person.
  const routeVisit = useRef(0)
  useEffect(() => {
    const el = chatBody.current
    if (phone) {
      const footer = chatFooter.current
      const latest = footer?.getClientRects().length ? footer : el?.lastElementChild
      latest?.scrollIntoView({ block: "end" })
    }
    else if (el) el.scrollTop = el.scrollHeight
  }, [messages, phone])

  // Phones scroll the page, so the request form and its error can open below the fold.
  const requestAmountError = amountError(requestDraft?.amount ?? "")
  const requestAmountInvalid = Boolean(requestAmountError)
  const requesting = Boolean(requestDraft)
  useEffect(() => {
    if (phone && requesting) chatFooter.current?.scrollIntoView({ block: "end" })
  }, [phone, requesting, requestAmountInvalid])

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
          setSaved(true)
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

  // Assemble the chat from the live web sources; rebuild on any source change. No paylink store
  // exists on web — paylink rows persisted in TransactionStorage flow through `transactions`.
  useEffect(() => {
    if (!entry) return
    let cancelled = false
    const storage = webStorage
    const rebuild = async () => {
      const [transactions, requests] = await Promise.all([
        TransactionStorage.get(storage)
          .getTransactions()
          .catch(() => []),
        RequestStorage.get()
          .list()
          .catch(() => []),
      ])
      const sipaDeposits = getSipaDepositGateway().records()
      const withdrawalStore = getWithdrawalStore()
      await withdrawalStore.load().catch(() => {})
      if (cancelled) return
      const next = { transactions, requests, sipaDeposits, withdrawals: withdrawalStore.list() }
      setSources(next)
      setMessages(buildContactChat(entry, next))
    }
    void rebuild()
    const onUpdate = () => void rebuild()
    globalEventEmitter.onTransactionsUpdated(onUpdate)
    const unsubRequests = RequestStorage.get().subscribe(onUpdate)
    const unsubSipa = getSipaDepositGateway().subscribe(onUpdate)
    const unsubWithdrawals = getWithdrawalStore().onListChanged(onUpdate)
    return () => {
      cancelled = true
      globalEventEmitter.offTransactionsUpdated(onUpdate)
      unsubRequests()
      unsubSipa()
      unsubWithdrawals()
    }
  }, [entry])

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
    setAlias(isL1 ? l1AliasDraft(entry) : (l2ContactLabel(entry) ?? ""))
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
  const submitRequest = async () => {
    if (!entry?.tag || !requestDraft || submitting) return
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
      await RequestStorage.get().add(row)
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
    const row = await RequestStorage.get().findById(m.id)
    if (!row) return
    navigate(`/contacts/${idOrTag}/send`, {
      state: {
        request: { id: row.id, tag: entry?.tag, amount: row.amount, note: row.note },
        from: "detail",
        contact: entry,
        saved,
      },
    })
  }

  const remind = (id: string) =>
    void remindRequestById(id, tokenService?.tokenAddress?.toString())
      .then((ok) => ok && setRemindedIds((prev) => new Set(prev).add(id)))
      .catch(console.warn)

  // Every bubble opens its own sheet.
  const openMessage = (m: ChatMessage) => {
    const source = chatMessageSource(m, sources)
    if (!source) return
    if (source.kind === "request") return setRequestDetail({ id: source.id, step: "detail" })
    if (source.kind === "deposit")
      return setDepositDetail({ record: source.record, amount: m.amount })
    if (source.kind === "withdrawal")
      return setWithdrawalDetail({ record: source.record, amount: m.amount })
    if (!entry || !isPaymentContactEntry(entry)) return
    const row = buildActivityRows([source.transaction], directory)[0]
    if (!row) return
    setTxDetail({
      row: { ...row, contact: row.contact ?? contactRowFromEntry(entry) },
      note: txNoteFor(row, sources.requests ?? []),
    })
  }

  // Open-request buttons: incoming → Decline / Send, outgoing → Cancel / Remind. Cancel runs
  // through the detail modal's confirm step.
  const requestActions = (m: ChatMessage) => {
    if (m.role === "request-in")
      return [
        { label: "Decline", onClick: () => void declineRequestById(m.id).catch(console.warn) },
        { label: "Send", onClick: () => void payRequest(m).catch(console.warn) },
      ]
    if (m.role === "request-out") {
      const reminded = remindedIds.has(m.id)
      return [
        { label: "Cancel", onClick: () => setRequestDetail({ id: m.id, step: "confirm" }) },
        {
          label: reminded ? "Reminder sent" : "Remind",
          disabled: reminded,
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
  const avatarName = isL1 ? header.title : (l2ContactLabel(entry) ?? handle)
  const renamable = saved && (isL1 || Boolean(entry.tag))
  const ownHandle = loadWalletIdentity()?.handle ?? "me"
  // Payment rails need a completed handshake (payable L2 address) and a registered tag to
  // resolve against. L1 contacts are the bridge counterparty — Deposit + Withdraw only.
  const selected = selectedContactOf(entry)
  const payable = selected.addressKind === "aztec-l2" && Boolean(selected.address && entry.tag)
  const parsedAmount = parseAmount(requestDraft?.amount ?? "")
  const validRequestAmount = Number.isFinite(parsedAmount) && parsedAmount > 0
  const inlineCard = confirmingDelete || renaming || !!requestDraft
  return (
    <div className="ww-panel">
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
          <button
            type="button"
            className="zkm-btn-reset zkm-pressable ww-chat__unsaved-add"
            disabled={adding}
            onClick={() => void addToContacts()}
          >
            {adding ? "Adding…" : "Add contact"}
          </button>
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
        {isL1 && !inlineCard && (
          <>
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-chat__glassbtn"
              onClick={() => navigate("/deposit")}
            >
              Receive
            </button>
            <PrimaryGradientButton
              title="Send"
              style={{ flex: 1 }}
              onClick={() =>
                navigate("/withdraw/existing", {
                  state: { recipient: entry.address, alias: entry.name },
                })
              }
            />
          </>
        )}

        {payable && !inlineCard && (
          <>
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-chat__glassbtn"
              onClick={() => setRequestDraft({ amount: "", note: "" })}
            >
              Request
            </button>
            <PrimaryGradientButton
              title="Send"
              style={{ flex: 1 }}
              onClick={() =>
                navigate(`/contacts/${idOrTag}/send`, {
                  state: { from: "detail", contact: entry, saved },
                })
              }
            />
          </>
        )}

        {requestDraft && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
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
                isDisabled={!validRequestAmount || submitting}
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
              {isL1 ? "Leave blank to show the address instead." : `Leave blank to show @${handle} instead.`}
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
            <div style={{ fontWeight: 700, marginBottom: 6 }}>
              Delete {header.title}?
            </div>
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
      {withdrawalDetail && (
        <WithdrawalDetailModal
          record={withdrawalDetail.record}
          amount={withdrawalDetail.amount}
          onClose={() => setWithdrawalDetail(undefined)}
        />
      )}
    </div>
  )
}
