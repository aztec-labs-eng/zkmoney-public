import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { BaseAccount } from "@aztec/aztec.js/account"
import { Fr } from "@aztec/aztec.js/fields"
import { TxHash } from "@aztec/stdlib/tx"
import type { SpendMetadataResolver } from "@oxide/oxide-client/token_operations_collector.js"

import { TIMEOUT } from "../../../sdk/test/utils/index.js"
import { setupOxideTokenSandbox } from "../../../sdk/test/utils/oxideTokenSandbox.js"
import type { DepositSpendMetadataResolver } from "../../../sdk/src/oxide/index.js"
import type { TokenService } from "../../../sdk/src/index.js"

import { RequestStorage, type PaymentRequest } from "../../src/core/storages/RequestStorage"
import { TransactionStorage } from "../../src/core/storages/TransactionStorage"
import { startRequestFulfillmentReconciler } from "../../src/xmtp/requestFulfillmentReconciler"
import { setActiveNetworkId } from "../../src/core/activeNetworkId"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"

/**
 * Sandbox e2e for the on-chain payment-request join: B requests from A (a contact request and a
 * link request), A pays through the RequestPay rail's service leg — `TokenService.sendToken` with
 * the `requestId` option — and B's rows flip via the `Transfer.meta` reference entry alone. **No XMTP anywhere in
 * this file**: B's ingest is exactly what the receive pipeline writes after verification
 * (`verifyTransferClaims` → `addIncomingTokenTransaction` → `incomingTransfer` → reconciler).
 * A plain send of the same amount without a `requestId` leaves a pending row untouched.
 *
 * Needs `aztec start --local-network`; run via `pnpm test:e2e:requests`.
 */

const AMOUNT_HUMAN = "25"

const waitUntil = async (pred: () => Promise<boolean> | boolean, timeoutMs = 15_000) => {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) return false
    await new Promise((r) => setTimeout(r, 200))
  }
  return true
}

describe("request fulfilment joins on Transfer.meta (real sandbox, no XMTP)", () => {
  // A = payer (funded), B = requester.
  let alice: BaseAccount
  let bob: BaseAccount
  let tokenService: TokenService
  let resolveSpendMetadata: SpendMetadataResolver
  let resolveDepositSpendMetadata: DepositSpendMetadataResolver
  let tokenDecimals: number
  let rawAmount: bigint

  // B's device state.
  let requests: RequestStorage
  let transactions: TransactionStorage
  let stopReconciler: () => void

  beforeAll(async () => {
    const sandbox = await setupOxideTokenSandbox({ initialFundHuman: "100" })
    tokenService = sandbox.tokenService
    resolveSpendMetadata = sandbox.resolveSpendMetadata
    resolveDepositSpendMetadata = sandbox.resolveDepositSpendMetadata
    alice = sandbox.accounts[0]!
    bob = sandbox.accounts[1]!
    rawAmount = await tokenService.parseAmount(AMOUNT_HUMAN)
    tokenDecimals = (await tokenService.fetchTokenInformation()).decimals

    setActiveNetworkId("aztec-sandbox-e2e")
    requests = new RequestStorage(new InMemoryStorageAdapter())
    transactions = TransactionStorage.get(new InMemoryStorageAdapter())
    stopReconciler = startRequestFulfillmentReconciler(requests, transactions)
  }, TIMEOUT)

  afterAll(() => {
    stopReconciler?.()
    setActiveNetworkId(undefined)
  })

  function pendingRow(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
    return {
      id: Fr.random().toString(),
      contactTag: "alice",
      amount: Number(AMOUNT_HUMAN),
      asset: "DAI",
      direction: "outgoing",
      status: "pending",
      createdAt: Date.now(),
      kind: "contact",
      amountAtomic: rawAmount.toString(),
      tokenDecimals,
      tokenAddress: tokenService.tokenAddress.toString(),
      ...overrides,
    }
  }

  /** A pays: the RequestPay rail's service leg — an ordinary send carrying the id in meta. */
  async function pay(requestId?: string): Promise<{ txHash: TxHash; blockNumber: number }> {
    const transfer = await tokenService.sendToken(bob.getAddress(), AMOUNT_HUMAN, {
      userAccount: alice,
      resolveSpendMetadata,
      resolveDepositSpendMetadata,
      ...(requestId ? { requestId } : {}),
    })
    const result = await transfer.txPromise
    if (result.receipt.blockNumber === undefined) throw new Error("transfer not mined")
    return {
      txHash: TxHash.fromString(result.txHash),
      blockNumber: Number(result.receipt.blockNumber),
    }
  }

  /** B's receive pipeline after XMTP-independent discovery: verify on-chain, then ingest the row. */
  async function verifyAndIngest(
    sent: { txHash: TxHash; blockNumber: number },
    fromTag: string,
  ): Promise<string | undefined> {
    const verified = await tokenService.verifyTransferClaims({
      sender: alice.getAddress(),
      recipient: bob.getAddress(),
      amount: AMOUNT_HUMAN,
      blockNumber: sent.blockNumber,
      txHash: sent.txHash,
      recipientAccount: bob,
    })
    expect(verified.ok).toBe(true)
    if (!verified.ok) throw new Error("unreachable")

    await transactions.addIncomingTokenTransaction({
      txHash: sent.txHash.toString(),
      from: fromTag,
      senderL2Address: verified.event.from.toString(),
      to: "bob",
      token: {
        address: tokenService.tokenAddress.toString(),
        name: "DAI",
        symbol: "DAI",
        decimals: tokenDecimals,
        logo: "",
        amount: Number(AMOUNT_HUMAN),
        price: 0,
      },
      timestamp: Date.now(),
      blockNumber: sent.blockNumber,
      requestId: verified.event.requestId,
      amountAtomic: verified.event.amount.toString(),
    })
    return verified.event.requestId
  }

  it(
    "flips B's contact-request row when A pays with the id in meta",
    async () => {
      const row = pendingRow()
      await requests.add(row)

      const sent = await pay(row.id)
      const decodedId = await verifyAndIngest(sent, "alice")
      expect(decodedId).toBe(row.id.toLowerCase())

      expect(
        await waitUntil(async () => (await requests.findById(row.id))?.status === "fulfilled"),
      ).toBe(true)
      expect((await requests.findById(row.id))?.fulfillmentTxHash).toBe(sent.txHash.toString())
    },
    TIMEOUT,
  )

  it(
    "flips B's link-request row from any payer",
    async () => {
      const row = pendingRow({ kind: "link", contactTag: "" })
      await requests.add(row)

      const sent = await pay(row.id)
      // A link payer is a stranger — attribution is not the contact tag.
      await verifyAndIngest(sent, "stranger")

      expect(
        await waitUntil(async () => (await requests.findById(row.id))?.status === "fulfilled"),
      ).toBe(true)
    },
    TIMEOUT,
  )

  it(
    "a plain send of the same amount without a requestId leaves a pending row pending",
    async () => {
      const row = pendingRow()
      await requests.add(row)

      const sent = await pay(undefined)
      const decodedId = await verifyAndIngest(sent, "alice")
      expect(decodedId).toBeUndefined()

      // Give the reconciler a beat to (wrongly) act, then assert nothing moved.
      expect(
        await waitUntil(async () => (await requests.findById(row.id))?.status !== "pending", 2_000),
      ).toBe(false)
      expect((await requests.findById(row.id))?.status).toBe("pending")
    },
    TIMEOUT,
  )
})
