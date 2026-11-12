import type { SipaLinkPreimage } from "../core/paymentRequest/requestInlineCodec"
import { sipaDepositFulfillsRequest } from "../core/paymentRequest/sipaRequestFulfillment"
import { sipaPaymentIndex } from "../core/services/deposits/sipaCredits"
import type { SipaDeposit } from "./sipaDeposits"
import type { TokenTransaction, Transaction } from "../types/transactions"
import { fulfillmentSatisfiesRequest } from "../xmtp/RequestReceiver"
import type { Database, Reads, Write } from "./database"
import { loadRecords, persistentStore } from "./persistentStore"
import { task, type Task } from "./runtime"
import { derived, type ReadonlyStore } from "./store"
import { migrateRequests } from "../storageMigrations/requests"

export type RequestDirection = "outgoing" | "incoming"

/** What the user, or the payer, did with a request. */
export type RequestAction = "pending" | "declined" | "cancelled"

/**
 * `paid`: paid before payments were read from the chain. Only the migration writes it, and the
 * request reads fulfilled for good.
 */
export type StoredStatus = RequestAction | "paid"

/** `fulfilled` is not stored for new requests: `resolveRequests` reads it from the chain. */
export type RequestStatus = RequestAction | "fulfilled"

/** `contact`: announced to a saved contact over XMTP. `link`: a shareable `…/request#…` link. */
export type RequestKind = "contact" | "link"

export interface StoredRequest {
  id: string
  /** Bare tag (no leading `@`, no `.zk.money`); empty for a link. */
  contactTag: string
  /** USD amount as a number. */
  amount: number
  asset: string
  direction: RequestDirection
  status: StoredStatus
  createdAt: number
  note?: string
  kind?: RequestKind
  tokenAddress?: string
  /** Base units, stringified. `"0"` is any amount. */
  amountAtomic?: string
  /** The exponent `amountAtomic` was scaled by. */
  tokenDecimals?: number
  expiresAt?: number
  networkId?: string
  /** Requester's tag at mint time, preferred when re-minting a share URL. */
  requesterTag?: string
  requesterAddress?: string
  /** Self-broadcast L1 SIPA at mint time. */
  sipaAddress?: string
  sipaPreimage?: SipaLinkPreimage
  /** When the payer was last reminded (epoch ms). */
  remindedAt?: number
  /** The payment's tx hash; unset while a paying send has none yet. Stored only on `paid`. */
  fulfillmentTxHash?: string
  /** A Receive code minted without an amount: kept out of the requests the feed lists. */
  unlisted?: boolean
  /** Its payer was made a full contact. Set once, so a payer deleted since stays deleted. */
  payerApproved?: boolean
  /** The request's short link, once its publish landed; shared in place of the full link. */
  shortLink?: string
}

/** A request as screens read it: its status with the payment folded in. */
export interface PaymentRequest extends Omit<StoredRequest, "status"> {
  status: RequestStatus
  /**
   * The deposit payment a fulfilled request counts: its address, and its sweep's inbox index when
   * it has one. Activity and the CSV export show the request in its place.
   */
  paidByDeposit?: { sipaAddress: string; inboxIndex?: string }
}

export interface Requests {
  /** Every saved request with its status as the chain has it, oldest first. */
  readonly view: ReadonlyStore<readonly PaymentRequest[]>
  /** The saved requests and their payments loaded: until then a status may be wrong. */
  readonly loaded: ReadonlyStore<boolean>
  /** The first read of the saved requests and of their payments finished, even if one failed. */
  readonly settled: ReadonlyStore<boolean>
  readonly ready: Promise<void>
  /** `view` once loaded; rejects when a read failed. */
  all(): Promise<readonly PaymentRequest[]>
  get(id: string, w?: Write): Promise<StoredRequest | undefined>
  /** Every write resolves once saved; with `w`, it joins that transaction. */
  add(request: StoredRequest, w?: Write): Promise<void>
  /** `inserted: false` when a row with the id exists: a re-delivered request is a no-op. */
  addIfAbsent(request: StoredRequest, w?: Write): Promise<{ inserted: boolean }>
  decline(id: string): Promise<{ applied: boolean }>
  cancel(id: string): Promise<{ applied: boolean }>
  markReminded(id: string, at: number): Promise<{ applied: boolean }>
  markPayerApproved(id: string): Promise<{ applied: boolean }>
  setShortLink(id: string, shortLink: string): Promise<{ applied: boolean }>
  remove(id: string, w?: Write): Promise<void>
}

type SipaEvidence = Pick<
  SipaDeposit,
  | "phase"
  | "sipaAddress"
  | "amount"
  | "netAmount"
  | "fee"
  | "sweepTxHash"
  | "sweeps"
  | "inboxIndex"
  | "claimedInboxIndexes"
> &
  /** When the payment was funded: chain time, or when this device first saw it, never before. */
  Partial<Pick<SipaDeposit, "startTime">> & {
    /** The L2 token a past sweep credited, the units of its `netAmount`. */
    l2Token?: string
  }

/**
 * Each claimed sweep at a deposit address is one payment, split from its record as Activity splits
 * it (`sipaCredits`); an address funded again keeps its past ones.
 */
function sipaPayments(record: SipaEvidence): SipaEvidence[] {
  const current = sipaPaymentIndex(record)
  const past = (record.sweeps ?? [])
    .filter((sweep) => sweep.inboxIndex !== current)
    .map((sweep) => ({
      phase: "claimed" as const,
      sipaAddress: record.sipaAddress,
      amount: "0",
      netAmount: sweep.netAmount,
      sweepTxHash: sweep.sweepTxHash,
      inboxIndex: sweep.inboxIndex,
      startTime: sweep.settledAt,
      l2Token: sweep.l2Token,
    }))
  return record.phase === "claimed" ? [...past, record] : past
}

/** What pays a request: the activity rows and the SIPA deposits. */
export interface RequestPayments {
  rows: readonly Transaction[]
  deposits: readonly SipaEvidence[]
}

export interface RequestsDeps {
  /** The account's database. */
  db: Database
  /** `loaded` once every payment source loaded; `failed` when one could not be read. */
  payments: ReadonlyStore<RequestPayments & { loaded: boolean; failed: boolean }>
  /** The page's database, which holds the ids of older builds' Receive codes minted without an amount. */
  legacy?: Pick<Reads, "get">
}

/** What the user, or the payer, does to a request. */
export type RequestEvent =
  | { type: "decline" }
  | { type: "cancel" }
  | { type: "remind"; at: number }
  | { type: "payerApproved" }
  | { type: "shortLink"; shortLink: string }

/**
 * The one place a stored request changes; `undefined` leaves it as it is. A short link is recorded
 * whatever the request reads. A paid request only records its payer's approval, once. Otherwise only
 * a request that reads pending moves: a declined or cancelled one stays so. Only an outgoing request
 * is reminded.
 */
export function requestTransition(
  row: StoredRequest,
  event: RequestEvent,
  resolved: RequestStatus,
): StoredRequest | undefined {
  if (event.type === "shortLink") return { ...row, shortLink: event.shortLink }
  if (event.type === "payerApproved") {
    return resolved === "fulfilled" && !row.payerApproved
      ? { ...row, payerApproved: true }
      : undefined
  }
  if (resolved !== "pending") return undefined
  switch (event.type) {
    case "decline":
      return { ...row, status: "declined" }
    case "cancel":
      return { ...row, status: "cancelled" }
    case "remind":
      return row.direction === "outgoing" ? { ...row, remindedAt: event.at } : undefined
  }
}

export function createRequests({ db, payments, legacy }: RequestsDeps): Requests {
  const PREFIX = "acct/requests"
  const store = persistentStore<StoredRequest>(db, {
    prefix: PREFIX,
    version: 3,
    id: (request) => request.id,
    migrate: (from, w) => migrateRequests(from, w, { db, prefix: PREFIX, legacy }),
    load: "all",
  })
  const resolved = derived([store.view, payments] as const, (saved, paid) => ({
    records: resolveRequests(
      [...saved.records].sort((a, b) => a.createdAt - b.createdAt),
      paid,
    ),
    loaded: saved.loaded && paid.loaded,
    failed: saved.failed || paid.failed,
  }))
  const view = derived([resolved], ({ records }) => records)
  const all = () => loadRecords(resolved)
  const writing = async <T>(w: Write | undefined, fn: (w: Write) => Promise<T>): Promise<T> => {
    if (w) return fn(w)
    await store.ready
    return db.write(fn)
  }
  const apply = async (id: string, event: RequestEvent) => {
    // The chain's word comes from the loaded view; the user's from the saved row.
    const fulfilled = (await all()).find((r) => r.id === id)?.status === "fulfilled"
    return writing(undefined, async (w) => {
      const row = await store.get(id, w)
      const paid = row?.status === "paid" || fulfilled
      const next =
        row && requestTransition(row, event, paid ? "fulfilled" : (row.status as RequestAction))
      if (!next) return { applied: false }
      await store.put(next, w)
      return { applied: true }
    })
  }

  return {
    view,
    loaded: derived([resolved], ({ loaded, failed }) => loaded && !failed),
    settled: derived(
      [store.view, payments] as const,
      (saved, paid) => (saved.loaded || saved.failed) && (paid.loaded || paid.failed),
    ),
    ready: store.ready,
    all,
    get: store.get,
    add: store.put,
    addIfAbsent: (request, w) =>
      writing(w, async (w) => {
        if (await store.get(request.id, w)) return { inserted: false }
        await store.put(request, w)
        return { inserted: true }
      }),
    decline: (id) => apply(id, { type: "decline" }),
    cancel: (id) => apply(id, { type: "cancel" }),
    markReminded: (id, at) => apply(id, { type: "remind", at }),
    markPayerApproved: (id) => apply(id, { type: "payerApproved" }),
    setShortLink: (id, shortLink) => apply(id, { type: "shortLink", shortLink }),
    remove: store.remove,
  }
}

const lower = (value: string | undefined) => value?.toLowerCase()

/**
 * The clock skew a deposit's funding time, chain time, tolerates against a request's `createdAt`,
 * the device's time at mint.
 */
export const FUNDING_SKEW_MS = 2 * 60_000

/**
 * Each request with its status as the chain has it, whatever the user did to it since. A migrated
 * `paid` request is paid. An incoming request is paid while a send carrying its id in
 * `Transfer.meta` has not failed. An outgoing one is paid by a receive carrying its id, from its
 * contact when it names one, that covers the token and amount. A claimed deposit to a request
 * link's address pays one request there: the oldest live one, else the newest cancelled one, and no
 * request whose payment another already counts. An edit mints another request at the same address
 * and cancels the one it replaces, which a paid request refuses, so two live requests there mean the
 * older was paid first. A request minted after the deposit was funded takes it only when none minted
 * before can. A request a deposit pays names that payment.
 */
export function resolveRequests(
  stored: readonly StoredRequest[],
  payments: RequestPayments,
): PaymentRequest[] {
  const byRequest = new Map<string, Transaction[]>()
  for (const tx of payments.rows) {
    const id = lower((tx as { requestId?: string }).requestId)
    if (!id || tx.status === "failed") continue
    byRequest.set(id, [...(byRequest.get(id) ?? []), tx])
  }
  const paid = new Map<string, string | undefined>()
  for (const request of stored) {
    if (request.status === "paid") {
      paid.set(request.id, request.fulfillmentTxHash)
      continue
    }
    const txs = byRequest.get(request.id.toLowerCase()) ?? []
    if (request.direction === "incoming") {
      const send = txs.find((tx) => tx.action === "send")
      if (send) paid.set(request.id, send.txHash || undefined)
      continue
    }
    const tag = lower(request.contactTag)
    const receive = txs.find(
      (tx): tx is TokenTransaction =>
        tx.action === "receive" &&
        !!tx.txHash &&
        (!tag || tag === lower((tx as TokenTransaction).from)) &&
        fulfillmentSatisfiesRequest(request, tx as TokenTransaction),
    )
    if (receive) paid.set(request.id, receive.txHash)
  }

  const used = new Set([...paid.values()].flatMap((hash) => (hash ? [hash.toLowerCase()] : [])))
  const addresses = new Set(stored.flatMap((r) => (r.sipaAddress ? [lower(r.sipaAddress)] : [])))
  const deposits = payments.deposits
    .filter((d) => addresses.has(d.sipaAddress.toLowerCase()))
    .flatMap(sipaPayments)
  const known = new Set(
    deposits.flatMap((d) => (d.sweepTxHash ? [d.sweepTxHash.toLowerCase()] : [])),
  )
  const receives = new Set(
    payments.rows.flatMap((tx) =>
      tx.action === "receive" && tx.txHash ? [tx.txHash.toLowerCase()] : [],
    ),
  )
  const paidBy = new Map<string, SipaEvidence>()
  // A migrated paid request counts the payment its hash names. One whose hash no payment here
  // carries holds the earliest payment at its address, unless an L2 receive carries it.
  const held = new Set<SipaEvidence>()
  for (const r of stored) {
    const hash = lower(r.fulfillmentTxHash) ?? ""
    if (r.status !== "paid" || !r.sipaAddress || receives.has(hash)) continue
    const address = r.sipaAddress.toLowerCase()
    const payment = known.has(hash)
      ? deposits.find((d) => lower(d.sweepTxHash) === hash)
      : deposits.find((d) => !held.has(d) && d.sipaAddress.toLowerCase() === address)
    if (!payment) continue
    if (!known.has(hash)) held.add(payment)
    paidBy.set(r.id, payment)
  }
  const rank = (r: StoredRequest) => (r.status === "cancelled" ? 0 : 1)
  for (const record of deposits) {
    if (held.has(record)) continue
    const txHash = record.sweepTxHash
    const address = record.sipaAddress.toLowerCase()
    const consumed = txHash
      ? used.has(txHash.toLowerCase())
      : stored.some((r) => paid.has(r.id) && lower(r.sipaAddress) === address)
    if (consumed) continue
    const token = lower(record.l2Token)
    const fits = stored.filter(
      (r) =>
        !paid.has(r.id) &&
        (!token || !r.tokenAddress || token === lower(r.tokenAddress)) &&
        sipaDepositFulfillsRequest(record, r),
    )
    const fundedAt = record.startTime
    const before =
      fundedAt === undefined ? [] : fits.filter((r) => r.createdAt <= fundedAt + FUNDING_SKEW_MS)
    const request = (before.length ? before : fits).sort(
      (a, b) =>
        rank(b) - rank(a) || (rank(a) ? a.createdAt - b.createdAt : b.createdAt - a.createdAt),
    )[0]
    if (!request) continue
    paid.set(request.id, txHash)
    paidBy.set(request.id, record)
    if (txHash) used.add(txHash.toLowerCase())
  }

  return stored.map(({ status, ...request }) => {
    if (!paid.has(request.id)) return { ...request, status: status as RequestAction }
    const deposit = paidBy.get(request.id)
    return {
      ...request,
      status: "fulfilled",
      fulfillmentTxHash: paid.get(request.id),
      ...(deposit && {
        paidByDeposit: { sipaAddress: deposit.sipaAddress, inboxIndex: deposit.inboxIndex },
      }),
    }
  })
}

/** The receives whose `Transfer.meta` named this request. */
export function receivesForRequest(
  rows: readonly Transaction[],
  requestId: string,
): TokenTransaction[] {
  const id = requestId.toLowerCase()
  return rows.filter(
    (tx): tx is TokenTransaction =>
      tx.action === "receive" && lower((tx as TokenTransaction).requestId) === id,
  )
}

/** The receive that paid a fulfilled request, when one did. */
export function fulfillingReceive(
  request: Pick<PaymentRequest, "fulfillmentTxHash">,
  rows: readonly Transaction[],
): TokenTransaction | undefined {
  const hash = lower(request.fulfillmentTxHash)
  if (!hash) return undefined
  return rows.find(
    (row): row is TokenTransaction => row.action === "receive" && lower(row.txHash) === hash,
  )
}

/**
 * The payer of each outgoing request whose approval is not yet recorded: the sender of the receive
 * that paid it. Paying a request is how a requester approves who answered.
 */
export function payersToApprove(
  requests: readonly PaymentRequest[],
  rows: readonly Transaction[],
): { requestId: string; payer: string }[] {
  return requests.flatMap((request) => {
    if (request.direction !== "outgoing" || request.status !== "fulfilled") return []
    if (request.payerApproved) return []
    const tx = fulfillingReceive(request, rows)
    if (!tx?.senderL2Address || lower(tx.requestId) !== lower(request.id)) return []
    return [{ requestId: request.id, payer: tx.senderL2Address }]
  })
}

export interface PayerApprovalDeps {
  requests: Pick<Requests, "view" | "markPayerApproved">
  rows: ReadonlyStore<readonly Transaction[]>
  /** Makes the payer a full contact when the wallet added it; resolves once saved. */
  approve(l2Address: string): Promise<unknown>
}

/**
 * Approves the payer of each request `payersToApprove` names, then records it on the request, on
 * each change of what it reads. A failed approval runs again after 1 s, doubling to a minute.
 */
export function payerApprovals(deps: PayerApprovalDeps): Task {
  return task("payerApprovals", {
    needs: {},
    on: {
      due: derived(
        [deps.requests.view, deps.rows] as const,
        payersToApprove,
        (a, b) =>
          a.length === b.length &&
          a.every((p, i) => p.requestId === b[i].requestId && p.payer === b[i].payer),
      ),
    },
    every: "once",
    backoff: { baseMs: 1_000, maxMs: 60_000 },
    run: async ({ due }) => {
      for (const { requestId, payer } of due) {
        await deps.approve(payer)
        await deps.requests.markPayerApproved(requestId)
      }
    },
  })
}

/** A reminder blocks the next one for this long. */
export const REMIND_INTERVAL_MS = 12 * 60 * 60 * 1000

export function remindedRecently(remindedAt: number | undefined, now: number): boolean {
  return remindedAt !== undefined && now - remindedAt < REMIND_INTERVAL_MS
}
