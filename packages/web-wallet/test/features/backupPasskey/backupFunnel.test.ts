/** The backup passkey funnel: each step an attempt reaches is reported once, from its saved record. */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  createBackupFunnel,
  memoryBackend,
  openDatabase,
  type BackupRotationRecord,
} from "@obsidion/front-core"
import type { AccountHistory } from "../../../src/features/backupPasskey/accountHistory"
import type { OpenEntryBlock } from "../../../src/features/backupPasskey/backupPasskeyEntry"
import type { BackupAddState } from "../../../src/features/backupPasskey/backupScreen"
import type { PreviousMoveOutcome } from "../../../src/features/backupPasskey/previousAccountWatcher"
import { createdRecord, sent as funding } from "../../support/backupAdd"

vi.stubEnv("VITE_ZKMONEY_API_URL", "https://api.test")
const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response)
const { bindAnalyticsConsent } = await import("../../../src/lib/analytics")
const { backupTransitions, reportAddTapped, reportDelayed, reportMoveEnded, reportNudgeShown } =
  await import("../../../src/features/backupPasskey/backupFunnel")

/** Each event sent, as `[event, props]`, without the viewport every event carries. */
const sent = () =>
  fetchSpy.mock.calls.map(([, init]) => {
    const { event, props } = JSON.parse(String(init?.body))
    delete props.viewport
    return [event, props]
  })

beforeEach(() => {
  bindAnalyticsConsent(() => true)
  fetchSpy.mockClear()
})

const at = (phase: BackupRotationRecord["phase"], updatedAt: number, over = {}) =>
  createdRecord({ phase, createdAt: 1_000, updatedAt, ...over })

const phases = (events: ReturnType<typeof backupTransitions>["events"]) =>
  events.map(({ event, props }) => ({ event, ...props }))

describe("backupTransitions", () => {
  it("reports each step once as it is reached, timed from the start and the step before", () => {
    const signed = backupTransitions([at("signed", 2_000)], {})
    expect(phases(signed.events)).toEqual([
      {
        event: "backup_rotation_phase",
        phase: "signed",
        since_start_ms: 1_000,
        prev_phase_ms: 1_000,
      },
    ])
    const published = backupTransitions([at("published", 5_000)], signed.next)
    expect(phases(published.events)).toEqual([
      {
        event: "backup_rotation_phase",
        phase: "published",
        since_start_ms: 4_000,
        prev_phase_ms: 3_000,
      },
    ])
    expect(backupTransitions([at("published", 9_000)], published.next).events).toEqual([])
  })

  it("reports the steps a closed tab missed in order, timing only the one it stands at", () => {
    const { events } = backupTransitions(
      [at("moved", 60_000, { installed: { blockHash: "0x" } })],
      {},
    )
    expect(phases(events)).toEqual([
      { event: "backup_rotation_phase", phase: "signed" },
      { event: "backup_rotation_phase", phase: "published" },
      { event: "backup_rotation_phase", phase: "installed" },
      { event: "backup_rotation_phase", phase: "rerooted" },
      { event: "backup_rotation_phase", phase: "moved", since_start_ms: 59_000 },
    ])
  })

  it("reports an attention once with its reason, and nothing when the attempt returns", () => {
    const funded = backupTransitions([at("funded", 3_000)], {}).next
    const parked = at("attention", 4_000, { attention: "route", suspended: "funded" })
    const attention = backupTransitions([parked], funded)
    expect(phases(attention.events)).toEqual([
      {
        event: "backup_rotation_phase",
        phase: "attention",
        attention: "route",
        since_start_ms: 3_000,
        prev_phase_ms: 1_000,
      },
    ])
    expect(backupTransitions([at("funded", 5_000)], attention.next).events).toEqual([])
  })

  it("times the step after an attention from the phase before it", () => {
    const funded = backupTransitions([at("funded", 3_000)], {}).next
    const parked = at("attention", 4_000, { attention: "route", suspended: "funded" })
    const paused = backupTransitions([parked], funded).next
    const { events } = backupTransitions([at("swept", 10_000)], paused)
    expect(phases(events)).toEqual([
      {
        event: "backup_rotation_phase",
        phase: "swept",
        since_start_ms: 9_000,
        prev_phase_ms: 7_000,
      },
    ])
  })

  it("reports the steps a side path's saved facts show, though no page saw them", () => {
    const published = backupTransitions([at("published", 2_000)], {}).next
    const installed = at("installed", 9_000, { ...funding(), installed: { blockHash: "0x" } })
    expect(phases(backupTransitions([installed], published).events)).toEqual([
      { event: "backup_rotation_phase", phase: "funded" },
      { event: "backup_rotation_phase", phase: "installed", since_start_ms: 8_000 },
    ])

    const recovered = at("recovered", 2_000, { publish: { count: 1, history: [] }, ...funding() })
    expect(phases(backupTransitions([recovered], {}).events)).toEqual([
      { event: "backup_rotation_phase", phase: "signed" },
      { event: "backup_rotation_phase", phase: "published" },
      { event: "backup_rotation_phase", phase: "funded" },
      { event: "backup_rotation_phase", phase: "recovered", since_start_ms: 1_000 },
      { event: "backup_recovery", state: "recovered", extra: false },
    ])
  })
})

describe("reportDelayed", () => {
  it("reports each delay once per attempt, in this session and the next", async () => {
    const entries = new Map<string, string>()
    const funnel = () => createBackupFunnel({ db: openDatabase(memoryBackend(entries)) })
    const record = at("funded", 2_000)
    await reportDelayed(funnel(), record, "late")
    await reportDelayed(funnel(), record, "late")
    await reportDelayed(funnel(), record, "route")
    expect(sent()).toEqual([
      ["backup_delayed", { delay: "late", phase: "funded" }],
      ["backup_delayed", { delay: "route", phase: "funded" }],
    ])
  })
})

const open = (block: OpenEntryBlock): OpenEntryBlock => block
const balance = open({ id: "balance", need: 2n, have: 1n, done: false, action: "deposit" })
const route = open({ id: "route", done: false })
const savings = open({ id: "savings", done: false, action: "savings" })
const withdrawal = open({ id: "withdrawal", done: false, action: "activity" })

describe("reportAddTapped", () => {
  it.each<[string, BackupAddState, Record<string, string> | undefined]>([
    ["checking", { kind: "checking" }, undefined],
    ["ready", { kind: "ready", links: 3 }, { entry: "ready", links: "2+" }],
    [
      "a short balance alone",
      { kind: "blocked", screen: "blocked", block: balance, blocks: [balance] },
      { entry: "low_balance", block: "balance", blocks: "1" },
    ],
    [
      "three conditions",
      {
        kind: "blocked",
        screen: "blocked",
        block: savings,
        blocks: [savings, withdrawal, balance],
      },
      { entry: "blocked", block: "savings", blocks: "3+" },
    ],
    [
      "no route",
      { kind: "blocked", screen: "unavailable", block: route, blocks: [route, balance] },
      { entry: "unavailable", block: "route", blocks: "2" },
    ],
  ])("%s", (_, add, props) => {
    reportAddTapped(add)
    expect(sent()).toEqual(props ? [["backup_add_tapped", props]] : [])
  })
})

const history = (
  status: Extract<AccountHistory, { kind: "rotation" }>["status"],
): AccountHistory => ({
  kind: "rotation",
  earlier: "0xold",
  status,
})
const found = (over = {}) => history({ kind: "found", held: [], ...over })

describe("reportMoveEnded", () => {
  it.each<[string, PreviousMoveOutcome, AccountHistory]>([
    ["moved", { kind: "done" }, history({ kind: "moved" })],
    ["partial", { kind: "stopped" }, found({ rows: [{ kind: "main", state: "partial" }] })],
    ["declined", { kind: "stopped" }, found({ action: "move" })],
    ["failed", { kind: "failed", error: new Error("x") }, found({ note: "failed" })],
    ["stuck", { kind: "refused", reason: "spend", amount: 1n }, found({ note: "stuck" })],
    ["refused", { kind: "refused", reason: "spend", amount: 1n }, found({ note: "refused" })],
  ])("%s", (ended, outcome, after) => {
    reportMoveEnded(outcome, after, 2)
    expect(sent()).toEqual([["account_history_move_ended", { outcome: ended, approvals: "2-3" }]])
  })
})

describe("reportNudgeShown", () => {
  it("counts a card once per tab, with the balance step it showed at", () => {
    const threshold = 1_000n * 10n ** BigInt(DEFAULT_DECIMALS)
    reportNudgeShown("home", { kind: "oneKey", threshold })
    reportNudgeShown("home", { kind: "oneKey", threshold })
    expect(sent()).toEqual([
      ["backup_nudge_shown", { surface: "home", kind: "one_key", threshold: "1k" }],
    ])
  })
})
