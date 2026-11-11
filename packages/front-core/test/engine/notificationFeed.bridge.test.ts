// @vitest-environment node
/** A bridge-out stays live while the bridge delivers; a bridge-in rings only for its own ending. */
import { describe, expect, it } from "vitest"
import type { WithdrawalRecord } from "../../src/core/services/bridge/types"
import type { BridgeInRecord } from "../../src/core/services/crossChain/types"
import { createBridgeIns } from "../../src/engine/bridgeIns"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import {
  deriveNotifications,
  selectNotifications,
  type NotificationSources,
} from "../../src/engine/notificationFeed"
import type { NotificationState } from "../../src/engine/notifications"

const NOW = 1_800_000_000_000
const HOUR = 3_600_000
const E18 = 10n ** 18n
const addr = (byte: string) => `0x${byte.repeat(20)}` as const

const burn = (over: Partial<WithdrawalRecord> = {}): WithdrawalRecord =>
  ({
    localId: "w1",
    recipient: addr("e1"),
    amount: "7",
    tokenSymbol: "DAI",
    phase: "done",
    startTime: NOW - 2 * HOUR,
    endTime: NOW - HOUR,
    ...over,
  } as WithdrawalRecord)

const loaded = <T>(records: T[]) => ({ records, loaded: true, failed: false })
const hydrated = <T>(records: T[]) => ({ records, hydrated: true })

const sources = (over: Partial<NotificationSources> = {}): NotificationSources => ({
  rows: [],
  links: [],
  oldVersionWithdrawals: [],
  bridgeIns: hydrated([]),
  deposits: loaded([]),
  withdrawals: hydrated([]),
  upgrades: { items: [], recipients: new Set(), loaded: true },
  processing: new Map(),
  registrations: [],
  operations: { ended: [], running: [] },
  loaded: true,
  ...over,
})

const ids = (s: NotificationSources) => deriveNotifications(s, new Map(), NOW).map((e) => e.id)

/** Lists `s` with every derived id seen now, as the writer stamps them. */
const select = (s: NotificationSources) =>
  selectNotifications(
    s,
    new Map<string, NotificationState>(
      deriveNotifications(s, new Map(), NOW).map((e) => [e.id, { id: e.id, firstSeenAt: NOW }]),
    ),
    new Map(),
    NOW,
  )

describe("bridge entries", () => {
  it("keeps a bridge-out live while the bridge delivers", () => {
    expect(ids(sources({ withdrawals: hydrated([burn({ phase: "bridging" })]) }))).toEqual([
      "bridge:withdrawal:w1:inflight",
    ])
  })

  const hash = `0x${"B1".repeat(32)}` as const
  const ID = `bridge-in:${hash.toLowerCase()}`
  const bridged = (over: Partial<BridgeInRecord>): BridgeInRecord => ({
    id: ID,
    originTxHash: hash,
    originChainId: 8453,
    depositor: addr("a1"),
    recipient: addr("d1"),
    symbol: "USDC",
    inputAmount: "20500000",
    outputAmount: (20n * E18).toString(),
    fee: "500000",
    inputDecimals: 6,
    outputSymbol: "DAI",
    outputDecimals: 18,
    status: "pending",
    startTime: NOW - HOUR,
    ...over,
  })

  it("reports a bridge-in's ending once it fills or comes back, nothing while it bridges", () => {
    expect(ids(sources({ bridgeIns: hydrated([bridged({})]) }))).toEqual([])
    const [filled] = select(
      sources({ bridgeIns: hydrated([bridged({ status: "filled", endTime: NOW - 5 })]) }),
    )
    expect(filled).toMatchObject({
      id: `${ID}:filled`,
      about: { kind: "bridgeInEnded" },
      severity: "success",
      timestampMs: NOW - 5,
      target: { type: "bridgeIn.detail", id: ID },
    })
    for (const status of ["refunded", "expired", "failed"] as const)
      expect(
        select(sources({ bridgeIns: hydrated([bridged({ status, endTime: NOW - 5 })]) })),
      ).toMatchObject([{ id: `${ID}:${status}`, severity: "info" }])
  })

  it("reports a payment to someone else ending under its own kind", () => {
    const pays = { payee: "bob" }
    expect(
      select(sources({ bridgeIns: hydrated([bridged({ status: "filled", endTime: 9, pays })]) })),
    ).toMatchObject([{ id: `${ID}:filled`, about: { kind: "paymentBridgeEnded" } }])
  })

  it("reports nothing for a call that was never sent", () => {
    const { originTxHash: _, ...unsent } = bridged({ status: "failed", endTime: NOW - 5 })
    expect(ids(sources({ bridgeIns: hydrated([unsent]) }))).toEqual([])
  })

  it("reports nothing for a bridge-in rebuilt from the chain: another device reported it", () => {
    const rebuilt = bridged({ status: "filled", endTime: NOW - 5, replayed: true })
    expect(ids(sources({ bridgeIns: hydrated([rebuilt]) }))).toEqual([])
  })

  it("reports a sped-up bridge-in's ending once, under its own id", async () => {
    const store = createBridgeIns({ db: openDatabase(memoryBackend()) })
    const resend = `0x${"5e".repeat(32)}` as const
    const { id: _, ...sent } = bridged({})
    const saved = await store.rebuild(sent)
    await store.apply(saved!.id, [
      { type: "sent", originTxHash: resend },
      { type: "reported", status: { status: "filled", fillTxHash: resend }, at: NOW - 5 },
    ])
    const bridgeIns = hydrated([...store.list.get().records])
    expect(select(sources({ bridgeIns }))).toMatchObject([
      { id: `${saved!.id}:filled`, target: { id: saved!.id } },
    ])
  })
})
