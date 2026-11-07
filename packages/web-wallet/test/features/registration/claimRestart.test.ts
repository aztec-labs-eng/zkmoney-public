// A claim that restarts a refunded registration, or replaces one nothing reached, at the earned price.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { formatUnits } from "viem"
import {
  broadcastJob,
  canManualRegistrationSweep,
  composeWireNameHash,
  loadRecords,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"
import { claimWith, type ClaimRequest } from "../../../src/features/onboarding/oxideOnboarding"
import { hasDepositAdmission } from "../../../src/features/registration/admission"
import { loadRegistrationTerms } from "../../../src/features/registration/registrationTerms"
import { registrationRecordForSipa } from "../../../src/features/registration/webRegistration"
import { setIdentity } from "../../support/identity"
import { closeSession, session, type Session } from "../../../src/session/session"
import { openTestSession } from "../../support/session"
import { seedDeviceKeys } from "../../support/page"
import { DAI, accountRecords, earnedTerms, nameClaim } from "../../support/registrationFixtures"
import { PAID, PAID_ASK, RANDOM } from "../../support/registrationPrices"
import {
  forceSipaDeposit,
  holdAtSipa,
  seedSipaDeposit,
  viewedSipaDeposit,
} from "../../support/sipaDeposits"
import {
  DERIVATION,
  ENV,
  HASH,
  L2,
  NEW,
  OLD,
  OWNER,
  TOKEN,
  claimHarness,
  keys,
  transfer,
} from "../../support/claimHarness"

/** The old paid registration's deposit, refunded before the restart. */
const REFUND = PAID_ASK
const old: PendingRegistrationRecord = {
  account: OWNER,
  tag: "demo",
  nameHash: HASH,
  l2Address: L2,
  l1ChainId: 11155111,
  sipaAddress: OLD,
  fee: String(PAID.fee),
  beneficiary: OWNER,
  depositToken: TOKEN,
  broadcast: true,
  phase: "awaiting_deposit",
  retries: 3,
  startTime: 1,
}
/** The random-tag claim the restart is quoted. */
const randomClaim = () =>
  nameClaim({
    signature: "0xaa",
    terms: earnedTerms({ fee: String(RANDOM.fee), minDeposit: String(RANDOM.min) }),
  })

let own: Session
let harness: ReturnType<typeof claimHarness>
const claim = (over: Partial<ClaimRequest> = {}) =>
  claimWith(harness.deps, { handle: "demo", keys, requireEarnedQuote: true, ticket: null, ...over })
/** Restarts the registration from `refunded`, the address whose deposit was recovered. */
const restart = (refunded = accountRecords.get(OWNER)!) => claim({ refundedRecord: refunded })
/** Replaces `unfunded`, an address nothing reached, with one at the earned price. */
const replace = (unfunded = accountRecords.get(OWNER)!) => claim({ replacedRecord: unfunded })
const current = () => accountRecords.get(OWNER)!
const pending = async (outcome: Promise<{ kind: string }>) =>
  expect(outcome).resolves.toMatchObject({ kind: "pending" })
/** A sign-in on this account: its pending identity saved again. */
const signInPending = (claimedAt: number) =>
  setIdentity({ address: L2, handle: "demo", pending: true, claimedAt })

beforeEach(async () => {
  localStorage.clear()
  await seedDeviceKeys({ storageId: "a1" })
  own = openTestSession()
  await own.registrations.ready
  harness = claimHarness(own)
  await accountRecords.upsert(OWNER, {}, old)
  await seedSipaDeposit({
    sipaAddress: OLD,
    phase: "recovered",
    networkId: "0xnet",
    recipientL2Address: L2,
    tokenAddress: TOKEN,
    tokenSymbol: "DAI",
    l1ChainId: 11155111,
    messageSecret: HASH,
    recoveryAddress: OWNER,
    recipientHash: HASH,
    amount: formatUnits(REFUND, 18),
    recoveryTxHash: HASH,
    startTime: 1,
  })
  await loadRecords(own.sipaDeposits.view)
  await signInPending(1)
  await holdAtSipa(OLD, REFUND)
  harness.h.sign.mockResolvedValue(randomClaim())
  harness.h.receipt.mockResolvedValue(transfer(REFUND))
})
afterEach(closeSession)

describe("a restart from a refund", () => {
  it("replaces the refunded commitment with the earned terms, the spent broadcast inherited", async () => {
    await pending(restart())
    const replacement = current()
    expect(replacement).toMatchObject({
      sipaAddress: NEW,
      fee: String(RANDOM.fee),
      phase: "awaiting_deposit",
      broadcast: false,
      refundedEntry: { sipaAddress: OLD, recoveryTxHash: HASH, amount: String(REFUND) },
      replaced: { sipaAddress: OLD, refunded: true, broadcastSpent: true },
    })
    expect(hasDepositAdmission(session().sipaDeposits, replacement)).toBe(false)
    // A manual sweep needs the claim cached; the spent rail leaves no payload to send.
    expect((await own.nameClaims.get(L2))?.terms?.fee).toBe(String(RANDOM.fee))
    expect(harness.payloads.has(NEW.toLowerCase())).toBe(false)
  })

  it("keeps the verified refund on the replacement when the session dies after its checkpoint", async () => {
    harness.h.metadataRegistry.mockRejectedValueOnce(new Error("rpc down"))
    await expect(restart()).rejects.toThrow()
    expect(current()).toMatchObject({
      sipaAddress: NEW,
      refundedEntry: { sipaAddress: OLD, recoveryTxHash: HASH, amount: String(REFUND) },
    })
    await signInPending(2)
    // The record no longer names the refunded address, so the plain earned claim resumes it.
    await pending(claim())
    expect(current()).toMatchObject({ sipaAddress: NEW, refundedEntry: { sipaAddress: OLD } })
  })

  it("restarts on a refund below the earned total without buying wallet entry", async () => {
    harness.h.receipt.mockResolvedValue(transfer(RANDOM.fee))
    await pending(restart())
    expect(current()).toMatchObject({ sipaAddress: NEW, fee: String(RANDOM.fee) })
    expect(current().refundedEntry).toBeUndefined()
  })

  it("carries the entry a funded registration's refund bought from the activity list", async () => {
    await accountRecords.upsert(OWNER, { phase: "funded", fundedAt: 5, fundingTxHash: HASH })
    // The rest of the 15 DAI landed after the balance read; the receipt says what moved.
    harness.h.receipt.mockResolvedValue(transfer(15n * DAI))
    await harness.recovery.confirmed(OLD, TOKEN, HASH, (hash) => harness.h.receipt({ hash }))
    expect(current()).toMatchObject({ sipaAddress: OLD, phase: "awaiting_deposit" })
    await pending(restart())
    expect(current()).toMatchObject({
      sipaAddress: NEW,
      refundedEntry: { sipaAddress: OLD, amount: String(15n * DAI) },
    })
  })

  it("keeps the old record while the receipt that bought entry is unread", async () => {
    const down = new Error("rpc down")
    harness.h.receipt.mockRejectedValueOnce(down).mockRejectedValueOnce(down)
    await expect(restart()).rejects.toThrow()
    expect(current().sipaAddress).toBe(OLD)
    await pending(restart())
    expect(current().sipaAddress).toBe(NEW)
  })

  it.each<[string, () => void, string?]>([
    [
      "while funds remain at the address",
      () => {
        harness.h.balance.mockResolvedValue(REFUND)
      },
    ],
    [
      "on a quote at the standard price",
      () => {
        const terms = { fee: String(PAID.fee), minDeposit: String(PAID.min), reduced: false }
        harness.h.sign.mockResolvedValue(nameClaim({ terms: earnedTerms(terms) }))
      },
    ],
    ["for another wallet's tag", () => undefined, "other"],
  ])("keeps the old record %s", async (_, arrange, handle = "demo") => {
    arrange()
    await expect(claim({ handle, refundedRecord: current() })).rejects.toThrow()
    expect(current().sipaAddress).toBe(OLD)
    expect(harness.payloads.size).toBe(0)
  })

  it("re-enters the refunded record when the corrected quote only lowered the minimum", async () => {
    // A legacy earned quote over a higher minimum, refunded: the fee, and so the address, stay.
    await accountRecords.upsert(OWNER, {
      fee: String(RANDOM.fee),
      nameHash: composeWireNameHash("demo", ENV.ensDomain),
      terms: {
        deadline: 1,
        fee: String(RANDOM.fee),
        minDeposit: String(5n * DAI),
        feeWaived: true,
        earnedExpected: true,
      },
    })
    harness.h.derive.mockResolvedValue({ ...DERIVATION, sipaAddress: OLD })
    await holdAtSipa(OLD, 5n * DAI)
    expect(hasDepositAdmission(session().sipaDeposits, current())).toBe(true)
    await pending(restart())
    expect(current()).toMatchObject({
      sipaAddress: OLD,
      fee: String(RANDOM.fee),
      phase: "awaiting_deposit",
      refundedEntry: { sipaAddress: OLD, amount: String(REFUND) },
    })
    expect(current().replaced).toBeUndefined()
    expect(loadRegistrationTerms(session().registrations, OWNER, "demo")).toMatchObject({
      fee: String(RANDOM.fee),
      minDeposit: String(RANDOM.min),
      feeWaived: true,
      earnedExpected: true,
    })
    // The rail starts the address over: the old recovery is evidence, not the new deposit's state.
    expect(viewedSipaDeposit(OLD)).toMatchObject({ phase: "broadcast", amount: "0" })
    expect(viewedSipaDeposit(OLD)?.recoveryTxHash).toBeUndefined()
    // Once the rail reads it empty, the resumed registration asks again.
    await holdAtSipa(OLD, 0n)
    expect(hasDepositAdmission(session().sipaDeposits, current())).toBe(false)
  })

  it("leaves the broadcast to the relayer rail when the refunded address never used it", async () => {
    await accountRecords.upsert(OWNER, { broadcast: false })
    await pending(restart())
    // The sheet that shows the new address owes it, on the payload the session kept.
    expect(broadcastJob(own.sipaDeposits.view.get().records, NEW)).toBeUndefined()
    expect(harness.payloads.has(NEW.toLowerCase())).toBe(true)
    expect(harness.payloads.has(OLD.toLowerCase())).toBe(false)
    expect(current().replaced).toEqual({ sipaAddress: OLD, refunded: true, broadcastSpent: false })
  })
})

describe("a replacement of an address nothing reached", () => {
  beforeEach(async () => {
    await forceSipaDeposit(OLD, { phase: "broadcast", recoveryTxHash: undefined })
    await holdAtSipa(OLD, 0n)
  })

  it("closes the old record as replaced, recoverable but never swept", async () => {
    await pending(replace())
    expect(current()).toMatchObject({ sipaAddress: NEW, fee: String(RANDOM.fee) })
    expect(current().refundedEntry).toBeUndefined()
    // The old address was broadcast: the rail's one use is gone, so only a manual sweep finishes.
    expect(current().replaced).toEqual({ sipaAddress: OLD, refunded: false, broadcastSpent: true })
    const archived = registrationRecordForSipa(session().registrations, OLD)!
    expect(archived).toMatchObject({ fee: String(PAID.fee), phase: "replaced" })
    expect(canManualRegistrationSweep(archived)).toBe(false)
    expect((await own.nameClaims.get(L2))?.terms?.fee).toBe(String(RANDOM.fee))
  })

  it("inherits a spent broadcast through a chain of replacements", async () => {
    const spent = { sipaAddress: TOKEN, refunded: false, broadcastSpent: true }
    await accountRecords.upsert(OWNER, { broadcast: false, replaced: spent })
    await pending(replace())
    expect(current().replaced).toEqual({ ...spent, sipaAddress: OLD })
  })

  it("aborts and keeps the old record when a deposit reaches it during the quote fetch", async () => {
    // Empty when the screen checked, funded by the time the checkpoint would overwrite it.
    harness.h.balance.mockResolvedValue(REFUND)
    await expect(replace()).rejects.toThrow()
    expect(current().sipaAddress).toBe(OLD)
  })
})

it("stamps no waiver for a claim that signed no schedule", async () => {
  const unpriced = nameClaim()
  harness.h.sign.mockResolvedValue(unpriced)
  await pending(claim({ requireEarnedQuote: false }))
  const terms = loadRegistrationTerms(session().registrations, OWNER, "demo")
  expect(terms?.deadline).toBe(Number(unpriced.deadline))
  // Absent is "no schedule named a kind", which is not the same as the standard one.
  expect(terms && "feeWaived" in terms).toBe(false)
})
