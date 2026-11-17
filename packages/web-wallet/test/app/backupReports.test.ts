import { describe, expect, it, vi } from "vitest"
import {
  createBackupFunnel,
  createBackupRotations,
  memoryBackend,
  openDatabase,
  startRuntime,
} from "@obsidion/front-core"
import { sessions } from "../../../front-core/test/engine/taskTable"
import { signedRecord } from "../support/backupAdd"

vi.stubEnv("VITE_ZKMONEY_API_URL", "https://api.test")
const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response)
const { bindAnalyticsConsent } = await import("../../src/lib/analytics")
const { backupReports } = await import("../../src/app/backupReports")

const phases = () =>
  fetchSpy.mock.calls.map(([, init]) => {
    const { event, props } = JSON.parse(String(init?.body))
    return [event, props.phase]
  })

describe("backupReports", () => {
  it("reports each step a saved attempt reached once read, and the next as it moves", async () => {
    bindAnalyticsConsent(() => true)
    const db = openDatabase(memoryBackend())
    const rotations = createBackupRotations({ db })
    await rotations.put(signedRecord({ updatedAt: 2 }))

    const runtime = sessions(startRuntime)
    runtime.tasks.push(backupReports({ rotations, funnel: createBackupFunnel({ db }) }))
    runtime.start()
    await expect.poll(phases).toEqual([["backup_rotation_phase", "signed"]])

    await rotations.put(signedRecord({ phase: "published", updatedAt: 3 }))
    await expect.poll(phases).toEqual([
      ["backup_rotation_phase", "signed"],
      ["backup_rotation_phase", "published"],
    ])
    runtime.end()
  })
})
