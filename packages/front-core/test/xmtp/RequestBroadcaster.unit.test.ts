import { describe, it, expect } from "vitest"
import type { AztecPaymentRequestContent } from "@obsidion/sdk"

import { RequestBroadcaster } from "../../src/xmtp/RequestBroadcaster"
import type { IXmtpSender } from "../../src/xmtp/types"

const PEER = "0xAbCDef0000000000000000000000000000001234"

interface SendRequestCall {
  peerAddress: string
  content: AztecPaymentRequestContent
}

/** Hand-rolled fake recording every adapter call. */
class FakeXmtpSender implements IXmtpSender {
  canMessageCalls: string[][] = []
  sendRequestCalls: SendRequestCall[] = []

  canMessageImpl?: (addresses: string[]) => Promise<Record<string, boolean>>
  sendRequestImpl?: (peerAddress: string, content: AztecPaymentRequestContent) => Promise<string>

  async canMessage(addresses: string[]): Promise<Record<string, boolean>> {
    this.canMessageCalls.push(addresses)
    if (this.canMessageImpl) return this.canMessageImpl(addresses)
    return Object.fromEntries(addresses.map((a) => [a.toLowerCase(), true]))
  }

  async sendRequest(peerAddress: string, content: AztecPaymentRequestContent): Promise<string> {
    this.sendRequestCalls.push({ peerAddress, content })
    if (this.sendRequestImpl) return this.sendRequestImpl(peerAddress, content)
    return "fake-msg-1"
  }
}

const REQ = "0x" + "0c".repeat(32)

const token = {
  address: "0x00000000000000000000000000000000000000000000000000000000deadbeef",
  symbol: "DAI",
  decimals: 6,
}

function announceInput(overrides: Record<string, unknown> = {}) {
  return {
    recipientXmtpAddress: PEER,
    requestId: REQ,
    requesterTag: "alice",
    amountAtomic: "1000000",
    token,
    networkId: "aztec-sandbox",
    ...overrides,
  }
}

describe("RequestBroadcaster.announce", () => {
  it("builds a request payload and returns the messageId", async () => {
    const fake = new FakeXmtpSender()
    const result = await new RequestBroadcaster(fake).announce(announceInput({ note: "lunch" }))

    expect(result).toEqual({ status: "sent", messageId: "fake-msg-1" })
    expect(fake.sendRequestCalls).toHaveLength(1)
    const { content } = fake.sendRequestCalls[0]
    expect(content.kind).toBe("request")
    if (content.kind === "request") {
      expect(content.requestId).toBe(REQ)
      expect(content.requesterTag).toBe("alice")
      expect(content.amountAtomic).toBe("1000000")
      expect(content.note).toBe("lunch")
    }
  })

  it("skips when no recipient address", async () => {
    const fake = new FakeXmtpSender()
    const result = await new RequestBroadcaster(fake).announce(
      announceInput({ recipientXmtpAddress: null }),
    )
    expect(result).toEqual({ status: "skipped", reason: "no-xmtp-address" })
    expect(fake.sendRequestCalls).toHaveLength(0)
  })

  it("skips when the recipient is unreachable", async () => {
    const fake = new FakeXmtpSender()
    fake.canMessageImpl = async () => ({ [PEER.toLowerCase()]: false })
    const result = await new RequestBroadcaster(fake).announce(announceInput())
    expect(result).toEqual({ status: "skipped", reason: "recipient-not-reachable" })
  })

  it("maps a canMessage throw to failed", async () => {
    const fake = new FakeXmtpSender()
    fake.canMessageImpl = async () => {
      throw new Error("network down")
    }
    const result = await new RequestBroadcaster(fake).announce(announceInput())
    expect(result.status).toBe("failed")
  })

  it("maps a sendRequest throw to failed", async () => {
    const fake = new FakeXmtpSender()
    fake.sendRequestImpl = async () => {
      throw new Error("send failed")
    }
    const result = await new RequestBroadcaster(fake).announce(announceInput())
    expect(result.status).toBe("failed")
  })
})

describe("RequestBroadcaster.signalDeclined", () => {
  it("sends a declined signal", async () => {
    const fake = new FakeXmtpSender()
    const result = await new RequestBroadcaster(fake).signalDeclined({
      recipientXmtpAddress: PEER,
      requestId: REQ,
      networkId: "aztec-sandbox",
    })
    expect(result.status).toBe("sent")
    expect(fake.sendRequestCalls[0].content.kind).toBe("request-declined")
  })
})
