/**
 * Transaction detail modal: counterparty
 * avatar, Type / Amount / Note / Date / Tx hash (Aztec Scan link) / Status card, and for creator
 * paylink rows the share section: tap-to-copy claim URL and Share (Web Share API only — hidden when
 * the browser has no share sheet).
 *
 * On a creator paylink row the status is the link's own lifecycle, in the words the feed row uses.
 * It starts from the stored row (front-core's paylinkStatusFor); opening rechecks the chain through
 * the shared claim reconciler, whose flip updates the feed row and this sheet together.
 *
 * A creator paylink row whose escrow is still spendable also carries its recovery: "Cancel paylink"
 * during the grace window, "Reclaim funds" once the claim window has closed (`creatorLinkActions.ts`).
 * The gate reads the refreshed status, so a link the refresh shows claimed offers neither, and stays
 * inert while that refresh is in flight.
 */
import { useEffect, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { globalEventEmitter, truncateMiddle, type PaylinkStatusKind } from "@obsidion/front-core"
import {
  ConfirmationSheetDetailRow,
  GradientInitialAvatar,
  Icon,
  PrimaryGradientButton,
  Spinner,
  StatusBadge,
  avatarColors,
  type StatusBadgeStyle,
} from "@obsidion/web-ds"
import { PayModalChrome } from "../PayModalChrome"
import { usePhoneLayout } from "../usePhoneLayout"
import { Modal } from "../Modal"
import { usdFigure } from "../format"
import { getConfig } from "../../config/env"
import { l2TxUrl } from "../../lib/explorer"
import {
  creatorLinkAction,
  type CreatorLinkAction,
} from "../../features/paylink/creatorLinkActions"
import { LinkRecoverModal } from "../../features/paylink/LinkRecoverModal"
import { usePolledChainSeconds } from "../../features/paylink/chainTime"
import { recheckPaylinkClaim } from "../../features/notifications/PaylinkClaimMount"
import { usePaylinkDeps } from "../../features/paylink/usePaylinkDeps"
import { HashRow } from "../detailRows"
import { useCopy } from "../hooks"
import { activityStatusLabel, linkFragmentOf, type ActivityRowView } from "./activityView"

// Styles match the feed row's STATUS_STYLE for the same labels, so one state never wears two colors.
const PAYLINK_BADGE_STYLE: Record<PaylinkStatusKind, StatusBadgeStyle> = {
  awaitingClaim: "awaitingClaim",
  claimed: "pending",
  refunded: "cancelled",
  migrated: "pending",
  expired: "failed",
}

const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function"

function expiryLabel(untilSec: number | undefined, nowSec: number): string {
  if (untilSec == null) return "--"
  const days = Math.ceil((untilSec - nowSec) / 86400)
  return days <= 0 ? "Expired" : `${days} ${days === 1 ? "day" : "days"} remaining`
}

export function TxDetailModal({
  row,
  note: noteProp,
  notice,
  onClose,
}: {
  row: ActivityRowView
  /** Memo override — the chat passes the fulfilled request's note when the transfer has none. */
  note?: string
  /** Full text of the notification that opened this detail. */
  notice?: string
  onClose: () => void
}) {
  const { copied, copy } = useCopy()
  const phone = usePhoneLayout()
  const navigate = useNavigate()
  const pathname = useLocation().pathname
  const deps = usePaylinkDeps()

  const fragment = row.paylink ? linkFragmentOf(row.paylink) : null
  const [linkStatus, setLinkStatus] = useState(row.paylinkStatus)
  const [checking, setChecking] = useState(false)
  // Paylink windows are chain timestamps: the recovery on offer must flip as the tip crosses
  // them while the sheet is open, and stays withheld until the tip has been read.
  const chainNow = usePolledChainSeconds(deps?.wallet.node)
  // Captured at the tap: the sheet follows its row, and a refund scrubs that row's link as it
  // lands, so the recovery modal must not depend on what the row carries afterwards.
  const [recovering, setRecovering] = useState<{
    action: CreatorLinkAction
    fragment: string
    paylinkRow: NonNullable<ActivityRowView["paylinkRow"]>
    amount: string
    createdMs: number
  } | null>(null)

  // A status the row itself now carries (refunded, claimed) wins over the one it opened with.
  useEffect(() => setLinkStatus(row.paylinkStatus), [row.paylinkStatus])

  useEffect(() => {
    const { txHash } = row
    if (!txHash || !row.paylinkStatus) return
    let cancelled = false
    const onClaimed = (d: { txHash: string }) => d.txHash === txHash && setLinkStatus("claimed")
    globalEventEmitter.onPaylinkClaimed(onClaimed)
    setChecking(true)
    void recheckPaylinkClaim(txHash).finally(() => !cancelled && setChecking(false))
    return () => {
      cancelled = true
      globalEventEmitter.offPaylinkClaimed(onClaimed)
    }
  }, [row.txHash, row.paylinkStatus])

  const config = getConfig()
  const explorerUrl = row.txHash ? l2TxUrl(config.network, config.nodeUrl, row.txHash) : null
  // A refund has no row of its own, so the link's own row is where its transaction is readable.
  const refundUrl = row.refundTxHash
    ? l2TxUrl(config.network, config.nodeUrl, row.refundTxHash)
    : null
  // The status is the feed row's badge, derived through the same function off the same words — the
  // refresh only sharpens which link status goes in, so the two can never read differently. An
  // expired link is awaiting its reclaim, and says so here as it does in the feed.
  const statusLabel = activityStatusLabel(row.status, linkStatus) ?? "Completed"
  const paylinkBadgeStyle: StatusBadgeStyle =
    statusLabel === "Failed"
      ? "failed"
      : statusLabel === "Pending"
      ? "pending"
      : linkStatus
      ? PAYLINK_BADGE_STYLE[linkStatus]
      : "awaitingClaim"

  const recovery =
    row.paylinkRow && linkStatus && chainNow != null
      ? creatorLinkAction(row.paylinkRow, {
          nowSec: chainNow,
          liveStatus: linkStatus,
          account: deps?.account.getAddress().toString(),
        })
      : null

  if (recovering) {
    return (
      <LinkRecoverModal
        action={recovering.action}
        deps={deps}
        fragment={recovering.fragment}
        amount={recovering.amount}
        createdMs={recovering.createdMs}
        untilClaimableSec={recovering.paylinkRow.untilClaimable}
        refundableUntilSec={recovering.paylinkRow.refundableUntil}
        onClose={onClose}
      />
    )
  }

  const outgoing = row.amount.trim().startsWith("-")
  const pending = row.status === "pending"
  const type = outgoing ? "Send" : "Receive"
  // Only a settled transfer reads as done ("Sent" / "Received"); a pending or failed one keeps the action's name.
  const title = row.paylink
    ? row.counterparty
    : row.status === "success"
    ? outgoing
      ? "Sent"
      : "Received"
    : type
  const avatarName = row.contact?.name ?? row.counterparty
  // The counterparty's chat is where all of that user's transactions live; an unsaved tag opens it
  // unsaved.
  const contactId = row.contact?.id ?? row.counterpartyTag
  const contactPath = contactId && !row.paylink ? `/contacts/${encodeURIComponent(contactId)}` : null
  const openContact =
    contactPath && pathname !== contactPath
      ? () => {
          onClose()
          navigate(contactPath)
        }
      : undefined
  const subtitle = row.contact?.tag
    ? `${row.contact.tag.replace(/^@/, "")}.zk.money`
    : row.counterparty

  const isLink = !!(row.paylink && fragment && linkStatus)
  const nowSec = chainNow ?? Math.floor(Date.now() / 1000)
  const amountFace = row.amount.replace(/^[+-]/, "")
  const note = noteProp ?? row.note
  const hashLink =
    explorerUrl && row.txHash ? (
      <a className="ww-txd__hash" href={explorerUrl} target="_blank" rel="noreferrer">
        {truncateMiddle(row.txHash, 12)}
        <Icon name="share-box" size={14} color="currentColor" />
      </a>
    ) : (
      "--"
    )

  const status = linkStatus ? (
    <StatusBadge label={statusLabel} badgeStyle={paylinkBadgeStyle} />
  ) : pending ? (
    <StatusBadge label={outgoing ? "Sending" : "Receiving"} badgeStyle="pending" />
  ) : row.status === "failed" ? (
    <StatusBadge label="Failed" badgeStyle="failed" />
  ) : (
    <StatusBadge label="Completed" badgeStyle="paid" />
  )

  return (
    <Modal
      variant="bare"
      className="ww-txd"
      label={`${isLink ? "Send via paylink" : title} ${amountFace}`}
      onClose={onClose}
    >
      <PayModalChrome
        title={isLink ? "Send via paylink" : title}
        subtitle={
          isLink ? null : openContact ? (
            <button type="button" className="zkm-btn-reset ww-txd__link" onClick={openContact}>
              {subtitle}
              <Icon name="chevron-right" size={12} color="currentColor" />
            </button>
          ) : (
            subtitle
          )
        }
        onClose={onClose}
        avatar={
          isLink ? (
            <span className="ww-send-option__icon">
              <Icon name="link" size={24} color="#fff" />
            </span>
          ) : row.avatarIcon ? (
            <Icon name={row.avatarIcon} size={28} color="#fff" />
          ) : (
            <GradientInitialAvatar
              name={avatarName}
              colors={avatarColors(row.contact?.id ?? avatarName)}
              size={52}
            />
          )
        }
      />

      {notice && <p className="ww-txd__notice">{notice}</p>}
      {/* A link exists before its deposit lands; the proof runs in this tab, so leaving kills it. */}
      {isLink && pending && (
        <div className="ww-txd__notice ww-txd__notice--live" role="status">
          <Spinner size={14} />
          <span>
            Your link is ready to share. The deposit behind it is still being proved in this tab.
            Keep the tab open until the status reads sent, or the link will have nothing to pay out.
          </span>
        </div>
      )}

      {isLink ? (
        <div className="ww-txd__card">
          {note && <ConfirmationSheetDetailRow label="Note" value={note} />}
          {row.paylinkRow?.to && (
            <ConfirmationSheetDetailRow label="Validation" value={row.paylinkRow.to} />
          )}
          <ConfirmationSheetDetailRow label="Date created" value={pending ? "--" : row.timestamp} />
          <ConfirmationSheetDetailRow label="Tx hash" value={hashLink} />
          {row.refundTxHash && (
            <HashRow label="Refund" hash={row.refundTxHash} url={refundUrl ?? undefined} />
          )}
          <hr className="ww-divider" />
          <ConfirmationSheetDetailRow label="Amount" value={amountFace} />
          <ConfirmationSheetDetailRow label="Status" value={status} />
          {row.error && <ConfirmationSheetDetailRow label="Reason" value={row.error} />}
          <ConfirmationSheetDetailRow
            label="Link expiry"
            value={expiryLabel(row.paylinkRow?.untilClaimable, nowSec)}
          />
        </div>
      ) : (
        <div className="ww-txd__card">
          <ConfirmationSheetDetailRow label="Amount" value={row.amount.replace(/^[+-]/, "")} />
          {note && <ConfirmationSheetDetailRow label="Note" value={note} />}
          <ConfirmationSheetDetailRow label="Date" value={pending ? "--" : row.timestamp} />
          <ConfirmationSheetDetailRow label="Tx hash" value={hashLink} />
          {row.refundTxHash && (
            <HashRow label="Refund" hash={row.refundTxHash} url={refundUrl ?? undefined} />
          )}
          <hr className="ww-divider" />
          <ConfirmationSheetDetailRow label="Status" value={status} />
          {row.error && <ConfirmationSheetDetailRow label="Reason" value={row.error} />}
        </div>
      )}

      {isLink ? (
        <>
          <div className="ww-txd__actions">
            {canShare && phone && (
              <PrimaryGradientButton
                title="Share"
                buttonStyle="dark"
                leadingIcon="share"
                onClick={() => {
                  void navigator
                    .share({ text: `I sent you ${amountFace} on zk.money`, url: row.paylink! })
                    .catch(() => {})
                }}
              />
            )}
            <PrimaryGradientButton
              title={copied ? "Copied!" : "Copy paylink"}
              leadingIcon={copied ? "check" : "file-copy"}
              onClick={() => void copy(row.paylink!)}
            />
          </div>
          {recovery && fragment && row.paylinkRow && (
            <PrimaryGradientButton
              title={recovery === "reclaim" ? "Reclaim funds" : "Cancel paylink"}
              buttonStyle="danger"
              isDisabled={checking}
              onClick={() => {
                const token = row.paylinkRow?.token
                setRecovering({
                  action: recovery,
                  fragment,
                  paylinkRow: row.paylinkRow!,
                  amount: token ? usdFigure(String(token.amount)) : row.amount.replace(/^[+-]/, ""),
                  createdMs: row.timestampMs,
                })
              }}
            />
          )}
        </>
      ) : (
        // ponytail: cancellation is out of scope; a pending row shows no footer action.
        !pending &&
        openContact && (
          <button type="button" className="zkm-btn-reset ww-txd__all" onClick={openContact}>
            See all transactions
          </button>
        )
      )}
    </Modal>
  )
}
