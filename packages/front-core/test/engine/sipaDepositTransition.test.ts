import { describe, expect, it } from "vitest"
import type { Address, Hash } from "viem"
import type { SIPADepositPhase } from "@obsidion/core/types"
import {
  sipaDepositTransition,
  type SipaDepositEvent,
} from "../../src/engine/sipaDepositTransition"
import type { SipaDeposit, SIPASweep } from "../../src/engine/sipaDeposits"

const NOW = 1_000_000
const SIPA = "0x00000000000000000000000000000000000000a1" as Address
const HASH = `0x${"ab".repeat(32)}` as Hash
const OTHER_HASH = `0x${"cd".repeat(32)}` as Hash
const NETWORK = "0x00000000000000000000000000000000000000E1"

const PHASES: SIPADepositPhase[] = [
  "resolved",
  "funding",
  "funded",
  "broadcast",
  "sweeping",
  "pendingClaim",
  "claimed",
  "failed",
  "recoverable",
  "recovered",
]
const SETTLED = new Set<SIPADepositPhase>(["claimed", "failed", "recovered"])
const BEFORE_SWEEP = new Set<SIPADepositPhase>(["resolved", "funding", "funded", "broadcast"])

const record = (over: Partial<SipaDeposit> = {}): SipaDeposit => ({
  sipaAddress: SIPA,
  version: 2,
  recipientL2Address: "0xrecipient",
  messageSecret: "0xsecret",
  recipientHash: "0xhash",
  recoveryAddress: "0xrecovery",
  l1ChainId: 1,
  networkId: NETWORK.toLowerCase(),
  amount: "0",
  tokenSymbol: "DAI",
  phase: "broadcast",
  startTime: 1,
  ...over,
})

const sweep = (inboxIndex: string): SIPASweep => ({
  inboxIndex,
  sweepTxHash: HASH,
  netAmount: "5",
})

/**
 * Every event, and the phase it leaves a record in from each phase: a phase, `undefined` when the
 * record is left as it is, or `null` when it goes.
 */
const TABLE: [
  string,
  SipaDepositEvent,
  (from: SIPADepositPhase) => SIPADepositPhase | null | undefined,
][] = [
  ["derived", { type: "derived", fields: { ...record(), networkId: NETWORK } }, () => undefined],
  ["seeded", { type: "seeded", fields: { ...record(), networkId: NETWORK } }, () => undefined],
  [
    "rotationSeeded",
    { type: "rotationSeeded", fields: { ...record(), networkId: NETWORK } },
    () => undefined,
  ],
  [
    "discovered",
    { type: "discovered", fields: { ...record(), networkId: NETWORK } },
    () => undefined,
  ],
  [
    "directBatch",
    { type: "directBatch", fields: { ...record(), networkId: NETWORK } },
    () => undefined,
  ],
  ["imported", { type: "imported", fields: { ...record(), networkId: NETWORK } }, () => undefined],
  [
    "observed, no funds",
    { type: "observed", fields: { phase: "sweeping" } },
    (from) => (SETTLED.has(from) ? from : "sweeping"),
  ],
  [
    "observed, new funds",
    { type: "observed", fields: { phase: "sweeping", amount: "3" } },
    () => "sweeping",
  ],
  ["misfiled", { type: "misfiled" }, () => undefined],
  ["republishDue", { type: "republishDue", at: NOW }, (from) => from],
  [
    "sweepRowsStamped",
    {
      type: "sweepRowsStamped",
      networkId: NETWORK,
      pinned: {
        portal: SIPA,
        l2Token: "0xl2",
        token: { address: SIPA, symbol: "DAI", decimals: 18 },
      },
    },
    () => undefined,
  ],
  ["claimLanded", { type: "claimLanded", inboxIndex: "7", at: NOW }, (from) => from],
  ["claimed", { type: "claimed", sweep: sweep("7") }, () => "claimed"],
  [
    "shown",
    { type: "shown", at: NOW },
    (from) => (from === "broadcast" || from === "resolved" ? from : undefined),
  ],
  ["fundingSent", { type: "fundingSent", fields: { fundingTxHash: HASH } }, (from) => from],
  [
    "sweepSent",
    { type: "sweepSent", txHash: HASH },
    (from) => (BEFORE_SWEEP.has(from) ? "sweeping" : from),
  ],
  ["recoverySent", { type: "recoverySent", txHash: HASH }, (from) => from],
  [
    "recoverySent, confirmed",
    { type: "recoverySent", txHash: HASH, confirmed: true },
    () => "recovered",
  ],
  [
    "recoverySent, if unsettled",
    { type: "recoverySent", txHash: HASH, confirmed: true, ifUnsettled: true },
    (from) => (SETTLED.has(from) ? undefined : "recovered"),
  ],
  ["recoveryReverted", { type: "recoveryReverted", txHash: OTHER_HASH }, () => undefined],
  ["reentered", { type: "reentered" }, (from) => (from === "recovered" ? "broadcast" : undefined)],
]

describe("sipaDepositTransition: every event from every phase", () => {
  for (const [name, event, expected] of TABLE) {
    it.each(PHASES)(`${name} from %s`, (from) => {
      const next = sipaDepositTransition(record({ phase: from }), event, NOW)
      const want = expected(from)
      if (want === undefined) expect(next).toBeUndefined()
      else if (want === null) expect(next).toBeNull()
      else expect(next?.phase).toBe(want)
    })
  }
})

describe("sipaDepositTransition", () => {
  it("creates a record only from a creation event, stamped with its network in lowercase", () => {
    const fields = { ...record({ phase: "claimed" }), networkId: NETWORK }
    expect(sipaDepositTransition(undefined, { type: "discovered", fields }, NOW)).toMatchObject({
      networkId: NETWORK.toLowerCase(),
      endTime: NOW,
    })
    expect(sipaDepositTransition(undefined, { type: "shown", at: NOW }, NOW)).toBeUndefined()
    expect(() =>
      sipaDepositTransition(
        undefined,
        { type: "seeded", fields: { ...fields, networkId: "" } },
        NOW,
      ),
    ).toThrow()
  })

  it("fills only the empty fields of an existing record; a seed also fills its fee", () => {
    const held = record({ messageSecret: "", origin: undefined, registrationFee: undefined })
    const fields = {
      ...record({ messageSecret: "0xnew", recipientHash: "0xother", registrationFee: "140" }),
      networkId: NETWORK,
    }
    expect(sipaDepositTransition(held, { type: "discovered", fields }, NOW)).toMatchObject({
      messageSecret: "0xnew",
      recipientHash: "0xhash",
      registrationFee: undefined,
    })
    expect(sipaDepositTransition(held, { type: "seeded", fields }, NOW)).toMatchObject({
      registrationFee: "140",
    })
  })

  it("gives a direct deposit its batch's amount once", () => {
    const direct = { recipientCommitment: "0xc0" as Address }
    const fields = { ...record({ direct: { ...direct, expected: "9" } }), networkId: NETWORK }
    const held = record({ direct })
    expect(sipaDepositTransition(held, { type: "directBatch", fields }, NOW)?.direct).toEqual({
      ...direct,
      expected: "9",
    })
    const priced = record({ direct: { ...direct, expected: "1" } })
    expect(sipaDepositTransition(priced, { type: "directBatch", fields }, NOW)).toBeUndefined()
  })

  it("merges claims and observations in either order", () => {
    const pending = [
      { inboxIndex: "7", amount: "5", messageKey: HASH, blockNumber: "1", sweepTxHash: HASH },
      { inboxIndex: "8", amount: "5", messageKey: HASH, blockNumber: "1", sweepTxHash: HASH },
    ]
    const observed = { type: "observed", fields: { pendingSweeps: pending } } as const
    const claimed = { type: "claimed", sweep: sweep("7") } as const
    const start = record({ phase: "pendingClaim" })
    const a = sipaDepositTransition(sipaDepositTransition(start, observed, NOW)!, claimed, NOW)!
    const b = sipaDepositTransition(sipaDepositTransition(start, claimed, NOW)!, observed, NOW)!
    for (const next of [a, b]) {
      expect(next.claimedInboxIndexes).toEqual(["7"])
      expect(next.pendingSweeps?.map((s) => s.inboxIndex)).toEqual(["8"])
      expect(next.sweeps?.map((s) => s.inboxIndex)).toEqual(["7"])
    }
  })

  it("leaves a record on its newer pending sweep when an older one is claimed", () => {
    const pending = ["7", "8"].map((inboxIndex) => ({
      inboxIndex,
      amount: "5",
      messageKey: HASH,
      blockNumber: "1",
      sweepTxHash: HASH,
    }))
    const start = record({ phase: "pendingClaim", inboxIndex: "8", pendingSweeps: pending })
    const older = {
      type: "claimed",
      sweep: sweep("7"),
    } as const

    const next = sipaDepositTransition(start, older, NOW)!

    expect(next).toMatchObject({
      phase: "pendingClaim",
      inboxIndex: "8",
      claimedInboxIndexes: ["7"],
    })
    expect(next.endTime).toBeUndefined()
    const newer = {
      type: "claimed",
      sweep: sweep("8"),
    } as const
    expect(sipaDepositTransition(next, newer, NOW)).toMatchObject({
      phase: "claimed",
      inboxIndex: "8",
    })
  })

  it("stamps the terminal time once", () => {
    const done = sipaDepositTransition(record(), { type: "claimed", sweep: sweep("7") }, NOW)!
    expect(done.endTime).toBe(NOW)
    const again = sipaDepositTransition(done, { type: "claimed", sweep: sweep("8") }, NOW + 5)!
    expect(again.endTime).toBe(NOW)
    expect(again.claimedInboxIndexes).toEqual(["7", "8"])
  })

  it("removes only a replayed registration record no sweep ever touched", () => {
    const misfiled = record({ intent: "registration", replayed: true })
    expect(sipaDepositTransition(misfiled, { type: "misfiled" }, NOW)).toBeNull()
    const swept = { ...misfiled, sweepTxHash: HASH }
    expect(sipaDepositTransition(swept, { type: "misfiled" }, NOW)).toBeUndefined()
  })

  it("sets a sweep's hash once, and restarts only an unfunded record's clock", () => {
    const sent = sipaDepositTransition(record(), { type: "sweepSent", txHash: HASH }, NOW)!
    expect(sent).toMatchObject({ phase: "sweeping", sweepTxHash: HASH })
    expect(
      sipaDepositTransition(sent, { type: "sweepSent", txHash: OTHER_HASH }, NOW),
    ).toBeUndefined()
    expect(sipaDepositTransition(record(), { type: "shown", at: NOW }, NOW)?.startTime).toBe(NOW)
    const funded = record({ amount: "5" })
    expect(sipaDepositTransition(funded, { type: "shown", at: NOW }, NOW)).toBeUndefined()
  })

  it("names the token a confirmed recovery moved, and clears a reverted one's hash", () => {
    const token = { tokenAddress: SIPA, tokenSymbol: "USDC", tokenDecimals: 6 }
    const recovered = sipaDepositTransition(
      record({ phase: "recoverable" }),
      { type: "recoverySent", txHash: HASH, confirmed: true, token },
      NOW,
    )
    expect(recovered).toMatchObject({
      phase: "recovered",
      recoveryTxHash: HASH,
      ...token,
      endTime: NOW,
    })
    const stamped = record({ phase: "recoverable", recoveryTxHash: HASH })
    expect(
      sipaDepositTransition(stamped, { type: "recoveryReverted", txHash: HASH }, NOW)
        ?.recoveryTxHash,
    ).toBeUndefined()
  })

  it("stamps version 1 sweeps with the one bridge they settled on, on this network only", () => {
    const pinned = {
      portal: SIPA,
      l2Token: "0xl2",
      token: { address: SIPA, symbol: "DAI", decimals: 18 },
    }
    const old = record({ version: 1, inboxIndex: "7", fee: "3", sweeps: [sweep("7")] })
    const event = { type: "sweepRowsStamped", networkId: NETWORK, pinned } as const
    expect(sipaDepositTransition(old, event, NOW)).toMatchObject({
      version: 2,
      sweeps: [{ ...sweep("7"), portal: SIPA, l2Token: "0xl2", tokenSymbol: "DAI", fee: "3" }],
    })
    const elsewhere = { ...old, networkId: "0xother" }
    expect(sipaDepositTransition(elsewhere, event, NOW)).toBeUndefined()
  })
})
