/**
 * The note typed on the pay form must reach its carriers — for a request the XMTP announce +
 * RequestStorage, for a send the on-chain `Transfer.meta` (via sendTokenSponsored's memo option)
 * and the TransactionStorage row the rail writes before proving and advances in place (a second
 * post-settlement write could fail after funds
 * moved).
 */
import { describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  announce: vi.fn(async (_input: object) => ({ status: "sent", messageId: "m1" })),
  requestAdd: vi.fn(async (_row: object) => {}),
  addTokenTransaction: vi.fn(async (..._args: unknown[]) => {}),
  sendTokenSponsored: vi.fn(async (..._args: unknown[]) => ({ txHash: "0xhash", amount: 5n })),
  markRequestPaidById: vi.fn(async (_id: string, _txHash: string) => true),
  updateTransaction: vi.fn(async (..._args: unknown[]) => true),
  removeTransaction: vi.fn(async (..._args: unknown[]) => true),
  addEntry: vi.fn(async (_entry: object) => {}),
  /** Set to a hash to stand for a send the node has already been handed. */
  survivingHash: undefined as string | undefined,
  TxInFlightError: class TxInFlightError extends Error {
    constructor(readonly txHash: string, cause: unknown) {
      super(cause instanceof Error ? cause.message : String(cause))
    }
  },
}))

// The operation record has its own tests; here it only has to run the flow.
vi.mock("../src/features/operations/operations", async () => ({
  isFlowCancelled: (await import("@obsidion/passkey-web")).isPasskeyCancelled,
  runOperation: (input: { operationId: string }, run: (op: unknown) => Promise<unknown>) =>
    run({ operationId: input.operationId, leaveToChain() {} }),
}))
vi.mock("@obsidion/front-core", () => ({
  RequestBroadcaster: class {
    announce = h.announce
  },
  RequestStorage: { get: () => ({ add: h.requestAdd }) },
  TransactionStorage: {
    get: () => ({
      addTokenTransaction: h.addTokenTransaction,
      updateTransaction: h.updateTransaction,
      removeTransaction: h.removeTransaction,
    }),
  },
  ContactStorage: { get: () => ({ addEntry: h.addEntry }) },
  getActiveNetworkId: () => "0xrollup",
  resolveAssetConstants: () => ({ DAI: { logo: "", price: 1 } }),
  trackSubmission: () => ({
    get txHash() {
      return h.survivingHash
    },
    survived: async () => h.survivingHash ?? null,
    stop: async () => {},
  }),
  TxInFlightError: h.TxInFlightError,
}))
vi.mock("@obsidion/sdk", () => ({ nextOperationId: () => "op" }))
vi.mock("@obsidion/core/constants", async (original) => ({
  ...(await original<object>()),
  QueueStatus: { MINING: "mining", SUCCESS: "success", FAILED: "failed" },
}))
vi.mock("@obsidion/proving-progress", () => ({
  ProvingStage: { Mining: "mining" },
  provingProgress: { on: () => {}, off: () => {} },
}))
vi.mock("@aztec/stdlib/aztec-address", () => ({
  AztecAddress: { fromStringUnsafe: (s: string) => s },
}))
vi.mock("../src/config/env", () => ({ getConfig: () => ({ network: "sandbox" }) }))
vi.mock("../src/platform/storage/WebStorageAdapter", () => ({ webStorage: {} }))
vi.mock("../src/platform/xmtp/xmtpLifecycle", () => ({
  getXmtpSender: () => ({}),
  getXmtpUiState: () => ({}),
  xmtpUnavailableMessage: () => "unavailable",
}))
vi.mock("../src/features/fees/fpcRefuel", () => ({ maybeRefuelFpc: () => {} }))
vi.mock("../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorContext: async () => ({ subscribe: false }),
  noteSubscribed: () => {},
}))
vi.mock("../src/features/contacts/registryResolution", () => ({
  resolveTagForCommit: async () => ({
    status: "resolved",
    l2Address: "0xabc",
    xmtpAddress: "0xxmtp",
  }),
}))
vi.mock("../src/features/contacts/requestActions", () => ({
  markRequestPaidById: h.markRequestPaidById,
}))

const { runContactPay } = await import("../src/features/contacts/contactPay")

const token = {
  fetchTokenInformation: async () => ({
    address: "0xtoken",
    name: "DAI",
    symbol: "DAI",
    decimals: 18,
  }),
  sendTokenSponsored: h.sendTokenSponsored,
}

describe("contact pay note", () => {
  it("carries a request note onto the announce and the stored row", async () => {
    await runContactPay(
      {
        mode: "request",
        deps: { tokenService: token as never },
        tag: "alice",
        senderTag: "bob",
        amountDisplay: "5",
        note: "dinner",
      },
      () => {},
    )
    expect(h.announce.mock.calls[0][0]).toMatchObject({ note: "dinner" })
    expect(h.requestAdd.mock.calls[0][0]).toMatchObject({ note: "dinner" })
  })

  it("persists a send note in the same write as the transaction row", async () => {
    await runContactPay(
      {
        mode: "send",
        deps: {
          tokenService: token as never,
          account: { makeSpendMetadataResolver: async () => () => {} } as never,
          wallet: {} as never,
          contractService: {} as never,
        },
        tag: "alice",
        senderTag: "bob",
        amountDisplay: "5",
        note: "dinner",
      },
      () => {},
    )
    const args = h.addTokenTransaction.mock.calls[0]
    expect(args[7]).toBe("dinner")
    // The tag rides the same write, so a send to someone unsaved still reads as them.
    expect(args[8]).toBe("alice")
    // Written pending, before the proof — the chat needs a bubble to advance while it runs.
    expect(args[2]).toBe("pending")
    // The note also rides the on-chain meta, with the sender tag.
    expect(h.sendTokenSponsored.mock.calls[0][3]).toMatchObject({
      memo: "dinner",
      senderTag: "bob",
    })
  })

  it("a send fulfilling a request threads its id into the send and flips the local row", async () => {
    vi.clearAllMocks()
    const REQ = "0x" + "0c".repeat(32)
    const sendTokenSponsored = vi.fn(async (..._args: unknown[]) => ({
      txHash: "0xhash",
      amount: 5n,
    }))
    await runContactPay(
      {
        mode: "send",
        deps: {
          tokenService: { ...token, sendTokenSponsored } as never,
          account: { makeSpendMetadataResolver: async () => () => {} } as never,
          wallet: {} as never,
          contractService: {} as never,
        },
        tag: "alice",
        senderTag: "bob",
        amountDisplay: "5",
        request: { id: REQ } as never,
      },
      () => {},
    )
    expect(sendTokenSponsored.mock.calls[0][3]).toMatchObject({ requestId: REQ })
    await vi.waitFor(() => expect(h.markRequestPaidById).toHaveBeenCalledWith(REQ, "0xhash"))
    // The pending row carries the request id so the feed hides the request it pays.
    const [, stamp] = h.updateTransaction.mock.calls[0] as [
      unknown,
      (row: { requestId?: string }) => void,
    ]
    const row: { requestId?: string } = {}
    stamp(row)
    expect(row.requestId).toBe(REQ)
  })

  it("saves an unsaved requester as a contact before the send row is written", async () => {
    vi.clearAllMocks()
    const order: string[] = []
    h.addEntry.mockImplementationOnce(async () => {
      order.push("contact")
    })
    h.addTokenTransaction.mockImplementationOnce(async () => {
      order.push("row")
    })
    await runContactPay(
      {
        mode: "send",
        deps: {
          tokenService: token as never,
          account: { makeSpendMetadataResolver: async () => () => {} } as never,
          wallet: {} as never,
          contractService: {} as never,
        },
        tag: "alice",
        senderTag: "bob",
        amountDisplay: "5",
        request: { id: "0x01" } as never,
        saveUnsavedRequester: true,
      },
      () => {},
    )
    expect(h.addEntry).toHaveBeenCalledWith({
      name: "alice",
      address: "0xabc",
      verified: true,
      tag: "alice",
    })
    expect(order).toEqual(["contact", "row"])
  })
})

describe("contact send cancellation and failure identity", () => {
  const send = {
    mode: "send" as const,
    deps: {
      tokenService: token as never,
      account: { makeSpendMetadataResolver: async () => () => {} } as never,
      wallet: {} as never,
      contractService: {} as never,
    },
    tag: "alice",
    senderTag: "bob",
    amountDisplay: "5",
  }

  it("an early Cancel exits before allocating or failing a transaction row", async () => {
    vi.clearAllMocks()
    const cancelled = new Error("cancelled at the stage boundary")
    await expect(
      runContactPay(send, (stage) => {
        if (stage === "proving") throw cancelled
      }),
    ).rejects.toBe(cancelled)
    expect(h.addTokenTransaction).not.toHaveBeenCalled()
    expect(h.sendTokenSponsored).not.toHaveBeenCalled()
    expect(h.updateTransaction).not.toHaveBeenCalled()
  })

  it("a later service rejection fails only the row keyed by its operation id", async () => {
    vi.clearAllMocks()
    const rejection = new Error("passkey rejected")
    h.sendTokenSponsored.mockRejectedValueOnce(rejection)
    await expect(runContactPay(send, () => {})).rejects.toBe(rejection)
    expect(h.addTokenTransaction).toHaveBeenCalledOnce()
    const pendingArgs = h.addTokenTransaction.mock.calls[0]
    expect(pendingArgs[2]).toBe("pending")
    const operationId = pendingArgs[5]
    expect(h.sendTokenSponsored.mock.calls[0][3]).toMatchObject({ operationId })
    expect(h.updateTransaction).toHaveBeenCalledOnce()
    const [matches, update] = h.updateTransaction.mock.calls[0] as [
      (row: { queueId: unknown }) => boolean,
      (row: { status: string; txHash?: string; detailedStatus?: string; error?: string }) => void,
    ]
    expect(matches({ queueId: operationId })).toBe(true)
    expect(matches({ queueId: "unrelated-operation" })).toBe(false)
    const row = { status: "pending" }
    update(row)
    expect(row).toEqual({ status: "failed", detailedStatus: "failed", error: rejection.message })
  })

  // ULT-876: the wallet emits the submit boundary before handing the tx to the node, so a
  // rejection after it — a throttled timer, a dropped socket — is not evidence the send failed.
  // Failing the row here is what told a user to pay twice.
  it("a rejection after the tx reached the node leaves the row alone", async () => {
    vi.clearAllMocks()
    h.survivingHash = "0xsubmitted"
    try {
      const rejection = new Error("socket closed while waiting for the mine")
      h.sendTokenSponsored.mockRejectedValueOnce(rejection)
      const thrown = await runContactPay(send, () => {}).catch((e: unknown) => e)
      expect(thrown).toBeInstanceOf(h.TxInFlightError)
      expect(thrown).toMatchObject({ txHash: "0xsubmitted", message: rejection.message })
      // Neither failed nor dropped: the chain settles it.
      expect(h.removeTransaction).not.toHaveBeenCalled()
      expect(h.updateTransaction).not.toHaveBeenCalled()
    } finally {
      h.survivingHash = undefined
    }
  })

  // `fulfilled` is terminal, and a send that only reached the node may still be dropped: marking
  // it here would strand the request paid and unpayable. The pending row speaks for it instead.
  it("does not mark a request paid while the send is unconfirmed", async () => {
    vi.clearAllMocks()
    const requestId = "0x" + "0d".repeat(32)
    h.survivingHash = "0xsubmitted"
    try {
      h.sendTokenSponsored.mockRejectedValueOnce(new Error("socket closed"))
      await expect(
        runContactPay({ ...send, request: { id: requestId } }, () => {}),
      ).rejects.toBeInstanceOf(h.TxInFlightError)
      expect(h.markRequestPaidById).not.toHaveBeenCalled()
    } finally {
      h.survivingHash = undefined
    }
  })

  it("a closed passkey prompt drops the pending row instead of failing it", async () => {
    vi.clearAllMocks()
    const closed = new DOMException(
      "The operation either timed out or was not allowed.",
      "NotAllowedError",
    )
    h.sendTokenSponsored.mockRejectedValueOnce(closed)
    await expect(runContactPay(send, () => {})).rejects.toBe(closed)
    const operationId = h.addTokenTransaction.mock.calls[0][5]
    expect(h.updateTransaction).not.toHaveBeenCalled()
    expect(h.removeTransaction).toHaveBeenCalledOnce()
    const [matches] = h.removeTransaction.mock.calls[0] as [(row: { queueId: unknown }) => boolean]
    expect(matches({ queueId: operationId })).toBe(true)
  })
})
