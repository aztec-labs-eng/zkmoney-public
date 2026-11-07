import { useSyncExternalStore } from "react"
import {
  resource,
  task,
  within,
  type Milestones,
  type Resource,
  type SavingsSource,
  type Task,
} from "@obsidion/front-core"
import type { ContractService, ObsidionAccount, ObsidionWallet, TokenService } from "@obsidion/sdk"
import { createExternalState } from "../../lib/externalState"
import type { rescanWithdrawals } from "../withdraw/withdrawGateway"
import type { savingsRescanToken } from "./savingsGateway"

/** How long a failed read of the deployment, or a failed replay, waits before it tries again. */
export const SAVINGS_RETRY_MS = 30_000
const RETRY = { baseMs: SAVINGS_RETRY_MS, maxMs: SAVINGS_RETRY_MS }

type Inputs = {
  wallet: Resource<ObsidionWallet>
  account: Resource<ObsidionAccount>
  token: Resource<TokenService>
}
type Ready = [ObsidionWallet, ObsidionAccount, TokenService, ContractService]
type Resources<T> = { [K in keyof T]: Resource<T[K]> }

/** Savings over the account and Main's token; null where the profile has no sUSDS deployment. */
export const savingsResource = (
  from: Resources<Ready>,
  open: (...ready: Ready) => Promise<SavingsSource | null>,
) =>
  resource("savings", { from, backoff: RETRY }, (ready, { signal }) =>
    within(open(...ready), "savings", { signal }),
  )

/** The latest replay on this page: the account it ran for and whether it ended clean. */
const replayed = createExternalState<{ account: string; complete: boolean } | undefined>(undefined)

/**
 * Whether this page replayed `account`'s Savings moves: undefined before a replay ended, false
 * while the latest one failed. Its milestone is marked either way, so it can't tell them apart.
 */
export function savingsMovesReplayed(account: string | undefined): boolean | undefined {
  const latest = replayed.get()
  return account && latest?.account === account.toLowerCase() ? latest.complete : undefined
}

export function useSavingsMovesReplayed(account: string | undefined): boolean | undefined {
  useSyncExternalStore(replayed.subscribe, replayed.get, replayed.get)
  return savingsMovesReplayed(account)
}

/**
 * Replays the moves this browser has no record of: both tokens' burns are rebuilt, then a settle
 * pass stores their deposits, which can be unspent. A catching-up balance waits for the first try.
 */
export function savingsMovesReplay(
  needs: Inputs & { savings: Resource<SavingsSource | null> },
  milestones: Pick<Milestones, "mark">,
  chain: {
    rescan: ReturnType<typeof rescanWithdrawals>
    savingsToken: typeof savingsRescanToken
  },
): Task {
  return task("savingsMovesReplay", {
    needs,
    after: { firstBalance: true, depositsReplayed: { whenCatchingUp: 0 } },
    every: "once",
    backoff: RETRY,
    async run({ wallet, account, token, savings, signal }) {
      let complete = false
      try {
        if (savings) {
          const rebuilt = Promise.all([
            chain.rescan(wallet, account, [{ tokenService: token }]),
            chain
              .savingsToken(wallet, account)
              .then((savingsToken) =>
                savingsToken ? chain.rescan(wallet, account, [savingsToken]) : [],
              ),
          ])
          await within(rebuilt, "savingsMovesReplay", { signal })
          await within(savings.settle(), "savings settle", { signal })
        }
        complete = true
      } finally {
        if (!signal.aborted) {
          milestones.mark("movesReplayed")
          replayed.set({ account: account.getAddress().toString().toLowerCase(), complete })
        }
      }
    },
  })
}
