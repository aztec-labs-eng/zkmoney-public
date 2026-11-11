import type { Fr } from "@aztec-labs/aztec.js/fields"
import {
  bestEffort,
  checkSpentViaPaylinkService,
  createTransferEventSource,
  memoryStore,
  rebuildPaylinks,
  sweepLinks,
  task,
  within,
  type Transfers,
  type Operations,
  type Paylinks,
  type After,
  type Database,
  type ReadonlyStore,
  type Task,
  type Service,
} from "@obsidion/front-core"
import {
  PaylinkService,
  encodePaylinkInline,
  type ContractService,
  type ObsidionAccount,
  type ObsidionWallet,
  type TokenService,
} from "@obsidion/sdk"

const SWEEP_MS = 60_000
const RESCAN_AFTER: After = { firstBalance: true, depositsReplayed: true, movesReplayed: true }

export interface PaylinkSweep {
  task: Task
  /** Undefined before a pass ends; false while the latest pass failed or deferred a link. */
  rescanned: ReadonlyStore<boolean | undefined>
  /** A recheck asked for is in flight: an open link's recovery waits for its answer. */
  checking: ReadonlyStore<boolean>
  /** Runs a pass now, as when a sent link's detail opens; `checking` until it ends. */
  recheck(): void
}

/** A visitor's: it made no links, so nothing is rescanned or checked. */
export const NO_SWEEP: Omit<PaylinkSweep, "task"> = {
  // eslint-disable-next-line no-restricted-syntax -- ZKM-1778
  rescanned: memoryStore<boolean | undefined>(undefined).readonly,
  // eslint-disable-next-line no-restricted-syntax -- ZKM-1778
  checking: memoryStore(false).readonly,
  recheck() {},
}

/** One pass over the sent links: the rebuild from chain, then the claim sweep. */
export interface SweepPass {
  /** Whether the rebuild read every link the account made. */
  rescan(signal: AbortSignal): Promise<boolean>
  /** Writes nothing once `signal` aborts. */
  reconcile(signal: AbortSignal): Promise<void>
}

export type SweepNeeds = {
  wallet: Service<ObsidionWallet>
  account: Service<ObsidionAccount>
  token: Service<TokenService>
  contractService: Service<ContractService>
}
type NeedValues = {
  [K in keyof SweepNeeds]: SweepNeeds[K] extends Service<infer V> ? V : never
}

/**
 * Creator-side link upkeep: rebuilds the sent links this browser never had, then sweeps them
 * against the chain's nullifiers, flipping a claimed one. A failed rebuild still sweeps.
 */
export function paylinkSweep(
  needs: SweepNeeds,
  open: (values: NeedValues) => SweepPass,
  wake: (task: Task) => Promise<void>,
): PaylinkSweep {
  const rescanned = memoryStore<boolean | undefined>(undefined)
  const checking = memoryStore(false)
  const sweep = task("paylinkSweep", {
    needs,
    after: RESCAN_AFTER,
    every: SWEEP_MS,
    async run({ signal, wallet, account, token, contractService }) {
      const pass = open({ wallet, account, token, contractService })
      const rescan = within(pass.rescan(signal), "paylink rescan", { signal })
      const complete = (await bestEffort("unknown", rescan)) ?? false
      if (signal.aborted) return
      rescanned.set(complete)
      await within(pass.reconcile(signal), "paylink sweep", { signal })
    },
  })
  let asked = 0
  return {
    task: sweep,
    rescanned: rescanned.readonly,
    checking: checking.readonly,
    recheck() {
      const mine = ++asked
      checking.set(true)
      void wake(sweep).finally(() => mine === asked && checking.set(false))
    },
  }
}

export interface ChainPassDeps {
  transfers: Transfers
  paylinks: Paylinks
  operations: Pick<Operations, "view">
  db: Database
  /** The cached master secret; undefined while the account is locked, which skips the rebuild. */
  secretKey(): Promise<Fr | undefined>
  /** The custom node endpoint the rebuilt rows are scoped to, if any. */
  endpointScope(): string | undefined
}

/** The pass over the account's own funding transfers and the paylink contracts. */
export const chainPass =
  (deps: ChainPassDeps) =>
  ({ wallet, account, token, contractService }: NeedValues): SweepPass => {
    const accountAddress = account.getAddress().toString()
    const paylinkService = new PaylinkService(wallet, account, token, contractService)
    return {
      async rescan(signal) {
        const masterSecret = await deps.secretKey()
        if (!masterSecret) return false
        const info = await token.fetchTokenInformation()
        const { complete } = await rebuildPaylinks({
          source: createTransferEventSource({
            wallet,
            tokenAddress: info.address,
            accountAddress,
            contractService,
          }),
          accountAddress,
          masterSecret,
          networkId: wallet.networkId,
          endpointScope: deps.endpointScope(),
          signal,
          paylinkService,
          linkFor: (params) => `${location.origin}/link#${encodePaylinkInline(params)}`,
          store: deps.transfers,
          links: deps.paylinks,
          db: deps.db,
          token: { address: info.address, symbol: info.symbol, decimals: info.decimals },
        })
        return complete
      },
      reconcile: (signal) =>
        sweepLinks(
          {
            checkSpent: checkSpentViaPaylinkService(paylinkService),
            links: deps.paylinks,
            operations: deps.operations,
            transfers: deps.transfers,
          },
          wallet.networkId,
          signal,
        ),
    }
  }
