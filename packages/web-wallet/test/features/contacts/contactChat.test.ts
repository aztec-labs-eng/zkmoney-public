// @vitest-environment node
/** Who a chat is with, each item's bubble words, and each role's side, label, icon and mark. */
import { describe, expect, it } from "vitest"
import {
  formatDateLabel,
  formatTimeLabel,
  type ChatItem,
  type ChatRole,
} from "@obsidion/front-core"
import {
  bubbleViewOf,
  chatContactOf,
  chatMessageOf,
} from "../../../src/features/contacts/contactChat"
import { usdCents } from "../../../src/ui/screens/activityView"
import copy from "../../../src/features/contacts/contactChat.copy"

const { label } = copy
const view = (role: ChatRole) => bubbleViewOf(role)
const plain = { error: false, struck: false, tick: "none", request: false, settled: false }

describe("bubbleViewOf", () => {
  it("shows open requests as gold request bubbles on the asker's side", () => {
    expect(view("request-out")).toEqual({
      ...plain,
      side: "right",
      label: label.owesYou,
      icon: "clock",
      request: true,
    })
    expect(view("request-in")).toEqual({
      ...plain,
      side: "left",
      label: label.youOwe,
      icon: "clock",
      request: true,
    })
  })

  it("shows a paid request as settled and a declined one struck in red", () => {
    expect(view("request-paid")).toEqual({
      ...plain,
      side: "left",
      label: label.youPaid,
      icon: "check",
      settled: true,
    })
    expect(view("request-declined")).toEqual({
      ...plain,
      side: "left",
      label: label.declined,
      icon: "reply-slash",
      error: true,
      struck: true,
    })
  })

  it("puts sends on the right and receives on the left, two ticks once mined", () => {
    expect(view("sent-confirmed")).toEqual({
      ...plain,
      side: "right",
      label: label.sent,
      icon: "forward",
      tick: "mined",
    })
    expect(view("received-confirmed")).toEqual({
      ...plain,
      side: "left",
      label: label.received,
      icon: "reply",
      tick: "mined",
    })
  })

  it("marks a transfer proving with a spinner and pending with one tick", () => {
    expect(view("sent-proving")).toEqual({
      ...plain,
      side: "right",
      label: label.pending,
      icon: "clock-outline",
      tick: "proving",
    })
    expect(view("received-pending")).toEqual({
      ...plain,
      side: "left",
      label: label.pending,
      icon: "clock-outline",
      tick: "sent",
    })
  })

  it("strikes a failed or cancelled transfer in red, labeled by which", () => {
    const struck = { ...plain, icon: "reply-slash", error: true, struck: true }
    expect(view("sent-failed")).toEqual({ ...struck, side: "right", label: label.failed })
    expect(view("received-cancelled")).toEqual({ ...struck, side: "left", label: label.cancelled })
  })
})

describe("chatContactOf", () => {
  const address = `0x${"ab".repeat(32)}`

  it("takes a payable contact's tag, address and retired addresses", () => {
    expect(
      chatContactOf({ name: "Alice", tag: "@alice", address, retiredAddresses: ["0xold"] }),
    ).toEqual({ tag: "@alice", address, retiredAddresses: ["0xold"], addressKind: "aztec-l2" })
  })

  it("names a pending handshake by its tag, else its name, with no address", () => {
    expect(chatContactOf({ name: "Bob", tag: "@bob", address: "" })).toEqual({
      tag: "@bob",
      addressKind: "aztec-l2",
    })
    expect(chatContactOf({ name: "Bob", address: "" })).toEqual({
      tag: "Bob",
      addressKind: "aztec-l2",
    })
  })
})

describe("chatMessageOf", () => {
  const ts = Date.UTC(2026, 1, 3, 11, 15)
  const money = { atomic: 2523n, decimals: 2 }
  const item = (over: Partial<ChatItem> = {}) =>
    ({ id: "i1", ts, role: "sent-confirmed", amount: { money, sign: "+" }, ...over } as ChatItem)

  it("dates the bubble, times it, and signs its dollars", () => {
    const one = item({ memo: "lunch" })
    expect(chatMessageOf(one)).toEqual({
      id: "i1",
      dateLabel: formatDateLabel(ts),
      timeLabel: formatTimeLabel(ts),
      amount: `+${usdCents(money)}`,
      role: "sent-confirmed",
      memo: "lunch",
      item: one,
    })
  })

  it("shows a transfer's state in place of the time, and an amount still read as detecting", () => {
    const message = chatMessageOf(item({ status: "needsRecovery", amount: "detecting" }))
    expect(message.timeLabel).toBe(copy.time.needsRecovery)
    expect(message.amount).toBe(copy.detecting)
  })
})
