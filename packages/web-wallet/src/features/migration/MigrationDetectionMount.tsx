import { reloadPage } from "../../platform/storage/walletStorage"
import { Modal } from "../../ui/Modal"
/**
 * Boot-time migration detection: pop the upgrade dialog when the signed-in account
 * still holds residual funds on a retired oxide deployment (`probeAccountResiduals`). Mounted
 * inside WalletGate (post-PXE, post-unlock) because the probes need the wallet + account.
 *
 * Paylinks still inside their claim window cannot be refunded yet; `probeAccountResiduals` hands
 * them to `PendingPaylinkMigrationService`, which waits out the window and mints a reclaim
 * notification once chain time passes it.
 *
 * "Maybe later" is a SESSION dismiss only — funds on a retired deployment stay detectable, so the
 * modal returns next boot until they are moved. Detection failures are swallowed: this must never
 * break the wallet's boot. On an intra-rollup migration "Upgrade now" runs its exit half
 * (`runIntraRollupMigration`) under `OperationHandOff`: the modal shows the working beat, labeled
 * "Publishing your new address" while the arrival publishes, until the passkey signs the burn; then
 * it closes into the bell and the exit and the arrival ride the withdrawal and deposit rails.
 * Residuals with nothing to do right now become a notification instead of a modal.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  AppNotificationStore,
  bootPriority,
  checkSpentViaPaylinkService,
  useAccountContext,
  useAssetContext,
  useAztecContext,
  useContractServiceContext,
  runMetadataMigration,
  type MetadataMigrationRecord,
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
import { formatUnits } from "viem"
import { fetchLiveProfilePortal, getConfig } from "../../config/env"
import { showReportableError } from "../../errors/errorModal"
import { usd } from "../../ui/format"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import type { HistoricResidualSummary } from "./historicResiduals"
import { probeAccountResiduals, reconcilePendingPaylinks } from "./probeAccountResiduals"
import { runIntraRollupMigration } from "./runIntraRollupMigration"
import { migrationSummary } from "./migrationArrival"
import { loadMigrationFee, migrationAmounts } from "./migrationFee"
import {
  isFlowCancelled,
  runOperation,
  useBusyLabel,
  useLeavingLosesTransaction,
} from "../operations/operations"
import { runUserFlow, useUserFlowActive } from "../provingGate"
import { OperationHandOff } from "../operations/OperationHandOff"
import { PayWorking } from "../contacts/PayWorking"
import { UpgradeIntro } from "./UpgradeIntro"
import { continueLabel, upgradePhaseLabel, upgradeStopText } from "./upgradeCopy"
import "./migration.css"
import { createWebMetadataMigration, webMetadataMigrationKey } from "./createWebMetadataMigration"
import {
  setRegistrationMigrationNeeded,
  setUpgradeOffered,
  useMigrationDialogRequest,
} from "./migrationDialog"

export const PROFILE_REPOINT_POLL_MS = 5 * 60_000

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
  const [dismissed, setDismissed] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [scanRevision, setScanRevision] = useState(0)
  // The last probe ran to a result: a locked wallet or a manifest with no history reads nothing.
  const [scanned, setScanned] = useState(false)
  const [chainTimeUnknown, setChainTimeUnknown] = useState(false)
  // Opened on request: with nothing to move or register, the dialog lists what is left.
  const [requested, setRequested] = useState(false)
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
  // Nothing on a retired version can move, and the account still has to update its registration.
  const [registrationOnly, setRegistrationOnly] = useState(false)
  const [funding, setFunding] = useState<Awaited<ReturnType<MetadataMigrationService["funding"]>>>()
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
    void (async () => {
      await bootPriority.whenReady("migrationProbe")
      if (cancelled) return
      const found = await probeAccountResiduals(obsidionWallet, obsidionAccount)
      if (cancelled) return
      setScanRevision((n) => n + 1)
      setScanned(!!found)
      if (!found) return
      setCurrent(found.current)
      setResiduals(found.residuals)
      setPendingWithdrawals(found.pendingWithdrawals)
      setChainTimeUnknown(!!found.chainTimeUnknown)
      setHistoric(found.historic ?? [])
    })().catch((error) => console.warn("[migration] boot probe failed:", error))
    return () => {
      cancelled = true
    }
  }, [obsidionWallet, obsidionAccount])

  useEffect(() => {
    if (!obsidionWallet || !obsidionAccount || !current || !historic) return
    let cancelled = false
    const observing = new AbortController()
    // Every batch of an arriving upgrade is sent: its run finishes from chain evidence with no
    // click, no prompt and no send. It asks for the dialog only if it stops for the user.
    const observe = async (source: OxideEnvTuple) => {
      if (!contractService || !tokenService) return
      const portal = source.portal.toLowerCase()
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
        await session.controller.load()
        const record = await runMetadataMigration(session.controller, {
          signal: observing.signal,
          observeOnly: true,
        })
        if (observing.signal.aborted || !record) return
        if (record.phase === "done") {
          await loadAssets()
          await refresh()
          return
        }
        setResumeSource(source)
        setMetadataRecord(record)
      } finally {
        setFollowing(count(-1))
      }
    }
    void (async () => {
      for (const source of [...historic, current]) {
        const raw = await webStorage.getItem(
          webMetadataMigrationKey(current, source, obsidionAccount),
        )
        if (cancelled) return
        if (!raw) continue
        const record = JSON.parse(raw) as MetadataMigrationRecord
        if (record.phase === "done") continue
        if (record.phase === "arriving") {
          void observe(source).catch((error) =>
            console.warn("[migration] arriving upgrade check failed:", error),
          )
          continue
        }
        setResumeSource(source)
        setMetadataRecord(record)
        return
      }
      setRecordChecked(true)
    })().catch((error) => console.warn("[migration] metadata probe failed:", error))
    return () => {
      cancelled = true
      observing.abort()
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
  useEffect(() => {
    // A running migration moves the funds it would quote; it quotes them again once it stops.
    if (migrating) return
    const sources = residuals.filter(holdsFunds)
    if (
      !sources.length ||
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
      for (const r of sources) {
        try {
          const session = await createWebMetadataMigration({
            wallet: obsidionWallet,
            account: obsidionAccount,
            contractService,
            toTokenService: tokenService,
            historic: r.tuple,
            current,
          })
          const portal = r.tuple.portal.toLowerCase()
          next.set(
            portal,
            await session.service.quote({ firstBatchSettled: portal === settledPortal }),
          )
        } catch (error) {
          failed = true
          console.warn(`[migration] quote failed for ${r.tuple.portal}:`, error)
        }
      }
      if (cancelled) return
      setChecked({ residuals, quotes: next, failed })
    })()
    return () => {
      cancelled = true
    }
  }, [
    residuals,
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
  // Without the metadata flow a live balance moves whole, and nothing moves a frozen source.
  const followed = (r: HistoricResidualSummary) =>
    (following.get(r.tuple.portal.toLowerCase()) ?? 0) > 0
  const movableState = (r: HistoricResidualSummary) =>
    !metadataFlow
      ? !r.frozen && r.balance > 0n
      : holdsFunds(r) && !followed(r)
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
  useEffect(() => {
    if (
      !nothingToMove ||
      !metadataFlow ||
      !obsidionWallet ||
      !obsidionAccount ||
      !current ||
      !tokenService ||
      !contractService
    ) {
      setRegistrationOnly(false)
      return
    }
    let cancelled = false
    void (async () => {
      const session = await createWebMetadataMigration({
        wallet: obsidionWallet,
        account: obsidionAccount,
        contractService,
        toTokenService: tokenService,
        historic: current,
        current,
      })
      const needed = await session.service.needsMigration()
      if (!cancelled) setRegistrationOnly(needed)
    })().catch((error) => console.warn("[migration] registration check failed:", error))
    return () => {
      cancelled = true
    }
  }, [
    nothingToMove,
    metadataFlow,
    obsidionWallet,
    obsidionAccount,
    current,
    tokenService,
    contractService,
  ])
  const source = resumeSource ?? migratable?.tuple ?? (registrationOnly ? current : undefined)
  // The metadata flow is what registers the account on this version.
  const registrationUpdate = metadataFlow && !!source
  useEffect(() => setRegistrationMigrationNeeded(registrationUpdate), [registrationUpdate])
  useEffect(() => () => setRegistrationMigrationNeeded(false), [])
  useEffect(
    () => setUpgradeOffered(registrationUpdate && !runActive),
    [registrationUpdate, runActive],
  )
  useEffect(() => () => setUpgradeOffered(false), [])
  const request = useMigrationDialogRequest()
  const seenRequest = useRef(request)
  useEffect(() => {
    if (request === seenRequest.current) return
    seenRequest.current = request
    setDismissed(false)
    setRequested(true)
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
  // selections it saved, which the quote can't see.
  const sourceQuote = !(resumeSource && metadataRecord) && executing && quoteOf(executing)
  const summary =
    sourceQuote && sourceQuote.fees !== undefined && sourceQuote.approvals !== undefined
      ? { movable: sourceQuote.movable, fees: sourceQuote.fees, approvals: sourceQuote.approvals }
      : undefined
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

  // A stopped or interrupted upgrade waits for the user: the bell keeps it until the run moves on.
  const waiting =
    !runActive && !!resumeSource && metadataRecord && !SENT.has(metadataRecord.phase)
      ? metadataRecord.phase
      : undefined
  const movedOn = runActive || recordChecked || SENT.has(metadataRecord?.phase ?? "preparing")
  useEffect(() => {
    void (async () => {
      const store = AppNotificationStore.get(webStorage)
      await store.load()
      if (!waiting) {
        if (movedOn && store.get(RUN_NOTIFICATION_ID)) await store.remove(RUN_NOTIFICATION_ID)
        return
      }
      const description =
        waiting === "needsApproval"
          ? "Your upgrade needs another approval. Open it to continue."
          : waiting === "needsAttention"
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
        severity: waiting === "needsAttention" ? "error" : "info",
        target: { type: "migration.run" },
      })
    })().catch(console.warn)
  }, [waiting, movedOn])

  // Past the hand-off the migration outlives the modal: its activity rows and the bell report it.
  const left = useRef(false)
  const onLeave = useCallback(() => {
    left.current = true
    setHandedOff(true)
    setDismissed(true)
  }, [])

  const onMigrate = async () => {
    if (migrationRun.current) return
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
          let shownPlan: string | undefined
          const progress = {
            signal: run.signal,
            // Display only: a failed read never stops the run, and the next pass reads again.
            onProgress: async () => {
              const plan = session.controller.getSnapshot()?.plan
              if (plan && plan !== shownPlan) {
                try {
                  const funding = await session.service.funding(plan)
                  if (!run.signal.aborted) setFunding(funding)
                  shownPlan = plan
                } catch (error) {
                  console.warn("[migration] funding read failed:", error)
                }
              }
            },
          }
          const sent = !handsOff
            ? await runUserFlow(() => runMetadataMigration(session.controller, progress))
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
      setDismissed(true)
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

  // Boot never opens the list of what is left; a request does.
  const listing = requested && !migratable && !scanFailed && !source
  if (dismissed || (!migratable && !scanFailed && !source && !listing)) return null

  const close = () => {
    // Before the hand-off a close cancels the run; after it, the run goes on without the dialog.
    if (!left.current) migrationRun.current?.abort()
    setDismissed(true)
    setRequested(false)
  }
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
  // A stop while the run is going is one it is trying again: the user sees only the one it ends on.
  const retrying = runActive && metadataRecord?.phase === "needsAttention"
  const phase = metadataRecord && !retrying ? upgradePhaseLabel[metadataRecord.phase] : undefined
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
            {source ? (
              <UpgradeIntro
                title="Upgrade to a faster zk.money"
                lead={
                  external
                    ? "Upgrade to send and receive faster. With nothing on the old version that " +
                      "can move, you fund the upgrade yourself."
                    : "Upgrade to send and receive faster. Your balance stays safe."
                }
              />
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
            {migratable && (
              <div className="ww-pay__summary">
                {amount && <ConfirmationSheetDetailRow label="Amount" value={amount} />}
                {!metadataFlow && !fee.isError && (
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
                {summary && (
                  <>
                    <ConfirmationSheetDetailRow label="Fees" value={usd(dollars(summary.fees))} />
                    <ConfirmationSheetDetailRow
                      label="You'll receive"
                      value={usd(dollars(summary.movable - summary.fees))}
                    />
                    <ConfirmationSheetDetailRow
                      label="Approvals"
                      value={String(summary.approvals)}
                    />
                  </>
                )}
                {!handsOff && (
                  <ConfirmationSheetDetailRow label="Takes" value="About an hour, hands-off" />
                )}
              </div>
            )}
            {handsOff && migratable && (
              <p className="ww-migration__note">
                Keep this tab open until your funds are sent, usually a few minutes.
              </p>
            )}
            {phase && <p className="ww-migration__note">{phase}</p>}
            {metadataRecord?.error && !retrying && (
              <p className="ww-migration__note" role="alert">
                {upgradeStopText(metadataRecord)}
              </p>
            )}
            {funding?.external && metadataRecord?.phase !== "done" && (
              <p className="ww-migration__note">
                Send at least {formatUnits(funding.minimumAmount, funding.decimals)}{" "}
                {funding.symbol} (token <code>{funding.token}</code>) on Ethereum to your upgrade
                address <code>{funding.address}</code>.{" "}
                {formatUnits(funding.fee, funding.decimals)} {funding.symbol} pays for the upgrade;
                the rest reaches your balance.
              </p>
            )}
            {migratable && notes.length > 0 && (
              <p className="ww-migration__note">Also there: {notes.join(" · ")}.</p>
            )}
            {pendingWithdrawals > 0 && (
              <p className="ww-migration__note" data-testid="migration-pending-withdrawals">
                {pendingWithdrawals} withdrawal(s) in progress are unaffected.
              </p>
            )}
            {source ? (
              <PrimaryGradientButton
                title={
                  runActive
                    ? "Upgrading…"
                    : busy
                      ? busyLabel
                      : resumeSource && metadataRecord
                        ? continueLabel(metadataRecord)
                        : "Upgrade now"
                }
                isDisabled={busy || runActive}
                onClick={() => void onMigrate()}
              />
            ) : (
              <PrimaryGradientButton
                title="Try again"
                isDisabled={refreshing}
                onClick={() => void refresh()}
              />
            )}
            <button type="button" className="zkm-btn-reset ww-migration__later" onClick={close}>
              {runActive ? "Close" : "Maybe later"}
            </button>
          </>
        )}
      </div>
    </Modal>
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


/** Funds a source's first batch could move: a balance, or a frozen source's unclaimed deposits. */
function holdsFunds(r: HistoricResidualSummary): boolean {
  return r.balance > 0n || (r.frozen && r.sweptDeposits > 0)
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
