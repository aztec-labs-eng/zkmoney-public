import { describe, expect, it } from "vitest"
import type { Hex } from "viem"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { SipaDeposit } from "../../src/engine/sipaDeposits"
import type { WithdrawalRecord } from "../../src/core/services/bridge/types"
import { SWAP_STUCK_THRESHOLD_MS } from "../../src/core/services/bridge/withdrawalPhases"
import type { MoveState } from "../../src/engine/moveState"
import type { BackupRotationRecord } from "../../src/engine/backupRotations"
import type { SipaProcessingState } from "../../src/core/services/deposits/sipaProcessing"
import { STUCK_SWEEP_MS } from "../../src/core/services/deposits/sipaStuck"
import {
  backupAddRunning,
  backupAdded,
  backupFee,
  backupFundingQuote,
  bridgeDetailTarget,
  canSelfSweep,
  depositDetailOffer,
  depositExitOffer,
  findBridgeItem,
  fundingRecovery,
  migrationAmounts,
  recoveryReasonFor,
  registrationTagForDeposit,
  moveExitOffer,
  withdrawalIntent,
  type ActivityItem,
  type RegistrationRef,
} from "../../src/engine/feedRules"

const NOW = 1_800_000_000_000

const stuck = {
  sipaAddress: "0x000000000000000000000000000000000000d0d0",
  recipientL2Address: `0x${"aa".repeat(32)}`,
  messageSecret: `0x${"01".repeat(32)}`,
  recipientHash: `0x${"02".repeat(32)}`,
  recoveryAddress: "0x000000000000000000000000000000000000b0b0",
  l1ChainId: 11155111,
  amount: "18",
  tokenSymbol: "DAI",
  phase: "sweeping",
  startTime: NOW - 10 * 60_000,
} as SipaDeposit

const blocked: SipaProcessingState = {
  reason: {
    kind: "capacity",
    requiredAtomic: 17n * 10n ** 18n,
    availableAtomic: 5n * 10n ** 18n,
    refill: { status: "unknown" },
    decimals: 18,
    observedAt: 1,
  },
  blocker: { kind: "capacity", observedAt: 1 },
}

const cleared: SipaProcessingState = {
  reason: { kind: "processing", availableAtomic: 50n * 10n ** 18n, decimals: 18, observedAt: 2 },
}

const registration = (over: Partial<RegistrationRef> = {}): RegistrationRef => ({
  sipaAddress: stuck.sipaAddress,
  tag: "alice",
  phase: "funded",
  ...over,
})

describe("depositExitOffer", () => {
  it("offers Recover, opening recovery alone, while a capacity blocker is confirmed", () => {
    expect(depositExitOffer(stuck, { processing: blocked, now: NOW })).toEqual({
      reason: "stuck",
      canSweep: false,
      sweepable: true,
      waiting: true,
      action: "recover",
    })
  })

  it("offers the sweep again once a read clears the blocker", () => {
    expect(depositExitOffer(stuck, { processing: cleared, now: NOW })).toMatchObject({
      canSweep: true,
      action: "sweep",
    })
  })

  it("holds a registration-backed deposit to the registration's own gate", () => {
    const live = { processing: cleared, registration: registration(), now: NOW }
    expect(depositExitOffer(stuck, live)).toMatchObject({ canSweep: true, action: "sweep" })
    const swept = { ...live, registration: registration({ sweptAt: 1 }) }
    expect(depositExitOffer(stuck, swept)).toMatchObject({ canSweep: false, action: "recover" })
  })

  it("offers nothing before the stuck clock runs out", () => {
    expect(depositExitOffer(stuck, { processing: cleared, now: stuck.startTime })).toBeNull()
  })
})

describe("depositDetailOffer", () => {
  const fresh = { ...stuck, startTime: NOW }

  it("offers a sweep for funds still at the address", () => {
    expect(depositDetailOffer(fresh, { processing: cleared, now: NOW })).toMatchObject({
      canSweep: true,
      action: "sweep",
    })
  })

  it("offers nothing once the funds have left the address or never arrived", () => {
    const sweepTxHash = `0x${"03".repeat(32)}` as Hex
    const at = { processing: cleared, now: NOW }
    expect(depositDetailOffer({ ...fresh, sweepTxHash }, at)).toBeNull()
    expect(depositDetailOffer({ ...stuck, sweepTxHash }, at)).toBeNull()
    expect(
      depositDetailOffer({ ...fresh, phase: "pendingClaim", inboxIndex: "7", netAmount: "17" }, at),
    ).toBeNull()
    expect(depositDetailOffer({ ...stuck, phase: "broadcast", amount: "0" }, at)).toBeNull()
  })

  it("offers nothing on a backup passkey's deposit address, whose panel recovers it", () => {
    const origin = {
      protocol: "account",
      sipaFactory: "0x00000000000000000000000000000000000000fa",
      implementation: "0x00000000000000000000000000000000000000f1",
      intentHash: `0x${"04".repeat(32)}`,
      rollupVersion: "6",
      resweepable: false,
      recoveryAccount: "0x00000000000000000000000000000000000000a1",
      recoveryCommitment: `0x${"05".repeat(32)}`,
      accountFactory: "0x00000000000000000000000000000000000000af",
      forwardingTable: "0x00000000000000000000000000000000000000f7",
    } as const
    const at = { processing: cleared, now: NOW }
    for (const record of [stuck, fresh]) {
      const rotation = { ...record, recoveryAddress: "", origin, intent: "add-passkey" as const }
      expect(depositDetailOffer({ ...rotation, intent: undefined }, at)).not.toBeNull()
      expect(depositExitOffer(rotation, at)).toBeNull()
      expect(depositDetailOffer(rotation, at)).toBeNull()
    }
  })
})

describe("recoveryReasonFor", () => {
  const at = (patch: Partial<SipaDeposit>) => ({
    ...stuck,
    startTime: NOW - STUCK_SWEEP_MS,
    ...patch,
  })

  it("always offers the exit to a deposit that can never be swept, however fresh", () => {
    expect(recoveryReasonFor(at({ phase: "recoverable", startTime: NOW }), NOW)).toBe("unsweepable")
  })

  it.each(["sweeping", "broadcast"] as const)(
    "offers a %s deposit the exit only once it is stuck",
    (phase) => {
      expect(recoveryReasonFor(at({ phase }), NOW)).toBe("stuck")
      expect(recoveryReasonFor(at({ phase, startTime: NOW - STUCK_SWEEP_MS + 1 }), NOW)).toBeNull()
    },
  )

  it("runs the clock from the last ask to publish again, however the payment is dated", () => {
    // A payment found late is dated hours back; on a chain ahead of this clock, it is ahead.
    for (const startTime of [NOW - 2 * 60 * 60_000, NOW + 60 * 60_000]) {
      const asked = at({ startTime, republishAskedAt: NOW })
      expect(recoveryReasonFor(asked, NOW + STUCK_SWEEP_MS - 1)).toBeNull()
      expect(recoveryReasonFor(asked, NOW + STUCK_SWEEP_MS)).toBe("stuck")
    }
  })

  it("offers nothing without the note's message secret", () => {
    // Half the recovery key derives from it.
    expect(recoveryReasonFor(at({ messageSecret: "" }), NOW)).toBeNull()
    expect(recoveryReasonFor(at({ messageSecret: "", phase: "recoverable" }), NOW)).toBeNull()
  })

  it("offers nothing on every other phase", () => {
    for (const phase of [
      "resolved",
      "funding",
      "funded",
      "pendingClaim",
      "claimed",
      "failed",
      "recovered",
    ] as const) {
      expect(recoveryReasonFor(at({ phase, startTime: 0 }), NOW)).toBeNull()
    }
  })
})

describe("canSelfSweep", () => {
  it("offers the sweep to a stuck deposit", () => {
    expect(canSelfSweep(stuck, NOW)).toBe(true)
  })

  it("withholds it from a deposit under the fee floor, where Recover is the only exit", () => {
    expect(canSelfSweep({ ...stuck, phase: "recoverable", startTime: 0 }, NOW)).toBe(false)
  })

  it("withholds it without the derived inputs the CREATE2 address is bound to", () => {
    expect(canSelfSweep({ ...stuck, recipientHash: "" }, NOW)).toBe(false)
    expect(canSelfSweep({ ...stuck, recoveryAddress: "" }, NOW)).toBe(false)
  })
})

describe("fundingRecovery", () => {
  const funding = {
    localId: "wdraw_backup_a1",
    intent: "backup",
    phase: "done",
  } as WithdrawalRecord
  const stopped = (over: Partial<BackupRotationRecord> = {}) =>
    ({
      attemptId: "a1",
      phase: "attention",
      attention: "stranded",
      suspended: "funded",
      fundings: [{ attemptId: "a1", localId: funding.localId, outcome: "mined" }],
      ...over,
    } as BackupRotationRecord)
  const recovery = { txHash: `0x${"06".repeat(32)}` as Hex }
  const plan = { deposited: "1800" } as BackupRotationRecord["plan"]
  const held = { ...stuck, intent: "add-passkey", phase: "recoverable" } as SipaDeposit
  const of = (rotations: readonly BackupRotationRecord[] | "unread", deposit = held) =>
    fundingRecovery(funding, rotations, deposit)

  it("reads a paid funding from the attempt that did not add the backup", () => {
    expect(of([stopped({ plan })])).toEqual({ state: "held" })
    expect(of([stopped({ attention: "corrupt" })])?.state).toBe("held")
    expect(of([stopped({ plan, recovery })])).toEqual({
      state: "sent",
      recoveryTxHash: recovery.txHash,
    })
    const ended = stopped({ phase: "recovered", attention: undefined, suspended: undefined })
    expect(of([{ ...ended, plan, recovery }])).toEqual({
      state: "recovered",
      deposited: "1800",
      recoveryTxHash: recovery.txHash,
    })
  })

  // An attempt ends at recovered only once none of its fundings can land, so later money is not this one's.
  it("keeps a recovered funding recovered, with its own recovery, when money lands later", () => {
    const later = { txHash: `0x${"07".repeat(32)}` as Hex }
    const own = { state: "recovered", deposited: "1800", recoveryTxHash: recovery.txHash }
    const reparked = stopped({ suspended: "recovered", plan, recovered: recovery })
    expect(of([reparked])).toEqual(own)
    expect(of([{ ...reparked, recovery: later }])).toEqual(own)
    // Back at recovered once the later money went back too.
    const ended = stopped({ phase: "recovered", attention: undefined, suspended: undefined })
    expect(of([{ ...ended, plan, recovery: later, recovered: recovery }])).toEqual(own)
    // An attempt that ended without `recovered` names no recovery rather than the later money's.
    const unnamed = stopped({ suspended: "recovered", plan, recovery: later })
    expect(of([unnamed])).toEqual({ state: "recovered", deposited: "1800" })
  })

  // The Recovered card's Done removes the attempt's record.
  it("reads a recovered funding from its deposit address once no attempt holds it", () => {
    const recovered = { ...held, phase: "recovered", recoveryTxHash: recovery.txHash } as const
    const expected = { state: "recovered", recoveryTxHash: recovery.txHash }
    expect(of([], recovered)).toEqual(expected)
    expect(of([], { ...recovered, phase: "sweeping" })).toEqual(expected)
    expect(of("unread", recovered)).toEqual(expected)
    expect(of("unread", { ...recovered, phase: "recoverable" })).toEqual({
      state: "sent",
      recoveryTxHash: recovery.txHash,
    })
  })

  it("does not read a funding as settled while this device's attempts are unread", () => {
    expect(of("unread")).toEqual({ state: "unread" })
    expect(of("unread", undefined)).toEqual({ state: "unread" })
    const sweptHeld = { ...held, phase: "claimed", claimedInboxIndexes: ["1"] } as SipaDeposit
    expect(of("unread", sweptHeld)).toEqual({ state: "unread" })
  })

  it("keeps the tracker's status for a landing funding, a backup added, or a healthy attempt", () => {
    expect(
      fundingRecovery({ ...funding, phase: "finalizing_l1" }, [stopped()], held),
    ).toBeUndefined()
    expect(of([stopped({ suspended: "done" })])).toBeUndefined()
    const healthy = stopped({ phase: "funded", attention: undefined, suspended: undefined })
    expect(of([healthy])).toBeUndefined()
    expect(of([stopped({ fundings: [] })])).toBeUndefined()
    expect(of([])).toBeUndefined()
    // Money paid after the change ran, then recovered, was never this funding's.
    const swept = { ...held, sweepTxHash: "0x01", recoveryTxHash: recovery.txHash } as SipaDeposit
    expect(of([], swept)).toBeUndefined()
  })
})

describe("backupAdded", () => {
  const funding = {
    localId: "wdraw_backup_a1",
    intent: "backup",
    phase: "done",
  } as WithdrawalRecord
  const attempt = (over: Partial<BackupRotationRecord>) =>
    ({
      attemptId: "a1",
      fundings: [{ attemptId: "a1", localId: funding.localId, outcome: "mined" }],
      ...over,
    } as BackupRotationRecord)
  const unswept = { ...stuck, intent: "add-passkey", phase: "funded" } as SipaDeposit
  const swept = { ...unswept, phase: "claimed", sweepTxHash: "0x01" } as SipaDeposit

  it("reads added only once the attempt is done", () => {
    expect(backupAdded(funding, [attempt({ phase: "done" })], unswept)).toBe(true)
    // Past the account change, the final approval is still to come.
    for (const phase of ["swept", "installed", "rerooted", "moved"] as const) {
      expect(backupAdded(funding, [attempt({ phase })], swept)).toBe(false)
    }
    const move = attempt({ phase: "attention", attention: "move", suspended: "moved" })
    expect(backupAdded(funding, [move], swept)).toBe(false)
  })

  it("reads not added while the funding releases, after it failed, or before the sweep", () => {
    const done = [attempt({ phase: "done" })]
    expect(backupAdded({ ...funding, phase: "finalizing_l1" }, done, swept)).toBe(false)
    expect(backupAdded({ ...funding, phase: "failed" }, done, swept)).toBe(false)
    expect(backupAdded(funding, [attempt({ phase: "funded" })], swept)).toBe(false)
    // Parked on a route that does not pay, the change has not run.
    const route = attempt({ phase: "attention", attention: "route", suspended: "funded" })
    expect(backupAdded(funding, [route], unswept)).toBe(false)
    expect(backupAdded(funding, [attempt({ phase: "recovered" })], unswept)).toBe(false)
  })

  // The Recovered card's Done removes the attempt's record; the deposit address outlives it.
  it("reads the deposit address once the attempts are read and none holds the funding", () => {
    expect(backupAdded(funding, [], swept)).toBe(true)
    expect(backupAdded(funding, [], unswept)).toBe(false)
    expect(backupAdded(funding, "unread", swept)).toBe(false)
  })

  it("reads nothing for a burn that paid for something else", () => {
    const done = [attempt({ phase: "done" })]
    expect(backupAdded({ ...funding, intent: "registration" }, done, swept)).toBe(false)
  })
})

describe("registrationTagForDeposit", () => {
  it("names the registration, and drops it once the deposit went back unpaid", () => {
    const regs = { records: [registration({ phase: "awaiting_deposit" })], handle: "me" }
    expect(registrationTagForDeposit(regs, stuck)).toBe("alice")
    expect(registrationTagForDeposit(regs, { ...stuck, phase: "recovered" })).toBeUndefined()
    const other = { ...stuck, sipaAddress: "0x1", intent: "registration" as const }
    expect(registrationTagForDeposit(regs, other)).toBe("me")
  })
})

describe("migrationAmounts", () => {
  it("takes the tip, the executor fee and the arrival fee off the amount", () => {
    // 85 less the 0.1 tip, the 0.05 executor fee and the 0.25 arrival fee.
    expect(
      migrationAmounts({
        amount: "85",
        rawAmount: (85n * 10n ** 18n).toString(),
        tokenDecimals: 18,
        relayerTip: WITHDRAW_RELAYER_TIP.toString(),
        withdrawalFee: (5n * 10n ** 16n).toString(),
        arrivalFee: (25n * 10n ** 16n).toString(),
      })?.netDisplay,
    ).toBe("84.6")
  })

  it("prices nothing while a fee is missing", () => {
    expect(migrationAmounts({ amount: "85", relayerTip: "1", tokenDecimals: 18 })).toBeUndefined()
  })
})

describe("backupFee", () => {
  const cents = (n: bigint) => (n * 10n ** 16n).toString()
  const funding = {
    localId: "wdraw_backup_a1",
    intent: "backup",
    phase: "done",
    amount: "1.3",
    rawAmount: cents(130n),
    relayerTip: cents(5n),
    withdrawalFee: cents(15n),
    tokenDecimals: 18,
  } as WithdrawalRecord
  // 1.10 reached the address: 0.50 ran the change and 0.60 came back.
  const sweep = { inboxIndex: "1", sweepTxHash: "0x01", netAmount: cents(60n), fee: cents(50n) }
  const credit = {
    ...stuck,
    intent: "add-passkey",
    phase: "claimed",
    netAmount: cents(60n),
    fee: cents(50n),
    sweeps: [sweep],
  } as SipaDeposit
  const unclaimed = { ...credit, phase: "pendingClaim", sweeps: [] } as SipaDeposit
  const attempt = (over: Partial<BackupRotationRecord> = {}) =>
    ({
      attemptId: "a1",
      phase: "funded",
      plan: { credited: cents(60n) },
      fundings: [{ attemptId: "a1", localId: funding.localId, outcome: "mined" }],
      ...over,
    } as BackupRotationRecord)
  const returned = { amount: 70n * 10n ** 16n, hold: 60n * 10n ** 16n, returned: true }
  const held = { ...returned, returned: false }

  it("splits a landed funding into its fee and the hold that came back", () => {
    expect(backupFee(funding, [], credit)).toEqual(returned)
  })

  // Someone else's 0.20 swept with the funding would read as hold until the claim splits it.
  it("reads the planned hold until the credit is claimed, whatever the sweep credited", () => {
    expect(backupFee({ ...funding, phase: "finalizing_l1" }, [attempt()], undefined)).toEqual(held)
    const sweep = { index: "1", blockHash: `0x${"0a".repeat(32)}` as Hex, credited: cents(80n) }
    expect(backupFee(funding, [attempt({ phase: "swept", sweep })], unclaimed)).toEqual(held)
  })

  it("prices a funding rebuilt from chain, which names no intent, by the address it paid", () => {
    expect(backupFee({ ...funding, intent: undefined }, [], credit)).toEqual(returned)
  })

  // The address cannot be swept twice, so later money reopens its record for recovery.
  it("keeps the price when money reaches the address after its sweep", () => {
    const reopened = { ...credit, phase: "recoverable", amount: "0.3", fee: cents(5n) } as const
    expect(backupFee(funding, [], reopened)).toEqual(returned)
  })

  it("prices nothing while neither the plan nor the claimed credit is known", () => {
    expect(backupFee(funding, [], unclaimed)).toBeUndefined()
    expect(backupFee({ ...funding, phase: "finalizing_l1" }, "unread", undefined)).toBeUndefined()
    // A credit at an address that is no backup passkey's is not this funding's.
    expect(backupFee(funding, [], { ...credit, intent: undefined })).toBeUndefined()
  })

  it("prices nothing for a burn that paid for something else", () => {
    expect(backupFee({ ...funding, intent: "registration" }, [attempt()], credit)).toBeUndefined()
  })

  // No sweep will take this funding, so its money stays at the address to recover.
  it("holds nothing back once the change ran without this funding, or the attempt stranded it", () => {
    const releasing = { ...funding, phase: "finalizing_l1" } as const
    expect(backupFee(releasing, [attempt({ phase: "installed" })], undefined)).toBeUndefined()
    const stranded = attempt({ phase: "attention", attention: "stranded", suspended: "funded" })
    expect(backupFee(releasing, [stranded], undefined)).toBeUndefined()
    expect(backupFee(releasing, [attempt({ phase: "conflict" })], undefined)).toBeUndefined()
  })

  // Someone else's 0.10 swept with the funding's 1.10 would read as 0.10 more returned.
  it("prices nothing when the sweep took other money with this funding's", () => {
    const shared = [{ ...sweep, netAmount: cents(70n) }]
    expect(backupFee(funding, [attempt()], { ...credit, sweeps: shared })).toBeUndefined()
  })

  it("prices nothing while the funding's fees are unknown", () => {
    expect(backupFee({ ...funding, withdrawalFee: undefined }, [], credit)).toBeUndefined()
    expect(backupFee({ ...funding, relayerTip: undefined }, [], credit)).toBeUndefined()
  })

  // A retry pays the same address, so a failed burn would otherwise take the add's price.
  it("prices nothing for a burn that did not land, or an add that stopped", () => {
    expect(backupFee({ ...funding, phase: "failed" }, [attempt()], credit)).toBeUndefined()
    const stopped = attempt({ phase: "attention", attention: "stranded", suspended: "funded" })
    const parked = { ...unclaimed, phase: "recoverable" } as SipaDeposit
    expect(backupFee(funding, [stopped], parked)).toBeUndefined()
  })
})

describe("backupAddRunning", () => {
  const funding = {
    localId: "wdraw_backup_a1",
    intent: "backup",
    phase: "done",
  } as WithdrawalRecord
  const attempt = (over: Partial<BackupRotationRecord>) =>
    ({
      attemptId: "a1",
      fundings: [{ attemptId: "a1", localId: funding.localId, outcome: "mined" }],
      ...over,
    } as BackupRotationRecord)
  const unswept = { ...stuck, intent: "add-passkey", phase: "funded" } as SipaDeposit
  const running = (record: WithdrawalRecord, rotation: BackupRotationRecord) =>
    backupAddRunning(record, [rotation], unswept)

  it("runs from the funding until the attempt is done, through a final approval", () => {
    for (const phase of ["funded", "swept", "rerooted", "moved"] as const) {
      expect(running(funding, attempt({ phase })), phase).toBe(true)
    }
    const route = attempt({ phase: "attention", attention: "route", suspended: "funded" })
    expect(running({ ...funding, phase: "finalizing_l1" }, route)).toBe(true)
  })

  it("stops once the attempt ended, its funding failed or stopped, or no attempt holds it", () => {
    expect(running(funding, attempt({ phase: "done" }))).toBe(false)
    expect(running(funding, attempt({ phase: "recovered" }))).toBe(false)
    expect(running({ ...funding, phase: "failed" }, attempt({ phase: "funded" }))).toBe(false)
    const stranded = attempt({ phase: "attention", attention: "stranded", suspended: "funded" })
    const held = { ...unswept, phase: "recoverable" } as SipaDeposit
    expect(backupAddRunning(funding, [stranded], held)).toBe(false)
    expect(backupAddRunning(funding, [], unswept)).toBe(false)
    expect(backupAddRunning(funding, "unread", unswept)).toBe(false)
  })
})

describe("backupFundingQuote", () => {
  const cents = (n: bigint) => n * 10n ** 16n
  // 1.30 sent, 1.10 reaches the deposit address, 0.60 comes back to the new account.
  const plan = {
    fundingAmount: cents(130n).toString(),
    deposited: cents(110n).toString(),
    credited: cents(60n).toString(),
  }

  it("splits the fees between the withdrawal and the account change", () => {
    expect(backupFundingQuote(plan)).toEqual({
      sent: cents(130n),
      fees: { withdrawal: cents(20n), accountChange: cents(50n) },
      credited: cents(60n),
    })
  })

  it("gives one fee for a plan saved without what reaches the deposit address", () => {
    expect(backupFundingQuote({ ...plan, deposited: undefined }).fees).toBe(cents(70n))
  })
})

describe("withdrawalIntent", () => {
  it("reads a burn that names no intent as a backup passkey's funding by the address it paid", () => {
    expect(withdrawalIntent({}, { intent: "add-passkey" })).toBe("backup")
    expect(withdrawalIntent({}, { intent: "registration" })).toBeUndefined()
    expect(withdrawalIntent({}, undefined)).toBeUndefined()
  })

  it("keeps the intent a record names", () => {
    expect(withdrawalIntent({ intent: "backup" }, undefined)).toBe("backup")
    expect(withdrawalIntent({ intent: "registration" }, { intent: "add-passkey" })).toBe(
      "registration",
    )
  })
})

describe("notification target -> bridge row", () => {
  // Bridge targets carry the producer's lowercased SIPA address; records keep it checksummed.
  const SIPA = "0xAbCdEf0000000000000000000000000000000001"
  const items = [
    { kind: "bridge.withdrawal", record: { localId: "w1", l2TxHash: "0xBurn" } },
    { kind: "bridge.sipaDeposit", record: { sipaAddress: SIPA } },
    { kind: "transfer", record: { txHash: "0xt" } },
  ] as unknown as ActivityItem[]

  it("finds the bridge row, matching SIPA addresses case-insensitively", () => {
    expect(findBridgeItem(items, { openWithdrawalId: "w1" })?.kind).toBe("bridge.withdrawal")
    expect(findBridgeItem(items, { openDepositAddress: SIPA.toLowerCase() })?.kind).toBe(
      "bridge.sipaDeposit",
    )
    expect(findBridgeItem(items, { openWithdrawalId: "nope" })).toBeUndefined()
  })

  it("opens an address's own record, not a past payment to it", () => {
    const credited = [
      {
        kind: "bridge.sipaDeposit",
        record: { sipaAddress: SIPA, tokenSymbol: "DAI" },
        payment: "7",
      },
      { kind: "bridge.sipaDeposit", record: { sipaAddress: SIPA, tokenSymbol: "sUSDS" } },
    ] as unknown as ActivityItem[]
    const hit = findBridgeItem(credited, { openDepositAddress: SIPA })
    expect(hit?.record).toMatchObject({ tokenSymbol: "sUSDS" })
  })

  it("opens a Savings move's burn in the Savings detail its row opens, and a fresh leg as its group", () => {
    const withdrawal = (record: object) => ({ kind: "bridge.withdrawal", record } as never)
    expect(
      bridgeDetailTarget(withdrawal({ localId: "m1", skyMove: { direction: "out" } })),
    ).toEqual({ kind: "savings", id: "m1" })
    const vault = { holdingId: "fea-vault", nonce: "0x01" }
    expect(bridgeDetailTarget(withdrawal({ localId: "v1", vaultMove: vault }))).toEqual({
      kind: "savings",
      id: "v1",
    })
    expect(bridgeDetailTarget(withdrawal({ localId: "w2", groupId: "g1" }))).toEqual({
      kind: "withdrawal",
      id: "g1",
    })
    expect(bridgeDetailTarget(withdrawal({ localId: "w3" }))).toEqual({
      kind: "withdrawal",
      id: "w3",
    })
    expect(bridgeDetailTarget(items[1] as never)).toEqual({ kind: "deposit", address: SIPA })
  })

  it("resolves a reorg notice's tx hash to the bridge row it was taken from", () => {
    expect(findBridgeItem(items, { openTxHash: "0xburn" })?.kind).toBe("bridge.withdrawal")
    expect(findBridgeItem(items, { openTxHash: "0xt" })).toBeUndefined()
    expect(findBridgeItem(items, {})).toBeUndefined()
  })
})

describe("moveExitOffer", () => {
  const burned = { phase: "burned" } as const
  const both = { recoverable: true, runnable: true }
  const recoverOnly = { recoverable: true, runnable: false }
  const neither = { recoverable: false, runnable: false }

  it("offers a stalled burn's finalize, then the recovery once the relayer dropped its release", () => {
    const later = Date.now() + 365 * 24 * 3_600_000
    const burn = { localId: "w1", l2TxHash: "0xburn", startTime: 0, phaseEnteredAt: 0 }
    const pending = { kind: "pending" } as const
    const dropped = { kind: "delayed", reason: "relayerDropped", dropped: true } as const
    const proven = { ...burn, phase: "finalizing_l1" } as WithdrawalRecord
    const item = (state: MoveState, b?: WithdrawalRecord) => ({ state, move: burned, burn: b })
    expect(moveExitOffer(item(pending, proven), neither, later)).toBe("finalize")
    expect(moveExitOffer(item(pending, proven), both, 1)).toBeNull()
    expect(moveExitOffer(item(dropped), recoverOnly, later)).toBe("recover")
    expect(moveExitOffer(item(dropped), neither, later)).toBeNull()
    const waiting = { kind: "delayed", reason: "vaultFull", dropped: false } as const
    expect(moveExitOffer(item(waiting), both, later)).toBeNull()
  })

  it("offers the run once a release funded the escrow and nobody ran it within a swap's wait", () => {
    const pending = { kind: "pending" } as const
    const spent = { localId: "w1", phase: "done", startTime: 0, endTime: 1_000 } as WithdrawalRecord
    const stuck = 1_000 + SWAP_STUCK_THRESHOLD_MS
    expect(moveExitOffer({ state: pending, move: burned, burn: spent }, both, stuck - 1)).toBeNull()
    expect(moveExitOffer({ state: pending, move: burned, burn: spent }, both, stuck)).toBe("run")
    // Its run sheet offers recovery too, so a rail that cannot recover offers no run.
    const runOnly = { recoverable: false, runnable: true }
    expect(moveExitOffer({ state: pending, move: burned, burn: spent }, runOnly, stuck)).toBeNull()
    const ran = { phase: "released" } as const
    expect(moveExitOffer({ state: pending, move: ran, burn: spent }, both, stuck)).toBeNull()
  })

  it("offers no exit for a retired version's move, as that version offered none", () => {
    const later = Date.now() + 365 * 24 * 3_600_000
    const migrated = { phase: "migrated", releasedAt: 0 } as const
    expect(moveExitOffer({ state: { kind: "done" }, move: migrated }, both, later)).toBeNull()
  })
})
