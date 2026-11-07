// @vitest-environment node
/** The detection tick, the broadcast rebuild and the late broadcast, over a real store. */

import { describe, expect, it, vi } from "vitest"
import { type Address, type Hex } from "viem"

import { AccountServiceError } from "../../src/oxide/accountServiceClient"
import {
  rebuildRegistrationBroadcast,
  resumeOxideRegistration,
  startOxideRegistrationSession,
} from "../../src/oxide/oxideRegistration"
import {
  DERIVATION,
  FACTORY,
  NO_NAME,
  OTHER_SIPA,
  OWNER,
  RECORD,
  REGISTRY,
  SIPA,
  recordAt,
  registrationStore,
  resumeDeps,
  sessionDeps,
  signDeps,
} from "./oxideRegistrationFakes"

const MOVED = "0x00000000000000000000000000000000000000b9" as Address

describe("resumeOxideRegistration", () => {
  it("resumes the selected registration even when another record is newer and open", async () => {
    const bob = recordAt({
      account: FACTORY,
      tag: "bob",
      nameHash: NO_NAME,
      sipaAddress: OTHER_SIPA,
      startTime: 5,
    })
    const { deps, at, l1 } = resumeDeps({}, {}, [bob])
    l1.readUserAddress.mockResolvedValue(OWNER)
    const resume = await resumeOxideRegistration(deps, {
      expectedRecord: { account: OWNER, nameHash: RECORD.nameHash },
    })
    expect(resume.outcome).toBe("confirmed")
    expect((await at(SIPA))?.phase).toBe("confirmed")
    expect((await at(OTHER_SIPA))?.phase).toBe("awaiting_deposit")
    expect(l1.readUserAddress).toHaveBeenCalledWith(REGISTRY, RECORD.nameHash)
  })

  it.each([
    ["the selected account has no record", { account: FACTORY, nameHash: RECORD.nameHash }],
    ["the selected record's name changed while queued", { account: OWNER, nameHash: NO_NAME }],
  ])("stays pending, reading nothing, when %s", async (_, expectedRecord) => {
    const { deps, at, l1 } = resumeDeps({})
    expect((await resumeOxideRegistration(deps, { expectedRecord })).outcome).toBe("pending")
    expect(l1.readUserAddress).not.toHaveBeenCalled()
    expect((await at(SIPA))?.phase).toBe("awaiting_deposit")
  })

  it("leaves a terminal selected record closed", async () => {
    const { deps, at, l1 } = resumeDeps({ phase: "failed_terminal", endTime: 1 })
    const resume = await resumeOxideRegistration(deps, {
      expectedRecord: { account: OWNER, nameHash: RECORD.nameHash },
    })
    expect(resume.outcome).toBe("idle")
    expect(l1.readUserAddress).not.toHaveBeenCalled()
    expect((await at(SIPA))?.phase).toBe("failed_terminal")
  })

  it.each([
    ["confirmed", OWNER, "confirmed"],
    ["taken", "0x00000000000000000000000000000000000000ff", "failed_taken"],
  ])("closes the record %s through the page's close", async (outcome, owner, phase) => {
    const close = vi.fn()
    const { deps, l1 } = resumeDeps({}, { close })
    l1.readUserAddress.mockResolvedValue(owner as Address)
    expect((await resumeOxideRegistration(deps)).outcome).toBe(outcome)
    expect(close).toHaveBeenCalledWith(
      expect.objectContaining({ sipaAddress: SIPA }),
      expect.objectContaining({ type: "closed" }),
    )
    const real = resumeDeps({})
    real.l1.readUserAddress.mockResolvedValue(owner as Address)
    await resumeOxideRegistration(real.deps)
    expect((await real.at(SIPA))?.phase).toBe(phase)
  })

  it("closes for recovery under the name the account holds, marking the notice", async () => {
    const held = `0x${"99".repeat(32)}` as Hex
    const { deps, at, l1 } = resumeDeps({})
    l1.readNameOf.mockResolvedValue(held)
    expect((await resumeOxideRegistration(deps)).outcome).toBe("needs_recovery")
    expect(await at(SIPA)).toMatchObject({
      phase: "confirmed",
      nameHash: held,
      notice: { recovery: true },
    })
  })

  it("marks the record funded when a deposit at/above the floor lands", async () => {
    const { deps, at, deposits } = resumeDeps({})
    deposits.readBalance.mockResolvedValue(50n)
    deposits.readFunding.mockResolvedValue([{ amount: 50n, txHash: `0x${"ee".repeat(32)}` }])
    expect((await resumeOxideRegistration(deps)).outcome).toBe("pending")
    expect(await at(SIPA)).toMatchObject({
      phase: "funded",
      fundedAt: expect.any(Number),
      fundingTxHash: `0x${"ee".repeat(32)}`,
    })
  })

  it.each([undefined, 1_000])(
    "marks a record swept before any tick saw its funds as funded, keeping an earlier stamp (%s)",
    async (fundedAt) => {
      const SWEEP = `0x${"5e".repeat(32)}` as const
      const { deps, at, deposits } = resumeDeps({
        fundedAt,
        ...(fundedAt ? { phase: "funded" } : {}),
      })
      deposits.readSweeps.mockResolvedValue([{ txHash: SWEEP }])
      const swept: [string, string][] = []
      ;(deps as { sweepSent: unknown }).sweepSent = async (sipa: string, txHash: string) =>
        void swept.push([sipa, txHash])
      expect(await resumeOxideRegistration(deps)).toEqual({ outcome: "pending", nextMs: 5_000 })
      expect(swept).toEqual([[SIPA, SWEEP]])
      const record = await at(SIPA)
      expect(record).toMatchObject({
        phase: "funded",
        sweptAt: expect.any(Number),
        sweepTxHash: SWEEP,
      })
      if (fundedAt) expect(record?.fundedAt).toBe(fundedAt)
      else expect(record?.fundedAt).toBe(record?.sweptAt)
    },
  )

  it("reads funding off the balance, not the sum of transfers a refund left behind", async () => {
    const { deps, at, deposits } = resumeDeps({})
    // 13 in, refunded, 2 in: the transfers still sum past the floor of 10.
    deposits.readFunding.mockResolvedValue([
      { amount: 13n, txHash: `0x${"ee".repeat(32)}` },
      { amount: 2n, txHash: `0x${"ef".repeat(32)}` },
    ])
    deposits.readBalance.mockResolvedValue(2n)
    expect((await resumeOxideRegistration(deps)).outcome).toBe("pending")
    expect(await at(SIPA)).toMatchObject({ phase: "awaiting_deposit" })
    expect(await at(SIPA)).not.toHaveProperty("fundedAt")
  })

  it.each(["readBalance", "floor"] as const)(
    "decides nothing about funding when %s rejects, and asks for the transient window",
    async (read) => {
      const { deps, at, deposits } = resumeDeps({})
      deposits.readBalance.mockResolvedValue(50n)
      deposits[read].mockRejectedValue(new Error("rpc"))
      expect(await resumeOxideRegistration(deps)).toEqual({ outcome: "pending", nextMs: 30_000 })
      expect(await at(SIPA)).not.toHaveProperty("fundedAt")
    },
  )

  it("decides nothing about funding while the floor is unreadable, then decides on the next tick", async () => {
    const { deps, at, deposits } = resumeDeps({})
    deposits.readBalance.mockResolvedValue(50n)
    deposits.readFunding.mockResolvedValue([{ amount: 50n, txHash: `0x${"ee".repeat(32)}` }])
    deposits.floor.mockResolvedValueOnce(undefined)
    expect((await resumeOxideRegistration(deps)).outcome).toBe("pending")
    expect((await at(SIPA))?.phase).toBe("awaiting_deposit")
    await resumeOxideRegistration(deps)
    expect((await at(SIPA))?.phase).toBe("funded")
  })

  it("rejects when a tick's read fails, so the caller backs off", async () => {
    const { deps, l1 } = resumeDeps({})
    l1.readUserAddress.mockRejectedValue(new Error("rpc"))
    await expect(resumeOxideRegistration(deps)).rejects.toThrow()
  })

  it("never owes a broadcast on its own: the sheet that shows the address does", async () => {
    const oweBroadcast = vi.fn(async () => {})
    const { deps } = resumeDeps({ broadcast: false }, { oweBroadcast })
    expect((await resumeOxideRegistration(deps)).outcome).toBe("pending")
    expect(oweBroadcast).not.toHaveBeenCalled()
  })

  it("re-signs an unpublished record on a forced tick and owes the fresh payload at once", async () => {
    const session = sessionDeps()
    const out = await startOxideRegistrationSession(session.deps)
    if (out.status !== "awaiting_deposit") throw new Error("unreachable")
    const sign = signDeps()
    const oweBroadcast = vi.fn(async () => {})
    const { deps } = resumeDeps((await session.at(SIPA))!, {
      getSignDeps: vi.fn(async () => sign),
      oweBroadcast,
    })
    expect((await resumeOxideRegistration(deps, { force: true })).outcome).toBe("pending")
    expect(sign.accountService.signDomain).toHaveBeenCalledOnce()
    expect(oweBroadcast).toHaveBeenCalledWith(expect.objectContaining({ account: OWNER }), {
      payload: out.payload,
      now: true,
    })
  })

  it("owes the broadcast at once on a forced tick that brings no signer", async () => {
    const oweBroadcast = vi.fn(async () => {})
    const { deps } = resumeDeps({ broadcast: false }, { oweBroadcast })
    expect((await resumeOxideRegistration(deps, { force: true })).outcome).toBe("pending")
    expect(oweBroadcast).toHaveBeenCalledWith(expect.objectContaining({ account: OWNER }), {
      now: true,
    })
  })

  const spent = { sipaAddress: OTHER_SIPA, refunded: true, broadcastSpent: true }

  it("renews a spent-rail record's claim on a forced tick, publishing nothing", async () => {
    const sign = signDeps()
    const oweBroadcast = vi.fn(async () => {})
    const { deps, at } = resumeDeps(
      { broadcast: false, replaced: spent },
      { getSignDeps: vi.fn(async () => sign), oweBroadcast },
    )
    expect((await resumeOxideRegistration(deps, { force: true })).outcome).toBe("pending")
    expect(sign.accountService.signDomain).toHaveBeenCalledOnce()
    expect(oweBroadcast).not.toHaveBeenCalled()
    expect(await at(SIPA)).toMatchObject({ broadcast: false })
  })

  it("leaves a spent-rail record's claim alone on a forced tick that brings no signer", async () => {
    const { deps, at } = resumeDeps({ broadcast: false, replaced: spent })
    expect((await resumeOxideRegistration(deps, { force: true })).outcome).toBe("pending")
    expect(await at(SIPA)).toMatchObject({ retries: 0, broadcast: false })
  })
})

describe("rebuildRegistrationBroadcast", () => {
  it("rebuilds exactly the broadcast the session would have sent, counting the attempt", async () => {
    const session = sessionDeps()
    const out = await startOxideRegistrationSession(session.deps)
    if (out.status !== "awaiting_deposit") throw new Error("unreachable")
    const { deps, at, record } = resumeDeps((await session.at(SIPA))!)
    const result = await rebuildRegistrationBroadcast(deps, record, signDeps())
    expect(result).toEqual({ kind: "payload", payload: out.payload })
    expect((await at(SIPA))?.retries).toBe(1)
  })

  it.each([
    [
      "the claim budget ran out",
      { reason: "claim_attempts_exhausted" },
      429,
      "failed",
      "failed_terminal",
    ],
    ["the name was reserved", { reason: "name_reserved" }, 409, "taken", "failed_taken"],
  ])("closes the record when %s", async (_, body, status, outcome, phase) => {
    const { deps, at, record } = resumeDeps({ broadcast: false })
    const sign = signDeps(
      vi.fn(async () => Promise.reject(new AccountServiceError(status, "no", body))),
    )
    expect(await rebuildRegistrationBroadcast(deps, record, sign)).toEqual({
      kind: "closed",
      outcome,
    })
    expect((await at(SIPA))?.phase).toBe(phase)
  })

  it("waits, spending nothing, while another account is unlocked", async () => {
    const { deps, at, l1, record } = resumeDeps({ broadcast: false })
    l1.predictAccountAddress.mockResolvedValue(FACTORY)
    const sign = signDeps()
    expect((await rebuildRegistrationBroadcast(deps, record, sign)).kind).toBe("wait")
    expect(sign.accountService.signDomain).not.toHaveBeenCalled()
    expect((await at(SIPA))?.retries).toBe(0)
  })

  it("waits when the re-issued quote prices another fee than the address committed", async () => {
    const { deps, deposits, record } = resumeDeps({ broadcast: false })
    deposits.scheduleFee.mockResolvedValue(2n)
    expect((await rebuildRegistrationBroadcast(deps, record, signDeps())).kind).toBe("wait")
  })

  it("renews the claim of a spent-rail record and publishes nothing", async () => {
    const { deps, record } = resumeDeps({
      replaced: { sipaAddress: OTHER_SIPA, refunded: true, broadcastSpent: true },
    })
    const sign = signDeps()
    expect(await rebuildRegistrationBroadcast(deps, record, sign)).toEqual({ kind: "spent" })
    expect(sign.accountService.signDomain).toHaveBeenCalledOnce()
  })

  // A clean record whose derivation moved closes as replaced, and only once the chain confirms the
  // old address is empty. Every other hold keeps it open.
  it.each([
    ["its old address cannot be read", {}, () => Promise.reject(new Error("rpc"))],
    ["its old address holds funds", {}, async () => 3n],
    ["a deposit was seen at it", { fundedAt: 1, phase: "funded" as const }, async () => 0n],
    ["it was swept", { sweptAt: 1, phase: "funded" as const }, async () => 0n],
    ["its funding was stamped", { fundingTxHash: `0x${"ee".repeat(32)}` as Hex }, async () => 0n],
  ])("holds a record whose derivation moved while %s", async (_, over, balance) => {
    const { deps, at, deposits, record } = resumeDeps({
      broadcast: false,
      sipaAddress: MOVED,
      ...over,
    })
    deposits.readBalance.mockImplementation(balance)
    expect((await rebuildRegistrationBroadcast(deps, record, signDeps())).kind).toBe("wait")
    expect(await at(MOVED)).toMatchObject({ phase: record.phase })
  })

  it("closes a clean record whose derivation moved as replaced, keeping its address", async () => {
    const { deps, at, record } = resumeDeps({ broadcast: false, sipaAddress: MOVED })
    expect(await rebuildRegistrationBroadcast(deps, record, signDeps())).toEqual({
      kind: "closed",
      outcome: "failed",
    })
    expect(await at(MOVED)).toMatchObject({ phase: "replaced", endTime: expect.any(Number) })
  })

  it("rebuilds an address shown before the wallet's salt key from the salt seeded with it", async () => {
    const seeded = `0x${"03".repeat(32)}` as Hex
    const { deps, record } = resumeDeps({ broadcast: false, sipaAddress: MOVED, fundedAt: 1 })
    const seededSipaSalt = vi.fn(async () => seeded)
    const sign = {
      ...signDeps(),
      seededSipaSalt,
      deriveRegistrationSipa: vi.fn(async (input: { sharedSecretSalt?: Hex }) =>
        input.sharedSecretSalt === seeded
          ? { ...DERIVATION, sipaAddress: MOVED, sharedSecretSalt: seeded }
          : DERIVATION,
      ),
    }
    expect(await rebuildRegistrationBroadcast(deps, record, sign)).toMatchObject({
      kind: "payload",
      payload: { sipaAddress: MOVED, sharedSecretSalt: seeded },
    })
    expect(seededSipaSalt).toHaveBeenCalledWith(MOVED)
  })

  it("has nothing to rebuild for a record that already ended", async () => {
    const { deps, record } = resumeDeps({ phase: "confirmed", endTime: 1 })
    const sign = signDeps()
    expect(await rebuildRegistrationBroadcast(deps, record, sign)).toEqual({
      kind: "closed",
      outcome: "failed",
    })
    expect(sign.accountService.signDomain).not.toHaveBeenCalled()
  })
})

describe("registrations.broadcastSent", () => {
  it("stamps the record whose address it published", async () => {
    const { registrations, at } = registrationStore([recordAt({ broadcast: false })])
    await registrations.broadcastSent(SIPA)
    expect(await at(SIPA)).toMatchObject({ broadcast: true })
  })

  it("spends the replacement's rail in the same write when the account moved on meanwhile", async () => {
    const { registrations, at } = registrationStore([
      recordAt({ broadcast: false, phase: "failed_terminal", endTime: 1 }),
      recordAt({
        sipaAddress: OTHER_SIPA,
        broadcast: false,
        startTime: 5,
        replaced: { sipaAddress: SIPA, refunded: false, broadcastSpent: false },
      }),
    ])
    await registrations.broadcastSent(SIPA)
    expect(await at(SIPA)).toMatchObject({ broadcast: true })
    expect(await at(OTHER_SIPA)).toMatchObject({
      broadcast: false,
      replaced: { sipaAddress: SIPA, refunded: false, broadcastSpent: true },
    })
  })
})

describe("the lapse", () => {
  it.each([
    ["an expired quote with nothing at the address", 1, 0n, true],
    ["a live quote", 4_102_444_800, 0n, false],
    ["an expired quote with the deposit at the floor", 1, 50n, false],
    ["an unknown deadline", 0, 0n, false],
  ])("is stamped once for %s", async (_, deadline, balance, lapsed) => {
    const { deps, at, deposits } = resumeDeps({ terms: { deadline } })
    deposits.readBalance.mockResolvedValue(balance)
    await resumeOxideRegistration(deps)
    const first = (await at(SIPA))?.lapsedAt
    expect(first !== undefined).toBe(lapsed)
    await resumeOxideRegistration(deps)
    expect((await at(SIPA))?.lapsedAt).toBe(first)
  })
})
