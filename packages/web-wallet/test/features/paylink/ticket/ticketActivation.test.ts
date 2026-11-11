// @vitest-environment node
// The link codec's byte checks need one realm, which jsdom splits.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  memoryStore,
  type PendingRegistrationRecord,
  type RegistrationTerms,
} from "@obsidion/front-core"
import {
  ticketActivation,
  ticketSignupCommitted,
  ticketSignupResumable,
} from "../../../../src/features/paylink/ticketContinuation"
import { TICKET_SIGNUP_PREFIX } from "../../../../src/platform/storage/deviceKeys"
import type { Session } from "../../../../src/session/session"
import { stashClaimLink } from "../../../../src/features/paylink/claimStash"
import { tabStash } from "../../../../src/platform/storage/tabStash"
import { linkIdentity } from "../../../../src/features/paylink/linkIdentity"
import { closeSession } from "../../../../src/session/session"
import { openTestSession } from "../../../support/session"
import { SIPA, pendingRecord } from "../../../support/registrationFixtures"
import { PAYLINK_FRAGMENT } from "../../../fixtures/scanPayloads"
import { defaultConfig } from "../../../support/page"

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
) => ticketActivation(openTestSession(), record, terms, burns, NOW)

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
    stashClaimLink(tabStash, PAYLINK_FRAGMENT)
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
    stashClaimLink(tabStash, PAYLINK_FRAGMENT)
    expect(activation(ticket())).toMatchObject({
      state: "ready",
      stash: { fragment: PAYLINK_FRAGMENT },
      schedule: { fee: 1n, min: 0n },
    })
  })
})

describe("a ticket signup reopened on this browser", () => {
  const paylinkId = linkIdentity(PAYLINK_FRAGMENT)
  const open = pendingRecord({ terms: ticket() })
  /** A session holding `records` and the device's saved ticket signup for this link, if any. */
  const reads = (
    records: PendingRegistrationRecord[],
    saved?: string,
    loaded = true,
  ): Pick<Session, "registrations" | "device" | "page"> => {
    const key = `${TICKET_SIGNUP_PREFIX}${defaultConfig.rpId}:${paylinkId}`
    return {
      page: { config: defaultConfig },
      registrations: { view: memoryStore({ records, loaded: true, failed: false }) },
      device: memoryStore({
        loaded,
        ticketSignups: new Map(saved === undefined ? [] : [[key, saved]]),
      }),
    } as unknown as Pick<Session, "registrations" | "device" | "page">
  }
  const account = JSON.stringify({ credentialId: "c1", l2Address: `0x${"ab".repeat(32)}` })
  const creating = JSON.stringify({ phase: "creating", attemptId: "a1", tag: "taga" })

  it("is committed while an open registration names the link", () => {
    expect(ticketSignupCommitted(reads([open]), PAYLINK_FRAGMENT)).toBe(true)
    expect(ticketSignupCommitted(reads([{ ...open, phase: "confirmed" }]), PAYLINK_FRAGMENT)).toBe(
      false,
    )
    expect(ticketSignupCommitted(reads([open]), "not a link")).toBe(false)
  })

  it("resumes an open registration or a saved account, never a link it cannot read", () => {
    expect(ticketSignupResumable(reads([open]), PAYLINK_FRAGMENT)).toBe(true)
    expect(ticketSignupResumable(reads([], account), PAYLINK_FRAGMENT)).toBe(true)
    expect(ticketSignupResumable(reads([]), PAYLINK_FRAGMENT)).toBe(false)
    expect(ticketSignupResumable(reads([], account), "not a link")).toBe(false)
  })

  it("starts over on a passkey still being created, a binding it cannot read, or unloaded keys", () => {
    expect(ticketSignupResumable(reads([], creating), PAYLINK_FRAGMENT)).toBe(false)
    expect(ticketSignupResumable(reads([], "{"), PAYLINK_FRAGMENT)).toBe(false)
    expect(ticketSignupResumable(reads([], account, false), PAYLINK_FRAGMENT)).toBe(false)
  })
})
