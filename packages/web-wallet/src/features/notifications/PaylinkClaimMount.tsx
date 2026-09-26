/**
 * Creator-side paylink upkeep: rebuilds the sent paylink rows this browser never had from the
 * account's own funding `Transfer` copies, then sweeps sent rows against the on-chain nullifier —
 * once the wallet is live, whenever the tab becomes visible, and on a timer while it stays visible.
 * The reconciler owns the isClaimed write and the `paylinkClaimed` event the notification producer
 * listens to.
 */

import { useEffect } from "react"
import {
  PaylinkClaimReconciler,
  TransactionStorage,
  checkSpentViaPaylinkService,
  createTransferEventSource,
  rebuildPaylinks,
  useAccountContext,
  useAssetContext,
  useAztecContext,
  useContractServiceContext,
} from "@obsidion/front-core"
import { PaylinkService, encodePaylinkInline } from "@obsidion/sdk"
import { webStorage } from "../../platform/storage/WebStorageAdapter"

const SWEEP_MS = 60_000

let active: PaylinkClaimReconciler | undefined

/** Recheck one sent paylink row against the chain through the mounted sweep; no-op before it mounts. */
export function recheckPaylinkClaim(txHash: string): Promise<void> {
  return active?.reconcileTxHash(txHash) ?? Promise.resolve()
}

export function PaylinkClaimMount(): null {
  const { obsidionWallet } = useAztecContext()
  const { obsidionAccount, getSecretKey } = useAccountContext()
  const { tokenService } = useAssetContext()
  const { contractService } = useContractServiceContext()

  useEffect(() => {
    if (!obsidionWallet || !obsidionAccount || !tokenService || !contractService) return
    const controller = new AbortController()
    const accountAddress = obsidionAccount.getAddress().toString()
    const paylinkService = new PaylinkService(
      obsidionWallet,
      obsidionAccount,
      tokenService,
      contractService,
    )
    const reconciler = new PaylinkClaimReconciler({
      checkSpent: checkSpentViaPaylinkService(paylinkService),
      getActiveAccount: () => accountAddress,
    })
    active = reconciler
    const rescan = async () => {
      if (controller.signal.aborted) return
      // Cached once the account is unlocked; a locked wallet skips this pass.
      const masterSecret = await getSecretKey()
      if (!masterSecret || controller.signal.aborted) return
      const [token, nodeInfo] = await Promise.all([
        tokenService.fetchTokenInformation(),
        obsidionWallet.node.getNodeInfo(),
      ])
      await rebuildPaylinks({
        source: createTransferEventSource({
          wallet: obsidionWallet,
          tokenAddress: token.address,
          accountAddress,
        }),
        accountAddress,
        masterSecret,
        networkId: nodeInfo.l1ContractAddresses.rollupAddress.toString(),
        signal: controller.signal,
        paylinkService,
        linkFor: (params) => `${location.origin}/link#${encodePaylinkInline(params)}`,
        store: TransactionStorage.get(webStorage),
        storage: webStorage,
        token: { address: token.address, symbol: token.symbol, decimals: token.decimals },
      })
    }
    const run = () => {
      if (controller.signal.aborted || document.visibilityState !== "visible") return
      void rescan()
        .catch((err) => console.warn("[PaylinkClaimMount] paylink rescan failed", err))
        .then(() => {
          if (!controller.signal.aborted) return reconciler.reconcile()
        })
    }
    run()
    document.addEventListener("visibilitychange", run)
    const timer = setInterval(run, SWEEP_MS)
    return () => {
      controller.abort()
      clearInterval(timer)
      document.removeEventListener("visibilitychange", run)
      if (active === reconciler) active = undefined
    }
  }, [obsidionWallet, obsidionAccount, tokenService, contractService])

  return null
}
