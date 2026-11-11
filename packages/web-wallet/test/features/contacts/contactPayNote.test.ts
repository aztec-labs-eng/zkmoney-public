/**
 * The note typed on the pay form must reach its carriers — for a request the XMTP announce +
 * the requests store, for a send the on-chain `Transfer.meta` (via sendTokenSponsored's memo option)
 * and the send's operation, which takes what its row shows before proving and advances in place.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { operationRows } from "@obsidion/front-core"
import type { WalletSendOptions } from "../../support/submitBoundary"
import { testWalletDbs } from "../../support/fakeWalletDb"
import { operationRecord, testOperations } from "../../support/operations"
import type { Session } from "../../../src/session/session"

const h = vi.hoisted(() => ({
  announce: vi.fn(async (_input: object) => ({ status: "sent", messageId: "m1" })),
  requestAdd: undefined as unknown as MockInstance,
  sendTokenSponsored: vi.fn(async (..._args: unknown[]) => ({ txHash: "0xhash", amount: 5n })),
  addEntry: vi.fn(async (_entry: object) => {}),
  addOrMergeContact: vi.fn(async (entry: object) => entry),
  approveAutoAdded: vi.fn(async (_address: string) => undefined),
  removeEntry: vi.fn(async (_identity: object) => {}),
  /** Set to a hash to stand for a send the node has already been handed. */
  survivingHash: undefined as string | undefined,
  TxInFlightError: class TxInFlightError extends Error {
    constructor(readonly txHash: string, cause: unknown) {
      super(cause instanceof Error ? cause.message : String(cause))
    }
  },
}))

/** The book the send writes through. */
const contacts = {
  addEntry: h.addEntry,
  addOrMergeContact: h.addOrMergeContact,
  approveAutoAdded: h.approveAutoAdded,
  removeEntry: h.removeEntry,
} as never

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  RequestBroadcaster: class {
    announce = h.announce
  },
  resolveAssetConstants: () => ({ DAI: { logo: "", price: 1 } }),
  trackSubmission: () => ({
    get txHash() {
      return h.survivingHash
    },
    survived: async () => h.survivingHash ?? null,
    stop: () => {},
  }),
  TxInFlightError: h.TxInFlightError,
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  nextOperationId: () => "op",
}))
vi.mock("@obsidion/core/constants", async (original) => ({
  ...(await original<object>()),
  QueueStatus: {
    MINING: "mining",
    SUCCESS: "success",
    FAILED: "failed",
    PENDING: "pending",
    CANCELLED: "cancelled",
  },
}))
vi.mock("@aztec-labs/stdlib/aztec-address", () => ({
  AztecAddress: { fromStringUnsafe: (s: string) => s },
}))
vi.mock("../../../src/platform/xmtp/xmtpLifecycle", () => ({
  getXmtpSender: () => ({}),
  getXmtpUiState: () => ({}),
  xmtpUnavailableCode: () => "messaging.starting",
}))
vi.mock("../../../src/features/registration/claimSponsorship", () => ({
  claimSponsorContext: async () => ({ subscribe: false, fpcAddress: "0xfpc" }),
  noteSubscribed: () => {},
}))
vi.mock("../../../src/features/contacts/registryResolution", () => ({
  resolveTagForCommit: async (_page: unknown, tag: string) =>
    tag === "stale"
      ? { status: "staleRollup" }
      : { status: "resolved", l2Address: "0xabc", xmtpAddress: "0xxmtp" },
  resolveTagViaRegistry: async () => ({ status: "resolved" }),
}))
const { runContactPay, RecipientNotUpgradedError } = await import(
  "../../../src/features/contacts/contactPay"
)
const { closeSession } = await import("../../../src/session/session")
const { openTestSession } = await import("../../support/session")

let session: Session
beforeEach(() => {
  session = openTestSession({
    token,
    account: { makeSpendMetadataResolver: async () => () => {} },
    wallet: { networkId: "0xnet" },
    contractService: {},
    contacts,
  })
  h.requestAdd = vi.spyOn(session.requests, "add")
})
afterEach(() => {
  vi.restoreAllMocks()
  closeSession()
})
/** The send's operation, its record; `nextOperationId` names every one "op". */
const sendOp = () => operationRecord("op")

const token = {
  fetchTokenInformation: async () => ({
    address: "0xtoken",
    name: "DAI",
    symbol: "DAI",
    decimals: 18,
  }),
  sendTokenSponsored: h.sendTokenSponsored,
}

describe("recipient upgrade check", () => {
  it("refuses a send to a tag still on a retired rollup before anything is written or proven", async () => {
    vi.clearAllMocks()
    await expect(
      runContactPay(
        {
          mode: "send",
          session,
          tag: "stale",
          senderTag: "bob",
          amountDisplay: "5",
        },
        () => {},
      ),
    ).rejects.toBeInstanceOf(RecipientNotUpgradedError)
    expect(sendOp()).toBeUndefined()
    expect(h.sendTokenSponsored).not.toHaveBeenCalled()
  })
})

describe("request pin", () => {
  // The registry resolves every tag here to 0xabc.
  const pay = (requesterPin: string) =>
    runContactPay(
      {
        mode: "send",
        session,
        tag: "alice",
        senderTag: "bob",
        amountDisplay: "5",
        request: { id: "0x" + "0c".repeat(32), source: "link", requesterPin },
      },
      () => {},
    )

  it("refuses a send whose @tag no longer names the pinned account, before anything is written", async () => {
    vi.clearAllMocks()
    await expect(pay("0xabd")).rejects.toMatchObject({ code: "contact.requestMismatch" })
    expect(sendOp()).toBeUndefined()
    expect(h.sendTokenSponsored).not.toHaveBeenCalled()
  })

  it("pays when the pin is the first bytes of the @tag's address, as a Receive code's is", async () => {
    vi.clearAllMocks()
    await pay("0xAB")
    expect(h.sendTokenSponsored).toHaveBeenCalledOnce()
  })
})

describe("contact pay note", () => {
  it("carries a request note onto the announce and the stored row", async () => {
    await runContactPay(
      {
        mode: "request",
        session,
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
    vi.clearAllMocks()
    let atProof: ReturnType<typeof sendOp>
    h.sendTokenSponsored.mockImplementationOnce(async () => {
      atProof = sendOp()
      return { txHash: "0xhash", amount: 5n }
    })
    await runContactPay(
      {
        mode: "send",
        session,
        tag: "alice",
        senderTag: "bob",
        amountDisplay: "5",
        note: "dinner",
      },
      () => {},
    )
    // The tag rides the same write, so a send to someone unsaved still reads as them. Written
    // pending, before the proof — the chat needs a bubble to advance while it runs.
    expect(atProof).toMatchObject({
      state: "local",
      kind: "send",
      payload: { memo: "dinner", toTag: "alice" },
    })
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
    // The open session, with this token in place of the suite's.
    openTestSession({ token: { ...token, sendTokenSponsored } })
    await runContactPay(
      {
        mode: "send",
        session,
        tag: "alice",
        senderTag: "bob",
        amountDisplay: "5",
        request: { id: REQ } as never,
      },
      () => {},
    )
    expect(sendTokenSponsored.mock.calls[0][3]).toMatchObject({ requestId: REQ })
    // The pending row carries the request id so the feed hides the request it pays.
    expect(sendOp()).toMatchObject({ kind: "send", payload: { requestId: REQ } })
  })

  it("saves an unsaved requester before the send row is written, and approves them once it lands", async () => {
    vi.clearAllMocks()
    const order: string[] = []
    // Each step names whether the send's row was written by then.
    const row = () => sendOp()?.kind ?? "no row"
    h.addOrMergeContact.mockImplementationOnce(async (entry) => {
      order.push(`contact, ${row()}`)
      return entry
    })
    h.sendTokenSponsored.mockImplementationOnce(async () => {
      order.push(`send, ${row()}`)
      return { txHash: "0xhash", amount: 5n }
    })
    h.addEntry.mockImplementationOnce(async () => {
      order.push("approval")
    })
    await runContactPay(
      {
        mode: "send",
        session,
        tag: "alice",
        senderTag: "bob",
        amountDisplay: "5",
        request: { id: "0x01" } as never,
        saveUnsavedRequester: true,
      },
      () => {},
    )
    const contact = { name: "alice", address: "0xabc", verified: true, tag: "alice" }
    expect(h.addOrMergeContact).toHaveBeenCalledWith({ ...contact, autoAdded: true })
    expect(h.addEntry).toHaveBeenCalledWith(contact)
    expect(order).toEqual(["contact, no row", "send, send", "approval"])
  })
})

it("makes a payee the wallet added a contact once the send lands", async () => {
  vi.clearAllMocks()
  await runContactPay(
    {
      mode: "send",
      session,
      tag: "alice",
      senderTag: "bob",
      amountDisplay: "5",
    },
    () => {},
  )
  expect(h.approveAutoAdded).toHaveBeenCalledWith("0xabc")
  expect(h.addEntry).not.toHaveBeenCalled()
})

describe("approving an unsaved requester", () => {
  const send = {
    mode: "send" as const,
    get session() {
      return session
    },
    tag: "alice",
    senderTag: "bob",
    amountDisplay: "5",
    request: { id: "req-1" },
    saveUnsavedRequester: true,
  }

  it("does not approve them when the send is cancelled before proving", async () => {
    vi.clearAllMocks()
    const cancelled = new Error("Cancelled")
    await expect(
      runContactPay(send, (stage) => {
        if (stage === "proving") throw cancelled
      }),
    ).rejects.toBe(cancelled)
    expect(h.addOrMergeContact).toHaveBeenCalledWith(expect.objectContaining({ autoAdded: true }))
    expect(h.sendTokenSponsored).not.toHaveBeenCalled()
    expect(h.addEntry).not.toHaveBeenCalled()
  })

  it("does not approve them when the send fails", async () => {
    vi.clearAllMocks()
    const rejection = new Error("rejected")
    h.sendTokenSponsored.mockRejectedValueOnce(rejection)
    await expect(runContactPay(send, () => {})).rejects.toBe(rejection)
    expect(h.addEntry).not.toHaveBeenCalled()
  })

  it("does not approve them while the send is unconfirmed", async () => {
    vi.clearAllMocks()
    h.survivingHash = "0xsubmitted"
    try {
      h.sendTokenSponsored.mockRejectedValueOnce(new Error("socket closed"))
      await expect(runContactPay(send, () => {})).rejects.toBeInstanceOf(h.TxInFlightError)
      expect(h.addEntry).not.toHaveBeenCalled()
    } finally {
      h.survivingHash = undefined
    }
  })

  it("still sends when saving the contact fails", async () => {
    vi.clearAllMocks()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      h.addOrMergeContact.mockRejectedValueOnce(new Error("contacts unavailable"))
      h.addEntry.mockRejectedValueOnce(new Error("contacts unavailable"))
      await expect(runContactPay(send, () => {})).resolves.toEqual({ txHash: "0xhash" })
      expect(h.addEntry).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
})

describe("the row a failed send added", () => {
  const send = {
    mode: "send" as const,
    get session() {
      return session
    },
    tag: "alice",
    senderTag: "bob",
    amountDisplay: "5",
    request: { id: "req-1" },
    saveUnsavedRequester: true,
  }

  it.each([
    [
      "the send fails",
      () => h.sendTokenSponsored.mockRejectedValueOnce(new Error("rejected")),
      true,
    ],
    [
      "the send may still land",
      () => {
        h.survivingHash = "0xsubmitted"
        h.sendTokenSponsored.mockRejectedValueOnce(new Error("socket closed"))
      },
      false,
    ],
    [
      "the row was there before the send",
      () => {
        h.addOrMergeContact.mockImplementationOnce(async (entry) => ({ ...entry }))
        h.sendTokenSponsored.mockRejectedValueOnce(new Error("rejected"))
      },
      false,
    ],
  ])("is removed when %s: %s", async (_case, arrange, removed) => {
    vi.clearAllMocks()
    arrange()
    try {
      await expect(runContactPay(send, () => {})).rejects.toBeDefined()
    } finally {
      h.survivingHash = undefined
    }
    if (removed) expect(h.removeEntry).toHaveBeenCalledWith({ address: "0xabc" })
    else expect(h.removeEntry).not.toHaveBeenCalled()
  })

  it("is removed when the passkey prompt is closed before proving", async () => {
    vi.clearAllMocks()
    await expect(
      runContactPay(send, (stage) => {
        if (stage === "proving") throw new Error("Cancelled")
      }),
    ).rejects.toThrow("Cancelled")
    expect(h.removeEntry).toHaveBeenCalledWith({ address: "0xabc" })
  })
})

describe("contact send cancellation and failure identity", () => {
  const send = {
    mode: "send" as const,
    get session() {
      return session
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
    expect(sendOp()).toBeUndefined()
    expect(h.sendTokenSponsored).not.toHaveBeenCalled()
  })

  it("a later service rejection fails only the row keyed by its operation id", async () => {
    vi.clearAllMocks()
    const rejection = new Error("passkey rejected")
    h.sendTokenSponsored.mockRejectedValueOnce(rejection)
    await expect(runContactPay(send, () => {})).rejects.toBe(rejection)
    expect(h.sendTokenSponsored.mock.calls[0][3]).toMatchObject({ operationId: "op" })
    // Failed before its proof: kept as the send's history, with no notification.
    expect(sendOp()).toMatchObject({ kind: "send", state: "failed", error: rejection.message })
    expect(sendOp()?.readAt).toBeDefined()
    expect(operationRows(testOperations().view.get()).records).toEqual([
      expect.objectContaining({ id: "op", status: "failed", failure: { code: "tx.failed" } }),
    ])
  })

  it("holds the send's hash on its row when the node takes it", async () => {
    vi.clearAllMocks()
    let heldAtNode: string | undefined
    h.sendTokenSponsored.mockImplementationOnce(async (...args: unknown[]) => {
      await (args[3] as WalletSendOptions).onTxHash?.("0xhash", { expiresAtMs: 0 })
      heldAtNode = sendOp()?.state === "sent" ? sendOp()?.txHash : undefined
      return { txHash: "0xhash", amount: 5n }
    })
    await runContactPay(send, () => {})
    expect(heldAtNode).toBe("0xhash")
    expect(sendOp()).toMatchObject({ state: "settled", txHash: "0xhash" })
  })

  it("sends nothing, and fails the row, when the hash cannot be saved", async () => {
    vi.clearAllMocks()
    testWalletDbs().onApply = (_version, written) => {
      if (written.some(([key, value]) => key.endsWith("/op") && value?.includes('"state":"sent"')))
        throw new Error("quota exceeded")
    }
    const node = vi.fn()
    h.sendTokenSponsored.mockImplementationOnce(async (...args: unknown[]) => {
      await (args[3] as WalletSendOptions).onTxHash?.("0xhash", { expiresAtMs: 0 })
      node()
      return { txHash: "0xhash", amount: 5n }
    })
    const err = await runContactPay(send, () => {})
      .catch((e: unknown) => e)
      .finally(() => (testWalletDbs().onApply = undefined))
    expect(err).toMatchObject({ message: "quota exceeded" })
    expect(err).not.toBeInstanceOf(h.TxInFlightError)
    expect(node).not.toHaveBeenCalled()
    expect(sendOp()).toMatchObject({ state: "failed" })
    expect(sendOp()?.txHash).toBeUndefined()
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
      expect(sendOp()).toMatchObject({ state: "sent", txHash: "0xsubmitted" })
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
    let written: string | undefined
    h.sendTokenSponsored.mockImplementationOnce(async () => {
      written = sendOp()?.kind
      throw closed
    })
    await expect(runContactPay(send, () => {})).rejects.toBe(closed)
    expect(written).toBe("send")
    expect(sendOp()).toBeUndefined()
  })
})
