import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { BaseAccount } from "@aztec/aztec.js/account"
import { Fr } from "@aztec/aztec.js/fields"
import type { SpendMetadataResolver } from "@oxide/oxide-client/token_operations_collector.js"

import { TIMEOUT } from "../../../sdk/test/utils/index.js"
import { setupOxideTokenSandbox } from "../../../sdk/test/utils/oxideTokenSandbox.js"
import type { DepositSpendMetadataResolver } from "../../../sdk/src/oxide/index.js"
import { createTransferEventSource, type TokenService } from "../../../sdk/src/index.js"

import { TransferEventScanner } from "../../src/core/services/transactions/TransferEventScanner"
import { RequestStorage, type PaymentRequest } from "../../src/core/storages/RequestStorage"
import { TransactionStorage } from "../../src/core/storages/TransactionStorage"
import { startRequestFulfillmentReconciler } from "../../src/xmtp/requestFulfillmentReconciler"
import { setActiveNetworkId } from "../../src/core/activeNetworkId"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"

/**
 * Sandbox e2e for the chain-native web-wallet receive path: two wallets with no prior contact,
 * everything B learns rides the on-chain `Transfer.meta` and B's own `TransferEventScanner` — no
 * XMTP, no off-chain hint anywhere. A sends with a tag + memo and the row lands attributed on one
 * scanner tick; a link-request row flips through the same tick via the meta reference entry; a forged sender tag
 * (registry resolves it to someone else) falls back to the raw address and adds no contact.
 *
 * The name registry is modeled by an in-test resolver pinned to the real on-chain addresses — the
 * registry has its own tests; this file exercises the meta encode → event → scan → attribute chain.
 *
 * Needs `aztec start --local-network`; run via `pnpm test:e2e:transfer-scan`.
 */

const AMOUNT_HUMAN = "25"
const NETWORK_ID = "aztec-sandbox-e2e"

const waitUntil = async (pred: () => Promise<boolean> | boolean, timeoutMs = 15_000) => {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) return false
    await new Promise((r) => setTimeout(r, 200))
  }
  return true
}

describe("web-wallet chain-native receive (real sandbox, scanner-driven)", () => {
  // A = payer (funded), B = recipient running the scanner.
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
  let scanner: TransferEventScanner
  const contactsByAddr = new Map<string, string>()
  const registry = new Map<string, string>()

  beforeAll(async () => {
    const sandbox = await setupOxideTokenSandbox({ initialFundHuman: "100" })
    tokenService = sandbox.tokenService
    resolveSpendMetadata = sandbox.resolveSpendMetadata
    resolveDepositSpendMetadata = sandbox.resolveDepositSpendMetadata
    alice = sandbox.accounts[0]!
    bob = sandbox.accounts[1]!
    rawAmount = await tokenService.parseAmount(AMOUNT_HUMAN)
    tokenDecimals = (await tokenService.fetchTokenInformation()).decimals

    setActiveNetworkId(NETWORK_ID)
    requests = new RequestStorage(new InMemoryStorageAdapter())
    transactions = TransactionStorage.get(new InMemoryStorageAdapter())
    stopReconciler = startRequestFulfillmentReconciler(requests, transactions)

    // The registry knows alice's real tag; "mallory" is registered to bob — so alice claiming
    // "mallory" is a forgery (tag resolves, but not to the on-chain sender).
    registry.set("alice", alice.getAddress().toString())
    registry.set("mallory", bob.getAddress().toString())

    scanner = new TransferEventScanner({
      source: createTransferEventSource({
        wallet: sandbox.wallet,
        tokenAddress: tokenService.tokenAddress.toString(),
        accountAddress: bob.getAddress().toString(),
      }),
      storage: new InMemoryStorageAdapter(),
      transactionStore: transactions,
      tags: {
        resolveL2: async (tag) => {
          const l2Address = registry.get(tag)
          return l2Address ? { l2Address } : null
        },
      },
      contacts: {
        findByL2Address: async (addr) => {
          const tag = contactsByAddr.get(addr.toLowerCase())
          return tag ? { tag } : null
        },
        registerL2: async ({ tag, l2Address }) => {
          contactsByAddr.set(l2Address.toLowerCase(), tag)
        },
      },
      token: { address: tokenService.tokenAddress.toString(), symbol: "BOLD", decimals: tokenDecimals },
      // Only explicit tickNow() calls scan, so "one poll" is literal per assertion.
      pollIntervalMs: 600_000,
    })
    await scanner.start({
      accountAddress: bob.getAddress().toString(),
      accountTag: "bob",
      networkId: NETWORK_ID,
    })
  }, TIMEOUT)

  afterAll(() => {
    scanner?.stop()
    stopReconciler?.()
    setActiveNetworkId(undefined)
  })

  /** A pays B on-chain; anything B learns must come from the mined event's meta. */
  async function pay(meta: { requestId?: string; senderTag?: string; memo?: string }) {
    const transfer = await tokenService.sendToken(bob.getAddress(), AMOUNT_HUMAN, {
      userAccount: alice,
      resolveSpendMetadata,
      resolveDepositSpendMetadata,
      ...meta,
    })
    const result = await transfer.txPromise
    if (result.receipt.blockNumber === undefined) throw new Error("transfer not mined")
    return { txHash: result.txHash }
  }

  function pendingLinkRow(): PaymentRequest {
    return {
      id: Fr.random().toString(),
      contactTag: "",
      amount: Number(AMOUNT_HUMAN),
      asset: "BOLD",
      direction: "outgoing",
      status: "pending",
      createdAt: Date.now(),
      kind: "link",
      amountAtomic: rawAmount.toString(),
      tokenDecimals,
      tokenAddress: tokenService.tokenAddress.toString(),
    }
  }

  it(
    "a stranger's send with tag + memo lands attributed on one scanner tick",
    async () => {
      expect(contactsByAddr.size).toBe(0)
      const memo = "coffee ☕ thanks!"
      const sent = await pay({ senderTag: "alice", memo })

      await scanner.tickNow()

      const row = await transactions.findByTxHash(sent.txHash)
      expect(row).not.toBeNull()
      expect(row!.from).toBe("alice")
      expect(row!.memo).toBe(memo)
      expect(row!.senderL2Address?.toLowerCase()).toBe(alice.getAddress().toString().toLowerCase())
      // Verified first-time sender is auto-added as a contact.
      expect(contactsByAddr.get(alice.getAddress().toString().toLowerCase())).toBe("alice")
    },
    TIMEOUT,
  )

  it(
    "flips B's link-request row from the scanned event's meta reference alone",
    async () => {
      const row = pendingLinkRow()
      await requests.add(row)

      const sent = await pay({ requestId: row.id })
      await scanner.tickNow()

      expect((await transactions.findByTxHash(sent.txHash))?.requestId).toBe(row.id.toLowerCase())
      expect(
        await waitUntil(async () => (await requests.findById(row.id))?.status === "fulfilled"),
      ).toBe(true)
      expect((await requests.findById(row.id))?.fulfillmentTxHash?.toLowerCase()).toBe(
        sent.txHash.toLowerCase(),
      )
    },
    TIMEOUT,
  )

  it(
    "a forged sender tag shows the raw address and adds no contact",
    async () => {
      // Drop the contact auto-added above so attribution runs on the claimed tag, not the contact.
      contactsByAddr.clear()
      const sent = await pay({ senderTag: "mallory", memo: "it's me, mallory" })

      await scanner.tickNow()

      const row = await transactions.findByTxHash(sent.txHash)
      expect(row).not.toBeNull()
      expect(row!.from.toLowerCase()).toBe(alice.getAddress().toString().toLowerCase())
      expect(row!.memo).toBe("it's me, mallory")
      expect(contactsByAddr.size).toBe(0)
    },
    TIMEOUT,
  )
})
