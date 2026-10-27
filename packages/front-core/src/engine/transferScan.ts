import type { WalletBalanceRead, WalletBalances } from "@obsidion/sdk"
import type { WalletSyncCoordinator } from "../core/services/transactions/WalletSyncCoordinator"
import {
  TRANSFER_SCAN_POLL_INTERVAL_MS,
  type TransferScanContext,
  type TransferScanPass,
} from "../core/services/transactions/TransferEventScanner"
import { bestEffort, WalletError } from "./errors"
import { within, type TaskCtx, type TaskDef } from "./runtime"
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
export function transferScanTask(
  pass: (opts: TransferScanPass, ctx: TaskCtx) => Promise<boolean>,
): TaskDef {
  return {
    id: "transferScan",
    cadence: TRANSFER_SCAN_POLL_INTERVAL_MS,
    backoff: { baseMs: 2 * TRANSFER_SCAN_POLL_INTERVAL_MS, maxMs: 60_000 },
    async run(ctx) {
      if (!(await pass({ full: ctx.woken, signal: ctx.signal }, ctx)))
        throw new WalletError("scan.incomplete")
    },
  }
}

type SyncCoordinator = Pick<WalletSyncCoordinator, "pass" | "attach">
type Token = { address: string; symbol: string; decimals: number }

export interface TransferScanDeps {
  context: TransferScanContext
  /** Main's token. A throw is retried by the next run. */
  token(): Promise<Token>
  main: BalanceReader
  /** The coordinator over Main's token, reading every balance through `readBalances`. */
  coordinator(token: Token, readBalances: () => Promise<WalletBalanceRead>): SyncCoordinator
  /** The runtime's visibility: the coordinator's refreshes run passes only while it holds. */
  visible?: ReadonlyStore<boolean>
}

export interface TransferScan {
  readonly task: TaskDef
  /** Reads `reader` beside Main's balance at every synced anchor. */
  alsoRead(address: string, reader: BalanceReader): void
  dispose(): void
}

/** The wallet's chain sync: the coordinator, built on the first run that reads Main's token. */
export function createTransferScan(deps: TransferScanDeps): TransferScan {
  const others = new Map<string, BalanceReader>()
  let coordinator: SyncCoordinator | undefined
  let detach: (() => void) | undefined
  let disposed = false

  const build = async (ctx: TaskCtx) => {
    const token = await within(deps.token(), "token", { signal: ctx.signal })
    const built = deps.coordinator(token, async () => {
      const balances: WalletBalances = {}
      const readAt: Record<string, number> = {}
      // Each token is stamped when its read resolves: a Savings claim stored after it is missing.
      const stamp = (address: string, atomic: bigint) => {
        balances[address] = atomic
        readAt[address] = Date.now()
      }
      stamp(token.address, await deps.main.readBalanceAssumingSynced())
      // Another token's failed read leaves Main's standing; the next pass reads it again.
      for (const [address, reader] of others) {
        const atomic = await bestEffort("balance.unread", reader.readBalanceAssumingSynced())
        if (atomic !== undefined) stamp(address, atomic)
      }
      return { balances, readAt }
    })
    if (!disposed)
      detach = built.attach({
        wake: () => ctx.wake("transferScan"),
        live: () => !disposed && (deps.visible?.get() ?? true),
      })
    return built
  }

  return {
    alsoRead: (address, reader) => others.set(address, reader),
    task: transferScanTask(async (opts, ctx) => {
      coordinator ??= await build(ctx)
      return coordinator.pass(deps.context, opts)
    }),
    dispose() {
      disposed = true
      detach?.()
    },
  }
}

/** Savings' token, looked up at its boot stage; from then on its shares are read beside Main's. */
export function createSavingsLookup(deps: {
  lookup(): Promise<(BalanceReader & { tokenAddress: { toString(): string } }) | undefined>
  scan: Pick<TransferScan, "alsoRead">
  refreshBalance(): Promise<void>
}): TaskDef {
  return {
    id: "savingsLookup",
    stage: "savings",
    cadence: "once",
    backoff: { baseMs: SAVINGS_LOOKUP_RETRY_MS, maxMs: SAVINGS_LOOKUP_RETRY_MS },
    async run({ signal }) {
      const savings = await within(deps.lookup(), "savingsLookup", { signal })
      if (!savings) return
      deps.scan.alsoRead(savings.tokenAddress.toString(), savings)
      await within(deps.refreshBalance(), "refreshBalance", { signal })
    },
  }
}
