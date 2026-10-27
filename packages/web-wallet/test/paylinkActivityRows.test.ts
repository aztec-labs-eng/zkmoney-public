/**
 * Paylink activity-row storage: the sponsored create/claim glue writes the same
 * PaylinkTransaction rows (pending synth row → txHash/paylink patch →
 * terminal status), and those rows surface in the activity view.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { PaylinkActionEnum, type PaylinkService } from "@obsidion/sdk"
import {
  TransactionStorage,
  TxInFlightError,
  type IStorageAdapter,
  type PaylinkTransaction,
} from "@obsidion/front-core"
import { creatorLinkAction } from "../src/features/paylink/creatorLinkActions"
import {
  failPaylinkRow,
  finishPaylinkRow,
  markCreateRowClaimed,
  markCreateRowRefunded,
  markCreateRowRefundSubmitted,
  paylinkFailure,
  startPaylinkRow,
  type SponsoredPaylinkDeps,
} from "../src/features/paylink/sponsoredPaylink"
import { buildActivityRows, isPendingActivityRow } from "../src/ui/screens/activityView"
import { PaylinkClaimReconciler } from "@obsidion/front-core"

const TX_HASH = `0x${"ab".repeat(32)}`
const ACCOUNT = `0x${"22".repeat(32)}`
const TOKEN_ADDR = `0x${"33".repeat(32)}`
const SECRET = `0x${"44".repeat(32)}`

/** completeTransaction's storage write is fire-and-forget; give it a tick before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 10))

function memStorage(): IStorageAdapter {
  const m = new Map<string, string>()
  return {
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => {
      m.set(k, v)
    },
    removeItem: async (k) => {
      m.delete(k)
    },
    clear: async () => {
      m.clear()
    },
  }
}

/** Fresh TransactionStorage over in-memory storage, pre-seeded to skip the legacy migration. */
async function freshTxStorage(storage: IStorageAdapter): Promise<TransactionStorage> {
  ;(TransactionStorage as unknown as { instance: TransactionStorage | null }).instance = null
  await storage.setItem("obsidion_transactions", "[]")
  return TransactionStorage.get(storage)
}

// startTrackingTx subscribes to the service's "status" events; a bare emitter stub suffices.
const svcStub = { on: () => {}, off: () => {} } as unknown as PaylinkService

const deps = {
  tokenService: {
    fetchTokenInformation: async () => ({
      address: TOKEN_ADDR,
      name: "DAI",
      symbol: "DAI",
      decimals: 6,
    }),
  },
  account: { getAddress: () => ({ toString: () => ACCOUNT }) },
} as unknown as SponsoredPaylinkDeps

const emptyDirectory = {
  contacts: [],
  lookup: () => undefined,
  lookupByAddress: () => undefined,
}

describe("paylink activity rows", () => {
  let store: TransactionStorage

  beforeEach(async () => {
    store = await freshTxStorage(memStorage())
  })

  it("create: pending synth row → success row with hash + link, visible in the activity view", async () => {
    const { queueId } = await startPaylinkRow(
      deps,
      svcStub,
      "paylink-create",
      PaylinkActionEnum.PAY,
      25,
    )

    let [row] = (await store.getTransactions()) as PaylinkTransaction[]
    expect(row.status).toBe("pending")
    expect(row.emailPaymentAction).toBe(PaylinkActionEnum.PAY)
    expect(row.flavor).toBe("direct")
    expect(row.kind).toBe("paylink-create")
    expect(row.obsidionAccountAddress).toBe(ACCOUNT)
    expect(row.token?.amount).toBe(25)

    await finishPaylinkRow(queueId, TX_HASH, {
      payToEmailSecret: SECRET,
      paylink: "https://wallet.example/link#frag",
      untilClaimable: 1234,
    })
    await settle()
    ;[row] = (await store.getTransactions()) as PaylinkTransaction[]
    expect(row.status).toBe("success")
    expect(row.txHash).toBe(TX_HASH)
    expect(row.paylink).toBe("https://wallet.example/link#frag")
    expect(row.untilClaimable).toBe(1234)

    const [view] = buildActivityRows([row], emptyDirectory)
    expect(view.counterparty).toBe("Sent via paylink")
    expect(view.amount).toBe("-$25.00")
  })

  it("create (email flavor): row carries flavor 'email' and the locked recipient", async () => {
    await startPaylinkRow(deps, svcStub, "paylink-create", PaylinkActionEnum.PAY, 25, {
      flavor: "email",
      to: "friend@example.com",
    })

    const [row] = (await store.getTransactions()) as PaylinkTransaction[]
    expect(row.flavor).toBe("email")
    expect(row.to).toBe("friend@example.com")
  })

  it("claim: success row, and the creator's PAY row flips to claimed", async () => {
    const { queueId: createId } = await startPaylinkRow(
      deps,
      svcStub,
      "paylink-create",
      PaylinkActionEnum.PAY,
      25,
    )
    await finishPaylinkRow(createId, TX_HASH, {
      payToEmailSecret: SECRET,
      paylink: "https://x/l#f",
    })

    const { queueId: claimId } = await startPaylinkRow(
      deps,
      svcStub,
      "paylink-claim",
      PaylinkActionEnum.CLAIM,
      25,
    )
    await finishPaylinkRow(claimId, `0x${"cd".repeat(32)}`)
    await settle()
    await markCreateRowClaimed(SECRET, "direct", ACCOUNT)

    const rows = (await store.getTransactions()) as PaylinkTransaction[]
    const claim = rows.find((r) => r.emailPaymentAction === PaylinkActionEnum.CLAIM)!
    const create = rows.find((r) => r.emailPaymentAction === PaylinkActionEnum.PAY)!
    expect(claim.status).toBe("success")
    expect(claim.kind).toBe("paylink-claim")
    expect(create.isClaimed).toBe(true)
    expect(create.paylink).toBeUndefined()

    const [view] = buildActivityRows([claim], emptyDirectory)
    expect(view.counterparty).toBe("Received via paylink")
    expect(view.amount).toBe("+$25.00")
  })

  it.each([
    ["reclaim", "email"],
    ["cancel", "direct"],
  ] as const)(
    "%s: the refund folds into the creator's PAY row, which carries both hashes",
    async (_label, flavor) => {
      const { queueId: createId } = await startPaylinkRow(
        deps,
        svcStub,
        "paylink-create",
        PaylinkActionEnum.PAY,
        25,
        { flavor },
      )
      await finishPaylinkRow(createId, TX_HASH, {
        payToEmailSecret: SECRET,
        paylink: "https://x/l#f",
        fallbackSecret: `0x${"55".repeat(32)}`,
        fromClaimable: 0,
        untilClaimable: 1234,
      })

      const { queueId: backId } = await startPaylinkRow(
        deps,
        svcStub,
        "paylink-refund",
        PaylinkActionEnum.CLAIM_BACK,
        25,
        { flavor },
      )
      const refundHash = `0x${"ef".repeat(32)}`
      await finishPaylinkRow(backId, refundHash)
      await settle()
      await markCreateRowRefunded(SECRET, flavor, ACCOUNT, refundHash, "cancel")

      const rows = (await store.getTransactions()) as PaylinkTransaction[]
      const back = rows.find((r) => r.emailPaymentAction === PaylinkActionEnum.CLAIM_BACK)!
      const create = rows.find((r) => r.emailPaymentAction === PaylinkActionEnum.PAY)!
      expect(back.status).toBe("success")
      expect(back.kind).toBe("paylink-refund")
      expect(create.isRefunded).toBe(true)
      // Scrubbed with the refund: the link can never be claimed again.
      expect(create.paylink).toBeUndefined()

      // The refund transaction is readable off the create row, which is the only row left.
      expect(create.refundTxHash).toBe(refundHash)

      // The escrow left and came back, so the round trip is one row, not two.
      expect(buildActivityRows([back], emptyDirectory)).toHaveLength(0)
      // And the create row's own status pill follows its flag, so no CTA survives.
      const [createView] = buildActivityRows([create], emptyDirectory)
      expect(createView.paylinkStatus).toBe("refunded")
      expect(createView.statusLabel).toBe("Cancelled")
      expect(createView.refundTxHash).toBe(refundHash)
      expect(
        creatorLinkAction(createView.paylinkRow!, {
          nowSec: 9999,
          liveStatus: "refunded",
          account: ACCOUNT,
        }),
      ).toBeNull()
    },
  )

  it("failure terminalizes the row as failed", async () => {
    const { queueId } = await startPaylinkRow(
      deps,
      svcStub,
      "paylink-create",
      PaylinkActionEnum.PAY,
      5,
    )
    await failPaylinkRow(queueId, new Error("prove failed"))
    await settle()
    const [row] = await store.getTransactions()
    expect(row.status).toBe("failed")
    // No expiry was ever saved: the failed row must not sit under Pending until one passes.
    const [view] = buildActivityRows([row], emptyDirectory)
    expect(view.statusLabel).toBe("Failed")
    expect(isPendingActivityRow(view)).toBe(false)
  })

  // ULT-876: past the submit boundary the tx may still land, so a rejection is not a failed row —
  // and the caller has to learn that too, or its screen offers to send the same operation again.
  it("leaves the row alone and surfaces the in-flight hash when the tx reached the node", async () => {
    const { queueId } = await startPaylinkRow(
      deps,
      svcStub,
      "paylink-create",
      PaylinkActionEnum.PAY,
      5,
    )
    const rejection = new Error("socket closed")
    const submission = { survived: async () => TX_HASH as `0x${string}` }
    const surfaced = await paylinkFailure(queueId, rejection, submission, {} as never)
    expect(surfaced).toBeInstanceOf(TxInFlightError)
    expect(surfaced).toMatchObject({
      txHash: TX_HASH,
      message: rejection.message,
      cause: rejection,
    })
    await settle()
    const [row] = await store.getTransactions()
    expect(row.status).not.toBe("failed")
  })

  it("fails the row and keeps the transport error when the boundary was never crossed", async () => {
    const { queueId } = await startPaylinkRow(
      deps,
      svcStub,
      "paylink-create",
      PaylinkActionEnum.PAY,
      5,
    )
    const rejection = new Error("prove failed")
    const submission = { survived: async () => null }
    expect(await paylinkFailure(queueId, rejection, submission, {} as never)).toBe(rejection)
    await settle()
    const [row] = await store.getTransactions()
    expect(row.status).toBe("failed")
  })

  it.each(["NotAllowedError", "AbortError"])(
    "%s removes only the cancelled paylink row",
    async (name) => {
      const { queueId: retained } = await startPaylinkRow(
        deps,
        svcStub,
        "paylink-create",
        PaylinkActionEnum.PAY,
        10,
      )
      const { queueId: cancelled } = await startPaylinkRow(
        deps,
        svcStub,
        "paylink-claim",
        PaylinkActionEnum.CLAIM,
        5,
      )
      await failPaylinkRow(cancelled, new DOMException("Prompt closed", name))
      await settle()
      expect((await store.getTransactions()).map((row) => row.queueId)).toEqual([retained])
    },
  )

  it("does not remove or scrub a paylink that already has a transaction hash", async () => {
    const { queueId } = await startPaylinkRow(
      deps,
      svcStub,
      "paylink-create",
      PaylinkActionEnum.PAY,
      5,
    )
    await store.updateTransaction(
      (tx) => tx.queueId === queueId,
      (tx) => {
        tx.txHash = TX_HASH
        ;(tx as PaylinkTransaction).paylink = "https://x/l#f"
      },
    )
    await failPaylinkRow(queueId, new DOMException("Aborted", "AbortError"))
    await settle()
    expect(await store.getTransactions()).toMatchObject([
      { txHash: TX_HASH, paylink: "https://x/l#f" },
    ])
  })

  // The tab closes after the refund reaches the node: no finish, no refunded flag, only the hash.
  it("a refund submitted before a reload is never read as a recipient's claim", async () => {
    const { queueId: createId } = await startPaylinkRow(
      deps,
      svcStub,
      "paylink-create",
      PaylinkActionEnum.PAY,
      25,
      { flavor: "direct" },
    )
    await finishPaylinkRow(createId, TX_HASH, {
      payToEmailSecret: SECRET,
      paylink: "https://x/l#f",
      fallbackSecret: `0x${"55".repeat(32)}`,
      fromClaimable: 0,
      untilClaimable: 1234,
    })
    await settle()
    await markCreateRowRefundSubmitted(SECRET, "direct", ACCOUNT, `0x${"ef".repeat(32)}`, "cancel")

    const spent = async (rows: PaylinkTransaction[]) => new Map(rows.map((r) => [r.txHash, true]))
    await new PaylinkClaimReconciler({ checkSpent: spent, storage: store }).reconcile()

    const create = ((await store.getTransactions()) as PaylinkTransaction[]).find(
      (r) => r.emailPaymentAction === PaylinkActionEnum.PAY,
    )!
    expect(create.isClaimed).toBeFalsy()
    expect(create.refundTxHash).toBe(`0x${"ef".repeat(32)}`)
  })
})
