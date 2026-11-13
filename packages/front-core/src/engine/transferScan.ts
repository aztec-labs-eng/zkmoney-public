import type {
  ContractService,
  ObsidionAccount,
  ObsidionWallet,
  TokenService,
  WalletBalanceRead,
  WalletBalances,
} from "@obsidion/sdk"
import type { WalletSyncCoordinator } from "../core/services/transactions/WalletSyncCoordinator"
import {
  TRANSFER_SCAN_POLL_INTERVAL_MS,
  type TransferEventScanner,
  type TransferScanPass,
} from "../core/services/transactions/TransferEventScanner"
import { bestEffort, WalletError } from "./errors"
import { BOOT_WAIT_MS, type After } from "./milestones"
import type { Service } from "./service"
import { task, within, type Needs, type RunCtx, type Task } from "./runtime"
import type { ReadonlyStore } from "./store"

/** How long a failed Savings lookup waits before it tries again. */
export const SAVINGS_LOOKUP_RETRY_MS = 30_000

export interface BalanceReader {
  readBalanceAssumingSynced(): Promise<bigint>
}

/**
 * The transfer scan, one pass per run: every 5 s while the page is visible, paused while hidden,
 * backing off to a minute while passes fail. A wake runs a full pass.
 */
export function transferScanTask<const N extends Needs>(
  needs: N,
  pass: (opts: TransferScanPass, ctx: RunCtx<N>) => Promise<boolean>,
): Task {
  return task("transferScan", {
    needs,
    every: TRANSFER_SCAN_POLL_INTERVAL_MS,
    backoff: { baseMs: 2 * TRANSFER_SCAN_POLL_INTERVAL_MS, maxMs: 60_000 },
    async run(ctx) {
      if (!(await pass({ full: ctx.woken, signal: ctx.signal }, ctx)))
        throw new WalletError("scan.incomplete")
    },
  })
}

type SyncCoordinator = Pick<WalletSyncCoordinator, "pass" | "attach" | "readBalanceCoalesced">

type Ready = {
  wallet: ObsidionWallet
  account: ObsidionAccount
  token: TokenService
  contractService: ContractService
}

export type TransferScanDeps = { [K in keyof Ready]: Service<Ready[K]> } & {
  now: () => number
  /** The account's display tag; a nameless account shows its address. */
  tag(): string | undefined
  endpointScope?(): string | undefined
  /** The coordinator's refreshes run passes only while it holds. */
  visible: ReadonlyStore<boolean>
  /** The coordinator over Main's token, reading every balance through `readBalances`. */
  coordinator(ready: Ready, readBalances: () => Promise<WalletBalanceRead>): SyncCoordinator
}

export interface TransferScan {
  readonly task: Task
  /** Reads `reader` beside Main's balance at every synced anchor. */
  alsoRead(address: string, reader: BalanceReader): void
  /** The balances alone at a fresh anchor; a full pass while the coordinator is not live. */
  refreshBalance(): Promise<void>
  dispose(): void
}

/** The wallet's chain sync: a coordinator per value of Main's token. */
export function transferScan(deps: TransferScanDeps): TransferScan {
  const others = new Map<string, BalanceReader>()
  let built:
    | { token: TokenService; coordinator: SyncCoordinator; wake(): Promise<void> }
    | undefined
  let detach: (() => void) | undefined
  let disposed = false
  const live = () => !disposed && deps.visible.get()

  const build = (ready: Ready, wake: () => Promise<void>) => {
    const { account, token } = ready
    const coordinator = deps.coordinator(ready, async () => {
      const balances: WalletBalances = {}
      const readAt: Record<string, number> = {}
      // Each token is stamped when its read resolves: a Savings claim stored after it is missing.
      const stamp = (address: string, atomic: bigint) => {
        balances[address] = atomic
        readAt[address] = deps.now()
      }
      stamp(token.metadata.address, await token.readBalanceAssumingSynced(account))
      // Another token's failed read leaves Main's standing; the next pass reads it again.
      for (const [address, reader] of others) {
        const atomic = await bestEffort("balance.unread", reader.readBalanceAssumingSynced())
        if (atomic !== undefined) stamp(address, atomic)
      }
      return { balances, readAt }
    })
    detach?.()
    detach = disposed ? undefined : coordinator.attach({ wake, canRun: live })
    return (built = { token, coordinator, wake })
  }

  const { wallet, account, token, contractService } = deps
  const scan: Task = transferScanTask({ wallet, account, token, contractService }, (opts, ctx) => {
    const { coordinator } = built?.token === ctx.token ? built : build(ctx, () => ctx.wake(scan))
    const address = ctx.account.getAddress().toString()
    const context = {
      accountAddress: address,
      accountTag: deps.tag() ?? address,
      networkId: ctx.wallet.networkId,
      endpointScope: deps.endpointScope?.(),
    }
    return coordinator.pass(context, opts)
  })
  return {
    task: scan,
    alsoRead: (address, reader) => others.set(address, reader),
    async refreshBalance() {
      if (!built) return
      if (!live()) return built.wake()
      await built.coordinator.readBalanceCoalesced().catch(built.wake)
    },
    dispose() {
      disposed = true
      detach?.()
    },
  }
}

type SavingsToken = { tokenService: BalanceReader & { tokenAddress: { toString(): string } } }

/**
 * The holdings' share tokens, looked up after the first balance; from then on their shares are read
 * beside Main's.
 */
export function savingsLookup<W, A>(deps: {
  wallet: Service<W>
  account: Service<A>
  lookup(wallet: W, account: A): Promise<readonly SavingsToken[]>
  scan: Pick<TransferScan, "alsoRead" | "refreshBalance">
}): Task {
  return task("savingsLookup", {
    needs: { wallet: deps.wallet, account: deps.account },
    after: { firstBalance: BOOT_WAIT_MS },
    every: "once",
    backoff: { baseMs: SAVINGS_LOOKUP_RETRY_MS, maxMs: SAVINGS_LOOKUP_RETRY_MS },
    async run({ wallet, account, signal }) {
      const found = await within(deps.lookup(wallet, account), "savingsLookup", { signal })
      if (found.length === 0) return
      for (const { tokenService } of found) {
        deps.scan.alsoRead(tokenService.tokenAddress.toString(), tokenService)
      }
      await within(deps.scan.refreshBalance(), "refreshBalance", { signal })
    },
  })
}

/**
 * How often a rotated wallet's previous account is scanned. Transfers to it are rare, and each scan
 * syncs the PXE, which queues the user's own reads behind it.
 */
export const PREVIOUS_ACCOUNT_SCAN_MS = 5 * 60_000

/** As every history reader: its PXE syncs wait for the balance, the replays and the history. */
const PREVIOUS_ACCOUNT_SCAN_AFTER: After = {
  firstBalance: true,
  depositsReplayed: true,
  movesReplayed: true,
  historyAtHead: true,
}

type Scanner = Pick<TransferEventScanner, "pass">

export type PreviousAccountScanDeps = { [K in keyof Ready]: Service<Ready[K]> } & {
  now: () => number
  /** The previous account once the PXE can read its events; undefined while there is none. */
  previousAccount(wallet: ObsidionWallet): Promise<string | undefined>
  /** The account's display tag; a nameless account shows its address. */
  tag(): string | undefined
  endpointScope?(): string | undefined
  scanner(ready: Ready, previousAccount: string): Scanner
  /**
   * Rebuilds the paylinks the account made, from its cursor on: a device signed in later lacks
   * them, and a refund's payout lands there. Answers whether it read every link.
   */
  links(ready: Ready, previousAccount: string, signal: AbortSignal): Promise<boolean>
  /**
   * Rebuilds the burns the account made, once a session: a device signed in later lacks them, and
   * a backup passkey's funding is one, which the add's row is priced from. Rejects when it could
   * not read them all.
   */
  burns(ready: Ready, previousAccount: string): Promise<unknown>
}

/**
 * A rotated wallet's previous account's burns, transfers and paylinks, filed into the account's
 * history like its own: a transfer sent there after the rotation keeps its sender, and a device
 * signed in later gets the history from before it. The moves between the two accounts stay out.
 * Links are rebuilt before the transfers are filed, so a link's funding and refund never show as
 * plain transfers first. A step that fails or reads short ends the pass. Showing the page wakes
 * every task, so a show sooner than the cadence after the last pass skips it.
 */
export function previousAccountScan(deps: PreviousAccountScanDeps): Task {
  let built: { previous: string; token: TokenService; scanner: Scanner } | undefined
  let passedAt: number | undefined
  const { wallet, account, token, contractService } = deps
  return task("previousAccountScan", {
    needs: { wallet, account, token, contractService },
    after: PREVIOUS_ACCOUNT_SCAN_AFTER,
    every: PREVIOUS_ACCOUNT_SCAN_MS,
    backoff: { baseMs: 60_000, maxMs: PREVIOUS_ACCOUNT_SCAN_MS },
    async run(ctx) {
      const { signal, woken } = ctx
      const fresh = passedAt !== undefined && deps.now() - passedAt < PREVIOUS_ACCOUNT_SCAN_MS
      if (woken && fresh && built?.token === ctx.token) return
      passedAt = undefined
      const previous = await within(deps.previousAccount(ctx.wallet), "previousAccount", {
        signal,
      })
      if (!previous) return
      const key = previous.toLowerCase()
      if (built?.previous !== key || built.token !== ctx.token)
        built = { previous: key, token: ctx.token, scanner: deps.scanner(ctx, previous) }
      const address = ctx.account.getAddress().toString()
      const context = {
        accountAddress: previous,
        accountTag: deps.tag() ?? address,
        networkId: ctx.wallet.networkId,
        endpointScope: deps.endpointScope?.(),
        ownAccount: address,
      }
      await within(deps.burns(ctx, previous), "previousAccountBurns", { signal })
      if (!(await within(deps.links(ctx, previous, signal), "previousAccountLinks", { signal })))
        throw new WalletError("scan.incomplete")
      if (!(await built.scanner.pass(context, { full: woken, signal })))
        throw new WalletError("scan.incomplete")
      passedAt = deps.now()
    },
  })
}

export interface PreviousAccountHistoryDeps {
  wallet: Service<ObsidionWallet>
  account: Service<ObsidionAccount>
  /** One scan of the account's deposit addresses, with no claim; answers whether it read all. */
  read(wallet: ObsidionWallet): Promise<boolean>
}

/**
 * A rotated wallet's previous account's deposits, found once a session so a device signed in after
 * the rotation lists the history from before it. Funds still waiting there are left to the
 * Passkeys panel's check.
 */
export function previousAccountHistory(deps: PreviousAccountHistoryDeps): Task {
  const { wallet, account } = deps
  return task("previousAccountHistory", {
    needs: { wallet, account },
    after: PREVIOUS_ACCOUNT_SCAN_AFTER,
    every: "once",
    backoff: { baseMs: 60_000, maxMs: 60 * 60_000 },
    async run({ wallet }) {
      if (!(await deps.read(wallet))) throw new WalletError("scan.incomplete")
    },
  })
}

export interface PreviousAccountFindDeps {
  wallet: Service<ObsidionWallet>
  account: Service<ObsidionAccount>
  /** Finds the account from the session's keys and record, and saves it for the feed and bell. */
  find(wallet: ObsidionWallet): Promise<unknown>
}

/**
 * A rotated wallet's previous account, found once a session as it opens: the feed and the bell hide
 * the moves from it, which the account's own scan may file first. A local lookup, it waits on no
 * milestone.
 */
export function previousAccountFind(deps: PreviousAccountFindDeps): Task {
  const { wallet, account } = deps
  return task("previousAccountFind", {
    needs: { wallet, account },
    every: "once",
    backoff: { baseMs: 10_000, maxMs: 5 * 60_000 },
    async run({ wallet }) {
      await deps.find(wallet)
    },
  })
}
