import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  cancelRotation,
  dismissRotation,
  fundRotation,
  noteRecovery,
  recordMoved,
  serviceStatus,
  signRotation,
  UNREAD,
  useStore,
  type BackupRotationRecord,
  type QueryState,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { currentDevicePosture, type BackupAddChoice } from "@obsidion/passkey-web"
import type { Address } from "viem"
import { backupPasskeySettingsEnabled } from "../../../config/features"
import { reloadPage } from "../../../platform/storage/walletStorage"
import { handOffAccount, useSession } from "../../../session/session"
import { useScreenFlow } from "../../../ui/useScreenFlow"
import { useSponsoredAllowance } from "../../allowance/useSponsoredAllowance"
import { DepositExitModal } from "../../deposit/DepositExitModal/DepositExitModal"
import { EmptyDepositError } from "../../deposit/depositReadErrors"
import type { StrandedToken } from "../../deposit/recovery/sipaRecovery"
import {
  useSponsoredRailPending,
  useSponsoredRailReadFailed,
} from "../../registration/sponsoredRailReadiness"
import { backupAddSheetOptions } from "../backupAddOptions"
import { fundingBlock, useBackupAddRelease } from "../backupAddTime"
import { warnFailure, type BackupStep } from "../backupFailure"
import { startBackupAdd } from "../backupPasskeyAdd"
import type { EntryAction } from "../backupPasskeyEntry"
import { useBackupEntryFacts } from "../backupPasskeyFacts"
import {
  buildBackupAddDeps,
  buildBackupFlowDeps,
  type BackupFlowDeps,
} from "../backupPasskeyRuntime"
import { deviceBound } from "../backupReminder"
import { useBackupRotation, type BackupRotationState } from "../backupRotations"
import { openFundFitFlow, type FundFit } from "../fundFitFlow"
import { useFasterWithdrawal } from "../../withdraw/useFasterWithdrawal"
import {
  entryShows,
  pendingRecord,
  recoveryKey,
  selectBackupScreen,
  timeShows,
  type BackupActions,
  type BackupRead,
  type BackupScreen,
  type BackupScreenInput,
  type EntryInput,
  type KeysRead,
} from "../backupScreen"
import { getRotationDriver, useRotationDrive } from "../rotationDrive"
import { sessionRecord } from "../useBackupNudge"
import { AddingScreen } from "../screens/AddingScreen/AddingScreen"
import { ApproveScreen } from "../screens/ApproveScreen/ApproveScreen"
import { BlockedScreen } from "../screens/BlockedScreen/BlockedScreen"
import { DoneScreen } from "../screens/DoneScreen/DoneScreen"
import { FailedScreen } from "../screens/FailedScreen/FailedScreen"
import { FinishScreen } from "../screens/FinishScreen/FinishScreen"
import { FirstPasskeyScreen } from "../screens/FirstPasskeyScreen/FirstPasskeyScreen"
import { IntroScreen } from "../screens/IntroScreen/IntroScreen"
import { LoadingScreen } from "../screens/LoadingScreen/LoadingScreen"
import { KeysScreen } from "../screens/KeysScreen/KeysScreen"
import { PlaceScreen } from "../screens/PlaceScreen/PlaceScreen"
import { RecoveryScreen } from "../screens/RecoveryScreen/RecoveryScreen"
import { UnavailableScreen } from "../screens/UnavailableScreen/UnavailableScreen"
import { UnreadableScreen } from "../screens/UnreadableScreen/UnreadableScreen"

const sameOwner = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** A deployment tuple's l2 token once read; null where the deployment has no such tuple. */
const l2Token = (s: QueryState<OxideEnvTuple | null>) =>
  s.status === "ready" ? s.value?.l2Token ?? null : undefined

/** The add's own reads, mounted only while a new add can show. */
function EntryReads({
  verified,
  laptop,
  children,
}: {
  verified: boolean
  laptop: boolean
  children: (entry: EntryInput, refresh: () => void) => ReactNode
}) {
  const allowance = useSponsoredAllowance()
  const chain = useBackupEntryFacts(verified)
  const registering = useSponsoredRailPending()
  const railFailed = useSponsoredRailReadFailed()
  const { page } = useSession()
  // The entry waits for this read, so a device whose own manager cannot hold a backup sees its
  // line before any press opens the sheet.
  const device = useStore(page.userAgent)
  const reachRead = useStore(laptop ? page.phoneReach : UNREAD)
  const reach = reachRead.status === "ready" ? reachRead.value : undefined
  // The page's own reads are taken once, when the probe settles.
  const place = useMemo(
    () => (laptop && reach ? backupAddSheetOptions({ reach }) : undefined),
    [laptop, reach],
  )
  const entry: EntryInput = {
    allowance: allowance.snapshot,
    facts: chain.facts,
    railFailed,
    ...(registering !== undefined && { registering }),
    ...(device && { device }),
    ...(place && { place }),
  }
  return children(entry, () => {
    allowance.refresh()
    chain.refresh()
  })
}

/** The Fund step's fit read, mounted while the funding waits on the user. */
function PayReads({
  deps,
  children,
}: {
  deps: BackupFlowDeps
  children: (fit: FundFit) => ReactNode
}) {
  const session = useSession()
  const flow = useScreenFlow({ deps, balances: session.balances.view }, (inputs) =>
    openFundFitFlow(inputs()),
  )
  return children(useStore(flow.state))
}

interface HostProps {
  keys: KeysRead
  /** `keys` is an earlier read while a new one is out. */
  refreshing?: boolean
  /** The L1 account the keys are installed on, once read. */
  owner?: Address
  onAction?: (action: EntryAction) => void
  /** Reads the account's keys again: after a failed read, and once an attempt ends. */
  onReadKeys: () => void
  onClose?: () => void
}

/**
 * The backup passkey under the key list: the account's saved rotation, and the flow's
 * dependencies for it.
 */
export function BackupPasskeyHost(props: HostProps) {
  const session = useSession()
  const walletBuilt = useStore(session.wallet, serviceStatus) === "ready"
  const saved = useBackupRotation(props.owner)
  const flow = useFlowDeps(pendingRecord(props.keys, saved), walletBuilt)
  return <BackupPasskeyScreens {...props} saved={saved} flow={flow} walletBuilt={walletBuilt} />
}

/** The flow's dependencies for the pending record, as `useFlowDeps` builds them. */
export interface FlowDeps {
  state: BackupScreenInput["deps"]
  deps?: BackupFlowDeps
  retry: () => void
}

/**
 * Renders the screen `selectBackupScreen` picks for the saved rotation, its driver and the add's
 * conditions, and runs the steps its screens tap. Closing it ends what its taps started: an add in
 * flight, and a send that has not prompted yet.
 */
export function BackupPasskeyScreens({
  keys,
  refreshing,
  owner,
  saved,
  flow,
  walletBuilt,
  onAction,
  onReadKeys,
  onClose,
}: HostProps & { saved: BackupRotationState; flow: FlowDeps; walletBuilt: boolean }) {
  const session = useSession()
  const record = pendingRecord(keys, saved)
  const drive = useRotationDrive(record?.owner ?? "")
  const now = useStore(session.page.wallClock)
  // The move's tokens, read on the attempt's last step, which names each balance by them.
  const { chain } = session.page
  const moving =
    record?.phase === "rerooted" || record?.phase === "moved" || record?.attention === "move"
  const mainToken = useStore(moving ? chain.feeTokenBridgeTuple : UNREAD, l2Token)
  const savingsToken = useStore(moving ? chain.savingsTuple : UNREAD, l2Token)
  const passkey = useStore(session.device, sessionRecord)
  const [laptop] = useState(() => currentDevicePosture() === "laptop")
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<BackupScreenInput["failure"]>()
  // Tagged with its attempt: a read that lands after the attempt changed opens nothing.
  const [recovering, setRecovering] = useState<{ attemptId: string; token: StrandedToken }>()
  const [emptyUnder, setEmptyUnder] = useState<string>()
  const [cancelled, setCancelled] = useState(false)
  const [start, setStart] = useState<"intro" | "place">()
  const [picked, setPicked] = useState<BackupAddChoice>()
  const funding = useFundingRow(record)
  const release = useBackupAddRelease(timeShows({ keys, saved, start }), fundingBlock(funding))
  // The intro's time is for the speed the pay step opens on, so it reads the same offer.
  const { offer } = useFasterWithdrawal({ active: !record && start !== undefined })
  // What the taps found belongs to the attempt they ran on: another attempt, or none, starts clean.
  const attempt = record?.attemptId ?? null
  const [shown, setShown] = useState(attempt)
  if (shown !== attempt) {
    setShown(attempt)
    setFailure(undefined)
    setRecovering(undefined)
    setEmptyUnder(undefined)
    setStart(undefined)
    setPicked(undefined)
  }
  const open = useRef<AbortController>(undefined)
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    const controller = new AbortController()
    open.current = controller
    return () => controller.abort()
  }, [])

  const run = async (step: BackupStep, action: () => Promise<unknown>, attemptId?: string) => {
    setBusy(true)
    setFailure(undefined)
    try {
      await action()
    } catch (err) {
      if (open.current?.signal.aborted || recordMoved(err)) return
      warnFailure(step === "add" ? "add failed" : "step failed", err)
      setFailure({ step, error: err, ...(attemptId && { attemptId }) })
    } finally {
      setBusy(false)
    }
  }
  /** A step over the pending record, once its dependencies are built. */
  const onRecord = (
    step: BackupStep,
    action: (deps: BackupFlowDeps, record: BackupRotationRecord) => Promise<unknown>,
  ) => {
    const { deps } = flow
    if (record && deps) void run(step, () => action(deps, record), record.attemptId)
  }
  const driver = getRotationDriver()
  /** The tip the last funding was sent with. */
  const lastTip = useRef(0n)
  const retryRead = (read: BackupRead) => {
    if (read === "keys") onReadKeys()
    else if (read === "records") void reloadPage()
    else if (read === "deps") flow.retry()
  }
  const actions: BackupActions = {
    add: (choice) => {
      if (typeof keys !== "object" || !owner || !walletBuilt) return
      void run("add", async () => {
        const deps = await buildBackupAddDeps({
          session,
          owner,
          ...(choice && { choice }),
        })
        await startBackupAdd(deps, open.current?.signal)
        setCancelled(false)
      })
    },
    pick: setPicked,
    start: setStart,
    approve: () =>
      onRecord("approve", async (deps, record) =>
        signRotation(deps, record, await deps.prepare(record)),
      ),
    fund: (proverTip = lastTip.current) => {
      lastTip.current = proverTip
      onRecord("fund", (deps, record) => fundRotation(deps, record, proverTip))
    },
    approveMove: () =>
      onRecord("move", (_, record) => driver.approve(record.owner, open.current?.signal)),
    retryMove: () =>
      onRecord("move", (_, record) => driver.retry(record.owner, open.current?.signal)),
    check: () => {
      setFailure(undefined)
      if (record) driver.check(record.owner)
    },
    cancel: () =>
      onRecord("cancel", async (deps, record) => {
        await cancelRotation(deps, record)
        setCancelled(true)
      }),
    recover: () =>
      onRecord("recover", async (deps, record) => {
        setEmptyUnder(undefined)
        let found: StrandedToken
        try {
          found = await deps.strandedDeposit(record)
        } catch (err) {
          // Nothing to recover is not a failure: the card says so in its own neutral line.
          if (err instanceof EmptyDepositError) return setEmptyUnder(recoveryKey(record))
          throw err
        }
        setRecovering({ attemptId: record.attemptId, token: found })
      }),
    finish: () =>
      onRecord("finish", async (deps, record) => {
        await dismissRotation(deps, record)
        onReadKeys()
      }),
    dismiss: () => setFailure(undefined),
    retryRead,
    ...(onAction && { act: onAction }),
    ...(onClose && { close: onClose }),
  }
  const input: BackupScreenInput = {
    keys,
    ...(refreshing && { keysRefreshing: true }),
    saved,
    deps: flow.state,
    ...(drive && { drive }),
    ...(mainToken &&
      savingsToken !== undefined && {
        tokens: { main: mainToken, ...(savingsToken && { savings: savingsToken }) },
      }),
    ...(funding && { funding }),
    ...(release && { release }),
    ...(offer && { offer }),
    addable: backupPasskeySettingsEnabled,
    laptop,
    oneDevice: passkey !== undefined && deviceBound(passkey),
    ...(start && { start }),
    ...(picked && { picked }),
    ...(failure && { failure }),
    busy,
    ...(emptyUnder && { emptyUnder }),
    cancelled,
    now,
  }
  return (
    <>
      {walletBuilt && entryShows(input) ? (
        <EntryReads verified={keys !== "unverified"} laptop={laptop}>
          {(entry, refresh) => (
            <Screen
              screen={selectBackupScreen({ ...input, entry })}
              actions={{
                ...actions,
                retryRead: (read) => (read === "entry" ? refresh() : retryRead(read)),
              }}
            />
          )}
        </EntryReads>
      ) : record?.phase === "published" && flow.deps ? (
        <PayReads deps={flow.deps}>
          {(fit) => <Screen screen={selectBackupScreen({ ...input, fit })} actions={actions} />}
        </PayReads>
      ) : (
        <Screen screen={selectBackupScreen(input)} actions={actions} />
      )}
      {recovering && recovering.attemptId === record?.attemptId && (
        <DepositExitModal
          record={recovering.token.record}
          reason="stranded"
          canSweep={false}
          stranded={recovering.token}
          onRecovered={(hash) =>
            onRecord("recover", (deps, pending) => noteRecovery(deps, pending, hash))
          }
          onClose={() => setRecovering(undefined)}
        />
      )}
    </>
  )
}

/** The attempt's funding as the withdrawal tracker has it; each send writes the same row. */
function useFundingRow(record: BackupRotationRecord | null): WithdrawalRecord | undefined {
  const session = useSession()
  const { records } = useStore(session.withdrawals.list)
  const localId = record?.fundings.at(-1)?.localId
  return localId === undefined ? undefined : records.find((row) => row.localId === localId)
}

/**
 * The flow's dependencies for the pending record's account, built from the record and the session,
 * so its screens stand whether or not the key list was read.
 */
function useFlowDeps(record: BackupRotationRecord | null, walletBuilt: boolean): FlowDeps {
  const session = useSession()
  const [built, setBuilt] = useState<{ owner: string; flow: BackupFlowDeps }>()
  const [failed, setFailed] = useState(false)
  const [runs, setRuns] = useState(0)
  // A wallet that rebuilds goes unbuilt first: dependencies over the old one are dropped.
  if (!walletBuilt && built) setBuilt(undefined)
  const current = record && walletBuilt && built && sameOwner(built.owner, record.owner)
  // Every write of the record builds again after a failed build, as the chain may have answered.
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (!record || !walletBuilt || current) return
    let stale = false
    setFailed(false)
    // In the record's casing, which the flow keeps.
    const owner = record.owner
    buildBackupFlowDeps({
      session,
      owner: owner as Address,
      switchAccount: (account) => handOffAccount(session, account),
    }).then(
      (flow) => {
        if (!stale) setBuilt({ owner, flow })
      },
      (err: unknown) => {
        warnFailure("dependencies failed", err)
        if (!stale) setFailed(true)
      },
    )
    return () => {
      stale = true
    }
  }, [record, walletBuilt, current, runs, session])
  return {
    state: !walletBuilt ? "none" : current ? "ready" : failed ? "failed" : "building",
    ...(current && { deps: built.flow }),
    retry: () => setRuns((n) => n + 1),
  }
}

function Screen({ screen, actions }: { screen: BackupScreen; actions: BackupActions }) {
  switch (screen.id) {
    case "loading":
      return <LoadingScreen screen={screen} actions={actions} />
    case "keys":
      return <KeysScreen screen={screen} actions={actions} />
    case "intro":
      return <IntroScreen screen={screen} actions={actions} />
    case "place":
      return <PlaceScreen screen={screen} actions={actions} />
    case "blocked":
      return <BlockedScreen screen={screen} actions={actions} />
    case "unavailable":
      return <UnavailableScreen screen={screen} actions={actions} />
    case "unreadable":
      return <UnreadableScreen screen={screen} actions={actions} />
    case "firstPasskey":
      return <FirstPasskeyScreen screen={screen} actions={actions} />
    case "approve":
      return <ApproveScreen screen={screen} actions={actions} />
    case "adding":
      return <AddingScreen screen={screen} actions={actions} />
    case "finish":
      return <FinishScreen screen={screen} actions={actions} />
    case "done":
      return <DoneScreen screen={screen} actions={actions} />
    case "failed":
      return <FailedScreen screen={screen} actions={actions} />
    case "recovery":
      return <RecoveryScreen screen={screen} actions={actions} />
  }
}
