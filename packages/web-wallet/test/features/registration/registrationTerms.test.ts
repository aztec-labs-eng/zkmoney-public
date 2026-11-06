/** The terms a registration's record carries, and the writes that change them. */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { seedDeviceKeys, testPage, testCore } from "../../support/page"
import type { PendingRegistrationRecord, RegistrationTerms } from "@obsidion/front-core"
import { activeNamespace, closeSession, session, switchSession } from "../../../src/session/session"
import { pageSessionDeps } from "../../../src/app/sessionDeps"
import {
  commitRegistrationProverTip,
  loadRegistrationTerms,
  registrationOffer,
  rememberReissuedClaim,
} from "../../../src/features/registration/registrationTerms"
import { releaseLinkDeposit } from "../../../src/features/paylink/ticketContinuation"
import { testWalletDbs } from "../../support/fakeWalletDb"
import {
  ACCOUNT,
  SIPA,
  earnedTerms,
  pendingRecord,
  seedRegistration,
  storedRegistration,
} from "../../support/registrationFixtures"

const OTHER_SIPA = "0x00000000000000000000000000000000000000c9"

beforeEach(async () => {
  await seedDeviceKeys({ storageId: "a1" })
  await switchSession(activeNamespace(testCore().device), pageSessionDeps(testPage())).registrations
    .ready
})
afterEach(closeSession)

/** Seeds a record with `terms`, and reads back what the store holds after `write`. */
async function after(
  terms: RegistrationTerms,
  write: (record: PendingRegistrationRecord) => unknown,
  over: Partial<PendingRegistrationRecord> = {},
) {
  const record = pendingRecord({ fee: "1", terms, ...over })
  await seedRegistration(record)
  await write(record)
  // The terms writes commit on their own; the next read follows the last one.
  await new Promise((r) => setTimeout(r, 0))
  return (await storedRegistration(SIPA))?.terms
}

describe("a re-issued claim against the stored quote", () => {
  const stored = { deadline: 100, fee: "1", minDeposit: "10", feeWaived: true, proverTip: "7" }

  it("replaces the schedule when the claim prices the committed fee", async () => {
    const claim = {
      hold: { deadline: "500" },
      terms: earnedTerms({ fee: "1", minDeposit: "9", reduced: false }),
    }
    expect(
      await after(stored, (r) => rememberReissuedClaim(session().registrations, r, claim)),
    ).toEqual({
      ...stored,
      deadline: 500,
      minDeposit: "9",
      feeWaived: false,
    })
  })

  it("refreshes only the deadline when the claim carries no schedule", async () => {
    // Silence is not evidence the signed schedule was wrong.
    expect(
      await after(stored, (r) =>
        rememberReissuedClaim(session().registrations, r, { hold: { deadline: "500" } }),
      ),
    ).toEqual({
      ...stored,
      deadline: 500,
    })
  })

  it("keeps the stored quote when the claim prices another fee", async () => {
    const claim = { hold: { deadline: "500" }, terms: earnedTerms({ fee: "2" }) }
    expect(
      await after(stored, (r) => rememberReissuedClaim(session().registrations, r, claim)),
    ).toEqual(stored)
  })

  it("keeps the campaign expectation through a renewal", async () => {
    const claim = { hold: { deadline: "500" }, terms: earnedTerms({ fee: "1", reduced: false }) }
    expect(
      await after({ deadline: 0, earnedExpected: true }, (r) =>
        rememberReissuedClaim(session().registrations, r, claim),
      ),
    ).toMatchObject({ earnedExpected: true, deadline: 500 })
  })
})

describe("a link-funded registration's binding", () => {
  const bound = {
    deadline: 1_000,
    fee: "1",
    minDeposit: "0",
    feeWaived: true,
    paylinkFunded: true,
    paylinkId: "id:link",
  }

  it("blocks on a renewal the link cannot pay, holds through one with no schedule, lifts on a ticket", async () => {
    const record = pendingRecord({ fee: "1", terms: bound })
    await seedRegistration(record)
    const read = async () => (await storedRegistration(SIPA))!
    const settle = () => new Promise((r) => setTimeout(r, 0))
    const refused = rememberReissuedClaim(session().registrations, record, {
      hold: { deadline: "1300" },
      terms: earnedTerms({ fee: "1", minDeposit: "0" }),
    })
    await settle()
    expect(refused.ticketRefused).toBe(true)
    expect(registrationOffer((await read()).terms)).toMatchObject({
      funding: "paylink",
      blocked: true,
    })
    expect(
      rememberReissuedClaim(session().registrations, await read(), { hold: { deadline: "1400" } })
        .ticketRefused,
    ).toBe(false)
    await settle()
    expect((await read()).terms).toMatchObject({ deadline: 1400, paylinkBlocked: true })
    const renewed = rememberReissuedClaim(session().registrations, await read(), {
      hold: { deadline: "1500" },
      terms: earnedTerms({ fee: "1", minDeposit: "0", ticket: true }),
    })
    await settle()
    expect(renewed.ticketRefused).toBe(false)
    expect((await read()).terms?.paylinkBlocked).toBe(false)
    expect(registrationOffer((await read()).terms)).toMatchObject({
      funding: "paylink",
      blocked: false,
    })
  })

  it("blocks on a renewal pricing another fee, keeping the stored quote", async () => {
    const claim = { hold: { deadline: "1300" }, terms: earnedTerms({ fee: "2", ticket: true }) }
    expect(
      await after(bound, (r) => rememberReissuedClaim(session().registrations, r, claim)),
    ).toEqual({
      ...bound,
      paylinkBlocked: true,
    })
  })

  it("drops every field that binds a deposit link on its release", async () => {
    const terms = { deadline: 1_000, fee: "1", minDeposit: "0" }
    const linked = {
      ...terms,
      paylinkFunded: true,
      paylinkDeposit: true,
      paylinkId: "id:link",
      paylinkAmount: "9",
      paylinkSender: "bob",
      paylinkBlocked: true,
      proverTip: "3",
      speed: "faster" as const,
    }
    expect(await after(linked, (r) => releaseLinkDeposit(r))).toEqual(terms)
  })

  it("owes a settled tag's broadcast when its deposit link is released", async () => {
    const linked = { deadline: 1, paylinkFunded: true, paylinkDeposit: true, paylinkId: "id:link" }
    await after(linked, (r) => releaseLinkDeposit(r), { broadcast: false, tagConfirmed: true })
    expect((await session().sipaDeposits.get(SIPA))?.broadcast).toMatchObject({
      kind: "registration",
      state: "queued",
    })
  })
})

describe("the terms actions", () => {
  it("commit a review's tip and speed", async () => {
    const terms = { deadline: 1 }
    expect(
      await after(terms, (r) =>
        commitRegistrationProverTip(session().registrations, r, 4n, "faster"),
      ),
    ).toEqual({
      deadline: 1,
      proverTip: "4",
      speed: "faster",
    })
  })

  it("resolve a tip's commit once it is saved, and reject when the save fails", async () => {
    const { registrations } = session()
    const record = pendingRecord({ terms: { deadline: 1 } })
    await seedRegistration(record)
    await commitRegistrationProverTip(registrations, record, 4n, "faster")
    expect(loadRegistrationTerms(registrations, ACCOUNT)).toMatchObject({ proverTip: "4" })
    testWalletDbs().onApply = () => {
      throw new Error("disk full")
    }
    await expect(commitRegistrationProverTip(registrations, record, 5n, "faster")).rejects.toThrow()
    testWalletDbs().onApply = undefined
  })

  it("are read by both halves of what the quote priced, never by the account alone", async () => {
    await seedRegistration(pendingRecord({ tag: "taga", terms: { deadline: 1 } }))
    await seedRegistration(
      pendingRecord({ tag: "tagb", sipaAddress: OTHER_SIPA, startTime: 1, terms: { deadline: 2 } }),
    )
    expect(loadRegistrationTerms(session().registrations, ACCOUNT, "taga")).toEqual({ deadline: 1 })
    expect(loadRegistrationTerms(session().registrations, ACCOUNT, "tagb")).toEqual({ deadline: 2 })
    expect(loadRegistrationTerms(session().registrations, undefined, "taga")).toBeNull()
  })
})
