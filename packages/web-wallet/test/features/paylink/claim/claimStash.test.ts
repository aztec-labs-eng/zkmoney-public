import { beforeEach, describe, expect, it } from "vitest"
import {
  CLAIM_STASH_KEY,
  RECEIVE_TO_ACCOUNT,
  TICKET_STASH_KEY,
  clearClaimStash,
  clearTicketSignup,
  peekClaimStash,
  peekTicketSignup,
  receivesToAccount,
  stashClaimLink,
  stashTicketSignup,
} from "../../../../src/features/paylink/claimStash"
import { fakeTabStash } from "../../../support/tabStash"

const ticket = {
  fragment: "frag-a",
  threshold: "2000000000000000000",
  schedule: { fee: "500000000000000000", minDeposit: "0" },
}

describe("claim stash — the ticket-funded signup marker", () => {
  let stash = fakeTabStash()
  beforeEach(() => (stash = fakeTabStash()))

  it("a marker for another link is stale, never a ticket for the new one", () => {
    stashTicketSignup(stash, ticket)
    stashClaimLink(stash, "frag-b")
    expect(peekTicketSignup(stash)).toBeNull()
    expect(stash.get(TICKET_STASH_KEY)).not.toBeNull()
  })

  it("settling the claim clears both; dropping the intent alone keeps the link for Home", () => {
    stashTicketSignup(stash, ticket)
    clearClaimStash(stash, "other")
    expect(peekTicketSignup(stash)).toEqual(ticket)
    clearClaimStash(stash, "frag-a")
    expect(stash.get(CLAIM_STASH_KEY)).toBeNull()
    expect(stash.get(TICKET_STASH_KEY)).toBeNull()

    stashTicketSignup(stash, ticket)
    clearTicketSignup(stash)
    expect(peekClaimStash(stash)).toBe("frag-a")
    expect(peekTicketSignup(stash)).toBeNull()
  })
})

describe("receivesToAccount", () => {
  it("is true only for the router state that chose to receive to an account", () => {
    expect(receivesToAccount(RECEIVE_TO_ACCOUNT)).toBe(true)
    expect(receivesToAccount({ receive: "l1" })).toBe(false)
    expect(receivesToAccount(null)).toBe(false)
    expect(receivesToAccount(undefined)).toBe(false)
  })
})
