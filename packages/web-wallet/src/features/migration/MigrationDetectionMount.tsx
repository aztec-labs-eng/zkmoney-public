import { reloadPage } from "../../platform/storage/walletStorage"
import { Modal } from "../../ui/Modal"
/**
 * Boot-time migration detection: derives where the signed-in account's upgrade stands from what it
 * still holds on a retired oxide deployment (`probeAccountResiduals`), its saved runs, the sponsored
 * rail's readiness and the registration check, and publishes it (`setUpgradeStatus`) for Home's
 * banner and the bell. The dialog opens only on a request. Mounted inside WalletGate (post-PXE,
 * post-unlock) because the probes need the wallet + account.
 *
 * Paylinks still inside their claim window cannot be refunded yet; `probeAccountResiduals` hands
 * them to `PendingPaylinkMigrationService`, which waits out the window and mints a reclaim
 * notification once chain time passes it.
 *
 * A failed check never breaks the wallet's boot: the state reads `failed`, and trying again checks
 * once more. On an intra-rollup migration "Upgrade now" runs its exit half
 * (`runIntraRollupMigration`) under `OperationHandOff`: the modal shows the working beat, labeled
 * "Publishing your new address" while the arrival publishes, until the passkey signs the burn; then
 * it closes into the bell and the exit and the arrival ride the withdrawal and deposit rails.
 * Residuals with nothing to do right now become a notification.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  AppNotificationStore,
  BalanceStorage,
  bootPriority,
  checkSpentViaPaylinkService,
  useBalance,
  useAccountContext,
  useAssetContext,
  useAztecContext,
  useContractServiceContext,
  retryableStop,
  runMetadataMigration,
  type MetadataMigrationRecord,
  type MetadataMigrationSummary,
} from "@obsidion/front-core"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  PaylinkService,
  type MetadataMigrationService,
  type MigrationSourceQuote,
} from "@obsidion/sdk"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  ConfirmationSheetDetailRow,
  GradientText,
  PrimaryGradientButton,
  TopNavIconButton,
} from "@obsidion/web-ds"
import { formatUnits, parseUnits } from "viem"
import { fetchLiveProfilePortal, getConfig } from "../../config/env"
import { showReportableError } from "../../errors/errorModal"
import { usd } from "../../ui/format"
import { TipRow } from "../../ui/TipRow"
import questionMark from "../../assets/migration/question-mark-circle.svg"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import type { HistoricResidualSummary } from "./historicResiduals"
import { probeAccountResiduals, reconcilePendingPaylinks } from "./probeAccountResiduals"
import { runIntraRollupMigration } from "./runIntraRollupMigration"
import { migrationSummary } from "./migrationArrival"
import { loadMigrationFee, migrationAmounts } from "./migrationFee"
import {
  isFlowCancelled,
  runBackgroundOperation,
  runOperation,
  useBusyLabel,
  useLeavingLosesTransaction,
} from "../operations/operations"
import { runUserFlow, useUserFlowActive } from "../provingGate"
import { upgradeVerdict } from "../actionGate"
import { OperationHandOff } from "../operations/OperationHandOff"
import { PayWorking } from "../contacts/PayWorking"
import { UpgradeIntro } from "./UpgradeIntro"
import {
  actionUpgradeTitle,
  checkingLead,
  continueLabel,
  depositToUpgradeCopy,
  finishingCopy,
  followingLead,
  keepTabOpen,
  offerCopy,
  upgradeFeeLabel,
  upgradeFeeTip,
  upgradePhaseLabel,
  upgradeStopText,
} from "./upgradeCopy"
import "./migration.css"
import { createWebMetadataMigration, webMetadataMigrationKey } from "./createWebMetadataMigration"
import {
  migrationDialogReason,
  setUpgradeStatus,
  useMigrationDialogRequest,
  type MigrationDialogReason,
  type UpgradeState,
} from "./migrationDialog"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { DepositScreen } from "../deposit/DepositScreen"
import type { DepositTarget, ShownAddress } from "../deposit/depositTarget"
import { formatDepositDue } from "../onboarding/steps/DepositTermsRows"
import {
  useSponsoredRailPending,
  useSponsoredRailReadFailed,
} from "../onboarding/sponsoredRailReadiness"
import { getPendingStore } from "../onboarding/webRegistration"
import {
  markOldHoldingsRead,
  oldHoldingsRead,
  oldVersionScope,
  releaseOldHoldingsWait,
  useOldVersionHoldings,
} from "./oldVersionBalance"
import {
  acquireUpgradeLock,
  checkUpgradeLock,
  releaseUpgradeLock,
  useUpgradeLock,
} from "./upgradeLock"

export const PROFILE_REPOINT_POLL_MS = 5 * 60_000
/** How long a failed read or release of the upgrade lock waits before it is tried again. */
const LOCK_RETRY_MS = 12_000

const RESIDUALS_NOTIFICATION_ID = "migration:residuals"
const RUN_NOTIFICATION_ID = "migration:run"

/** The upgrade stopped for the user: the dialog and the bell say why. */
class UpgradeStopped extends Error {}

function useProfileRepoint(): boolean {
  const booted = getConfig().oxideProfile.portal.toLowerCase()
  const { data } = useQuery({
    queryKey: ["profile-portal", booted],
    queryFn: () => fetchLiveProfilePortal(),
    initialData: booted,
    staleTime: PROFILE_REPOINT_POLL_MS,
    refetchInterval: PROFILE_REPOINT_POLL_MS,
    refetchOnWindowFocus: true,
    retry: false,
  })
  return data.toLowerCase() !== booted
}

function lockedUntilLabel(rows: HistoricResidualSummary["lockedPaylinks"]): string {
  const latest = Math.max(...rows.map((r) => r.untilClaimable ?? 0))
  return new Date(latest * 1000).toLocaleDateString()
}

export function MigrationDetectionMount() {
  const { obsidionWallet } = useAztecContext()
  const { obsidionAccount } = useAccountContext()
  const { tokenService, loadAssets } = useAssetContext()
  const { contractService } = useContractServiceContext()
  const [residuals, setResiduals] = useState<HistoricResidualSummary[]>([])
  const [historic, setHistoric] = useState<OxideEnvTuple[]>()
  const [current, setCurrent] = useState<OxideEnvTuple | null>(null)
  const [pendingWithdrawals, setPendingWithdrawals] = useState(0)
  const [migrating, setMigrating] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [scanRevision, setScanRevision] = useState(0)
  // The last probe ran to a result: a locked wallet or a manifest with no history reads nothing.
  const [scanned, setScanned] = useState(false)
  // The boot probe answered, with or without history.
  const [probed, setProbed] = useState(false)
  // A check of the old versions failed; `checks` runs them all again.
  const [checkFailed, setCheckFailed] = useState(false)
  const [checks, setChecks] = useState(0)
  const [chainTimeUnknown, setChainTimeUnknown] = useState(false)
  // The dialog opens only on request; with nothing to move or register it lists what is left.
  const [requested, setRequested] = useState(false)
  // The residuals row asked: the dialog lists what is left unless it offers the upgrade.
  const [residualsAsked, setResidualsAsked] = useState(false)
  // An action asked: the sheet is titled for it, and a held one starts once no upgrade is needed.
  const [actionAsked, setActionAsked] = useState<Exclude<MigrationDialogReason, string>>()
  const repointed = useProfileRepoint()
  const [repointDismissed, setRepointDismissed] = useState(false)
  // Its Reload would end a running proof, so the prompt waits for the transaction to settle.
  const losesTransaction = useLeavingLosesTransaction()
  const busy = useUserFlowActive()
  const busyLabel = useBusyLabel()
  const [resumeSource, setResumeSource] = useState<OxideEnvTuple | null>(null)
  const [metadataRecord, setMetadataRecord] = useState<MetadataMigrationRecord | null>(null)
  // No unfinished migration record was found for this account.
  const [recordChecked, setRecordChecked] = useState(false)
  // What the registration check answered, for the inventory and session it was asked under.
  const [registrationAnswer, setRegistrationAnswer] = useState<{ ask: object; needed: boolean }>()
  const railPending = useSponsoredRailPending()
  const railReadFailed = useSponsoredRailReadFailed()
  // A failed readiness read is no answer: the account is neither finishing nor settled on it.
  const railUnread = railPending === undefined || railReadFailed
  // This browser registered the account on this version, so it is not finishing an upgrade.
  const [registeredHere, setRegisteredHere] = useState<boolean>()
  const [funding, setFunding] = useState<Awaited<ReturnType<MetadataMigrationService["funding"]>>>()
  // What a deposit that funds the upgrade takes, before there is a run to read it from.
  const [terms, setTerms] =
    useState<Awaited<ReturnType<MetadataMigrationService["fundingTerms"]>>>()
  // The deposit screen funds the upgrade in place of the dialog.
  const [depositing, setDepositing] = useState(false)
  // Followers of each arriving upgrade's source: its funds already move, so it is not offered.
  const [following, setFollowing] = useState<ReadonlyMap<string, number>>(new Map())
  const migrationRun = useRef<AbortController | undefined>(undefined)
  // Scans that follow a run; quotes wait for the last one.
  const rescans = useRef(0)
  // The user's start has approved and proven everything: the dialog hands the run to the bell.
  const [prepared, setPrepared] = useState(false)
  const [handedOff, setHandedOff] = useState(false)
  // The run itself, not the scan that follows it.
  const [runActive, setRunActive] = useState(false)
  useEffect(() => () => migrationRun.current?.abort(), [obsidionWallet, obsidionAccount])
  useEffect(() => {
    if (!obsidionAccount) return
    const account = obsidionAccount.getAddress().toString()
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () =>
      checkUpgradeLock(account).catch((error) => {
        console.warn("[migration] upgrade lock check failed:", error)
        if (live) timer = setTimeout(check, LOCK_RETRY_MS)
      })
    void check()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [obsidionAccount])
  const { walletBalance, balanceKnown } = useBalance()
  const oldHoldings = useOldVersionHoldings()

  const checkSpent = useMemo(
    () =>
      obsidionWallet && obsidionAccount && tokenService && contractService
        ? checkSpentViaPaylinkService(
            new PaylinkService(obsidionWallet, obsidionAccount, tokenService, contractService),
          )
        : undefined,
    [obsidionWallet, obsidionAccount, tokenService, contractService],
  )

  // Only the latest scan answers for the inventory.
  const scans = useRef(0)
  const refresh = useCallback(async () => {
    if (!obsidionWallet || !obsidionAccount) return
    const scan = ++scans.current
    setRefreshing(true)
    let found: Awaited<ReturnType<typeof probeAccountResiduals>>
    try {
      found = await probeAccountResiduals(obsidionWallet, obsidionAccount)
    } catch (error) {
      console.warn("[migration] re-probe failed:", error)
      return
    } finally {
      if (scan === scans.current) setRefreshing(false)
    }
    if (scan !== scans.current) return
    setScanRevision((n) => n + 1)
    setScanned(!!found)
    if (!found) {
      setResiduals([])
      return
    }
    setCurrent(found.current)
    setResiduals(found.residuals)
    setPendingWithdrawals(found.pendingWithdrawals)
    setChainTimeUnknown(!!found.chainTimeUnknown)
  }, [obsidionWallet, obsidionAccount])

  useEffect(() => {
    if (!obsidionWallet || !obsidionAccount) return
    let cancelled = false
    // A retry's probe holds every Try again, as a re-probe does.
    setRefreshing(true)
    void (async () => {
      await bootPriority.whenReady("migrationProbe")
      if (cancelled) return
      const found = await probeAccountResiduals(obsidionWallet, obsidionAccount)
      if (cancelled) return
      setScanRevision((n) => n + 1)
      setScanned(!!found)
      setProbed(true)
      if (!found) return
      setCurrent(found.current)
      setResiduals(found.residuals)
      setPendingWithdrawals(found.pendingWithdrawals)
      setChainTimeUnknown(!!found.chainTimeUnknown)
      setHistoric(found.historic ?? [])
    })()
      .catch((error) => {
        console.warn("[migration] boot probe failed:", error)
        if (!cancelled) setCheckFailed(true)
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false)
      })
    return () => {
      cancelled = true
    }
  }, [obsidionWallet, obsidionAccount, checks])

  // Follows a source's saved run to its end, one follower per source; the dialog's start hands its
  // run here once what is left needs no user.
  const followRun = useRef<(source: OxideEnvTuple, promptless: boolean) => void>(() => {})
  useEffect(() => {
    if (!obsidionWallet || !obsidionAccount || !current || !historic) return
    let cancelled = false
    const observing = new AbortController()
    const followed = new Set<string>()
    // An arriving run finishes from chain evidence with no click, no prompt and no send. A
    // `promptless` one also sends what needs no prompt, one step at a time in the background, and
    // is the run the dialog shows. Either asks for the dialog only if it stops for the user.
    const follow = async (source: OxideEnvTuple, promptless: boolean) => {
      if (!contractService || !tokenService) return
      const portal = source.portal.toLowerCase()
      if (followed.has(portal)) return
      followed.add(portal)
      const count = (by: number) => (now: ReadonlyMap<string, number>) =>
        new Map(now).set(portal, (now.get(portal) ?? 0) + by)
      setFollowing(count(1))
      try {
        const session = await createWebMetadataMigration({
          wallet: obsidionWallet,
          account: obsidionAccount,
          contractService,
          toTokenService: tokenService,
          historic: source,
          current,
        })
        const unsubscribe = promptless
          ? session.controller.subscribe(() => {
              if (observing.signal.aborted) return
              setResumeSource(source)
              setMetadataRecord(session.controller.getSnapshot())
            })
          : () => {}
        try {
          await session.controller.load()
          const record = await runMetadataMigration(
            session.controller,
            promptless
              ? {
                  signal: observing.signal,
                  promptless: true,
                  exclusive: (step) =>
                    runBackgroundOperation(
                      {
                        operationId: `migration_${crypto.randomUUID()}`,
                        flow: "migration",
                        summary: "Upgrade",
                      },
                      (op) => step(op.operationId),
                    ),
                  onProgress: fundingProgress(session, observing.signal, setFunding),
                }
              : { signal: observing.signal, observeOnly: true },
          )
          if (observing.signal.aborted || !record) return
          if (record.phase === "done") {
            if (promptless) setResumeSource(null)
            await loadAssets()
            await refresh()
            return
          }
          setResumeSource(source)
          setMetadataRecord(record)
        } finally {
          unsubscribe()
        }
      } finally {
        followed.delete(portal)
        setFollowing(count(-1))
      }
    }
    followRun.current = (source, promptless) =>
      void follow(source, promptless).catch((error) => {
        console.warn("[migration] upgrade follow failed:", error)
        if (cancelled) return
        // Not known to be paused: the failed check's retry reads the run again.
        if (promptless) {
          setResumeSource(null)
          setMetadataRecord(null)
        }
        setCheckFailed(true)
      })
    // With nothing on an old version to move, the run's source is this version: the user funds it.
    const isCurrent = (source: OxideEnvTuple) =>
      source.portal.toLowerCase() === current.portal.toLowerCase()
    void (async () => {
      for (const source of [...historic, current]) {
        const raw = await webStorage.getItem(
          webMetadataMigrationKey(current, source, obsidionAccount),
        )
        if (cancelled) return
        if (!raw) continue
        const record = JSON.parse(raw) as MetadataMigrationRecord
        if (record.phase === "done") continue
        if (record.phase === "arriving" || (isCurrent(source) && unattended(record))) {
          followRun.current(source, record.phase !== "arriving")
          continue
        }
        setResumeSource(source)
        setMetadataRecord(record)
        return
      }
      setRecordChecked(true)
    })().catch((error) => {
      console.warn("[migration] metadata probe failed:", error)
      if (!cancelled) setCheckFailed(true)
    })
    return () => {
      cancelled = true
      observing.abort()
      followRun.current = () => {}
    }
  }, [obsidionWallet, obsidionAccount, current, historic, contractService, tokenService])

  useEffect(() => {
    if (!obsidionWallet) return
    void reconcilePendingPaylinks(obsidionWallet, checkSpent).catch((error) =>
      console.warn("[migration] paylink reconcile failed:", error),
    )
  }, [obsidionWallet, checkSpent, scanRevision])

  // A destination with the metadata-update SIPA settles every source through it.
  const metadataFlow = !!current?.updateMetadataSIPAImplementation
  // Through the metadata flow a source moves what its batches afford, quoted from chain. A quote
  // belongs to the scan it was taken for; a newer scan's sources are unquoted until it lands.
  const [checked, setChecked] = useState<{
    residuals: HistoricResidualSummary[]
    quotes: ReadonlyMap<string, MigrationSourceQuote>
    failed: boolean
  }>()
  // Past the saved run's first refund, its source's rest pays only ordinary deposit fees.
  const settledPortal =
    resumeSource && firstRefundSettled(metadataRecord) ? resumeSource.portal.toLowerCase() : ""
  // The last scan left an old version's holdings unread.
  const [holdingsUnread, setHoldingsUnread] = useState(false)
  useEffect(() => {
    // A running migration moves the funds it would quote; it quotes them again once it stops.
    if (migrating) return
    if (
      !scanned ||
      !historic ||
      !metadataFlow ||
      !obsidionWallet ||
      !obsidionAccount ||
      !current ||
      !tokenService ||
      !contractService
    ) {
      setChecked(undefined)
      return
    }
    let cancelled = false
    void (async () => {
      const next = new Map<string, MigrationSourceQuote>()
      let failed = false
      let unread = false
      for (const tuple of historic) {
        const portal = tuple.portal.toLowerCase()
        const r = residuals.find((x) => x.tuple.portal.toLowerCase() === portal)
        const quoting = !!r && holdsFunds(r)
        if (r && liveSource(r)) continue
        if (!quoting && !(r && holdsBalance(r))) {
          // Only a complete scan says a source holds nothing.
          if (r?.incomplete) {
            unread = true
            continue
          }
          await BalanceStorage.get(webStorage)
            .updateBalance(
              oldVersionScope(tuple.portal, obsidionAccount.getAddress().toString()),
              tuple.l2Token,
              0n,
              undefined,
              { strict: true },
            )
            .catch((error) => {
              unread = true
              console.warn("[migration] holdings write failed:", error)
            })
          continue
        }
        try {
          const session = await createWebMetadataMigration({
            wallet: obsidionWallet,
            account: obsidionAccount,
            contractService,
            toTokenService: tokenService,
            historic: tuple,
            current,
          })
          if (!(await session.holdings())) unread = true
          if (quoting)
            next.set(
              portal,
              await session.service.quote({ firstBatchSettled: portal === settledPortal }),
            )
        } catch (error) {
          unread = true
          if (quoting) failed = true
          console.warn(`[migration] old version read failed for ${tuple.portal}:`, error)
        }
      }
      if (cancelled) return
      setChecked({ residuals, quotes: next, failed })
      setHoldingsUnread(unread)
      if (!unread) markOldHoldingsRead(obsidionAccount.getAddress().toString())
    })()
    return () => {
      cancelled = true
    }
  }, [
    residuals,
    historic,
    scanned,
    metadataFlow,
    settledPortal,
    migrating,
    obsidionWallet,
    obsidionAccount,
    current,
    tokenService,
    contractService,
  ])
  const quoted = checked?.residuals === residuals ? checked : undefined
  const quoteOf = (r: HistoricResidualSummary) =>
    metadataFlow ? quoted?.quotes.get(r.tuple.portal.toLowerCase()) : undefined
  // Without the metadata flow a live balance moves whole, and nothing moves a frozen source. With it,
  // only a frozen source moves: the old portal is frozen before this version reaches users.
  const followed = (r: HistoricResidualSummary) =>
    (following.get(r.tuple.portal.toLowerCase()) ?? 0) > 0
  const movableState = (r: HistoricResidualSummary) =>
    !metadataFlow
      ? !r.frozen && r.balance > 0n
      : holdsFunds(r) && r.frozen && !followed(r)
        ? quoteOf(r) && quoteOf(r)!.movable > 0n
        : false
  const migratable = residuals.find((r) => movableState(r) === true)
  // A source still being checked is neither offered nor written off yet.
  const checkingMovable = residuals.some((r) => movableState(r) === undefined)
  const scanFailed = residuals.some((r) => r.incomplete) || !!quoted?.failed
  // Only a complete inventory with nothing to move or resume falls through to the registration
  // update, so an unreadable source never reads as an empty one.
  const nothingToMove =
    scanned && recordChecked && !scanFailed && !checkingMovable && !migratable && !resumeSource
  // The registration check this inventory asks for; none when there is nothing to move.
  const registrationAsk = useMemo(
    () =>
      nothingToMove &&
      metadataFlow &&
      obsidionWallet &&
      obsidionAccount &&
      current &&
      tokenService &&
      contractService
        ? { obsidionWallet, obsidionAccount, current, tokenService, contractService }
        : undefined,
    [
      nothingToMove,
      metadataFlow,
      obsidionWallet,
      obsidionAccount,
      current,
      tokenService,
      contractService,
    ],
  )
  // Nothing on a retired version can move, and the account still has to update its registration.
  // Undefined until this inventory's own check answers, so an earlier answer never stands in.
  const registrationOnly =
    nothingToMove && metadataFlow
      ? registrationAnswer?.ask === registrationAsk
        ? registrationAnswer?.needed
        : undefined
      : false
  useEffect(() => {
    if (!registrationAsk) return
    const ask = registrationAsk
    let cancelled = false
    void (async () => {
      const session = await createWebMetadataMigration({
        wallet: ask.obsidionWallet,
        account: ask.obsidionAccount,
        contractService: ask.contractService,
        toTokenService: ask.tokenService,
        historic: ask.current,
        current: ask.current,
      })
      const needed = await session.service.needsMigration()
      if (!cancelled) setRegistrationAnswer({ ask, needed })
      // Display only: a failed read leaves the sheet unpriced and never fails the check.
      if (needed)
        void (async () => {
          const next = await session.service.fundingTerms()
          if (!cancelled) setTerms(next)
        })().catch((error) => console.warn("[migration] funding terms read failed:", error))
    })().catch((error) => {
      console.warn("[migration] registration check failed:", error)
      if (!cancelled) setCheckFailed(true)
    })
    return () => {
      cancelled = true
    }
  }, [registrationAsk])
  // Only a named account that would otherwise read as finishing needs this browser's records. A
  // nameless one has no registration to finish.
  const askRegisteredHere =
    metadataFlow &&
    nothingToMove &&
    registrationOnly === false &&
    railPending === true &&
    !railUnread &&
    !!loadWalletIdentity()?.handle
  useEffect(() => {
    if (!obsidionAccount || !askRegisteredHere) return
    let cancelled = false
    const address = obsidionAccount.getAddress().toString().toLowerCase()
    const store = getPendingStore()
    void store
      .load()
      .then(() => {
        if (cancelled) return
        setRegisteredHere(store.list().some((r) => r.l2Address.toLowerCase() === address))
      })
      .catch((error) => console.warn("[migration] registration record read failed:", error))
    return () => {
      cancelled = true
    }
  }, [obsidionAccount, askRegisteredHere])
  // Home waits until a check reads every old version, unless the deployment counts none. With the
  // wallet locked nothing can be read in this page.
  useEffect(() => {
    if (!obsidionAccount) return
    if (probed && scanned && !metadataFlow)
      markOldHoldingsRead(obsidionAccount.getAddress().toString())
    releaseOldHoldingsWait(probed && !scanned)
  }, [obsidionAccount, probed, scanned, metadataFlow])
  useEffect(() => () => releaseOldHoldingsWait(false), [])
  // No check has read every old version yet, and the last one left one unread.
  const holdingsMissing =
    holdingsUnread && !!obsidionAccount && !oldHoldingsRead(obsidionAccount.getAddress().toString())
  const source = resumeSource ?? migratable?.tuple ?? (registrationOnly ? current : undefined)
  const request = useMigrationDialogRequest()
  const seenRequest = useRef(request)
  useEffect(() => {
    if (request === seenRequest.current) return
    seenRequest.current = request
    const reason = migrationDialogReason()
    setRequested(true)
    setResidualsAsked(reason === "residuals")
    setActionAsked(typeof reason === "object" ? reason : undefined)
  }, [request])
  // The source this run moves, and what it moves: the quote, or a live balance moved whole.
  const executing = residuals.find(
    (r) => !!source && r.tuple.portal.toLowerCase() === source.portal.toLowerCase(),
  )
  const moving = (executing && (metadataFlow ? quoteOf(executing)?.movable : migratable?.balance)) ?? 0n
  // A frozen source's run goes to the bell once approved. A live source withdraws each later batch
  // when it reaches it, and an externally funded run waits on the user's transfer: both stay here.
  // With nothing to move from, the user funds the upgrade themselves.
  const external = !!source && source.portal.toLowerCase() === current?.portal.toLowerCase()
  const handsOff =
    metadataFlow && (!!executing?.frozen || planSourceState(metadataRecord) === "frozen")
  // What a fresh run's batches pay, and the approvals they ask for. A resumed run keeps the
  // selections it saved, which the quote can't see, so it shows what its start was quoted.
  const sourceQuote = !(resumeSource && metadataRecord) && executing && quoteOf(executing)
  const quotedSummary: MetadataMigrationSummary | undefined =
    sourceQuote && sourceQuote.fees !== undefined && sourceQuote.approvals !== undefined
      ? { fees: sourceQuote.fees.toString(), approvals: sourceQuote.approvals }
      : undefined
  const summary = resumeSource && metadataRecord ? metadataRecord.summary : quotedSummary
  // Main from an upgrade's start until it is done: what will land, less the quoted fees, the dust
  // and the deposits still waiting on the old network.
  const lost = residuals.reduce((sum, r) => {
    const q = quoteOf(r)
    return q ? sum + (q.fees ?? 0n) + q.stranded + q.waiting : sum
  }, 0n)
  const landing =
    balanceKnown && !oldHoldings.pending
      ? parseUnits(walletBalance, DEFAULT_DECIMALS) + oldHoldings.total - lost
      : undefined
  const heldMain = landing !== undefined && landing < 0n ? 0n : landing
  // A fresh start takes the lock at that figure, so it waits until the figure is known.
  const figurePending = metadataFlow && !(resumeSource && metadataRecord) && heldMain === undefined
  const amount = moving > 0n ? usd(dollars(moving)) : ""
  // Read per deployment pair; a failed read shows no fee and blocks nothing.
  const fee = useQuery({
    queryKey: ["migration-fee", migratable?.tuple.portal, current?.portal],
    queryFn: () => loadMigrationFee(migratable!.tuple, current!),
    enabled: !!migratable && !!current && !metadataFlow,
    staleTime: Infinity,
    retry: false,
  })
  const quote =
    migratable && fee.data
      ? migrationAmounts({
          amount: formatUnits(migratable.balance, DEFAULT_DECIMALS),
          rawAmount: migratable.balance.toString(),
          ...fee.data,
        })
      : undefined
  const feeValue = (display: string | undefined) =>
    fee.isPending ? "…" : display ? `~${usd(Number(display))}` : undefined

  // What this run won't move: "Also there", and the notification. Residuals with nothing to do (a
  // deposit in transit, a paylink still in its claim window) are a notification, not a boot modal:
  // the modal asks only for an action.
  const stuck = residuals.flatMap((r) =>
    residualItems(r, {
      metadataFlow,
      quote: quoteOf(r),
      executing: r === executing || followed(r),
    }),
  )
  const notes = stuck.map(itemNote)
  const description = notes.join(" · ")
  // Only a complete scan judges the row; an incomplete one leaves it as it is.
  const scanComplete = scanned && !scanFailed && !checkingMovable && !chainTimeUnknown
  useEffect(() => {
    if (!scanComplete) return
    void (async () => {
      const store = AppNotificationStore.get(webStorage)
      await store.load()
      if (!description) return store.remove(RESIDUALS_NOTIFICATION_ID)
      const known = store.get(RESIDUALS_NOTIFICATION_ID)
      // Unchanged notes keep their timestamp, so a row the user dismissed stays dismissed.
      await store.upsert({
        id: RESIDUALS_NOTIFICATION_ID,
        sourceId: RESIDUALS_NOTIFICATION_ID,
        producer: "migration",
        domain: "migration",
        title: "Funds on an old version",
        description,
        timestampMs: known?.description === description ? known.timestampMs : Date.now(),
        systemIcon: "clock.arrow.circlepath",
        severity: "info",
        target: { type: "migration.residuals" },
      })
    })().catch(console.warn)
  }, [scanComplete, description])

  // The run the dialog shows goes on without the user, from before its saved record is read.
  const sourceFollowed = !!source && (following.get(source.portal.toLowerCase()) ?? 0) > 0
  // A stopped or interrupted upgrade waits for the user: the bell keeps it until the run moves on.
  const waiting =
    !runActive &&
    !sourceFollowed &&
    !!resumeSource &&
    metadataRecord &&
    !SENT.has(metadataRecord.phase)
      ? metadataRecord.phase
      : undefined
  // A run the boot follows to the end, with no dialog.
  const followingRun = [...following.values()].some((n) => n > 0)
  // The account's registration is current but not active yet, and nothing here is running it.
  const finishing = askRegisteredHere && registeredHere === false
  // Every check answered, and none found anything to do.
  // A probe that read nothing (a sign-out mid-check) settles nothing.
  const settled =
    probed &&
    nothingToMove &&
    (!metadataFlow ||
      (registrationOnly === false &&
        !railUnread &&
        (!askRegisteredHere || registeredHere === true)))
  const state: UpgradeState =
    runActive || followingRun
      ? "running"
      : waiting
        ? "stopped"
        : // An unread run, registration or holdings is never offered over; an unread residual can wait.
          checkFailed || holdingsMissing
          ? "failed"
          : // A movable source waits until the saved runs are read, so no run is started over one.
            source && (recordChecked || resumeSource)
            ? "offered"
            : scanFailed
              ? "failed"
              : finishing
                ? "finishing"
                : settled
                  ? "none"
                  : "checking"
  // A stop while the run is going is one it is trying again: the user sees only the one it ends on.
  const retrying = (runActive || sourceFollowed) && metadataRecord?.phase === "needsAttention"
  const runPhase =
    state === "running"
      ? runActive || sourceFollowed
        ? retrying
          ? undefined
          : metadataRecord?.phase
        : "arriving"
      : state === "stopped"
        ? metadataRecord?.phase
        : undefined
  // The metadata flow is what registers the account on this version.
  const registration = metadataFlow && (!!source || finishing)
  useEffect(
    () =>
      setUpgradeStatus({ state, phase: runPhase, registration, external: external || undefined }),
    [state, runPhase, registration, external],
  )
  useEffect(() => () => setUpgradeStatus({ state: "checking", registration: false }), [])
  // Fully upgraded here: Home shows the live balance again.
  const [releaseRetries, setReleaseRetries] = useState(0)
  useEffect(() => {
    if (state !== "none" || !obsidionAccount) return
    let timer: ReturnType<typeof setTimeout> | undefined
    releaseUpgradeLock(obsidionAccount.getAddress().toString()).catch((error) => {
      console.warn("[migration] upgrade lock release failed:", error)
      timer = setTimeout(() => setReleaseRetries((n) => n + 1), LOCK_RETRY_MS)
    })
    return () => clearTimeout(timer)
  }, [state, obsidionAccount, releaseRetries])
  // A held action goes ahead once the gate would let a press through now.
  const lock = useUpgradeLock(obsidionAccount?.getAddress().toString())
  const cleared = !upgradeVerdict({
    upgrade: state,
    current: lock.state === "released",
    locked: lock.state === "held",
    lockChecked: lock.checked,
  })
  useEffect(() => {
    if (!requested || !cleared || !actionAsked?.then) return
    const run = actionAsked.then
    setRequested(false)
    setActionAsked(undefined)
    run()
  }, [requested, cleared, actionAsked])

  const movedOn =
    runActive ||
    recordChecked ||
    (probed && !scanned) ||
    SENT.has(metadataRecord?.phase ?? "preparing")
  const needsYou = waiting ?? (state === "failed" ? "failed" : undefined)
  useEffect(() => {
    void (async () => {
      const store = AppNotificationStore.get(webStorage)
      await store.load()
      if (!needsYou) {
        if (movedOn && store.get(RUN_NOTIFICATION_ID)) await store.remove(RUN_NOTIFICATION_ID)
        return
      }
      const description =
        needsYou === "failed"
          ? "We couldn't check your old funds. Open it to try again."
          : needsYou === "needsApproval"
            ? "Your upgrade needs another approval. Open it to continue."
            : needsYou === "needsAttention"
              ? "Your upgrade stopped. Open it to see why and continue."
              : "Your upgrade is paused. Open it to continue."
      const known = store.get(RUN_NOTIFICATION_ID)
      await store.upsert({
        id: RUN_NOTIFICATION_ID,
        sourceId: RUN_NOTIFICATION_ID,
        producer: "migration",
        domain: "migration",
        title: "Your upgrade needs you",
        description,
        timestampMs: known?.description === description ? known.timestampMs : Date.now(),
        systemIcon: "exclamationmark.circle",
        severity: needsYou === "needsAttention" || needsYou === "failed" ? "error" : "info",
        target: { type: "migration.run" },
      })
    })().catch(console.warn)
  }, [needsYou, movedOn])

  // Past the hand-off the migration outlives the modal: its activity rows and the bell report it.
  const left = useRef(false)
  const onLeave = useCallback(() => {
    left.current = true
    setHandedOff(true)
    setRequested(false)
  }, [])

  const onMigrate = async () => {
    if (migrationRun.current || sourceFollowed || figurePending) return
    if (
      !source ||
      !current ||
      !obsidionWallet ||
      !obsidionAccount ||
      !tokenService ||
      !contractService
    ) {
      return
    }
    const run = new AbortController()
    migrationRun.current = run
    setMigrating(true)
    setRunActive(true)
    setPrepared(false)
    setHandedOff(false)
    left.current = false
    try {
      if (metadataFlow) {
        const address = obsidionAccount.getAddress().toString()
        await acquireUpgradeLock(address, heldMain)
        const session = await createWebMetadataMigration({
          wallet: obsidionWallet,
          account: obsidionAccount,
          contractService,
          toTokenService: tokenService,
          historic: source,
          current,
        })
        const unsubscribe = session.controller.subscribe(() => {
          if (!run.signal.aborted) setMetadataRecord(session.controller.getSnapshot())
        })
        try {
          await session.controller.load()
          setResumeSource(source)
          const progress = {
            signal: run.signal,
            summary: quotedSummary,
            onProgress: fundingProgress(session, run.signal, setFunding),
          }
          const sent = !handsOff
            ? await runUserFlow(() =>
                runMetadataMigration(session.controller, {
                  ...progress,
                  until: external ? unattended : undefined,
                }),
              )
            : await runOperation(
                {
                  operationId: `migration_${crypto.randomUUID()}`,
                  flow: "migration",
                  summary: migrationSummary(formatUnits(moving, DEFAULT_DECIMALS)),
                },
                async () => {
                  const record = await runMetadataMigration(session.controller, {
                    ...progress,
                    retry: true,
                    untilArriving: true,
                    onPrepared: () => setPrepared(true),
                  })
                  if (run.signal.aborted) throw new Error("Cancelled")
                  if (record?.phase === "needsAttention" || record?.phase === "needsApproval") {
                    console.warn("[migration] stopped:", record.error)
                    throw new UpgradeStopped(record.error)
                  }
                  return record
                },
              )
          // The rest follows from chain evidence, with no prompt and no send.
          const record =
            sent?.phase === "arriving"
              ? await runMetadataMigration(session.controller, {
                  signal: run.signal,
                  observeOnly: true,
                })
              : sent
          if (run.signal.aborted) return
          if (external && record && unattended(record)) followRun.current(source, true)
          if (record?.phase === "done") {
            setResumeSource(null)
            await loadAssets()
          }
        } finally {
          unsubscribe()
          // The run is over: the dialog shows how it stopped while the scan after it runs.
          if (migrationRun.current === run) migrationRun.current = undefined
          setRunActive(false)
          // The run moved funds the last scan counted: scan again rather than quote over it.
          rescans.current++
          try {
            await refresh()
          } finally {
            rescans.current--
          }
        }
        return
      }
      if (!migratable) return
      await runIntraRollupMigration({
        wallet: obsidionWallet,
        account: obsidionAccount,
        contractService,
        toTokenService: tokenService,
        historic: source,
        current,
        summary: migrationSummary(formatUnits(migratable.balance, DEFAULT_DECIMALS)),
      })
      setRequested(false)
      await loadAssets()
      await refresh()
    } catch (error) {
      // Back to the prompt: a closed passkey prompt or a cancel is the user's own no, and a stopped
      // upgrade says why itself; anything else is shown.
      if (!left.current && !isFlowCancelled(error) && !(error instanceof UpgradeStopped)) {
        showReportableError(error, "migration:intra-rollup")
      }
    } finally {
      if (migrationRun.current === run) migrationRun.current = undefined
      // Unless a press during the scan after this run started another.
      if (!migrationRun.current) setRunActive(false)
      if (!migrationRun.current && !rescans.current) setMigrating(false)
    }
  }

  // Read when the deposit screen asks for the address, so it starts the current run.
  const onMigrateRef = useRef(onMigrate)
  onMigrateRef.current = onMigrate
  // Where an externally funded run's deposit goes, once its bootstrap is sent and until it is swept:
  // nothing would publish the address before, and anything sent after strands there.
  const swept = !!metadataRecord?.swept
  const upgradeAddress = useMemo<ShownAddress | undefined>(
    () =>
      external && funding?.external && metadataRecord?.bootstrapTx && !swept
        ? {
            address: funding.address,
            name: loadWalletIdentity()?.handle ?? "",
            publishing: metadataRecord.bootstrapStatus !== "included",
          }
        : undefined,
    [
      external,
      funding?.external,
      funding?.address,
      metadataRecord?.bootstrapTx,
      metadataRecord?.bootstrapStatus,
      swept,
    ],
  )
  // Once the deposit is in, or the run waits for the user, the dialog says where it stands.
  useEffect(() => {
    if (swept || waiting) setDepositing(false)
  }, [swept, waiting])
  const depositTerms = funding ?? terms
  // The deposit screen's target: the run makes the address, and its sweep takes the update's fee.
  // Nothing under the general $1 minimum is asked for.
  const upgradeTarget = useMemo<DepositTarget | undefined>(() => {
    if (!external) return undefined
    const floor = depositTerms?.minimumAmount
    const dollar = depositTerms && 10n ** BigInt(depositTerms.decimals)
    return {
      kind: "upgrade",
      address: upgradeAddress,
      create: () => void onMigrateRef.current(),
      creating: runActive && !upgradeAddress,
      creatingNote: depositToUpgradeCopy.creating,
      fee: depositTerms?.fee,
      floor,
      ask:
        floor !== undefined && dollar !== undefined ? (floor > dollar ? floor : dollar) : undefined,
      // Seeded on the rail the same as a registration address (createWebMetadataMigration.ts's
      // seedFunding); the rail's own cadence picks funding up from there.
      onFunded: () => {},
      onShown: () => {},
    }
  }, [external, upgradeAddress, runActive, depositTerms])
  const depositMinimum =
    upgradeTarget?.ask !== undefined && depositTerms
      ? formatDepositDue(upgradeTarget.ask, depositTerms.decimals).replace(/\.00$/, "")
      : undefined

  if (repointed && !repointDismissed && !losesTransaction) {
    return (
      <Modal
        variant="bare"
        label="New version"
        className="ww-modal--create ww-logout"
        onClose={() => setRepointDismissed(true)}
      >
        <div data-testid="migration-repoint-modal" className="ww-migration">
          <GradientText gradient="title" size={24} weight={700} style={{ textAlign: "center" }}>
            A new version of zk.money is live
          </GradientText>
          <p className="ww-logout__body">Reload to upgrade to it.</p>
          <div className="ww-logout__actions">
            <PrimaryGradientButton
              title="Later"
              buttonStyle="dark"
              onClick={() => setRepointDismissed(true)}
            />
            <PrimaryGradientButton title="Reload" onClick={() => void reloadPage()} />
          </div>
        </div>
      </Modal>
    )
  }

  if (!requested) return null
  const offer = !!source && (state === "offered" || state === "running" || state === "stopped")
  // With nothing to offer or follow, or when the residuals row asked, the dialog lists what is left.
  // An action held while the check runs waits in the sheet rather than in the list.
  const holding = !!actionAsked && state === "checking"
  const listing =
    !offer &&
    !holding &&
    (state === "none" || state === "checking" || (residualsAsked && state !== "failed"))
  const retryChecks = () => {
    setCheckFailed(false)
    setChecks((n) => n + 1)
  }

  const close = () => {
    // Before the hand-off a close cancels the run; after it, the run goes on without the dialog.
    if (!left.current) migrationRun.current?.abort()
    setRequested(false)
    setResidualsAsked(false)
    setActionAsked(undefined)
    setDepositing(false)
  }
  if (depositing && upgradeTarget)
    return (
      <DepositScreen
        onClose={close}
        target={upgradeTarget}
        title={depositToUpgradeCopy.depositTitle}
      />
    )
  if (listing) {
    return (
      <Modal
        variant="bare"
        label="Funds on an old version"
        className="ww-modal--create"
        onClose={close}
      >
        <div data-testid="migration-residuals-modal" className="ww-migration">
          <div className="ww-modal__close">
            <TopNavIconButton icon="x" ariaLabel="Close" onClick={close} />
          </div>
          <GradientText gradient="title" size={24} weight={700} style={{ textAlign: "center" }}>
            Funds on an old version
          </GradientText>
          {stuck.length > 0 && (
            <ul className="ww-migration__residuals">
              {stuck.map((item, i) => (
                <li key={i}>{itemLine(item)}</li>
              ))}
            </ul>
          )}
          {!scanComplete ? (
            <p className="ww-migration__lead">Still checking your funds on an old version.</p>
          ) : (
            !stuck.length && <p className="ww-migration__lead">Nothing is left on an old version.</p>
          )}
          <PrimaryGradientButton
            title="Try again"
            isDisabled={refreshing}
            onClick={() => void refresh()}
          />
          <button type="button" className="zkm-btn-reset ww-migration__later" onClick={close}>
            Close
          </button>
        </div>
      </Modal>
    )
  }
  const phase = metadataRecord && !retrying ? upgradePhaseLabel[metadataRecord.phase] : undefined
  const title = actionAsked ? actionUpgradeTitle[actionAsked.action] : offerCopy.title
  const working = runActive && !handedOff && (handsOff || !metadataFlow)
  const approvals = metadataRecord?.approvals
  return (
    <Modal
      variant="bare"
      label="Upgrade zk.money"
      className="ww-modal--create"
      onClose={working && !metadataFlow ? undefined : close}
    >
      <div data-testid="migration-detected-modal" className="ww-migration">
        {working && metadataFlow ? (
          <OperationHandOff
            until="prepared"
            prepared={prepared}
            onLeave={onLeave}
            renderWorking={(beat, _label, hint) => (
              <>
                <PayWorking beat={beat} hint={hint} onCancel={close} />
                {approvals && approvals.approved < approvals.total && (
                  <p className="ww-migration__note">
                    Approve {approvals.approved + 1} of {approvals.total}
                  </p>
                )}
                <p className="ww-migration__note">{keepTabOpen}</p>
              </>
            )}
          />
        ) : working ? (
          <OperationHandOff onLeave={onLeave} />
        ) : (
          <>
            <div className="ww-modal__close">
              <TopNavIconButton icon="x" ariaLabel="Close" onClick={close} />
            </div>
            {offer && external ? (
              <>
                <UpgradeIntro
                  title={depositToUpgradeCopy.title}
                  lead={depositToUpgradeCopy.lead(depositMinimum)}
                />
                <UpgradeFee label={depositToUpgradeCopy.fees}>
                  {depositToUpgradeCopy.tip}
                </UpgradeFee>
              </>
            ) : offer ? (
              <UpgradeIntro
                title={title}
                lead={metadataFlow ? offerCopy.lead : offerCopy.liveLead}
              />
            ) : holding ? (
              <UpgradeIntro title={title} lead={checkingLead} />
            ) : state === "finishing" ? (
              <UpgradeIntro title={finishingCopy.title} lead={finishingCopy.lead} />
            ) : state === "running" ? (
              <UpgradeIntro title={title} lead={followingLead} />
            ) : (
              <>
                <GradientText
                  gradient="title"
                  size={24}
                  weight={700}
                  style={{ textAlign: "center" }}
                >
                  Couldn't check your old funds
                </GradientText>
                <p className="ww-migration__lead">
                  Some funds on an old version could not be checked. Try again to see them.
                </p>
              </>
            )}
            {offer && metadataFlow && summary && (
              <>
                <UpgradeFee label={upgradeFeeLabel(usd(dollars(BigInt(summary.fees))))}>
                  {upgradeFeeTip}
                </UpgradeFee>
                {/* Each batch of the account's own funds asks its own passkey approval. */}
                <div className="ww-pay__summary">
                  <ConfirmationSheetDetailRow label="Approvals" value={String(summary.approvals)} />
                </div>
              </>
            )}
            {offer && migratable && !metadataFlow && (
              <div className="ww-pay__summary">
                {amount && <ConfirmationSheetDetailRow label="Amount" value={amount} />}
                {!fee.isError && (
                  <>
                    <ConfirmationSheetDetailRow
                      label="Old version fee"
                      value={feeValue(quote?.exitFeeDisplay)}
                    />
                    <ConfirmationSheetDetailRow
                      label="New version fee"
                      value={feeValue(quote?.arrivalFeeDisplay)}
                    />
                    <ConfirmationSheetDetailRow
                      label="You'll receive"
                      value={feeValue(quote?.netDisplay)}
                    />
                  </>
                )}
                <ConfirmationSheetDetailRow label="Takes" value="About an hour, hands-off" />
              </div>
            )}
            {/* A frozen run's operation keeps the tab, as the bell says; a run without one, until sent. */}
            {metadataFlow &&
              runActive &&
              (handsOff ? losesTransaction : !SENT.has(metadataRecord?.phase ?? "")) && (
                <p className="ww-migration__note">{keepTabOpen}</p>
              )}
            {phase && <p className="ww-migration__note">{phase}</p>}
            {metadataRecord?.error && !retrying && (
              <p className="ww-migration__note" role="alert">
                {upgradeStopText(metadataRecord)}
              </p>
            )}
            {offer && migratable && notes.length > 0 && (
              <p className="ww-migration__note">Also there: {notes.join(" · ")}.</p>
            )}
            {pendingWithdrawals > 0 && (
              <p className="ww-migration__note" data-testid="migration-pending-withdrawals">
                {pendingWithdrawals} withdrawal(s) in progress are unaffected.
              </p>
            )}
            {offer && external && !waiting && !swept ? (
              <PrimaryGradientButton
                title={depositToUpgradeCopy.button}
                isDisabled={figurePending}
                onClick={() => setDepositing(true)}
              />
            ) : offer ? (
              <PrimaryGradientButton
                title={
                  runActive || sourceFollowed
                    ? "Upgrading…"
                    : busy
                      ? busyLabel
                      : resumeSource && metadataRecord
                        ? continueLabel(metadataRecord)
                        : "Upgrade now"
                }
                isDisabled={busy || runActive || sourceFollowed || figurePending}
                onClick={() => void onMigrate()}
              />
            ) : (
              state === "failed" && (
                <PrimaryGradientButton
                  title="Try again"
                  isDisabled={refreshing}
                  onClick={() => (checkFailed ? retryChecks() : void refresh())}
                />
              )
            )}
            <button type="button" className="zkm-btn-reset ww-migration__later" onClick={close}>
              {runActive || sourceFollowed || !offer ? "Close" : "Maybe later"}
            </button>
          </>
        )}
      </div>
    </Modal>
  )
}

/** The upgrade's fee as a pill, and why it is charged behind a press (Figma 12725:37307). */
function UpgradeFee({ label, children }: { label: string; children: string }) {
  return (
    <TipRow
      className="ww-migration__fee"
      testId="upgrade-fee"
      mark={
        <img className="ww-migration__fee-mark" src={questionMark} alt="" width={12} height={12} />
      }
      label={label}
    >
      {children}
    </TipRow>
  )
}

/**
 * Whether the saved run's first refund has executed on L1: the deposit it funds has reached the
 * destination, which the run waits for before it activates sponsorship.
 */
function firstRefundSettled(record: MetadataMigrationRecord | null): boolean {
  return (
    !!record &&
    (["subscribing", "recovering", "arriving", "done"].includes(record.phase) ||
      (record.phase === "needsApproval" && !!record.subscriptionTx))
  )
}

/**
 * What is left of an externally funded run, whose source is this version, needs no user once its
 * consent is signed and its bootstrap sent, unless it stopped for the user. No other run is left to
 * itself: an old version's recovery may withdraw, which asks a passkey.
 */
function unattended(record: MetadataMigrationRecord): boolean {
  return (
    !!record.bootstrapTx &&
    record.phase !== "needsApproval" &&
    (record.phase !== "needsAttention" || retryableStop(record))
  )
}

/**
 * Reads where an externally funded run's funds go, once per plan. Display only: a failed read never
 * stops the run, and the next pass reads again.
 */
function fundingProgress(
  session: Awaited<ReturnType<typeof createWebMetadataMigration>>,
  signal: AbortSignal,
  show: (funding: Awaited<ReturnType<MetadataMigrationService["funding"]>>) => void,
): () => Promise<void> {
  let shownPlan: string | undefined
  return async () => {
    const plan = session.controller.getSnapshot()?.plan
    if (!plan || plan === shownPlan) return
    try {
      const funding = await session.service.funding(plan)
      if (!signal.aborted) show(funding)
      shownPlan = plan
    } catch (error) {
      console.warn("[migration] funding read failed:", error)
    }
  }
}

/** Every batch is sent: what is left needs no tab and no user. */
const SENT: ReadonlySet<string> = new Set(["arriving", "done"])

/** The source state a saved plan was prepared against; read while rendering, so it never throws. */
function planSourceState(record: MetadataMigrationRecord | null): string | undefined {
  try {
    const plan = record?.plan && (JSON.parse(record.plan) as { sourceState?: string })
    return plan ? plan.sourceState : undefined
  } catch {
    return undefined
  }
}

/** A source still taking transactions. The metadata flow neither reads nor moves one without a run. */
function liveSource(r: HistoricResidualSummary): boolean {
  return !r.frozen && !r.incomplete
}

/** Funds a source's first batch could move: a balance, or a frozen source's unclaimed deposits. */
function holdsFunds(r: HistoricResidualSummary): boolean {
  return r.balance > 0n || (r.frozen && r.sweptDeposits > 0)
}

/** Funds Home counts on a source: what a batch could move, and deposits still waiting to. */
function holdsBalance(r: HistoricResidualSummary): boolean {
  return holdsFunds(r) || (r.frozen && r.waitingDeposits > 0)
}

/** One kind of fund left on a retired version; `amount` in dollars when known. */
type ResidualItem =
  | { kind: "balance"; amount: number; stranded: "small" | "frozen" }
  | { kind: "other"; amount: number }
  | { kind: "unclaimed" | "transit" | "waiting" | "link"; count: number; amount?: number }
  | { kind: "locked"; count: number; amount?: number; until: string }

const dollars = (amount: bigint) => Number(formatUnits(amount, DEFAULT_DECIMALS))
// Dust under a cent still counts: never show it as nothing.
const money = (amount: number) => (amount > 0 && amount < 0.005 ? "<$0.01" : usd(amount))

/** A payment link's amount is its row's; one without a known amount leaves the total unknown. */
function linkTotal(rows: HistoricResidualSummary["paylinkCandidates"]): number | undefined {
  if (rows.some((row) => !row.token || row.token.hasUnknownAmount)) return undefined
  return rows.reduce((sum, row) => sum + row.token!.amount, 0)
}

/**
 * What a residual holds that a run won't move now, kind by kind. A quoted source shows what no batch
 * affords, and, unless the run takes it (`executing`), what it moves later. A quote counts a frozen
 * source's swept deposits. A live balance counts only the swept deposits stored in this PXE, so with
 * no balance none of them is in it.
 */
function residualItems(
  r: HistoricResidualSummary,
  v: { metadataFlow: boolean; quote?: MigrationSourceQuote; executing: boolean },
): ResidualItem[] {
  const items: ResidualItem[] = []
  if (v.quote) {
    if (!v.executing && v.quote.movable > 0n)
      items.push({ kind: "other", amount: dollars(v.quote.movable) })
    if (v.quote.stranded > 0n)
      items.push({ kind: "balance", amount: dollars(v.quote.stranded), stranded: "small" })
  } else if (r.balance > 0n && r.frozen) {
    const stranded = v.metadataFlow ? "small" : "frozen"
    items.push({ kind: "balance", amount: dollars(r.balance), stranded })
  } else if (r.balance > 0n && !v.executing) {
    items.push({ kind: "other", amount: dollars(r.balance) })
  }
  if (r.sweptDeposits > 0 && (r.frozen ? !v.quote : r.balance === 0n))
    items.push({ kind: "unclaimed", count: r.sweptDeposits })
  if (r.inTransitDeposits > 0) {
    const amount = r.inTransitAmount > 0n ? dollars(r.inTransitAmount) : undefined
    items.push({ kind: "transit", count: r.inTransitDeposits, amount })
  }
  // A quote reads the Inbox later than the scan did, so a quoted source's waiting is its quote's.
  const waiting = v.quote ? v.quote.waiting : r.waitingAmount
  if (r.waitingDeposits > 0 && (!v.quote || waiting > 0n)) {
    const amount = waiting > 0n ? dollars(waiting) : undefined
    items.push({ kind: "waiting", count: r.waitingDeposits, amount })
  }
  // With the chain clock unread, a still-escrowed link is neither refundable nor locked yet.
  const open = r.paylinkCandidates.filter((row) => !r.lockedPaylinks.includes(row))
  if (open.length > 0) items.push({ kind: "link", count: open.length, amount: linkTotal(open) })
  if (r.lockedPaylinks.length > 0) {
    items.push({
      kind: "locked",
      count: r.lockedPaylinks.length,
      amount: linkTotal(r.lockedPaylinks),
      until: lockedUntilLabel(r.lockedPaylinks),
    })
  }
  return items
}

/** A few words each, for the bell and "Also there". */
function itemNote(item: ResidualItem): string {
  const sum = item.amount === undefined ? undefined : money(item.amount)
  switch (item.kind) {
    case "balance":
      return item.stranded === "small" ? `${sum} too small to move` : `${sum} on a frozen version`
    case "other":
      return `${sum} on another old version`
    case "unclaimed":
      return sum ? `${sum} in unclaimed deposits` : `${item.count} unclaimed deposit(s)`
    case "transit":
      return sum ? `${sum} in transit` : `${item.count} deposit(s) in transit`
    case "waiting":
      return sum
        ? `${sum} waiting on the old network`
        : `${item.count} deposit(s) waiting on the old network`
    case "link":
      return sum ? `${sum} in open paylink(s)` : `${item.count} open paylink(s)`
    case "locked":
      return `${sum ? `${sum} in` : item.count} paylink(s) locked until ${item.until}`
  }
}

const deposits = (n: number) => (n === 1 ? "A deposit" : `${n} deposits`)
const links = (n: number) => (n === 1 ? "a payment link" : `${n} payment links`)

/** Why each kind is still there, for the dialog's list. */
function itemLine(item: ResidualItem): string {
  const one = "count" in item && item.count === 1
  const sum = item.amount === undefined ? undefined : money(item.amount)
  switch (item.kind) {
    case "balance":
      return `${sum} can't be moved now`
    case "other":
      return `${sum} is on another old version`
    case "unclaimed":
      return sum
        ? `${sum} in unclaimed deposits can't be moved now`
        : `${one ? "An unclaimed deposit" : `${item.count} unclaimed deposits`} can't be moved now`
    case "transit":
      return `${sum ?? deposits(item.count)} in transit: the old network hasn't credited ${
        one ? "it" : "them"
      } yet`
    case "waiting":
      return `${
        sum ?? deposits(item.count)
      } waiting: the old network must close its Inbox tree before ${one ? "it" : "they"} can move`
    case "link":
      return sum
        ? `${sum} is still in ${links(item.count)} on the old version`
        : `Funds are still in ${links(item.count)} on the old version`
    case "locked":
      return sum
        ? `${sum} in ${links(item.count)} locked until ${item.until}`
        : `${one ? "A payment link is" : `${item.count} payment links are`} locked until ${
            item.until
          }`
  }
}
