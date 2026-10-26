import { useEffect, useMemo, useState, type ReactNode } from "react"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  SavingsProvider,
  bootPriority,
  isSavingsMovePending,
  needsVaultFigures,
  useAccountContext,
  useAssetContext,
  useAztecContext,
  useBootReady,
  useCachedRecords,
  useContractServiceContext,
} from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { createSavingsSource, getSavingsTuple, savingsRescanToken } from "./savingsGateway"
import { getSavingsMoveStore } from "./savingsMoveStore"
import { getWithdrawalStore, rescanWithdrawals } from "../withdraw/withdrawGateway"

/** How often a pending move's deposit is looked for. */
const SAVINGS_SETTLE_INTERVAL_MS = 30_000
/** How long a failed replay of the moves waits before it tries again. */
export const SAVINGS_REPLAY_RETRY_MS = 30_000

/**
 * Composes the Savings source once the sUSDS deployment, the wallet, the account and Main's token
 * service are up, and runs the settle pass while a move is pending. Without a sUSDS deployment the
 * source is null and every Savings surface stays hidden.
 *
 * It also replays the moves this browser has no record of: their burns are rebuilt from both
 * tokens' `Withdraw` events (a move in burns Main's token, a move out Savings'), then a settle pass
 * stores their deposits. A rebuilt move's deposit can be unspent, so a device catching up does this
 * before its balance settles (`bootPriority`).
 */
export function WebSavingsProvider({ children }: { children: ReactNode }) {
  const { obsidionWallet, currentNetwork } = useAztecContext()
  const { obsidionAccount } = useAccountContext()
  const { tokenService } = useAssetContext()
  const { contractService } = useContractServiceContext()
  // Undefined until read; null where the profile has no sUSDS deployment.
  const [savings, setSavings] = useState<OxideEnvTuple | null>()
  useEffect(() => {
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    // A failed read (a manifest or RPC hiccup) is tried again, so Savings appears once it answers.
    const load = () =>
      getSavingsTuple(getConfig()).then(
        (tuple) => !cancelled && setSavings(tuple ?? null),
        (err) => {
          console.warn("[savings] the sUSDS deployment could not be read, retrying:", err)
          if (!cancelled) retry = setTimeout(load, SAVINGS_SETTLE_INTERVAL_MS)
        },
      )
    void load()
    return () => {
      cancelled = true
      clearTimeout(retry)
    }
  }, [])
  const ready = useBootReady("savings")
  const source = useMemo(
    () =>
      ready &&
      savings &&
      obsidionWallet &&
      obsidionAccount &&
      tokenService &&
      contractService &&
      currentNetwork
        ? createSavingsSource(
            {
              wallet: obsidionWallet,
              account: obsidionAccount,
              contractService,
              tokenService,
              network: currentNetwork.type,
            },
            savings,
          )
        : null,
    [
      ready,
      savings,
      obsidionWallet,
      obsidionAccount,
      tokenService,
      contractService,
      currentNetwork,
    ],
  )
  const { records } = useCachedRecords(useMemo(getSavingsMoveStore, []))
  const { records: burns } = useCachedRecords(useMemo(getWithdrawalStore, []))
  // Burns with Sky meta the store does not know: a rescan rebuilt them, and the pass adopts them.
  const unadopted = burns.filter(
    (burn) =>
      burn.skyMove &&
      burn.phase !== "failed" &&
      !records.some((move) => move.withdrawalLocalId === burn.localId),
  ).length
  // A failed burn funded nothing; the pass leaves its move alone, so it does not keep the poll alive.
  const failed = new Set(
    burns.filter((burn) => burn.phase === "failed").map((burn) => burn.localId),
  )
  const pending =
    unadopted > 0 ||
    records.some(
      (move) =>
        !failed.has(move.withdrawalLocalId) &&
        (isSavingsMovePending(move) || needsVaultFigures(move)),
    )
  useEffect(() => {
    if (savings === null) bootPriority.movesReplayed()
  }, [savings])
  useEffect(() => {
    if (!source || !obsidionWallet || !obsidionAccount || !tokenService) return
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const replay = async () => {
      await Promise.all([
        rescanWithdrawals(obsidionWallet, [{ tokenService }]),
        savingsRescanToken(obsidionWallet, obsidionAccount).then((token) =>
          token ? rescanWithdrawals(obsidionWallet, [token]) : [],
        ),
      ])
      if (!cancelled) await source.settle()
    }
    // A failed replay is tried again; the balance waits for the first try only.
    const attempt = (): Promise<void> =>
      replay().catch((err: unknown) => {
        console.warn("[savings] replaying the moves failed, retrying:", err)
        if (!cancelled) retry = setTimeout(() => void attempt(), SAVINGS_REPLAY_RETRY_MS)
      })
    void bootPriority
      .whenReady("savingsMoves")
      .then(() => (cancelled ? undefined : attempt()))
      .finally(() => !cancelled && bootPriority.movesReplayed())
    return () => {
      cancelled = true
      clearTimeout(retry)
    }
  }, [source, obsidionWallet, obsidionAccount, tokenService])
  useEffect(() => {
    if (!source) return
    const pass = () =>
      void source.settle().catch((err) => console.warn("[savings] settle pass failed:", err))
    pass()
    if (!pending) return
    const timer = setInterval(pass, SAVINGS_SETTLE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [source, pending, unadopted])
  return <SavingsProvider source={source}>{children}</SavingsProvider>
}
