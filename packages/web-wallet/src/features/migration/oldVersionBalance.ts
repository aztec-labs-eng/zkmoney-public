/**
 * What the account still holds on retired versions, kept in `BalanceStorage` beside the live balance
 * and never in its scope. Home counts it until an upgrade starts; what is left once the account is
 * upgraded is abandoned. Everything is keyed by the deployment the profile pins, so a repoint never
 * mixes another deployment's old versions in.
 */
import { useMemo, useSyncExternalStore } from "react"
import {
  balanceScope,
  BalanceStorage,
  useCachedRecords,
  type BalanceRecord,
} from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { isDemoMode } from "../../dev/demoFlag"
import { createExternalState } from "../../lib/externalState"
import { walletStorage } from "../../platform/storage/walletStorage"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { useUpgradeLock } from "./upgradeLock"

const pinned = () => getConfig().oxideProfile.portal.toLowerCase()
const prefix = () => `${pinned()}/old/`

/** Where the retired deployment `source` keeps what it holds for `account`. */
export const oldVersionScope = (source: string, account: string) =>
  balanceScope(`${prefix()}${source.toLowerCase()}`, account.toLowerCase())

/** What `records` hold on old versions for `account`. */
export function oldVersionRecords(
  records: readonly BalanceRecord[],
  account: string,
): BalanceRecord[] {
  return records.filter(
    (r) => r.scope.startsWith(prefix()) && r.scope.endsWith(`:${account.toLowerCase()}`),
  )
}

const readKey = (account: string) =>
  `webwallet.oldHoldingsRead/${pinned()}/${account.toLowerCase()}`
const changes = createExternalState(0)
const released = createExternalState(false)

/** Whether a check has read every old version once for `account`. */
export function oldHoldingsRead(account: string): boolean {
  return walletStorage.getItem(readKey(account)) === "1"
}

/** A check read every old version for `account`: from now on Home shows what is recorded. */
export function markOldHoldingsRead(account: string): void {
  if (oldHoldingsRead(account)) return
  walletStorage.setItem(readKey(account), "1")
  changes.set(changes.get() + 1)
}

/** Nothing can be read in this page, such as with the wallet locked: Home shows what it has. */
export function releaseOldHoldingsWait(release: boolean): void {
  released.set(release)
}

/**
 * What the signed-in account holds on old versions, and whether Home waits for it: no check has
 * read every old version yet. Nothing once the upgrade lock is taken. A record a partial check wrote
 * can be one source of several. The demo has no wallet to check.
 */
export function useOldVersionHoldings(): { total: bigint; pending: boolean } {
  const { records } = useCachedRecords(useMemo(() => BalanceStorage.get(webStorage), []))
  const changed = useSyncExternalStore(changes.subscribe, changes.get)
  const free = useSyncExternalStore(released.subscribe, released.get)
  const account = loadWalletIdentity()?.address
  const lock = useUpgradeLock(account).state
  return useMemo(() => {
    if (lock !== "pending") return { total: 0n, pending: false }
    const held = account ? oldVersionRecords(records, account) : []
    return {
      total: held.reduce((sum, r) => sum + BigInt(r.balance), 0n),
      pending: !!account && !isDemoMode() && !free && !oldHoldingsRead(account),
    }
    // `changed` re-reads the mark.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, account, free, changed, lock])
}
