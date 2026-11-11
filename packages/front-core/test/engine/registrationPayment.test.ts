// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { Hex } from "viem"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { loadRecords } from "../../src/engine/persistentStore"
import {
  createRegistrations,
  registrationAt,
  registrationPayment,
  submissionGone,
  UNKNOWN_HASH_MS,
  type RegistrationStart,
} from "../../src/engine/registrations"
import type { SubmittedTx } from "../../src/engine/registrationRecord"
import { createSipaDeposits } from "../../src/engine/sipaDeposits"
import {
  createUnresolvedSends,
  unresolvedSendState,
  type UnresolvedSendState,
} from "../../src/engine/unresolvedSends"
import { FakeTransferNode } from "./fakeTransferNode"

const NS = "obsidion.ns."
const SIPA = "0x00000000000000000000000000000000000000A1"
const OTHER = "0x00000000000000000000000000000000000000b2"
const TX = `0x${"cd".repeat(32)}` as const
const OTHER_TX = `0x${"ef".repeat(32)}` as const
const SENT_AT = 1_700_000_000_000
const START: RegistrationStart = {
  account: "0x00000000000000000000000000000000000000c3",
  tag: "alice",
  nameHash: `0x${"11".repeat(32)}`,
  l2Address: `0x${"22".repeat(32)}`,
  l1ChainId: 1,
  sipaAddress: SIPA,
  fee: "10",
  beneficiary: "0x00000000000000000000000000000000000000d4",
  depositToken: "0x00000000000000000000000000000000000000e5",
}

/** One page load over `entries`: a new map of them is a reload. */
function load(entries: Map<string, string>) {
  const backend = memoryBackend(entries)
  const page = openDatabase(backend)
  const db = page.scoped(NS)
  const registrations = createRegistrations({
    db,
    legacy: page,
    deposits: createSipaDeposits({ db, account: true, now: () => Date.now() }),
    account: true,
    now: () => Date.now(),
  })
  const holds = createUnresolvedSends({ page, namespace: NS })
  /** The row's state as a fresh sheet reads it, with no run of its own. */
  const row = async () => {
    const records = await loadRecords(registrations.view)
    await holds.ready
    return registrationPayment(
      SIPA,
      registrationAt(records, SIPA),
      unresolvedSendState(holds.view.get()),
    )
  }
  return { backend, registrations, holds, row }
}

const held = (address: string, submission = "s1") =>
  ({ type: "held", send: { address, at: 1, submission } } as const)

describe("registrationPayment", () => {
  const hold = (address: string): UnresolvedSendState => ({
    status: "held",
    send: { id: "send", address, at: 1 },
  })
  const saved = { submittedFunding: { txHash: TX, at: SENT_AT } }
  it.each<[string, Parameters<typeof registrationPayment>, string]>([
    ["is idle with nothing saved", [SIPA, null, { status: "none" }], "idle"],
    ["follows the screen's own run first", [SIPA, saved, hold(SIPA), "sent"], "sent"],
    ["checks a saved transfer again", [SIPA, saved, hold(SIPA)], "check"],
    ["holds an address the wallet may still pay", [SIPA.toLowerCase(), {}, hold(SIPA)], "holding"],
    ["leaves another address's hold to the save", [SIPA, {}, hold(OTHER)], "idle"],
    ["ends both once the address is funded", [SIPA, { ...saved, fundedAt: 1 }, hold(SIPA)], "idle"],
  ])("%s", (_, input, state) => {
    expect(registrationPayment(...input)).toBe(state)
  })
})

describe("a registration payment across a reload", () => {
  const opened = async () => {
    const entries = new Map<string, string>()
    const page = load(entries)
    await page.registrations.start({ type: "started", record: START })
    return { entries, page }
  }

  it("refuses a second payment after a reload, until the chain settles the first", async () => {
    const { entries, page } = await opened()
    await page.holds.apply(held(SIPA))
    // A reload while the wallet holds the transfer: it may still send it.
    expect(await load(entries).row()).toBe("holding")
    await expect(load(entries).holds.apply(held(SIPA, "s2"))).rejects.toMatchObject({
      code: "deposit.sendHeld",
    })
    await page.registrations.apply(SIPA, {
      type: "fundingSubmitted",
      tx: { txHash: TX, at: SENT_AT },
    })
    await page.holds.apply({ type: "cleared", only: { submission: "s1" } })
    // A reload before the receipt: the saved transfer is checked, never sent again.
    const reloaded = load(entries)
    expect(await reloaded.row()).toBe("check")
    await reloaded.registrations.apply(SIPA, { type: "submissionFailed", txHash: TX })
    expect(await load(entries).row()).toBe("idle")
  })

  it("lets the address be paid again once a refund settles the saved transfer", async () => {
    const { entries, page } = await opened()
    await page.registrations.apply(SIPA, {
      type: "fundingSubmitted",
      tx: { txHash: TX, at: SENT_AT },
    })
    await page.registrations.apply(SIPA, { type: "refunded", txHash: OTHER_TX })
    expect(await load(entries).row()).toBe("idle")
  })

  it("refuses a hold it could not save", async () => {
    const { page } = await opened()
    page.backend.failing.commits = true
    await expect(page.holds.apply(held(SIPA))).rejects.toMatchObject({
      code: "deposit.holdUnsaved",
    })
  })
})

describe("submissionGone", () => {
  const FROM = `0x${"ef".repeat(20)}` as Hex
  const TOKEN = `0x${"dd".repeat(20)}` as Hex
  /** A node where `FROM` sent one transfer, still pending. */
  const sent = () => {
    const node = new FakeTransferNode()
    node.setBalance(FROM, TOKEN, 10n)
    const txHash = node.send({ from: FROM, token: TOKEN, to: SIPA, amount: 1n })
    return { node, tx: { txHash, at: SENT_AT, from: FROM, nonce: 0 } }
  }
  const gone = (node: FakeTransferNode, tx: SubmittedTx, learned = async () => {}, now = SENT_AT) =>
    submissionGone(node.client, tx, learned, now)

  it("waits on a transaction its sender has not passed", async () => {
    const { node, tx } = sent()
    expect(await gone(node, tx)).toBe(false)
  })

  it("leaves a landed or reverted one to its receipt", async () => {
    const { node, tx } = sent()
    const over = node.send({ from: FROM, token: TOKEN, to: SIPA, amount: 99n })
    node.mine()
    expect(await gone(node, tx)).toBe(false)
    expect(await gone(node, { txHash: over, at: SENT_AT, from: FROM, nonce: 1 })).toBe(false)
  })

  it.each(["dropped", "replaced"])("finds a %s one gone once its nonce passes", async (how) => {
    const { node, tx } = sent()
    if (how === "dropped") node.drop(tx.txHash)
    node.send({ from: FROM, token: TOKEN, to: OTHER, amount: 1n, nonce: 0 })
    node.mine()
    expect(await gone(node, tx)).toBe(true)
  })

  it("reads the sender and nonce of a hash saved alone and waits on it", async () => {
    const { node, tx } = sent()
    const learned: unknown[] = []
    const alone = { txHash: tx.txHash, at: SENT_AT }
    expect(await gone(node, alone, async (t) => void learned.push(t))).toBe(false)
    expect(learned).toEqual([{ ...tx, from: FROM.toLowerCase() }])
  })

  it("waits on a hash saved alone that the node does not know, until an hour after it was sent", async () => {
    const { node } = sent()
    const learned: unknown[] = []
    const unknown = { txHash: OTHER_TX, at: SENT_AT }
    const learn = async (t: SubmittedTx) => void learned.push(t)
    expect(await gone(node, unknown, learn, SENT_AT + UNKNOWN_HASH_MS)).toBe(false)
    expect(await gone(node, unknown, learn, SENT_AT + UNKNOWN_HASH_MS + 1)).toBe(true)
    expect(learned).toEqual([])
  })

  it("does not read a failed receipt lookup as gone", async () => {
    const { node, tx } = sent()
    node.failing = (method) => method === "getTransactionReceipt"
    await expect(gone(node, tx)).rejects.toThrow()
  })
})
