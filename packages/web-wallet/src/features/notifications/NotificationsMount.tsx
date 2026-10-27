/**
 * Side-effect-only mount for in-app notifications: registers the shared producers (bridge,
 * transfer-receive, paylink-claimed, reorg) and runs the reorg monitor while the tab is visible.
 */

import { useEffect, useRef } from "react"
import {
  AppNotificationStore,
  BridgeNotificationProducer,
  NotificationProducerRegistry,
  PaylinkClaimedNotificationProducer,
  PendingRegistrationStore,
  RegistrationNotificationProducer,
  ReorgNotificationProducer,
  SIPADepositStore,
  TransactionStorage,
  TransferReceiveNotificationProducer,
  createReorgMonitor,
  getActiveNetworkId,
  loadTransferScanJoined,
  useAztecContext,
  useSavingsSource,
  useSavingsPosition,
  upgradeRunValue,
  type UpgradePricing,
} from "@obsidion/front-core"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { whenVisibilityChanges } from "../../platform/visibilityScheduler"
import { bridgeActivityFeed, sipaProcessingObserver } from "../deposit/sipaProcessing"
import { useDepositTokens } from "../deposit/loadDepositFacts"
import { getWithdrawalStore } from "../withdraw/withdrawGateway"
import { upgradeRunToken } from "../migration/upgradeRunAccount"

export function NotificationsMount(): null {
  const { obsidionWallet } = useAztecContext()
  const tokens = useDepositTokens()
  const savings = useSavingsSource()
  const { position } = useSavingsPosition()
  const pricing = useRef<UpgradePricing>({})
  pricing.current = {
    mainToken: tokens?.settlement.address,
    savingsToken: savings?.assetAddress,
    sharePrice: position?.sharePrice,
    runToken: (run) =>
      upgradeRunToken(run, { main: tokens?.settlement.address, savings: savings?.assetAddress }),
  }

  useEffect(() => {
    const notificationStore = AppNotificationStore.get(webStorage)
    const accountTransactions = () =>
      TransactionStorage.get(webStorage)
        .getTransactions()
        .catch(() => null)
    const producers = NotificationProducerRegistry.get()
    producers.register(
      BridgeNotificationProducer.get(bridgeActivityFeed(), notificationStore, {
        liveRows: true,
        upgradeValue: (run) => upgradeRunValue(run, pricing.current),
      }),
    )
    const joined = async () => {
      const identity = loadWalletIdentity()
      const networkId = getActiveNetworkId()
      if (!identity || !networkId) return undefined
      return loadTransferScanJoined(webStorage, { accountAddress: identity.address, networkId })
    }
    producers.register(
      TransferReceiveNotificationProducer.getOrCreate({
        notificationStore,
        accountTransactions,
        joined,
      }),
    )
    producers.register(
      PaylinkClaimedNotificationProducer.getOrCreate({ notificationStore, accountTransactions }),
    )
    producers.register(ReorgNotificationProducer.getOrCreate({ notificationStore }))
    producers.register(
      RegistrationNotificationProducer.getOrCreate({
        notificationStore,
        pendingStore: PendingRegistrationStore.get(webStorage),
        sipaStore: SIPADepositStore.get(webStorage),
        withdrawalStore: getWithdrawalStore(),
        currentAccount: () => loadWalletIdentity()?.address ?? null,
        processing: sipaProcessingObserver(),
      }),
    )
    producers.start()
    return () => producers.stop()
  }, [])

  useEffect(() => {
    void BridgeNotificationProducer.get().refresh()
  }, [tokens, savings, position?.sharePrice])

  useEffect(() => {
    if (!obsidionWallet) return
    const monitor = createReorgMonitor({ wallet: obsidionWallet, storage: webStorage })
    // A pass costs a receipt read per watched payment, and nothing reads the result until the tab
    // is looked at again; returning to it runs a side-effect pass before the loop resumes.
    const unwatch = whenVisibilityChanges({
      onShow: () => {
        monitor.start()
        monitor.requestPass({ sideEffects: true })
      },
      onHide: () => monitor.stop(),
    })
    return () => {
      unwatch()
      monitor.stop()
    }
  }, [obsidionWallet])

  return null
}
