import { bestEffort } from "@obsidion/core/errors"
import { memoryStore, type BalanceView, type ReadonlyStore } from "@obsidion/front-core"
import type { BackupFlowDeps } from "./backupPasskeyRuntime"

export interface FundFit {
  /** Whether one transfer funds an amount; none after a failed read, which lets the tip through. */
  fits?: (amount: bigint) => boolean
  /** A read answered or failed. */
  done: boolean
}

/**
 * The Fund step's fit read, run again when Main's balance moves, since funds that land may cover
 * the tip. The last fit stands until a newer read answers; an answer a newer read or the step's end
 * overtook is dropped. `deps` holds for the step's life: the modal builds one per owner, and
 * another owner remounts the panel.
 */
export function openFundFitFlow({
  deps,
  balances,
}: {
  deps: Pick<BackupFlowDeps, "fundable">
  balances: ReadonlyStore<BalanceView>
}) {
  const state = memoryStore<FundFit>({ done: false })
  let latest = 0
  return {
    state: state.readonly,
    start(signal: AbortSignal) {
      const read = async () => {
        const mine = ++latest
        const fits = await bestEffort("balance.unread", deps.fundable())
        if (mine !== latest || signal.aborted) return
        state.set(fits ? { fits, done: true } : { done: true })
      }
      let main = balances.get().main?.atomic
      const stop = balances.subscribe(() => {
        const next = balances.get().main?.atomic
        if (next === main) return
        main = next
        void read()
      })
      signal.addEventListener("abort", stop)
      void read()
    },
  }
}
