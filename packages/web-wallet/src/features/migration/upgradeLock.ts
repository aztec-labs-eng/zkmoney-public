/**
 * The account's upgrade lock. From an upgrade's start until the account is fully upgraded here,
 * Home shows each account at what the upgrade will land, so arrivals never count twice.
 * Released, the account is current on this version. Both are keyed to the
 * deployment the profile pins.
 */
import { useSyncExternalStore } from "react"
import { UpgradeActivity, type MetadataMigrationRecord, memoryStore } from "@obsidion/front-core"
import type { WebWalletConfig } from "../../config/env"
import { isDemoMode } from "../../dev/demoFlag"
import { walletStorage } from "../../platform/storage/walletStorage"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { useSession } from "../../session/session"

export type UpgradeLock =
  | { state: "pending" }
  | { state: "held"; main?: bigint; savings?: bigint }
  | { state: "released" }
type CheckedLock = UpgradeLock & { checked: boolean }

const lockKey = (account: string) => `webwallet.upgradeLock/${account.toLowerCase()}`
const versionKey = (account: string) => `webwallet.version/${account.toLowerCase()}`
const createdKey = (account: string) => `webwallet.createdOn/${account.toLowerCase()}`
const pin = (config: WebWalletConfig) => config.oxideProfile.portal.toLowerCase()
// v2: a read settled before registration commitments were scanned is read again.
const sourceReadKey = (config: WebWalletConfig, account: string, source: string) =>
  `webwallet.retiredSourceRead.v2/${pin(config)}/${source.toLowerCase()}/${account.toLowerCase()}`
// eslint-disable-next-line no-restricted-syntax -- debt
const changes = memoryStore(0)
const changed = () => changes.set(changes.get() + 1)
// Accounts whose saved runs were read this page, so the lock can be trusted.
// eslint-disable-next-line no-restricted-syntax -- debt
const checked = memoryStore<ReadonlySet<string>>(new Set())
// Storage shows a write before it is saved: a release reads as held until it is, and a failed one stays held.
// eslint-disable-next-line no-restricted-syntax -- debt
const releasing = new Map<string, { lock: UpgradeLock; saved: Promise<void> }>()
// A take not saved yet, which a second take waits on rather than reading it as held.
// eslint-disable-next-line no-restricted-syntax -- debt
const acquiring = new Map<string, Promise<void>>()

export function upgradeLock(config: WebWalletConfig, account: string): UpgradeLock {
  const pending = releasing.get(account.toLowerCase())
  if (pending) return pending.lock
  // eslint-disable-next-line local/legacy-store -- debt
  const raw = walletStorage.getItem(lockKey(account))
  const lock = raw
    ? (JSON.parse(raw) as { portal: string; main?: string; savings?: string })
    : undefined
  if (lock?.portal === pin(config))
    return {
      state: "held",
      main: lock.main === undefined ? undefined : BigInt(lock.main),
      ...(lock.savings === undefined ? {} : { savings: BigInt(lock.savings) }),
    }
  if (walletStorage.getItem(versionKey(account)) === pin(config)) return { state: "released" }
  return { state: "pending" }
}

/** Takes the lock before an upgrade sends anything; a lock already held keeps its figure. */
export function acquireUpgradeLock(
  config: WebWalletConfig,
  account: string,
  main?: bigint,
  savings?: bigint,
): Promise<void> {
  const id = account.toLowerCase()
  const pending = acquiring.get(id)
  if (pending) return pending
  if (upgradeLock(config, account).state === "held") return Promise.resolve()
  const saved = walletStorage
    .commitItem(
      lockKey(account),
      JSON.stringify({ portal: pin(config), main: main?.toString(), savings: savings?.toString() }),
    )
    .finally(() => {
      acquiring.delete(id)
      changed()
    })
  acquiring.set(id, saved)
  return saved
}

/**
 * The account is fully upgraded here: the lock opens and the account is current. Refused while a
 * run this account saved on this deployment is unfinished, even one whose source is out of reach.
 */
export function releaseUpgradeLock(config: WebWalletConfig, account: string): Promise<void> {
  const id = account.toLowerCase()
  const pending = releasing.get(id)
  if (pending) return pending.saved
  const lock = upgradeLock(config, account)
  if (lock.state === "released") return Promise.resolve()
  const saved = (async () => {
    if (await unfinishedRun(config, account))
      throw new Error("An upgrade run on this version is unfinished")
    await walletStorage.commitTransaction([
      [lockKey(account), null],
      [versionKey(account), pin(config)],
    ])
  })().finally(() => {
    releasing.delete(id)
    changed()
  })
  releasing.set(id, { lock, saved })
  return saved
}

/** A run of the account's on this deployment that has not reached `done`, read from its saved runs. */
async function unfinishedRun(config: WebWalletConfig, account: string): Promise<boolean> {
  const prefix = `metadata-migration/${pin(config)}/`
  for (const run of await UpgradeActivity.get(webStorage).runs()) {
    const key = run.toLowerCase()
    if (!key.startsWith(prefix) || !key.endsWith(`/${account.toLowerCase()}`)) continue
    // eslint-disable-next-line local/legacy-store -- debt
    const raw = await webStorage.getItem(run)
    const record = raw ? (JSON.parse(raw) as MetadataMigrationRecord) : undefined
    if (record && record.phase !== "done") return true
  }
  return false
}

/** The account was made here, on this version: it has nothing to upgrade. A held lock stays. */
export function markCreatedHere(config: WebWalletConfig, account: string): void {
  if (upgradeLock(config, account).state !== "pending") return
  walletStorage.setItem(versionKey(account), pin(config))
  changed()
}

/** A new identity made here, on this version: unlike a passkey rotation's account, it holds nothing on another rollup. */
export function markNewAccountHere(config: WebWalletConfig, account: string): void {
  if (upgradeLock(config, account).state !== "pending") return
  walletStorage.setItem(createdKey(account), pin(config))
  markCreatedHere(config, account)
}

const SETTLED = "settled"

/**
 * Whether the account has nothing left to read on `source`, a deployment on another rollup: it is a
 * new account made here, or it is current here and `source` settled.
 */
export function retiredSourceSettled(config: WebWalletConfig, account: string, source: string) {
  if (walletStorage.getItem(createdKey(account)) === pin(config)) return true
  return (
    upgradeLock(config, account).state === "released" &&
    walletStorage.getItem(sourceReadKey(config, account, source)) === SETTLED
  )
}

/** An L1 block, by number and hash. */
export interface L1Tip {
  number: bigint
  hash: string
}

/** The L1 tip that closed the account's latest empty read of `source`, while it has not settled. */
export function retiredSourceCandidate(config: WebWalletConfig, account: string, source: string) {
  const raw = walletStorage.getItem(sourceReadKey(config, account, source))
  if (raw === null || raw === SETTLED) return undefined
  const { number, hash } = JSON.parse(raw) as { number: string; hash: string }
  return { number: BigInt(number), hash }
}

/**
 * A complete read of `source`, frozen on another rollup. `empty`: nothing left there and its history
 * in, read up to L1 block `tip`. Once the account is current here, an empty read settles the source
 * when `priorFinal`: the block that closed the previous empty read is final and still on chain, so
 * every refund that read saw is final. Otherwise it waits on `tip`; a read that finds funds starts over.
 */
export function recordRetiredSourceRead(
  config: WebWalletConfig,
  account: string,
  source: string,
  read: { empty: false } | { empty: true; tip: L1Tip; priorFinal: boolean },
): void {
  const key = sourceReadKey(config, account, source)
  if (!read.empty) return walletStorage.removeItem(key)
  if (upgradeLock(config, account).state !== "released") return
  const held = walletStorage.getItem(key)
  if (held === SETTLED) return
  if (held !== null && read.priorFinal) return walletStorage.setItem(key, SETTLED)
  walletStorage.setItem(
    key,
    JSON.stringify({ number: read.tip.number.toString(), hash: read.tip.hash }),
  )
}

/**
 * Takes the lock, with no figure, for a run on this deployment that an older build started and
 * left unfinished, then marks the lock as read for this page. A failed read leaves it unread.
 */
export async function checkUpgradeLock(config: WebWalletConfig, account: string) {
  if (await unfinishedRun(config, account)) await acquireUpgradeLock(config, account)
  checked.set(new Set([...checked.get(), account.toLowerCase()]))
}

/** The account's lock, and whether this page has read its saved runs yet. The demo is never locked. */
export function upgradeLockNow(config: WebWalletConfig, account: string | undefined): CheckedLock {
  if (!account || isDemoMode()) return { state: "pending", checked: true }
  return { ...upgradeLock(config, account), checked: checked.get().has(account.toLowerCase()) }
}

export function useUpgradeLock(account: string | undefined): CheckedLock {
  useSyncExternalStore(changes.subscribe, changes.get)
  useSyncExternalStore(checked.subscribe, checked.get)
  return upgradeLockNow(useSession().page.config, account)
}
