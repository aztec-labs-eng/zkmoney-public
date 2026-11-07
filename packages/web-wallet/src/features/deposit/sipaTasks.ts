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
  bestEffort,
  claimSipaDeposits,
  createResolverWindow,
  deploymentScanRange,
  derived,
  ensureDirectMigrationDepositRecords,
  loadRecords,
  scanSipaDeposits,
  readyValue,
  selfSipaResolverKeys,
  stopIfAborted,
  task,
  UpgradeActivity,
  upsertDepositL1WalletContact,
  within,
  memoryStore,
  type CatchUp,
  type Database,
  type Milestones,
  type ReadonlyStore,
  type Resource,
  type ResourceState,
  type SipaClaimResult,
  type SipaDeposit,
  type SipaDeposits,
  type SipaScanResult,
  type SipaRow,
  type Task,
} from "@obsidion/front-core"
import {
  migrationDirectCommitment,
  SipaSelfResolver,
  type ObsidionAccount,
  type ObsidionWallet,
  type TokenService,
} from "@obsidion/sdk"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { getConfig } from "../../config/env"
import { getOxideTuple, l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { fireEvent } from "../../lib/analytics"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { registrationScheduleForSipa, type Registrations } from "../registration/webRegistration"
import { l2TokenService } from "../token/l2TokenService"
import { txAmountCap } from "../token/oxideToken"
import type { FundingStamps } from "./fundDeposit"
import {
  pinnedToken,
  railRows,
  type ResolverDeploymentsRead,
  type SipaDiscovery,
  type SipaKeys,
} from "./sipaRail"

/** While a screen watches an address, L1 is read this often. */
const WATCH_MS = 4_000
/** A full pass while anything is in flight; L1 alone in signup's custody. */
const ACTIVE_MS = 12_000
/** A full pass once nothing is expected to change soon. */
const IDLE_MS = 60_000
/** How long one read of the resolver deployments serves the window. */
const RESOLVER_DEPLOYMENTS_TTL_MS = 15 * 60_000

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
  let last: Promise<unknown> = Promise.resolve()
  return <T>(
    label: string,
    signal: AbortSignal | undefined,
    pass: () => Promise<T>,
  ): Promise<T> => {
    const next = last.then(() => {
      stopIfAborted(signal, label)
      return pass()
    })
    last = Promise.allSettled([next])
    return next
  }
}

export interface SipaPipelineDeps {
  store: SipaDeposits
  registrations: Registrations
  db: Pick<Database, "get" | "write">
  wallet: Resource<ObsidionWallet>
  keys: Resource<SipaKeys>
  discovery: Resource<SipaDiscovery>
  deployments: Resource<ResolverDeploymentsRead>
  account: Resource<ObsidionAccount>
  token: Resource<TokenService>
  milestones: Pick<Milestones, "mark" | "progress">
  visible: ReadonlyStore<boolean>
  catchUp: CatchUp
  /** A registration holds funds in signup's custody. */
  custody: ReadonlyStore<boolean>
  stamps: FundingStamps
  /** Reads the balance after claims landed. */
  refreshBalance(): Promise<void>
  /** Owes the landed broadcast of `sipa` again from L2 block `sinceBlock`; false when none landed. */
  republish(sipa: Address, sinceBlock: number): Promise<boolean>
}

/** A pass's inputs read once per run. */
async function railInputs(store: SipaDeposits, networkId: string) {
  const config = getConfig()
  const tuple = await getOxideTuple(config)
  const [meta, rows] = await Promise.all([pinnedToken(config, tuple), railRows(config)])
  // Every sweep recorded before rows was claimed through the pinned bridge.
  await store.stampSweepRows(networkId, {
    portal: requireTupleField(tuple, "portal") as Address,
    l2Token: requireTupleField(tuple, "l2Token"),
    token: meta,
  })
  return { config, tuple, rows }
}

const WATCHING: ResourceState<number> = { status: "ready", value: WATCH_MS }
const IN_CUSTODY: ResourceState<number> = { status: "ready", value: ACTIVE_MS }
const UNWATCHED: ResourceState<number> = { status: "pending" }

export function sipaPipeline(deps: SipaPipelineDeps) {
  const { store } = deps
  const watchers = memoryStore(0)
  /** Ready, with the pace to read L1 at, while a screen watches or signup holds funds. */
  const shownAddresses: Resource<number> = {
    ...derived([watchers.readonly, deps.custody], (n, custody) =>
      n > 0 ? WATCHING : custody ? IN_CUSTODY : UNWATCHED,
    ),
    name: "sipaShownAddresses",
    demand() {},
    retry() {},
    close() {},
  }
  const observedAt = memoryStore<number | undefined>(undefined)
  /** The head's time at the last balance read, ms epoch. */
  const chainTime = memoryStore<number | undefined>(undefined)
  const window = createResolverWindow()
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
      onFundingWalletDetected: upsertDepositL1WalletContact,
      onSweptAddressFunded: async (sipa: Address) => {
        if (!(await deps.republish(sipa, Number(await wallet.node.getBlockNumber()))))
          console.warn(`[sipa] ${sipa} has no landed broadcast to repeat; stuck exits remain`)
      },
      // Only this wallet's own broadcasts can be repeated; a resolver-published address cannot.
      onSweepOverdue: async (sipa: Address) =>
        deps.republish(sipa, Number(await wallet.node.getBlockNumber())),
      // The account has no on-chain creation block, and no deposit to it predates the deployment.
      historyStartBlock: async (head: bigint) =>
        (await deploymentScanRange(publicClient, inputs.tuple, head)).fromBlock,
      txAmountCap: (row: SipaRow) => txAmountCap(publicClient, row.portal),
    }
  }

  const claimDeps = (
    wallet: ObsidionWallet,
    recipient: AztecAddress,
    inputs: { tuple: OxideEnvTuple; rows: readonly SipaRow[] },
    tokenServiceFor: (l2Token: string) => Promise<Pick<TokenService, "claimSweptDeposit">>,
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
    const read = deps.deployments.get()
    if (
      read.status === "failed" ||
      (read.status === "ready" && Date.now() - read.value.at > RESOLVER_DEPLOYMENTS_TTL_MS)
    )
      deps.deployments.retry()
    return window(
      { stealthScalar: keys.stealthKey.scalar, recipient: keys.recipient },
      (await readyValue(deps.deployments, signal)).deployments,
      await loadRecords(store.view),
      // The resolver keys its addresses by the chain's UTC day, not the device's.
      chainTime.get() ?? Date.now(),
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
          await UpgradeActivity.get(webStorage).directBatches()
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
          const inputs = await railInputs(store, wallet.networkId)
          const pinnedL2Token = requireTupleField(inputs.tuple, "l2Token").toLowerCase()
          return claimSipaDeposits({
            ...claimDeps(wallet, keys.recipient, inputs, (l2Token) =>
              l2Token.toLowerCase() === pinnedL2Token
                ? Promise.resolve(token)
                : l2TokenService(wallet, account, l2Token),
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

  /** What every pass leaves for the screens and the funding stamps. */
  const observed = async (result: SipaScanResult) => {
    if (result.chainTime !== undefined) chainTime.set(result.chainTime)
    observedAt.set(Date.now())
    await deps.stamps.drain()
  }

  const check: Task = task("sipaCheck", {
    needs: { wallet: deps.wallet, keys: deps.keys, pace: shownAddresses },
    every: WATCH_MS,
    whenHidden: ACTIVE_MS,
    // Capped near the pace, so a watched screen never waits out a long backoff.
    backoff: { baseMs: 12_000, maxMs: 30_000 },
    async run({ wallet, keys, pace, signal, wake }) {
      const result: SipaScanResult = await within(
        oneAtATime("sipaCheck", signal, async () => {
          const inputs = await railInputs(store, wallet.networkId)
          return scanSipaDeposits({
            ...scanDeps(wallet, keys, keys.recipient, inputs),
            discover: false,
            signal,
          })
        }),
        "sipaCheck",
        { signal },
      )
      await observed(result)
      // New funds or a new sweep: the full pass, and the claim it wakes, run now.
      if (result.found > 0) void wake(scan)
      return { nextMs: pace }
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
      await readyValue(deps.discovery, signal)
      const result: SipaScanResult = await within(
        oneAtATime("sipaScan", signal, async () => {
          const inputs = await railInputs(store, wallet.networkId)
          await bestEffort(
            "scan.incomplete",
            discoverDirectDeposits(keys, wallet.networkId, inputs),
          )
          const candidates = deps.visible.get()
            ? (await bestEffort("scan.incomplete", resolverCandidates(keys, signal))) ?? []
            : []
          return scanSipaDeposits({
            ...scanDeps(wallet, keys, keys.recipient, inputs),
            discover: true,
            resolverCandidates: candidates,
            signal,
          })
        }),
        "sipaScan",
        { signal },
      )
      await observed(result)
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
    /** When a pass last read the chain, ms epoch: what a watching screen shows as last checked. */
    observedAt: observedAt.readonly,
    /** L1 is read at once, then on the watch cadence while any watch is held. Returns the release. */
    watch(): () => void {
      watchers.set(watchers.get() + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        watchers.set(watchers.get() - 1)
      }
    },
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
      await readyValue(deps.discovery)
      return oneAtATime("passFor", undefined, async () => {
        const inputs = await railInputs(store, wallet.value.networkId)
        const scanned = await scanSipaDeposits({
          ...scanDeps(wallet.value, keys.value, recipient, inputs),
          discover: true,
        })
        const claimed = await claimSipaDeposits(
          claimDeps(wallet.value, recipient, inputs, tokenServiceFor),
        )
        return { completed: scanned.complete && claimed.complete, scanned, claimed }
      })
    },
  }
}

export type SipaPipeline = ReturnType<typeof sipaPipeline>
