import { useMemo } from "react"
import {
  balanceToMove,
  selectFeed,
  useStore,
  type Feed,
  type FeedSources,
  type ReadonlyStore,
  type RecordSet,
  type Registrations,
  type Transaction,
} from "@obsidion/front-core"
import { rotationView } from "../../features/backupPasskey/backupRotations"
import { useHoldingPrices, useSavingsAsset } from "../../features/savings/useSavings"
import { useContactDirectory } from "../../session/contacts"
import { useOldVersionHoldings } from "../../features/migration/oldVersionBalance"
import { usePolledChainSeconds } from "../../features/paylink/chainTime"
import { useSession, type Session } from "../../session/session"
import { feedSources, mergedRows } from "./feedSources"

/** The feed's records: the rows listed, Home's by default, joined by a deep-linked row's hash. */
export function feedRows(
  session: Session,
  rows?: ReadonlyStore<RecordSet<Transaction>>,
  txHash?: string,
): ReadonlyStore<FeedSources> {
  if (!txHash && !rows) return session.feed
  const listed = txHash
    ? mergedRows([rows ?? session.homeRows, session.transfers.where("hash", txHash.toLowerCase())])
    : rows!
  return feedSources(session.feedBase, listed)
}

/** The feed, from the stores and what the view knows beside them. */
export function useFeed({
  registration,
  chainTime,
  account,
  rows,
  txHash,
}: {
  /** The activity rows it lists; Home's newest rows by default. */
  rows?: ReadonlyStore<RecordSet<Transaction>>
  /** A row a deep link opens, read by its hash wherever it sits. */
  txHash?: string
  /** The pending registration's own row, while it has one. */
  registration?: { sipaAddress: string; ts: number }
  /** Reads chain time, which gates a creator paylink's recovery offer. */
  chainTime?: boolean
  /** The session's account, which alone can take back the links it made. */
  account?: string
} = {}): {
  feed: Feed
  registrations: Registrations["records"]
  handle?: string
} {
  const { contacts, hydrated, failed } = useContactDirectory()
  const session = useSession()
  const records = useStore(session.registrations.view, (view) => view.records)
  const handle = useStore(session.identity, (identity) => identity.value?.handle)
  const address = useStore(session.identity, (identity) => identity.value?.address)
  const chainNow = usePolledChainSeconds(chainTime === true)
  const mainReadAt = useStore(useSession().balances.view, (v) => v.readAt)
  const mainToken = useStore(session.balances.view, (v) => v.token)
  const mainAnchor = useStore(session.balances.view, (v) => v.anchor)
  const position = useStore(session.savingsLine).position
  const holdingPrices = useHoldingPrices()
  // Pending until the session knows whether Savings has a row; null where it has none.
  const savings = useSavingsAsset()
  const savingsToken = savings ?? undefined
  const savingsUnknown = savings === undefined
  const rotations = rotationView(session)
  const moveMain = useStore(rotations, (set) =>
    balanceToMove(set.records, address, mainToken, mainAnchor),
  )
  const moveShares = useStore(rotations, (set) =>
    balanceToMove(set.records, address, position?.sharesToken, position?.sharesAnchor),
  )
  const { main: oldMain, savings: oldSavings } = useOldVersionHoldings()
  const previousAccount = useStore(session.savedPreviousAccount.address)
  const activeNetworkId = useStore(session.page.networkId)
  const regSipa = registration?.sipaAddress
  const regTs = registration?.ts
  const select = useMemo(() => {
    const ctx = {
      contacts: { rows: contacts, hydrated, failed },
      registrations: { records, handle },
      registration: regSipa !== undefined ? { sipaAddress: regSipa, ts: regTs! } : undefined,
      chainNowSec: chainNow,
      activeNetworkId,
      account: account ?? address,
      balanceReadAt: { main: mainReadAt, savings: position?.sharesReadAt },
      sharePrice: position?.sharePrice,
      holdingPrices,
      savingsToken,
      savingsUnknown,
      oldVersions: { main: oldMain, savings: oldSavings },
      backupMove: { main: moveMain, shares: moveShares },
      previousAccount,
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
    holdingPrices,
    savingsToken,
    savingsUnknown,
    oldMain,
    oldSavings,
    moveMain,
    moveShares,
    activeNetworkId,
    account,
    address,
    previousAccount,
  ])
  const sources = useMemo(() => feedRows(session, rows, txHash), [session, rows, txHash])
  return { feed: useStore(sources, select), registrations: records, handle }
}
