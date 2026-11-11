// @vitest-environment node
/**
 * The registration pay row's payment over the session's real stores, with the L1 on a fake node and
 * the connected wallet answering as each case says.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ChainMismatchError,
  formatUnits,
  ProviderDisconnectedError,
  type Address,
  type Hex,
} from "viem"
import { foundry } from "viem/chains"
import {
  admitDeposit,
  createPortalCapacityStore,
  NOMINAL_USD_VALUATION,
  registrationAt,
  registrationPayment,
  UNKNOWN_HASH_MS,
  unresolvedSendState,
} from "@obsidion/front-core"
import { FakeTransferNode } from "../../../../../front-core/test/engine/fakeTransferNode"
import {
  openRegistrationPayFlow,
  PAY_IO,
  type PayInputs,
} from "../../../../src/features/onboarding/steps/DepositAddress/registrationPayFlow"
import { subscribeErrorModal, type ErrorModalPayload } from "../../../../src/errors/errorModal"
import { closeSession, type Session } from "../../../../src/session/session"
import { closeWalletStore, openWalletStore } from "../../../../src/platform/storage/walletStorage"
import { sandboxProfile } from "../../../fixtures/sandboxProfile"
import { tokenOption } from "../../../support/depositTokens"
import { testWalletDbs } from "../../../support/fakeWalletDb"
import { seedDeviceKeys } from "../../../support/page"
import { pendingRecord, seedRegistration } from "../../../support/registrationFixtures"
import { openTestSession } from "../../../support/session"
import { testQuery } from "../../../support/query"

testWalletDbs()

const ROLLUP = sandboxProfile().shared.rollupVersion
const PAYER = "0x00000000000000000000000000000000000000aa" as Address
const ELSEWHERE = "0x00000000000000000000000000000000000000ee" as Address
const DAI = tokenOption("DAI", "0x00000000000000000000000000000000000000dd")
const PLENTY = 1_000n * 10n ** 18n
/** An ask of 11 that credits 1. */
const ADMISSION = admitDeposit(
  {
    token: { symbol: "DAI", decimals: 18, settlesIn: DAI.address, swapped: false },
    depositFeeAtomic: 10n,
    minimumAtomic: 0n,
  },
  { landedAtomic: 11n, gross: { atomic: 11n, decimals: 18, valuation: NOMINAL_USD_VALUATION } },
)
/** A saved transfer's submission time. */
const SENT = expect.any(Number) as number

/** The address's own bucket: what each read reports, and how many reads were made. */
const bucket = { available: PLENTY, reads: 0 }
const fundingStore = () =>
  createPortalCapacityStore(
    { chainId: 1, portal: `0x${"99".repeat(20)}`, token: DAI.address },
    {
      read: async (key) => ({
        ...key,
        decimals: 18,
        blockNumber: BigInt(++bucket.reads),
        blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        rateAtomicPerSecond: 1n,
        globalLimitAtomic: PLENTY * 50n,
        availableAtomic: bucket.available,
        txAmountCapAtomic: PLENTY * 10n,
      }),
      policy: { maxHeadAgeMs: Infinity },
      query: testQuery(),
    },
  )

let node: FakeTransferNode
let session: Session
let inputs: PayInputs
let modals: ErrorModalPayload[]
let sequence = 0
/** The wallet's answer to the next transfer: sent at once, unless a case holds it. */
let answer: (args: { to: Address; amount: bigint }) => Promise<Hex>
const transfers = vi.fn()
const balances = vi.fn()
const send = ({ to, amount }: { to: Address; amount: bigint }) =>
  node.send({ from: PAYER, token: DAI.address, to, amount })
/** The wallet holds the next transfer until the case approves or rejects it. */
const atPrompt = () => {
  const held = {} as { approve: () => void; reject: (e: unknown) => void }
  answer = (args) =>
    new Promise((resolve, reject) => {
      held.approve = () => resolve(send(args))
      held.reject = reject
    })
  return held
}

const io = {
  chain: () => node.client,
  balance: async (owner: Address, token: Address) => {
    balances(owner)
    const raw = node.balanceOf(owner, token)
    const shown = formatUnits(raw, 18)
    return { raw, value: Number(shown), display: `${shown} DAI`, symbol: "DAI", decimals: 18 }
  },
  clients: async () => ({
    account: PAYER,
    chain: foundry,
    walletClient: {
      writeContract: ({
        address,
        args: [to, amount],
      }: {
        address: Address
        args: [Address, bigint]
      }) => {
        transfers({ token: address, to, amount })
        return answer({ to, amount })
      },
    },
  }),
} as unknown as typeof PAY_IO

const open = () => openRegistrationPayFlow(session, () => inputs, io)
type Flow = ReturnType<typeof open>
const record = () => registrationAt(session.registrations.view.get().records, inputs.address)
/** The row's state, as the view selects it. */
const row = (flow: Flow) =>
  registrationPayment(
    inputs.address,
    record(),
    unresolvedSendState(session.unresolvedSends.view.get()),
    flow.state.get().run?.stage,
  )
const openPage = async () => {
  await openWalletStore(ROLLUP, { persistent: true })
  session = openTestSession()
  await session.registrations.ready
  await session.unresolvedSends.ready
}
/** A page reload: the session reopens over what its database saved, with no wallet request open. */
const reload = async () => {
  closeSession()
  await closeWalletStore()
  await openPage()
  return open()
}
/** Starts a payment and waits until its transfer is saved; the receipt is still to come. */
const paid = async (flow = open()) => {
  void flow.pay()
  await vi.waitFor(() => expect(record()?.submittedFunding).toBeDefined())
  return flow
}
/** Pays again and waits until the wallet is asked for the `n`th transfer. */
const sends = async (flow: Flow, n: number) => {
  void flow.pay()
  await vi.waitFor(() => expect(transfers).toHaveBeenCalledTimes(n))
}
/** The payment's transfer, as the node knows it. */
const sentHash = () => record()!.submittedFunding!.txHash
const sentNonce = async () => (await node.client.getTransaction({ hash: sentHash() })).nonce

beforeEach(async () => {
  node = new FakeTransferNode()
  node.setBalance(PAYER, DAI.address, PLENTY)
  answer = async (args) => send(args)
  transfers.mockReset()
  balances.mockReset()
  Object.assign(bucket, { available: PLENTY, reads: 0 })
  inputs = {
    address: `0x${(++sequence).toString(16).padStart(40, "0")}` as Address,
    chainId: foundry.id,
    total: 11n,
    ask: 11n,
    token: DAI.address,
    funding: { store: fundingStore(), admission: ADMISSION, canFund: true },
    account: PAYER,
    wagmi: {} as never,
    cleared: true,
    feeToken: DAI,
    tokens: [DAI],
    pick: DAI,
  }
  modals = []
  subscribeErrorModal((p) => modals.push(p))
  vi.spyOn(console, "error").mockImplementation(() => {})
  await seedDeviceKeys({ storageId: "a1" })
  await openPage()
  await seedRegistration(pendingRecord({ sipaAddress: inputs.address }))
})
afterEach(async () => {
  closeSession()
  await closeWalletStore()
  vi.restoreAllMocks()
})

describe("a new payment", () => {
  it("saves the transfer with its sender and nonce before the receipt, in place of the hold", async () => {
    const flow = await paid()
    expect(row(flow)).toBe("confirming")
    expect(record()?.submittedFunding).toEqual({
      txHash: sentHash(),
      at: SENT,
      from: PAYER,
      nonce: 0,
    })
    await vi.waitFor(() => expect(session.unresolvedSends.view.get().records).toHaveLength(0))
    node.mine()
    await vi.waitFor(() => expect(row(flow)).toBe("sent"))
  })

  it("holds the address before the wallet is asked: after a reload, nothing is sent", async () => {
    atPrompt()
    void open().pay()
    await vi.waitFor(() => expect(transfers).toHaveBeenCalledOnce())
    const flow = await reload()
    expect(row(flow)).toBe("holding")
    await flow.pay()
    expect(transfers).toHaveBeenCalledOnce()
  })

  it("refuses another address while the wallet may still pay this one", async () => {
    atPrompt()
    void open().pay()
    await vi.waitFor(() => expect(transfers).toHaveBeenCalledOnce())
    await reload()
    inputs.address = ELSEWHERE
    const flow = open()
    await flow.pay()
    expect(transfers).toHaveBeenCalledOnce()
    expect(flow.state.get().refusal).toBeDefined()
    expect(row(flow)).toBe("idle")
  })

  it("after Cancel, holds the address until the wallet rejects, then pays again", async () => {
    const held = atPrompt()
    const flow = open()
    const paying = flow.pay()
    await vi.waitFor(() => expect(transfers).toHaveBeenCalledOnce())
    flow.cancelPrompt()
    expect(row(flow)).toBe("holding")
    await flow.pay()
    expect(transfers).toHaveBeenCalledOnce()
    held.reject(Object.assign(new Error("Rejected"), { code: 4001 }))
    await paying
    expect(modals).toEqual([])
    await vi.waitFor(() => expect(row(flow)).toBe("idle"))
    answer = async (args) => send(args)
    await sends(flow, 2)
  })

  it("after Cancel, follows a transfer the wallet signs", async () => {
    const held = atPrompt()
    const flow = open()
    void flow.pay()
    await vi.waitFor(() => expect(transfers).toHaveBeenCalledOnce())
    flow.cancelPrompt()
    held.approve()
    await vi.waitFor(() => expect(row(flow)).toBe("confirming"))
    node.mine()
    await vi.waitFor(() => expect(row(flow)).toBe("sent"))
  })

  it("refuses another address while the wallet holds the transfer the row stopped waiting on", async () => {
    atPrompt()
    const first = open()
    void first.pay()
    await vi.waitFor(() => expect(transfers).toHaveBeenCalledOnce())
    first.cancelPrompt()
    inputs.address = ELSEWHERE
    const flow = open()
    await flow.pay()
    expect(transfers).toHaveBeenCalledOnce()
    expect(flow.state.get().refusal).toBeDefined()
  })

  it("a reopened row checks the saved transfer and never sends another", async () => {
    const held = atPrompt()
    void open().pay()
    await vi.waitFor(() => expect(transfers).toHaveBeenCalledOnce())
    const flow = open()
    expect(row(flow)).toBe("holding")
    await flow.pay()
    held.approve()
    await vi.waitFor(() => expect(row(flow)).toBe("check"))
    const checking = flow.pay()
    node.mine()
    await checking
    expect(row(flow)).toBe("sent")
    expect(transfers).toHaveBeenCalledOnce()
  })
})

describe("after a reload", () => {
  /** Pays, then the page closes before the receipt. */
  const paidThenReloaded = async () => {
    await paid()
    const flow = await reload()
    expect(row(flow)).toBe("check")
    return flow
  }
  /** The sender's transfer at the saved nonce goes elsewhere, or to the address, and mines. */
  const lost = async (paid: bigint, to = inputs.address) => {
    const nonce = await sentNonce()
    if (paid === 0n) node.drop(sentHash())
    node.send({
      from: PAYER,
      token: DAI.address,
      to: paid ? to : ELSEWHERE,
      amount: paid || 1n,
      nonce,
    })
    node.mine()
  }

  it("checks the saved transfer instead of paying again", async () => {
    const flow = await paidThenReloaded()
    const checking = flow.pay()
    node.mine()
    await checking
    expect(row(flow)).toBe("sent")
    expect(transfers).toHaveBeenCalledOnce()
    expect(balances).toHaveBeenCalledOnce()
  })

  it("clears a dropped transfer and offers payment again", async () => {
    const flow = await paidThenReloaded()
    await lost(0n)
    await flow.pay()
    expect(record()?.submittedFunding).toBeUndefined()
    expect(row(flow)).toBe("idle")
    await sends(flow, 2)
  })

  it("reads the sender and nonce of a transfer saved by hash alone, and waits on it", async () => {
    node.failing = (method) => method === "getTransaction"
    await paid()
    const flow = await reload()
    expect(record()?.submittedFunding).toEqual({ txHash: sentHash(), at: SENT })
    node.failing = () => false
    void flow.pay()
    await vi.waitFor(() =>
      expect(record()?.submittedFunding).toEqual({
        txHash: sentHash(),
        at: SENT,
        from: PAYER,
        nonce: 0,
      }),
    )
    expect(row(flow)).toBe("confirming")
    expect(transfers).toHaveBeenCalledOnce()
  })

  it("waits on a transfer saved by hash alone that the node never knew, for an hour", async () => {
    node.failing = (method) => method === "getTransaction"
    await paid()
    node.drop(sentHash())
    node.failing = () => false
    const waiting = await reload()
    void waiting.pay()
    await vi.waitFor(() => expect(row(waiting)).toBe("confirming"))
    vi.spyOn(Date, "now").mockReturnValue(record()!.submittedFunding!.at + UNKNOWN_HASH_MS + 1)
    const flow = await reload()
    const checking = flow.pay()
    await vi.waitFor(() => expect(record()?.submittedFunding).toBeUndefined())
    await checking
    expect(row(flow)).toBe("idle")
    // The reloaded row reads the capacity an hour on.
    inputs.funding = { ...inputs.funding, store: fundingStore() }
    await sends(flow, 2)
  })

  it("stops waiting on a replaced transfer; the address's funding ends the payment", async () => {
    const flow = await paidThenReloaded()
    await lost(1n, ELSEWHERE)
    await flow.pay()
    expect(record()?.submittedFunding).toBeUndefined()
    await session.registrations.apply(inputs.address, { type: "funded" })
    expect(row(flow)).toBe("idle")
    expect(transfers).toHaveBeenCalledOnce()
  })

  it("reads a replaced transfer that paid the address the ask as sent, and keeps it", async () => {
    const flow = await paidThenReloaded()
    await lost(11n)
    await flow.pay()
    expect(row(flow)).toBe("sent")
    expect(record()?.submittedFunding).toBeDefined()
    await flow.pay()
    expect(transfers).toHaveBeenCalledOnce()
  })

  it("clears a replaced transfer that left the address short of the ask", async () => {
    const flow = await paidThenReloaded()
    await lost(10n)
    await flow.pay()
    expect(row(flow)).toBe("idle")
    await sends(flow, 2)
  })

  it("offers a top-up again when its replaced transfer left only the earlier funds", async () => {
    // 6 of the 11 asked arrived earlier; the row tops up the other 5.
    Object.assign(inputs, { total: 5n, ask: 11n })
    node.setBalance(inputs.address, DAI.address, 6n)
    const flow = await paidThenReloaded()
    await lost(1n, ELSEWHERE)
    await flow.pay()
    expect(row(flow)).toBe("idle")
    await sends(flow, 2)
    expect(transfers).toHaveBeenLastCalledWith({
      token: DAI.address,
      to: inputs.address,
      amount: 5n,
    })
  })

  it("pays again once a refund settles the saved transfer", async () => {
    const saved = `0x${"77".repeat(32)}` as Hex
    await session.registrations.apply(inputs.address, {
      type: "fundingSubmitted",
      tx: { txHash: saved, at: Date.now() },
    })
    const flow = open()
    expect(row(flow)).toBe("check")
    await session.registrations.apply(inputs.address, {
      type: "refunded",
      txHash: `0x${"78".repeat(32)}`,
    })
    await sends(flow, 1)
    await vi.waitFor(() => expect(sentHash()).not.toBe(saved))
  })
})

describe("the receipt", () => {
  it("clears a reverted transfer, reports it, and pays again", async () => {
    const flow = open()
    const paying = flow.pay()
    await vi.waitFor(() => expect(row(flow)).toBe("confirming"))
    node.setBalance(PAYER, DAI.address, 0n)
    node.mine()
    await paying
    expect(modals).toHaveLength(1)
    await vi.waitFor(() => expect(record()?.submittedFunding).toBeUndefined())
    expect(row(flow)).toBe("idle")
    node.setBalance(PAYER, DAI.address, PLENTY)
    const again = flow.pay()
    await vi.waitFor(() => expect(row(flow)).toBe("confirming"))
    node.mine()
    await again
    expect(row(flow)).toBe("sent")
  })

  it("fails a transfer replaced by another and clears it", async () => {
    const flow = open()
    const paying = flow.pay()
    await vi.waitFor(() => expect(row(flow)).toBe("confirming"))
    node.send({ from: PAYER, token: DAI.address, to: ELSEWHERE, amount: 1n, nonce: 0 })
    node.mine()
    await paying
    expect(modals).toHaveLength(1)
    await vi.waitFor(() => expect(record()?.submittedFunding).toBeUndefined())
    expect(row(flow)).toBe("idle")
  })

  it("follows a repriced transfer to its receipt and saves its new hash", async () => {
    const flow = open()
    const paying = flow.pay()
    await vi.waitFor(() => expect(row(flow)).toBe("confirming"))
    const repriced = node.send({
      from: PAYER,
      token: DAI.address,
      to: inputs.address,
      amount: 11n,
      nonce: 0,
    })
    node.mine()
    await paying
    expect(modals).toEqual([])
    expect(row(flow)).toBe("sent")
    expect(sentHash()).toBe(repriced)
  })

  it("rechecks the same hash after a failed receipt read, and never resends", async () => {
    node.failing = (method) => method === "waitForTransactionReceipt"
    const flow = open()
    await flow.pay()
    expect(row(flow)).toBe("check")
    node.failing = () => false
    const checking = flow.pay()
    node.mine()
    await checking
    expect(row(flow)).toBe("sent")
    expect(transfers).toHaveBeenCalledOnce()
    expect(balances).toHaveBeenCalledOnce()
  })
})

describe("what stops a payment", () => {
  it("shows a wallet that disconnects mid-payment without a report, and frees the row", async () => {
    answer = () => Promise.reject(new ProviderDisconnectedError(new Error("gone")))
    const flow = open()
    await flow.pay()
    expect(modals).toEqual([expect.not.objectContaining({ showReport: true })])
    await vi.waitFor(() => expect(row(flow)).toBe("idle"))
  })

  it("refuses a wallet on another chain without a report, then pays", async () => {
    answer = () => Promise.reject(new ChainMismatchError({ chain: foundry, currentChainId: 1 }))
    const flow = open()
    await flow.pay()
    expect(modals).toEqual([])
    expect(flow.state.get().refusal).toBeDefined()
    await vi.waitFor(() => expect(session.unresolvedSends.view.get().records).toHaveLength(0))
    answer = async (args) => send(args)
    await sends(flow, 2)
  })

  it("sends nothing until the paying account is cleared", async () => {
    inputs.cleared = false
    await open().pay()
    expect(transfers).not.toHaveBeenCalled()
  })

  it("sends nothing when the last capacity read no longer fits, and leaves no hold", async () => {
    bucket.available = 0n
    const flow = open()
    await flow.pay()
    expect(transfers).not.toHaveBeenCalled()
    expect(modals).toEqual([])
    expect(flow.state.get().refusal).toBeDefined()
    expect(session.unresolvedSends.view.get().records).toHaveLength(0)
  })

  it("sends nothing from a wallet short of the amount, and says why", async () => {
    node.setBalance(PAYER, DAI.address, 10n)
    const flow = open()
    await flow.pay()
    expect(transfers).not.toHaveBeenCalled()
    expect(modals).toEqual([])
    expect(flow.state.get().refusal).toBeDefined()
  })

  it("reports a failed balance read and sends nothing", async () => {
    balances.mockImplementationOnce(() => {
      throw new Error("RPC down")
    })
    const flow = open()
    await flow.pay()
    expect(transfers).not.toHaveBeenCalled()
    expect(modals).toHaveLength(1)
    expect(row(flow)).toBe("idle")
  })

  it.each([
    ["over a limit", { overLimit: "public" }],
    ["with capacity unconfirmed", { funding: { admission: ADMISSION, canFund: false } }],
  ])("still rechecks a sent payment %s, without a capacity read", async (_, over) => {
    node.failing = (method) => method === "waitForTransactionReceipt"
    const flow = open()
    await flow.pay()
    node.failing = () => false
    const reads = bucket.reads
    Object.assign(inputs, over)
    const checking = flow.pay()
    node.mine()
    await checking
    expect(row(flow)).toBe("sent")
    expect(bucket.reads).toBe(reads)
    expect(transfers).toHaveBeenCalledOnce()
  })
})
