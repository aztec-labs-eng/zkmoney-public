import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TRANSACTIONS_STORAGE_KEY, TransactionStorage } from "../../src/core"
import { paylinkRefundEligibility } from "../../src/core/services/paylink/refundParamsFromRow"
import type { PaylinkTransaction, Transaction } from "../../src/types"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"

// cross-tab eligibility re-read. A successful refund writes `isRefunded`
// (and scrubs `paylink`) through `TransactionStorage`; every entry point's CTA
// re-reads `paylinkRefundEligibility` off the freshly-loaded row, so the same
// PAY row that was eligible must read as ineligible afterwards — no manual
// refresh. This exercises the real write→read flow through the storage
// singleton, not an in-place mutation of a throwaway object.

const ACCOUNT = "0x" + "a".repeat(64)
const SECRET = "0xsecret"

// A complete, refundable PAY row (window [1000, 2000]). `nowSec=3000` (expired)
// makes it eligible before the refund write lands.
const refundablePayRow = (overrides: Partial<PaylinkTransaction> = {}): PaylinkTransaction =>
  ({
    action: "Pay To Email",
    emailPaymentAction: "Pay To Email",
    flavor: "direct",
    timestamp: Date.now(),
    status: "success",
    txHash: "0xrow",
    payToEmailSecret: SECRET,
    obsidionAccountAddress: ACCOUNT,
    paylink: "https://x/#frag",
    fallbackSecret: "0xtag",
    fromClaimable: 1000,
    untilClaimable: 2000,
    ...overrides,
  } as PaylinkTransaction)

// Finds the row by the same fields a refund write matches on.
const matchesEmailPayment = (payToEmailSecret: string, account: string) => (tx: Transaction) => {
  const p = tx as PaylinkTransaction
  return (
    p.emailPaymentAction === "Pay To Email" &&
    p.payToEmailSecret === payToEmailSecret &&
    p.obsidionAccountAddress === account
  )
}

const resetSingleton = () => {
  ;(TransactionStorage as unknown as { instance: TransactionStorage | null }).instance = null
}

describe("paylink refund eligibility re-read after a refund write (R11)", () => {
  let storage: TransactionStorage
  let adapter: InMemoryStorageAdapter

  beforeEach(() => {
    resetSingleton()
    adapter = new InMemoryStorageAdapter()
    storage = TransactionStorage.get(adapter)
  })

  afterEach(() => {
    resetSingleton()
  })

  it("flips the same PAY row's CTA from eligible to ineligible after isRefunded is written", async () => {
    await adapter.setItem(TRANSACTIONS_STORAGE_KEY, JSON.stringify([refundablePayRow()]))

    // Before the refund write, the CTA is eligible (expired window).
    const before = (await storage.getTransactions())[0] as PaylinkTransaction
    expect(paylinkRefundEligibility(before, 3000)).toEqual({ eligible: true })

    // Stand in for a refund write: set `isRefunded`, scrub `paylink`. This
    // suite covers `paylinkRefundEligibility`, not the writer — the browser
    // wallet's `markCreateRowRefunded` is the live one, and its own suite
    // covers that it performs this mutation.
    const wrote = await storage.updateTransaction(matchesEmailPayment(SECRET, ACCOUNT), (tx) => {
      const p = tx as PaylinkTransaction
      p.isRefunded = true
      p.paylink = undefined
    })
    expect(wrote).toBe(true)

    // Re-reading the same row (as any tab's CTA does each render) now yields
    // ineligible — `refunded` wins over the scrubbed-link `unavailable` reason.
    const after = (await storage.getTransactions())[0] as PaylinkTransaction
    expect(after.isRefunded).toBe(true)
    expect(paylinkRefundEligibility(after, 3000)).toEqual({
      eligible: false,
      reason: "refunded",
    })
  })
})
