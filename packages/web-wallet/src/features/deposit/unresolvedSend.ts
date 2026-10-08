/**
 * A desktop deposit whose send was approved but has no known hash. The browser wallet may still send it, so the
 * deposit screen holds new funding until funds reach that address or the user chooses to start again. The marker is
 * saved to the wallet database before each approval, so an approval never happens without it, and an approval never
 * replaces the hold of another send. It is wallet state: it lives in the active rollup's wallet database, one per
 * account, and is read when the deposit screen mounts, so it survives a reload. A wallet database kept only in memory
 * (no OPFS) would lose it, so no hold is saved there outside a demo. Reads see only saved values, and holds and
 * removals run one at a time, so each one checks what the ones before it saved.
 */
import type { Address } from "viem"
import { isDemoMode } from "../../dev/demoFlag"
import { walletStorage, walletStoreIsPersistent } from "../../platform/storage/walletStorage"

export interface UnresolvedSend {
  address: Address
  /** Epoch ms of the approval. */
  at: number
  /** The desktop submission approved; every approval of one submission carries the same id. */
  submission?: string
}

/** `unreadable`: something is stored but cannot be read, so a hold may exist. */
export type UnresolvedSendState =
  | { status: "none" }
  | { status: "held"; send: UnresolvedSend }
  | { status: "unreadable" }

/** Another send's marker is saved, or one that cannot be read: approving would drop its hold. */
export class UnresolvedSendHeldError extends Error {
  constructor() {
    super("Another deposit from your browser wallet may still be sent.")
    this.name = "UnresolvedSendHeldError"
  }
}

/** This browser could not keep, or could not remove, the marker. */
export class UnresolvedSendStorageError extends Error {
  constructor(cause?: unknown) {
    super("This browser couldn't save the deposit's progress.", { cause })
    this.name = "UnresolvedSendStorageError"
  }
}

const key = (network: string, account: string) =>
  `webwallet.deposit.unresolved-send.${network}.${account.toLowerCase()}`

let queue: Promise<unknown> = Promise.resolve()

function serially<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task)
  queue = run.catch(() => {})
  return run
}

export function readUnresolvedSend(network: string, account: string): UnresolvedSendState {
  let raw: string | null
  try {
    raw = walletStorage.getCommitted(key(network, account))
  } catch {
    return { status: "unreadable" }
  }
  if (raw === null) return { status: "none" }
  try {
    const parsed = JSON.parse(raw) as Partial<UnresolvedSend>
    if (typeof parsed.address === "string" && typeof parsed.at === "number") {
      const send: UnresolvedSend = { address: parsed.address as Address, at: parsed.at }
      if (typeof parsed.submission === "string") send.submission = parsed.submission
      return { status: "held", send }
    }
  } catch {
    // Falls through: stored but not a marker this wallet wrote.
  }
  return { status: "unreadable" }
}

/**
 * Resolves once the marker is saved. Rejects with `UnresolvedSendHeldError` rather than replace another submission's
 * marker, and with `UnresolvedSendStorageError` unless this one is saved.
 */
export function holdUnresolvedSend(
  network: string,
  account: string,
  send: UnresolvedSend,
): Promise<void> {
  return serially(async () => {
    const saved = readUnresolvedSend(network, account)
    if (
      saved.status === "unreadable" ||
      (saved.status === "held" && (!send.submission || saved.send.submission !== send.submission))
    ) {
      throw new UnresolvedSendHeldError()
    }
    if (!walletStoreIsPersistent() && !(import.meta.env.DEV && isDemoMode())) {
      throw new UnresolvedSendStorageError()
    }
    const value = JSON.stringify(send)
    try {
      await walletStorage.commitItem(key(network, account), value)
      if (walletStorage.getCommitted(key(network, account)) === value) return
    } catch (err) {
      throw new UnresolvedSendStorageError(err)
    }
    throw new UnresolvedSendStorageError()
  })
}

/**
 * Resolves once the marker is removed from the database; rejects with `UnresolvedSendStorageError` otherwise. With
 * `only`, a marker is removed only if it matches every field given.
 */
export function clearUnresolvedSend(
  network: string,
  account: string,
  only?: { address?: Address; submission?: string },
): Promise<void> {
  return serially(async () => {
    if (only) {
      const saved = readUnresolvedSend(network, account)
      if (
        saved.status !== "held" ||
        (only.address && saved.send.address.toLowerCase() !== only.address.toLowerCase()) ||
        (only.submission && saved.send.submission !== only.submission)
      ) {
        return
      }
    }
    try {
      await walletStorage.commitRemove(key(network, account))
      if (walletStorage.getCommitted(key(network, account)) === null) return
    } catch (err) {
      throw new UnresolvedSendStorageError(err)
    }
    throw new UnresolvedSendStorageError()
  })
}
