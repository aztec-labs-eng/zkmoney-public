import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type Context,
  type ReactNode,
} from "react"
import type { Network } from "@obsidion/sdk"
import { useLocation, useNavigate } from "react-router-dom"
import { formatUnits } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  bridgeDetailTarget,
  depositDetailItem,
  depositDetailOffer,
  findBridgeItem,
  isWithdrawalDelayed,
  payerForPaidLink,
  registrationFor,
  registrationTagForDeposit,
  savingsMoveEta,
  savingsMoveExitOffer,
  savingsMoveOfWithdrawal,
  tagPriceOf,
  useStore,
  withdrawalExit,
  worstWithdrawalPhase,
  type CreatorLinkAction,
  type Feed,
  type FeedItem,
  type PaymentRequest,
  type DepositOffer,
  type OldVersionRefund,
  type OldVersionWithdrawal,
  type SipaProcessingState,
  type SavingsMoveEta,
  type SavingsMoveRecord,
  type SipaDeposit,
  type SwapExitReason,
  type UpgradePricing,
  type WithdrawalExit,
  type WithdrawalRecord,
  type ReadonlyStore,
  type RecordSet,
  type Transaction,
  WalletError,
  serviceStatus,
} from "@obsidion/front-core"
import { useContactDirectory } from "../../../session/contacts"
import { useActionGuard } from "../../../features/actionGate"
import { useBalanceMovingPause } from "../../../features/backupPasskey/balanceMovingPause"
import { RequestDetailModal } from "../../../features/contacts/RequestDetailModal/RequestDetailModal"
import { declineRequestById } from "../../../features/contacts/requestActions"
import { useRemind, type RemindState } from "../../../features/contacts/useRemind"
import { BridgeInDetailModal } from "../../../features/deposit/BridgeInDetailModal/BridgeInDetailModal"
import { DepositExitModal } from "../../../features/deposit/DepositExitModal/DepositExitModal"
import { settlementDecimals, useDepositTokens } from "../../../features/sipa/loadDepositFacts"
import { useSavedL1Wallets } from "../../../session/savedL1Wallets"
import { profileBridge } from "../../../session/walletChains"
import { upgradeRunTitle } from "../../../features/migration/upgradeCopy"
import { upgradeRunAccount } from "../../../features/migration/upgradeRunAccount"
import { RegistrationDepositDetailModal } from "../../../features/onboarding/RegistrationDepositDetailModal/RegistrationDepositDetailModal"
import {
  useRegistrationDepositEntry,
  type RegistrationDepositEntry,
} from "../../../features/onboarding/useRegistrationDepositEntry"
import { LinkRecoverModal } from "../../../features/paylink/LinkRecoverModal"
import { usePaylinkDeps } from "../../../features/paylink/usePaylinkDeps"
import { CancelRequestLinkModal } from "../../../features/requests/CancelRequestLinkModal"
import { IncomingRequestDetailModal } from "../../../features/requests/IncomingRequestDetailModal"
import { SharePaylinkModal } from "../../../features/requests/SharePaylinkModal"
import { SavingsMoveDetailModal } from "../../../features/savings/SavingsMoveDetailModal"
import {
  savingsFinalizeDeployment,
  useSavingsAsset,
} from "../../../features/savings/savingsGateway"
import { useSavingsMoveTiming } from "../../../features/savings/savingsMoveTiming"
import { OldVersionRefundExitModal } from "../../../features/withdraw/OldVersionRefundExitModal"
import { SwapExitModal } from "../../../features/withdraw/SwapExitModal"
import { useWithdrawals } from "../../../features/withdraw/useWithdrawals"
import { WithdrawalExitModal } from "../../../features/withdraw/WithdrawalExitModal"
import { writeClipboard } from "../../hooks"
import { usdFigure } from "../../format"
import { PasskeysSheet } from "../../PasskeysSheet/PasskeysSheet"
import {
  DepositDetailModal,
  TagPurchaseModal,
} from "../../screens/DepositDetailModal/DepositDetailModal"
import { FreshWithdrawalDetailModal } from "../../screens/FreshWithdrawalDetailModal"
import { TxDetailModal } from "../../screens/TxDetailModal/TxDetailModal"
import { UpgradeBatchDetailModal } from "../../screens/UpgradeBatchDetailModal"
import { UpgradeRunDetailModal } from "../../screens/UpgradeRunDetailModal"
import { WithdrawalDetailModal, withdrawalHeroAmount } from "../../screens/WithdrawalDetailModal"
import {
  linkFragmentOf,
  txNoteFor,
  rowView,
  type RowItem,
  type ActivityRowView,
} from "../../screens/activityView"
import copy from "../ActivityRow.copy"
import { exitTitle } from "../ActivityRow/ActivityRow"
import { useFeed } from "../useFeed"
import { useSession } from "../../../session/session"

const hashOf = (item: RowItem) => (item.kind === "link" ? item.link.txHash : item.tx.txHash)

/**
 * The notification text a detail opened with. `staleOn` marks a failure alert: the row status that
 * outdates it, and a withdrawal outdates it in every phase but failed.
 */
export type DetailNotice = { text: string; staleOn?: "success" }

export function detailNoticeFor(
  notice: DetailNotice | undefined,
  row: Pick<ActivityRowView, "status"> | Pick<WithdrawalRecord, "phase">,
): string | undefined {
  const stale = "phase" in row ? row.phase !== "failed" : row.status === notice?.staleOn
  return notice?.staleOn && stale ? undefined : notice?.text
}

/** The one detail open. Held by id, so it follows its record as the trackers advance it. */
export type DetailTarget =
  | { kind: "tx"; item: RowItem }
  /** A record's localId or a fresh withdrawal's group id. */
  | { kind: "withdrawal"; id: string }
  | { kind: "upgradeBatch"; id: string }
  | { kind: "upgradeRun"; id: string }
  /** `address:index` picks that payment's row, an address alone the address's own. */
  | { kind: "deposit"; address: string }
  /** The payment that bought the tag, keyed as a deposit is. */
  | { kind: "tag"; address: string }
  | { kind: "savings"; id: string }
  | { kind: "requestLink"; id: string }
  | { kind: "cancelLink"; id: string }
  | { kind: "cancelRequest"; id: string }
  | { kind: "sentRequest"; id: string }
  | { kind: "incomingRequest"; id: string }
  /** A bridge-in from another chain, by origin hash. */
  | { kind: "bridgeIn"; id: string }

/**
 * The open exit sheet, held by value: a submitted exit advances its record out of the list under
 * it, and a sheet mid-submit must not go with it.
 */
type Exit =
  | ({ kind: "deposit"; record: SipaDeposit } & DepositOffer)
  /** `savings`: a move out's burn, finalized on the Savings deployment and its co-signer. */
  | { kind: "withdrawal"; record: WithdrawalRecord; savings?: boolean }
  | { kind: "swap"; record: WithdrawalRecord; reason: SwapExitReason }
  | { kind: "skyEscrow"; move: SavingsMoveRecord; burn: WithdrawalRecord }
  | { kind: "oldVersion"; record: OldVersionWithdrawal; refund: OldVersionRefund }
  | {
      kind: "linkRecovery"
      action: CreatorLinkAction
      fragment: string
      amount: string
      createdMs: number
      untilClaimableSec?: number
      refundableUntilSec?: number
    }

/** `backRun`: the upgrade whose sheet opened this detail, which Back returns to. */
type Sheet =
  | { detail: DetailTarget; notice?: DetailNotice; backRun?: string }
  | { exit: Exit }
  /** Where a stopped backup attempt's funding is recovered; closing it reopens the funding's sheet. */
  | { passkeys: DetailTarget }
  | null

export interface ActivityHost {
  feed: Feed
  open(target: DetailTarget): void
  depositExit(item: Extract<FeedItem, { kind: "deposit" }>): void
  withdrawalExit(record: WithdrawalRecord, exit: WithdrawalExit): void
  /** Process manually: the user sends a refund no relayer sent. */
  oldVersionExit(record: OldVersionWithdrawal, refund: OldVersionRefund): void
  linkRecovery(item: RowItem): void
  checkAgain(l2TxHash: string): void
  decline(id: string): void
  send(request: PaymentRequest): void
  remind(id: string): void
  remindState(id: string, remindedAt?: number): RemindState
  shareLink(url: string, text: string): void
  copyLink(id: string, url: string): void
  /** The page's network, which names the short-link host. */
  network: Network
  /** The profile's L1. */
  l1ChainId: number
  /** A bridge chain's name from the profile; empty for a chain it does not list. */
  chainName(chainId: number): string
  copiedLinkId: string | null
  registration?: RegistrationDepositEntry
  sharePrice?: bigint
  /** What values an upgrade run in its credited asset. */
  upgradePricing: UpgradePricing
  /** The decimals of the row a deposit of `token` settles on. */
  depositDecimals(token: string | undefined): number | undefined
  savingsEta(move: SavingsMoveRecord, burn?: WithdrawalRecord): SavingsMoveEta | undefined
}

// Kept across hot updates: a re-run module's new context would leave mounted rows outside its host.
const hot = import.meta.hot?.data as { hostContext?: Context<ActivityHost | null> } | undefined
const HostContext = hot?.hostContext ?? createContext<ActivityHost | null>(null)
if (hot) hot.hostContext = HostContext

export function useActivityHost(): ActivityHost {
  const host = useContext(HostContext)
  if (!host) throw new WalletError("invariant", "useActivityHost needs an ActivityDetailHost")
  return host
}

interface RouterState {
  openTxHash?: string
  /** A creator paylink row by its claim URL: the key a row has before its tx hash. */
  openPaylink?: string
  openWithdrawalId?: string
  openDepositAddress?: string
  openUpgradeRun?: string
  /** A request link's id: its share sheet. */
  openRequestId?: string
  /** A bridge-in's origin hash. */
  openBridgeIn?: string
  /** Full text of the notification that opened the detail. */
  notice?: string
  noticeStaleOn?: "success"
}

/** Share sheet where the browser has one; clipboard otherwise. */
function shareLink(url: string, text: string): void {
  const done = (err: unknown) => console.warn("[activity] share failed:", err)
  if (typeof navigator.share === "function") void navigator.share({ text, url }).catch(done)
  else void navigator.clipboard?.writeText(url).catch(done)
}

/**
 * Owns every detail and exit sheet a feed row opens, and the router deep links into them, so Home,
 * Activity and Requests share one path. Exit sheets outlive the row they came from.
 */
export function ActivityDetailHost({
  children,
  rows,
}: {
  children: ReactNode
  /** The activity rows the feed lists; Home's newest rows by default. */
  rows?: ReadonlyStore<RecordSet<Transaction>>
}) {
  const navigate = useNavigate()
  const guard = useActionGuard()
  const pauseForMove = useBalanceMovingPause()
  const session = useSession()
  const tokenAddress = useStore(session.mainToken)?.address
  const walletBuilt = useStore(session.wallet, serviceStatus) === "ready"
  const accountAddress = useStore(session.identity, (i) => i.value?.address)
  const { contacts } = useContactDirectory()
  const paylinkDeps = usePaylinkDeps()
  const { checkAgain } = useWithdrawals()
  const savingsAsset = useSavingsAsset() ?? undefined
  const savingsPosition = useStore(session.savingsHolding).position
  const sharePrice = savingsPosition?.sharePrice
  const settleTask = session.tasks.savingsSettle
  const depositTokens = useDepositTokens()
  const upgradePricing = useStore(session.upgradePricing)
  const timing = useSavingsMoveTiming()
  const { wallClock } = useSession().page
  const now = useStore(wallClock)
  const registrationDeposit = useRegistrationDepositEntry()
  const savedWallets = useSavedL1Wallets(Infinity)
  // A just-created paylink or a tapped notification lands here with its row key in router state;
  // open its detail once the row exists, then clear the state so a back or refresh doesn't reopen it.
  const {
    openTxHash,
    openPaylink,
    openWithdrawalId,
    openDepositAddress,
    openUpgradeRun,
    openRequestId,
    openBridgeIn,
    notice: routedText,
    noticeStaleOn: routedStale,
  } = (useLocation().state as RouterState | null) ?? {}
  const [sheet, setSheet] = useState<Sheet>(null)
  const detail = sheet && "detail" in sheet ? sheet.detail : undefined
  // A row outside the listed rows stays watched by its hash while its sheet is open.
  const shownHash = detail?.kind === "tx" ? hashOf(detail.item) : undefined
  const { feed, registrations, handle } = useFeed({
    registration: registrationDeposit
      ? { sipaAddress: registrationDeposit.sipaAddress, ts: registrationDeposit.ts }
      : undefined,
    chainTime: !!paylinkDeps,
    account: paylinkDeps && accountAddress,
    rows,
    txHash: openTxHash ?? shownHash,
  })
  const notice = sheet && "detail" in sheet ? sheet.notice : undefined
  const backRun = sheet && "detail" in sheet ? sheet.backRun : undefined
  const back = backRun ? () => setSheet({ detail: { kind: "upgradeRun", id: backRun } }) : undefined
  const exit = sheet && "exit" in sheet ? sheet.exit : undefined
  const close = useCallback(() => setSheet(null), [])
  const sweep = session.paylinkSweep
  const open = useCallback(
    (target: DetailTarget) => {
      // A sent link's sheet asks the chain whether it was claimed since the last sweep.
      if (target.kind === "tx" && target.item.kind === "link") sweep.recheck()
      setSheet({ detail: target })
    },
    [sweep],
  )
  const regs = { records: registrations, handle }

  // Desktop has no useful share sheet, so a sent link's row copies; the id keeps the "Copied!"
  // flash on the one row that was clicked.
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => () => clearTimeout(copiedTimer.current), [])
  const copyLink = useCallback(async (id: string, url: string) => {
    if (!(await writeClipboard(url))) return
    setCopiedLinkId(id)
    clearTimeout(copiedTimer.current)
    // eslint-disable-next-line local/timer-in-view -- debt
    copiedTimer.current = setTimeout(() => setCopiedLinkId(null), 2000)
  }, [])

  const { remind, stateOf } = useRemind(tokenAddress)
  const requests = feed.csv.requests
  const requestById = (id: string) => requests.find((r) => r.id === id)
  const send = (request: PaymentRequest) =>
    // ContactPayScreen prefills the amount, works for an unsaved requester tag, and the send's
    // meta pays the request.
    guard("send", () =>
      navigate(`/contacts/${encodeURIComponent(request.contactTag ?? "")}/send`, {
        state: {
          request: {
            id: request.id,
            tag: request.contactTag,
            amount: request.amount,
            note: request.note,
          },
        },
      }),
    )
  const decline = (id: string) =>
    void declineRequestById(session, id).catch((err) =>
      console.warn("[activity] decline failed:", err),
    )
  const savingsEta = (move: SavingsMoveRecord, burn?: WithdrawalRecord) =>
    timing ? savingsMoveEta(move, burn, timing, now) : undefined

  const exitFor = (record: WithdrawalRecord, offer: WithdrawalExit): Exit =>
    offer.kind === "finalize"
      ? { kind: "withdrawal", record }
      : { kind: "swap", record, reason: offer.reason }
  const depositExit = (record: SipaDeposit, processing?: SipaProcessingState) => {
    const offer = depositDetailOffer(record, {
      processing,
      registration: registrationFor(regs, record.sipaAddress),
      now,
    })
    if (!offer) return
    setSheet({ exit: { kind: "deposit", record, ...offer } })
  }

  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    const notice = routedText ? { text: routedText, staleOn: routedStale } : undefined
    const settle = (target: DetailTarget, withNotice: DetailNotice | undefined = notice) => {
      setSheet({ detail: target, notice: withNotice })
      navigate(".", { replace: true, state: null })
    }
    if (openTxHash || openPaylink) {
      const item = feed.items.find(
        (i): i is RowItem =>
          (i.kind === "tx" || i.kind === "link") &&
          (openTxHash
            ? hashOf(i) === openTxHash
            : i.kind === "link" && !!openPaylink && i.link.paylink === openPaylink),
      )
      if (item) return settle({ kind: "tx", item })
    }
    const hit = findBridgeItem(feed.bridge, { openWithdrawalId, openDepositAddress, openTxHash })
    if (hit) return settle(bridgeDetailTarget(hit))
    if (openUpgradeRun && feed.upgradeRuns.some((run) => run.run === openUpgradeRun))
      return settle(
        { kind: "upgradeRun", id: openUpgradeRun },
        routedText ? { text: routedText } : undefined,
      )
    if (openRequestId && feed.csv.requests.some((r) => r.id === openRequestId))
      return settle({ kind: "requestLink", id: openRequestId })
    if (openBridgeIn) settle({ kind: "bridgeIn", id: openBridgeIn })
  }, [
    openTxHash,
    openPaylink,
    openWithdrawalId,
    openDepositAddress,
    openUpgradeRun,
    openRequestId,
    openBridgeIn,
    routedText,
    routedStale,
    feed,
    navigate,
  ])

  // The savings ledger's figure may be off: the console says why, once per change.
  const { ledger } = feed.savings
  const position = savingsPosition
  const ledgerKey =
    ledger && position
      ? `${ledger.shares}/${position.shares}/${ledger.excluded
          .map((e) => e.withdrawalLocalId)
          .join(",")}`
      : undefined
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (!ledger || !position || !ledgerKey) return
    if (ledger.shares !== position.shares || ledger.excluded.length > 0)
      console.info(
        `[savings] earnings: the counted moves add up to ${ledger.shares} shares, ${position.shares} held` +
          (ledger.excluded.length
            ? `; left out: ${ledger.excluded
                .map(
                  (e) =>
                    `${e.withdrawalLocalId} (${e.reason}${
                      e.backfilling ? ", awaiting its escrow run's receipt" : ""
                    })`,
                )
                .join(", ")}`
            : ""),
      )
    // Keyed on what the line would say, so it prints once per change.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debt
  }, [ledgerKey])

  const host: ActivityHost = {
    feed,
    open,
    depositExit: (item) => depositExit(item.record, item.processing),
    withdrawalExit: (record, offer) => setSheet({ exit: exitFor(record, offer) }),
    oldVersionExit: (record, refund) => setSheet({ exit: { kind: "oldVersion", record, refund } }),
    // Straight to the confirm sheet: the row's own status put the button there. A claim that beat
    // it spends the same nullifier, and that revert has its own copy.
    linkRecovery(item) {
      const row = rowView(item)
      const fragment = row.paylink ? linkFragmentOf(row.paylink) : null
      const { creatorAction: action, paylinkRow } = row
      if (!action || !fragment || !paylinkRow) return
      pauseForMove(() =>
        setSheet({
          exit: {
            kind: "linkRecovery",
            action,
            fragment,
            amount: usdFigure(formatUnits(item.amount.atomic, item.amount.decimals)),
            createdMs: row.timestampMs,
            untilClaimableSec: paylinkRow.untilClaimable,
            refundableUntilSec: paylinkRow.refundableUntil,
          },
        }),
      )
    },
    checkAgain: (hash) => void checkAgain(hash),
    decline,
    send,
    remind,
    remindState: stateOf,
    shareLink,
    copyLink: (id, url) => void copyLink(id, url),
    network: session.network,
    l1ChainId: session.page.config.l1ChainId,
    chainName: (chainId) =>
      profileBridge(session.page.config)?.chains.find((c) => c.chainId === chainId)?.name ?? "",
    copiedLinkId,
    registration: registrationDeposit ?? undefined,
    sharePrice,
    upgradePricing,
    depositDecimals: (token) => settlementDecimals(depositTokens, token),
    savingsEta,
  }

  const withdrawalRecord = (localId: string) =>
    feed.bridge.flatMap((i) =>
      i.kind === "bridge.withdrawal" && i.record.localId === localId ? [i.record] : [],
    )[0]
  const depositItem = (id: string) => depositDetailItem(feed.bridge, id)
  const burns = feed.savingsCsv.burns
  const moves = feed.savingsCsv.moves

  const modal = (): ReactNode => {
    if (exit) return exitModal(exit)
    if (sheet && "passkeys" in sheet) {
      const from = sheet.passkeys
      return <PasskeysSheet onClose={() => open(from)} onLeave={close} />
    }
    if (!detail) return null
    switch (detail.kind) {
      case "tx": {
        // The sheet follows its row as it settles: its id moves from operation id to tx hash, and
        // a creator link's URL gains the tx; the link's record id is what stays put.
        const linkId = (i: RowItem) => (i.kind === "link" ? i.link.id : undefined)
        const live =
          feed.items.find(
            (i): i is RowItem =>
              (i.kind === "tx" || i.kind === "link") &&
              (i.id === detail.item.id ||
                (!!linkId(detail.item) && linkId(i) === linkId(detail.item))),
          ) ?? detail.item
        const row = rowView(live)
        return (
          <TxDetailModal
            row={row}
            note={txNoteFor(row, [...requests])}
            notice={detailNoticeFor(notice, row)}
            onClose={close}
          />
        )
      }
      case "withdrawal": {
        const group = feed.groups.find((g) => g.groupId === detail.id)
        if (group)
          return (
            <FreshWithdrawalDetailModal
              group={group}
              notice={detailNoticeFor(notice, { phase: worstWithdrawalPhase(group) })}
              onViewLeg={(record) => open({ kind: "withdrawal", id: record.localId })}
              onClose={close}
            />
          )
        const record = withdrawalRecord(detail.id)
        if (!record) return null
        const hash = record.l2TxHash
        const offer = withdrawalExit(record, now)
        // Only the feed item carries these: they read records the bridge list hides.
        const item = feed.items.flatMap((i) =>
          i.kind === "withdrawal" && i.id === record.localId ? [i] : [],
        )[0]
        const recovery = item?.recovery
        const cost = item?.cost
        const intent = item?.intent
        return (
          <WithdrawalDetailModal
            record={record}
            intent={intent}
            amount={withdrawalHeroAmount(record, cost)}
            cost={cost}
            added={item?.added}
            recovery={recovery}
            onOpenPasskeys={
              recovery && recovery.state !== "recovered"
                ? () => setSheet({ passkeys: detail })
                : undefined
            }
            notice={detailNoticeFor(notice, record)}
            onClose={close}
            onCheckAgain={
              isWithdrawalDelayed(record, now) && hash
                ? () => {
                    close()
                    void checkAgain(hash)
                  }
                : undefined
            }
            exit={
              offer
                ? {
                    title: exitTitle(offer),
                    onStart: () => setSheet({ exit: exitFor(record, offer) }),
                  }
                : undefined
            }
          />
        )
      }
      case "upgradeBatch": {
        const batch = feed.bridge.flatMap((i) =>
          i.kind === "upgrade.batch" && `${i.batch.run}/${i.batch.id}` === detail.id
            ? [i.batch]
            : [],
        )[0]
        return batch ? (
          <UpgradeBatchDetailModal batch={batch} onBack={back} onClose={close} />
        ) : null
      }
      case "upgradeRun": {
        const run = feed.upgradeRuns.find((r) => r.run === detail.id)
        return run ? (
          <UpgradeRunDetailModal
            run={run}
            title={upgradeRunTitle[upgradeRunAccount(session.page.config, run.run)]}
            pricing={upgradePricing}
            onViewDeposit={(deposit) =>
              setSheet({
                detail: { kind: "deposit", address: deposit.sipaAddress },
                backRun: run.run,
              })
            }
            onViewBatch={(batch) =>
              setSheet({
                detail: { kind: "upgradeBatch", id: `${batch.run}/${batch.id}` },
                backRun: run.run,
              })
            }
            onClose={close}
          />
        ) : null
      }
      case "deposit": {
        const item = depositItem(detail.address)
        if (!item) return null
        const { record, processing } = item
        const offer = depositDetailOffer(record, {
          processing,
          registration: registrationFor(regs, record.sipaAddress),
          now,
        })
        const bridgeIn = feed.items.flatMap((i) =>
          i.kind === "deposit" && i.record.sipaAddress === record.sipaAddress && i.bridgeIn
            ? [i.bridgeIn]
            : [],
        )[0]
        const funder =
          bridgeIn &&
          savedWallets.find((w) => w.address.toLowerCase() === bridgeIn.depositor.toLowerCase())
        return (
          <DepositDetailModal
            record={record}
            bridgeIn={
              bridgeIn && {
                record: bridgeIn,
                walletName: funder?.name,
                chainName: profileBridge(session.page.config)?.chains.find(
                  (c) => c.chainId === bridgeIn.originChainId,
                )?.name,
              }
            }
            registrationTag={registrationTagForDeposit(regs, record)}
            exit={
              offer
                ? {
                    title: offer.action === "sweep" ? copy.action.sweep : copy.action.recover,
                    sweep: offer.canSweep,
                    onStart: () => depositExit(record, processing),
                  }
                : undefined
            }
            notice={notice?.text}
            onBack={back}
            onClose={close}
          />
        )
      }
      case "tag": {
        const record = depositItem(detail.address)?.record
        const tag = record && registrationTagForDeposit(regs, record)
        return record && tag ? (
          <TagPurchaseModal
            record={record}
            tag={tag}
            price={formatUnits(tagPriceOf(record), DEFAULT_DECIMALS)}
            onClose={close}
          />
        ) : null
      }
      case "savings": {
        const burn = burns.get(detail.id)
        const move =
          moves.find((m) => m.withdrawalLocalId === detail.id) ??
          (() => {
            const derived = burn && savingsMoveOfWithdrawal(burn)
            return derived ? { ...derived, startTime: burn.startTime } : undefined
          })()
        if (!move) return null
        const offer = burn && savingsMoveExitOffer(move, burn, now)
        return (
          <SavingsMoveDetailModal
            move={move}
            burn={burn}
            sharePrice={sharePrice}
            eta={savingsEta(move, burn)}
            onCheckAgain={
              savingsAsset && settleTask ? () => void session.wake(settleTask) : undefined
            }
            exit={
              burn && offer
                ? {
                    title: offer === "finalize" ? copy.action.finalize : copy.action.runMove,
                    onStart: () =>
                      setSheet({
                        exit:
                          offer === "finalize"
                            ? {
                                kind: "withdrawal",
                                record: burn,
                                savings: move.direction === "out",
                              }
                            : { kind: "skyEscrow", move, burn },
                      }),
                  }
                : undefined
            }
            onWithdraw={() => navigate("/withdraw")}
            onClose={close}
          />
        )
      }
      case "requestLink": {
        const request = requestById(detail.id)
        return request ? (
          <SharePaylinkModal
            request={request}
            requesterTag={handle ?? ""}
            payer={payerForPaidLink(request, feed.csv.transactions, contacts)}
            onCancel={() => open({ kind: "cancelLink", id: request.id })}
            onClose={close}
          />
        ) : null
      }
      case "bridgeIn":
        return <BridgeInDetailModal id={detail.id} onClose={close} />
      case "cancelLink":
        return <CancelRequestLinkModal requestId={detail.id} onClose={close} />
      case "cancelRequest":
        return <RequestDetailModal requestId={detail.id} initialStep="confirm" onClose={close} />
      case "sentRequest":
        return (
          <RequestDetailModal
            requestId={detail.id}
            remind={stateOf(detail.id, requestById(detail.id)?.remindedAt)}
            onRemind={() => remind(detail.id)}
            onClose={close}
          />
        )
      case "incomingRequest": {
        // Closes when its row is hidden, so it offers no Send.
        const shown = feed.items.some(
          (i) => i.kind === "request" && i.role === "incoming" && i.id === detail.id,
        )
        const request = requestById(detail.id)
        return shown && request ? (
          <IncomingRequestDetailModal
            request={request}
            onClose={close}
            onDecline={() => {
              close()
              decline(request.id)
            }}
            onSend={() => {
              close()
              send(request)
            }}
          />
        ) : null
      }
    }
  }

  const exitModal = (sheet: Exit): ReactNode => {
    switch (sheet.kind) {
      case "deposit":
        return (
          <DepositExitModal
            record={sheet.record}
            reason={sheet.reason}
            canSweep={sheet.canSweep}
            sweepable={sheet.sweepable}
            onClose={close}
          />
        )
      case "linkRecovery":
        return (
          <LinkRecoverModal
            action={sheet.action}
            deps={paylinkDeps}
            fragment={sheet.fragment}
            amount={sheet.amount}
            createdMs={sheet.createdMs}
            untilClaimableSec={sheet.untilClaimableSec}
            refundableUntilSec={sheet.refundableUntilSec}
            onClose={close}
          />
        )
      case "withdrawal":
        return (
          <WithdrawalExitModal
            record={sheet.record}
            deployment={
              sheet.savings && walletBuilt
                ? () => savingsFinalizeDeployment(session, sheet.record)
                : undefined
            }
            onClose={close}
          />
        )
      case "skyEscrow":
        return (
          <SwapExitModal
            record={burns.get(sheet.burn.localId) ?? sheet.burn}
            move={
              moves.find((m) => m.withdrawalLocalId === sheet.move.withdrawalLocalId) ?? sheet.move
            }
            reason="stuck"
            pace={session.page.pace}
            onClose={close}
          />
        )
      case "oldVersion":
        return (
          <OldVersionRefundExitModal record={sheet.record} refund={sheet.refund} onClose={close} />
        )
      case "swap":
        return (
          <SwapExitModal
            record={burns.get(sheet.record.localId) ?? sheet.record}
            reason={sheet.reason}
            pace={session.page.pace}
            onClose={close}
          />
        )
    }
  }

  // An incoming request's sheet stays closed if its row comes back.
  const incomingGone =
    detail?.kind === "incomingRequest" &&
    !feed.items.some((i) => i.kind === "request" && i.role === "incoming" && i.id === detail.id)
  if (incomingGone) close()

  return (
    <HostContext.Provider value={host}>
      {children}
      {registrationDeposit?.detail && (
        <RegistrationDepositDetailModal {...registrationDeposit.detail} />
      )}
      {modal()}
    </HostContext.Provider>
  )
}
