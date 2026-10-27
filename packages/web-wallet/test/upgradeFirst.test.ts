import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ whenReady: vi.fn() }))
vi.mock("@obsidion/front-core", () => ({ bootPriority: { whenReady: h.whenReady } }))

const { PROBE_FIRST_WAIT_MS, RECORD_CHECK_WAIT_MS, UpgradeFirst } = await import(
  "../src/features/migration/upgradeFirst"
)

/** Whether `promise` has settled once pending callbacks run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false
  void promise.then(() => (done = true))
  await vi.advanceTimersByTimeAsync(0)
  return done
}

beforeEach(() => {
  vi.useFakeTimers()
  // The probe's boot stage waits on the v6 balance, which these tests never reach.
  h.whenReady.mockReturnValue(new Promise(() => {}))
})
afterEach(() => vi.useRealTimers())

describe("UpgradeFirst", () => {
  it("lets v6 start at once when the record is current, and the probe wait for its stage", async () => {
    const gate = new UpgradeFirst()
    const v6 = gate.v6MayStart()
    const probe = gate.probeMayStart()

    gate.recordChecked(false)

    expect(await settled(v6)).toBe(true)
    expect(await settled(probe)).toBe(false)
  })

  it("starts the probe at once for a stale record and holds v6 until it answers", async () => {
    const gate = new UpgradeFirst()
    const v6 = gate.v6MayStart()
    const probe = gate.probeMayStart()

    gate.recordChecked(true)

    expect(await settled(probe)).toBe(true)
    expect(await settled(v6)).toBe(false)
    gate.probeAnswered()
    expect(await settled(v6)).toBe(true)
  })

  it("keeps the first answer, so this browser's last check outranks the record", async () => {
    const gate = new UpgradeFirst()
    gate.recordChecked(false)
    gate.recordChecked(true)

    expect(await settled(gate.v6MayStart())).toBe(true)
  })

  it.each([
    ["the record check never answers", () => {}, RECORD_CHECK_WAIT_MS],
    [
      "the probe never answers",
      (gate: InstanceType<typeof UpgradeFirst>) => gate.recordChecked(true),
      PROBE_FIRST_WAIT_MS,
    ],
  ])("lets v6 start when %s", async (_, act, ms) => {
    const gate = new UpgradeFirst()
    act(gate)
    const v6 = gate.v6MayStart()

    await vi.advanceTimersByTimeAsync(ms - 1)
    expect(await settled(v6)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled(v6)).toBe(true)
  })
})
