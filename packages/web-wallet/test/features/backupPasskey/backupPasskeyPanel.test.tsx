/** Guards: the backup screens offer only safe actions, publish once, and stop once closed. */
import { createPace } from "@obsidion/core/cadence"
import { StrictMode, act, useState, useSyncExternalStore } from "react"
import { createRoot, type Root } from "react-dom/client"
import { TxStatus } from "@aztec-labs/stdlib/tx"
import { L1_SETTLED_DEPTH } from "@obsidion/core/constants"
import {
  type BackupAddRelease,
  type BackupRotations,
  fundingLocalId,
  memoryStore,
  queries,
  type BackupRotationRecord,
} from "@obsidion/front-core"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/web-ds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/web-ds")>()),
  PrimaryGradientButton: ({
    title,
    onClick,
    isLoading,
    isDisabled,
    testId,
  }: {
    title: string
    onClick?: () => void
    isLoading?: boolean
    isDisabled?: boolean
    testId?: string
  }) => (
    <button onClick={onClick} disabled={isLoading || isDisabled} data-testid={testId}>
      {title}
    </button>
  ),
  Icon: () => null,
  IconCircle: () => null,
  Spinner: () => null,
  StatusBadge: ({ label }: { label: string }) => <span data-testid="badge">{label}</span>,
}))

/** The explorer links read the booted app's config, which a unit test has none of. */
vi.mock("../../../src/ui/detailRows", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/ui/detailRows")>()),
  l1TxUrl: () => undefined,
  l1AddressUrl: () => undefined,
  whenLabel: () => "19 August, 12:00",
}))

/** The Settings recovery sheet: its wallet and its L1 transaction are not the panel's to test. */
vi.mock("../../../src/features/deposit/DepositExitModal/DepositExitModal", () => ({
  DepositExitModal: ({
    stranded,
    onRecovered,
    onClose,
  }: {
    stranded: { balance: string; token: { symbol: string } }
    onRecovered?: (hash: `0x${string}`) => void
    onClose: () => void
  }) => (
    <div>
      <button onClick={() => onRecovered?.(`0x${"ab".repeat(32)}`)}>
        {`Recover ${stranded.balance} ${stranded.token.symbol}`}
      </button>
      <button onClick={onClose}>Close</button>
    </div>
  ),
}))

import { BackupPasskeyScreens } from "../../../src/features/backupPasskey/BackupPasskeyHost/BackupPasskeyHost"
import { startBackupAdd } from "../../../src/features/backupPasskey/backupPasskeyAdd"
import {
  holdCopy,
  panelCopy,
  recoveryCopy,
} from "../../../src/features/backupPasskey/backupPasskeyCopy"
import trackerCopy from "../../../src/features/backupPasskey/screens/AddTracker/AddTracker.copy"
import approveCopy from "../../../src/features/backupPasskey/screens/ApproveScreen/ApproveScreen.copy"
import { BackupStandIn } from "../../../src/features/backupPasskey/BackupPasskeyPanel"
import type { BackupActions } from "../../../src/features/backupPasskey/backupScreen"
import { BALANCE_TIP_BLOCKED_COPY } from "../../../src/features/withdraw/speedChoice"
import {
  etaLabel,
  type WithdrawalSpeed,
} from "../../../src/features/withdraw/WithdrawalSpeedPicker"
import speedCopy from "../../../src/features/withdraw/WithdrawalSpeedPicker.copy"
import { fasterOffers } from "../../../src/features/withdraw/fasterOffers"
import { fmt } from "../../../src/lib/fmt"
import { EmptyDepositError } from "../../../src/features/deposit/depositReadErrors"
import type { BackupFlowDeps } from "../../../src/features/backupPasskey/backupPasskeyRuntime"
import { getRotationDriver } from "../../../src/features/backupPasskey/rotationDrive"
import { closeSession } from "../../../src/session/session"
import { openTestSession } from "../../support/session"
import { balancesOf } from "../../support/balances"
import {
  OWNER,
  PLAN,
  SIPA,
  fasterQuote,
  makeBackupAddDeps,
  makeFlowDeps,
  phaseLine,
  receipt,
  sent,
  signedRecord,
  word,
  type World,
} from "../../support/backupAdd"

/** The store's first record as an external store, as the modal reads the view. */
function recordState(store: BackupRotations) {
  let current: BackupRotationRecord | null = null
  const listeners = new Set<() => void>()
  const set = () => {
    current = store.view.get().records[0] ?? null
    for (const listener of listeners) listener()
  }
  store.view.subscribe(set)
  set()
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    get: () => current,
  }
}

/** Renders the screens over whatever the store holds, as the host does once the deps are built. */
function Host({
  deps,
  approver,
  onFinished,
}: {
  deps: BackupFlowDeps
  approver?: string
  onFinished: () => void
}) {
  const [state] = useState(() => recordState(deps.store))
  const record = useSyncExternalStore(state.subscribe, state.get, state.get)
  return (
    <BackupPasskeyScreens
      keys={{
        keys: [
          {
            pubkeyHex: "ab",
            role: "sign-up",
            signsHere: true,
            ...(approver && { name: approver }),
          },
        ],
        count: 1,
      }}
      saved={record}
      walletBuilt={false}
      flow={{ state: "ready", deps, retry: () => {} }}
      onReadKeys={onFinished}
    />
  )
}

let root: Root
let container: HTMLDivElement
const onFinished = vi.fn()

const flush = async (rounds = 1) => {
  for (let i = 0; i < rounds; i++) await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
}

type Made = ReturnType<typeof makeFlowDeps>

/** A poll that never fires within a test, for the cases that drive the recheck by hand. */
const NO_POLL = 60_000

async function mount(
  record: BackupRotationRecord,
  opts: Parameters<typeof makeFlowDeps>[0] = {},
  pollMs = 0,
  approver?: string,
) {
  const made = makeFlowDeps(opts)
  await made.store.put(record)
  return render(made, false, pollMs, approver)
}

/** Flushes until the stored record reaches `phase`, or gives up after `cap` rounds. */
async function untilPhase(store: BackupRotations, phase: string, cap = 40) {
  for (let i = 0; i < cap; i++) {
    if ((await store.get(OWNER))?.phase === phase) return
    await flush()
  }
}

/** Flushes until `found` holds, or gives up after `cap` rounds. */
async function until(found: () => boolean, cap = 40) {
  for (let i = 0; i < cap; i++) {
    if (found()) return
    await flush()
  }
}

const untilText = (line: string) => until(() => text().includes(line))

/** The session's driver over the test's store, as the wallet's mount starts it. */
function drive(made: Made, pollMs: number) {
  getRotationDriver().start({
    store: made.store,
    deps: async () => made.deps,
    owns: () => true,
    pollMs,
    pace: createPace(),
  })
}

/** Main's balance as the session shows it; the Fund step reads its fit again when it moves. */
const SHOWN_BALANCE = balancesOf({
  main: 3n * 10n ** 18n,
  readThisSession: true,
  known: true,
}).view.get()
const mainBalance = memoryStore(SHOWN_BALANCE)
/** The pace the faster option re-quotes on: a wake quotes again at once. */
const offerPace = createPace()
/** The funding's release read: a minute to land, 30 minutes to release, 10 with a tip. */
const RELEASE: BackupAddRelease = {
  landingSeconds: 60,
  standardEtaSeconds: 1800,
  tippedEtaSeconds: 600,
  l1SlotSeconds: 12,
}
const released = memoryStore({ status: "ready", value: RELEASE, refreshing: false } as const)
const openSession = (made: Made) =>
  openTestSession({
    config: { l1ChainId: 31337, features: {} } as never,
    // A built wallet: the Fund step's Speed row quotes once it is.
    wallet: {},
    balances: { view: mainBalance.readonly, records: balancesOf().records },
    fasterOffer: fasterOffers(
      queries({ pace: offerPace, visible: memoryStore(true).readonly, now: () => Date.now() }),
      made.quoteFaster,
      () => Date.now(),
    ),
    backupAddRelease: () => released.readonly,
  })

async function render(made: Made, strict: boolean, pollMs = 0, approver?: string) {
  // The deposit address's broadcast row reads the session's deposit records, its links the L1.
  openSession(made)
  drive(made, pollMs)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  const host = <Host deps={made.deps} approver={approver} onFinished={onFinished} />
  await act(async () => {
    root.render(strict ? <StrictMode>{host}</StrictMode> : host)
  })
  await flush()
  return made
}

const text = () => container.textContent ?? ""
/** A button by its label or its test id. */
const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent === name || b.dataset.testid === name,
  )
const click = async (label: string) => {
  const b = button(label)
  if (!b) throw new Error(`no button ${label}`)
  await act(async () => b.click())
  await flush()
}
const current = () => container.querySelector('[aria-current="step"]')?.textContent
const row = (label: string) =>
  [...container.querySelectorAll(".ww-sheet__fact")]
    .find((fact) => fact.firstElementChild?.textContent === label)
    ?.querySelector("b")?.textContent
const fundButton = () =>
  container.querySelector<HTMLButtonElement>('[data-testid="backup-fund-continue"]')
/** The Speed row's trigger, reading the chosen speed; absent without an offer. */
const speed = () => container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')
const speedOptions = async () => {
  await act(async () => speed()!.click())
  return [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
}
const pickSpeed = async (key: WithdrawalSpeed) => {
  const option = (await speedOptions()).find((o) => o.textContent?.startsWith(speedCopy[key]))!
  await act(async () => option.click())
  await flush()
}
const errorText = () => container.querySelector('[data-testid="backup-error"]')?.textContent
const badge = () => container.querySelector('[data-testid="badge"]')?.textContent

const FIRST_HASH = word(0x101)
const approveMove = () =>
  container.querySelector<HTMLButtonElement>('[data-testid="backup-move-approve"]')
const retryMove = () => container.querySelector('[data-testid="backup-move-retry"]')

afterEach(async () => {
  getRotationDriver().stop()
  await act(async () => root.unmount())
  container.remove()
  closeSession()
  vi.clearAllMocks()
  vi.useRealTimers()
  mainBalance.set(SHOWN_BALANCE)
})

describe("BackupPasskeyScreens", () => {
  it("keeps Cancel beside Try again when a signed record's checks fail", async () => {
    const made = makeFlowDeps()
    ;(made.deps.route as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rpc down"))
    await made.store.put(signedRecord())
    await render(made, false)
    await flush(3)
    expect(current()).toContain(panelCopy.unverifiable)
    // Announced, since the tracker's own line is not a live region.
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(panelCopy.unverifiable)
    expect(button("Try again")).toBeDefined()
    expect(button("Cancel")).toBeDefined()
    await click("Cancel")
    expect(await made.store.get(OWNER)).not.toBeNull()
    await click("backup-cancel-confirm")
    expect(await made.store.get(OWNER)).toBeNull()
    expect(container.querySelector('[data-testid="backup-cancelled"]')).not.toBeNull()
  })

  it("a parked route whose recheck fails says so, and the next recheck can still return it", async () => {
    const made = await mount(signedRecord(), { world: { route: "route" } }, NO_POLL)
    await untilPhase(made.store, "attention")
    await flush(2)
    expect(errorText()).toBeUndefined()
    const route = made.deps.route as ReturnType<typeof vi.fn>
    route.mockRejectedValueOnce(new Error("rpc down"))
    await click("backup-failed-check")
    await flush(3)
    expect(errorText()).toBe(panelCopy.unverifiable)
    expect((await made.store.get(OWNER))?.attention).toBe("route")
    expect(button("backup-failed-cancel")).toBeDefined()
    made.world.route = "ok"
    await click("backup-failed-check")
    await untilPhase(made.store, "published")
    await flush(3)
    expect(fundButton()).not.toBeNull()
  })

  it("a published record whose funding may still land waits instead of offering the Fund screen", async () => {
    await mount(signedRecord({ phase: "published", ...sent() }), {
      world: { receipts: new Map([[FIRST_HASH, receipt(TxStatus.PENDING)]]) },
    })
    await flush(3)
    expect(fundButton()).toBeNull()
    expect(current()).toContain(trackerCopy.waiting)
    expect(button("Cancel")).toBeUndefined()
  })

  it("publishes once under StrictMode, where effects run twice", async () => {
    const made = makeFlowDeps()
    await made.store.put(signedRecord())
    const seen: string[] = []
    made.store.view.subscribe(() => {
      const r = made.store.view.get().records[0]
      const line = r ? phaseLine(r) : "gone"
      if (line !== "signed" && seen.at(-1) !== line) seen.push(line)
    })
    await render(made, true)
    await untilPhase(made.store, "published")
    await flush(3)
    expect(made.deps.publish).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(["published"])
  })

  it("offers to retry a resume that failed, asks again on its own, and keeps the record", async () => {
    const made = makeFlowDeps({
      world: { receipts: new Map([[FIRST_HASH, receipt(TxStatus.PENDING)]]) },
    })
    // Sent now, so the add is still within its time.
    await made.store.put(signedRecord({ phase: "funded", ...sent(Date.now()) }))
    const sweep = made.deps.l1.sweep as ReturnType<typeof vi.fn>
    sweep.mockRejectedValue(new Error("rpc down"))
    await render(made, false)
    await flush(3)
    expect(current()).toContain(panelCopy.unverifiable)
    expect(container.querySelector('[data-testid="backup-watch-retry"]')).not.toBeNull()
    expect((await made.store.get(OWNER))?.phase).toBe("funded")
    const asked = sweep.mock.calls.length
    await flush(3)
    expect(sweep.mock.calls.length).toBeGreaterThan(asked)
    sweep.mockResolvedValue(undefined)
    await flush(3)
    expect(current()).not.toContain(panelCopy.unverifiable)
    expect(current()).toContain(trackerCopy.waiting)
  })

  it("recovers a stranded funding, ends the attempt at recovered once final, and lets a new add start", async () => {
    const made = await mount(
      signedRecord({
        phase: "attention",
        attention: "stranded",
        suspended: "funded",
        ...sent(5, { outcome: "mined" }),
      }),
      { world: { balance: 1400n } },
    )
    await untilText("Adding this backup stopped.")
    expect(container.querySelector(".ww-backup__step")).toBeNull()
    expect(container.querySelector(".zkm-sheet-shell h2")?.textContent).toBe(panelCopy.title)
    expect(badge()).toBe("Needs recovery")
    // What reached the address, not the 2.00 DAI sent: the withdrawal kept its charges.
    expect(row("Funding")).toBe("1.80 DAI")
    await click("Recover funds")
    expect(made.deps.strandedDeposit).toHaveBeenCalledTimes(1)
    await click("Recover 1.4 DAI")
    await untilText("Recovery sent.")
    expect(badge()).toBe("Recovering")
    expect(button("Recover funds")).toBeUndefined()
    expect(await made.store.get(OWNER)).toMatchObject({
      phase: "attention",
      recovery: { txHash: `0x${"ab".repeat(32)}` },
    })
    await click("Close")
    // Final on L1: the funding reached the address and the recovery emptied it.
    made.world.balance = 0n
    made.world.rows.set(fundingLocalId("attempt-1"), {
      phase: "done",
      l2TxHash: FIRST_HASH,
      withdrawalId: word(0x77),
      startTime: 5,
      recipient: SIPA,
    })
    await untilPhase(made.store, "recovered")
    await untilText("Your funds were sent back.")
    expect(badge()).toBe("Recovered")
    expect(container.querySelector(".ww-backup__step")).toBeNull()
    await click("Done")
    expect(await made.store.get(OWNER)).toBeNull()
    const add = makeBackupAddDeps({ store: made.store })
    await expect(startBackupAdd(add.deps)).resolves.toMatchObject({ phase: "created" })
  })

  it("says plainly when the deposit address holds nothing, without an error, and checks again", async () => {
    const pending = { receipts: new Map([[FIRST_HASH, receipt(TxStatus.PENDING)]]) }
    const held = await mount(
      signedRecord({ phase: "attention", attention: "stranded", suspended: "funded", ...sent() }),
      { world: pending },
      NO_POLL,
    )
    await flush(2)
    vi.mocked(held.deps.strandedDeposit).mockRejectedValueOnce(new EmptyDepositError())
    await click("Recover funds")
    expect(errorText()).toBe("")
    expect(text()).toContain("Nothing at the deposit address right now. This updates shortly.")
    expect(button("Recover funds")).toBeDefined()
    await act(async () => root.unmount())
    container.remove()

    const sentBack = await mount(
      signedRecord({
        phase: "attention",
        attention: "stranded",
        suspended: "funded",
        recovery: { txHash: word(0xab) },
        ...sent(),
      }),
      { world: pending },
      NO_POLL,
    )
    await flush(2)
    vi.mocked(sentBack.deps.strandedDeposit).mockRejectedValueOnce(new EmptyDepositError())
    await click("Check the address")
    expect(errorText()).toBe("")
    expect(text()).toContain("Nothing new at the deposit address.")
    // Funding that lands after the empty check leaves the recovery as it was, so the link must stay.
    expect(container.querySelector('[data-testid="backup-recover-later"]')).not.toBeNull()
    await click("Check the address")
    await click("Recover 1.4 DAI")
    await untilText("Recovery sent.")
    expect((await sentBack.store.get(OWNER))?.recovery?.txHash).toBe(`0x${"ab".repeat(32)}`)
  })

  it("keeps an empty deposit address to the attempt it was checked under", async () => {
    const stranded = (attemptId: string) =>
      signedRecord({
        attemptId,
        phase: "attention",
        attention: "stranded",
        suspended: "funded",
        ...sent(),
      })
    const pending = { receipts: new Map([[FIRST_HASH, receipt(TxStatus.PENDING)]]) }
    const made = await mount(stranded("attempt-1"), { world: pending }, NO_POLL)
    await flush(2)
    vi.mocked(made.deps.strandedDeposit).mockRejectedValueOnce(new EmptyDepositError())
    await click("Recover funds")
    expect(text()).toContain(recoveryCopy.nothingYet)
    await act(async () => void (await made.store.put(stranded("attempt-2"))))
    await flush(2)
    expect(text()).not.toContain(recoveryCopy.nothingYet)
    expect(text()).toContain(recoveryCopy.gas)
  })

  it("says an attempt was dropped while the key read is out, and once it failed", async () => {
    openTestSession()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    const idle = new Proxy({}, { get: () => () => {} }) as BackupActions
    const cancelled = () => container.querySelector('[data-testid="backup-cancelled"]')
    for (const screen of [
      { id: "loading", rotation: false, cancelled: true },
      { id: "unreadable", read: "keys", cancelled: true },
    ] as const) {
      await act(async () => root.render(<BackupStandIn screen={screen} actions={idle} />))
      expect(cancelled()).not.toBeNull()
    }
  })

  it("offers a declined move's retry only once no earlier chunk is back in flight", async () => {
    const made = makeFlowDeps()
    const first = word(0x1a0)
    made.world.receipts.set(first, receipt(TxStatus.PENDING))
    await made.store.put(
      signedRecord({
        phase: "rerooted",
        ...sent(5, { outcome: "swept" }),
        move: {
          runs: [
            {
              plannedAt: 1,
              m: 2,
              depositBound: false,
              declined: true,
              chunks: [
                { token: "tok", amount: "1", state: "submitted", txHash: first, expiresAtMs: 5000 },
                { token: "tok", amount: "1", state: "planned" },
              ],
            },
          ],
        },
      }),
    )
    let built!: (deps: BackupFlowDeps) => void
    getRotationDriver().start({
      store: made.store,
      deps: () => new Promise((resolve) => (built = resolve)),
      owns: () => true,
      pollMs: NO_POLL,
      pace: createPace(),
    })
    openTestSession()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<Host deps={made.deps} onFinished={onFinished} />)
    })
    await flush(3)
    // Checking: the earlier chunk may be back in flight, so no decline is offered yet.
    expect(retryMove()).toBeNull()
    built(made.deps)
    await flush(5)
    expect(retryMove()).toBeNull()
    made.world.receipts.set(first, receipt(TxStatus.PROPOSED))
    getRotationDriver().check(OWNER)
    await until(() => retryMove() !== null)
    expect(retryMove()).not.toBeNull()
    expect(made.deps.move.send).not.toHaveBeenCalled()
  })

  it("asks for no passkey after the panel closes mid-approval", async () => {
    const made = await mount(signedRecord({ phase: "rerooted", ...sent(5, { outcome: "swept" }) }))
    await until(() => approveMove() !== null)
    const shape = made.deps.move.shape as ReturnType<typeof vi.fn>
    let read!: () => void
    shape.mockImplementationOnce(
      () => new Promise((resolve) => (read = () => resolve(made.world.shape))),
    )
    await act(async () => approveMove()!.click())
    await flush(3)
    expect(getRotationDriver().drive(OWNER)?.approving).toBe(true)
    await act(async () => root.unmount())
    root = createRoot(container)
    read()
    await flush(5)
    expect(made.deps.move.send).not.toHaveBeenCalled()
    expect(getRotationDriver().drive(OWNER)?.resume).toEqual({ wait: "approval" })
    expect((await made.store.get(OWNER))?.move?.runs[0]?.chunks[0]?.state).toBe("planned")
  })

  it("shows Checking… and reads nothing until the session's driver runs", async () => {
    const made = makeFlowDeps()
    await made.store.put(signedRecord({ phase: "published" }))
    getRotationDriver().stop()
    openSession(made)
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<Host deps={made.deps} onFinished={onFinished} />)
    })
    await flush(5)
    expect(fundButton()).toBeNull()
    expect(text()).not.toContain(panelCopy.unverifiable)
    expect(made.deps.verify).not.toHaveBeenCalled()
    drive(made, 0)
    await flush(3)
    expect(fundButton()).not.toBeNull()
  })
})

describe("the pay step's speed", () => {
  const DAI = 10n ** 18n
  const TIP = (4n * DAI) / 10n
  const OFFER = {
    proverTip: TIP,
    standardEtaSeconds: 1800,
    tippedEtaSeconds: 600,
    worstSpeedupSeconds: 900,
    measured: true,
  }
  const TIPPED = { fundingAmount: (2n * DAI + TIP).toString(), proverTip: TIP.toString() }
  const UNTIPPED = { fundingAmount: (2n * DAI).toString() }
  /**
   * The figures over the plan's 2 DAI funding, its 1.8 DAI deposit and the 1.4 DAI that comes back,
   * at either speed.
   */
  const figures = {
    standard: { fee: "$0.60", withdrawalFee: "$0.20", total: "$2.00" },
    faster: { fee: "$1.00", withdrawalFee: "$0.60", total: "$2.40" },
  }
  /** The whole wait at a speed: the landing, the release, two relayer pickups, then the settle. */
  const wait = (releaseSeconds: number) => {
    const tail = (2 * 2 + Number(L1_SETTLED_DEPTH)) * RELEASE.l1SlotSeconds
    const minutes = Math.ceil((RELEASE.landingSeconds + releaseSeconds + tail) / 60)
    return fmt(approveCopy.pay.timeValue, { minutes })
  }
  const time = {
    standard: wait(RELEASE.standardEtaSeconds),
    faster: wait(RELEASE.tippedEtaSeconds),
  }
  /** A fact's value by its label. */
  const fact = (label: string) =>
    [...container.querySelectorAll(".zkm-fact-box__row")]
      .find((r) => r.querySelector("dt")?.firstChild?.textContent === label)
      ?.querySelector("dd")?.textContent
  const breakdown = () => container.querySelector('[role="tooltip"]')?.textContent ?? ""

  /**
   * The pay step over a published record; the cap admits the tipped funding unless `world` says
   * otherwise.
   */
  const payStep = async (world: Partial<World> = {}) => {
    const made = await mount(signedRecord({ phase: "published" }), {
      world: { cap: 5n * DAI, ...world },
    })
    await flush(3)
    expect(fundButton()).not.toBeNull()
    return made
  }
  const sentPlan = (made: Made) => vi.mocked(made.deps.fund).mock.calls[0]![0].plan
  const pay = async (made: Made) => {
    await click("backup-fund-continue")
    await flush(3)
    expect(made.deps.fund).toHaveBeenCalledTimes(1)
    return (await made.store.get(OWNER))!.plan!
  }

  it("opens on Faster, prices the cost and the time with the tip, and sends it inside the funding", async () => {
    const made = await payStep({ faster: OFFER })
    expect(speed()?.textContent).toBe(speedCopy.faster)
    expect(fact(approveCopy.pay.from)).toBe(
      fmt(approveCopy.pay.accountBalance, { balance: "$3.00" }),
    )
    expect(fact(approveCopy.pay.fee)).toBe(figures.faster.fee)
    expect(breakdown()).toContain(figures.faster.withdrawalFee)
    expect(fact(holdCopy.label)).toBe(fmt(holdCopy.value, { amount: "$1.40" }))
    expect(fact(approveCopy.pay.total)).toBe(figures.faster.total)
    expect(fact(approveCopy.pay.time)).toBe(time.faster)
    // The button names what leaves the balance, the hold included.
    expect(fundButton()!.textContent).toBe(
      fmt(approveCopy.pay.pay, { amount: figures.faster.total }),
    )
    expect(fundButton()!.disabled).toBe(false)
    const stored = await pay(made)
    expect(sentPlan(made)).toMatchObject(TIPPED)
    expect(stored).toMatchObject({ ...TIPPED, deposited: PLAN.deposited, credited: PLAN.credited })
    await untilPhase(made.store, "funded")
    await flush()
    expect(fundButton()).toBeNull()
  })

  it("sends no tip once Standard is picked, and says how long Standard takes", async () => {
    const made = await payStep({ faster: OFFER })
    await pickSpeed("standard")
    expect(speed()?.textContent).toBe(speedCopy.standard)
    expect(fact(approveCopy.pay.fee)).toBe(figures.standard.fee)
    expect(fact(approveCopy.pay.total)).toBe(figures.standard.total)
    expect(fundButton()!.textContent).toBe(
      fmt(approveCopy.pay.pay, { amount: figures.standard.total }),
    )
    expect(fact(approveCopy.pay.time)).toBe(time.standard)
    const stored = await pay(made)
    expect(sentPlan(made)).toMatchObject(UNTIPPED)
    expect(stored.proverTip).toBeUndefined()
  })

  it("prices Standard without the tip a send that never went out saved in the plan", async () => {
    const made = await mount(signedRecord({ phase: "published", plan: { ...PLAN, ...TIPPED } }), {
      world: { cap: 5n * DAI, faster: OFFER },
    })
    await flush(3)
    await pickSpeed("standard")
    expect(fact(approveCopy.pay.fee)).toBe(figures.standard.fee)
    expect(fact(approveCopy.pay.total)).toBe(figures.standard.total)
    expect(fundButton()!.textContent).toBe(
      fmt(approveCopy.pay.pay, { amount: figures.standard.total }),
    )
    await pay(made)
    expect(sentPlan(made)).toMatchObject(UNTIPPED)
  })

  it("refuses Faster when one transfer cannot carry the funding and the tip, and sends none", async () => {
    // The cap equals the untipped funding, so the tip on top never fits.
    const made = await payStep({ faster: OFFER, cap: 2n * DAI })
    expect(speed()?.textContent).toBe(speedCopy.standard)
    expect(fact(approveCopy.pay.fee)).toBe(figures.standard.fee)
    expect(fact(approveCopy.pay.time)).toBe(time.standard)
    const [standard, blocked] = await speedOptions()
    expect(standard!.textContent).toContain(etaLabel(OFFER.standardEtaSeconds))
    expect(blocked!.textContent).toContain(BALANCE_TIP_BLOCKED_COPY)
    expect(blocked!.disabled).toBe(true)
    await act(async () => standard!.click())
    const stored = await pay(made)
    expect(sentPlan(made)).toMatchObject(UNTIPPED)
    expect(stored.proverTip).toBeUndefined()
  })

  it("refuses Faster when the balance itself is short of the funding and the tip", async () => {
    const held = (22n * DAI) / 10n
    await payStep({ faster: OFFER, shape: { notes: [held], depositTotal: 0n, balance: held } })
    expect(speed()?.textContent).toBe(speedCopy.standard)
    const [, blocked] = await speedOptions()
    expect(blocked!.textContent).toContain(BALANCE_TIP_BLOCKED_COPY)
    expect(blocked!.disabled).toBe(true)
  })

  it("reads the fit again once Main's balance moves, so funds that land open Faster", async () => {
    const held = (22n * DAI) / 10n
    mainBalance.set({ ...SHOWN_BALANCE, main: { atomic: held } })
    const made = await payStep({
      faster: OFFER,
      shape: { notes: [held], depositTotal: 0n, balance: held },
    })
    expect(speed()?.textContent).toBe(speedCopy.standard)
    made.world.shape = { notes: [3n * DAI], depositTotal: 0n, balance: 3n * DAI }
    await act(async () => mainBalance.set({ ...SHOWN_BALANCE, main: { atomic: 3n * DAI } }))
    await flush(3)
    await pickSpeed("faster")
    expect(speed()?.textContent).toBe(speedCopy.faster)
    expect(fact(approveCopy.pay.fee)).toBe(figures.faster.fee)
    const stored = await pay(made)
    expect(sentPlan(made)).toMatchObject(TIPPED)
    expect(stored).toMatchObject(TIPPED)
  })

  it("burns no tip on an offer that would not save a minute, and shows Faster closed", async () => {
    const made = await payStep({ faster: { ...OFFER, worstSpeedupSeconds: 30 } })
    expect(speed()?.textContent).toBe(speedCopy.faster)
    expect(speed()?.disabled).toBe(true)
    expect(fact(approveCopy.pay.fee)).toBe(figures.standard.fee)
    expect(fact(approveCopy.pay.time)).toBe(time.standard)
    const stored = await pay(made)
    expect(sentPlan(made)).toMatchObject(UNTIPPED)
    expect(stored.proverTip).toBeUndefined()
  })

  it("holds the button while the first quote is out, then opens on Faster with it", async () => {
    const made = makeFlowDeps({ world: { cap: 5n * DAI } })
    let answer = () => {}
    made.quoteFaster.mockImplementationOnce(
      () => new Promise((resolve) => (answer = () => resolve(fasterQuote(OFFER)))),
    )
    await made.store.put(signedRecord({ phase: "published" }))
    await render(made, false)
    await flush(3)
    expect(container.querySelector('[aria-busy="true"]')?.textContent).toContain(speedCopy.checking)
    expect(fundButton()!.disabled).toBe(true)
    expect(fact(approveCopy.pay.fee)).toBe(figures.standard.fee)
    await act(async () => answer())
    await flush()
    expect(fundButton()!.disabled).toBe(false)
    expect(speed()?.textContent).toBe(speedCopy.faster)
    expect(fact(approveCopy.pay.fee)).toBe(figures.faster.fee)
  })

  it("drops the tip with the offer once Faster was chosen", async () => {
    const made = await payStep({ faster: OFFER })
    expect(fact(approveCopy.pay.fee)).toBe(figures.faster.fee)
    made.world.faster = undefined
    await act(async () => offerPace.wake())
    await flush()
    expect(speed()).toBeNull()
    expect(fact(approveCopy.pay.fee)).toBe(figures.standard.fee)
    expect(fact(approveCopy.pay.time)).toBe(time.standard)
    const stored = await pay(made)
    expect(sentPlan(made)).toMatchObject(UNTIPPED)
    expect(stored.proverTip).toBeUndefined()
  })

  it("lets the tip through when the fit cannot be read", async () => {
    const made = makeFlowDeps({ world: { faster: OFFER, cap: 2n * DAI } })
    vi.mocked(made.deps.fundable).mockRejectedValue(new Error("unreadable"))
    await made.store.put(signedRecord({ phase: "published" }))
    await render(made, false)
    await flush(3)
    expect(speed()?.textContent).toBe(speedCopy.faster)
    expect(fundButton()!.disabled).toBe(false)
    const stored = await pay(made)
    expect(sentPlan(made)).toMatchObject(TIPPED)
    expect(stored).toMatchObject(TIPPED)
  })

  it("holds the button on Faster while the fit is unread, and opens it on Standard", async () => {
    const made = makeFlowDeps({ world: { faster: OFFER, cap: 5n * DAI } })
    vi.mocked(made.deps.fundable).mockImplementation(() => new Promise(() => {}))
    await made.store.put(signedRecord({ phase: "published" }))
    await render(made, false)
    await flush(3)
    expect(speed()?.textContent).toBe(speedCopy.faster)
    expect(fundButton()!.disabled).toBe(true)
    await pickSpeed("standard")
    expect(fundButton()!.disabled).toBe(false)
    const stored = await pay(made)
    expect(sentPlan(made)).toMatchObject(UNTIPPED)
    expect(stored.proverTip).toBeUndefined()
  })

  /**
   * Holds the route read the send starts with until the returned release runs: the pay step stays
   * on screen with its send in flight, as over a slow chain.
   */
  const holdRoute = (made: Made) => {
    const route = vi.mocked(made.deps.route)
    let release = () => {}
    route.mockImplementation(
      () =>
        new Promise<"ok" | "route">((resolve) => {
          release = () => {
            route.mockImplementation(async () => made.world.route)
            resolve("ok")
          }
        }),
    )
    return () => act(async () => release())
  }

  it("keeps the choice and the figures it was sent with while the funding goes out", async () => {
    const made = await payStep({ faster: OFFER })
    const release = holdRoute(made)
    await click("backup-fund-continue")
    await flush()
    // The quote stops while the funding goes out: the figures are the choice it was sent with.
    expect(fundButton()!.disabled).toBe(true)
    expect(speed()?.textContent).toBe(speedCopy.faster)
    expect(speed()?.disabled).toBe(true)
    expect(fact(approveCopy.pay.fee)).toBe(figures.faster.fee)
    expect(fact(approveCopy.pay.time)).toBe(time.faster)
    await release()
    await untilPhase(made.store, "funded")
    expect(sentPlan(made)).toMatchObject(TIPPED)
    expect((await made.store.get(OWNER))!.plan).toMatchObject(TIPPED)
  })
})
