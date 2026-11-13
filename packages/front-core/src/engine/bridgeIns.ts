import type { Address, Hex } from "viem"
import {
  BRIDGE_IN_TERMINAL,
  type BridgeInPays,
  type BridgeInQuote,
  type BridgeInRecord,
  type BridgeInStatus,
} from "../core/services/crossChain/types"
import type { Database } from "./database"
import { WalletError } from "./errors"
import { loadRecords, persistentStore } from "./persistentStore"
import type { Loaded } from "./recordSource"
import type { SipaDeposit } from "./sipaDeposits"
import { derived, type ReadonlyStore } from "./store"

const PREFIX = "acct/bridgeIns"

const lower = (hash: string) => hash.toLowerCase()

export const isBridgeInPending = (record: Pick<BridgeInRecord, "status">) =>
  !BRIDGE_IN_TERMINAL.includes(record.status)

/** Whether `record` was sent as `hash`, its own or one a sped-up resend replaced. */
export const bridgeInSentAs = (
  record: Pick<BridgeInRecord, "originTxHash" | "replacedHashes">,
  hash: string | undefined,
) =>
  hash !== undefined &&
  [record.originTxHash, ...(record.replacedHashes ?? [])].some(
    (h) => h !== undefined && lower(h) === lower(hash),
  )

/** What a bridge-in starts from, before the wallet signs its call. */
export interface BridgeInStart {
  originChainId: number
  depositor: Address
  recipient: Address
  /** The origin token's symbol. */
  symbol: string
  inputDecimals: number
  outputSymbol: string
  outputDecimals: number
  /** The quote the call is sent from: its last tx is the bridge call. */
  quote: BridgeInQuote
  feeUsd?: string
  /** The depositor's pending nonce, read before the wallet signs. */
  nonceHint: number
  startTime: number
  pays?: BridgeInPays
}

export type BridgeInEvent =
  | { type: "started"; id: string; start: BridgeInStart }
  /** The call's hash: the wallet's answer, the one the chain shows at its nonce, or a resend's. */
  | { type: "sent"; originTxHash: Hex; nonce?: number }
  | { type: "rebuilt"; record: BridgeInRecord }
  /** What a read learned: the nonce, or that the hint is spent. */
  | { type: "read"; nonce?: number; nonceHint?: number }
  | { type: "reported"; status: BridgeInStatus; at: number }
  /** A signing call that can no longer leave: its nonce went elsewhere, or its quote expired. */
  | { type: "dropped"; at: number }

/** The one way a bridge-in changes; undefined when the event does not apply. */
export function bridgeInTransition(
  current: BridgeInRecord | undefined,
  event: BridgeInEvent,
): BridgeInRecord | undefined {
  switch (event.type) {
    case "started": {
      if (current) return undefined
      const { quote, pays, feeUsd } = event.start
      const bridged = quote.bridged?.symbol === event.start.symbol ? undefined : quote.bridged
      const call = quote.txs.at(-1)
      if (!call) throw new WalletError("invariant", "bridgeIns: a quote with no bridge call")
      return {
        id: event.id,
        originChainId: event.start.originChainId,
        depositor: event.start.depositor,
        recipient: event.start.recipient,
        symbol: event.start.symbol,
        inputAmount: quote.inputAmount.toString(),
        outputAmount: quote.outputAmount.toString(),
        fee: quote.fee.toString(),
        ...(feeUsd !== undefined && { feeUsd }),
        inputDecimals: event.start.inputDecimals,
        outputSymbol: event.start.outputSymbol,
        outputDecimals: event.start.outputDecimals,
        ...(bridged && { bridged: { ...bridged, amount: bridged.amount.toString() } }),
        status: "signing",
        startTime: event.start.startTime,
        call: { to: call.to, data: call.data },
        nonceHint: event.start.nonceHint,
        ...(quote.expiresAt !== undefined && { quoteExpiresAt: quote.expiresAt }),
        ...(pays && { pays }),
      }
    }
    case "sent": {
      if (!current || !isBridgeInPending(current)) return undefined
      const { originTxHash: hash, nonce = current.nonce } = event
      if (current.status === "signing")
        return { ...current, status: "pending", originTxHash: hash, nonce }
      if (!current.originTxHash || bridgeInSentAs(current, hash)) return undefined
      return {
        ...current,
        originTxHash: hash,
        replacedHashes: [...(current.replacedHashes ?? []), current.originTxHash],
        nonce,
      }
    }
    case "rebuilt":
      return current?.status === "filled" ? undefined : event.record
    case "read": {
      if (current?.status !== "pending") return undefined
      return { ...current, nonce: event.nonce, nonceHint: event.nonceHint }
    }
    case "reported": {
      const { status, at } = event
      // Across refunds an expired deposit later.
      const refund = current?.status === "expired" && status.status === "refunded"
      if (!refund && (current?.status !== "pending" || status.status === current.status))
        return undefined
      return { ...current, ...status, ...(isBridgeInPending(status) ? {} : { endTime: at }) }
    }
    case "dropped":
      return current?.status === "signing"
        ? { ...current, status: "failed", endTime: event.at }
        : undefined
  }
}

/**
 * The account's bridge-ins, one record each by `id`. A bridge view starts a record before the
 * wallet signs and marks it sent with the hash; the tracker changes it after.
 */
export interface BridgeIns {
  /** Saved records, newest first; `hydrated` once they loaded. */
  readonly list: ReadonlyStore<Loaded<BridgeInRecord>>
  readonly ready: Promise<void>
  /** Every record, read once. */
  all(): Promise<readonly BridgeInRecord[]>
  get(id: string): Promise<BridgeInRecord | undefined>
  /** Saves a `signing` record; resolves once it is durable. */
  start(start: BridgeInStart): Promise<BridgeInRecord>
  /** Saves the hash the wallet returned; the record when it changed. */
  markSent(id: string, originTxHash: Hex): Promise<BridgeInRecord | undefined>
  /**
   * Saves a bridge-in rebuilt from the chain over the record sent as its hash, if any; undefined
   * when a filled one is already saved.
   */
  rebuild(record: Omit<BridgeInRecord, "id">): Promise<BridgeInRecord | undefined>
  /** Applies `events` in order in one write; the record when it changed. */
  apply(id: string, events: readonly BridgeInEvent[]): Promise<BridgeInRecord | undefined>
}

/** Whether a bridge-in may be bridging to, or has paid, its recipient. */
export const bridgeInDelivers = (record: Pick<BridgeInRecord, "status">) =>
  record.status === "signing" || record.status === "pending" || record.status === "filled"

/** The bridge-in bridging to, or that paid, `address`, one of this wallet's deposit addresses. */
export const bridgeInPaying = (records: readonly BridgeInRecord[], address: string) =>
  records.find((r) => !r.pays && bridgeInDelivers(r) && lower(r.recipient) === lower(address))

/** A deposit replayed onto this device, which another device may have bridged in. */
export const mayBeBridgedIn = (record: Pick<SipaDeposit, "replayed" | "intent" | "direct">) =>
  record.replayed === true && !record.intent && !record.direct

export function createBridgeIns({
  db,
  newId = () => crypto.randomUUID(),
}: {
  db: Database
  /** A random id; a record's key is `bridge-in:<newId()>`. */
  newId?: () => string
}): BridgeIns {
  const store = persistentStore<BridgeInRecord>(db, {
    prefix: PREFIX,
    version: 1,
    id: (record) => record.id,
    load: "all",
  })
  const list = derived([store.view], ({ records, loaded, failed }) => ({
    records: [...records].sort((a, b) => b.startTime - a.startTime),
    hydrated: loaded && !failed,
  }))
  const apply: BridgeIns["apply"] = (id, events) =>
    store.apply(id, (current) => {
      let next = current
      for (const event of events) next = bridgeInTransition(next, event) ?? next
      return next === current ? undefined : next
    })
  return {
    list,
    ready: store.ready,
    all: () => loadRecords(store.view),
    get: (id) => store.get(id),
    async start(start) {
      const id = `bridge-in:${newId()}`
      const record = await apply(id, [{ type: "started", id, start }])
      if (!record) throw new WalletError("invariant", `bridgeIns: ${id} already saved`)
      return record
    },
    markSent: (id, originTxHash) => apply(id, [{ type: "sent", originTxHash }]),
    async rebuild(rebuilt) {
      const hash = rebuilt.originTxHash
      if (!hash) throw new WalletError("invariant", "bridgeIns: a rebuild with no origin hash")
      await store.ready
      return db.write(async (w) => {
        const saved = (await loadRecords(store.view)).find((r) => bridgeInSentAs(r, hash))
        const id = saved?.id ?? `bridge-in:${newId()}`
        const record = { ...rebuilt, id }
        return store.apply(
          id,
          (current) => bridgeInTransition(current, { type: "rebuilt", record }),
          w,
        )
      })
    },
    apply,
  }
}
