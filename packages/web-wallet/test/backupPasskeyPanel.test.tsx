import { StrictMode, act, useState, useSyncExternalStore } from "react"
import { createRoot, type Root } from "react-dom/client"
import { TxStatus } from "@aztec-labs/stdlib/tx"
import { BackupRotationStore, type BackupRotationRecord } from "@obsidion/front-core"
import { BackupCredentialIdLengthError, type PersistedRotationVerdict } from "@obsidion/sdk"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/web-ds", () => ({
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
  Spinner: () => null,
}))

import { BackupPasskeyPanel, errorLine } from "../src/features/backupPasskey/BackupPasskeyPanel"
import type { BackupFlowDeps } from "../src/features/backupPasskey/backupPasskeyRuntime"
import {
  OWNER,
  PLAN,
  SIPA,
  createdRecord,
  makeFlowDeps,
  phaseLine,
  receipt,
  sent,
  signedRecord,
  word,
  type World,
} from "./support/backupAdd"

/** The store's first record as an external store, delivered the way the modal's subscription is. */
function recordState(store: BackupRotationStore) {
  let current: BackupRotationRecord | null = null
  const listeners = new Set<() => void>()
  const set = (records: readonly BackupRotationRecord[]) => {
    current = records[0] ?? null
    for (const listener of listeners) listener()
  }
  store.onChanged(set)
  void store.list().then(set)
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    get: () => current,
  }
}

/** Renders the panel over whatever the store holds, as the modal does. */
function Host({
  deps,
  approver,
  onCancelled,
  onFinished,
  pollMs,
}: {
  deps: BackupFlowDeps
  approver?: string
  onCancelled: () => void
  onFinished: () => void
  pollMs: number
}) {
  const [state] = useState(() => recordState(deps.store))
  const record = useSyncExternalStore(state.subscribe, state.get, state.get)
  return record ? (
    <BackupPasskeyPanel
      record={record}
      deps={deps}
      approver={approver}
      onCancelled={onCancelled}
      onFinished={onFinished}
      pollMs={pollMs}
    />
  ) : (
    <p data-testid="no-record" />
  )
}

let root: Root
let container: HTMLDivElement
const onCancelled = vi.fn()
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
async function untilPhase(store: BackupRotationStore, phase: string, cap = 40) {
  for (let i = 0; i < cap; i++) {
    if ((await store.get(OWNER))?.phase === phase) return
    await flush()
  }
}

/** Flushes until the text shows, or gives up after `cap` rounds. */
async function untilText(line: string, cap = 40) {
  for (let i = 0; i < cap; i++) {
    if (text().includes(line)) return
    await flush()
  }
}

async function render(made: Made, strict: boolean, pollMs = 0, approver?: string) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  const host = (
    <Host
      deps={made.deps}
      approver={approver}
      onCancelled={onCancelled}
      onFinished={onFinished}
      pollMs={pollMs}
    />
  )
  await act(async () => {
    root.render(strict ? <StrictMode>{host}</StrictMode> : host)
  })
  await flush()
  return made
}

const text = () => container.textContent ?? ""
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label)
const click = async (label: string) => {
  const b = button(label)
  if (!b) throw new Error(`no button ${label}`)
  await act(async () => b.click())
  await flush()
}
const current = () => container.querySelector('[aria-current="step"]')?.textContent
const steps = () =>
  [...container.querySelectorAll(".ww-backup__step")].map((li) =>
    li.className.includes("--done")
      ? "done"
      : li.className.includes("--current")
      ? "current"
      : "todo",
  )
const row = (label: string) =>
  [...container.querySelectorAll(".ww-sheet__fact")]
    .find((fact) => fact.firstElementChild?.textContent === label)
    ?.querySelector("b")?.textContent
const fundScreen = () => container.querySelector('[data-testid="backup-fund"]')
const errorText = () => container.querySelector('[data-testid="backup-error"]')?.textContent

const FIRST_HASH = word(0x101)
const DONE_LINE = "Your backup passkey is ready."

/** Finalizes every transaction the fake node holds, until the record is done or `cap` rounds pass. */
async function settleMove(made: Made, cap = 40) {
  for (let i = 0; i < cap; i++) {
    if ((await made.store.get(OWNER))?.phase === "done") return
    for (const hash of made.world.receipts.keys()) {
      made.world.receipts.set(hash, receipt(TxStatus.FINALIZED))
    }
    await flush()
  }
}

/** The world once the funding mined and the sweep ran, so the record moves to swept. */
async function swept(made: Made) {
  made.world.receipts.set(FIRST_HASH, receipt(TxStatus.FINALIZED))
  made.world.sweep = { index: "1", blockNumber: 90, blockHash: word(0x90), credited: 1400n }
  for (const funding of (await made.store.get(OWNER))?.fundings ?? []) {
    made.world.rows.set(funding.localId, {
      phase: "done",
      l2TxHash: funding.txHash,
      withdrawalId: word(0x77),
      startTime: funding.sentAt,
      recipient: SIPA,
    })
  }
}

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe("BackupPasskeyPanel", () => {
  it("walks a created attempt through the approval, the publish, the Fund screen and the funding", async () => {
    const made = await mount(createdRecord())
    const { store, deps } = made
    expect(steps()).toEqual(["done", "current", "todo", "todo", "todo"])
    expect(current()).toContain("Approve with your current passkey")
    expect(button("Cancel")).toBeDefined()

    await click("Approve with your current passkey")
    await untilPhase(store, "published")
    expect(deps.prepare).toHaveBeenCalledTimes(1)
    expect(deps.sign).toHaveBeenCalledTimes(1)
    expect(deps.publish).toHaveBeenCalledTimes(1)
    await flush(3)
    expect(current()).toContain("Fund")
    expect(fundScreen()).not.toBeNull()
    expect(row("Your new account")).toBe(`${word(0x2b).slice(0, 6)}…${word(0x2b).slice(-4)}`)
    expect(row("Fees")).toBe("0.60 DAI")
    expect(row("You'll receive")).toBe("1.40 DAI")
    expect(row("Approvals")).toBe("1 now, then 2 to move your balance")
    expect(row("Takes")).toBe("Up to 40 minutes")
    expect(text()).toContain(
      "Once sent, the funding cannot be cancelled. You can close this tab while it waits.",
    )
    expect(text()).toContain("The approval you gave stays usable until your account next changes.")

    await click("Fund and continue")
    await flush(3)
    expect(deps.fund).toHaveBeenCalledTimes(1)
    const funded = (await store.get(OWNER))!
    expect(funded.fundings[0]).toMatchObject({ txHash: FIRST_HASH, outcome: "pending" })
    expect(fundScreen()).toBeNull()
    expect(current()).toContain("Waiting for the network")
    expect(text()).toContain("Your funding is on its way.")
    expect(text()).toContain("can take up to 40 minutes")
    expect(text()).toContain("You can close this tab and come back later")
    expect(button("Cancel")).toBeUndefined()

    await swept(made)
    await untilPhase(store, "rerooted")
    expect(deps.reroot).toHaveBeenCalledTimes(1)
    await untilText("Moving your balance")
    expect(steps()).toEqual(["done", "done", "done", "done", "current"])
    expect(button("Cancel")).toBeUndefined()
    await settleMove(made)
    expect(await store.get(OWNER)).toMatchObject({ phase: "done" })
    expect(deps.move.send).toHaveBeenCalledTimes(2)
    await untilText(DONE_LINE)
    await click("Done")
    expect(onFinished).toHaveBeenCalledTimes(1)
    expect(await store.get(OWNER)).toBeNull()
  })

  it("cancels a created attempt and tells the caller", async () => {
    const { store } = await mount(createdRecord())
    await click("Cancel")
    expect(onCancelled).toHaveBeenCalledTimes(1)
    expect(await store.get(OWNER)).toBeNull()
  })

  it("keeps Cancel and the broadcast's status while the deposit address is being published", async () => {
    const made = makeFlowDeps()
    made.deps.publish = vi.fn(() => new Promise<void>(() => {}))
    await made.store.put(signedRecord())
    await render(made, false)
    await flush(2)
    expect(current()).toContain("Fund")
    expect(text()).toContain("Publishing your deposit address.")
    expect(container.querySelector('[data-testid="broadcast-status"]')).not.toBeNull()
    expect(fundScreen()).toBeNull()
    await click("Cancel")
    expect(onCancelled).toHaveBeenCalledTimes(1)
    expect(await made.store.get(OWNER)).toBeNull()
  })

  it("offers the Fund screen again after a funding that never went out, at the Fund step", async () => {
    await mount(signedRecord({ phase: "published", ...sent(5, { outcome: "never-sent" }) }))
    await flush(3)
    expect(fundScreen()).not.toBeNull()
    expect(current()).toContain("Fund")
    expect(text()).not.toContain("Your funding is on its way.")
  })

  it("keeps Check again and Cancel on a parked route whose only funding never went out", async () => {
    await mount(
      signedRecord({
        phase: "attention",
        attention: "route",
        suspended: "published",
        ...sent(5, { outcome: "never-sent" }),
      }),
      { world: { route: "route" } },
      NO_POLL,
    )
    await flush(2)
    expect(text()).toContain("The network is not paying for this right now.")
    expect(button("Check again")).toBeDefined()
    expect(button("Cancel")).toBeDefined()
  })

  it("asks the chain again on its own while a funded attempt is parked on the route", async () => {
    const made = await mount(
      signedRecord({ phase: "attention", attention: "route", suspended: "funded", ...sent() }),
      { world: { route: "route", receipts: new Map([[FIRST_HASH, receipt(TxStatus.PENDING)]]) } },
    )
    await flush(2)
    expect(text()).toContain("The network is not paying for this right now.")
    expect(button("Check again")).toBeUndefined()
    const route = made.deps.route as ReturnType<typeof vi.fn>
    const asked = route.mock.calls.length
    await flush(3)
    expect(route.mock.calls.length).toBeGreaterThan(asked)
    made.world.route = "ok"
    await untilPhase(made.store, "funded")
    await flush(2)
    expect(text()).not.toContain("The network is not paying for this right now.")
    expect(current()).toContain("Waiting for the network")
  })

  it("keeps Cancel beside Try again when a signed record's checks fail", async () => {
    const made = makeFlowDeps()
    ;(made.deps.route as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rpc down"))
    await made.store.put(signedRecord())
    await render(made, false)
    await flush(3)
    expect(errorText()).toBe("Could not check, try again")
    expect(button("Try again")).toBeDefined()
    expect(button("Cancel")).toBeDefined()
    await click("Cancel")
    expect(onCancelled).toHaveBeenCalledTimes(1)
  })

  it("refuses to cancel once the deposit address shows money, and says so", async () => {
    const made = makeFlowDeps({ world: { balance: 1n } })
    made.deps.publish = vi.fn(() => new Promise<void>(() => {}))
    await made.store.put(signedRecord())
    await render(made, false)
    await flush(2)
    await click("Cancel")
    expect(errorText()).toContain("money may have reached its deposit address")
    expect(onCancelled).not.toHaveBeenCalled()
    expect((await made.store.get(OWNER))?.phase).toBe("signed")
  })

  it("parks a route that stopped paying, and returns it to the Fund screen on Check again", async () => {
    const made = await mount(signedRecord(), { world: { route: "route" } }, NO_POLL)
    await untilPhase(made.store, "attention")
    await flush(2)
    expect(text()).toContain("The network is not paying for this right now.")
    expect(button("Check again")).toBeDefined()
    expect(button("Cancel")).toBeDefined()
    expect(fundScreen()).toBeNull()
    made.world.route = "ok"
    await click("Check again")
    await untilPhase(made.store, "published")
    await flush(3)
    expect(fundScreen()).not.toBeNull()
  })

  it("a parked route whose recheck fails says so, and the next recheck can still return it", async () => {
    const made = await mount(signedRecord(), { world: { route: "route" } }, NO_POLL)
    await untilPhase(made.store, "attention")
    await flush(2)
    expect(text()).toContain("The network is not paying for this right now.")
    const route = made.deps.route as ReturnType<typeof vi.fn>
    route.mockRejectedValueOnce(new Error("rpc down"))
    await click("Check again")
    await flush(3)
    expect(text()).toContain("Could not check, try again")
    expect(text()).not.toContain("The network is not paying for this right now.")
    expect((await made.store.get(OWNER))?.attention).toBe("route")
    expect(button("Cancel")).toBeDefined()
    made.world.route = "ok"
    await click("Check again")
    await untilPhase(made.store, "published")
    await flush(3)
    expect(fundScreen()).not.toBeNull()
  })

  it("reopens a funded attempt at the waiting step with no cancel", async () => {
    await mount(signedRecord({ phase: "funded", ...sent() }), {
      world: { receipts: new Map([[FIRST_HASH, receipt(TxStatus.PENDING)]]) },
    })
    await flush(3)
    expect(current()).toContain("Waiting for the network")
    expect(text()).toContain("Your funding is on its way.")
    expect(button("Cancel")).toBeUndefined()
    expect(fundScreen()).toBeNull()
  })

  it("a published record whose funding may still land waits instead of offering the Fund screen", async () => {
    await mount(signedRecord({ phase: "published", ...sent() }), {
      world: { receipts: new Map([[FIRST_HASH, receipt(TxStatus.PENDING)]]) },
    })
    await flush(3)
    expect(fundScreen()).toBeNull()
    expect(current()).toContain("Waiting for the network")
    expect(button("Cancel")).toBeUndefined()
  })

  it("follows a funded attempt through the re-root and the move to done once its sweep is final", async () => {
    const made = await mount(signedRecord({ phase: "funded", ...sent() }))
    await swept(made)
    await untilPhase(made.store, "rerooted")
    expect(made.deps.reroot).toHaveBeenCalledTimes(1)
    await settleMove(made)
    expect((await made.store.get(OWNER))?.phase).toBe("done")
    await untilText(DONE_LINE)
  })

  it("keeps the record and offers a retry when the re-root fails, and asks again on its own", async () => {
    const made = makeFlowDeps()
    ;(made.deps.reroot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rebind failed"))
    await made.store.put(signedRecord({ phase: "funded", ...sent() }))
    await render(made, false)
    await swept(made)
    await untilText("Could not check, try again")
    expect(container.querySelector('[data-testid="backup-watch-retry"]')).not.toBeNull()
    expect((await made.store.get(OWNER))?.phase).toBe("swept")
    const asked = (made.deps.reroot as ReturnType<typeof vi.fn>).mock.calls.length
    await flush(3)
    expect((made.deps.reroot as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(asked)
  })

  it("publishes once under StrictMode, where effects run twice", async () => {
    const made = makeFlowDeps()
    await made.store.put(signedRecord())
    const seen: string[] = []
    made.store.onChanged(([r]) => {
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
    await made.store.put(signedRecord({ phase: "funded", ...sent() }))
    const sweep = made.deps.l1.sweep as ReturnType<typeof vi.fn>
    sweep.mockRejectedValue(new Error("rpc down"))
    await render(made, false)
    await flush(3)
    expect(errorText()).toBe("Could not check, try again")
    expect(container.querySelector('[data-testid="backup-watch-retry"]')).not.toBeNull()
    expect((await made.store.get(OWNER))?.phase).toBe("funded")
    const asked = sweep.mock.calls.length
    await flush(3)
    expect(sweep.mock.calls.length).toBeGreaterThan(asked)
    sweep.mockResolvedValue(undefined)
    await flush(3)
    expect(errorText()).toBe("")
    expect(current()).toContain("Waiting for the network")
  })

  it("runs a paused move again on Try again", async () => {
    const made = await mount(
      signedRecord({ phase: "attention", attention: "move", suspended: "rerooted", ...sent() }),
      { world: { receipts: new Map([[FIRST_HASH, receipt(TxStatus.PENDING)]]) } },
      NO_POLL,
    )
    await flush(2)
    expect(text()).toContain("It stays yours on your previous account.")
    expect(made.deps.move.send).not.toHaveBeenCalled()
    await click("Try again")
    await untilPhase(made.store, "rerooted")
    expect(made.deps.move.send).toHaveBeenCalledTimes(1)
    expect(await made.store.get(OWNER)).toMatchObject({
      phase: "rerooted",
      attention: undefined,
      move: { runs: [{ chunks: [{ state: "submitted" }, { state: "planned" }] }] },
    })
  })

  it("starts over from a conflict by dropping the record", async () => {
    const { store } = await mount(createdRecord({ phase: "conflict" }))
    await click("Start over")
    expect(onCancelled).toHaveBeenCalledTimes(1)
    expect(await store.get(OWNER)).toBeNull()
  })

  it("starts over from a damaged record nothing was sent for", async () => {
    const { store } = await mount(
      signedRecord({ phase: "attention", attention: "corrupt", suspended: "signed" }),
    )
    await flush(2)
    await click("Start over")
    expect(onCancelled).toHaveBeenCalledTimes(1)
    expect(await store.get(OWNER)).toBeNull()
  })

  it("shows the move's progress under the step and finishes the run", async () => {
    const made = await mount(
      signedRecord({
        phase: "moved",
        ...sent(5, { outcome: "swept" }),
        sweep: { index: "1", blockHash: word(0x90), credited: "1400" },
        move: {
          runs: [
            {
              plannedAt: 1,
              m: 2,
              depositBound: false,
              chunks: [{ token: "tok", amount: "1", state: "mined" }],
            },
          ],
        },
      }),
    )
    await untilText("Moving your balance (1 of 2).")
    expect(made.deps.move.tokens).toHaveBeenCalled()
    expect(steps()).toEqual(["done", "done", "done", "done", "current"])
    await settleMove(made)
    expect((await made.store.get(OWNER))?.phase).toBe("done")
  })

  it("renders each attention reason with only its permitted actions", async () => {
    const pending = { receipts: new Map([[FIRST_HASH, receipt(TxStatus.PENDING)]]) }
    const corrupt = {
      verdict: {
        verdict: "corrupt",
        reason: "the signature",
      } as unknown as PersistedRotationVerdict,
    }
    const cases: [BackupRotationRecord, Partial<World>, string, string[]][] = [
      [
        signedRecord({ phase: "attention", attention: "stranded", suspended: "funded", ...sent() }),
        pending,
        "Your funding is held at the deposit address. Nothing to do yet.",
        [],
      ],
      [
        signedRecord({ phase: "attention", attention: "corrupt", suspended: "funded", ...sent() }),
        { ...pending, ...corrupt },
        "Keep this browser; support can recover it.",
        [],
      ],
      [
        signedRecord({ phase: "attention", attention: "corrupt", suspended: "signed" }),
        corrupt,
        "This attempt's record is damaged.",
        ["Start over"],
      ],
      [
        signedRecord({ phase: "attention", attention: "move", suspended: "rerooted", ...sent() }),
        pending,
        "It stays yours on your previous account.",
        ["Try again"],
      ],
      [
        signedRecord({ phase: "attention", attention: "route", suspended: "funded", ...sent() }),
        { ...pending, route: "route" },
        "The network is not paying for this right now.",
        [],
      ],
      // Funded from outside, with no funding of ours: the money's salt cannot be dropped.
      [
        signedRecord({ phase: "attention", attention: "route", suspended: "funded" }),
        { route: "route", balance: BigInt(PLAN.fundingAmount) },
        "The network is not paying for this right now.",
        ["Check again"],
      ],
      [
        createdRecord({ phase: "conflict" }),
        {},
        "Your passkeys changed on another device.",
        ["Start over"],
      ],
      [
        signedRecord({ phase: "conflict", ...sent() }),
        pending,
        "Your passkeys changed on another device.",
        [],
      ],
    ]
    for (const [record, world, line, actions] of cases) {
      await mount(record, { world }, NO_POLL)
      await flush(2)
      expect(text()).toContain(line)
      expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toEqual(actions)
      expect(container.querySelector('[aria-current="step"]')).toBeNull()
      await act(async () => root.unmount())
      container.remove()
    }
    await mount(createdRecord())
  })

  it("shows an inline error when the approval fails and keeps the record", async () => {
    const made = await mount(createdRecord())
    made.deps.sign = vi.fn(async () => {
      throw new Error("declined")
    })
    await click("Approve with your current passkey")
    expect(errorText()).toBe("Could not check, try again")
    expect((await made.store.get(OWNER))?.phase).toBe("created")
  })

  it("names the passkey that approves, in the line under the step and on the button", async () => {
    await mount(createdRecord(), {}, 0, "Security key")
    expect(container.querySelector(".ww-backup__detail")?.textContent).toBe(
      "Use Security key (the one you signed in with). Only a passkey already on your account can add a new one.",
    )
    expect(container.querySelector('[aria-current="step"] b')?.textContent).toBe("Security key")
    expect(button("Approve with Security key")).toBeDefined()
  })

  it("keeps the generic line for an approval that fails for another reason", async () => {
    const made = await mount(createdRecord(), {}, 0, "Security key")
    made.deps.sign = vi.fn(async () => {
      throw new Error("rpc")
    })
    await click("Approve with Security key")
    expect(errorText()).toBe("Could not check, try again")
  })

  it("says to use the passkey signed in with where its name is not known", async () => {
    await mount(createdRecord())
    expect(current()).toContain(
      "Use the passkey you signed in with. Only a passkey already on your account can add a new one.",
    )
    expect(container.querySelector('[aria-current="step"] b')).toBeNull()
  })

  it("names the approving passkey when the approval prompt ends without it", async () => {
    const made = await mount(createdRecord(), {}, 0, "Security key")
    made.deps.sign = vi.fn(async () => {
      throw new DOMException("closed", "NotAllowedError")
    })
    await click("Approve with Security key")
    expect(errorText()).toBe(
      "Use Security key, the passkey you signed in with. The new backup can't approve itself.",
    )
    expect(container.querySelector('[data-testid="backup-error"] b')?.textContent).toBe(
      "Security key",
    )
    expect((await made.store.get(OWNER))?.phase).toBe("created")
    await act(async () => root.unmount())
    container.remove()

    const unnamed = await mount(createdRecord())
    unnamed.deps.sign = vi.fn(async () => {
      throw new DOMException("closed", "NotAllowedError")
    })
    await click("Approve with your current passkey")
    expect(errorText()).toBe(
      "Use the passkey you signed in with. The new backup can't approve itself.",
    )
  })

  it("drops a finished record on Done", async () => {
    const { store } = await mount(signedRecord({ phase: "done", ...sent(5, { outcome: "swept" }) }))
    await flush(2)
    expect(steps()).toEqual(["done", "done", "done", "done", "done"])
    expect(text()).toContain("Your backup passkey is ready.")
    await click("Done")
    expect(onFinished).toHaveBeenCalledTimes(1)
    expect(await store.get(OWNER)).toBeNull()
  })
})

describe("errorLine", () => {
  it("names a credential id the account cannot store, which no retry changes", () => {
    expect(errorLine(new BackupCredentialIdLengthError(129))).toBe(
      "This passkey can't be a backup: its credential id is longer than the account can store. Cancel and use another passkey.",
    )
  })
})
