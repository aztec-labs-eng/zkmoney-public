// @vitest-environment node
// The link codec's byte checks need one realm, which jsdom splits.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RegistrationTerms } from "@obsidion/front-core"
import { ticketActivation } from "../../../../src/features/paylink/ticketContinuation"
import { stashClaimLink } from "../../../../src/features/paylink/claimStash"
import { linkIdentity } from "../../../../src/features/paylink/linkIdentity"
import { closeSession } from "../../../../src/session/session"
import { openTestSession } from "../../../support/session"
import { SIPA, pendingRecord } from "../../../support/registrationFixtures"
import { PAYLINK_FRAGMENT } from "../../../fixtures/scanPayloads"

const NOW = 1_700_000_000_000
const ticket = (over: Partial<RegistrationTerms> = {}): RegistrationTerms => ({
  deadline: NOW / 1000 + 600,
  fee: "1",
  minDeposit: "0",
  paylinkFunded: true,
  paylinkId: linkIdentity(PAYLINK_FRAGMENT),
  ...over,
})
const record = pendingRecord()
const activation = (
  terms: RegistrationTerms | null,
  burns: { recipient: string; phase: string }[] = [],
) => ticketActivation(record, terms, burns, NOW)

const tab = new Map<string, string>()
vi.stubGlobal("sessionStorage", {
  getItem: (key: string) => tab.get(key) ?? null,
  setItem: (key: string, value: string) => void tab.set(key, value),
  removeItem: (key: string) => void tab.delete(key),
})

beforeEach(() => {
  tab.clear()
  openTestSession()
})
afterEach(closeSession)

describe("a ticket-funded registration's activation", () => {
  it("is none for terms no link funds", () => {
    expect(activation({ deadline: NOW / 1000 + 600, fee: "1", minDeposit: "1" })).toBeNull()
  })

  it("is submitted once the claim's burn is on its way to the address", () => {
    expect(activation(ticket(), [{ recipient: SIPA, phase: "pending" }])).toEqual({
      state: "submitted",
    })
  })

  it("is blocked while the last renewal quoted terms the link cannot pay", () => {
    stashClaimLink(PAYLINK_FRAGMENT)
    expect(activation(ticket({ paylinkBlocked: true }))).toMatchObject({ state: "blocked" })
  })

  it.each([
    ["lapsed terms", { deadline: NOW / 1000 - 1 }],
    ["terms with no schedule", { fee: undefined, minDeposit: undefined }],
  ])("renews %s", (_, over) => {
    expect(activation(ticket(over))).toMatchObject({ state: "renew" })
  })

  it("misses the link until it is stashed on this tab, then is ready on the signed schedule", () => {
    expect(activation(ticket())).toEqual({ state: "missing_link" })
    stashClaimLink(PAYLINK_FRAGMENT)
    expect(activation(ticket())).toMatchObject({
      state: "ready",
      stash: { fragment: PAYLINK_FRAGMENT },
      schedule: { fee: 1n, min: 0n },
    })
  })
})
