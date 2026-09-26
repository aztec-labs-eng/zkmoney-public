import { describe, expect, it, vi } from "vitest"
import { DepositExitError } from "@obsidion/sdk"
import { enumerateDepositExitCandidates } from "../../../src/core/services/deposits/depositExitCandidates"
import type { RefundDepositL1Reads } from "../../../src/core/services/deposits/refundableDeposits"
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

function makeL1Reads(
  sweeps: Record<
    string,
    Array<{ index: bigint; amount: bigint; txHash: string; blockNumber?: bigint }>
  >,
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

const fakePath = () => vi.fn(async (leafIndex: bigint) => [`0xpath:${leafIndex}`])

describe("enumerateDepositExitCandidates", () => {
  it("turns a swept-unclaimed record into one hex candidate with log net amount + sibling path", async () => {
    const sipa = "0x1111111111111111111111111111111111111111"
    const buildSiblingPath = fakePath()
    const out = await enumerateDepositExitCandidates({
      records: [makeRecord({ sipaAddress: sipa })],
      recipientL2Address: RECIPIENT,
      l1Reads: makeL1Reads({
        [sipa]: [{ index: 7n, amount: 690n, txHash: "0xt", blockNumber: 123n }],
      }),
      buildSiblingPath,
    })

    expect(out.residuals).toEqual([])
    expect(out.candidates).toEqual([
      {
        sipaAddress: sipa,
        messageSecret: "0x0abc",
        messageKey: "mk:7",
        messageLeafIndex: "7",
        amount: "690",
        inboxSiblingPath: ["0xpath:7"],
      },
    ])
    // Anchored on the sweep's L1 block.
    expect(buildSiblingPath).toHaveBeenCalledWith(7n, 123n)
  })

  it("re-includes a locally-claimed sweep index (migration mode is always on)", async () => {
    const sipa = "0x1111111111111111111111111111111111111111"
    const out = await enumerateDepositExitCandidates({
      records: [makeRecord({ sipaAddress: sipa, phase: "claimed", claimedInboxIndexes: ["4"] })],
      recipientL2Address: RECIPIENT,
      l1Reads: makeL1Reads({ [sipa]: [{ index: 4n, amount: 100n, txHash: "0xc" }] }),
      buildSiblingPath: fakePath(),
    })
    expect(out.candidates.map((c) => c.messageLeafIndex)).toEqual(["4"])
  })

  it("throws DepositExitError transient when the sweep read fails", async () => {
    const l1: RefundDepositL1Reads<string> = {
      readSweepEvents: vi.fn(async () => {
        throw new Error("rpc down")
      }),
      readDepositMessageKey: vi.fn(async (_tx, index) => `mk:${index}`),
    }
    const err = await enumerateDepositExitCandidates({
      records: [makeRecord({})],
      recipientL2Address: RECIPIENT,
      l1Reads: l1,
      buildSiblingPath: fakePath(),
    }).catch((e) => e)
    expect(err).toBeInstanceOf(DepositExitError)
    expect(err.reason).toBe("transient")
    // Sanitized message; the raw error only on cause.
    expect(String(err.message)).not.toContain("rpc down")
    expect(String((err.cause as Error).message)).toContain("rpc down")
  })

  it("throws DepositExitError transient when the message-key read fails", async () => {
    const sipa = "0x1111111111111111111111111111111111111111"
    const l1: RefundDepositL1Reads<string> = {
      readSweepEvents: vi.fn(async () => [{ index: 1n, amount: 10n, txHash: "0xa" }]),
      readDepositMessageKey: vi.fn(async () => {
        throw new Error("receipt read failed")
      }),
    }
    const err = await enumerateDepositExitCandidates({
      records: [makeRecord({ sipaAddress: sipa })],
      recipientL2Address: RECIPIENT,
      l1Reads: l1,
      buildSiblingPath: fakePath(),
    }).catch((e) => e)
    expect(err).toBeInstanceOf(DepositExitError)
    expect(err.reason).toBe("transient")
  })

  it("throws DepositExitError transient when the sibling-path build fails", async () => {
    const sipa = "0x1111111111111111111111111111111111111111"
    const err = await enumerateDepositExitCandidates({
      records: [makeRecord({ sipaAddress: sipa })],
      recipientL2Address: RECIPIENT,
      l1Reads: makeL1Reads({ [sipa]: [{ index: 1n, amount: 10n, txHash: "0xa" }] }),
      buildSiblingPath: vi.fn(async () => {
        throw new Error("subtree incomplete")
      }),
    }).catch((e) => e)
    expect(err).toBeInstanceOf(DepositExitError)
    expect(err.reason).toBe("transient")
  })

  it("surfaces a record with no message secret as a residual, keeping other candidates", async () => {
    const bare = "0xbbbb000000000000000000000000000000000000"
    const unswept = "0xcccc000000000000000000000000000000000000"
    const good = "0x1111111111111111111111111111111111111111"
    const out = await enumerateDepositExitCandidates({
      records: [
        makeRecord({ sipaAddress: bare, messageSecret: "" }),
        makeRecord({ sipaAddress: unswept, messageSecret: "", phase: "funding" }),
        // Foreign no-secret records belong to another recipient's enumeration.
        makeRecord({
          sipaAddress: "0xdddd000000000000000000000000000000000000",
          messageSecret: "",
          recipientL2Address: "0x5555",
        }),
        makeRecord({ sipaAddress: good }),
      ],
      recipientL2Address: RECIPIENT,
      l1Reads: makeL1Reads({ [good]: [{ index: 2n, amount: 20n, txHash: "0xg" }] }),
      buildSiblingPath: fakePath(),
    })
    expect(out.residuals).toEqual([
      { sipaAddress: bare, reason: "missing-message-secret" },
      { sipaAddress: unswept, reason: "missing-message-secret" },
    ])
    expect(out.candidates.map((c) => c.sipaAddress)).toEqual([good])
  })

  it("names a secret-less record as a residual even when its local phase is not swept", async () => {
    // Migration mode ignores local phase for candidates, so the residual filter must too —
    // otherwise an on-chain-swept record with a stale phase and no secret escapes both lists.
    const stale = "0xbbbb000000000000000000000000000000000000"
    const out = await enumerateDepositExitCandidates({
      records: [makeRecord({ sipaAddress: stale, messageSecret: "", phase: "sweeping" })],
      recipientL2Address: RECIPIENT,
      l1Reads: makeL1Reads({ [stale]: [{ index: 3n, amount: 30n, txHash: "0xs" }] }),
      buildSiblingPath: fakePath(),
    })
    expect(out.residuals).toEqual([{ sipaAddress: stale, reason: "missing-message-secret" }])
    expect(out.candidates).toEqual([])
  })

  it("names a sweep whose message key cannot be read as a residual, keeping the rest", async () => {
    const sipa = "0x1111111111111111111111111111111111111111"
    const out = await enumerateDepositExitCandidates({
      records: [makeRecord({ sipaAddress: sipa })],
      recipientL2Address: RECIPIENT,
      l1Reads: makeL1Reads(
        {
          [sipa]: [
            { index: 1n, amount: 10n, txHash: "0xa" },
            { index: 2n, amount: 20n, txHash: "0xb" },
          ],
        },
        { "0xa:1": null },
      ),
      buildSiblingPath: fakePath(),
    })
    expect(out.candidates.map((c) => c.messageLeafIndex)).toEqual(["2"])
    expect(out.residuals).toEqual([{ sipaAddress: sipa, reason: "message-key-unreadable" }])
  })
})
