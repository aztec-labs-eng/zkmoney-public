/**
 * The DAI value the account holds on retired versions, kept in the balance store beside the live balance
 * and never in its scope. Home counts it until an upgrade starts; what is left once the account is
 * upgraded is abandoned, unless a later check offers to move it. Everything is keyed by the deployment
 * the profile pins, so a repoint never mixes another deployment's old versions in.
 */
import { useMemo, useSyncExternalStore } from "react"
import {
  balanceScope,
  memoryStore,
  useStore,
  type BalanceEntry,
  type RecordSet,
} from "@obsidion/front-core"
import type { WebWalletConfig } from "../../config/env"
import { isDemoMode } from "../../dev/demoFlag"
import { walletStorage } from "../../platform/storage/walletStorage"
import { useSession } from "../../session/session"
import { useUpgradeLock } from "./upgradeLock"

const pin = (config: WebWalletConfig) => config.oxideProfile.portal.toLowerCase()
const prefix = (config: WebWalletConfig) => `${pin(config)}/old/`

/** Where the retired deployment `source` keeps what it holds for `account`. */
export const oldVersionScope = (config: WebWalletConfig, source: string, account: string) =>
  balanceScope(`${prefix(config)}${source.toLowerCase()}`, account.toLowerCase())

/** What `records` hold on old versions for `account`. */
export function oldVersionRecords(
  config: WebWalletConfig,
  records: readonly BalanceEntry[],
  account: string,
): BalanceEntry[] {
  return records.filter(
    (r) => r.scope.startsWith(prefix(config)) && r.scope.endsWith(`:${account.toLowerCase()}`),
  )
}

const NO_BALANCES = memoryStore<RecordSet<BalanceEntry>>({
  records: [],
  loaded: true,
  failed: false,
}).readonly

const readKey = (config: WebWalletConfig, account: string) =>
  `webwallet.oldHoldingsRead/${pin(config)}/${account.toLowerCase()}`
// eslint-disable-next-line no-restricted-syntax -- debt
const changes = memoryStore(0)
// eslint-disable-next-line no-restricted-syntax -- debt
const released = memoryStore(false)
// eslint-disable-next-line no-restricted-syntax -- debt
const savingsSources = memoryStore<ReadonlySet<string> | undefined>(undefined)
const savingsSourcesKey = (config: WebWalletConfig) => `webwallet.oldSavingsSources/${pin(config)}`

/** The scan identifies which old portals move into Savings. */
export function setOldVersionDestinations(
  config: WebWalletConfig,
  current: string,
  destinations: ReadonlyMap<string, { tuple: { portal: string } }>,
): void {
  const sources = new Set(
    [...destinations].flatMap(([source, { tuple }]) =>
      tuple.portal.toLowerCase() === current.toLowerCase() ? [] : [source.toLowerCase()],
    ),
  )
  // eslint-disable-next-line local/legacy-store -- debt
  walletStorage.setItem(savingsSourcesKey(config), JSON.stringify([...sources]))
  savingsSources.set(sources)
}

/** Whether a check has read every old version once for `account`. */
export function oldHoldingsRead(config: WebWalletConfig, account: string): boolean {
  return walletStorage.getItem(readKey(config, account)) === "1"
}

/** A check read every old version for `account`: from now on Home shows what is recorded. */
export function markOldHoldingsRead(config: WebWalletConfig, account: string): void {
  if (oldHoldingsRead(config, account)) return
  walletStorage.setItem(readKey(config, account), "1")
  changes.set(changes.get() + 1)
}

const fundsKey = (config: WebWalletConfig, account: string) =>
  `webwallet.upgradeMovesFunds/${pin(config)}/${account.toLowerCase()}`

/**
 * Whether the last check that answered for `account` in this browser offered an upgrade that moves
 * funds; undefined when none answered.
 */
export function upgradeMovedFunds(config: WebWalletConfig, account: string): boolean | undefined {
  const mark = walletStorage.getItem(fundsKey(config, account))
  return mark === null ? undefined : mark === "1"
}

export function markUpgradeMovesFunds(config: WebWalletConfig, account: string, moves: boolean) {
  if (upgradeMovedFunds(config, account) === moves) return
  walletStorage.setItem(fundsKey(config, account), moves ? "1" : "0")
  // Home counts an upgraded account's old versions again while a check offers to move their funds.
  changes.set(changes.get() + 1)
}

/** Nothing can be read in this page, such as with the wallet locked: Home shows what it has. */
export function releaseOldHoldingsWait(release: boolean): void {
  released.set(release)
}

/**
 * What the signed-in account holds on old versions, and whether Home waits for it: no check has
 * read every old version yet. Home hides the total once the upgrade lock is taken, and shows it again
 * after the upgrade only while the last check offers to move funds: an upgrade that did not see them,
 * or funds that reached an old version since. Recorded amounts keep each account's holdings
 * available for the upgrade snapshot.
 */
export function useOldVersionHoldings(): {
  total: bigint
  main: bigint
  savings: bigint
  recordedMain: bigint
  recordedSavings: bigint
  pending: boolean
} {
  const session = useSession()
  const { config } = session.page
  const { records, loaded, failed } = useStore(session.balanceStore?.view ?? NO_BALANCES)
  const changed = useSyncExternalStore(changes.subscribe, changes.get)
  const free = useSyncExternalStore(released.subscribe, released.get)
  const scanned = useSyncExternalStore(savingsSources.subscribe, savingsSources.get)
  const saved = walletStorage.getItem(savingsSourcesKey(config))
  const sources = useMemo(
    () => scanned ?? (saved === null ? undefined : new Set<string>(JSON.parse(saved))),
    [scanned, saved],
  )
  const account = useStore(session.identity, (s) => s.value?.address)
  const lock = useUpgradeLock(account).state
  return useMemo(() => {
    const held = account ? oldVersionRecords(config, records, account) : []
    let recordedMain = 0n
    let recordedSavings = 0n
    for (const r of held) {
      const source = r.scope.slice(prefix(config).length, r.scope.lastIndexOf(":"))
      if (sources?.has(source)) recordedSavings += r.atomic
      else recordedMain += r.atomic
    }
    const recordedTotal = recordedMain + recordedSavings
    // A held lock's figure already counts them.
    const counted =
      lock === "pending" ||
      (lock === "released" && !!account && upgradeMovedFunds(config, account) === true)
    return {
      total: counted ? recordedTotal : 0n,
      main: counted ? recordedMain : 0n,
      savings: counted ? recordedSavings : 0n,
      recordedMain,
      recordedSavings,
      pending:
        lock === "pending" &&
        !!account &&
        !isDemoMode() &&
        !free &&
        (!loaded || failed || !oldHoldingsRead(config, account) || sources === undefined),
    }
    // `changed` re-reads the marks.
  }, [config, records, loaded, failed, account, free, changed, lock, sources])
}
