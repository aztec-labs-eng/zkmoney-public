/** Guards: a backup bug report names the failure and never carries the error's message. */
import { RotationFlowError } from "@obsidion/front-core"
import { afterEach, describe, expect, it, vi } from "vitest"

// Before the report's endpoint is read.
vi.hoisted(() => vi.stubEnv("VITE_ZKMONEY_API_URL", "https://api.zk.test"))

import { backupFailure } from "../../../src/features/backupPasskey/backupFailure"
import { LeftoverPasskeyError } from "../../../src/features/backupPasskey/backupPasskeyAdd"
import {
  failureId,
  sendFailureReport,
} from "../../../src/features/backupPasskey/screens/FailedScreen/failureReport"

const SECRET = "0xfeedface"

afterEach(() => vi.unstubAllGlobals())

describe("a backup bug report", () => {
  it("names the step, the kind and the error, through the leftover wrapper", () => {
    const error = new RotationFlowError("not-cancellable", SECRET)
    expect(failureId(backupFailure(new LeftoverPasskeyError(error), "cancel"))).toBe(
      failureId(backupFailure(error, "cancel")),
    )
    expect(failureId(backupFailure(error, "cancel"))).toBe(
      "cancel/not-cancellable/RotationFlowError:not-cancellable",
    )
    expect(failureId(backupFailure("thrown", "add"))).toBe("add/unknown/string")
  })

  it("sends the failure's id and none of the error's words", async () => {
    const bodies: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(init.body)
        return new Response(null, { status: 201 })
      }),
    )
    const failure = backupFailure(new Error(`approve failed for ${SECRET}`), "approve")
    expect(await sendFailureReport(failure)).toBe(true)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).not.toContain(SECRET)
    expect(JSON.parse(bodies[0]!)).toMatchObject({ message: failureId(failure) })
  })
})
