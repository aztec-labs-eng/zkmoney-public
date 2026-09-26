import { describe, expect, it, vi } from "vitest"
import {
  enumerateRefundableDeposits,
  scanRefundableDeposits,
  type RefundableSipaSource,
  type RefundDepositL1Reads,
} from "../../../src/core/services/deposits/refundableDeposits"
import type { SIPADepositRecord } from "../../../src/core/services/deposits/SIPADepositStore"

const RECIPIENT = "0x2222222222222222222222222222222222222222222222222222222222222222"

function makeRecord(patch: Partial<SIPADepositRecord>): SIPADepositRecord {
  return {
    sipaAddress: "0x1111111111111111111111111111111111111111",
    recipientL2Address: RECIPIENT,
    messageSecret: "0x0abc",
    recipientHash: "0x0d",
    recoveryAddress: "0x3333333333333333333333333333333333333333",
    l1ChainId: 31337,
    amount: "100",
    tokenSymbol: "DAI",
    phase: "pendingClaim",
    startTime: 0,
    ...patch,
  } as SIPADepositRecord
}

/** Sweep/Deposit logs per SIPA address; messageKey per `${txHash}:${index}`. */
function makeL1Reads(
  sweeps: Record<string, Array<{ index: bigint; amount: bigint; txHash: string }>>,
  messageKeys: Record<string, string | null> = {},
): RefundDepositL1Reads<string> {
  return {
    readSweepEvents: vi.fn(async (sipa: string) => sweeps[sipa] ?? []),
    readDepositMessageKey: vi.fn(async (txHash: string, index: bigint) => {
      const key = `${txHash}:${index}`
      return key in messageKeys ? messageKeys[key] : `mk:${index}`
    }),
  }
}

describe("enumerateRefundableDeposits", () => {
  it("uses SIPA-event sources without any wallet record", async () => {
    const sipa = "0x1111111111111111111111111111111111111111"
    const sources: RefundableSipaSource[] = [
      {
        sipaAddress: sipa,
        recipientL2Address: RECIPIENT,
        messageSecret: "0x0abc",
        origin: "sipa-event",
      },
    ]
    const l1 = makeL1Reads({
      [sipa]: [{ index: 7n, amount: 690n, txHash: "0xswept" }],
    })

    const out = await enumerateRefundableDeposits({ sources, l1Reads: l1 })

    expect(out).toHaveLength(1)
    expect(out[0]?.messageLeafIndex).toBe(7n)
  })

  it("chain-only scan reports in-transit balances and excludes consumed sweeps", async () => {
    const swept = "0x1111111111111111111111111111111111111111"
    const funded = "0x2222222222222222222222222222222222222222"
    const sources: RefundableSipaSource[] = [swept, funded].map((sipaAddress, index) => ({
      sipaAddress,
      recipientL2Address: RECIPIENT,
      messageSecret: `0x0${index + 1}`,
      origin: "sipa-event",
    }))
    const l1 = makeL1Reads({
      [swept]: [
        { index: 7n, amount: 690n, txHash: "0xunclaimed" },
        { index: 8n, amount: 10n, txHash: "0xclaimed" },
      ],
    })

    const result = await scanRefundableDeposits({
      sources,
      l1Reads: l1,
      readSipaBalance: async (address) => (address === funded ? 500n : 0n),
      isClaimed: async (deposit) => deposit.messageLeafIndex === 8n,
    })

    expect(result.refundable.map((deposit) => deposit.messageLeafIndex)).toEqual([7n])
    expect(result.inTransit).toEqual([{ source: sources[1], balance: 500n }])
  })

  it("yields only swept-but-unclaimed records from a mixed-phase store", async () => {
    const sipa = "0x1111111111111111111111111111111111111111"
    const claimedSipa = "0x7777777777777777777777777777777777777777"
    const records = [
      // Fully claimed: still scanned (a topped-up SIPA can be re-swept) but every index dedups.
      makeRecord({ sipaAddress: claimedSipa, phase: "claimed", claimedInboxIndexes: ["4"] }),
      makeRecord({
        sipaAddress: sipa,
        phase: "pendingClaim",
        sweepTxHash: "0xswept" as any,
      }),
      makeRecord({
        sipaAddress: "0x9999999999999999999999999999999999999999",
        phase: "recoverable",
      }),
    ]
    const l1 = makeL1Reads({
      [sipa]: [{ index: 7n, amount: 690n, txHash: "0xswept" }],
      [claimedSipa]: [{ index: 4n, amount: 100n, txHash: "0xold" }],
    })

    const out = await enumerateRefundableDeposits({
      records,
      l1Reads: l1,
      recipientL2Address: RECIPIENT,
    })

    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      sipaAddress: sipa,
      l2Recipient: RECIPIENT,
      messageSecret: "0x0abc",
      messageKey: "mk:7",
      messageLeafIndex: 7n,
      amount: 690n,
    })
    // The recoverable record never reaches L1 reads; claimed and pendingClaim both scan.
    expect(l1.readSweepEvents).toHaveBeenCalledTimes(2)
  })

  it("migration mode surfaces a locally-claimed sweep index (local claim state can lie at freeze)", async () => {
    const sipa = "0x1111111111111111111111111111111111111111"
    const records = [
      makeRecord({ sipaAddress: sipa, phase: "claimed", claimedInboxIndexes: ["4"] }),
    ]
    const l1 = makeL1Reads({ [sipa]: [{ index: 4n, amount: 100n, txHash: "0xc" }] })

    const withoutMode = await enumerateRefundableDeposits({
      records,
      l1Reads: l1,
      recipientL2Address: RECIPIENT,
    })
    const withMode = await enumerateRefundableDeposits({
      records,
      l1Reads: l1,
      recipientL2Address: RECIPIENT,
      includeLocallyClaimed: true,
    })

    expect(withoutMode).toEqual([])
    expect(withMode.map((d) => d.messageLeafIndex)).toEqual([4n])
  })

  it("migration mode ignores the local phase gate — an un-advanced record is refundable if L1 shows a Sweep", async () => {
    const sipa = "0x1111111111111111111111111111111111111111"
    // Sweep landed on L1 but the local record never advanced past `broadcast` (no sweepTxHash),
    // so the phase gate would strand it — migration mode lets the L1 Sweep read decide instead.
    const records = [makeRecord({ sipaAddress: sipa, phase: "broadcast", sweepTxHash: undefined })]
    const l1 = makeL1Reads({ [sipa]: [{ index: 6n, amount: 60n, txHash: "0xf" }] })

    const withoutMode = await enumerateRefundableDeposits({
      records,
      l1Reads: l1,
      recipientL2Address: RECIPIENT,
    })
    const withMode = await enumerateRefundableDeposits({
      records,
      l1Reads: l1,
      recipientL2Address: RECIPIENT,
      includeLocallyClaimed: true,
    })

    expect(withoutMode).toEqual([])
    expect(withMode.map((d) => d.messageLeafIndex)).toEqual([6n])
  })

  it("surfaces an unclaimed top-up sweep on a claimed-phase record", async () => {
    const sipa = "0x1111111111111111111111111111111111111111"
    const records = [
      // Terminal phase, but the SIPA was re-swept after the claim: index 9 is refundable.
      makeRecord({ sipaAddress: sipa, phase: "claimed", claimedInboxIndexes: ["3"] }),
    ]
    const l1 = makeL1Reads({
      [sipa]: [
        { index: 3n, amount: 100n, txHash: "0xsweep1" },
        { index: 9n, amount: 250n, txHash: "0xsweep2" },
      ],
    })

    const out = await enumerateRefundableDeposits({
      records,
      l1Reads: l1,
      recipientL2Address: RECIPIENT,
    })

    expect(out.map((d) => d.messageLeafIndex)).toEqual([9n])
  })

  it("is sweep-index granular: a topped-up SIPA yields only its unclaimed indexes", async () => {
    const sipa = "0x1111111111111111111111111111111111111111"
    const records = [
      makeRecord({ sipaAddress: sipa, phase: "pendingClaim", claimedInboxIndexes: ["3"] }),
    ]
    const l1 = makeL1Reads({
      [sipa]: [
        { index: 3n, amount: 100n, txHash: "0xsweep1" },
        { index: 9n, amount: 250n, txHash: "0xsweep2" },
      ],
    })

    const out = await enumerateRefundableDeposits({
      records,
      l1Reads: l1,
      recipientL2Address: RECIPIENT,
    })

    expect(out.map((d) => d.messageLeafIndex)).toEqual([9n])
    expect(out[0].amount).toBe(250n)
  })

  it("emits the sweep's net amount, not the record's gross display amount", async () => {
    const sipa = "0x1111111111111111111111111111111111111111"
    const records = [makeRecord({ sipaAddress: sipa, amount: "1000", netAmount: "990" })]
    const l1 = makeL1Reads({ [sipa]: [{ index: 1n, amount: 990n, txHash: "0xt" }] })

    const out = await enumerateRefundableDeposits({
      records,
      l1Reads: l1,
      recipientL2Address: RECIPIENT,
    })

    expect(out[0].amount).toBe(990n)
  })

  it("reports a sweep whose Deposit log cannot be matched, keeping the rest", async () => {
    const sipa = "0x1111111111111111111111111111111111111111"
    const records = [makeRecord({ sipaAddress: sipa })]
    const l1 = makeL1Reads(
      {
        [sipa]: [
          { index: 1n, amount: 10n, txHash: "0xa" },
          { index: 2n, amount: 20n, txHash: "0xb" },
        ],
      },
      { "0xa:1": null },
    )

    const onUnreadableMessageKey = vi.fn()
    const out = await enumerateRefundableDeposits({
      records,
      l1Reads: l1,
      recipientL2Address: RECIPIENT,
      onUnreadableMessageKey,
    })

    expect(out.map((d) => d.messageLeafIndex)).toEqual([2n])
    expect(onUnreadableMessageKey).toHaveBeenCalledTimes(1)
    expect(onUnreadableMessageKey).toHaveBeenCalledWith(sipa)
  })

  it("isolates a record whose L1 read throws", async () => {
    const bad = "0xbad0000000000000000000000000000000000000"
    const good = "0x1111111111111111111111111111111111111111"
    const records = [makeRecord({ sipaAddress: bad }), makeRecord({ sipaAddress: good })]
    const l1: RefundDepositL1Reads<string> = {
      readSweepEvents: vi.fn(async (sipa: string) => {
        if (sipa === bad) throw new Error("rpc down")
        return [{ index: 5n, amount: 55n, txHash: "0xg" }]
      }),
      readDepositMessageKey: vi.fn(async (_tx, index) => `mk:${index}`),
    }

    const out = await enumerateRefundableDeposits({
      records,
      l1Reads: l1,
      recipientL2Address: RECIPIENT,
    })

    expect(out.map((d) => d.sipaAddress)).toEqual([good])
  })

  it("includes sweeping only once the sweep tx is known", async () => {
    const confirmed = "0x1111111111111111111111111111111111111111"
    const pending = "0x4444444444444444444444444444444444444444"
    const records = [
      makeRecord({ sipaAddress: confirmed, phase: "sweeping", sweepTxHash: "0xs" as any }),
      makeRecord({ sipaAddress: pending, phase: "sweeping" }),
    ]
    const l1 = makeL1Reads({ [confirmed]: [{ index: 4n, amount: 40n, txHash: "0xs" }] })

    const out = await enumerateRefundableDeposits({
      records,
      l1Reads: l1,
      recipientL2Address: RECIPIENT,
    })

    expect(out.map((d) => d.sipaAddress)).toEqual([confirmed])
    expect(l1.readSweepEvents).toHaveBeenCalledTimes(1)
  })

  it("isolates a throwing message-key read to that sweep, keeping siblings", async () => {
    const sipa = "0x1111111111111111111111111111111111111111"
    const records = [makeRecord({ sipaAddress: sipa })]
    const l1: RefundDepositL1Reads<string> = {
      readSweepEvents: vi.fn(async () => [
        { index: 1n, amount: 10n, txHash: "0xa" },
        { index: 2n, amount: 20n, txHash: "0xb" },
      ]),
      readDepositMessageKey: vi.fn(async (txHash: string, index: bigint) => {
        if (index === 1n) throw new Error("receipt read failed")
        return `mk:${index}`
      }),
    }

    const out = await enumerateRefundableDeposits({
      records,
      l1Reads: l1,
      recipientL2Address: RECIPIENT,
    })

    expect(out.map((d) => d.messageLeafIndex)).toEqual([2n])
  })

  it("matches the recipient case-insensitively", async () => {
    const sipa = "0x1111111111111111111111111111111111111111"
    const records = [makeRecord({ sipaAddress: sipa, recipientL2Address: RECIPIENT.toUpperCase() })]
    const l1 = makeL1Reads({ [sipa]: [{ index: 1n, amount: 10n, txHash: "0xt" }] })

    const out = await enumerateRefundableDeposits({
      records,
      l1Reads: l1,
      recipientL2Address: RECIPIENT,
    })

    expect(out).toHaveLength(1)
  })

  it("excludes a swept record with no persisted message secret", async () => {
    const sipa = "0x1111111111111111111111111111111111111111"
    const records = [makeRecord({ sipaAddress: sipa, messageSecret: "" })]
    const l1 = makeL1Reads({ [sipa]: [{ index: 1n, amount: 10n, txHash: "0xt" }] })

    const out = await enumerateRefundableDeposits({
      records,
      l1Reads: l1,
      recipientL2Address: RECIPIENT,
    })

    expect(out).toEqual([])
    expect(l1.readSweepEvents).not.toHaveBeenCalled()
  })

  it("only considers records bound to the migrating account", async () => {
    const records = [makeRecord({ recipientL2Address: "0x5555" })]
    const l1 = makeL1Reads({})

    const out = await enumerateRefundableDeposits({
      records,
      l1Reads: l1,
      recipientL2Address: RECIPIENT,
    })

    expect(out).toEqual([])
    expect(l1.readSweepEvents).not.toHaveBeenCalled()
  })

  it("returns empty for an empty record set", async () => {
    const out = await enumerateRefundableDeposits({
      records: [],
      l1Reads: makeL1Reads({}),
      recipientL2Address: RECIPIENT,
    })
    expect(out).toEqual([])
  })
})
