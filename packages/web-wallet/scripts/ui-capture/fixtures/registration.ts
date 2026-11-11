import * as actual from "../../../src/features/registration/webRegistration"
import { currentRegistration } from "@obsidion/front-core"
import { captureSession, fixtureState, operation } from "./control"
import { putRegistration } from "./registration-seed"
export * from "../../../src/features/registration/webRegistration"

export const buildWebDetectionDeps: typeof actual.buildWebDetectionDeps = async (...args) => {
  if (!fixtureState()) return actual.buildWebDetectionDeps(...args)
  return {} as Awaited<ReturnType<typeof actual.buildWebDetectionDeps>>
}
export const runDetectionTick: typeof actual.runDetectionTick = async (...args) => {
  if (!fixtureState()) return actual.runDetectionTick(...args)
  // The background task's ticks leave the seeded records as they are.
  if (!args[1]?.force) return { outcome: "pending", nextMs: 0 }
  await operation("registration-check")
  const session = captureSession()
  const record = currentRegistration(actual.loadedRegistrations(session.registrations))
  if (record)
    await putRegistration(session, {
      ...record,
      broadcast: true,
      retries: 0,
      startTime: Date.now(),
    })
  return { outcome: "pending", nextMs: 0 }
}
