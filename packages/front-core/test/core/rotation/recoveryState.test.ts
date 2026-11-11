// @vitest-environment node
/** Where an attempt whose funding has to go back stands, as the recovery card reads it. */
import { describe, expect, it } from "vitest"
import { recoveryState } from "../../../src/core/rotation/backupRotationFlow"
import { funding, signedRecord, word } from "../../__test-helpers__/backupRotation"

describe("recoveryState", () => {
  it("holds a stranded funding until its recovery is sent, then waits on that recovery", () => {
    const stranded = signedRecord("attention", {
      attention: "stranded",
      suspended: "funded",
      fundings: [funding()],
    })
    expect(recoveryState(stranded)).toBe("held")
    expect(recoveryState({ ...stranded, recovery: { txHash: word(0xab) } })).toBe("sent")
  })

  it("recovers a damaged record only when it cannot be cancelled", () => {
    const funded = signedRecord("attention", {
      attention: "corrupt",
      suspended: "funded",
      fundings: [funding()],
    })
    expect(recoveryState(funded)).toBe("held")
    const signed = signedRecord("attention", { attention: "corrupt", suspended: "signed" })
    expect(recoveryState(signed)).toBeUndefined()
  })

  it("reads recovered once the attempt ended there, and nothing for any other attempt", () => {
    expect(recoveryState(signedRecord("recovered"))).toBe("recovered")
    for (const record of [
      signedRecord("funded", { fundings: [funding()] }),
      signedRecord("attention", { attention: "move", suspended: "rerooted" }),
      signedRecord("attention", { attention: "route", suspended: "funded" }),
      signedRecord("conflict"),
    ]) {
      expect(recoveryState(record)).toBeUndefined()
    }
  })
})
