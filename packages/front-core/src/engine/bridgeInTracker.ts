import type { Address, Hex } from "viem"
import type {
  BridgeInProvider,
  BridgeInRecord,
  BridgeInStatus,
} from "../core/services/crossChain/types"
import { isBridgeInPending, type BridgeInEvent, type BridgeIns } from "./bridgeIns"
import { bestEffort, WalletError } from "./errors"
import { task, within, type Task } from "./runtime"

/** A mined transaction on the origin chain. */
export interface OriginTx {
  hash: Hex
  to: Address | null
  input: Hex
}

/** Reads on a bridge-in's origin chain. Each throws when its read fails. */
export interface OriginChain {
  /** The call's receipt; undefined while the chain has none. */
  receipt(chainId: number, hash: Hex): Promise<"success" | "reverted" | undefined>
  /** The call's nonce; undefined while the RPC has not seen it. */
  nonce(chainId: number, hash: Hex): Promise<number | undefined>
  /** The latest block's number, and its timestamp in ms. */
  head(chainId: number): Promise<{ number: bigint; time: number }>
  /** How many transactions `from` has mined by `block`, or by the latest one. */
  minedCount(chainId: number, from: Address, block?: bigint): Promise<number>
  /** The transaction `from` mined with `nonce` in `block`. */
  minedIn(
    chainId: number,
    block: bigint,
    from: Address,
    nonce: number,
  ): Promise<OriginTx | undefined>
  /** An ERC-20's symbol and decimals. */
  token(chainId: number, address: Address): Promise<{ symbol: string; decimals: number }>
}

export interface BridgeInReadDeps {
  provider: BridgeInProvider
  origin: OriginChain
}

/** A read's status, and the record as now known: its nonce learned, or moved to a resend's hash. */
export interface BridgeInRead {
  record: BridgeInRecord
  status: BridgeInStatus
}

const PENDING: BridgeInStatus = { status: "pending" }
const FAILED: BridgeInStatus = { status: "failed" }
const same = (a: string | null | undefined, b: string) => a?.toLowerCase() === b.toLowerCase()
/** How many nonces past a missed hint a resend is looked for. */
const HINT_REACH = 4
/** How long past expiry a signed call may stay unknown to the RPC while it propagates. */
export const SENT_EXPIRY_GRACE_MS = 5 * 60_000

/**
 * A pending bridge-in's status now. The provider's word comes first. With none, it failed when:
 * - its origin call reverted;
 * - another call took its nonce;
 * - its quote expired on the origin chain's clock more than `SENT_EXPIRY_GRACE_MS` ago, the RPC
 *   does not know its hash, and nothing mined at its nonce: the call reverts once mined after
 *   expiry, so nothing can leave.
 * A resend of the same call, at its nonce or within a few past a send-time hint, takes the record
 * to its hash. Throws when a read fails.
 */
export async function readBridgeIn(
  record: BridgeInRecord & { originTxHash: Hex },
  deps: BridgeInReadDeps,
): Promise<BridgeInRead> {
  const { provider, origin } = deps
  const { originChainId: chainId, originTxHash: hash, depositor, call } = record
  const reported = await provider.status(chainId, hash)
  if (reported) return { record, status: reported }
  const receipt = await origin.receipt(chainId, hash)
  if (receipt === "reverted") return { record, status: FAILED }
  if (receipt === "success" || !call) return { record, status: PENDING }
  const seen = record.nonce === undefined ? await origin.nonce(chainId, hash) : undefined
  const nonce = record.nonce ?? seen
  const known = nonce === undefined || nonce === record.nonce ? record : { ...record, nonce }
  const at = nonce ?? record.nonceHint
  if (at === undefined) return { record: known, status: PENDING }
  const head = await origin.head(chainId)
  const expired =
    record.quoteExpiresAt !== undefined && head.time > record.quoteExpiresAt + SENT_EXPIRY_GRACE_MS
  const unseen = async () =>
    (record.nonce === undefined ? seen : await origin.nonce(chainId, hash)) === undefined
  const mined = await origin.minedCount(chainId, depositor, head.number)
  if (mined <= at) return { record: known, status: expired && (await unseen()) ? FAILED : PENDING }
  const resends = (tx: OriginTx) => isCall(tx, call)
  const follow = (tx: OriginTx, taken: number) => {
    const resent = unhinted(known)
    resent.originTxHash = tx.hash
    resent.nonce = taken
    resent.replacedHashes = [...(record.replacedHashes ?? []), hash]
    return readBridgeIn(resent, deps)
  }
  const used = await minedAt(origin, chainId, depositor, at, head.number)
  // Ours, its receipt not yet served.
  if (!used || same(used.hash, hash)) return { record: known, status: PENDING }
  if (resends(used)) return follow(used, at)
  if (nonce !== undefined) return { record: known, status: FAILED }
  // The hint named another call's nonce; a resend of ours may sit just past it.
  for (let n = at + 1; n <= Math.min(at + HINT_REACH, mined - 1); n++) {
    const tx = await minedAt(origin, chainId, depositor, n, head.number)
    if (tx && resends(tx)) return follow(tx, n)
  }
  if (expired && (await unseen())) return { record: known, status: FAILED }
  // With no expiry to end the search, the hint is dropped.
  return { record: record.quoteExpiresAt === undefined ? unhinted(known) : known, status: PENDING }
}

function unhinted<R extends BridgeInRecord>(record: R): R {
  const next = { ...record }
  delete next.nonceHint
  return next
}

const isCall = (tx: OriginTx, call: { to: Address; data: Hex }) =>
  same(tx.to, call.to) && same(tx.input, call.data)

/**
 * Where a `signing` record's call went, read by its depositor's nonce: `sent` once a nonce from the
 * hint on mined the call, `dropped` once every nonce near the hint mined something else or the
 * quote expired on the origin chain's clock more than `SENT_EXPIRY_GRACE_MS` ago, undefined while
 * neither is known. Throws when a read fails.
 */
export async function readSigning(
  record: BridgeInRecord,
  origin: OriginChain,
  at: number,
): Promise<Extract<BridgeInEvent, { type: "sent" } | { type: "dropped" }> | undefined> {
  const { originChainId: chainId, depositor, call, nonceHint: hint, quoteExpiresAt } = record
  const head = await origin.head(chainId)
  const expired = quoteExpiresAt !== undefined && head.time > quoteExpiresAt + SENT_EXPIRY_GRACE_MS
  if (!call || hint === undefined) return expired ? { type: "dropped", at } : undefined
  const mined = await origin.minedCount(chainId, depositor, head.number)
  for (let n = hint; n <= Math.min(hint + HINT_REACH, mined - 1); n++) {
    const tx = await minedAt(origin, chainId, depositor, n, head.number)
    if (tx && isCall(tx, call)) return { type: "sent", originTxHash: tx.hash, nonce: n }
  }
  return expired || mined > hint + HINT_REACH ? { type: "dropped", at } : undefined
}

/**
 * The transaction `from` mined with `nonce`, which its count at `head` has passed: found in the
 * first block whose count passed it, searched back from `head`.
 */
async function minedAt(
  origin: OriginChain,
  chainId: number,
  from: Address,
  nonce: number,
  head: bigint,
): Promise<OriginTx | undefined> {
  const passed = async (block: bigint) => (await origin.minedCount(chainId, from, block)) > nonce
  let hi = head
  let lo = -1n
  for (let step = 1n; hi - step >= 0n; step *= 2n) {
    if (!(await passed(hi - step))) {
      lo = hi - step
      break
    }
    hi -= step
  }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n
    if (await passed(mid)) hi = mid
    else lo = mid
  }
  return origin.minedIn(chainId, hi, from, nonce)
}

export interface BridgeInTrackerDeps {
  store: BridgeIns
  /** The profile's bridge provider; undefined where this build has none. */
  provider(): BridgeInProvider | undefined
  origin: OriginChain
  now: () => number
}

/** Records read per pass: one read can take dozens of origin-chain calls. */
export const BRIDGE_IN_READS_PER_PASS = 4

/** The events a read of a sent record learned, in the order they apply. */
function readEvents(record: BridgeInRecord, read: BridgeInRead, at: number): BridgeInEvent[] {
  const known = read.record
  const passed = (record.replacedHashes ?? []).length
  const hops =
    known.originTxHash === record.originTxHash
      ? []
      : [...(known.replacedHashes ?? []).slice(passed + 1), known.originTxHash!]
  return [
    ...hops.map((originTxHash) => ({ type: "sent" as const, originTxHash, nonce: known.nonce })),
    { type: "read", nonce: known.nonce, nonceHint: known.nonceHint },
    { type: "reported", status: read.status, at },
  ]
}

/**
 * Reads pending bridge-ins, and expired ones until refunded, every 10 s, and every minute while
 * hidden: a bridge fills or comes back with nobody watching, and a call signed before a reload is
 * found by its nonce. A pass reads a few records one at a time, taking up where the last pass
 * stopped. A read that fails leaves its record as it is; a pass where every read failed backs off.
 */
export function bridgeInTracker({ store, provider, origin, now }: BridgeInTrackerDeps): Task {
  let next = 0
  const follow = async (record: BridgeInRecord, bridge: BridgeInProvider | undefined) => {
    const { originTxHash } = record
    if (originTxHash === undefined) {
      const settled = await readSigning(record, origin, now())
      if (settled) await store.apply(record.id, [settled])
      return true
    }
    if (!bridge) return true
    if (record.status === "expired") {
      const status = await bridge.status(record.originChainId, originTxHash)
      if (status) await store.apply(record.id, [{ type: "reported", status, at: now() }])
      return true
    }
    const read = await readBridgeIn({ ...record, originTxHash }, { provider: bridge, origin })
    await store.apply(record.id, readEvents(record, read, now()))
    return true
  }
  return task("bridgeInTracker", {
    needs: {},
    every: 10_000,
    whenHidden: 60_000,
    backoff: { baseMs: 10_000, maxMs: 300_000 },
    async run({ signal }) {
      const bridge = provider()
      const pending = (await within(store.all(), "bridge-ins", { signal })).filter((r) =>
        bridge ? isBridgeInPending(r) || r.status === "expired" : r.status === "signing",
      )
      if (!pending.length) return
      const count = Math.min(pending.length, BRIDGE_IN_READS_PER_PASS)
      const start = next % pending.length
      next = start + count
      let read = 0
      for (let i = 0; i < count; i++) {
        if (signal.aborted) return
        const record = pending[(start + i) % pending.length]!
        const done = await bestEffort(
          "unknown",
          within(follow(record, bridge), "bridge-in read", { signal }),
        )
        if (done) read++
      }
      if (!read) throw new WalletError("unknown", "every bridge-in read failed")
    },
  })
}
