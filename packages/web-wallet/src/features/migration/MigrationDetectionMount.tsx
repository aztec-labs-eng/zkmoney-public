import { reloadPage } from "../../platform/storage/walletStorage"
import { Modal } from "../../ui/Modal"
/**
 * Boot-time migration detection: pop the "Migration detected" modal when the signed-in account
 * still holds residual funds on a retired oxide deployment (`probeAccountResiduals`). Mounted
 * inside WalletGate (post-PXE, post-unlock) because the probes need the wallet + account.
 *
 * Paylinks still inside their claim window cannot be refunded yet; `probeAccountResiduals` hands
 * them to `PendingPaylinkMigrationService`, which waits out the window and mints a reclaim
 * notification once chain time passes it.
 *
 * "Later" is a SESSION dismiss only — funds on a retired deployment stay detectable, so the modal
 * returns next boot until they are moved. Detection failures are swallowed: this must never break
 * the wallet's boot. "Move funds" runs the exit half of the migration (`runIntraRollupMigration`)
 * under `OperationHandOff`: the modal shows the working beat, labeled "Publishing your new address"
 * while the arrival publishes, until the passkey signs the burn; then it closes into the bell and
 * the exit and the arrival ride the withdrawal and deposit rails. Residuals with nothing to do
 * right now become a notification instead of a modal.
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
} from "@obsidion/front-core"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { PaylinkService } from "@obsidion/sdk"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  ConfirmationSheetDetailRow,
  GradientText,
  PrimaryGradientButton,
  TopNavIconButton,
} from "@obsidion/web-ds"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
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
import { useBusyLabel, useLeavingLosesTransaction } from "../operations/operations"
import { useUserFlowActive } from "../provingGate"
import { OperationHandOff } from "../operations/OperationHandOff"
import "./migration.css"

export const PROFILE_REPOINT_POLL_MS = 5 * 60_000

const RESIDUALS_NOTIFICATION_ID = "migration:residuals"

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
  const [current, setCurrent] = useState<OxideEnvTuple | null>(null)
  const [pendingWithdrawals, setPendingWithdrawals] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [scanRevision, setScanRevision] = useState(0)
  // The last probe ran to a result: a locked wallet or a manifest with no history reads nothing.
  const [scanned, setScanned] = useState(false)
  const repointed = useProfileRepoint()
  const [repointDismissed, setRepointDismissed] = useState(false)
  // Its Reload would end a running proof, so the prompt waits for the transaction to settle.
  const losesTransaction = useLeavingLosesTransaction()
  const busy = useUserFlowActive()
  const busyLabel = useBusyLabel()

  const checkSpent = useMemo(
    () =>
      obsidionWallet && obsidionAccount && tokenService && contractService
        ? checkSpentViaPaylinkService(
            new PaylinkService(obsidionWallet, obsidionAccount, tokenService, contractService),
          )
        : undefined,
    [obsidionWallet, obsidionAccount, tokenService, contractService],
  )

  const refresh = useCallback(async () => {
    if (!obsidionWallet || !obsidionAccount) return
    setRefreshing(true)
    let found: Awaited<ReturnType<typeof probeAccountResiduals>>
    try {
      found = await probeAccountResiduals(obsidionWallet, obsidionAccount)
    } catch (error) {
      console.warn("[migration] re-probe failed:", error)
      return
    } finally {
      setRefreshing(false)
    }
    setScanRevision((n) => n + 1)
    setScanned(!!found)
    if (!found) {
      setResiduals([])
      return
    }
    setCurrent(found.current)
    setResiduals(found.residuals)
    setPendingWithdrawals(found.pendingWithdrawals)
  }, [obsidionWallet, obsidionAccount])

  useEffect(() => {
    if (!obsidionWallet || !obsidionAccount) return
    let cancelled = false
    void (async () => {
      await bootPriority.whenBalanceSettled()
      if (cancelled) return
      const found = await probeAccountResiduals(obsidionWallet, obsidionAccount)
      if (cancelled) return
      setScanRevision((n) => n + 1)
      setScanned(!!found)
      if (!found) return
      setCurrent(found.current)
      setResiduals(found.residuals)
      setPendingWithdrawals(found.pendingWithdrawals)
    })().catch((error) => console.warn("[migration] boot probe failed:", error))
    return () => {
      cancelled = true
    }
  }, [obsidionWallet, obsidionAccount])

  useEffect(() => {
    if (!obsidionWallet) return
    void reconcilePendingPaylinks(obsidionWallet, checkSpent).catch((error) =>
      console.warn("[migration] paylink reconcile failed:", error),
    )
  }, [obsidionWallet, checkSpent, scanRevision])

  const migratable = residuals.find((r) => r.balance > 0n)
  const scanFailed = residuals.some((r) => r.incomplete)
  const amount = migratable ? usd(Number(formatUnits(migratable.balance, DEFAULT_DECIMALS))) : ""
  // Read per deployment pair; a failed read shows no fee and blocks nothing.
  const fee = useQuery({
    queryKey: ["migration-fee", migratable?.tuple.portal, current?.portal],
    queryFn: () => loadMigrationFee(migratable!.tuple, current!),
    enabled: !!migratable && !!current,
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

  // Residuals with nothing to do right now (a deposit in transit, a paylink still in its claim
  // window) are a notification, not a boot modal: the modal asks only for an action.
  const notes = residuals.flatMap(residualNotes)
  const description = notes.join(" · ")
  useEffect(() => {
    if (migratable || !description) return
    void (async () => {
      const store = AppNotificationStore.get(webStorage)
      await store.load()
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
  }, [migratable, description])
  // A complete scan with nothing left retires the row.
  const nothingLeft = scanned && !scanFailed && notes.length === 0
  useEffect(() => {
    if (!nothingLeft) return
    void AppNotificationStore.get(webStorage).dismiss(RESIDUALS_NOTIFICATION_ID).catch(console.warn)
  }, [nothingLeft])

  // Past the hand-off the migration outlives the modal: its withdrawal record's rows report it.
  const left = useRef(false)
  const onLeave = useCallback(() => {
    left.current = true
    setDismissed(true)
  }, [])

  const onMigrate = async () => {
    if (
      !migratable ||
      !current ||
      !obsidionWallet ||
      !obsidionAccount ||
      !tokenService ||
      !contractService
    ) {
      return
    }
    setMigrating(true)
    left.current = false
    try {
      await runIntraRollupMigration({
        wallet: obsidionWallet,
        account: obsidionAccount,
        contractService,
        toTokenService: tokenService,
        historic: migratable.tuple,
        current,
        summary: migrationSummary(formatUnits(migratable.balance, DEFAULT_DECIMALS)),
      })
      setDismissed(true)
      await loadAssets()
      await refresh()
    } catch (error) {
      // Back to the prompt: a closed passkey prompt is the user's own no, anything else is shown.
      if (!left.current && !isPasskeyCancelled(error)) {
        showReportableError(error, "migration:intra-rollup")
      }
    } finally {
      setMigrating(false)
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
          <p className="ww-logout__body">Reload to move your funds to it.</p>
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

  if (dismissed || (!migratable && !scanFailed)) return null

  const close = () => setDismissed(true)
  return (
    <Modal
      variant="bare"
      label="Move your funds"
      className="ww-modal--create"
      onClose={migrating ? undefined : close}
    >
      <div data-testid="migration-detected-modal" className="ww-migration">
        {migrating ? (
          <OperationHandOff onLeave={onLeave} />
        ) : (
          <>
            <div className="ww-modal__close">
              <TopNavIconButton icon="x" ariaLabel="Close" onClick={close} />
            </div>
            <GradientText gradient="title" size={24} weight={700} style={{ textAlign: "center" }}>
              {migratable ? "Move your funds" : "Couldn't check your old funds"}
            </GradientText>
            <p className="ww-migration__lead">
              {migratable
                ? `${amount} sits on a retired version of the network. Move it now. ` +
                  "One tap, your keys stay the same."
                : "Some funds on a retired version could not be checked. Try again to see them."}
            </p>
            {migratable && (
              <div className="ww-pay__summary">
                <ConfirmationSheetDetailRow label="Amount" value={amount} />
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
            {migratable && notes.length > 0 && (
              <p className="ww-migration__note">Also there: {notes.join(" · ")}.</p>
            )}
            {pendingWithdrawals > 0 && (
              <p className="ww-migration__note" data-testid="migration-pending-withdrawals">
                {pendingWithdrawals} withdrawal(s) in progress are unaffected.
              </p>
            )}
            {migratable ? (
              <PrimaryGradientButton
                title={busy ? busyLabel : "Move funds"}
                isDisabled={busy}
                onClick={() => void onMigrate()}
              />
            ) : (
              <PrimaryGradientButton
                title="Try again"
                isDisabled={refreshing}
                onClick={() => void refresh()}
              />
            )}
            <button
              type="button"
              className="zkm-btn-reset ww-migration__later"
              onClick={() => setDismissed(true)}
            >
              Later
            </button>
          </>
        )}
      </div>
    </Modal>
  )
}

/** What a residual that needs no action right now amounts to, in a few words each. */
function residualNotes(r: HistoricResidualSummary): string[] {
  const notes: string[] = []
  if (r.sweptDeposits > 0) notes.push(`${r.sweptDeposits} unclaimed deposit(s)`)
  if (r.inTransitDeposits > 0) notes.push(`${r.inTransitDeposits} deposit(s) in transit`)
  if (r.paylinkEscrows > 0) notes.push(`${r.paylinkEscrows} open paylink(s)`)
  if (r.lockedPaylinks.length > 0) {
    notes.push(
      `${r.lockedPaylinks.length} paylink(s) locked until ${lockedUntilLabel(r.lockedPaylinks)}`,
    )
  }
  return notes
}
