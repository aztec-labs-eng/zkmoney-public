import { describe, expect, it } from "vitest"
import { ACCOUNT_MAX_CALLS, buildTeeOperation } from "../../src/services/teeOperation.js"

// Guard math: [...ops, publish_da] + 1 wallet-merged fee call must fit ACCOUNT_MAX_CALLS.
const MAX_OPS = ACCOUNT_MAX_CALLS - 2

const op = { kind: "transfer" } as any

function build(opCount: number) {
  return buildTeeOperation({} as any, {} as any, {
    tokenContract: {} as any,
    signer: {} as any,
    operations: Array(opCount).fill(op),
    buildOperationCall: () => {
      throw new Error("buildOperationCall should not run for an oversized batch")
    },
  })
}

describe("buildTeeOperation payload-capacity guard", () => {
  it("rejects a batch that overflows the entrypoint AppPayload", async () => {
    await expect(build(MAX_OPS + 1)).rejects.toThrow(/ACCOUNT_MAX_CALLS/)
  })

  it("lets the largest fitting batch past the guard", async () => {
    // Stub args crash later in the pipeline; only assert the guard didn't fire.
    const err = await build(MAX_OPS).then(
      () => undefined,
      (e) => e,
    )
    expect(String(err)).not.toMatch(/ACCOUNT_MAX_CALLS/)
  })
})
