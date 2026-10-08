/**
 * The exit a stuck deposit's row offers. While a capacity blocker is confirmed the row offers Recover, and Recover opens
 * recovery alone; a later read that clears the blocker brings the sweep back.
 */
import { afterEach, describe, expect, it } from "vitest"
import type { Hex } from "viem"
import {
  PendingRegistrationStore,
  type SIPADepositRecord,
  type SipaProcessingState,
} from "@obsidion/front-core"
import { depositDetailOffer, depositExitOffer } from "../src/ui/screens/useActivityEntries"
import { getPendingStore } from "../src/features/onboarding/webRegistration"

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
  startTime: Date.now() - 10 * 60_000,
} as SIPADepositRecord

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

describe("depositExitOffer", () => {
  afterEach(() => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
  })

  it("offers Recover, opening recovery alone, while a capacity blocker is confirmed", () => {
    expect(depositExitOffer(stuck, blocked)).toEqual({
      reason: "stuck",
      canSweep: false,
      sweepable: true,
      waiting: true,
      title: "Recover",
    })
  })

  it("offers the sweep again once a read clears the blocker", () => {
    expect(depositExitOffer(stuck, cleared)).toEqual({
      reason: "stuck",
      canSweep: true,
      sweepable: true,
      waiting: true,
      title: "Sweep manually",
    })
  })

  it("holds a registration-backed deposit's sweep the same way", async () => {
    await getPendingStore().upsert(
      "0x00000000000000000000000000000000000000aa",
      {},
      {
        tag: "alice",
        nameHash: `0x${"77".repeat(32)}` as Hex,
        l2Address: stuck.recipientL2Address as Hex,
        l1ChainId: 11155111,
        sipaAddress: stuck.sipaAddress,
        depositToken: "0x00000000000000000000000000000000000000d4" as Hex,
        broadcast: true,
        phase: "funded",
        retries: 0,
        startTime: stuck.startTime,
      },
    )
    expect(depositExitOffer(stuck, blocked)).toMatchObject({ canSweep: false, title: "Recover" })
    expect(depositExitOffer(stuck, cleared)).toMatchObject({
      canSweep: true,
      title: "Sweep manually",
    })
  })
})

describe("depositDetailOffer", () => {
  const fresh = { ...stuck, startTime: Date.now() }

  it("offers a sweep for funds still at the address", () => {
    expect(depositDetailOffer(fresh, cleared)).toMatchObject({
      canSweep: true,
      title: "Sweep manually",
    })
  })

  it("offers nothing once the funds have left the address or never arrived", () => {
    const sweepTxHash = `0x${"03".repeat(32)}` as Hex
    expect(depositDetailOffer({ ...fresh, sweepTxHash }, cleared)).toBeNull()
    expect(depositDetailOffer({ ...stuck, sweepTxHash }, cleared)).toBeNull()
    expect(
      depositDetailOffer(
        { ...fresh, phase: "pendingClaim", inboxIndex: "7", netAmount: "17" },
        cleared,
      ),
    ).toBeNull()
    expect(depositDetailOffer({ ...fresh, phase: "broadcast", amount: "0" }, cleared)).toBeNull()
    expect(depositDetailOffer({ ...stuck, phase: "broadcast", amount: "0" }, cleared)).toBeNull()
  })
})
