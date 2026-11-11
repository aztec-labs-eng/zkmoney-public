// @vitest-environment node
/** The Fund step's fit read over held `fundable` answers and the session's shown balance. */
import { memoryStore, type BalanceView, type Store } from "@obsidion/front-core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { openFundFitFlow } from "../../../src/features/backupPasskey/fundFitFlow"
import { balancesOf } from "../../support/balances"

type Fits = (amount: bigint) => boolean

const upTo =
  (cap: bigint): Fits =>
  (amount) =>
    amount <= cap

/** Each `fundable` call, held until the test answers or fails it. */
function heldReads() {
  const reads: { answer(fits: Fits): void; fail(): void }[] = []
  const fundable = () =>
    new Promise<Fits>((resolve, reject) =>
      reads.push({ answer: resolve, fail: () => reject(new Error("unread")) }),
    )
  return { fundable, reads }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("the Fund step's fit read", () => {
  let balances: Store<BalanceView>
  let ended: AbortController
  const moveMain = (atomic: bigint) => balances.set({ ...balances.get(), main: { atomic } })

  const started = () => {
    const held = heldReads()
    const flow = openFundFitFlow({ deps: held, balances: balances.readonly })
    flow.start(ended.signal)
    return { ...held, state: flow.state }
  }

  beforeEach(() => {
    balances = memoryStore(balancesOf({ main: 3n, readThisSession: true }).view.get())
    ended = new AbortController()
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    ended.abort()
    vi.restoreAllMocks()
  })

  it("reads the fit once it starts", async () => {
    const { reads, state } = started()
    expect(state.get()).toEqual({ done: false })
    const fits = upTo(5n)
    reads[0]!.answer(fits)
    await settle()
    expect(state.get()).toEqual({ fits, done: true })
  })

  it("reads again when Main's balance moves, keeping the last fit until the new one answers", async () => {
    const { reads, state } = started()
    const before = upTo(2n)
    reads[0]!.answer(before)
    await settle()
    moveMain(4n)
    expect(reads).toHaveLength(2)
    expect(state.get().fits).toBe(before)
    const after = upTo(4n)
    reads[1]!.answer(after)
    await settle()
    expect(state.get()).toEqual({ fits: after, done: true })
  })

  it("reads nothing when the balance changes but Main's figure does not", async () => {
    const { reads } = started()
    balances.set({ ...balances.get(), syncing: true })
    moveMain(3n)
    expect(reads).toHaveLength(1)
  })

  it("drops a read's answer once a newer read began", async () => {
    const { reads, state } = started()
    moveMain(4n)
    reads[0]!.answer(upTo(2n))
    await settle()
    expect(state.get()).toEqual({ done: false })
    const latest = upTo(4n)
    reads[1]!.answer(latest)
    await settle()
    expect(state.get()).toEqual({ fits: latest, done: true })
  })

  it("ends a failed read done with no fit, the earlier fit dropped", async () => {
    const { reads, state } = started()
    reads[0]!.fail()
    await settle()
    expect(state.get()).toEqual({ done: true })
    moveMain(4n)
    reads[1]!.answer(upTo(4n))
    await settle()
    moveMain(5n)
    reads[2]!.fail()
    await settle()
    expect(state.get()).toEqual({ done: true })
  })

  it("takes no answer and reads nothing more once the step ends", async () => {
    const { reads, state } = started()
    ended.abort()
    reads[0]!.answer(upTo(5n))
    await settle()
    expect(state.get()).toEqual({ done: false })
    moveMain(4n)
    expect(reads).toHaveLength(1)
  })
})
