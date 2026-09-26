import { sendFeedback as actual } from "../../../src/lib/feedback"
import { fixtureState, pause } from "./control"
export * from "../../../src/lib/feedback"
let attempts = 0
export const sendFeedback: typeof actual = async (payload) => {
  const state = fixtureState()
  if (!state) return actual(payload)
  attempts += 1
  if (state === "pending") return new Promise(() => {})
  await pause(1500)
  return state !== "failure" && !(state === "retry" && attempts === 1)
}
