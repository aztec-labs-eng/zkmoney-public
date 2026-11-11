// @vitest-environment node
/** A held subscription stays known; a missing one is read again unless its subscribe landed. */
import { createPace } from "@obsidion/core/cadence"
import { describe, expect, it } from "vitest"
import { memoryStore, queries } from "@obsidion/front-core"
import { createSubscriptionChecks } from "../../src/session/session"

const KEY = "0xacc|0xfpc|1"

function checks() {
  const reads: boolean[] = []
  const answers: boolean[] = []
  const subscriptions = createSubscriptionChecks(
    queries({
      pace: createPace({ signalled: false }),
      visible: memoryStore(true).readonly,
      now: () => Date.now(),
    }),
  )
  const held = () =>
    subscriptions
      .held({
        toString: () => KEY,
        read: async () => {
          const answer = answers.shift() ?? false
          reads.push(answer)
          return answer
        },
      })
      .read()
  return { subscriptions, answers, reads, held }
}

describe("subscription checks", () => {
  it("reads a held subscription once", async () => {
    const { answers, reads, held } = checks()
    answers.push(true)
    expect([await held(), await held()]).toEqual([true, true])
    expect(reads).toEqual([true])
  })

  it("reads a missing subscription again, and answers held without a read once its subscribe lands", async () => {
    const { subscriptions, reads, held } = checks()
    expect([await held(), await held()]).toEqual([false, false])
    expect(reads).toHaveLength(2)
    subscriptions.landed(KEY)
    expect(await held()).toBe(true)
    expect(reads).toHaveLength(2)
  })
})
