import { beforeEach, describe, expect, it, vi } from "vitest"
const h = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock("@obsidion/front-core", () => ({ runMetadataMigration: h.run }))
import {
  runMigrationQueue,
  upgradeApprovals,
  type MigrationQueueJob,
} from "../src/features/migration/runMigrationQueue"
const jobs = [
  { controller: { asset: "DAI" } },
  { controller: { asset: "Savings" } },
] as unknown as MigrationQueueJob[]
beforeEach(() => vi.resetAllMocks())
describe("one upgrade for every asset", () => {
  it("approves both assets, then proves both, before sending DAI, then Savings without another prompt", async () => {
    const order: string[] = []
    h.run.mockImplementation(async (controller, options) => {
      const pass = options.approvalsOnly ? "approve" : options.prepareOnly ? "prove" : "send"
      order.push(`${pass} ${controller.asset}`)
      if (pass === "send") expect(options).toMatchObject({ prompts: false, untilArriving: true })
      return { phase: pass === "send" ? "arriving" : "broadcasting", plan: controller.asset }
    })
    const prepared = vi.fn(() => order.push("prepared"))
    const unsubscribe = vi.fn()
    expect(
      await runMigrationQueue(jobs, {
        signal: new AbortController().signal,
        onActive: () => unsubscribe,
        onPrepared: prepared,
        onArriving: vi.fn(),
      }),
    ).toBe(true)
    expect(order).toEqual([
      "approve DAI",
      "approve Savings",
      "prove DAI",
      "prove Savings",
      "prepared",
      "send DAI",
      "send Savings",
    ])
    expect(unsubscribe).toHaveBeenCalledTimes(6)
  })
  it("runs only the prepare pass inside `prepare`, and gives the send pass `exclusive`", async () => {
    let inPrepare = false
    const seen: { prepare: boolean; inPrepare: boolean; exclusive: unknown }[] = []
    h.run.mockImplementation(async (_controller, options) => {
      const prepare = !!(options.prepareOnly || options.approvalsOnly)
      seen.push({ prepare, inPrepare, exclusive: options.exclusive })
      return { phase: prepare ? "broadcasting" : "arriving", plan: "p" }
    })
    const exclusive = vi.fn()
    let prepares = 0
    const prepare = async <R>(pass: () => Promise<R>): Promise<R> => {
      prepares++
      inPrepare = true
      try {
        return await pass()
      } finally {
        inPrepare = false
      }
    }
    expect(
      await runMigrationQueue(jobs, {
        signal: new AbortController().signal,
        onActive: () => () => {},
        onPrepared: () => expect(inPrepare).toBe(false),
        onArriving: vi.fn(),
        prepare,
        exclusive,
      }),
    ).toBe(true)
    expect(prepares).toBe(1)
    expect(seen).toEqual([
      { prepare: true, inPrepare: true, exclusive: undefined },
      { prepare: true, inPrepare: true, exclusive: undefined },
      { prepare: true, inPrepare: true, exclusive: undefined },
      { prepare: true, inPrepare: true, exclusive: undefined },
      { prepare: false, inPrepare: false, exclusive },
      { prepare: false, inPrepare: false, exclusive },
    ])
  })
  it("sends nothing when the Savings approval is refused", async () => {
    h.run
      .mockResolvedValueOnce({ phase: "broadcasting", plan: "DAI" })
      .mockResolvedValueOnce({ phase: "needsAttention", refused: true })
    const onPrepared = vi.fn()
    expect(
      await runMigrationQueue(jobs, {
        signal: new AbortController().signal,
        onActive: () => () => {},
        onPrepared,
        onArriving: vi.fn(),
      }),
    ).toBe(false)
    expect(h.run).toHaveBeenCalledTimes(2)
    expect(h.run.mock.calls.every(([, options]) => options.approvalsOnly)).toBe(true)
    expect(onPrepared).not.toHaveBeenCalled()
  })
  it("does not send Savings if the registration run stops", async () => {
    h.run
      .mockResolvedValueOnce({ phase: "broadcasting" })
      .mockResolvedValueOnce({ phase: "broadcasting" })
      .mockResolvedValueOnce({ phase: "needsApproval" })
    expect(
      await runMigrationQueue(jobs, {
        signal: new AbortController().signal,
        onActive: () => () => {},
        onPrepared: vi.fn(),
        onArriving: vi.fn(),
      }),
    ).toBe(false)
    expect(h.run).toHaveBeenCalledTimes(3)
  })
})

describe("an upgrade's approvals", () => {
  it("counts every run's approvals as one, quoted for a run that has asked none", () => {
    expect(
      upgradeApprovals([
        { record: { approvals: { approved: 1, total: 1 } } as never },
        { record: { approvals: { approved: 0, total: 2 } } as never },
        { summary: { fees: "0", approvals: 3 } },
      ]),
    ).toEqual({ approved: 1, total: 6 })
  })

  it("counts a saved run's quote until it asks", () => {
    expect(
      upgradeApprovals([{ record: { summary: { fees: "0", approvals: 2 } } as never }]),
    ).toEqual({ approved: 0, total: 2 })
  })

  it("has no count for an upgrade that asks nothing", () => {
    expect(upgradeApprovals([{ summary: { fees: "0", approvals: 0 } }, {}])).toBeUndefined()
  })
})
