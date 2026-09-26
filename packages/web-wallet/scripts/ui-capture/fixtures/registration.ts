import * as actual from "../../../src/features/onboarding/webRegistration"
import { fixtureState, operation } from "./control"
export * from "../../../src/features/onboarding/webRegistration"

export const buildWebDetectionDeps: typeof actual.buildWebDetectionDeps = async (...args) => {
  if (!fixtureState()) return actual.buildWebDetectionDeps(...args)
  return { pendingStore: actual.getPendingStore() } as unknown as Awaited<ReturnType<typeof actual.buildWebDetectionDeps>>
}
export const runDetectionTick: typeof actual.runDetectionTick = async (...args) => {
  if (!fixtureState()) return actual.runDetectionTick(...args)
  await operation("registration-check")
  const store = actual.getPendingStore()
  const record = store.current()
  if (record) await store.upsert(record.account, { broadcast: true, retries: 0, startTime: Date.now() })
  return "pending"
}
export const runBootDetection: typeof actual.runBootDetection = async (...args) => {
  if (!fixtureState()) return actual.runBootDetection(...args)
  return "pending"
}
export const startDetectionLoop: typeof actual.startDetectionLoop = (...args) => {
  if (!fixtureState()) return actual.startDetectionLoop(...args)
  return () => {}
}
