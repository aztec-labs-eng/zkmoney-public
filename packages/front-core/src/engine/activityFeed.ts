/**
 * The activity feed as typed items: every source merged once, every exclusion applied here, keyed,
 * newest first. Views render from `selectFeed` and the selectors over it, never from the records.
 */
import { DEFAULT_DECIMALS, PaylinkActionEnum } from "@obsidion/core/constants"
import { hiddenBehindOwnWithdrawal, itemStartTime, type ActivityItem } from "./feedRules"
import type { WithdrawalRecord } from "../core/services/bridge/types"
import type { BridgeInPays, BridgeInRecord } from "../core/services/crossChain/types"
import type { BackupRotationRecord } from "./backupRotations"
import { bridgeInDelivers, bridgeInPaying } from "./bridgeIns"
import { WITHDRAWAL_TERMINAL_PHASES } from "../core/services/bridge/types"
import {
  isFundsLegUnsent,
  isWithdrawalGroupTerminal,
  withdrawalGroupsOf,
  withdrawalGroupTime,
  type WithdrawalGroup,
} from "../core/services/bridge/withdrawalGroups"
import { isWithdrawalDelayed } from "../core/services/bridge/withdrawalPhases"
import type { ActivityCsvSources, SavingsCsvSources } from "../core/services/activity/activityCsv"
import { depositAmounts } from "../core/services/deposits/depositAmounts"
import { sipaReasonShown, type SipaProcessingState } from "../core/services/deposits/sipaProcessing"
import { isFirstSipaPayment, sipaCredits } from "../core/services/deposits/sipaCredits"
import {
  isAccountMoveSipa,
  isSettledSipaPhase,
  isUnfundedSipaDeposit,
  type SipaDeposit,
} from "./sipaDeposits"
import { upgradeRecipients, upgradeRunsOf, type UpgradeRun } from "../core/migration/upgradeRuns"
import { chainUpgradeBatches } from "../core/migration/chainUpgradeBatches"
import type { UpgradeBatchItem } from "../core/migration/upgradeActivity"
import type { OldVersionWithdrawal } from "../core/migration/OldVersionWithdrawalStorage"
import {
  creatorLinkAction,
  isOtherRollupLink,
  type CreatorLinkAction,
} from "../core/services/paylink/creatorLinkAction"
import { paylinkRowView, type PaylinkRowView } from "../core/services/paylink/paylinkRowView"
import { paylinkStatusFor, type PaylinkStatusKind } from "../core/services/paylink/paylinkStatus"
import { savingsLedger, type SavingsLedger } from "../core/services/savings/savingsBasis"
import type { SavingsMoveRecord } from "../core/services/savings/types"
import { savingsValue } from "../core/services/savings/savingsMath"
import { savingsMoveOfWithdrawal } from "../oxide/savingsMoves"
import {
  resolveContactByCounterparty,
  resolveContactForTx,
  type TxContactDirectory,
} from "../core/txContactResolution"
import type { ContactRow } from "./contacts"
import type {
  FaucetTransaction,
  PaylinkTransaction,
  TokenTransaction,
  Transaction,
  TransactionStatus,
} from "../types/transactions"
import { FUNDING_STATUS, operationIndex, withOperation } from "./operations"
import type { Funding, OperationIndex } from "./operations"
import type { OperationRecord } from "./operationTransition"
import type { PaylinkRecord } from "./paylinkTransition"
import { fundingKeys, isLinkFunding } from "./paylinks"
import { normalizeTag } from "../utils/normalizeTag"
import { isZeroAddress, validateAddress } from "../utils/validate"
import {
  backupAddCost,
  backupAdded,
  bridgeItemTime,
  depositExitOffer,
  depositRowPayment,
  fundingRecovery,
  isAddedBackupDeposit,
  isMoveFromPrevious,
  isWaitingAtPrevious,
  isSavingsMoveSettled,
  isStoppedBackupDeposit,
  migrationAmounts,
  neverCreditsL2,
  registrationFor,
  registrationTagForDeposit,
  registrationTagForSipa,
  tagPriceOf,
  withdrawalExit,
  withdrawalIntent,
  type BackupAddCost,
  type DepositOffer,
  type FundingRecovery,
  type Registrations,
  type WithdrawalExit,
} from "./feedRules"
import type { Loaded } from "./recordSource"
import type { RecordSet } from "./persistentStore"
import { fulfillingReceive, type PaymentRequest } from "./requests"

/** An amount in base units at its decimals. */
export interface Money {
  atomic: bigint
  decimals: number
}

/** The stored records the feed reads, and wall time. */
export interface FeedSources {
  /**
   * The transfers the feed lists, with every pending one and
   * request payment, so lookups by hash or request find theirs. `loaded` once every read landed.
   */
  rows: RecordSet<Transaction>
  /** The links the feed lists; their funding transfers among `rows` show as the link. */
  links: RecordSet<PaylinkRecord>
  /** Every operation: a link's funding and refund state are its operations'. */
  operations: RecordSet<OperationRecord>
  /** The time of the oldest row listed while older rows are not read: older items wait for them. */
  cutoff?: number
  requests: readonly PaymentRequest[]
  /** False until the saved requests load. */
  requestsLoaded?: boolean
  deposits: RecordSet<SipaDeposit>
  withdrawals: Loaded<WithdrawalRecord>
  bridgeIns: Loaded<BridgeInRecord>
  /** `recipients`: every deposit address a run pays, a live source's included. */
  upgrades: {
    items: readonly UpgradeBatchItem[]
    recipients: ReadonlySet<string>
    loaded: boolean
  }
  moves: Loaded<SavingsMoveRecord>
  /** "Withdraw to Ethereum" runs from old versions. */
  oldVersionWithdrawals: readonly OldVersionWithdrawal[]
  /** Why a deposit waits for its sweep, by lowercase address. */
  processing: ReadonlyMap<string, SipaProcessingState>
  /** This device's backup passkey attempts: a stopped one's funding reads its recovery. */
  rotations: readonly BackupRotationRecord[] | "unread"
  catchingUp: boolean
  now: number
}

/** What the feed reads beside the stores. */
export interface FeedContext {
  contacts: { rows: readonly ContactRow[]; hydrated: boolean; failed: boolean }
  registrations: Registrations
  /** The pending registration's own row, while it has one. */
  registration?: { sipaAddress: string; ts: number }
  /** Chain time; no creator recovery is offered until it is read. */
  chainNowSec?: number
  /** The active rollup's network: a link made on another is retired here. */
  activeNetworkId?: string
  /**
   * The session's account: a link another account made offers no creator recovery, and a send
   * from the previous account to it is the wallet's own move.
   */
  account?: string
  /** When each stored balance's read resolved, ms. */
  balanceReadAt?: { main?: number; savings?: number }
  sharePrice?: bigint
  /** The L1 token of Savings' row: a deposit swept on it lands in Savings. */
  savingsToken?: string
  /** Whether Savings has a row is not known yet, so no swept deposit can be placed. */
  savingsUnknown?: boolean
  /** What the account holds on old versions. */
  oldVersions?: ArrivingFunds
  /** What a backup passkey add has yet to move into the account, as `balanceToMove` reads it. */
  backupMove?: BackupMove
  /**
   * A rotated wallet's previous account. Transfers from it leave the feed, and so do deposits still
   * waiting there, which the Passkeys panel's check finds.
   */
  previousAccount?: string
}

interface Base {
  id: string
  ts: number
  /** Where funds move: out of the balance, or into it. */
  direction: "in" | "out"
  pending: boolean
}

export type RequestRole = "incoming" | "outgoingContact" | "outgoingLink"

export type FeedItem = Base &
  (
    | {
        kind: "request"
        request: PaymentRequest
        role: RequestRole
        amount: Money
        /** A link whose deposit shows funds before the claim pays it. */
        detected: boolean
        contact?: ContactRow
      }
    | { kind: "paidLink"; request: PaymentRequest; amount: Money }
    | {
        kind: "tx"
        tx: TokenTransaction | FaucetTransaction | PaylinkTransaction
        amount: Money
        contact?: ContactRow
        /** The counterparty's tag, saved or not: its conversation opens by it. */
        counterpartyTag?: string
        /** A claim of a link: what its row shows. */
        link?: PaylinkRowView
      }
    | {
        kind: "link"
        link: PaylinkRecord
        funding: Funding
        /** The operation that funded it, while this device keeps it. */
        op?: OperationRecord
        amount: Money
        view: PaylinkRowView
        paylinkStatus: PaylinkStatusKind
        refundStatus?: TransactionStatus
        creatorAction?: CreatorLinkAction
      }
    | { kind: "upgrade"; run: UpgradeRun }
    | {
        kind: "withdrawalGroup"
        group: WithdrawalGroup
        head: WithdrawalRecord
        /** The leg whose release waits longer than usual. */
        delayed?: WithdrawalRecord
        exit?: { record: WithdrawalRecord; exit: WithdrawalExit }
        unsent: boolean
      }
    | { kind: "savingsMove"; move: SavingsMoveRecord; burn: WithdrawalRecord }
    | {
        kind: "withdrawal"
        record: WithdrawalRecord
        /** What the burn paid for, as {@link withdrawalIntent} reads it. */
        intent: WithdrawalRecord["intent"]
        delayed: boolean
        exit?: WithdrawalExit
        /** A burn to this wallet's registration SIPA paid for its tag. */
        registrationTag?: string
        recovery?: FundingRecovery
        /** A backup passkey funding whose add ran, as {@link backupAdded} reads it. */
        added?: true
        /** A backup passkey funding, once its deposit address credited the rest back. */
        cost?: BackupAddCost
      }
    | {
        kind: "deposit"
        record: SipaDeposit
        /** The inbox index of a past payment to the address, split out of its record. */
        payment?: string
        processing?: SipaProcessingState
        intent: "deposit" | "registration" | "migration" | "backup"
        /** A backup passkey's deposit whose add stopped, shown when no funding here carries it. */
        stopped?: true
        /** A backup passkey's deposit that was swept: the add ran. */
        added?: true
        tag?: string
        /**
         * The price its tag purchase row lists, in the record's units. The row's figure adds it to
         * what landed, so the two rows net what the balance gained.
         */
        tagPrice?: bigint
        offer: DepositOffer | null
        /** What the timestamp slot says instead of the time. */
        subline?: { reason: SipaProcessingState["reason"]["kind"] } | "stuck"
        /** A migration's arrival before its funds land; no figure while a fee is unknown. */
        arriving?: { net?: bigint }
        /** The bridge-in that paid the address from another chain. */
        bridgeIn?: BridgeInRecord
      }
    | { kind: "tagPurchase"; record: SipaDeposit; tag: string; price: bigint }
    | { kind: "registration" }
    | { kind: "oldVersionWithdrawal"; record: OldVersionWithdrawal }
    | {
        kind: "bridgeIn"
        record: BridgeInRecord
        /** Set when it pays someone else: an outgoing payment. */
        pays?: BridgeInPays
      }
  )

export interface SavingsItem extends Base {
  move: SavingsMoveRecord
  burn?: WithdrawalRecord
}

export interface ArrivingFunds {
  main: bigint
  savings: bigint
}

/** Main's atomic units and Savings' shares. */
export interface BackupMove {
  main: bigint
  shares: bigint
}

export interface Feed {
  items: FeedItem[]
  /** The bridge records the feed shows, newest first: what deep links and details resolve. */
  bridge: ActivityItem[]
  groups: WithdrawalGroup[]
  upgradeRuns: UpgradeRun[]
  /** Every source served its last-known state and no chain scan is rebuilding history. */
  hydrated: boolean
  /** The contacts could not be read, so incoming requests are hidden. */
  requestsUnavailable: boolean
  arriving: ArrivingFunds
  /** The upgrade's deposit addresses are read, so `arriving` counts none of them. */
  upgradesLoaded: boolean
  savings: { items: SavingsItem[]; hydrated: boolean; ledger?: SavingsLedger }
  /** The exports' records; the view adds the Main token's metadata once it is read. */
  csv: Omit<ActivityCsvSources, "walletToken">
  savingsCsv: Omit<SavingsCsvSources, "walletToken">
}

const lower = (value: string) => value.toLowerCase()

/** A request's amount. Rows from before `amountAtomic` carry only the dollar figure. */
export function requestMoney(request: PaymentRequest): Money {
  if (request.amountAtomic !== undefined && request.tokenDecimals !== undefined)
    return { atomic: BigInt(request.amountAtomic), decimals: request.tokenDecimals }
  return { atomic: BigInt(Math.round(request.amount * 100)), decimals: 2 }
}

const isExpired = (request: PaymentRequest, now: number) =>
  request.expiresAt != null && now > request.expiresAt

/** Lowercased tags of the L2 contacts the user added, not of senders added from a transfer. */
export function approvedContactTags(contacts: readonly ContactRow[]): Set<string> {
  return new Set(
    contacts.flatMap((c) =>
      c.addressKind === "aztec-l2" && !c.autoAdded ? [c.tag.toLowerCase()] : [],
    ),
  )
}

/** An incoming request from someone outside the contact book: kept out of Activity and Home. */
export function isFromNonContact(
  request: Pick<PaymentRequest, "direction" | "contactTag">,
  contactTags: ReadonlySet<string>,
): boolean {
  return request.direction === "incoming" && !contactTags.has(request.contactTag.toLowerCase())
}

/** The inbox for requests from non-contacts: pending, unexpired, unpaid, newest first. */
export function nonContactInbox(
  requests: readonly PaymentRequest[],
  contacts: readonly ContactRow[],
  now: number,
): PaymentRequest[] {
  const tags = approvedContactTags(contacts)
  return requests
    .filter((r) => r.status === "pending" && !isExpired(r, now) && isFromNonContact(r, tags))
    .sort((a, b) => b.createdAt - a.createdAt)
}

export interface PaidLinkPayer {
  displayName: string
  contact?: ContactRow
}

/** Who paid a request link, from the receive that paid it. */
export function payerForPaidLink(
  request: Pick<PaymentRequest, "fulfillmentTxHash">,
  rows: readonly Transaction[],
  contacts: readonly ContactRow[],
): PaidLinkPayer | undefined {
  const tx = fulfillingReceive(request, rows)
  if (!tx) return undefined
  const contact = resolveContactForTx(tx.from ?? "", tx.senderL2Address, directoryOf(contacts))
  if (contact) return { displayName: contact.name, contact }
  const from = tx.from
  if (!from || isZeroAddress(from) || validateAddress(from)) return undefined
  return { displayName: from.startsWith("@") ? from : `@${from}` }
}

/** The paid screen's "Added to your contacts": the payer is now a full contact. */
export function payerAddedToContacts(contact: ContactRow | undefined): boolean {
  return !!contact && contact.addressKind === "aztec-l2" && !contact.autoAdded
}

const directoryOf = (contacts: readonly ContactRow[]): TxContactDirectory => ({
  contacts: [...contacts],
  lookup: (idOrTag) => contacts.find((c) => c.id === idOrTag || c.tag === idOrTag),
})

const isPaidLink = (r: PaymentRequest) =>
  r.direction === "outgoing" && r.kind === "link" && r.status === "fulfilled"

// A refund is not a movement of its own: the creator's PAY row carries the round trip.
// eslint-disable-next-line no-restricted-syntax -- ZKM-1778
const VISIBLE_ACTIONS = new Set<string>([
  "send",
  "receive",
  "faucet",
  PaylinkActionEnum.PAY,
  PaylinkActionEnum.CLAIM,
])

type VisibleTx = TokenTransaction | FaucetTransaction | PaylinkTransaction

const isVisible = (tx: Transaction): tx is VisibleTx =>
  "token" in tx && tx.token != null && VISIBLE_ACTIONS.has(tx.action)

/** The state of the transaction `txHash`, as its operation or its row has it. */
function statusOf(
  txHash: string | undefined,
  ops: OperationIndex,
  rows: ReadonlyMap<string, TransactionStatus>,
): TransactionStatus | undefined {
  if (!txHash) return undefined
  const { op, funding } = withOperation({ txHash }, ops)
  return op ? FUNDING_STATUS[funding] : rows.get(lower(txHash))
}

function linkItems(
  links: readonly PaylinkRecord[],
  ops: OperationIndex,
  statusByHash: ReadonlyMap<string, TransactionStatus>,
  sources: Pick<FeedSources, "now">,
  ctx: Pick<FeedContext, "chainNowSec" | "activeNetworkId" | "account">,
): FeedItem[] {
  const { chainNowSec } = ctx
  const clockSec = chainNowSec ?? Math.floor(sources.now / 1000)
  return links.map((link): FeedItem => {
    const { op, funding, refunding } = withOperation(link, ops)
    const status = FUNDING_STATUS[funding]
    const linkStatus = paylinkStatusFor(link, clockSec)
    const refundStatus = statusOf(link.refundTxHash, ops, statusByHash)
    const view = paylinkRowView(link, {
      status,
      create: true,
      linkStatus,
      offer:
        chainNowSec != null
          ? creatorLinkAction(link, status, {
              nowSec: chainNowSec,
              liveStatus: linkStatus,
              account: ctx.account,
            })
          : null,
      refundStatus,
      refundStarting: !!refunding,
      retired: isOtherRollupLink(link, ctx.activeNetworkId),
      nowSec: clockSec,
    })
    const paylinkStatus = view.refunded ? "refunded" : linkStatus
    return {
      kind: "link",
      id: link.txHash ? lower(link.txHash) : link.id,
      ts: link.timestamp,
      direction: "out",
      pending: status === "pending" || (status === "success" && paylinkStatus === "awaitingClaim"),
      link,
      funding,
      op,
      amount: { atomic: link.amountAtomic, decimals: link.token?.decimals ?? DEFAULT_DECIMALS },
      view,
      paylinkStatus,
      refundStatus,
      creatorAction: view.recovery ?? undefined,
    }
  })
}

function txItems(
  rows: readonly Transaction[],
  requests: readonly PaymentRequest[],
  directory: TxContactDirectory,
  funded: ReadonlySet<string>,
  nowSec: number,
  { previousAccount, account }: Pick<FeedContext, "previousAccount" | "account">,
): FeedItem[] {
  // A receive that paid a request link shows as the paid link.
  const paidByLink = new Set(
    requests.flatMap((r) =>
      isPaidLink(r) && r.fulfillmentTxHash ? [lower(r.fulfillmentTxHash)] : [],
    ),
  )
  return rows
    .filter(isVisible)
    .filter((tx) => !isLinkFunding(tx, funded))
    .filter((tx) => tx.action !== "receive" || !tx.txHash || !paidByLink.has(lower(tx.txHash)))
    .filter((tx) => !isMoveFromPrevious(tx, previousAccount, account))
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((tx): FeedItem => {
      // A created link's row with no link record: one an older build never finished.
      const create = tx.action === PaylinkActionEnum.PAY
      const view =
        create || tx.action === PaylinkActionEnum.CLAIM
          ? paylinkRowView(tx as PaylinkTransaction, { status: tx.status, create, nowSec })
          : undefined
      let contact: ContactRow | undefined
      let counterpartyTag: string | undefined
      if (!view && tx.action === "send") {
        const { to, toTag } = tx as TokenTransaction
        contact =
          (to ? resolveContactByCounterparty(to, directory) : undefined) ??
          (toTag ? directory.lookup(toTag) : undefined)
        counterpartyTag = toTag
      } else if (!view && tx.action !== "faucet") {
        const { from, senderL2Address } = tx as TokenTransaction
        contact =
          from || senderL2Address
            ? resolveContactForTx(from ?? "", senderL2Address, directory)
            : undefined
        counterpartyTag =
          from && !validateAddress(from) ? normalizeTag(from) ?? undefined : undefined
      }
      return {
        kind: "tx",
        id: tx.txHash || tx.id,
        ts: tx.timestamp,
        direction: tx.action === "send" || create ? "out" : "in",
        pending: tx.status === "pending",
        tx,
        amount: { atomic: tx.amountAtomic, decimals: tx.token?.decimals ?? DEFAULT_DECIMALS },
        contact,
        counterpartyTag: contact?.addressKind === "aztec-l2" ? contact.tag : counterpartyTag,
        link: view,
      }
    })
}

type DepositView = Extract<ActivityItem, { kind: "bridge.sipaDeposit" }>

/**
 * The deposit row a paid request link stands for: the payment `resolveRequests` counted for it, by
 * its sweep's inbox index, or the address's own row when that payment has none.
 */
function paidLinkDeposit(
  { paidByDeposit: paid }: PaymentRequest,
  views: readonly DepositView[],
): DepositView | undefined {
  if (!paid) return undefined
  const address = lower(paid.sipaAddress)
  return views.find(
    (view) =>
      lower(view.record.sipaAddress) === address &&
      (paid.inboxIndex ? depositRowPayment(view) === paid.inboxIndex : !view.payment),
  )
}

/**
 * The deposit rows request links stand for: every payment at an address with a pending request,
 * and the payment that paid a paid one. Any other payment there is a deposit of its own, at a
 * cancelled request's address too: a payment that paid it would make it read paid.
 */
function requestLinkedDeposits(
  requests: readonly PaymentRequest[],
  paidBy: (request: PaymentRequest) => DepositView | undefined,
): (view: DepositView) => boolean {
  const pending = new Set<string>()
  const paying = new Set<DepositView>()
  for (const request of requests) {
    if (!request.sipaAddress) continue
    if (request.status === "pending") pending.add(lower(request.sipaAddress))
    const paid = request.status === "fulfilled" && paidBy(request)
    if (paid) paying.add(paid)
  }
  return (view) => pending.has(lower(view.record.sipaAddress)) || paying.has(view)
}

function requestItems(
  requests: readonly PaymentRequest[],
  rows: readonly Transaction[],
  deposits: readonly SipaDeposit[],
  directory: TxContactDirectory,
  ctx: FeedContext,
  now: number,
  paidBy: (request: PaymentRequest) => DepositView | undefined,
): FeedItem[] {
  const contactsCurrent = ctx.contacts.hydrated && !ctx.contacts.failed
  const tags = approvedContactTags(ctx.contacts.rows)
  const bySipa = new Map(deposits.map((d) => [lower(d.sipaAddress), d]))
  const open = requests
    .filter(
      (r) =>
        r.status === "pending" &&
        !isExpired(r, now) &&
        !r.unlisted &&
        (contactsCurrent ? !isFromNonContact(r, tags) : r.direction !== "incoming"),
    )
    .map((request): FeedItem => {
      const role: RequestRole =
        request.direction === "incoming"
          ? "incoming"
          : request.kind === "link"
          ? "outgoingLink"
          : "outgoingContact"
      const deposit = request.sipaAddress ? bySipa.get(lower(request.sipaAddress)) : undefined
      // Any evidence of funds counts; paid waits for the claim.
      const detected =
        role === "outgoingLink" &&
        !!deposit &&
        (depositAmounts(deposit).grossAtomic > 0n ||
          (deposit.phase !== "broadcast" && deposit.phase !== "resolved"))
      return {
        kind: "request",
        id: request.id,
        ts: request.createdAt,
        direction: role === "incoming" ? "out" : "in",
        pending: true,
        request,
        role,
        amount: requestMoney(request),
        detected,
        contact: request.contactTag ? directory.lookup(request.contactTag) : undefined,
      }
    })
  const paid = requests.filter(isPaidLink).map((request): FeedItem => {
    const deposit = paidBy(request)?.record
    const receive = fulfillingReceive(request, rows)
    const net = deposit ? depositAmounts(deposit).netAtomic : 0n
    const amount: Money = receive
      ? { atomic: receive.amountAtomic, decimals: receive.token.decimals }
      : net > 0n
      ? { atomic: net, decimals: DEFAULT_DECIMALS }
      : requestMoney(request)
    return {
      kind: "paidLink",
      id: request.id,
      // When it was paid: the row stands in for the payment, which can land long after the ask.
      ts: deposit ? deposit.endTime ?? deposit.startTime : receive?.timestamp ?? request.createdAt,
      direction: "in",
      pending: false,
      request,
      amount,
    }
  })
  return [...open, ...paid]
}

/** What the feed shows of the bridge, as the bell's feed lists it: newest first. */
function bridgeOf(sources: FeedSources): ActivityItem[] {
  const withdrawals = sources.withdrawals.records
  const { upgrades } = sources
  // Deposits no run of this device covers, once its runs are read, so none is listed twice.
  const chainBatches = upgrades.loaded
    ? chainUpgradeBatches(sources.deposits.records, upgrades.recipients)
    : []
  const items: ActivityItem[] = [
    ...sources.deposits.records
      .filter((record) => !hiddenBehindOwnWithdrawal(record, withdrawals, sources.now))
      .flatMap((stored) =>
        sipaCredits(stored).map(({ record, payment }): ActivityItem => {
          if (payment) return { kind: "bridge.sipaDeposit", record, payment }
          const processing = sources.processing.get(lower(record.sipaAddress))
          return processing
            ? { kind: "bridge.sipaDeposit", record, processing }
            : { kind: "bridge.sipaDeposit", record }
        }),
      ),
    ...withdrawals.map((record): ActivityItem => ({ kind: "bridge.withdrawal", record })),
    ...[...upgrades.items, ...chainBatches].map(
      (batch): ActivityItem => ({ kind: "upgrade.batch", batch }),
    ),
  ]
  return items.sort((a, b) => itemStartTime(b) - itemStartTime(a))
}

function withdrawalItem(
  record: WithdrawalRecord,
  sources: FeedSources,
  ctx: FeedContext,
  moves: readonly SavingsMoveRecord[],
): FeedItem {
  const base = { id: record.localId, ts: bridgeItemTime({ kind: "bridge.withdrawal", record }) }
  if (record.skyMove) {
    const move = moves.find((m) => m.withdrawalLocalId === record.localId) ?? {
      ...savingsMoveOfWithdrawal(record)!,
      startTime: record.startTime,
    }
    return {
      ...base,
      kind: "savingsMove",
      direction: move.direction === "in" ? "out" : "in",
      pending: !isSavingsMoveSettled(move, record),
      move,
      burn: record,
    }
  }
  const exit = withdrawalExit(record, sources.now)
  const recipient = sources.deposits.records.find(
    (d) => lower(d.sipaAddress) === lower(record.recipient),
  )
  const recovery = fundingRecovery(record, sources.rotations, recipient)
  return {
    ...base,
    kind: "withdrawal",
    direction: "out",
    pending:
      !WITHDRAWAL_TERMINAL_PHASES.has(record.phase) ||
      recovery?.state === "sent" ||
      recovery?.state === "unread",
    record,
    intent: withdrawalIntent(record, recipient),
    delayed:
      isWithdrawalDelayed(record, sources.now) ||
      (exit?.kind === "swap" && exit.reason === "stuck"),
    exit,
    registrationTag: registrationTagForSipa(ctx.registrations, record.recipient, recipient),
    recovery,
    ...(backupAdded(record, sources.rotations, recipient) ? { added: true as const } : {}),
    cost: backupAddCost(record, recipient),
  }
}

function depositItems(
  item: Extract<ActivityItem, { kind: "bridge.sipaDeposit" }>,
  sources: FeedSources,
  ctx: FeedContext,
  hide: { linked: (view: DepositView) => boolean; upgradeArrivals: ReadonlySet<string> },
): FeedItem[] {
  const { record, processing, payment } = item
  const address = lower(record.sipaAddress)
  if (hide.upgradeArrivals.has(address)) return []
  const bridgeIn = bridgeInPaying(sources.bridgeIns.records, record.sipaAddress)
  const burn = sources.withdrawals.records.find(
    (r) => r.intent === "migration" && lower(r.recipient) === address,
  )
  const unfunded = isUnfundedSipaDeposit(record)
  // A migration's arrival shows from its exit on; unfunded behind a failed burn it never fills.
  if (((!burn || burn.phase === "failed") && unfunded) || hide.linked(item)) return []
  const arriving = !!burn && unfunded
  const exitTime = burn ? burn.endTime ?? burn.startTime : undefined
  // A migration's arrival sits directly above its exit.
  const ts =
    exitTime !== undefined
      ? Math.max(arriving ? 0 : bridgeItemTime(item), exitTime + 1)
      : bridgeItemTime(item)
  const tag = registrationTagForDeposit(ctx.registrations, record)
  const offer = depositExitOffer(record, {
    processing,
    registration: registrationFor(ctx.registrations, record.sipaAddress),
    now: sources.now,
  })
  if (isWaitingAtPrevious(record, ctx.previousAccount, offer)) return []
  const subline = sipaReasonShown(processing, record, sources.now)
    ? { reason: processing.reason.kind }
    : offer?.waiting
    ? ("stuck" as const)
    : undefined
  // The tag's price came out of the address's first payment before it reached L2; its own row says
  // where it went.
  const price = tagPriceOf(record)
  const purchase: FeedItem[] =
    tag && price && record.phase === "claimed" && isFirstSipaPayment(record)
      ? [
          {
            kind: "tagPurchase",
            id: `${record.sipaAddress}:tag`,
            ts: ts - 1,
            direction: "out",
            pending: false,
            record,
            tag,
            price,
          },
        ]
      : []
  return [
    ...purchase,
    {
      kind: "deposit",
      // A past payment to the address is a row of its own.
      id: payment ? `${record.sipaAddress}:${payment}` : record.sipaAddress,
      ts,
      direction: "in",
      pending: !isSettledSipaPhase(record.phase),
      record,
      ...(payment ? { payment } : {}),
      processing,
      intent: tag
        ? "registration"
        : burn
        ? "migration"
        : isAccountMoveSipa(record)
        ? "backup"
        : "deposit",
      ...(isStoppedBackupDeposit(record)
        ? { stopped: true as const }
        : isAddedBackupDeposit(record)
        ? { added: true as const }
        : {}),
      tag,
      ...(purchase.length ? { tagPrice: price } : {}),
      offer,
      subline,
      arriving: arriving ? { net: burn && migrationAmounts(burn)?.netAtomic } : undefined,
      ...(bridgeIn ? { bridgeIn } : {}),
    },
  ]
}

/**
 * Bridge-ins from another chain, once their call is sent. One still delivering shows until its
 * deposit is funded, then the deposit's row carries it. One that pays someone else is an outgoing
 * payment.
 */
function bridgeInItems(sources: FeedSources): FeedItem[] {
  const deposits = new Map(sources.deposits.records.map((d) => [lower(d.sipaAddress), d]))
  return sources.bridgeIns.records.flatMap((record): FeedItem[] => {
    if (!record.originTxHash) return []
    const deposit = !record.pays && deposits.get(lower(record.recipient))
    if (bridgeInDelivers(record) && deposit && !isUnfundedSipaDeposit(deposit)) return []
    return [
      {
        kind: "bridgeIn",
        id: record.id,
        ts: record.startTime,
        direction: record.pays ? "out" : "in",
        // Filled, it is still swept into the balance; a payment is done.
        pending: record.status === "pending" || (!record.pays && record.status === "filled"),
        record,
        ...(record.pays && { pays: record.pays }),
      },
    ]
  })
}

function groupItems(groups: readonly WithdrawalGroup[], now: number): FeedItem[] {
  return groups.map((group): FeedItem => {
    const named = [group.legs.gas, group.legs.funds].flatMap((r) => r ?? [])
    const legs = named.length ? named : group.records
    const delayed = legs.find((r) => {
      const exit = withdrawalExit(r, now)
      return isWithdrawalDelayed(r, now) || (exit?.kind === "swap" && exit.reason === "stuck")
    })
    const exit = legs.flatMap((record) => {
      const offer = withdrawalExit(record, now)
      return offer ? [{ record, exit: offer }] : []
    })[0]
    return {
      kind: "withdrawalGroup",
      id: group.groupId,
      ts: withdrawalGroupTime(group),
      direction: "out",
      pending: !isWithdrawalGroupTerminal(group),
      group,
      head: group.legs.gas ?? group.records[0],
      delayed,
      exit,
      unsent: isFundsLegUnsent(group),
    }
  })
}

/**
 * Funds each balance is owed but does not hold yet, at what will land, so a balance never drops
 * when funds arrive. A deposit counts in the balance its row credits once its sweep fixes the net,
 * Savings' at the share price. A migration or a Savings move counts once its burn has left the
 * source, at its quote, then at its deposit once the escrow has run, until its destination's
 * balance is read after this device stored the claim. A move rebuilt from
 * a rescan has no quote and counts only from its deposit. An upgrade's own deposits never count:
 * the upgrade lock holds Home's figure until the balance holds them. A backup passkey add's move
 * counts until the balance holds each chunk.
 */
export function arrivingFunds(input: {
  deposits: readonly SipaDeposit[]
  burns: readonly WithdrawalRecord[]
  moves: readonly SavingsMoveRecord[]
  sharePrice?: bigint
  savingsToken?: string
  /** A deposit is held until its row can be placed: the balance rises late, never drops. */
  savingsUnknown?: boolean
  rows: readonly Transaction[]
  balanceReadAt?: { main?: number; savings?: number }
  upgradeRecipients?: ReadonlySet<string>
  oldVersions?: ArrivingFunds
  backupMove?: BackupMove
  previousAccount?: string
}): ArrivingFunds {
  const { deposits, burns, moves, sharePrice, balanceReadAt = {} } = input
  const { backupMove = { main: 0n, shares: 0n } } = input
  const upgrades = input.upgradeRecipients ?? new Set<string>()
  let main = (input.oldVersions?.main ?? 0n) + backupMove.main
  let savings = input.oldVersions?.savings ?? 0n
  if (sharePrice !== undefined) savings += savingsValue(backupMove.shares, sharePrice)
  const swept = (record: SipaDeposit) => record.phase === "pendingClaim" && record.netAmount != null
  // A spent deposit is history the balance already holds or spent.
  const spent = (record: SipaDeposit) =>
    !!record.pendingSweeps?.some((s) => s.inboxIndex === record.inboxIndex && s.spent)
  const depositBySipa = new Map(deposits.map((d) => [lower(d.sipaAddress), d] as const))
  // A burn still proving has not left its source yet.
  const left = (burn?: WithdrawalRecord) =>
    !!burn && burn.phase !== "submitting" && burn.phase !== "failed"
  // A read resolved after a claim landed holds it, though the record still awaits `claimed`.
  const held = ({ claimLanded, inboxIndex }: SipaDeposit, into: keyof ArrivingFunds) =>
    !!claimLanded &&
    claimLanded.inboxIndex === inboxIndex &&
    (balanceReadAt[into] ?? 0) >= claimLanded.at
  const previous = input.previousAccount && lower(input.previousAccount)
  const savingsToken = input.savingsToken && lower(input.savingsToken)
  for (const record of deposits) {
    // A SIPA the account pays itself is not a deposit the user waits on.
    const upgrade = isAccountMoveSipa(record) || upgrades.has(lower(record.sipaAddress))
    const toPrevious = !!previous && lower(record.recipientL2Address ?? "") === previous
    if (!swept(record) || spent(record) || upgrade || toPrevious || input.savingsUnknown) continue
    // A swept record reads as its row's token.
    const into = lower(record.tokenAddress ?? "") === savingsToken ? "savings" : "main"
    if (held(record, into)) continue
    const net = BigInt(record.netAmount!)
    if (into === "main") main += net
    else if (sharePrice !== undefined) savings += savingsValue(net, sharePrice)
  }
  for (const burn of burns) {
    if (burn.intent !== "migration" || !left(burn)) continue
    const arrival = depositBySipa.get(lower(burn.recipient))
    if (
      arrival &&
      (swept(arrival) || isSettledSipaPhase(arrival.phase) || neverCreditsL2(arrival.phase))
    )
      continue
    main += migrationAmounts(burn)?.netAtomic ?? 0n
  }
  const burnById = new Map(burns.map((burn) => [burn.localId, burn] as const))
  for (const move of moves) {
    const burn = burnById.get(move.withdrawalLocalId)
    const into = move.direction === "in"
    const storedAt = move.deposit?.claimed ? move.deposit.storedAt : undefined
    const unread =
      storedAt !== undefined && (balanceReadAt[into ? "savings" : "main"] ?? 0) < storedAt
    if (!left(burn) || (isSavingsMoveSettled(move, burn) && !unread)) continue
    const landed = move.deposit && BigInt(move.deposit.amount)
    const figure =
      landed !== undefined && (!into || sharePrice !== undefined)
        ? into
          ? savingsValue(landed, sharePrice!)
          : landed
        : move.net === undefined
        ? 0n
        : BigInt(move.net)
    if (into) savings += figure
    else main += figure
  }
  for (const tx of input.rows) {
    const inbound = tx.action === PaylinkActionEnum.CLAIM || tx.action === "faucet"
    if (tx.status !== "pending" || !inbound || !("token" in tx) || !tx.token) continue
    if (tx.token.hasUnknownAmount) continue
    const { decimals } = tx.token
    const scale = DEFAULT_DECIMALS - decimals
    main += scale >= 0 ? tx.amountAtomic * 10n ** BigInt(scale) : tx.amountAtomic
  }
  return { main, savings }
}

/** Every source merged into the feed. */
export function selectFeed(sources: FeedSources, ctx: FeedContext): Feed {
  const { now } = sources
  const rows = sources.rows.records
  const directory = directoryOf(ctx.contacts.rows)
  const bridge = bridgeOf(sources)
  const deposits = sources.deposits.records
  const withdrawals = sources.withdrawals.records
  const moves = sources.moves.records
  const groups = withdrawalGroupsOf(withdrawals)
  const upgradeRuns = upgradeRunsOf(bridge)
  const views = bridge.filter((item): item is DepositView => item.kind === "bridge.sipaDeposit")
  const paidBy = (request: PaymentRequest) => paidLinkDeposit(request, views)
  const hide = {
    // Request-link SIPAs show as the request.
    linked: requestLinkedDeposits(sources.requests, paidBy),
    // An upgrade is one row over its batches; their deposits are its legs.
    upgradeArrivals: upgradeRecipients(bridge),
  }
  // A registration a burn from this wallet paid: the burn's row is the registration's.
  const burnFunded = new Set(
    withdrawals.filter((r) => r.intent === "registration").map((r) => lower(r.recipient)),
  )
  const { registration } = ctx
  const ops = operationIndex(sources.operations.records)
  const links = sources.links.records
  const statusByHash = new Map(
    rows.flatMap((tx) => (tx.txHash ? [[lower(tx.txHash), tx.status] as const] : [])),
  )
  // A listed link's funding transfer shows as the link.
  const funded = fundingKeys(links)
  const clockSec = ctx.chainNowSec ?? Math.floor(now / 1000)
  const items: FeedItem[] = [
    ...requestItems(sources.requests, rows, deposits, directory, ctx, now, paidBy),
    ...linkItems(links, ops, statusByHash, { now }, ctx),
    ...txItems(rows, sources.requests, directory, funded, clockSec, ctx),
    ...upgradeRuns.map(
      (run): FeedItem => ({
        kind: "upgrade",
        id: `upgrade-run:${run.run}`,
        ts: run.time,
        direction: "in",
        pending: !run.settled,
        run,
      }),
    ),
    ...sources.oldVersionWithdrawals.map(
      (record): FeedItem => ({
        kind: "oldVersionWithdrawal",
        id: `old-version-withdrawal:${record.id}`,
        ts: record.startTime,
        direction: "out",
        pending: record.phase === "sending",
        record,
      }),
    ),
    ...groupItems(groups, now),
    ...bridgeInItems(sources),
    ...bridge.flatMap((item): FeedItem[] => {
      if (item.kind === "bridge.withdrawal")
        return item.record.groupId ? [] : [withdrawalItem(item.record, sources, ctx, moves)]
      if (item.kind === "bridge.sipaDeposit") return depositItems(item, sources, ctx, hide)
      return []
    }),
    ...(registration && !burnFunded.has(lower(registration.sipaAddress))
      ? [
          {
            kind: "registration" as const,
            id: "registration-deposit",
            ts: registration.ts,
            direction: "in" as const,
            pending: true,
          },
        ]
      : []),
  ]
    .filter((item) => sources.cutoff === undefined || item.ts >= sources.cutoff)
    .sort((a, b) => b.ts - a.ts)

  const burns = new Map(withdrawals.map((record) => [record.localId, record] as const))
  const savingsItems = moves.map(
    (move): SavingsItem => ({
      id: move.withdrawalLocalId,
      ts: move.startTime,
      direction: move.direction,
      pending: !isSavingsMoveSettled(move, burns.get(move.withdrawalLocalId)),
      move,
      burn: burns.get(move.withdrawalLocalId),
    }),
  )
  return {
    items,
    bridge,
    groups,
    upgradeRuns,
    hydrated:
      sources.rows.loaded &&
      !sources.rows.failed &&
      sources.links.loaded &&
      !sources.links.failed &&
      sources.operations.loaded &&
      !sources.operations.failed &&
      sources.requestsLoaded !== false &&
      sources.deposits.loaded &&
      !sources.deposits.failed &&
      sources.upgrades.loaded &&
      sources.withdrawals.hydrated &&
      sources.bridgeIns.hydrated &&
      (ctx.contacts.hydrated || ctx.contacts.failed) &&
      !sources.catchingUp,
    requestsUnavailable: ctx.contacts.failed,
    // The store, not the feed: the feed hides a deposit behind the burn that paid it.
    arriving: arrivingFunds({
      deposits,
      burns: withdrawals,
      moves,
      sharePrice: ctx.sharePrice,
      savingsToken: ctx.savingsToken,
      savingsUnknown: ctx.savingsUnknown,
      rows,
      balanceReadAt: ctx.balanceReadAt,
      upgradeRecipients: sources.upgrades.recipients,
      oldVersions: ctx.oldVersions,
      backupMove: ctx.backupMove,
      previousAccount: ctx.previousAccount,
    }),
    upgradesLoaded: sources.upgrades.loaded,
    savings: {
      items: savingsItems,
      hydrated: sources.moves.hydrated,
      ledger: sources.moves.hydrated ? savingsLedger([...moves], burns) : undefined,
    },
    csv: {
      transactions: rows,
      links: links.map((link) => ({
        link,
        status: FUNDING_STATUS[withOperation(link, ops).funding],
      })),
      items: bridge,
      requests: sources.requests,
    },
    savingsCsv: { moves, burns },
  }
}

/** A request nobody has paid: it files under Pending, never Sent or Received. */
export const isUnpaidRequest = (item: FeedItem) => item.kind === "request"

export const isIncomingRequest = (item: FeedItem) =>
  item.kind === "request" && item.role === "incoming"

/** Home: incoming requests in their own slot above the feed. */
export function selectHome(feed: Feed): { requests: FeedItem[]; feed: FeedItem[] } {
  return {
    requests: feed.items.filter(isIncomingRequest),
    feed: feed.items.filter((item) => !isIncomingRequest(item)),
  }
}

export type ActivityFilter = "All" | "Sent" | "Received" | "Pending"

export function matchesFilter(item: Base & { kind?: string }, filter: ActivityFilter): boolean {
  const unpaid = item.kind === "request"
  if (filter === "Sent") return item.direction === "out" && !unpaid
  if (filter === "Received") return item.direction === "in" && !unpaid
  if (filter === "Pending") return item.pending
  return true
}

/** The Activity list for a filter, Main's feed or the Savings account's. */
export function selectActivity<T extends Base & { kind?: string }>(
  items: readonly T[],
  filter: ActivityFilter,
): T[] {
  return items.filter((item) => matchesFilter(item, filter))
}

/** Requests' boxes: the unpaid ones made by the user, those made to them, and the inbox count. */
export function selectRequests(
  feed: Feed,
  nonContacts: number,
): { sent: FeedItem[]; received: FeedItem[]; receivedCount: number } {
  const unpaid = feed.items.filter(isUnpaidRequest)
  const received = unpaid.filter(isIncomingRequest)
  return {
    sent: unpaid.filter((item) => !isIncomingRequest(item)),
    received,
    receivedCount: received.length + nonContacts,
  }
}
