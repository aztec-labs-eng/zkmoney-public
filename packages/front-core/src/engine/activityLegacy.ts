import { parseUnits } from "viem"
import type { PaylinkTransaction, Transaction } from "../types/transactions"
import type { TokenInTxService } from "../types/tokens"
import type { Failure } from "./errors"
import type { KvStore } from "./kv"
import { ACCOUNT_STORAGE_KEY, TRANSACTIONS_STORAGE_KEY } from "../core/storages/constants"

/** The texts older builds stored on a row the tab closed on before it was sent. */
const INTERRUPTED_TEXTS = new Set([
  "This payment was interrupted before it was sent. The amount is still in your balance.",
  "The tab closed before it was sent. The amount is still in your balance.",
  "The tab closed before the link was funded. The amount is still in your balance.",
  "The tab closed before your claim was sent. The link can still be claimed.",
  "The tab closed before it was sent.",
])

type LegacyRow = Omit<Transaction, "id" | "amountAtomic" | "failure"> & {
  queueId?: string
  error?: string
  amountAtomic?: string
}

/**
 * The legacy blob's rows: `TRANSACTIONS_STORAGE_KEY` (one JSON array), or, where no build split it
 * out yet, the account blob's `transactions`. A malformed blob holds none.
 */
export function legacyRows(get: (key: string) => string | null | undefined): object[] {
  const own = get(TRANSACTIONS_STORAGE_KEY)
  const list =
    own === null || own === undefined
      ? (parse(get(ACCOUNT_STORAGE_KEY)) as { transactions?: unknown } | null)?.transactions
      : parse(own)
  return Array.isArray(list) ? list.filter((row) => typeof row === "object" && row !== null) : []
}

function parse(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * Every legacy row (`legacyRows`), keyed as the store keys it. Rows the chain could rebuild are
 * carried too: the current token, which tells them apart from a retired deployment's rows and
 * links announced before the payout lane, is only known once the wallet's token service loads.
 */
export function legacyActivity(kv: Pick<KvStore, "getItem">): [string, Transaction][] {
  const out = new Map<string, Transaction>()
  legacyRows((key) => kv.getItem(key)).forEach((row, i) => {
    const converted = convert(row as LegacyRow, i)
    out.set(converted.id, converted)
  })
  return [...out]
}

/** One row of a legacy blob, as `legacyActivity` converts it; `index` is its place in the blob. */
export function legacyRow(row: object, index: number): Transaction {
  return convert(row as LegacyRow, index)
}

function convert(legacy: LegacyRow, index: number): Transaction {
  const { queueId, error, amountAtomic, ...row } = legacy
  const operationId = row.operationId ?? queueId
  const txHash = row.txHash ?? ""
  const id = operationId ?? (txHash ? txHash.toLowerCase() : `legacy-${row.timestamp}-${index}`)
  const token = (row as { token?: TokenInTxService }).token
  const atomic =
    amountAtomic !== undefined
      ? BigInt(amountAtomic)
      : token && !token.hasUnknownAmount
      ? floatToAtomic(token.amount, token.decimals)
      : 0n
  const converted = {
    ...row,
    id,
    txHash,
    ...(operationId ? { operationId } : {}),
    amountAtomic: atomic,
    ...(error ? { failure: failureOf(error) } : {}),
  } as Transaction
  return withFlavor(converted)
}

function failureOf(error: string): Failure {
  return INTERRUPTED_TEXTS.has(error)
    ? { code: "tx.interrupted" }
    : { code: "tx.failed", detail: error }
}

/** The stored display float at the token's decimals: the precision it already had, no less. */
function floatToAtomic(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount)) return 0n
  const text = String(amount)
  try {
    return parseUnits(/e/i.test(text) ? amount.toFixed(decimals) : text, decimals)
  } catch {
    return 0n
  }
}

/** Paylink rows from before `flavor` existed: an email recipient makes it an email link. */
function withFlavor(row: Transaction): Transaction {
  const link = row as PaylinkTransaction
  if (typeof link.emailPaymentAction !== "string" || link.flavor !== undefined) return row
  const email = typeof link.to === "string" && /^[^@\s]+@[^@\s]+$/.test(link.to)
  return { ...link, flavor: email ? "email" : "direct" }
}
