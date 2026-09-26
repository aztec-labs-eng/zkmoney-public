/**
 * Which stashed link Home claims with the registration burn: only the one whose ticket paid for
 * this account's still-unfunded signup.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { PendingRegistrationStore, type PendingRegistrationRecord } from "@obsidion/front-core"
import type { Hex } from "viem"

// Fake fragments never decode; the binding only needs a stable name for one.
vi.mock("../src/features/paylink/linkIdentity", () => ({
  linkIdentity: (fragment: string) => `id:${fragment}`,
}))
import {
  loadRegistrationTerms,
  saveRegistrationTerms,
} from "../src/features/onboarding/registrationTerms"
import { stashClaimLink, stashTicketSignup } from "../src/features/paylink/claimStash"
import {
  boundTicketSignup,
  ticketActivation,
  ticketSignupCommitted,
  ticketSignupRegistration,
  ticketSignupContinuation,
} from "../src/features/paylink/ticketContinuation"
import { webStorage } from "../src/platform/storage/WebStorageAdapter"

const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex
const ONE = 10n ** 18n

const record = (
  over: Partial<PendingRegistrationRecord> = {},
): Omit<PendingRegistrationRecord, "account"> => ({
  tag: "taga",
  nameHash: `0x${"ab".repeat(32)}` as Hex,
  l2Address: L2_ADDRESS,
  l1ChainId: 11155111,
  sipaAddress: "0x00000000000000000000000000000000000000c3",
  depositToken: "0x00000000000000000000000000000000000000d4",
  broadcast: true,
  phase: "awaiting_deposit",
  retries: 0,
  startTime: Date.now(),
  ...over,
})
const terms = (over: Partial<Parameters<typeof saveRegistrationTerms>[0]> = {}) =>
  saveRegistrationTerms({
    account: ACCOUNT,
    tag: "taga",
    deadline: Math.floor(Date.now() / 1000) + 7200,
    fee: (ONE / 2n).toString(),
    minDeposit: "0",
    feeWaived: true,
    paylinkFunded: true,
    paylinkId: "id:paylink-frag",
    ...over,
  })
const stash = (fragment = "paylink-frag") =>
  stashTicketSignup({
    fragment,
    threshold: (2n * ONE).toString(),
    schedule: { fee: (ONE / 2n).toString(), minDeposit: "0" },
    amount: (20n * ONE).toString(),
  })

describe("ticketSignupContinuation", () => {
  const SIPA = "0x00000000000000000000000000000000000000c3"
  const burning = [{ recipient: SIPA, phase: "pending" }]
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
  })

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
    expect(loadRegistrationTerms(ACCOUNT, "taga")?.paylinkId).toBe("id:paylink-frag")
    const found = ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])
    expect(found?.activation.state).toBe("ready")
    // Rebuilt from the terms: the split they signed, no amount or memo until the link is read.
    expect(found?.stash).toEqual({
      fragment: "paylink-frag",
      schedule: { fee: (ONE / 2n).toString(), minDeposit: "0" },
    })
    expect(boundTicketSignup(loadRegistrationTerms(ACCOUNT, "taga"))?.fragment).toBe("paylink-frag")
    expect(
      ticketActivation(
        { account: ACCOUNT, ...record() },
        loadRegistrationTerms(ACCOUNT, "taga"),
        [],
      )?.state,
    ).toBe("ready")
    // Terms without a signed schedule rebuild nothing: the renewal has to price the split first.
    terms({ fee: undefined, minDeposit: undefined })
    expect(boundTicketSignup(loadRegistrationTerms(ACCOUNT, "taga"))).toBeNull()
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()
    expect(
      ticketActivation(
        { account: ACCOUNT, ...record() },
        loadRegistrationTerms(ACCOUNT, "taga"),
        [],
      )?.state,
    ).toBe("renew")
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
    expect(boundTicketSignup(loadRegistrationTerms(ACCOUNT, "taga"))?.fragment).toBe("paylink-frag")
    expect(ticketSignupCommitted("paylink-frag")).toBe(true)
  })

  it("holds a lapsed, unpublished or already-burning signup with its reason, never as an ordinary claim", async () => {
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
    terms()
    await PendingRegistrationStore.get(webStorage).upsert(ACCOUNT, { broadcast: false }, record())
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])?.activation.state).toBe(
      "unpublished",
    )
    await PendingRegistrationStore.get(webStorage).upsert(ACCOUNT, { broadcast: true }, record())
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, burning)?.activation).toEqual({
      state: "submitted",
    })
    // A failed burn is not on its way: the claim is offered again.
    expect(
      ticketSignupContinuation("paylink-frag", L2_ADDRESS, [{ recipient: SIPA, phase: "failed" }])
        ?.activation.state,
    ).toBe("ready")
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

    // Funded or swept by any means, the registration no longer needs the link.
    await store.upsert(ACCOUNT, { fundedAt: Date.now() }, record())
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()
    await store.upsert(ACCOUNT, { fundedAt: undefined, sweptAt: Date.now() }, record())
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()
    await store.upsert(ACCOUNT, { sweptAt: undefined, phase: "confirmed" }, record())
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()

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
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
  })

  it("only the stashed link the terms name is the registration's own, with or without its marker", () => {
    const bound = {
      account: ACCOUNT,
      tag: "taga",
      deadline: 1,
      fee: (ONE / 2n).toString(),
      minDeposit: "0",
      feeWaived: true,
      paylinkFunded: true,
      paylinkId: "id:paylink-frag",
    }
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

  it("selects the link's registration rather than a newer unrelated record", async () => {
    const store = PendingRegistrationStore.get(webStorage)
    await store.upsert(ACCOUNT, {}, record({ startTime: Date.now() - 60000 }))
    terms()
    await store.upsert(
      "0x00000000000000000000000000000000000000bb",
      {},
      record({ tag: "bob", l2Address: `0x${"ef".repeat(32)}` }),
    )
    expect(ticketSignupCommitted("paylink-frag")).toBe(true)
    expect(ticketSignupRegistration("paylink-frag", L2_ADDRESS)?.account).toBe(ACCOUNT)
    expect(ticketSignupRegistration("paylink-frag", `0x${"ef".repeat(32)}`)).toBeNull()
    await store.close(ACCOUNT, "confirmed")
    expect(ticketSignupCommitted("paylink-frag")).toBe(false)
  })

  it("a signup is committed once its registration's terms name the link", async () => {
    expect(ticketSignupCommitted("paylink-frag")).toBe(false)
    await PendingRegistrationStore.get(webStorage).upsert(ACCOUNT, {}, record())
    terms()
    expect(ticketSignupCommitted("paylink-frag")).toBe(true)
    expect(ticketSignupCommitted("link-b")).toBe(false)
  })
})

describe("ticketActivation", () => {
  const SIPA = "0x00000000000000000000000000000000000000c3"
  const full = (over: Partial<PendingRegistrationRecord> = {}) =>
    ({ account: ACCOUNT, ...record(over) } as PendingRegistrationRecord)

  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

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
    // A failed burn is not on its way; custody stamps are.
    const failed = [{ recipient: SIPA, phase: "failed" }]
    expect(ticketActivation(full(), loadRegistrationTerms(ACCOUNT, "taga"), failed)?.state).toBe(
      "ready",
    )
    expect(
      ticketActivation(full({ fundedAt: 1 }), loadRegistrationTerms(ACCOUNT, "taga"), []),
    ).toEqual({ state: "submitted" })
    expect(
      ticketActivation(full({ sweptAt: 1 }), loadRegistrationTerms(ACCOUNT, "taga"), []),
    ).toEqual({ state: "submitted" })
  })

  it("is ready only with the bound link on this tab, live fundable terms and a published address", () => {
    terms()
    stash()
    const ready = ticketActivation(full(), loadRegistrationTerms(ACCOUNT, "taga"), [])
    expect(ready).toMatchObject({ state: "ready", schedule: { fee: ONE / 2n, min: 0n } })
    expect(ready?.state === "ready" && ready.stash.fragment).toBe("paylink-frag")

    expect(
      ticketActivation(full({ broadcast: false }), loadRegistrationTerms(ACCOUNT, "taga"), []),
    ).toMatchObject({ state: "unpublished" })

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
    // Missing inputs change the action, not the funding: none of these is an external deposit.
    for (const activation of [
      ticketActivation(full(), loadRegistrationTerms(ACCOUNT, "taga"), []),
      ticketActivation(full({ broadcast: false }), loadRegistrationTerms(ACCOUNT, "taga"), []),
    ]) {
      expect(activation).not.toBeNull()
    }
  })
})
