/**
 * The SIPA pipeline as three session tasks. `sipaCheck` reads L1 alone while a screen shows an
 * address or signup holds funds; `sipaScan` runs the full pass, PXE events included. Both write
 * what the chain says about the account's SIPAs, with the cursor that covers it. `sipaClaim` claims
 * the sweeps they left pending and marks `depositsReplayed`. A previous account (a backup passkey's
 * rotation) runs through the same scan and claim passes on the watcher's own schedule.
 */
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { Address } from "viem"
import {
  deploymentScanRange,
  bestEffort,
  claimSipaDeposits,
  createTurn,
  createResolverWindow,
  derived,
  ensureDirectMigrationDepositRecords,
  loadRecords,
  scanSipaDeposits,
  RESOLVER_SLOTS,
  SELF_SLOTS,
  selfSipaResolverKeys,
  stopIfAborted,
  task,
  type UpgradeActivity,
  upsertDepositL1WalletContact,
  within,
  liveStore,
  memoryStore,
  type CatchUp,
  type Contacts,
  type UpsertDepositL1WalletContactParams,
  type Database,
  type Milestones,
  type ReadonlyStore,
  type SipaClaimResult,
  type SipaDeposit,
  type SipaDeposits,
  type SipaScanResult,
  type SipaRow,
  type Task,
  type Service,
} from "@obsidion/front-core"
import {
  migrationDirectCommitment,
  SipaSelfResolver,
  type ObsidionAccount,
  type ObsidionWallet,
  type TokenService,
} from "@obsidion/sdk"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import type { PageFacts } from "../../session/pageChain"
import type { Session } from "../../session/session"
import { fireEvent } from "../../lib/analytics"
import { registrationScheduleForSipa, type Registrations } from "../registration/webRegistration"
import { l2TokenService } from "../token/l2TokenService"
import {
  pinnedToken,
  railRows,
  windowKeys,
  type ResolverDeployments,
  type SipaDiscovery,
  type SipaKeys,
} from "./sipaRail"

/** While a screen watches an address, L1 is read this often. */
const WATCH_MS = 4_000
/** A full pass while anything is in flight; L1 alone in signup's custody. */
const ACTIVE_MS = 12_000
/** A full pass once nothing is expected to change soon. */
const IDLE_MS = 60_000

/**
 * Reports each address's first claim once, and only one that settled from `since` on: records load
 * in any order, so `endTime` tells history from a live claim. A claim with no `endTime` is history.
 */
export function createClaimSweepReporter(
  since: number = Date.now(),
): (records: readonly SipaDeposit[]) => SipaDeposit[] {
  const seen = new Set<string>()
  return (records) =>
    records.filter((r) => {
      if (r.phase !== "claimed" || seen.has(r.sipaAddress)) return false
      seen.add(r.sipaAddress)
      return r.endTime !== undefined && r.endTime >= since
    })
}

/** Reports failing runs only on the way into failure; a clean run arms the next report. */
export function createSyncFailureReporter(): (failed: number) => boolean {
  let failing = false
  return (failed) => {
    const report = failed > 0 && !failing
    failing = failed > 0
    return report
  }
}

/**
 * Starts each pass once the one before it ended, so no two write the same records at once. A pass
 * whose `signal` aborted while it waited does not start.
 */
export function passQueue() {
  const turn = createTurn()
  return <T>(label: string, signal: AbortSignal | undefined, pass: () => Promise<T>): Promise<T> =>
    turn(() => {
      stopIfAborted(signal, label)
      return pass()
    })
}

export interface SipaPipelineDeps {
  store: SipaDeposits
  registrations: Registrations
  db: Pick<Database, "get" | "write">
  wallet: Service<ObsidionWallet>
  keys: Service<SipaKeys>
  discovery: () => Service<SipaDiscovery>
  deployments: ResolverDeployments
  account: Service<ObsidionAccount>
  token: Service<TokenService>
  milestones: Pick<Milestones, "mark" | "progress">
  visible: ReadonlyStore<boolean>
  catchUp: CatchUp
  /** A registration holds funds in signup's custody. */
  custody: ReadonlyStore<boolean>
  /** Where each deposit's funding wallet is saved. */
  contacts: Pick<Contacts, "upsertL1WalletContact">
  /** Reads the balance after claims landed. */
  refreshBalance(): Promise<void>
  /** Runs the broadcasts a pass owes again. */
  wakeBroadcasts(): void
  /** The upgrade runs, whose direct deposits each get a record. */
  upgrades: Pick<UpgradeActivity, "directBatches">
  page: Pick<Session["page"], "config" | "chain" | "tokenServices">
}

/** A pass's inputs read once per run. */
async function railInputs(page: PageFacts, store: SipaDeposits, networkId: string) {
  const { config } = page
  const tuple = await page.chain.oxideTuple.read()
  const [meta, rows] = await Promise.all([pinnedToken(page, tuple), railRows(page)])
  // Every sweep recorded before rows was claimed through the pinned bridge.
  await store.stampSweepRows(networkId, {
    portal: requireTupleField(tuple, "portal") as Address,
    l2Token: requireTupleField(tuple, "l2Token"),
    token: meta,
  })
  return { config, tuple, rows }
}

export function sipaPipeline(deps: SipaPipelineDeps) {
  const { store } = deps
  const shown = memoryStore(false)
  /** L1 is read while a screen subscribes or signup holds funds. */
  const watched = derived([shown.readonly, deps.custody], (screen, custody) => screen || custody)
  /** The interval to read L1 at: a screen's, else custody's. */
  const l1Interval = derived([shown.readonly], (screen) => (screen ? WATCH_MS : ACTIVE_MS))
  const observedAt = memoryStore<number | undefined>(undefined)
  /** The head's time at the last balance read, ms epoch. */
  const chainTime = memoryStore<number | undefined>(undefined)
  const window = createResolverWindow(RESOLVER_SLOTS)
  const ownWindow = createResolverWindow(SELF_SLOTS)
  // Addresses are keyed by the chain's UTC day, not the device's.
  const chainNow = () => chainTime.get() ?? Date.now()
  /**
   * What the last scan failed, written by `sipaScan` alone: a clean claim run after a clean one
   * replays the deposits.
   */
  const scanFailed = memoryStore<number | undefined>(undefined)
  const reportSweeps = createClaimSweepReporter()
  const reportFailures = createSyncFailureReporter()
  /** The tasks' and `passFor`'s passes, one at a time. */
  const oneAtATime = passQueue()

  const scanDeps = (
    wallet: ObsidionWallet,
    keys: SipaKeys,
    recipient: AztecAddress,
    inputs: Awaited<ReturnType<typeof railInputs>>,
  ) => {
    const publicClient = l1PublicClient(inputs.config)
    return {
      publicClient,
      wallet,
      node: wallet.node,
      masterNullifierHidingKey: keys.nullifierHidingKey,
      store,
      db: deps.db,
      tuple: inputs.tuple,
      recipient,
      stealthPublicKey: keys.stealthKey.publicKey,
      recoveryAccount: keys.recoveryAccount,
      rows: inputs.rows,
      l1ChainId: inputs.config.l1ChainId,
      networkId: wallet.networkId,
      registrationScheduleFor: (sipa: string) =>
        registrationScheduleForSipa(deps.registrations, sipa),
      onFundingWalletDetected: (funder: UpsertDepositL1WalletContactParams) =>
        upsertDepositL1WalletContact(deps.contacts, funder),
      // The account has no on-chain creation block, and no deposit to it predates the deployment.
      historyStartBlock: async (head: bigint) =>
        (await deploymentScanRange(publicClient, inputs.tuple, head)).fromBlock,
      txAmountCap: (row: SipaRow) => deps.page.chain.txAmountCap(row.portal).read(),
    }
  }

  const claimDeps = (
    wallet: ObsidionWallet,
    recipient: AztecAddress,
    inputs: { tuple: OxideEnvTuple; rows: readonly SipaRow[] },
    tokenServiceFor?: (l2Token: string) => Promise<Pick<TokenService, "claimSweptDeposit">>,
  ) => ({
    store,
    node: wallet.node as never,
    recipient,
    tuple: inputs.tuple,
    rows: inputs.rows,
    tokenServiceFor,
  })

  /** The resolver's addresses with no record yet, read while the page is shown. */
  const resolverCandidates = async (keys: SipaKeys, signal: AbortSignal) => {
    return window(
      windowKeys(keys),
      await deps.deployments(keys).read(signal),
      await loadRecords(store.view),
      chainNow(),
    )
  }

  /** Gives each upgrade batch the migration executor deposited straight into a portal its record. */
  const discoverDirectDeposits = async (
    keys: SipaKeys,
    networkId: string,
    inputs: Awaited<ReturnType<typeof railInputs>>,
  ) => {
    const recipient = keys.recipient
    const selfResolver = new SipaSelfResolver(selfSipaResolverKeys(keys.msk))
    await ensureDirectMigrationDepositRecords({
      store,
      // Only this account's runs: a run's key ends in its account (`webMetadataMigrationKey`).
      batches: async () =>
        (
          await deps.upgrades.directBatches()
        ).filter((batch) =>
          batch.run.toLowerCase().endsWith(`/${recipient.toString().toLowerCase()}`),
        ),
      rows: inputs.rows,
      // `webMetadataMigrationKey` saves the run's destination portal as its second segment.
      destinationPortal: (batch) => batch.run.split("/")[1] as Address | undefined,
      recipient: recipient.toString(),
      l1ChainId: inputs.config.l1ChainId,
      networkId,
      secret: (direct) =>
        migrationDirectCommitment(
          { selfResolver, recipient, recoveryAccount: keys.recoveryAccount },
          direct.day,
          direct.nonce,
        ),
    })
  }

  const claim: Task = task("sipaClaim", {
    needs: { wallet: deps.wallet, keys: deps.keys, account: deps.account, token: deps.token },
    after: { firstBalance: true },
    every: ACTIVE_MS,
    whenHidden: ACTIVE_MS,
    backoff: { baseMs: 12_000, maxMs: 300_000 },
    async run({ wallet, keys, account, token, signal }) {
      const result: SipaClaimResult = await within(
        oneAtATime("sipaClaim", signal, async () => {
          const inputs = await railInputs(deps.page, store, wallet.networkId)
          const pinnedL2Token = requireTupleField(inputs.tuple, "l2Token").toLowerCase()
          return claimSipaDeposits({
            ...claimDeps(wallet, keys.recipient, inputs, (l2Token) =>
              l2Token.toLowerCase() === pinnedL2Token
                ? Promise.resolve(token)
                : l2TokenService(deps.page, account, l2Token),
            ),
            refreshBalance: deps.refreshBalance,
            onProgress: (done, total) => deps.milestones.progress("deposits", done, total),
            signal,
          })
        }),
        "sipaClaim",
        { signal },
      )
      if (result.failed > 0) console.warn("[sipa] claim run left", result.failed, "sweep(s)")
      const scanFailures = scanFailed.get()
      if (scanFailures === 0 && result.failed === 0) deps.milestones.mark("depositsReplayed")
      if (reportFailures((scanFailures ?? 0) + result.failed))
        fireEvent("action_failed", { action: "deposit:sync", code: "note_sync_failed" })
      for (const r of reportSweeps(await loadRecords(store.view))) {
        fireEvent("deposit_swept", {
          duration_ms: r.endTime! - r.startTime,
          ...(r.intent === "registration" && { registration: true }),
        })
      }
    },
  })

  /** A scan pass: the broadcasts it owes run at once. */
  const scanPass = async (pass: Parameters<typeof scanSipaDeposits>[0]) => {
    const result = await scanSipaDeposits(pass)
    if (result.republished > 0 || result.resolverFunded > 0) deps.wakeBroadcasts()
    return result
  }

  /** What every pass leaves for the screens. */
  const observed = (result: SipaScanResult) => {
    if (result.chainTime !== undefined) chainTime.set(result.chainTime)
    observedAt.set(Date.now())
  }

  const check: Task = task("sipaCheck", {
    needs: { wallet: deps.wallet, keys: deps.keys },
    when: watched,
    every: l1Interval,
    whenHidden: ACTIVE_MS,
    // Capped near the interval, so a watched screen never waits out a long backoff.
    backoff: { baseMs: 12_000, maxMs: 30_000 },
    async run({ wallet, keys, signal, wake }) {
      const result: SipaScanResult = await within(
        oneAtATime("sipaCheck", signal, async () => {
          const inputs = await railInputs(deps.page, store, wallet.networkId)
          return scanPass({
            ...scanDeps(wallet, keys, keys.recipient, inputs),
            discover: false,
            signal,
          })
        }),
        "sipaCheck",
        { signal },
      )
      observed(result)
      // New funds or a new sweep: the full pass, and the claim it wakes, run now.
      if (result.found > 0) void wake(scan)
    },
  })

  const scan: Task = task("sipaScan", {
    needs: { wallet: deps.wallet, keys: deps.keys },
    // The PXE reads the events once the first balance is in.
    after: { firstBalance: true },
    every: ACTIVE_MS,
    whenHidden: ACTIVE_MS,
    backoff: { baseMs: 12_000, maxMs: 300_000 },
    async run({ wallet, keys, signal, wake }) {
      await deps.discovery().ready(signal)
      const result: SipaScanResult = await within(
        oneAtATime("sipaScan", signal, async () => {
          const inputs = await railInputs(deps.page, store, wallet.networkId)
          await bestEffort(
            "scan.incomplete",
            discoverDirectDeposits(keys, wallet.networkId, inputs),
          )
          const candidates = deps.visible.get()
            ? (await bestEffort("scan.incomplete", resolverCandidates(keys, signal))) ?? []
            : []
          return scanPass({
            ...scanDeps(wallet, keys, keys.recipient, inputs),
            discover: true,
            resolverCandidates: candidates,
            selfCandidates: (deployment, records, salts) =>
              ownWindow(windowKeys(keys), [deployment], records, chainNow(), salts),
            signal,
          })
        }),
        "sipaScan",
        { signal },
      )
      observed(result)
      scanFailed.set(result.failed)
      if (result.resolverFunded > 0) void wake(scan)
      // History replayed onto this device holds the balance and activity placeholders until its
      // claims refreshed the chain view; otherwise the claim run joins a catch-up in progress.
      const end = result.replaying || deps.catchUp.status.get() ? deps.catchUp.begin() : undefined
      try {
        if (end) await wake(claim)
        else void wake(claim)
      } finally {
        end?.()
      }
      return { nextMs: result.active === 0 ? IDLE_MS : ACTIVE_MS }
    },
  })

  return {
    check,
    scan,
    claim,
    /**
     * When a pass last read the chain, ms epoch: what a screen shows as last checked. While
     * subscribed, L1 is read on the watch cadence, and at once when the last read is older.
     */
    observedAt: liveStore(observedAt.get(), {
      whileSubscribed(set) {
        shown.set(true)
        const off = observedAt.subscribe(() => set(observedAt.get()))
        set(observedAt.get())
        return () => {
          off()
          shown.set(false)
        }
      },
    }),
    /**
     * One scan and claim pass over `recipient`, another account of the session's key, claimed
     * through `tokenServiceFor`. It stays out of the session's catch-up. `completed` is false while
     * locked and when either pass fell short.
     */
    async passFor(
      recipient: AztecAddress,
      tokenServiceFor: (l2Token: string) => Promise<Pick<TokenService, "claimSweptDeposit">>,
    ): Promise<{ completed: boolean; scanned?: SipaScanResult; claimed?: SipaClaimResult }> {
      const wallet = deps.wallet.get()
      const keys = deps.keys.get()
      if (wallet.status !== "ready" || keys.status !== "ready") return { completed: false }

      await deps.discovery().ready()
      return oneAtATime("passFor", undefined, async () => {
        const inputs = await railInputs(deps.page, store, wallet.value.networkId)
        const scanned = await scanPass({
          ...scanDeps(wallet.value, keys.value, recipient, inputs),
          discover: true,
        })
        const claimed = await claimSipaDeposits(
          claimDeps(wallet.value, recipient, inputs, tokenServiceFor),
        )
        return { completed: scanned.complete && claimed.complete, scanned, claimed }
      })
    },
    /**
     * One scan over `recipient`, another account of the session's key, that records the deposits it
     * finds and claims or publishes nothing: that account's history, for Activity. Deposits already
     * claimed, on any device, are saved as claimed so Activity lists them.
     */
    async historyFor(recipient: AztecAddress): Promise<{ completed: boolean }> {
      const wallet = deps.wallet.get()
      const keys = deps.keys.get()
      if (wallet.status !== "ready" || keys.status !== "ready") return { completed: false }

      await deps.discovery().ready()
      return oneAtATime("historyFor", undefined, async () => {
        const inputs = await railInputs(deps.page, store, wallet.value.networkId)
        const scanned = await scanSipaDeposits({
          ...scanDeps(wallet.value, keys.value, recipient, inputs),
          republishes: false,
          discover: true,
        })
        const settled = await claimSipaDeposits(claimDeps(wallet.value, recipient, inputs))
        return { completed: scanned.complete && settled.complete }
      })
    },
  }
}
