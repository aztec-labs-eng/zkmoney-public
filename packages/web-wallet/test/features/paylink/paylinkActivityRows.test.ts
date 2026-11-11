// @vitest-environment node
// The link codec's byte checks need one realm, which jsdom splits.
/**
 * What the sponsored create and refund glue saves: a created link's record and its operation, and
 * a refund's operation, read here as other rollups' readers read them.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { testPage, testCore } from "../../support/page"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { Grumpkin } from "@aztec-labs/foundation/crypto/grumpkin"
import { PaylinkActionEnum, encodePaylinkInline, type PaylinkParams } from "@obsidion/sdk"
import {
  TxInFlightError,
  linkIdFor,
  linkedActivity,
  operationRows,
  sweepLinks,
  type Transfers,
  type PaylinkTransaction,
} from "@obsidion/front-core"
import { activeNamespace, closeSession, switchSession } from "../../../src/session/session"
import { openTestSession } from "../../support/session"
import { pageSessionDeps } from "../../../src/app/sessionDeps"
import { walletStorage } from "../../../src/platform/storage/walletStorage"
import {
  fundLink,
  markLinkRefunded,
  paylinkFailure,
  saveLinkTxHash,
  savePreparedLink,
  saveRefundSubmitted,
  type LinkDraft,
} from "../../../src/features/paylink/sponsoredPaylink"
import { testWalletDbs } from "../../support/fakeWalletDb"

const TX_HASH = `0x${"ab".repeat(32)}`
const ACCOUNT = `0x${"22".repeat(32)}`
const TOKEN_ADDR = `0x${"33".repeat(32)}`
const PARAMS: PaylinkParams = {
  secret: new Fr(0x44n),
  paylinkType: "paylinkDirect",
  classId: new Fr(2n),
  chainId: 31337,
  fallbackKeyHash: new Fr(3n),
  rollupVersion: 1,
  escrowTagSecret: Grumpkin.generator,
}
const SECRET = PARAMS.secret.toString()

/** A display amount at the token's 6 decimals. */
const usd = (human: number) => ({ atomic: BigInt(human) * 10n ** 6n, human })

/** The rows once every background write has landed, each link funded as its operation says. */
async function savedRows() {
  await walletStorage.flush()
  const { paylinks, operations } = openTestSession()
  return (await linkedActivity(store, paylinks, operations)) as PaylinkTransaction[]
}

let nextOp = 0

/** A create's operation, begun as `runOperation` begins it. */
async function createOp(): Promise<string> {
  const operationId = `op-create-${++nextOp}`
  await openTestSession().operations.begin({ operationId, flow: "paylink-create", summary: "$25 paylink" })
  return operationId
}

const draft = (operationId: string, flavor: "direct" | "email" = "direct"): LinkDraft => ({
  timestamp: 1,
  operationId,
  networkId: "0xnet",
  kind: "paylink-create",
  amountAtomic: usd(25).atomic,
  token: {
    address: TOKEN_ADDR,
    name: "DAI",
    symbol: "DAI",
    decimals: 6,
    logo: "",
    amount: 25,
    price: 1,
  },
  tokenAddress: TOKEN_ADDR,
  flavor,
  obsidionAccountAddress: ACCOUNT,
})

const FIELDS = {
  payToEmailSecret: SECRET,
  paylink: `https://x/l#${encodePaylinkInline(PARAMS)}`,
  fallbackSecret: `0x${"55".repeat(32)}`,
  fromClaimable: 0,
  untilClaimable: 1234,
}

/** A create past its submit boundary: its operation and its link hold the hash. */
async function sentLink(flavor: "direct" | "email" = "direct") {
  const operationId = await createOp()
  await savePreparedLink(openTestSession(), draft(operationId, flavor), FIELDS)
  await saveLinkTxHash(openTestSession(), operationId)(TX_HASH)
  return operationId
}

/** A refund's operation, begun and given its transfer as the refund flow does before proving. */
async function refundRow() {
  const operationId = `op-refund-${++nextOp}`
  const { operations } = openTestSession()
  await operations.begin({ operationId, flow: "paylink-reclaim", summary: "$25 paylink" })
  await operations.apply(operationId, {
    type: "transfer",
    transfer: {
      kind: "paylink-refund",
      payload: {
        networkId: "0xnet",
        token: draft(operationId).token!,
        amountAtomic: String(usd(25).atomic),
        flavor: "direct",
        linkId: linkIdFor(PARAMS),
      },
    },
  })
  return { operationId }
}

/** A flow's rejection before its tx reached the node. */
const unsent = { survived: async () => null }

let store: Transfers

beforeEach(() => {
  store = switchSession(activeNamespace(testCore().device), pageSessionDeps(testPage())).transfers
})
afterEach(closeSession)

describe("paylink activity rows", () => {
  it("create: its prepared link, funded as its operation says, and no activity row", async () => {
    const operationId = await createOp()
    await savePreparedLink(openTestSession(), draft(operationId), FIELDS)
    let [row] = await savedRows()
    expect(row).toMatchObject({ status: "pending", emailPaymentAction: PaylinkActionEnum.PAY })
    expect(row).toMatchObject({ flavor: "direct", kind: "paylink-create" })
    expect(row.obsidionAccountAddress).toBe(ACCOUNT)

    await saveLinkTxHash(openTestSession(), operationId)(TX_HASH)
    expect(await openTestSession().operations.get(operationId)).toMatchObject({
      state: "sent",
      txHash: TX_HASH,
    })
    await fundLink(openTestSession(), operationId, "https://wallet.example/link#frag")
    await openTestSession().operations.apply(operationId, { type: "settled", at: 2 })
    ;[row] = await savedRows()
    expect(row).toMatchObject({ status: "success", txHash: TX_HASH, untilClaimable: 1234 })
    expect(row.paylink).toBe("https://wallet.example/link#frag")
    expect(await store.all()).toEqual([])
  })

  it("never saves a create's hash without its link, nor on one record alone", async () => {
    const operationId = await createOp()
    await expect(saveLinkTxHash(openTestSession(), operationId)(TX_HASH)).rejects.toMatchObject({
      code: "invariant",
    })
    expect(await openTestSession().operations.get(operationId)).toMatchObject({ state: "local" })
    expect((await openTestSession().operations.get(operationId))?.txHash).toBeUndefined()
  })

  it("cancel: the refund folds into the creator's link, which carries both hashes", async () => {
    const createId = await sentLink()
    await fundLink(openTestSession(), createId, "https://x/l#tx")
    const { operationId: backId } = await refundRow()
    const refundHash = `0x${"ef".repeat(32)}`
    await openTestSession().operations.apply(backId, { type: "settled", txHash: refundHash, at: 3 })
    await markLinkRefunded(openTestSession(), PARAMS, ACCOUNT, refundHash, "cancel")

    const rows = await savedRows()
    expect(rows.some((r) => r.emailPaymentAction === PaylinkActionEnum.CLAIM_BACK)).toBe(false)
    const [back] = operationRows(openTestSession().operations.view.get()).records as PaylinkTransaction[]
    const create = rows.find((r) => r.emailPaymentAction === PaylinkActionEnum.PAY)!
    expect(back).toMatchObject({
      operationId: backId,
      status: "success",
      txHash: refundHash,
      emailPaymentAction: PaylinkActionEnum.CLAIM_BACK,
    })
    expect(create).toMatchObject({ isRefunded: true, refundTxHash: refundHash })
    // Scrubbed with the refund: the link can never be claimed again.
    expect(create.paylink).toBeUndefined()
  })

  // ULT-876: past the submit boundary the tx may still land, so a rejection is not a failed row —
  // and the caller has to learn that too, or its screen offers to send the same operation again.
  it("leaves the link alone and surfaces the in-flight hash when the tx reached the node", async () => {
    const operationId = await createOp()
    await savePreparedLink(openTestSession(), draft(operationId), FIELDS)
    const rejection = new Error("socket closed")
    const submission = { survived: async () => TX_HASH as `0x${string}` }
    const surfaced = await paylinkFailure(
      openTestSession(),
      operationId,
      rejection,
      submission,
      {} as never,
    )
    expect(surfaced).toBeInstanceOf(TxInFlightError)
    expect(surfaced).toMatchObject({
      txHash: TX_HASH,
      message: rejection.message,
      cause: rejection,
    })
    expect(await openTestSession().paylinks.get(linkIdFor(PARAMS))).toBeDefined()
  })

  it("does not remove or scrub a paylink that already has a transaction hash", async () => {
    const operationId = await sentLink()
    const aborted = new DOMException("Aborted", "AbortError")
    await paylinkFailure(openTestSession(), operationId, aborted, unsent, {} as never)
    expect(await savedRows()).toMatchObject([{ txHash: TX_HASH, paylink: FIELDS.paylink }])
  })

  it("drops the unsent link when the passkey closes before submit", async () => {
    const operationId = await createOp()
    await savePreparedLink(openTestSession(), draft(operationId), FIELDS)
    const aborted = new DOMException("Aborted", "AbortError")
    await paylinkFailure(openTestSession(), operationId, aborted, unsent, {} as never)
    expect(await savedRows()).toEqual([])
    expect(await openTestSession().paylinks.get(linkIdFor(PARAMS))).toBeUndefined()
  })

  // The tab closes after the refund reaches the node: no finish, no refunded flag, only the hash.
  it("a refund submitted before a reload is never read as a recipient's claim", async () => {
    const createId = await sentLink()
    await fundLink(openTestSession(), createId, FIELDS.paylink)
    const { operationId: refundId } = await refundRow()
    await saveRefundSubmitted(
      openTestSession(),
      refundId,
      PARAMS,
      ACCOUNT,
      `0x${"ef".repeat(32)}`,
      "cancel",
    )

    const spent = async (rows: readonly { txHash: string }[]) =>
      new Map(rows.map((r) => [r.txHash, true]))
    await walletStorage.flush()
    const { paylinks, transfers, operations } = openTestSession()
    await sweepLinks({ checkSpent: spent, links: paylinks, operations, transfers }, "0xnet")

    const create = (await savedRows()).find((r) => r.emailPaymentAction === PaylinkActionEnum.PAY)!
    expect(create.isClaimed).toBeFalsy()
    expect(create.refundTxHash).toBe(`0x${"ef".repeat(32)}`)
  })

  it("a create at the slot an unsent create left takes its link, and saves its hash", async () => {
    await savePreparedLink(openTestSession(), draft(await createOp()), FIELDS)
    const operationId = await createOp()
    await savePreparedLink(openTestSession(), draft(operationId), FIELDS)
    await saveLinkTxHash(openTestSession(), operationId)(TX_HASH)
    const link = await openTestSession().paylinks.get(linkIdFor(PARAMS))
    expect(link).toMatchObject({ operationId, txHash: TX_HASH })
  })

  it("never takes the slot of a link that was sent", async () => {
    await sentLink()
    const operationId = await createOp()
    await expect(savePreparedLink(openTestSession(), draft(operationId), FIELDS)).rejects.toMatchObject({
      code: "invariant",
    })
  })

  describe("a prepared link", () => {
    it("rejects when its save fails, so the flow stops before it signs", async () => {
      const operationId = await createOp()
      testWalletDbs().onApply = (_version, ops) => {
        if (ops.some(([, value]) => value?.includes(SECRET))) throw new Error("disk full")
      }
      await expect(savePreparedLink(openTestSession(), draft(operationId), FIELDS)).rejects.toThrow(
        "disk full",
      )
      expect(await openTestSession().paylinks.get(linkIdFor(PARAMS))).toBeUndefined()
    })
  })

  describe("a submitted refund's hash", () => {
    const REFUND_HASH = `0x${"ef".repeat(32)}`

    it("never lands on the refund's operation without the creator link's stamp", async () => {
      const createId = await sentLink()
      await fundLink(openTestSession(), createId, FIELDS.paylink)
      await walletStorage.flush()
      const { operationId: refundId } = await refundRow()
      testWalletDbs().onApply = (_version, ops) => {
        if (ops.some(([, value]) => value?.includes('"refundTxHash"'))) throw new Error("disk full")
      }
      await expect(
        saveRefundSubmitted(openTestSession(), refundId, PARAMS, ACCOUNT, REFUND_HASH, "cancel"),
      ).rejects.toThrow("disk full")
      await walletStorage.flush().catch(() => {})

      expect(await openTestSession().operations.get(refundId)).toMatchObject({ state: "local" })
      expect((await openTestSession().operations.get(refundId))?.txHash).toBeUndefined()
      const [create] = (await savedRows()).filter((r) => r.payToEmailSecret)
      expect(create.refundTxHash).toBeUndefined()
    })

    it("needs the refund's own operation, and a link this device never made", async () => {
      await expect(
        saveRefundSubmitted(openTestSession(), "missing", PARAMS, ACCOUNT, REFUND_HASH, "cancel"),
      ).rejects.toMatchObject({ code: "invariant" })
      const { operationId: refundId } = await refundRow()
      await saveRefundSubmitted(openTestSession(), refundId, PARAMS, ACCOUNT, REFUND_HASH, "cancel")
      expect(await openTestSession().operations.get(refundId)).toMatchObject({
        state: "sent",
        txHash: REFUND_HASH,
      })
    })
  })
})
