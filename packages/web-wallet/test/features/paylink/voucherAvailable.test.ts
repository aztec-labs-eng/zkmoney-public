// @vitest-environment node
/** Whether a new link can carry a voucher, over the real session while one of its services builds. */
import { afterEach, expect, it, vi } from "vitest"
import { service } from "@obsidion/front-core"
import { voucherAvailable } from "../../../src/features/paylink/sponsoredPaylink"
import { closeSession } from "../../../src/session/session"
import { openTestSession } from "../../support/session"

afterEach(() => {
  closeSession()
  vi.useRealTimers()
})

it("withholds the gift once the check times out on a session service still building", async () => {
  vi.useFakeTimers()
  const session = openTestSession({
    account: { getAddress: () => ({}) },
    // Its build never answers: the token service is still building.
    token: service("token", { from: [], retry: "manual" }, () => new Promise<never>(() => {})),
  })
  const answer = voucherAvailable({ session } as never)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(await answer).toBe(false)
})
