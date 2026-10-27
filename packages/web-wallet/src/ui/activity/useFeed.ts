import { useMemo } from "react"
import {
  getActiveNetworkId,
  selectFeed,
  useAssetContext,
  useContactsDirectory,
  useSavingsPosition,
  useStore,
  type Feed,
  type Registrations,
} from "@obsidion/front-core"
import { useOldVersionHoldings } from "../../features/migration/oldVersionBalance"
import { usePolledChainSeconds } from "../../features/paylink/chainTime"
import { useSession } from "../../platform/session"

/** The feed, from the stores and what the view knows beside them. */
export function useFeed({
  registration,
  chainNode,
}: {
  /** The pending registration's own row, while it has one. */
  registration?: { sipaAddress: string; ts: number }
  /** The node to read chain time from, which gates a creator paylink's recovery offer. */
  chainNode?: Parameters<typeof usePolledChainSeconds>[0]
} = {}): {
  feed: Feed
  registrations: Registrations["records"]
  handle?: string
} {
  const { contacts, hydrated, failed } = useContactsDirectory()
  const session = useSession()
  const records = useStore(session.registrations)
  const handle = useStore(session.identity, (identity) => identity.value?.handle)
  const chainNow = usePolledChainSeconds(chainNode)
  const mainReadAt = useStore(useAssetContext().balances.view, (v) => v.readAt)
  const position = useSavingsPosition().position
  const { main: oldMain, savings: oldSavings } = useOldVersionHoldings()
  const activeNetworkId = getActiveNetworkId()
  const regSipa = registration?.sipaAddress
  const regTs = registration?.ts
  const select = useMemo(() => {
    const ctx = {
      contacts: { rows: contacts, hydrated, failed },
      registrations: { records, handle },
      registration: regSipa !== undefined ? { sipaAddress: regSipa, ts: regTs! } : undefined,
      chainNowSec: chainNow,
      activeNetworkId,
      balanceReadAt: { main: mainReadAt, savings: position?.sharesReadAt },
      sharePrice: position?.sharePrice,
      oldVersions: { main: oldMain, savings: oldSavings },
    }
    return (sources: Parameters<typeof selectFeed>[0]) => selectFeed(sources, ctx)
  }, [
    contacts,
    hydrated,
    failed,
    records,
    handle,
    regSipa,
    regTs,
    chainNow,
    mainReadAt,
    position,
    oldMain,
    oldSavings,
    activeNetworkId,
  ])
  return { feed: useStore(session.feed, select), registrations: records, handle }
}
