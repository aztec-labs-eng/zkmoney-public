// @vitest-environment node
/** A bell entry names its sender as the activity row does, and quotes its figure in dollars. */
import { truncateMiddle, type OperationRecord, type TokenTransaction } from "@obsidion/front-core"
import { describe, expect, it } from "vitest"
import { operationIdOf, operationText } from "../../src/features/operations/operationEntries"
import { fmt } from "../../src/lib/fmt"
import copy from "../../src/ui/notifications.copy"
import { notificationText } from "../../src/ui/notificationText"

const ZERO = "0x" + "0".repeat(40)
const SENDER = "0x" + "12ab".repeat(16)

function received(tx: Partial<TokenTransaction>, amountAtomic = 5_000_000n, decimals = 6) {
  return notificationText({
    about: {
      kind: "receive",
      tx: { amountAtomic, token: { decimals }, ...tx } as TokenTransaction,
    },
  })
}
const from = (who: string, amount = "$5") => fmt(copy.receive.description, { amount, from: who })

describe("a received payment's entry", () => {
  it("quotes whole dollars bare and cents to two places", () => {
    expect(received({ from: "alice" }).description).toBe(from("alice"))
    expect(received({ from: "alice" }, 2_500_000n).description).toBe(from("alice", "$2.50"))
  })

  it("names a mint the faucet, keeps a tag, and cuts an address", () => {
    expect(received({ from: ZERO }).description).toBe(from(copy.receive.faucet))
    expect(received({ senderL2Address: ZERO }).description).toBe(from(copy.receive.faucet))
    expect(received({ from: SENDER }).description).toBe(from(truncateMiddle(SENDER, 15)))
    expect(received({ from: "0xabc", senderL2Address: SENDER }).description).toBe(
      from(truncateMiddle(SENDER, 15)),
    )
    expect(received({}).description).toBe(from(copy.receive.unknown))
  })
})

describe("a new contact's entry", () => {
  const added = (data: { address: string; contactId: string; tag?: string }) =>
    notificationText({
      about: { kind: "event", event: { id: "c", at: 0, kind: "contactAdded", data } },
    }).description

  it("names the contact by its tag, else by its short address", () => {
    const tagged = added({ address: SENDER, contactId: "bob", tag: "bob" })
    const bare = added({ address: SENDER, contactId: SENDER })
    expect(tagged).toBe(
      fmt(copy.contactAdded.description, { who: fmt(copy.contactAdded.tag, { tag: "bob" }) }),
    )
    expect(bare).not.toBe(tagged)
    expect(bare).not.toContain(SENDER)
  })
})

describe("an operation's entry", () => {
  it("reads as the operation's own text", () => {
    const record = {
      operationId: "o",
      flow: "send",
      state: "settled",
      summary: "$3",
    } as OperationRecord
    expect(notificationText({ about: { kind: "operation", record } })).toEqual(
      operationText(record),
    )
  })
})

describe("operationIdOf", () => {
  it("reads the operation an operation entry stands for, and none for any other entry", () => {
    expect(operationIdOf("operation:op1")).toBe("op1")
    expect(operationIdOf("receive:0xaa")).toBeUndefined()
  })
})
