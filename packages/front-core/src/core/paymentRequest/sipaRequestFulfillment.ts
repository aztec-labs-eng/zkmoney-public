/**
 * Creator-side join: a claimed SIPA deposit whose address matches a minted
 * request-link row fulfills that request. Mint itself publishes the SIPA, so
 * SIPA event discovery (`broadcast`) is not payment — only `claimed` (balance-visible)
 * counts, same bar as L2 send verification.
 */
import { depositAmounts } from "../services/deposits/depositAmounts.js"
import type { SIPADepositRecord } from "../services/deposits/SIPADepositStore.js"
import type { PaymentRequest, RequestStorage } from "../storages/RequestStorage.js"

type SipaFulfillmentRecord = Pick<
  SIPADepositRecord,
  "phase" | "sipaAddress" | "amount" | "netAmount" | "fee" | "claimTxHash" | "sweepTxHash"
>

type SipaFulfillmentRequest = Pick<
  PaymentRequest,
  "direction" | "status" | "sipaAddress" | "amountAtomic"
>

/** True when this claimed deposit closes the request: same SIPA, net credits at least the asked amount. */
export function sipaDepositFulfillsRequest(
  record: SipaFulfillmentRecord,
  request: SipaFulfillmentRequest,
): boolean {
  if (record.phase !== "claimed") return false
  if (request.direction !== "outgoing" || request.status === "fulfilled") return false
  if (!request.sipaAddress) return false
  if (record.sipaAddress.toLowerCase() !== request.sipaAddress.toLowerCase()) return false
  const requested = BigInt(request.amountAtomic ?? "0")
  if (requested === 0n) return true
  return depositAmounts(record).netAtomic >= requested
}

/** Lowercased SIPA addresses stamped on stored requests — Activity hides matching deposits. */
export function requestLinkedSipaAddresses(
  requests: ReadonlyArray<Pick<PaymentRequest, "sipaAddress">>,
): Set<string> {
  const out = new Set<string>()
  for (const request of requests) {
    if (request.sipaAddress) out.add(request.sipaAddress.toLowerCase())
  }
  return out
}

/**
 * Each claimed deposit fulfills one request. Rows sharing its address are earlier requests the code
 * replaced, so the live row wins, else the newest cancelled one.
 */
export async function reconcileSipaRequestFulfillments(
  store: Pick<RequestStorage, "list" | "applyStatus">,
  records: readonly SipaFulfillmentRecord[],
): Promise<void> {
  const claimed = records.filter((record) => record.phase === "claimed")
  if (claimed.length === 0) return
  const all = await store.list()
  const used = new Set(all.flatMap((row) => (row.fulfillmentTxHash ? [row.fulfillmentTxHash] : [])))
  const rank = (row: PaymentRequest) => (row.status === "cancelled" ? 0 : 1)
  for (const record of claimed) {
    const txHash = record.claimTxHash ?? record.sweepTxHash
    const address = record.sipaAddress.toLowerCase()
    const consumed = txHash
      ? used.has(txHash)
      : all.some((r) => r.status === "fulfilled" && r.sipaAddress?.toLowerCase() === address)
    if (consumed) continue
    const row = all
      .filter((r) => sipaDepositFulfillsRequest(record, r))
      .sort((a, b) => rank(b) - rank(a) || b.createdAt - a.createdAt)[0]
    if (!row) continue
    await store.applyStatus(row.id, "fulfilled", txHash)
    row.status = "fulfilled"
    if (txHash) used.add(txHash)
  }
}
