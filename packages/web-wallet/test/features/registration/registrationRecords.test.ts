/**
 * What the wallet reads off its registration records and the writes that close them, over the
 * session's real store: the pending tag, the logout gate, custody, the lost-name notice and the
 * close that retracts the identity in the same write.
 */
import { act, createElement } from "react"
import { testCore, testPage } from "../../support/page"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { WalletError, type PendingRegistrationRecord } from "@obsidion/front-core"
import { writeDeviceKeys } from "../../../src/platform/storage/deviceKeys"
import { setIdentity } from "../../support/identity"
import {
  activeNamespace,
  closeSession,
  followSavedSession,
  session,
  switchSession,
} from "../../../src/session/session"
import { pageSessionDeps } from "../../../src/app/sessionDeps"
import {
  abandonPendingRegistration,
  acknowledgeLostRegistration,
  closeRegistration,
  isLogoutBlockedByRegistration,
  isTagPresentationPending,
  lostRegistrationNotice,
  registrationRecordForSipa,
  registrationScheduleForSipa,
  useTagPresentationPending,
} from "../../../src/features/registration/webRegistration"
import {
  openRegistration,
  registrationCustody,
} from "../../../src/features/registration/openRegistration"
import { useOwedRegistration } from "../../../src/features/registration/owedRegistration"
import { holdAtSipa } from "../../support/sipaDeposits"
import { testWalletDbs } from "../../support/fakeWalletDb"
import {
  L2_ADDRESS,
  SIPA,
  pendingRecord,
  seedRegistration,
  seedRegistrationRail,
  storedRegistration,
} from "../../support/registrationFixtures"
import { seedBootConfig } from "../../support/seedBootConfig"
import { getConfig } from "../../../src/config/env"

const deviceDb = testPage().database

const OTHER_SIPA = "0x00000000000000000000000000000000000000c9"
const NS = "a1"
let record: PendingRegistrationRecord
beforeAll(async () => {
  await seedBootConfig()
  record = pendingRecord({ l1ChainId: getConfig().l1ChainId })
})
const identity = { handle: "taga", address: L2_ADDRESS, claimedAt: 1 }

/** An account's session; `blob` is the legacy record blob its namespace holds before it opens. */
async function open(blob?: string) {
  await writeDeviceKeys(deviceDb, { storageId: NS })
  if (blob !== undefined)
    await deviceDb.write(async (w) =>
      w.put(`obsidion.${NS}.@obsidion/pending-registration/records`, blob),
    )
  await followSavedSession(testCore().device, pageSessionDeps(testPage()))
  const { withdrawals } = session()
  // The session's watchers keep the withdrawals loaded: a stage is known once they land.
  unwatch = withdrawals.list.subscribe(() => {})
  await withdrawals.all()
}
let unwatch = () => {}
afterEach(() => {
  unwatch()
  closeSession()
})

const seed = (over: Partial<PendingRegistrationRecord> = {}) =>
  seedRegistration({ ...record, ...over })

describe("the identity's pending tag", () => {
  beforeEach(async () => {
    await open()
    await setIdentity(identity)
  })

  it.each([
    ["no record", null, false],
    ["an open record", {}, true],
    ["a lost one", { phase: "failed_taken" as const, endTime: 1 }, true],
    ["a confirmed one", { phase: "confirmed" as const, endTime: 1 }, false],
    [
      "a confirmed one owing its recovery notice",
      { phase: "confirmed" as const, endTime: 1, notice: { recovery: true as const } },
      true,
    ],
    [
      "one whose recovery notice was read",
      {
        phase: "confirmed" as const,
        endTime: 1,
        notice: { recovery: true as const, acknowledged: true as const },
      },
      false,
    ],
  ])("follows %s", async (_, over, pending) => {
    if (over) await seed(over)
    expect(isTagPresentationPending(session().registrations, session().identity.get().value)).toBe(
      pending,
    )
  })
})

describe("a view over the registrations", () => {
  it("follows a signup that opens the account's session in place of the visitor's", async () => {
    await writeDeviceKeys(deviceDb, { storageId: null })
    await switchSession(activeNamespace(testCore().device), pageSessionDeps(testPage()))
      .registrations.ready
    let pending: boolean | undefined
    const root = createRoot(document.createElement("div"))
    const Probe = () => {
      pending = useTagPresentationPending()
      return null
    }
    await act(async () => root.render(createElement(Probe)))
    expect(pending).toBe(false)
    await act(async () => {
      await open()
      await setIdentity(identity)
      await seed()
    })
    expect(pending).toBe(true)
    await act(async () => void (await seed({ phase: "confirmed", endTime: 1 })))
    expect(pending).toBe(false)
    await act(async () => root.unmount())
  })
})

describe("the refunds task", () => {
  it("remembers the refund the rail's record shows", async () => {
    await open()
    await seed()
    const hash = `0x${"66".repeat(32)}` as const
    await seedRegistrationRail(record, { phase: "recovered", recoveryTxHash: hash })
    await session().wake(session().tasks.registrationRefunds)
    expect((await storedRegistration())?.refunds?.txHashes).toEqual([hash])
  })
})

describe("records that cannot be read", () => {
  beforeEach(async () => {
    await open("{not json")
    await setIdentity(identity)
  })

  it("hold the tag pending, block the sign-out, report failed and keep custody held", () => {
    expect(session().registrations.view.get().failed).toBe(true)
    expect(isTagPresentationPending(session().registrations, session().identity.get().value)).toBe(
      true,
    )
    expect(isLogoutBlockedByRegistration(session())).toBe(true)
    expect(openRegistration(session())).toEqual({ failed: true })
    const { registrations, sipaDeposits, withdrawals } = session()
    expect(registrationCustody(registrations.view, sipaDeposits.view, withdrawals.list).get()).toBe(
      true,
    )
  })
  it("are unknown, never none, to the paths that route funds", () => {
    // A plain-deposit answer would send a registration address down the sweep that fails parity.
    expect(() => registrationScheduleForSipa(session().registrations, SIPA)).toThrow(WalletError)
    expect(() => registrationRecordForSipa(session().registrations, SIPA)).toThrow(WalletError)
  })
})

describe("the close", () => {
  beforeEach(async () => {
    await open()
    await setIdentity(identity)
    await seed()
  })

  it("of a lost race retracts the identity in the same write", async () => {
    await closeRegistration(session(), record, { type: "closed", outcome: "taken" })
    expect((await storedRegistration())?.phase).toBe("failed_taken")
    expect(session().identity.get().value).toBeNull()
    expect(lostRegistrationNotice(session().registrations)).toEqual({ kind: "taken", tag: "taga" })
  })

  it("that fails to commit changes neither the record nor the identity", async () => {
    testWalletDbs().onApply = () => {
      throw new Error("disk full")
    }
    await expect(
      closeRegistration(session(), record, { type: "closed", outcome: "taken" }),
    ).rejects.toThrow()
    testWalletDbs().onApply = undefined
    expect((await storedRegistration())?.phase).toBe("awaiting_deposit")
    expect(session().identity.get().value).toMatchObject({ handle: "taga" })
  })

  it.each([
    ["a moved derivation's replacement", { type: "replaced" } as const, "replaced"],
    ["a recovery", { type: "closed", outcome: "recovery" } as const, "confirmed"],
  ])("of %s keeps the record and retracts the identity", async (_, event, phase) => {
    await closeRegistration(session(), record, event)
    expect((await storedRegistration())?.phase).toBe(phase)
    expect(session().identity.get().value).toBeNull()
  })

  it("of a confirmation keeps the identity", async () => {
    await closeRegistration(session(), record, { type: "closed", outcome: "confirmed" })
    expect(session().identity.get().value).toMatchObject({ handle: "taga" })
    expect(isTagPresentationPending(session().registrations, session().identity.get().value)).toBe(
      false,
    )
  })

  it("of another wallet's record leaves this identity alone", async () => {
    const other: PendingRegistrationRecord = {
      ...record,
      sipaAddress: OTHER_SIPA,
      l2Address: `0x${"33".repeat(32)}`,
    }
    await seedRegistration(other)
    await closeRegistration(session(), other, { type: "closed", outcome: "taken" })
    expect(session().identity.get().value).toMatchObject({ handle: "taga" })
  })
})

describe("the lost-name notice", () => {
  beforeEach(() => open())

  it("tells of a loss once, and a later loss surfaces its own", async () => {
    await seed({ phase: "failed_taken", endTime: 1 })
    expect(lostRegistrationNotice(session().registrations)).toEqual({ kind: "taken", tag: "taga" })
    await acknowledgeLostRegistration(session().registrations)
    expect(lostRegistrationNotice(session().registrations)).toBeNull()
    await seedRegistration({
      ...record,
      sipaAddress: OTHER_SIPA,
      tag: "tagb",
      phase: "failed_terminal",
      startTime: record.startTime + 1,
      endTime: 2,
    })
    expect(lostRegistrationNotice(session().registrations)).toEqual({ kind: "failed", tag: "tagb" })
  })

  it("owes nothing for a name change, and keeps the replaced address for recovery only", async () => {
    await seed()
    const { phase, broadcast, retries, startTime, ...start } = record
    void [phase, broadcast, retries, startTime]
    await session().registrations.start({
      type: "started",
      record: { ...start, sipaAddress: OTHER_SIPA, tag: "tagb" },
    })
    expect((await storedRegistration())?.phase).toBe("replaced")
    expect(lostRegistrationNotice(session().registrations)).toBeNull()
    expect(registrationScheduleForSipa(session().registrations, SIPA)).toBe("unsweepable")
  })

  it("puts a recovery first, and its dismissal leaves an unrelated failure standing", async () => {
    await seed({ phase: "failed_terminal", endTime: 1 })
    await seedRegistration({
      ...record,
      sipaAddress: OTHER_SIPA,
      tag: "tagb",
      phase: "confirmed",
      endTime: 2,
      notice: { recovery: true },
    })
    expect(lostRegistrationNotice(session().registrations)).toEqual({
      kind: "recovery",
      tag: "tagb",
    })
    await acknowledgeLostRegistration(session().registrations)
    expect(lostRegistrationNotice(session().registrations)).toEqual({ kind: "failed", tag: "taga" })
  })
})

describe("abandoning", () => {
  beforeEach(async () => {
    await open()
    await setIdentity(identity)
  })

  it("closes a record with no custody, retracts its identity and owes no notice", async () => {
    await seed()
    expect(await abandonPendingRegistration(session())).toBe(true)
    expect((await storedRegistration())?.phase).toBe("failed_terminal")
    expect(session().identity.get().value).toBeNull()
    expect(lostRegistrationNotice(session().registrations)).toBeNull()
  })

  it.each([
    ["a deposit landed", { phase: "funded" as const, fundedAt: 1 }],
    ["the sweep was seen", { phase: "funded" as const, fundedAt: 1, sweptAt: 2 }],
  ])("is refused once %s, keeping the record and its identity", async (_, over) => {
    await seed(over)
    expect(await abandonPendingRegistration(session())).toBe(false)
    expect((await storedRegistration())?.phase).toBe("funded")
    expect(session().identity.get().value).toMatchObject({ handle: "taga" })
  })
})

describe("the logout gate", () => {
  beforeEach(async () => {
    await open()
    await setIdentity(identity)
  })

  it.each([
    ["an open record still retrying", {}, true],
    ["an escalated one", { retries: 3 }, false],
    ["a closed one", { phase: "confirmed" as const, endTime: 1 }, false],
    ["another wallet's", { l2Address: `0x${"33".repeat(32)}` as const }, false],
  ])("for %s", async (_, over: Partial<PendingRegistrationRecord>, blocked) => {
    await seed(over)
    expect(isLogoutBlockedByRegistration(session())).toBe(blocked)
  })
})

describe("the SIPA lane's schedule for a registration address", () => {
  beforeEach(() => open())
  const signed = { deadline: 9, fee: pendingRecord().fee, minDeposit: "4" }

  it.each([
    ["an address never registered", null, undefined],
    ["one priced by its signed terms", { terms: signed }, { fee: BigInt(signed.fee), min: 4n }],
    ["a live one whose terms are missing", {}, null],
    ["one whose terms price another fee", { terms: { ...signed, fee: "999" } }, "unsweepable"],
    [
      "a closed one, replaced or lost",
      { phase: "failed_terminal" as const, endTime: 1, terms: signed },
      "unsweepable",
    ],
  ])("reads %s", async (_, over, answer) => {
    if (over) await seed(over)
    expect(registrationScheduleForSipa(session().registrations, SIPA)).toEqual(answer)
  })
})

describe("openRegistration and custody", () => {
  beforeEach(() => open())

  it("speaks only for the tag the active wallet still presents as pending", async () => {
    await seed()
    expect(openRegistration(session())).toBeNull()
    await setIdentity({ ...identity, address: `0x${"33".repeat(32)}` })
    expect(openRegistration(session())).toBeNull()
    await setIdentity(identity)
    expect(openRegistration(session())?.stage).toBe("reserved")
  })

  it("holds custody from the record alone until the name settles", async () => {
    const { registrations, sipaDeposits, withdrawals } = session()
    const custody = registrationCustody(registrations.view, sipaDeposits.view, withdrawals.list)
    const off = custody.subscribe(() => {})
    expect(custody.get()).toBe(false)
    await seed()
    expect(custody.get()).toBe(true)
    await seed({ phase: "confirmed", endTime: 1 })
    expect(custody.get()).toBe(false)
    off()
  })

  it("asks for the check on an admitting deposit only once its record is funded", async () => {
    await setIdentity(identity)
    await seed({ route: "random" })
    await holdAtSipa(SIPA, 10n ** 21n)
    let owed: ReturnType<typeof useOwedRegistration> = null
    const root = createRoot(document.createElement("div"))
    const Probe = () => {
      owed = useOwedRegistration()
      return null
    }
    await act(async () => root.render(createElement(Probe)))
    // The deposit screen spots it first.
    expect(owed).toMatchObject({ needsCheck: false })
    await act(async () => void (await seed({ route: "random", phase: "funded" })))
    expect(owed).toMatchObject({ needsCheck: true })
    await act(async () => root.unmount())
  })
})
