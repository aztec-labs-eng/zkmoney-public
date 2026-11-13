// @vitest-environment node
/** Which screen each saved rotation, driver answer, entry read and failure picks, and its props. */
import { L1_SETTLED_DEPTH } from "@obsidion/core/constants"
import {
  RootPasskeyRequiredError,
  RotationFlowError,
  type AllowanceSnapshot,
  type BackupAddRelease,
  type BackupFundingRow,
  type BackupRotationRecord,
  type ResumeAnswer,
} from "@obsidion/front-core"
import { providerNameFor, type BackupAddOptions, type UserAgentInfo } from "@obsidion/passkey-web"
import { RotationRouteNotLiveError } from "@obsidion/sdk"
import { describe, expect, it } from "vitest"
import type { BackupStep } from "../../../src/features/backupPasskey/backupFailure"
import type { EntryFacts } from "../../../src/features/backupPasskey/backupPasskeyFacts"
import type { FasterWithdrawal } from "../../../src/features/withdraw/useFasterWithdrawal"
import {
  pendingRecord,
  recoveryKey,
  selectAddStep,
  selectBackupScreen,
  selectSheetClose,
  type AddStep,
  type BackupScreen,
  type BackupScreenInput,
  type EntryInput,
  type KeysRead,
} from "../../../src/features/backupPasskey/backupScreen"
import { createdRecord, PLAN, sent, signedRecord, SIPA, word } from "../../support/backupAdd"

const DAI = 10n ** 18n
const MIN = 60_000
const BITWARDEN = "d548826e-79b4-db40-a3d8-11116f7e8349"
const PROVIDER = "iCloud Keychain"
const KEYS: KeysRead = {
  keys: [{ pubkeyHex: "aa", role: "sign-up", signsHere: true, provider: PROVIDER }],
  count: 1,
}
const READY: Extract<AllowanceSnapshot, { status: "ready" }> = {
  status: "ready",
  read: {
    fpcAddress: "0x1",
    railId: 0,
    payer: "0x2",
    allowance: { subscribed: true, uses: 10, maxTx: 10, refillPeriod: 0 },
  },
  state: { kind: "available", available: 10, renews: false },
  refreshing: false,
}
const FACTS: EntryFacts = {
  routeLive: true,
  balance: 10n * DAI,
  fundingAmount: 2n * DAI,
  credited: (14n * DAI) / 10n,
  chunk: { kind: "fits" },
  fits: (amount) => amount <= 10n * DAI,
  plan: true,
  moves: 2,
  savingsMoving: false,
  withdrawalInFlight: false,
  links: 1,
  historicBalance: false,
}
const DEVICE: UserAgentInfo = {
  osFamily: "macos",
  osVersionReported: "15",
  browserFamily: "chrome",
  browserVersionReported: "140",
}
const PLACE: BackupAddOptions = {
  options: [
    { id: "phone", label: "phone", description: "", advice: [] },
    { id: "key", label: "key", description: "", advice: [] },
  ],
  selected: "phone",
}
const entry = (over: Partial<EntryInput> = {}): EntryInput => ({
  allowance: READY,
  facts: FACTS,
  railFailed: false,
  registering: false,
  device: DEVICE,
  ...over,
})

const select = (over: Partial<BackupScreenInput> = {}): BackupScreen =>
  selectBackupScreen({
    keys: KEYS,
    saved: null,
    deps: "ready",
    addable: true,
    laptop: false,
    busy: false,
    cancelled: false,
    now: 0,
    ...over,
  })
/** The screen for `record` once the driver answered `resume` for it; null before it answers. */
const at = (
  record: BackupRotationRecord,
  resume: ResumeAnswer | null = {},
  over: Partial<BackupScreenInput> = {},
) =>
  select({ saved: record, drive: { record, ...(resume && { resume }), approving: false }, ...over })
const tapped = (error: unknown, step: BackupStep, record?: BackupRotationRecord) => ({
  error,
  step,
  ...(record && { attemptId: record.attemptId }),
})

const declined = () => new DOMException("closed", "NotAllowedError")
const landing = sent()
/** The release read for a funding: 2 min to land, a 10 min release, 3 min with a tip. */
const RELEASE: BackupAddRelease = {
  landingSeconds: 120,
  standardEtaSeconds: 600,
  tippedEtaSeconds: 180,
  l1SlotSeconds: 12,
}
/** The wait after the release, in seconds: two relayer pickups of two slots, then the settle. */
const TAIL = (2 * 2 + Number(L1_SETTLED_DEPTH)) * RELEASE.l1SlotSeconds
const parked = (attention: BackupRotationRecord["attention"], over = {}) =>
  signedRecord({ phase: "attention", attention, suspended: "funded", ...over })
const movedRecord = (over: Partial<BackupRotationRecord> = {}) =>
  signedRecord({ phase: "moved", ...sent(5, { outcome: "swept" }), ...over })
/** A sweep a reorg dropped, the relayer's re-sweep yet to settle. */
const gone: Pick<BackupRotationRecord, "sweep"> = {
  sweep: { index: "3", blockNumber: 90, blockHash: word(0x90), credited: "1400", recheck: "gone" },
}

describe("selectBackupScreen, a saved rotation", () => {
  it("acts on no record while the key read is out, and waits on the record's dependencies", () => {
    expect(select({ keys: undefined, saved: signedRecord() })).toEqual({
      id: "loading",
      rotation: false,
    })
    expect(select({ saved: signedRecord(), deps: "building" })).toEqual({
      id: "loading",
      rotation: true,
    })
    expect(select({ saved: signedRecord(), deps: "failed" })).toEqual({
      id: "unreadable",
      read: "deps",
    })
    expect(select({ keys: "unreadable", saved: signedRecord() }).id).toBe("approve")
    expect(select({ saved: signedRecord(), deps: "none" })).toEqual({
      id: "loading",
      rotation: false,
    })
    // With no wallet the keys did not read either: their sheet stands rather than a blank one.
    expect(select({ keys: "unreadable", saved: signedRecord(), deps: "none" })).toEqual({
      id: "unreadable",
      read: "keys",
    })
  })

  it("puts approving and paying on one step, the sign named for the session's key", () => {
    expect(at(createdRecord(), null)).toMatchObject({
      id: "approve",
      progress: { step: 2, stage: "sign" },
      approver: PROVIDER,
      checking: false,
      canCancel: true,
    })
    expect(at(signedRecord())).toMatchObject({
      id: "approve",
      progress: { step: 2, stage: "publish" },
      sipa: SIPA,
    })
    const published = signedRecord({ phase: "published" })
    expect(at(published, null)).toMatchObject({ id: "approve", checking: true })
    expect(at(published)).not.toHaveProperty("pay")
    expect(at(published, { wait: "funding" })).toMatchObject({
      id: "approve",
      progress: { step: 2, stage: "pay" },
      pay: {
        address: PLAN.address,
        sent: 2n * DAI,
        fees: { withdrawal: DAI / 5n, accountChange: (4n * DAI) / 10n },
        credited: (14n * DAI) / 10n,
        approvals: 1,
        refunds: 0,
        moves: 2,
      },
    })
    // The time at either speed, once the release is read: the landing, the release and the tail.
    expect(at(published, { wait: "funding" })).not.toHaveProperty("pay.eta")
    const etas = { pay: { eta: { standard: 120 + 600 + TAIL, tipped: 120 + 180 + TAIL } } }
    expect(at(published, { wait: "funding" }, { release: RELEASE })).toMatchObject(etas)
    // A send that failed, or carried another speed's tip, leaves the next send's quote alone.
    for (const funding of [
      { phase: "failed", startTime: 0 },
      { phase: "submitting", startTime: 0, proverTip: "5" },
    ] as const)
      expect(at(published, { wait: "funding" }, { release: RELEASE, funding })).toMatchObject(etas)
  })

  it("waits on the network once a funding may land, through the sweep and the install", () => {
    const waits = [
      [signedRecord({ phase: "published", ...landing }), "landing"],
      [signedRecord({ phase: "funded", ...landing }), "funded"],
      [signedRecord({ phase: "swept", ...landing }), "final"],
      [signedRecord({ phase: "installed" }), "final"],
    ] as const
    for (const [record, stage] of waits)
      expect(at(record)).toMatchObject({ id: "adding", progress: { step: 3, stage } })
    expect(at(signedRecord({ phase: "funded", ...landing }))).toMatchObject({ canCancel: false })
  })

  it("finishes on step 4, asking only for what the move waits on", () => {
    expect(at(signedRecord({ phase: "rerooted" }))).toMatchObject({
      id: "finish",
      progress: { step: 4, stage: "installing" },
    })
    expect(at(movedRecord(), { wait: "approval" })).toMatchObject({
      id: "finish",
      progress: { stage: "moving" },
      ask: "approve",
    })
    expect(at(movedRecord(), { wait: "link" })).toMatchObject({ linkExpiring: true })
    expect(at(movedRecord(), { wait: "uses" })).toMatchObject({ delay: "uses" })
    expect(at(movedRecord())).not.toHaveProperty("ask")
  })

  it("says the network is confirming the backup again while a reorg dropped the sweep", () => {
    expect(at(signedRecord({ phase: "swept", ...landing, ...gone }))).toMatchObject({
      id: "adding",
      progress: { stage: "final", relanding: true },
    })
    expect(at(signedRecord({ phase: "rerooted", ...gone }))).toMatchObject({
      id: "finish",
      progress: { stage: "installing", relanding: true },
    })
    expect(at(movedRecord(gone), { wait: "approval" })).toMatchObject({
      id: "finish",
      ask: "approve",
      progress: { relanding: true },
    })
    expect(at(signedRecord({ phase: "done", ...gone }))).toMatchObject({
      id: "done",
      relanding: true,
    })
    expect(at(movedRecord())).toMatchObject({
      progress: expect.not.objectContaining({ relanding: true }),
    })
    expect(at(signedRecord({ phase: "done" }))).not.toHaveProperty("relanding")
  })

  it("counts the refunds and the move's parts it is on", () => {
    const record = movedRecord({
      refunds: {
        links: [
          { link: "a", state: "mined" },
          { link: "b", state: "planned" },
        ],
      },
      move: {
        runs: [
          {
            plannedAt: 1,
            m: 3,
            depositBound: false,
            chunks: [{ token: "t", amount: "1", state: "mined" }],
          },
        ],
      },
    })
    expect(at(record)).toMatchObject({
      progress: { refunds: { landed: 1, total: 2 }, moved: { included: 1, total: 3 } },
    })
  })

  it("asks again for a move the user declined once the driver answers so, as C7", () => {
    const record = movedRecord({
      move: { runs: [{ plannedAt: 1, m: 1, depositBound: false, declined: true, chunks: [] }] },
    })
    expect(at(record, { wait: "declined" })).toMatchObject({
      id: "finish",
      ask: "retry",
      declined: true,
      failure: { kind: "declined", step: "move", charged: "funding" },
    })
    expect(at(record, null)).toMatchObject({ declined: false, checking: true })
  })

  it("names where the backup was saved, and what the add charged once paid", () => {
    expect(at(createdRecord())).not.toHaveProperty("savedIn")
    expect(at(createdRecord(), null)).not.toHaveProperty("paid")
    const key = createdRecord({ backup: { ...createdRecord().backup, securityKey: true } })
    expect(at(key, null)).toMatchObject({ savedIn: { securityKey: true } })
    const manager = createdRecord({ backup: { ...createdRecord().backup, prfAaguid: BITWARDEN } })
    expect(at(manager, null)).toMatchObject({ savedIn: { manager: providerNameFor(BITWARDEN) } })
    expect(at(signedRecord({ phase: "funded", ...landing }))).toMatchObject({
      paid: { sent: 2n * DAI, credited: (14n * DAI) / 10n },
    })
  })

  it("counts the time left from the funding's row and release, late well past the quote", () => {
    const record = signedRecord({
      phase: "funded",
      ...sent(0),
      plan: { ...PLAN, takesMs: 40 * MIN },
    })
    const release = RELEASE
    const tail = TAIL * 1000
    const landed: BackupFundingRow = { phase: "awaiting_proven", startTime: 0, minedAt: 2 * MIN }
    const timed = { funding: landed, release }
    expect(at(record, {}, { now: 5 * MIN, ...timed })).toMatchObject({
      timing: { leftMs: 2 * MIN + 600_000 + tail - 5 * MIN },
    })
    expect(at(record, {}, { now: 5 * MIN, ...timed })).not.toHaveProperty("delay")
    // Run out well before the quote: nothing left, and not yet late.
    expect(at(record, {}, { now: 25 * MIN, ...timed })).toMatchObject({ timing: { leftMs: 0 } })
    expect(at(record, {}, { now: 25 * MIN, ...timed })).not.toHaveProperty("delay")
    // The row's own tip picks the faster release.
    expect(
      at(record, {}, { now: 5 * MIN, funding: { ...landed, proverTip: "5" }, release }),
    ).toMatchObject({ timing: { leftMs: 2 * MIN + 180_000 + tail - 5 * MIN } })
    // No row or no release read yet: no time, while the delay still follows the quote.
    expect(at(record, {}, { now: 5 * MIN, release })).not.toHaveProperty("timing")
    expect(at(record, {}, { now: 5 * MIN, funding: landed })).not.toHaveProperty("timing")
    expect(at(record, {}, { now: 60 * MIN, ...timed })).toMatchObject({
      timing: { leftMs: 0 },
      delay: "late",
    })
    expect(at(record, {}, { now: 60 * MIN })).toMatchObject({ delay: "late" })
    // Reopened long after paying: the driver's first answer may find the add done.
    expect(at(record, null, { now: 60 * MIN, ...timed })).not.toHaveProperty("delay")
    // A phase the add moved to keeps the delay the page already knew of, with nothing left to wait.
    const swept = { ...record, phase: "swept" as const }
    expect(
      select({
        saved: swept,
        drive: { record: swept, approving: false, checkedAt: 0 },
        now: 60 * MIN,
        ...timed,
      }),
    ).toMatchObject({ timing: { leftMs: 0 }, delay: "late" })
    // The user's recheck keeps the sheet it was tapped on, spinning.
    const rechecking = { record, resume: {}, approving: false, rechecking: true as const }
    expect(select({ saved: record, drive: rechecking, now: 60 * MIN })).toMatchObject({
      delay: "late",
      checking: true,
    })
    // Before the funding lands there is nothing to count from.
    const sending: BackupFundingRow = { phase: "submitting", startTime: 0 }
    expect(
      at(signedRecord({ phase: "published", ...landing }), {}, { funding: sending, release }),
    ).not.toHaveProperty("timing")
  })

  it("keeps the pay step while the funding's prompt or proof is out, with nothing paid", () => {
    const unsent = sent(5)
    const paying = signedRecord({
      phase: "published",
      fundings: unsent.fundings.map(({ txHash: _, ...f }) => f),
    })
    const screen = at(paying, null)
    expect(screen).toMatchObject({
      id: "approve",
      progress: { step: 2, stage: "pay" },
      sending: true,
    })
    expect(screen).toHaveProperty("pay")
    expect(screen).not.toHaveProperty("paid")
    // An earlier funding that was sent and reverted charged nothing either.
    const reverted = sent(5, { outcome: "reverted" }).fundings
    expect(at({ ...paying, fundings: [...reverted, ...paying.fundings] }, null)).not.toHaveProperty(
      "paid",
    )
  })

  it("says how long ago the driver last read the chain for the attempt", () => {
    const record = signedRecord({ phase: "funded", ...landing })
    expect(at(record)).not.toHaveProperty("checkedAgoMs")
    const checked = (checkedAt: number) =>
      select({
        saved: record,
        drive: { record, resume: {}, approving: false, checkedAt },
        now: 3 * MIN,
      })
    expect(checked(MIN)).toMatchObject({ checkedAgoMs: 2 * MIN })
    expect(checked(3 * MIN + 10)).toMatchObject({ checkedAgoMs: 0 })
  })

  it("shows the added backup with the keys, named from the attempt while the read predates it", () => {
    const done = signedRecord({ phase: "done", ...sent(5, { outcome: "swept" }) })
    const backup = { pubkeyHex: `0x${done.backup.pubkeyHex.toUpperCase()}`, signsHere: false }
    const both = { keys: [...KEYS.keys, { ...backup, role: "backup" as const }], count: 2 }
    expect(at(done, {}, { keys: both })).toEqual({
      id: "done",
      keys: both.keys,
      paid: { sent: 2n * DAI, credited: (14n * DAI) / 10n },
    })
    expect(at(signedRecord({ phase: "done" }))).toEqual({
      id: "done",
      keys: KEYS.keys,
      unlisted: {},
    })
    const onKey = { ...done, backup: { ...done.backup, securityKey: true } }
    expect(at(onKey)).toMatchObject({ unlisted: { savedIn: { securityKey: true } } })
    const record = signedRecord({ phase: "published" })
    const other = { ...record, attemptId: "attempt-0" }
    expect(
      select({
        saved: record,
        drive: { record: other, resume: { wait: "funding" }, approving: false },
      }),
    ).toMatchObject({ id: "approve", checking: true })
  })
})

describe("selectBackupScreen, the move's rows", () => {
  const TOKENS = { main: "0xMAIN", savings: "0xsave" }
  type Run = NonNullable<BackupRotationRecord["move"]>["runs"][number]
  type Chunk = Run["chunks"][number]
  type Link = NonNullable<BackupRotationRecord["refunds"]>["links"][number]
  const chunk = (token: string, state: Chunk["state"], over: Partial<Chunk> = {}): Chunk => ({
    token,
    amount: "1",
    state,
    ...over,
  })
  const run = (chunks: Chunk[]): Run => ({
    plannedAt: 1,
    m: chunks.length,
    depositBound: false,
    chunks,
  })
  const links = (...states: Link["state"][]) => ({
    refunds: { links: states.map((state, i) => ({ link: `l${i}`, state })) },
  })
  const rows = (over: Partial<BackupRotationRecord>, tokens: { main: string } | null = TOKENS) => {
    const screen = at(movedRecord(over), {}, tokens ? { tokens } : {})
    return screen.id === "finish" ? screen.progress.rows : undefined
  }

  it("takes the paylinks back first, one row standing for the balances until planned", () => {
    expect(rows(links("planned", "mined", "skipped"))).toEqual([
      { kind: "links", count: 2, state: "next" },
      { kind: "funds", state: "todo" },
    ])
    expect(rows(links("submitted", "planned"))).toMatchObject([{ state: "confirming" }, {}])
    expect(rows(links("claimed"))).toMatchObject([{ state: "sending" }, {}])
  })

  it("shows no rows with no link left to take back and no run, or before the tokens are read", () => {
    expect(rows({})).toBeUndefined()
    expect(rows(links("skipped", "skipped"))).toBeUndefined()
    expect(rows(links("mined"))).toBeUndefined()
    expect(rows(links("planned"), null)).toBeUndefined()
    const planned = { move: { runs: [run([chunk("0xmain", "planned")])] } }
    expect(rows(planned, null)).toBeUndefined()
  })

  it("decides each balance from its own chunks, Main first, two active at once", () => {
    const move = (...chunks: Chunk[]) => rows({ move: { runs: [run(chunks)] } })
    // The next send goes out while an earlier one is included.
    expect(move(chunk("0xSAVE", "claimed"), chunk("0xmain", "included"))).toEqual([
      { kind: "main", state: "confirming" },
      { kind: "savings", state: "sending" },
    ])
    expect(move(chunk("0xmain", "included"), chunk("0xsave", "planned"))).toEqual([
      { kind: "main", state: "confirming" },
      { kind: "savings", state: "next" },
    ])
    expect(
      move(chunk("0xmain", "mined"), chunk("0xmain", "mined"), chunk("0xsave", "planned")),
    ).toEqual([
      { kind: "main", state: "done" },
      { kind: "savings", state: "next" },
    ])
    // Nothing is sent while a send is out, or while a reverted inclusion is read again.
    expect(move(chunk("0xmain", "submitted"), chunk("0xsave", "planned"))).toEqual([
      { kind: "main", state: "confirming" },
      { kind: "savings", state: "todo" },
    ])
    expect(
      move(chunk("0xmain", "included", { effect: "reverted" }), chunk("0xmain", "planned")),
    ).toEqual([{ kind: "main", state: "confirming" }])
    expect(move(chunk("0xmain", "mined"), chunk("0xmain", "planned"))).toEqual([
      { kind: "main", state: "next" },
    ])
  })

  it("names a token that is neither Main's nor Savings' as another balance, last", () => {
    expect(
      rows({ move: { runs: [run([chunk("0xelse", "planned"), chunk("0xmain", "mined")])] } }),
    ).toEqual([
      { kind: "main", state: "done" },
      { kind: "other", state: "next" },
    ])
    const savings = { move: { runs: [run([chunk("0xsave", "mined")])] } }
    expect(rows(savings, { main: "0xmain" })).toEqual([{ kind: "other", state: "done" }])
  })

  it("keeps the paylinks row done beside a run only when a link was taken back", () => {
    const move = { runs: [run([chunk("0xmain", "planned")])] }
    expect(rows({ ...links("mined", "skipped"), move })).toEqual([
      { kind: "links", count: 1, state: "done" },
      { kind: "main", state: "next" },
    ])
    expect(rows({ ...links("skipped"), move })).toEqual([{ kind: "main", state: "next" }])
  })

  it("builds the rows from the latest run, and for a paused move", () => {
    const move = {
      runs: [run([chunk("0xmain", "mined")]), run([chunk("0xsave", "submitted")])],
    }
    expect(rows({ move })).toEqual([{ kind: "savings", state: "confirming" }])
    const paused = parked("move", { suspended: "moved", ...sent(5, { outcome: "swept" }), move })
    expect(at(paused, {}, { tokens: TOKENS })).toMatchObject({
      paused: true,
      progress: { rows: [{ kind: "savings", state: "confirming" }] },
    })
  })

  it("leaves the counts of refunds and chunks as they are beside the rows", () => {
    const record = {
      ...links("mined", "planned"),
      move: { runs: [{ ...run([chunk("0xmain", "mined")]), m: 3 }] },
    }
    expect(at(movedRecord(record), {}, { tokens: TOKENS })).toMatchObject({
      progress: { refunds: { landed: 1, total: 2 }, moved: { included: 1, total: 3 } },
    })
  })

  it("counts the chunks sent that no block holds yet, apart from the chunks in", () => {
    const progress = (...chunks: Chunk[]) => {
      const screen = at(movedRecord({ move: { runs: [run(chunks)] } }))
      return screen.id === "finish" ? screen.progress : undefined
    }
    expect(progress(chunk("0xmain", "submitted"), chunk("0xsave", "planned"))).toMatchObject({
      moved: { included: 0, total: 2 },
      out: 1,
    })
    expect(progress(chunk("0xmain", "included"), chunk("0xsave", "claimed"))).not.toHaveProperty(
      "out",
    )
  })
})

describe("selectBackupScreen, a parked or ended rotation", () => {
  it("sends a conflict to C4 and lets it start over", () => {
    expect(at(signedRecord({ phase: "conflict" }))).toMatchObject({
      id: "failed",
      failure: { kind: "changed", charged: "nothing" },
      canCancel: true,
    })
  })

  it("parks a route before paying as a wait to retry, and after paying as a delay", () => {
    expect(at(parked("route", { suspended: "signed" }))).toMatchObject({
      id: "failed",
      failure: { kind: "route", charged: "nothing" },
      canCancel: true,
    })
    expect(at(parked("route", landing))).toMatchObject({
      id: "adding",
      progress: { stage: "funded" },
      delay: "route",
      canCancel: false,
    })
  })

  it("keeps a recheck that failed on a parked route's sheet", () => {
    expect(at(parked("route", { suspended: "signed" }), { error: new Error("rpc") })).toMatchObject(
      {
        id: "failed",
        inline: { kind: "unknown", step: "resume" },
      },
    )
  })

  it("pauses a move that could not finish on step 4, for a retry", () => {
    expect(
      at(parked("move", { suspended: "moved", ...sent(5, { outcome: "swept" }) })),
    ).toMatchObject({
      id: "finish",
      paused: true,
      ask: "retry",
      progress: { step: 4 },
    })
  })

  it("starts a damaged record over, or recovers its funding once it may have landed", () => {
    expect(at(parked("corrupt", { suspended: "signed" }))).toMatchObject({
      id: "failed",
      failure: { kind: "corrupt" },
    })
    expect(at(parked("corrupt", landing))).toMatchObject({
      id: "recovery",
      state: "held",
      damaged: true,
    })
  })

  it("follows stranded funding from held to sent to recovered", () => {
    const held = parked("stranded", sent(5, { outcome: "mined" }))
    expect(at(held)).toMatchObject({
      id: "recovery",
      state: "held",
      extra: false,
      deposited: (18n * DAI) / 10n,
      sipa: SIPA,
      startedAt: 1,
      empty: false,
    })
    expect(at(held, {}, { emptyUnder: recoveryKey(held) })).toMatchObject({ empty: true })
    const recovering = { ...held, recovery: { txHash: word(0xab) } }
    expect(at(recovering)).toMatchObject({ state: "sent", recoveryTx: word(0xab), empty: false })
    expect(
      at(signedRecord({ phase: "recovered", recovery: { txHash: word(0xab) } })),
    ).toMatchObject({ id: "recovery", state: "recovered" })
    expect(at(parked("stranded", { suspended: "done" }))).toMatchObject({ extra: true })
  })

  it("shows no finished record the user left, unless it parked over its funding since", () => {
    const left = signedRecord({ phase: "done", dismissed: true, ...sent(5, { outcome: "swept" }) })
    expect(pendingRecord(KEYS, left)).toBeNull()
    expect(at(left)).toMatchObject({ id: "keys" })
    expect(at(parked("stranded", { suspended: "done", dismissed: true }))).toMatchObject({
      id: "recovery",
      extra: true,
    })
  })
})

describe("selectAddStep", () => {
  /** The driver's lane for `record`, as `at` builds it. */
  const drive = (record: BackupRotationRecord, resume: ResumeAnswer = {}) => ({
    record,
    resume,
    approving: false,
  })
  /**
   * Each phase, with the screen its sheet opens on, the step Home and Settings show, and how the
   * Passkeys sheet closes.
   */
  type Row = [
    BackupRotationRecord,
    ResumeAnswer,
    BackupScreen["id"],
    AddStep["kind"] | undefined,
    ReturnType<typeof selectSheetClose>,
  ]
  const phases: Row[] = [
    [createdRecord(), {}, "approve", "resume", "asks"],
    [signedRecord(), {}, "approve", "resume", "asks"],
    [signedRecord({ phase: "published" }), { wait: "funding" }, "approve", "resume", "asks"],
    [signedRecord({ phase: "published", ...landing }), {}, "adding", "adding", "holds"],
    [signedRecord({ phase: "funded", ...landing }), {}, "adding", "adding", "holds"],
    [signedRecord({ phase: "swept", ...landing }), {}, "adding", "adding", "holds"],
    [signedRecord({ phase: "installed" }), {}, "adding", "adding", "holds"],
    [parked("route", landing), {}, "adding", "adding", "holds"],
    [signedRecord({ phase: "rerooted" }), {}, "finish", "adding", "asks"],
    [movedRecord(), { wait: "approval" }, "finish", "finish", "asks"],
    [movedRecord(), { wait: "uses" }, "finish", "adding", "holds"],
    [movedRecord(), { wait: "link" }, "finish", "adding", "holds"],
    [
      parked("move", { suspended: "moved", ...sent(5, { outcome: "swept" }) }),
      {},
      "finish",
      "finish",
      "asks",
    ],
    [signedRecord({ phase: "done" }), {}, "done", undefined, "closes"],
    [signedRecord({ phase: "conflict" }), {}, "failed", undefined, "closes"],
    [parked("route", { suspended: "signed" }), {}, "failed", undefined, "closes"],
    [parked("stranded", sent(5, { outcome: "mined" })), {}, "recovery", undefined, "closes"],
    [
      signedRecord({ phase: "recovered", recovery: { txHash: word(0xab) } }),
      {},
      "recovery",
      undefined,
      "closes",
    ],
  ]

  it("follows the screen the add's sheet opens on, for every phase", () => {
    for (const [record, resume, screen, step, closing] of phases) {
      expect(at(record, resume).id).toBe(screen)
      expect(selectAddStep(record, { drive: drive(record, resume) })?.kind).toBe(step)
      expect(selectSheetClose(record, drive(record, resume))).toBe(closing)
    }
  })

  it("says a payment already going out, or a step the sheet calls late, is with the network", () => {
    const paying = signedRecord({
      phase: "published",
      fundings: sent(5).fundings.map(({ txHash: _, ...f }) => f),
    })
    expect(at(paying, null)).toMatchObject({ id: "approve", sending: true })
    expect(selectAddStep(paying, { drive: drive(paying) })).toEqual({ kind: "adding" })
    const delayed = { kind: "adding", delayed: true }
    expect(selectAddStep(parked("route", landing))).toEqual(delayed)
    expect(selectAddStep(movedRecord(), { drive: drive(movedRecord(), { wait: "uses" }) })).toEqual(
      delayed,
    )
  })

  it("asks for the last approval only while the move waits on the user's tap", () => {
    const record = movedRecord()
    const approving = { ...drive(record, { wait: "approval" }), approving: true }
    expect(selectAddStep(record, { drive: approving })).toEqual({ kind: "adding" })
    // The driver's answer for another attempt has no say.
    const other = drive({ ...record, attemptId: "attempt-2" }, { wait: "approval" })
    expect(selectAddStep(record, { drive: other })).toEqual({ kind: "adding" })
  })

  it("names no step for a finished add the user left, nor while the records do not read", () => {
    expect(selectAddStep(signedRecord({ phase: "done", dismissed: true }))).toBeUndefined()
    for (const saved of [null, "loading", "unreadable"] as const)
      expect(selectAddStep(saved)).toBeUndefined()
  })

  it("counts the time left the sheet shows, and none once the add is late", () => {
    const record = signedRecord({
      phase: "funded",
      ...sent(0),
      plan: { ...PLAN, takesMs: 40 * MIN },
    })
    const funding: BackupFundingRow = { phase: "awaiting_proven", startTime: 0, minedAt: 2 * MIN }
    const timed = { drive: drive(record), funding, release: RELEASE }
    const sheet = at(record, {}, { now: 5 * MIN, funding, release: RELEASE })
    expect(sheet).toMatchObject({ id: "adding", timing: { leftMs: expect.any(Number) } })
    expect(selectAddStep(record, { ...timed, now: 5 * MIN })).toEqual({
      kind: "adding",
      leftMs: sheet.id === "adding" ? sheet.timing?.leftMs : undefined,
    })
    expect(selectAddStep(record, { ...timed, now: 60 * MIN })).toEqual({
      kind: "adding",
      delayed: true,
    })
    // Without the clock or the release there is nothing to count.
    expect(selectAddStep(record, timed)).toEqual({ kind: "adding" })
    expect(selectAddStep(record, { drive: drive(record), now: 5 * MIN })).toEqual({
      kind: "adding",
    })
  })
})

describe("selectBackupScreen, a step's failure", () => {
  it("keeps a closed approval on step 2 as C3, and raises an unknown one over it as C5", () => {
    const record = createdRecord()
    expect(at(record, null, { failure: tapped(declined(), "approve", record) })).toMatchObject({
      id: "approve",
      failure: { kind: "declined", charged: "nothing" },
    })
    expect(at(record, null, { failure: tapped(new Error("x"), "approve", record) })).toMatchObject({
      id: "failed",
      failure: { kind: "unknown", charged: "nothing" },
      under: { id: "approve", progress: { stage: "sign" } },
    })
  })

  it("raises a closed payment prompt as C1, and keeps an unknown failure once funds left", () => {
    const record = signedRecord({ phase: "published" })
    expect(
      at(record, { wait: "funding" }, { failure: tapped(declined(), "fund", record) }),
    ).toMatchObject({
      id: "failed",
      failure: { kind: "declined", step: "fund" },
      under: { id: "approve" },
    })
    const paid = signedRecord({ phase: "published", ...landing })
    expect(at(paid, {}, { failure: tapped(new Error("x"), "fund", paid) })).toMatchObject({
      id: "adding",
      failure: { kind: "unknown", charged: "funding" },
    })
  })

  it("sends a missing route to B2 and a backup session to B4, over the step they stopped", () => {
    const record = createdRecord()
    expect(
      at(record, null, {
        failure: tapped(new RotationRouteNotLiveError("off"), "approve", record),
      }),
    ).toMatchObject({ id: "unavailable", under: { id: "approve" } })
    expect(at(movedRecord(), { error: new RootPasskeyRequiredError() })).toMatchObject({
      id: "firstPasskey",
      keys: KEYS.keys,
      under: { id: "finish" },
    })
  })

  it("shows a driver's failed run on the tracker, and a tap's failure over its own attempt only", () => {
    const funded = signedRecord({ phase: "funded", ...landing })
    expect(at(funded, { error: new Error("rpc") })).toMatchObject({
      id: "adding",
      failure: { kind: "unknown", step: "resume", charged: "funding" },
    })
    const other = tapped(new Error("x"), "approve", { ...funded, attemptId: "attempt-0" })
    expect(at(funded, {}, { failure: other })).not.toHaveProperty("failure")
  })
})

describe("selectBackupScreen, the add", () => {
  it("offers no add with the flag off, on a two-key account, or while records are out", () => {
    expect(select({ addable: false, entry: entry() })).toMatchObject({
      id: "keys",
      add: { kind: "none" },
    })
    expect(select({ keys: { keys: [], count: 2 }, entry: entry() })).toMatchObject({
      add: { kind: "none" },
    })
    expect(select({ saved: "loading" })).toEqual({ id: "loading", rotation: false })
    expect(select({ saved: "unreadable" })).toEqual({ id: "unreadable", read: "records" })
    expect(select({ keys: "unreadable" })).toEqual({ id: "unreadable", read: "keys" })
  })

  it("says an attempt was dropped whatever the key read, once no record is pending", () => {
    expect(select({ keys: "unreadable", cancelled: true })).toMatchObject({ cancelled: true })
    expect(select({ keys: undefined, cancelled: true })).toMatchObject({ cancelled: true })
    expect(select({ saved: "loading", cancelled: true })).not.toHaveProperty("cancelled")
  })

  it("checks while a read is out, and offers the retry once one failed", () => {
    for (const over of [
      { allowance: { status: "loading", scope: "s" } as const },
      { facts: "checking" as const },
      { registering: undefined },
      { device: undefined },
    ])
      expect(select({ entry: entry(over) })).toMatchObject({ add: { kind: "checking" } })
    for (const over of [
      { allowance: { status: "unavailable", scope: "s", error: 1 } as const },
      { facts: "unreadable" as const },
      { railFailed: true },
    ]) {
      expect(select({ entry: entry(over) })).toMatchObject({ add: { kind: "unreadable" } })
      expect(select({ entry: entry(over), start: "intro" })).toEqual({
        id: "unreadable",
        read: "entry",
      })
    }
  })

  it("checks while the keys read again, and leaves a saved attempt as it is", () => {
    expect(select({ entry: entry() })).toMatchObject({ id: "keys", add: { kind: "ready" } })
    expect(select({ keysRefreshing: true, entry: entry() })).toMatchObject({
      id: "keys",
      add: { kind: "checking" },
    })
    const published = signedRecord({ phase: "published" })
    expect(at(published, {}, { keysRefreshing: true, entry: entry() })).toEqual(
      at(published, {}, { entry: entry() }),
    )
  })

  it("lists every condition, and routes the first passkey and the network to theirs", () => {
    const facts = { ...FACTS, balance: DAI, withdrawalInFlight: true }
    const low = select({ entry: entry({ facts }), start: "intro" })
    if (low.id !== "blocked") throw new Error(low.id)
    expect(low.blocks.filter((b) => !b.done).map((b) => b.id)).toEqual(["withdrawal", "balance"])
    expect(low.blocks.find((b) => b.id === "registered")).toMatchObject({ done: true })
    const backup: KeysRead = { keys: [{ ...KEYS.keys[0]!, signsHere: false }], count: 1 }
    expect(select({ keys: backup, entry: entry() })).toMatchObject({
      add: { kind: "blocked", screen: "firstPasskey" },
    })
    expect(select({ keys: backup, entry: entry(), start: "intro" })).toEqual({
      id: "firstPasskey",
      keys: backup.keys,
    })
    const off = entry({ facts: { ...FACTS, routeLive: false } })
    expect(select({ entry: off, start: "intro" })).toEqual({ id: "unavailable" })
    // A registration still finishing is named before the route, on its own screen.
    expect(select({ entry: { ...off, registering: true }, start: "intro" })).toMatchObject({
      id: "blocked",
    })
  })

  it("names registration first on an account not registered yet, whatever the chain reads", () => {
    expect(select({ keys: "unverified", entry: entry({ facts: "checking" }) })).toMatchObject({
      id: "keys",
      keys: [],
      add: { kind: "blocked", screen: "blocked" },
    })
  })

  it("counts the publish, the funding, the refunds and the moves against the allowance", () => {
    const left = (available: number) =>
      select({
        entry: entry({
          allowance: { ...READY, state: { kind: "available", available, renews: false } },
        }),
      })
    expect(left(5)).toMatchObject({ add: { kind: "ready", links: 1 } })
    expect(left(4)).toMatchObject({ add: { kind: "blocked", screen: "blocked" } })
  })

  it("waits on the phone probe on a laptop, then opens the picker on the user's choice", () => {
    expect(select({ laptop: true, entry: entry() })).toMatchObject({ add: { kind: "checking" } })
    const ready = select({ laptop: true, entry: entry({ place: PLACE }), picked: "key" })
    expect(ready).toMatchObject({ add: { kind: "ready" }, place: { selected: "key" } })
    expect(select({ laptop: true, entry: entry({ place: PLACE }), start: "place" })).toMatchObject({
      id: "place",
      place: { selected: "phone" },
    })
  })

  it("walks the start screens, a phone going from A2 straight to the add", () => {
    expect(select({ entry: entry(), start: "intro" })).toEqual({
      id: "intro",
      links: 1,
      picker: false,
      device: DEVICE,
      busy: false,
    })
    expect(select({ entry: entry(), start: "place" })).toMatchObject({ id: "intro" })
    expect(select({ laptop: true, entry: entry({ place: PLACE }), start: "intro" })).toMatchObject({
      id: "intro",
      picker: true,
    })
  })

  it("quotes the add's cost and time on A2 at the speed the pay step opens on", () => {
    const quote = { total: (6n * DAI) / 10n, fixed: DAI / 2n, network: DAI / 10n }
    const funding = { sent: 2n * DAI, credited: (14n * DAI) / 10n }
    const intro = (over: Partial<BackupScreenInput> = {}, facts: Partial<EntryFacts> = {}) =>
      select({ entry: entry({ facts: { ...FACTS, quote, ...facts } }), start: "intro", ...over })
    const cost = { funding, fixed: quote.fixed }
    expect(intro()).toMatchObject({ id: "intro", cost })
    expect(intro()).not.toHaveProperty("eta")
    expect(intro({ release: RELEASE })).toMatchObject({ eta: 120 + 600 + TAIL })
    // Faster where the offer's tip is worth it, its tip in the cost.
    const tip = DAI / 10n
    const offer: FasterWithdrawal = {
      proverTip: tip,
      standardEtaSeconds: 600,
      tippedEtaSeconds: 180,
      worstSpeedupSeconds: 420,
      measured: true,
    }
    expect(intro({ release: RELEASE, offer })).toMatchObject({
      eta: 120 + 180 + TAIL,
      cost: { ...cost, funding: { ...funding, sent: funding.sent + tip } },
    })
    const standard = { eta: 120 + 600 + TAIL, cost }
    expect(intro({ release: RELEASE, offer: { ...offer, worstSpeedupSeconds: 30 } })).toMatchObject(
      standard,
    )
    // A balance that funds the add but not the tip on top opens the pay step on Standard.
    const short = { fits: (amount: bigint) => amount <= funding.sent }
    expect(intro({ release: RELEASE, offer }, short)).toMatchObject(standard)
  })

  it("shows the balance's own sheet when a short balance is all that holds the add", () => {
    const short = { ...FACTS, balance: DAI }
    expect(select({ entry: entry({ facts: short }), start: "intro" })).toEqual({
      id: "lowBalance",
      funding: { sent: 2n * DAI, credited: (14n * DAI) / 10n },
      have: DAI,
    })
    const more = { ...short, withdrawalInFlight: true }
    expect(select({ entry: entry({ facts: more }), start: "intro" })).toMatchObject({
      id: "blocked",
    })
  })

  it("raises the add's failure over the screen it started from, with nothing charged", () => {
    const keys = select({ entry: entry(), failure: tapped(declined(), "add") })
    expect(keys).toMatchObject({
      id: "failed",
      failure: { kind: "declined", charged: "nothing", leftover: false },
      under: { id: "keys", add: { kind: "ready" } },
    })
    const route = select({
      entry: entry(),
      failure: tapped(new RotationRouteNotLiveError("x"), "add"),
    })
    expect(route).toMatchObject({ id: "unavailable", under: { id: "keys" } })
    const open = select({
      entry: entry(),
      failure: tapped(new RotationFlowError("funding-open", "x"), "add"),
    })
    expect(open).toMatchObject({ id: "failed", failure: { kind: "funding-open" } })
    expect(select({ entry: entry(), cancelled: true })).toMatchObject({ cancelled: true })
  })
})
