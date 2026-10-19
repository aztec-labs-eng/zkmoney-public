import { beforeEach, describe, expect, it } from "vitest"
import {
  CLAIM_STASH_KEY,
  TICKET_STASH_KEY,
  clearClaimStash,
  clearTicketSignup,
  peekClaimStash,
  peekTicketSignup,
  stashClaimLink,
  stashTicketSignup,
  updateTicketSignup,
} from "../src/features/paylink/claimStash"

const ticket = {
  fragment: "frag-a",
  threshold: "2000000000000000000",
  schedule: { fee: "500000000000000000", minDeposit: "0" },
}

describe("claim stash — the ticket-funded signup marker", () => {
  beforeEach(() => sessionStorage.clear())

  it("an ordinary stashed link carries no ticket intent", () => {
    stashClaimLink("frag-a")
    expect(peekClaimStash()).toBe("frag-a")
    expect(peekTicketSignup()).toBeNull()
  })

  it("a ticket signup stashes the link and its offer together", () => {
    stashTicketSignup(ticket)
    expect(peekClaimStash()).toBe("frag-a")
    expect(peekTicketSignup()).toEqual(ticket)
  })

  it("carries the visitor page's read of the link to Home", () => {
    const read = {
      amount: "25000000000000000000",
      memo: "Pizza dinner",
      claimableFrom: 1_800_000_100,
      claimableUntil: 1_800_086_500,
      tokenAddress: "0xtoken",
      txHash: "0xfund",
    }
    stashTicketSignup({ ...ticket, ...read })
    expect(peekTicketSignup()).toEqual({ ...ticket, ...read })
  })

  it("a marker for another link is stale, never a ticket for the new one", () => {
    stashTicketSignup(ticket)
    stashClaimLink("frag-b")
    expect(peekTicketSignup()).toBeNull()
    expect(sessionStorage.getItem(TICKET_STASH_KEY)).not.toBeNull()
  })

  it("keeps the amount the witness read, and survives a garbled marker", () => {
    stashTicketSignup(ticket)
    updateTicketSignup({ amount: "20" })
    expect(peekTicketSignup()?.amount).toBe("20")
    sessionStorage.setItem(TICKET_STASH_KEY, "{not json")
    expect(peekTicketSignup()).toBeNull()
  })

  it("settling the claim clears both; dropping the intent alone keeps the link for Home", () => {
    stashTicketSignup(ticket)
    clearClaimStash("other")
    expect(peekTicketSignup()).toEqual(ticket)
    clearClaimStash("frag-a")
    expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBeNull()
    expect(sessionStorage.getItem(TICKET_STASH_KEY)).toBeNull()

    stashTicketSignup(ticket)
    clearTicketSignup()
    expect(peekClaimStash()).toBe("frag-a")
    expect(peekTicketSignup()).toBeNull()
  })
})
