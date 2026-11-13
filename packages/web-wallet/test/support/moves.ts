import type { MoveRecord } from "@obsidion/front-core"

/** A Sky escrow move into Savings, its burn mined; `over` sets any field. */
export const moveRecord = (over: Partial<MoveRecord> = {}): MoveRecord =>
  ({
    id: "m1",
    holdingId: "fea-sky",
    rail: "skyEscrow",
    escrow: { factory: `0x${"fa".repeat(20)}`, address: `0x${"e1".repeat(20)}`, tip: 0n },
    direction: "in",
    amount: 10n ** 18n,
    withdrawalLocalId: "w1",
    nonce: "0x02",
    recipientCommitment: "0x03",
    scanFrom: 0n,
    phase: "burned",
    startTime: 0,
    ...over,
  } as MoveRecord)
