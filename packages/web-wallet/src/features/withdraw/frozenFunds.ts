/**
 * What the account still holds on its frozen portals, from one shared scan. A refund leaves the L2
 * notes unspent, so while the portal is frozen this scan, not the token balance, says what is left.
 */
import { useEffect, useSyncExternalStore } from "react"
import { useAccountContext, useAztecContext } from "@obsidion/front-core"
import { savingsValue } from "@obsidion/front-core"
import type { ObsidionAccount, ObsidionWallet } from "@obsidion/sdk"
import { createExternalState } from "../../lib/externalState"
import {
  frozenExitRuntime,
  frozenSavingsRuntime,
  openLinksHeld,
  recordSentFrozenRefunds,
} from "./frozenExit"
import { frozenExitSummary } from "./frozenExitRun"
import type { FrozenFunds, FrozenSourceFunds } from "./frozenExitParts"
import { usePortalFrozen } from "./portalFrozen"

type Chain = { wallet: ObsidionWallet; account: ObsidionAccount }

const state = createExternalState<{ owner?: string; funds?: FrozenFunds; failed: boolean }>({
  failed: false,
})
let scanning: { owner: string; run: Promise<void> } | undefined
// Accounts whose past refund batches this page has read from L1.
const historyRead = new Set<string>()

/**
 * Rescans both portals. One scan runs per account at a time; `fresh` queues another after it, for
 * state that changed since it started.
 */
export function scanFrozenFunds(chain: Chain, fresh = false): Promise<void> {
  const owner = chain.account.getAddress().toString()
  if (scanning?.owner === owner)
    return fresh ? scanning.run.then(() => scanFrozenFunds(chain)) : scanning.run
  const prev = state.get()
  state.set({ owner, funds: prev.owner === owner ? prev.funds : undefined, failed: false })
  const run = (async () => {
    try {
      const [main, savings, openLinks] = await Promise.all([
        frozenExitRuntime(chain).then((runtime) => {
          if (!historyRead.has(owner)) {
            historyRead.add(owner)
            void recordSentFrozenRefunds(runtime).catch((error) => {
              historyRead.delete(owner)
              console.warn("[frozen-exit] refund history read failed:", error)
            })
          }
          return frozenExitSummary(runtime)
        }),
        frozenSavingsRuntime(chain)
          .then((runtime) => runtime && frozenExitSummary(runtime))
          .then(
            (funds) => ({ funds }),
            (error: unknown) => {
              console.warn("[frozen-exit] Savings scan failed:", error)
              return { failed: true }
            },
          ),
        openLinksHeld().catch(() => 0n),
      ])
      if (state.get().owner !== owner) return
      const held = "funds" in savings && savings.funds
      state.set({
        owner,
        failed: false,
        funds: {
          main,
          openLinks,
          ...(held ? { savings: held } : {}),
          ...("failed" in savings ? { savingsFailed: true } : {}),
        },
      })
    } catch (error) {
      if (state.get().owner !== owner) return
      state.set({ owner, funds: state.get().funds, failed: true })
      console.warn("[frozen-exit] scan failed:", error)
    } finally {
      if (scanning?.owner === owner) scanning = undefined
    }
  })()
  scanning = { owner, run }
  return run
}

/** The last scan, for code outside React. */
export const lastFrozenScan = () => state.get()

/** The last scan's funds, without starting one. */
export function useLastFrozenFunds(): FrozenFunds | undefined {
  return useSyncExternalStore(state.subscribe, state.get).funds
}

/**
 * The shared scan, started once the portal is frozen and the account is loaded. `rescanOnMount`
 * also refreshes a finished scan on mount, as a waiting deposit can become refundable.
 */
export function useFrozenFunds({ rescanOnMount = false } = {}): {
  funds?: FrozenFunds
  failed: boolean
  rescan: () => void
} {
  const { obsidionWallet } = useAztecContext()
  const { obsidionAccount } = useAccountContext()
  const portalFrozen = usePortalFrozen()
  const snapshot = useSyncExternalStore(state.subscribe, state.get)
  const chain =
    obsidionWallet && obsidionAccount ? { wallet: obsidionWallet, account: obsidionAccount } : null
  const owner = chain?.account.getAddress().toString()
  const current = snapshot.owner === owner
  useEffect(() => {
    if (chain && portalFrozen && !current) void scanFrozenFunds(chain)
  }, [obsidionWallet, obsidionAccount, portalFrozen, current])
  useEffect(() => {
    if (rescanOnMount && chain && portalFrozen && current) void scanFrozenFunds(chain)
  }, [obsidionWallet, obsidionAccount, portalFrozen])
  return {
    funds: current ? snapshot.funds : undefined,
    failed: current && snapshot.failed,
    rescan: () => {
      if (chain) void scanFrozenFunds(chain)
    },
  }
}

/** What `funds` leaves in zk.money: refundable now and later. */
export const fundsLeft = (funds: FrozenSourceFunds) => funds.refundable + funds.waiting

/** Savings shares in dollars. Without a read price, a share counts as a dollar. */
export const sharesUsd = (shares: bigint, sharePrice?: bigint) =>
  sharePrice === undefined ? shares : savingsValue(shares, sharePrice)
