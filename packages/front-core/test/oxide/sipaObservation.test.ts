// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"

const h = vi.hoisted(() => ({
  readPortalDeposits: vi.fn(),
  readTokenTransfers: vi.fn(),
  readSipaBalancesMany: vi.fn(),
}))
vi.mock("@obsidion/sdk", () => ({
  readPortalDeposits: h.readPortalDeposits,
  readTokenTransfers: h.readTokenTransfers,
  readSipaBalancesMany: h.readSipaBalancesMany,
}))

import { observeSipas } from "../../src/oxide/sipaObservation"

const PORTAL = "0x00000000000000000000000000000000000000a0" as Address
const DAI = "0x00000000000000000000000000000000000000d1" as Address
const RELAYER = "0x00000000000000000000000000000000000000e1" as Address
const SIPA_A = "0x00000000000000000000000000000000000000aa" as Address
const SIPA_B = "0x00000000000000000000000000000000000000bb" as Address
const COMMIT_A = `0x${"0a".repeat(32)}` as Hex
const COMMIT_B = `0x${"0b".repeat(32)}` as Hex
const HEAD = 1_000n

const deposit = (commitment: Hex, index: bigint, txHash: Hex, blockNumber = 900n) => ({
  recipientCommitment: commitment,
  amount: 10n * index,
  key: `0x${index.toString(16).padStart(64, "0")}` as Hex,
  index,
  blockNumber,
  txHash,
  logIndex: 0,
})
const transfer = (from: Address, to: Address, txHash: Hex, value = 5n) => ({
  token: DAI,
  from,
  to,
  value,
  blockNumber: 900n,
  txHash,
  logIndex: 1,
})

beforeEach(() => {
  h.readPortalDeposits.mockReset().mockResolvedValue([])
  h.readTokenTransfers.mockReset().mockResolvedValue([])
  h.readSipaBalancesMany.mockReset().mockResolvedValue(new Map())
})

describe("observeSipas", () => {
  it("gives each SIPA the deposits to its commitment, with their claim inputs", async () => {
    h.readPortalDeposits.mockResolvedValue([
      deposit(COMMIT_A, 7n, "0x01"),
      deposit(COMMIT_B, 8n, "0x02"),
    ])
    h.readTokenTransfers.mockImplementation(async (_c: unknown, _t: unknown, side: string) =>
      side === "from" ? [transfer(SIPA_A, RELAYER, "0x01"), transfer(SIPA_B, RELAYER, "0x02")] : [],
    )

    const { observed } = await observeSipas({} as never, {
      portal: PORTAL,
      tokens: [DAI],
      head: HEAD,
      subjects: [
        { address: SIPA_A, commitment: COMMIT_A, fromBlock: 800n, inflows: false },
        { address: SIPA_B, commitment: COMMIT_B, fromBlock: 800n, inflows: false },
      ],
    })

    expect(h.readPortalDeposits).toHaveBeenCalledOnce()
    expect(h.readPortalDeposits).toHaveBeenCalledWith({}, PORTAL, [COMMIT_A, COMMIT_B], 800n, HEAD)
    expect(observed.get(SIPA_A)!.sweeps).toEqual([
      {
        index: 7n,
        amount: 70n,
        messageKey: deposit(COMMIT_A, 7n, "0x01").key,
        blockNumber: 900n,
        txHash: "0x01",
      },
    ])
    expect(observed.get(SIPA_B)!.sweeps.map((s) => s.index)).toEqual([8n])
  })

  it("names the SIPA that swept a shared commitment by the transfer out in the deposit's transaction", async () => {
    h.readPortalDeposits.mockResolvedValue([deposit(COMMIT_A, 7n, "0x01")])
    h.readTokenTransfers.mockImplementation(async (_c: unknown, _t: unknown, side: string) =>
      side === "from" ? [transfer(SIPA_B, RELAYER, "0x01")] : [],
    )

    const { observed } = await observeSipas({} as never, {
      portal: PORTAL,
      tokens: [DAI],
      head: HEAD,
      subjects: [
        { address: SIPA_A, commitment: COMMIT_A, fromBlock: 800n, inflows: false },
        { address: SIPA_B, commitment: COMMIT_A, fromBlock: 800n, inflows: false },
      ],
    })

    expect(observed.get(SIPA_A)!.sweeps).toEqual([])
    expect(observed.get(SIPA_B)!.sweeps.map((s) => s.index)).toEqual([7n])
  })

  it("reads a transfer out with no sweep in its transaction as a recovery", async () => {
    h.readPortalDeposits.mockResolvedValue([deposit(COMMIT_A, 7n, "0x01")])
    h.readTokenTransfers.mockImplementation(async (_c: unknown, _t: unknown, side: string) =>
      side === "from"
        ? [
            transfer(SIPA_A, RELAYER, "0x01"),
            transfer(SIPA_A, "0x00000000000000000000000000000000000000f0", "0x02"),
          ]
        : [],
    )

    const { observed } = await observeSipas({} as never, {
      portal: PORTAL,
      tokens: [DAI],
      head: HEAD,
      subjects: [{ address: SIPA_A, commitment: COMMIT_A, fromBlock: 800n, inflows: false }],
    })

    expect(observed.get(SIPA_A)!.outflows).toHaveLength(2)
    expect(observed.get(SIPA_A)!.recoveries.map((r) => r.txHash)).toEqual(["0x02"])
  })

  it("reads what funded only the SIPAs that ask, and leaves the rest without inflows", async () => {
    h.readTokenTransfers.mockImplementation(
      async (_c: unknown, _t: unknown, side: string, sipas: Address[]) =>
        side === "to"
          ? sipas.map((sipa) =>
              transfer("0x00000000000000000000000000000000000000c0", sipa, "0x03"),
            )
          : [],
    )

    const { observed } = await observeSipas({} as never, {
      portal: PORTAL,
      tokens: [DAI],
      head: HEAD,
      subjects: [
        { address: SIPA_A, commitment: COMMIT_A, fromBlock: 800n, inflows: true },
        { address: SIPA_B, commitment: COMMIT_B, fromBlock: 800n, inflows: false },
      ],
    })

    const inflowReads = h.readTokenTransfers.mock.calls.filter((c) => c[2] === "to")
    expect(inflowReads.map((c) => c[3])).toEqual([[SIPA_A]])
    expect(observed.get(SIPA_A)!.inflows).toHaveLength(1)
    expect(observed.get(SIPA_B)!.inflows).toBeUndefined()
  })

  it("reads each window once for all its SIPAs, and SIPAs sharing a commitment from the earliest", async () => {
    await observeSipas({} as never, {
      portal: PORTAL,
      tokens: [DAI],
      head: HEAD,
      subjects: [
        { address: SIPA_A, commitment: COMMIT_A, fromBlock: 990n, inflows: false },
        { address: SIPA_B, commitment: COMMIT_A, fromBlock: 10n, inflows: false },
        {
          address: "0x00000000000000000000000000000000000000cc",
          commitment: COMMIT_B,
          fromBlock: 990n,
          inflows: false,
        },
      ],
    })

    const windows = h.readPortalDeposits.mock.calls.map((c) => [c[2], c[3]])
    expect(windows.sort((a, b) => Number(a[1] - b[1]))).toEqual(
      expect.arrayContaining([
        [[COMMIT_A, COMMIT_A], 10n],
        [[COMMIT_B], 990n],
      ]),
    )
    expect(h.readSipaBalancesMany).toHaveBeenCalledOnce()
  })

  it("leaves out the SIPAs of a window that failed, and observes the rest", async () => {
    h.readPortalDeposits.mockImplementation(
      async (_c: unknown, _p: unknown, _commitments: Hex[], from: bigint) => {
        if (from === 10n) throw new Error("request failed")
        return [deposit(COMMIT_B, 8n, "0x02")]
      },
    )
    h.readTokenTransfers.mockImplementation(async (_c: unknown, _t: unknown, side: string) =>
      side === "from" ? [transfer(SIPA_B, RELAYER, "0x02")] : [],
    )

    const { observed } = await observeSipas({} as never, {
      portal: PORTAL,
      tokens: [DAI],
      head: HEAD,
      subjects: [
        { address: SIPA_A, commitment: COMMIT_A, fromBlock: 10n, inflows: false },
        { address: SIPA_B, commitment: COMMIT_B, fromBlock: 990n, inflows: false },
      ],
    })

    expect(observed.has(SIPA_A)).toBe(false)
    expect(observed.get(SIPA_B)!.sweeps.map((s) => s.index)).toEqual([8n])
  })

  it("hands back a deposit to a tracked commitment that no tracked SIPA sent", async () => {
    h.readPortalDeposits.mockResolvedValue([
      deposit(COMMIT_A, 7n, "0x01"),
      deposit(COMMIT_A, 8n, "0x02"),
    ])
    h.readTokenTransfers.mockImplementation(async (_c: unknown, _t: unknown, side: string) =>
      side === "from" ? [transfer(SIPA_A, RELAYER, "0x01")] : [],
    )

    const { observed, strays } = await observeSipas({} as never, {
      portal: PORTAL,
      tokens: [DAI],
      head: HEAD,
      subjects: [
        { address: SIPA_A, commitment: COMMIT_A, fromBlock: 800n, inflows: false },
        { address: SIPA_B, commitment: COMMIT_A, fromBlock: 800n, inflows: false },
      ],
    })

    expect(observed.get(SIPA_A)!.sweeps.map((s) => s.index)).toEqual([7n])
    expect(strays.map((d) => d.index)).toEqual([8n])
  })

  it("leaves holdings unknown when their read fails, and still observes the logs", async () => {
    h.readSipaBalancesMany.mockRejectedValue(new Error("rpc down"))
    h.readPortalDeposits.mockResolvedValue([deposit(COMMIT_A, 7n, "0x01")])
    h.readTokenTransfers.mockImplementation(async (_c: unknown, _t: unknown, side: string) =>
      side === "from" ? [transfer(SIPA_A, RELAYER, "0x01")] : [],
    )

    const { observed } = await observeSipas({} as never, {
      portal: PORTAL,
      tokens: [DAI],
      head: HEAD,
      subjects: [{ address: SIPA_A, commitment: COMMIT_A, fromBlock: 800n, inflows: false }],
    })

    expect(observed.get(SIPA_A)!.balances).toBeUndefined()
    expect(observed.get(SIPA_A)!.sweeps).toHaveLength(1)
  })
})
