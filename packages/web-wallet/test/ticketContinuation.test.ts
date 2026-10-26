/**
 * Which stashed link Home claims with the registration burn: only the one whose ticket paid for
 * this account's still-unfunded signup.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { PendingRegistrationStore, type PendingRegistrationRecord } from "@obsidion/front-core"
import type { Hex } from "viem"
import {
  DAI as ONE,
  pendingRecord,
  resetRegistrationStores,
  SIPA,
  ticketBoundTerms,
  ticketSignupStash,
} from "./support/registrationFixtures"

// Fake fragments never decode; the binding only needs a stable name for one.
vi.mock("../src/features/paylink/linkIdentity", () => ({
  linkIdentity: (fragment: string) => `id:${fragment}`,
}))
import {
  loadRegistrationTerms,
  saveRegistrationTerms,
  type RegistrationTerms,
} from "../src/features/onboarding/registrationTerms"
import { stashClaimLink, stashTicketSignup } from "../src/features/paylink/claimStash"
import {
  bindLinkDeposit,
  boundTicketSignup,
  fundingRefusalCopy,
  releaseLinkDeposit,
  ticketActivation,
  ticketSignupCommitted,
  ticketSignupRegistration,
  ticketSignupContinuation,
  unfundedRegistration,
} from "../src/features/paylink/ticketContinuation"
import { webStorage } from "../src/platform/storage/WebStorageAdapter"

const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex

const record = (over: Partial<PendingRegistrationRecord> = {}) =>
  pendingRecord({ account: ACCOUNT, l2Address: L2_ADDRESS, ...over })
const terms = (over: Partial<RegistrationTerms> = {}) =>
  saveRegistrationTerms(ticketBoundTerms({ account: ACCOUNT, ...over }))
const stash = (fragment = "paylink-frag") =>
  stashTicketSignup(ticketSignupStash({ fragment, amount: (20n * ONE).toString() }))

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  resetRegistrationStores()
})

describe("ticketSignupContinuation", () => {
  const burning = [{ recipient: SIPA, phase: "pending" }]

  it("names the signup the stashed link paid for and still has to fund", async () => {
    stash()
    await PendingRegistrationStore.get(webStorage).upsert(ACCOUNT, {}, record())
    terms()
    const found = ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])
    expect(found?.stash.fragment).toBe("paylink-frag")
    expect(found?.stash.amount).toBe((20n * ONE).toString())
    expect(found?.record.tag).toBe("taga")
    expect(found?.activation).toMatchObject({
      state: "ready",
      schedule: { min: 0n, fee: ONE / 2n },
    })
  })

  it("recognises the bound link reopened on a tab that lost its marker, from the terms alone", async () => {
    stash()
    await PendingRegistrationStore.get(webStorage).upsert(ACCOUNT, {}, record())
    terms()
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])?.activation.state).toBe("ready")
    // The user entered the wallet, closed the tab and opened the link again: /link's signed-in
    // hand-off stashes the bare fragment. The binding outlives the marker.
    sessionStorage.clear()
    stashClaimLink("paylink-frag")
    const found = ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])
    expect(found?.activation.state).toBe("ready")
    // Rebuilt from the terms: the split they signed, no amount or memo until the link is read.
    expect(found?.stash).toEqual({
      fragment: "paylink-frag",
      schedule: { fee: (ONE / 2n).toString(), minDeposit: "0" },
    })
    // Terms without a signed schedule rebuild nothing: the renewal has to price the split first.
    terms({ fee: undefined, minDeposit: undefined })
    expect(boundTicketSignup(loadRegistrationTerms(ACCOUNT, "taga"))).toBeNull()
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()
  })

  it("a signup whose renewed quote the link cannot pay is blocked, never an ordinary claim", async () => {
    stash()
    await PendingRegistrationStore.get(webStorage).upsert(ACCOUNT, {}, record())
    terms({
      fee: (5n * ONE).toString(),
      minDeposit: (10n * ONE).toString(),
      feeWaived: false,
      paylinkBlocked: true,
    })
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])?.activation).toMatchObject({
      state: "blocked",
    })
  })

  it("holds a lapsed signup with its reason, never as an ordinary claim", async () => {
    stash()
    await PendingRegistrationStore.get(webStorage).upsert(ACCOUNT, {}, record())
    terms({ deadline: Math.floor(Date.now() / 1000) - 60 })
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])?.activation.state).toBe("renew")
    // The clock the caller passes decides.
    expect(
      ticketSignupContinuation(
        "paylink-frag",
        L2_ADDRESS,
        [],
        (Math.floor(Date.now() / 1000) - 120) * 1000,
      )?.activation.state,
    ).toBe("ready")
    // An unpriced quote is no schedule to burn from.
    terms({ fee: "0", minDeposit: "0" })
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])?.activation.state).toBe("renew")
  })

  it("is ready before its address is published: the claim publishes it", async () => {
    stash()
    terms()
    await PendingRegistrationStore.get(webStorage).upsert(ACCOUNT, { broadcast: false }, record())
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])?.activation.state).toBe("ready")
    // Without its link on the tab nothing can publish it: the link is reopened.
    sessionStorage.clear()
    expect(
      ticketActivation(record({ broadcast: false }), loadRegistrationTerms(ACCOUNT, "taga"), []),
    ).toEqual({
      state: "missing_link",
    })
  })

  it("is nothing for an ordinary stashed link, or a marker for another link", async () => {
    await PendingRegistrationStore.get(webStorage).upsert(ACCOUNT, {}, record())
    terms({ paylinkFunded: false })
    stashClaimLink("paylink-frag")
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()
    terms()
    stashClaimLink("link-b")
    expect(ticketSignupContinuation("link-b", L2_ADDRESS, [])).toBeNull()
    // The link Home shows decides, not a marker another visitor left beside it.
    stash("other-frag")
    expect(ticketSignupContinuation("other-frag", L2_ADDRESS, [])).toBeNull()
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])?.stash).toEqual({
      fragment: "paylink-frag",
      schedule: { fee: (ONE / 2n).toString(), minDeposit: "0" },
    })
  })

  it("is nothing for another account, a funded or settled registration, or terms a paylink cannot fund", async () => {
    stash()
    const store = PendingRegistrationStore.get(webStorage)
    terms()
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()

    await store.upsert(ACCOUNT, {}, record())
    expect(ticketSignupContinuation("paylink-frag", `0x${"ef".repeat(32)}`, [])).toBeNull()
    expect(ticketSignupContinuation("paylink-frag", undefined, [])).toBeNull()

    // Funded or swept by other means, the registration no longer needs the link; funded by this
    // account's own burn, the link's review still reports it, submitted, until the name confirms.
    await store.upsert(ACCOUNT, { fundedAt: Date.now() }, record())
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, burning)?.activation).toEqual({
      state: "submitted",
    })
    await store.upsert(ACCOUNT, { phase: "funded" }, record())
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, burning)?.activation).toEqual({
      state: "submitted",
    })
    await store.upsert(
      ACCOUNT,
      { fundedAt: undefined, phase: "awaiting_deposit", sweptAt: Date.now() },
      record(),
    )
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()
    await store.upsert(ACCOUNT, { sweptAt: undefined, phase: "confirmed" }, record())
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, burning)).toBeNull()

    await store.upsert(ACCOUNT, { phase: "awaiting_deposit" }, record())
    terms({ paylinkFunded: false })
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()
    terms({ tag: "other" })
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()
  })

  it("a later link cannot attach to the signup an earlier link paid for", async () => {
    await PendingRegistrationStore.get(webStorage).upsert(ACCOUNT, {}, record())
    terms()
    stash()
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).not.toBeNull()
    // Another visitor picked link B on this tab and walked away; A's terms are still the last signed.
    stash("link-b")
    expect(ticketSignupContinuation("link-b", L2_ADDRESS, [])).toBeNull()
    // A write that keeps the funding keeps the link; only dropping the funding frees the signup.
    terms({ paylinkId: undefined })
    stash()
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).not.toBeNull()
    terms({ paylinkFunded: false })
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()
  })
})

describe("boundTicketSignup / ticketSignupCommitted", () => {
  it("only the stashed link the terms name is the registration's own, with or without its marker", () => {
    const bound = ticketBoundTerms({ account: ACCOUNT, deadline: 1 })
    expect(boundTicketSignup(bound)).toBeNull()
    stash()
    expect(boundTicketSignup(bound)?.amount).toBe((20n * ONE).toString())
    expect(boundTicketSignup({ ...bound, paylinkId: "id:other" })).toBeNull()
    expect(boundTicketSignup({ ...bound, paylinkId: undefined })).toBeNull()
    expect(boundTicketSignup(null)).toBeNull()
    // The bare link, stashed by the signed-in hand-off, is the same link.
    sessionStorage.clear()
    stashClaimLink("paylink-frag")
    expect(boundTicketSignup(bound)).toEqual({
      fragment: "paylink-frag",
      schedule: { fee: (ONE / 2n).toString(), minDeposit: "0" },
    })
    stashClaimLink("link-b")
    expect(boundTicketSignup(bound)).toBeNull()
    // A marker for another link beside the bound link's own stash is stale, and the link still counts.
    stashClaimLink("paylink-frag")
    sessionStorage.setItem("obsidion.pending-claim.ticket", JSON.stringify({ fragment: "link-b" }))
    expect(boundTicketSignup(bound)?.fragment).toBe("paylink-frag")
  })

  it("rebuilds a deposit the link pays at the name's price as paid, never as a ticket", () => {
    stashClaimLink("paylink-frag")
    const paid = ticketBoundTerms({ account: ACCOUNT, deadline: 1, paylinkDeposit: true })
    expect(boundTicketSignup(paid)).toMatchObject({ fragment: "paylink-frag", paid: true })
    expect(
      boundTicketSignup(ticketBoundTerms({ account: ACCOUNT, deadline: 1 })),
    ).not.toHaveProperty("paid")
  })

  it("selects the link's registration rather than a newer unrelated record, until it settles", async () => {
    const store = PendingRegistrationStore.get(webStorage)
    expect(ticketSignupCommitted("paylink-frag")).toBe(false)
    await store.upsert(ACCOUNT, {}, record({ startTime: Date.now() - 60000 }))
    terms()
    await store.upsert(
      "0x00000000000000000000000000000000000000bb",
      {},
      record({ tag: "bob", l2Address: `0x${"ef".repeat(32)}` }),
    )
    expect(ticketSignupCommitted("paylink-frag")).toBe(true)
    expect(ticketSignupCommitted("link-b")).toBe(false)
    expect(ticketSignupRegistration("paylink-frag", L2_ADDRESS)?.account).toBe(ACCOUNT)
    expect(ticketSignupRegistration("paylink-frag", `0x${"ef".repeat(32)}`)).toBeNull()
    await store.close(ACCOUNT, "confirmed")
    expect(ticketSignupCommitted("paylink-frag")).toBe(false)
  })
})

describe("ticketActivation", () => {
  const full = record

  it("is nothing for a registration no paylink funds, whatever its waiver says", () => {
    terms({ paylinkFunded: false })
    expect(ticketActivation(full(), loadRegistrationTerms(ACCOUNT, "taga"), [])).toBeNull()
    expect(ticketActivation(full(), null, [])).toBeNull()
  })

  it("shows progress once the burn is on its way, and never a claim", () => {
    terms()
    stash()
    const burning = [{ recipient: SIPA.toUpperCase(), phase: "pending" }]
    expect(ticketActivation(full(), loadRegistrationTerms(ACCOUNT, "taga"), burning)).toEqual({
      state: "submitted",
    })
    // A failed or reclaimed burn is not on its way; custody stamps are.
    for (const phase of ["failed", "recovered"]) {
      expect(
        ticketActivation(full(), loadRegistrationTerms(ACCOUNT, "taga"), [
          { recipient: SIPA, phase },
        ])?.state,
      ).toBe("ready")
    }
    expect(
      ticketActivation(full({ fundedAt: 1 }), loadRegistrationTerms(ACCOUNT, "taga"), []),
    ).toEqual({ state: "submitted" })
    expect(
      ticketActivation(full({ sweptAt: 1 }), loadRegistrationTerms(ACCOUNT, "taga"), []),
    ).toEqual({ state: "submitted" })
  })

  it("is ready only with the bound link on this tab and live fundable terms, published or not", () => {
    terms()
    stash()
    const ready = ticketActivation(full(), loadRegistrationTerms(ACCOUNT, "taga"), [])
    expect(ready).toMatchObject({ state: "ready", schedule: { fee: ONE / 2n, min: 0n } })
    expect(ready?.state === "ready" && ready.stash.fragment).toBe("paylink-frag")

    expect(
      ticketActivation(full({ broadcast: false }), loadRegistrationTerms(ACCOUNT, "taga"), []),
    ).toMatchObject({ state: "ready" })

    sessionStorage.clear()
    expect(ticketActivation(full(), loadRegistrationTerms(ACCOUNT, "taga"), [])).toEqual({
      state: "missing_link",
    })
    stash("other-frag")
    expect(ticketActivation(full(), loadRegistrationTerms(ACCOUNT, "taga"), [])).toEqual({
      state: "missing_link",
    })
  })

  it("keeps a blocked or lapsed binding a ticket, with the way back to its renewal", () => {
    stash()
    terms({ paylinkBlocked: true })
    expect(ticketActivation(full(), loadRegistrationTerms(ACCOUNT, "taga"), [])).toMatchObject({
      state: "blocked",
    })
    // A block outlasts every write that does not lift it.
    terms({ deadline: Math.floor(Date.now() / 1000) - 60 })
    expect(ticketActivation(full(), loadRegistrationTerms(ACCOUNT, "taga"), [])).toMatchObject({
      state: "blocked",
    })
    terms({ deadline: Math.floor(Date.now() / 1000) - 60, paylinkBlocked: false })
    expect(ticketActivation(full(), loadRegistrationTerms(ACCOUNT, "taga"), [])).toMatchObject({
      state: "renew",
    })
    terms({ fee: undefined, minDeposit: undefined })
    expect(ticketActivation(full(), loadRegistrationTerms(ACCOUNT, "taga"), [])).toMatchObject({
      state: "renew",
    })
  })
})

describe("releaseLinkDeposit", () => {
  it("asks a closed link's deposit of the user again, and leaves a ticket's binding alone", async () => {
    stashClaimLink("paylink-frag")
    const rec = record()
    await PendingRegistrationStore.get(webStorage).upsert(ACCOUNT, {}, rec)
    terms({ feeWaived: true, minDeposit: String(ONE), paylinkDeposit: true })
    expect(ticketActivation(rec, loadRegistrationTerms(ACCOUNT, "taga"), [])?.state).toBe("ready")
    releaseLinkDeposit(rec)
    const released = loadRegistrationTerms(ACCOUNT, "taga")
    expect(released).not.toHaveProperty("paylinkId")
    expect(released).toMatchObject({ minDeposit: String(ONE), feeWaived: true })
    expect(ticketActivation(rec, released, [])).toBeNull()

    terms()
    releaseLinkDeposit(rec)
    expect(loadRegistrationTerms(ACCOUNT, "taga")).toMatchObject({ paylinkFunded: true })
  })
})

describe("an entered account's registration a link funds", () => {
  /** A drawn tag's live signed deposit, with nothing at its address yet. */
  const waiting = async (over: Partial<PendingRegistrationRecord> = {}) => {
    const rec = record(over)
    await PendingRegistrationStore.get(webStorage).upsert(ACCOUNT, {}, rec)
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: Math.floor(Date.now() / 1000) + 7200,
      fee: String(ONE / 2n),
      minDeposit: String(ONE),
      feeWaived: true,
    })
    return rec
  }

  it("offers the registration still waiting for its deposit, at its signed schedule", async () => {
    await waiting()
    expect(unfundedRegistration(L2_ADDRESS, [])).toMatchObject({
      record: { account: ACCOUNT, tag: "taga" },
      schedule: { fee: ONE / 2n, min: ONE },
    })
  })

  it.each([
    ["funded already", { fundedAt: 1 }],
    ["past its deposit", { phase: "confirmed" as const }],
    [
      "whose address can never be published",
      { broadcast: false, replaced: { sipaAddress: SIPA, refunded: false, broadcastSpent: true } },
    ],
  ])("offers nothing for a registration %s", async (_, over) => {
    await waiting(over)
    expect(unfundedRegistration(L2_ADDRESS, [])).toBeNull()
  })

  it("offers nothing once a link funds it, and the binding makes Home's claim of that link fund it", async () => {
    stashClaimLink("paylink-frag")
    const rec = await waiting()
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()
    await bindLinkDeposit(
      rec,
      { fragment: "paylink-frag", amount: 52n * ONE, senderTag: "maple" },
      ONE / 10n,
      "faster",
    )
    expect(unfundedRegistration(L2_ADDRESS, [])).toBeNull()
    expect(loadRegistrationTerms(ACCOUNT, "taga")).toMatchObject({
      paylinkFunded: true,
      paylinkDeposit: true,
      paylinkId: "id:paylink-frag",
      proverTip: String(ONE / 10n),
    })
    // The hero reads it as claiming, not as waiting for a deposit.
    expect(ticketActivation(rec, loadRegistrationTerms(ACCOUNT, "taga"), [])?.state).toBe("ready")
    const continued = ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])
    expect(continued?.activation.state).toBe("ready")
    // Who sent it and how much, kept with the binding for once the link reads as claimed.
    expect(continued?.stash).toMatchObject({ amount: String(52n * ONE), senderTag: "maple" })
  })
})

describe("fundingRefusalCopy", () => {
  it("puts a funding refusal in words, and leaves other errors alone", () => {
    const refusal = (reason: string) =>
      Object.assign(new Error("raw"), { name: "RegistrationFundingError", reason })
    expect(fundingRefusalCopy(refusal("unpublished"))).toBe(
      "The registration's address is still being set up. Try again in a moment.",
    )
    expect(fundingRefusalCopy(refusal("uncovered"))).toBe(
      "This payment cannot cover the account deposit.",
    )
    expect(fundingRefusalCopy(new Error("boom"))).toBeUndefined()
  })
})
