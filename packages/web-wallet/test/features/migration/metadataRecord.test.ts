import { createPace } from "@obsidion/core/cadence"
import {
  fixed,
  memoryBackend,
  memoryStore,
  openDatabase,
  queries,
  startRuntime,
  type Milestone,
} from "@obsidion/front-core"
import type { AccountRecordState, ObsidionAccount } from "@obsidion/sdk"
import { describe, expect, it } from "vitest"
import {
  metadataRecordStates,
  oldVersionsByRecord,
} from "../../../src/features/migration/metadataRecord"

async function boot(state: AccountRecordState) {
  const pace = createPace()
  const query = queries({ pace, visible: memoryStore(true).readonly, now: () => Date.now() })
  const account = fixed("account", {} as ObsidionAccount)
  let reads = 0
  const record = metadataRecordStates(query, account, async () => {
    reads += 1
    return state
  })
  const marked: Milestone[] = []
  const task = oldVersionsByRecord({ account, record, milestones: { mark: (m) => marked.push(m) } })
  const runtime = startRuntime([task], {
    db: openDatabase(memoryBackend()),
    milestones: { after: async () => true, reached: () => false },
    visible: memoryStore(true).readonly,
    pace,
    now: () => Date.now(),
    sinceLoad: () => performance.now(),
  })
  await runtime.wake(task)
  return { marked, record, reads: () => reads, stop: () => runtime.stop() }
}

describe("oldVersionsByRecord", () => {
  it("ends the old versions' hold when the record names the account on this version", async () => {
    const run = await boot("current")
    expect(run.marked).toEqual(["oldVersionsRead"])
    run.stop()
  })

  it.each(["other", "none"] as const)("leaves the hold to the upgrade check for %s", async (s) => {
    const run = await boot(s)
    expect(run.marked).toEqual([])
    run.stop()
  })

  it("reads the record once for the Task and the boot's choice", async () => {
    const run = await boot("current")
    expect(await run.record().read()).toBe("current")
    expect(run.reads()).toBe(1)
    run.stop()
  })
})
