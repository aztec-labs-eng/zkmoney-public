// @vitest-environment node
// A claim a payment link funds: its ticket redeems after the preflight, and its link binds to the
// checkpoint. The link codec's byte checks need one realm, which jsdom splits.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { goldenTicketBurn } from "@obsidion/front-core"
import {
  NameTakenError,
  claimWith,
  type ClaimRequest,
} from "../../../src/features/onboarding/oxideOnboarding"
import { stashClaimLink } from "../../../src/features/paylink/claimStash"
import { tabStash } from "../../../src/platform/storage/tabStash"
import { linkIdentity } from "../../../src/features/paylink/linkIdentity"
import {
  ticketSignupContinuation,
  ticketSignupRegistration,
} from "../../../src/features/paylink/ticketContinuation"
import { loadRegistrationTerms } from "../../../src/features/registration/registrationTerms"
import { closeSession } from "../../../src/session/session"
import { openTestSession } from "../../support/session"
import { seedDeviceKeys } from "../../support/page"
import { DAI, accountRecords, earnedTerms, nameClaim } from "../../support/registrationFixtures"
import { PAID, RANDOM } from "../../support/registrationPrices"
import { HASH, L2, NEW, OWNER, claimHarness, keys } from "../../support/claimHarness"
import { PAYLINK_FRAGMENT } from "../../fixtures/scanPayloads"

const tab = new Map<string, string>()
vi.stubGlobal("sessionStorage", {
  getItem: (key: string) => tab.get(key) ?? null,
  setItem: (key: string, value: string) => void tab.set(key, value),
  removeItem: (key: string) => void tab.delete(key),
})

let harness: ReturnType<typeof claimHarness>
const claim = (over: Partial<ClaimRequest> = {}) =>
  claimWith(harness.deps, { handle: "demo", keys, ticket: null, ...over })
/** The tab dies right after the checkpoint: the consent read that follows it never answers. */
const closeTabAfterCheckpoint = () =>
  harness.h.metadataRegistry.mockRejectedValueOnce(new Error("tab closed after the checkpoint"))

beforeEach(async () => {
  tab.clear()
  await seedDeviceKeys({ storageId: "a1" })
  const session = openTestSession()
  await session.registrations.ready
  harness = claimHarness(session)
  harness.h.sign.mockResolvedValue(
    nameClaim({ terms: earnedTerms({ fee: String(PAID.fee), minDeposit: String(PAID.min) }) }),
  )
})
afterEach(closeSession)

describe("ticket redemption after the registration preflight", () => {
  const ticket = {
    fragment: PAYLINK_FRAGMENT,
    schedule: { fee: String(DAI / 2n), minDeposit: "0" },
  }
  const register = () => claim({ ticket })
  const nothingSpent = () => {
    expect(harness.h.redeem).not.toHaveBeenCalled()
    expect(harness.h.sign).not.toHaveBeenCalled()
  }

  it("spends nothing when the account already owns another tag", async () => {
    harness.h.heldName.mockResolvedValue(HASH)
    await expect(register()).rejects.toThrow()
    nothingSpent()
    expect(harness.h.derive).not.toHaveBeenCalled()
  })

  it("spends nothing when the tag belongs to another account", async () => {
    harness.h.registeredOwner.mockResolvedValue(NEW)
    await expect(register()).rejects.toBeInstanceOf(NameTakenError)
    nothingSpent()
  })

  it("redeems nothing again when this account already registered the tag", async () => {
    harness.h.registeredOwner.mockResolvedValue(OWNER)
    await expect(register()).resolves.toMatchObject({ kind: "custody", confirmed: true })
    nothingSpent()
  })

  it("asks for no paid terms when the redemption fails", async () => {
    harness.h.redeem.mockRejectedValueOnce(new Error("ticket_spent"))
    await expect(register()).rejects.toThrow()
    expect(harness.h.sign).not.toHaveBeenCalled()
    expect(harness.h.derive).not.toHaveBeenCalled()
  })

  it("reports a paused ticket, so the wizard can explain the paid quote", async () => {
    harness.h.redeem.mockResolvedValue("unavailable")
    await expect(register()).resolves.toMatchObject({ kind: "pending", ticketUnavailable: true })
    expect(harness.h.sign).toHaveBeenCalledTimes(1)
  })

  it("keeps the link on the checkpoint, so a reopen resumes without another proof or claim", async () => {
    const session = openTestSession()
    harness.h.redeem.mockResolvedValue("redeemed")
    harness.h.sign.mockResolvedValue(nameClaim({ terms: earnedTerms({ ticket: true }) }))
    closeTabAfterCheckpoint()
    await expect(register()).rejects.toThrow()
    expect(harness.h.redeem).toHaveBeenCalledTimes(1)
    expect(accountRecords.get(OWNER)).toMatchObject({ sipaAddress: NEW, phase: "awaiting_deposit" })
    expect(loadRegistrationTerms(session.registrations, OWNER, "demo")).toMatchObject({
      feeWaived: true,
      paylinkFunded: true,
      paylinkId: linkIdentity(PAYLINK_FRAGMENT),
    })
    // What the reopened wizard resumes by, pinned to the account the ticket bound.
    expect(ticketSignupRegistration(session, PAYLINK_FRAGMENT, L2)?.account).toBe(OWNER)
    expect(ticketSignupRegistration(session, PAYLINK_FRAGMENT, `0x${"99".repeat(32)}`)).toBeNull()
  })

  it("binds no link to a checkpoint whose quote does not honour the ticket", async () => {
    const session = openTestSession()
    harness.h.redeem.mockResolvedValue("unavailable")
    closeTabAfterCheckpoint()
    await expect(register()).rejects.toThrow()
    expect(accountRecords.get(OWNER)).toMatchObject({ sipaAddress: NEW })
    expect(loadRegistrationTerms(session.registrations, OWNER, "demo")).not.toHaveProperty(
      "paylinkId",
    )
    expect(ticketSignupRegistration(session, PAYLINK_FRAGMENT, L2)).toBeNull()
  })
})

describe("a link with no ticket for this signup, which pays the name's own deposit", () => {
  beforeEach(() => {
    stashClaimLink(tabStash, PAYLINK_FRAGMENT)
    harness.h.sign.mockResolvedValue(
      nameClaim({
        terms: earnedTerms({ fee: String(RANDOM.fee), minDeposit: String(RANDOM.min) }),
      }),
    )
  })
  /** A random tag's claim with the link's note and committed tip handed in. */
  const register = (amount: bigint, proverTip = 0n) =>
    claim({
      requireEarnedQuote: true,
      linkDeposit: { fragment: PAYLINK_FRAGMENT, amount, proverTip, speed: "faster" },
    })
  /** What the claim burns for the random tag's signed deposit at a zero executor fee. */
  const burn = (proverTip: bigint) => goldenTicketBurn(RANDOM, proverTip, 0n).burn

  it("binds the registration to the link, with its tip, when the note covers the signed deposit", async () => {
    const session = openTestSession()
    const outcome = await register(20n * DAI, DAI / 10n)
    expect(outcome).toMatchObject({ kind: "pending", depositLink: { fragment: PAYLINK_FRAGMENT } })
    expect(loadRegistrationTerms(session.registrations, OWNER, "demo")).toMatchObject({
      paylinkFunded: true,
      paylinkDeposit: true,
      paylinkId: linkIdentity(PAYLINK_FRAGMENT),
      proverTip: String(DAI / 10n),
      speed: "faster",
    })
    // Home's claim of the link pays the registration.
    expect(ticketSignupContinuation(session, PAYLINK_FRAGMENT, L2, [])?.activation.state).toBe(
      "ready",
    )
  })

  it.each([
    ["covers the deposit but not the tip", () => register(burn(DAI / 10n), DAI / 10n)],
    [
      "is priced while the executor fee is unread",
      () => {
        harness.h.withdrawalFee.mockRejectedValue(new Error("rpc down"))
        return register(20n * DAI)
      },
    ],
  ])("leaves the registration on its own deposit when the note %s", async (_, run) => {
    const session = openTestSession()
    const outcome = await run()
    expect(outcome).toMatchObject({ kind: "pending" })
    expect(outcome).not.toHaveProperty("depositLink")
    expect(loadRegistrationTerms(session.registrations, OWNER, "demo")).not.toHaveProperty(
      "paylinkId",
    )
    expect(ticketSignupContinuation(session, PAYLINK_FRAGMENT, L2, [])).toBeNull()
  })
})
