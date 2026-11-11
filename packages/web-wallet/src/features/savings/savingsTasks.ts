import {
  bestEffort,
  derived,
  readSavingsPrice,
  service,
  task,
  tupleField,
  within,
  type Milestones,
  type QueryEntry,
  type QueryFactory,
  type QueryState,
  type ReadonlyStore,
  type SavingsHolding,
  type SavingsPrice,
  type SavingsSource,
  type Service,
  type SettleDue,
  type Task,
  memoryStore,
  useStore,
} from "@obsidion/front-core"
import { WalletError } from "@obsidion/core/errors"
import type { ContractService, ObsidionAccount, ObsidionWallet, TokenService } from "@obsidion/sdk"
import { l1PublicClient } from "../../config/oxideTuple"
import type { PageFacts } from "../../session/pageChain"
import { useSession } from "../../session/session"
import type { rescanWithdrawals } from "../withdraw/withdrawGateway"
import type { savingsRescanToken } from "./savingsGateway"

/** How long a failed read of the deployment, or a failed replay, waits before it tries again. */
export const SAVINGS_RETRY_MS = 30_000
const RETRY = { baseMs: SAVINGS_RETRY_MS, maxMs: SAVINGS_RETRY_MS }

type Ready = [ObsidionWallet, ObsidionAccount, TokenService, ContractService]
type Inputs<T> = { [K in keyof T]: Service<T[K]> }

/** Savings over the account and Main's token; null where the profile has no sUSDS deployment. */
export const openSavingsSource = (
  from: Inputs<Ready>,
  open: (...ready: Ready) => Promise<SavingsSource | null>,
) =>
  service("savings", { from, retry: RETRY }, (ready, signal) =>
    within(open(...ready), "savings", { signal }),
  )

/** How often the vault's share price is read while something shows it. */
export const SAVINGS_PRICE_INTERVAL_MS = 60_000

/** The vault's share price, with the Savings asset of the tuple it was read on. */
export type ChainSavingsPrice = SavingsPrice & { asset: string }

/** The vault's share price on L1; null where the profile has no Savings. */
export async function readChainSavingsPrice(
  { config, chain }: PageFacts,
  signal: AbortSignal,
): Promise<ChainSavingsPrice | null> {
  const tuple = await chain.savingsTuple.read(signal)
  if (!tuple) return null
  const vault = await chain.savingsVault(tupleField(tuple, "portal")).read(signal)
  const price = await readSavingsPrice(l1PublicClient(config), vault, {
    l1ChainId: config.l1ChainId,
  })
  return { ...price, asset: tuple.underlying ?? tuple.token }
}

/**
 * The vault's share price: read after the first balance, then every minute while subscribed and
 * the page shows. A read finds it stale after a minute. A failed read keeps the last price.
 */
export const savingsPrices = (
  query: QueryFactory,
  milestones: Pick<Milestones, "after">,
  read: (signal: AbortSignal) => Promise<ChainSavingsPrice | null>,
) =>
  query<[], ChainSavingsPrice | null>("savingsPrice", {
    poll: SAVINGS_PRICE_INTERVAL_MS,
    load: async (signal) => {
      if (!(await milestones.after({ firstBalance: true }, signal)))
        throw new WalletError("aborted", "the session ended before its first balance")
      return read(signal)
    },
    stale: SAVINGS_PRICE_INTERVAL_MS,
  })()

export type SavingsPriceQuery = ReturnType<typeof savingsPrices>

/** The share price a move out's tray line names; a failed read is logged and names none. */
export const exitSharePrice = async (price: Pick<QueryEntry<SavingsPrice | null>, "read">) =>
  (await bestEffort("unknown", price.read()))?.sharePrice

/** A visitor's: it holds no Savings. */
export const NO_PRICE: ReadonlyStore<QueryState<ChainSavingsPrice | null>> = memoryStore<
  QueryState<ChainSavingsPrice | null>
>({ status: "ready", value: null, refreshing: false }).readonly

/** The vault's price a read gave, null after a failed first read; undefined before one answers. */
export const priceOf = <P extends SavingsPrice>(read: QueryState<P | null>): P | null | undefined =>
  read.status === "ready" ? read.value : read.status === "failed" ? null : undefined

/** How often a pending move's deposit is looked for, shown or hidden. */
const SAVINGS_SETTLE_INTERVAL_MS = 30_000

/**
 * The Savings settle pass: adopts rebuilt burns and claims each pending move's deposit. While
 * something is `due`, it passes at once, every 30 s, hidden too, on a wake and when the page is
 * shown again. A failed pass fails its run, which backs off and passes again.
 */
export const savingsSettle = (
  savings: Service<SavingsSource | null>,
  due: ReadonlyStore<SettleDue>,
): Task =>
  task("savingsSettle", {
    needs: { savings },
    when: derived([due], (state) => state.due),
    after: { firstBalance: true },
    every: SAVINGS_SETTLE_INTERVAL_MS,
    whenHidden: SAVINGS_SETTLE_INTERVAL_MS,
    backoff: { baseMs: SAVINGS_SETTLE_INTERVAL_MS, maxMs: 300_000 },
    // Not `within`: the run ends with its pass, so the runtime never runs two at once.
    run: async ({ savings, signal }) => void (await savings?.settle(signal)),
  })

/** A visitor's: nothing is due. */
export const NO_SETTLE_DUE = memoryStore<SettleDue>({ due: false, unadopted: 0 }).readonly

/** A visitor's: it holds no Savings. */
export const NO_HOLDING = memoryStore<SavingsHolding>({ position: null, hydrated: false }).readonly

/** A visitor's: it replays nothing. */
export const NO_REPLAY = memoryStore<boolean | undefined>(undefined).readonly

/**
 * Whether the session rebuilt its Savings burns: undefined before a replay ended, false while the
 * latest one failed. Its milestone is marked either way, so it can't tell them apart.
 */
export const useSavingsMovesReplayed = (): boolean | undefined =>
  useStore(useSession().savingsReplayed)

/**
 * Replays the moves this browser has no record of: both tokens' burns are rebuilt, then the replay
 * wakes the settle task and waits for its run, which adopts them and stores their deposits, which
 * can be unspent. A catching-up balance waits for the first try.
 */
export function savingsMovesReplay(
  needs: Inputs<{
    wallet: ObsidionWallet
    account: ObsidionAccount
    token: TokenService
    savings: SavingsSource | null
  }>,
  milestones: Pick<Milestones, "mark">,
  chain: {
    rescan: ReturnType<typeof rescanWithdrawals>
    savingsToken: ReturnType<typeof savingsRescanToken>
  },
  settle: Task,
) {
  const replayed = memoryStore<boolean | undefined>(undefined)
  const replay = task("savingsMovesReplay", {
    needs,
    after: { firstBalance: true, depositsReplayed: { whenCatchingUp: 0 } },
    every: "once",
    backoff: RETRY,
    async run({ wallet, account, token, savings, signal, wake }) {
      let complete = false
      try {
        if (savings) {
          const owner = account.getAddress().toString()
          const rebuilt = Promise.all([
            chain.rescan(wallet, owner, [{ tokenService: token }]),
            chain
              .savingsToken(wallet, account)
              .then((savingsToken) =>
                savingsToken ? chain.rescan(wallet, owner, [savingsToken]) : [],
              ),
          ])
          await within(rebuilt, "savingsMovesReplay", { signal })
          // The milestone waits for the settle run, so the boot sync ends with the claims in.
          await within(wake(settle), "savingsMovesReplay", { signal })
        }
        complete = true
      } finally {
        if (!signal.aborted) {
          milestones.mark("movesReplayed")
          replayed.set(complete)
        }
      }
    },
  })
  return { task: replay, replayed: replayed.readonly }
}
