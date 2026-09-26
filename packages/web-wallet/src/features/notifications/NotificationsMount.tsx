/**
 * Side-effect-only mount for in-app notifications: registers the shared producers (bridge,
 * transfer-receive, paylink-claimed, reorg) and runs the reorg monitor while the tab is visible.
 */

import { useEffect } from "react"
import {
  ActivityFeed,
  AppNotificationStore,
  BridgeNotificationProducer,
  NotificationProducerRegistry,
  PaylinkClaimedNotificationProducer,
  ReorgNotificationProducer,
  SIPADepositStore,
  TransactionStorage,
  TransferReceiveNotificationProducer,
  createReorgMonitor,
  useAztecContext,
} from "@obsidion/front-core"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { whenVisibilityChanges } from "../../platform/visibilityScheduler"
import { getWithdrawalStore } from "../withdraw/withdrawGateway"

export function NotificationsMount(): null {
  const { obsidionWallet } = useAztecContext()

  useEffect(() => {
    const notificationStore = AppNotificationStore.get(webStorage)
    const accountTransactions = () =>
      TransactionStorage.get(webStorage)
        .getTransactions()
        .catch(() => null)
    const producers = NotificationProducerRegistry.get()
    producers.register(
      BridgeNotificationProducer.get(
        ActivityFeed.get(SIPADepositStore.get(webStorage), getWithdrawalStore()),
        notificationStore,
        { liveRows: true },
      ),
    )
    producers.register(
      TransferReceiveNotificationProducer.getOrCreate({ notificationStore, accountTransactions }),
    )
    producers.register(
      PaylinkClaimedNotificationProducer.getOrCreate({ notificationStore, accountTransactions }),
    )
    producers.register(ReorgNotificationProducer.getOrCreate({ notificationStore }))
    producers.start()
    return () => producers.stop()
  }, [])

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
