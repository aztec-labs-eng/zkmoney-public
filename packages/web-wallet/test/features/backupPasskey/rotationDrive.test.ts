// @vitest-environment node
/** The page's rotation driver, which record changes an account, and which step waits on a tap. */
import { RotationDriver, type RotationDrive } from "@obsidion/front-core"
import { describe, expect, it } from "vitest"
import {
  awaitsApproval,
  getRotationDriver,
  ownsRotation,
} from "../../../src/features/backupPasskey/rotationDrive"
import { createdRecord, signedRecord, TWO_KEY, word } from "../../support/backupAdd"

describe("getRotationDriver", () => {
  it("hands out the page's one driver", () => {
    expect(getRotationDriver()).toBeInstanceOf(RotationDriver)
    expect(getRotationDriver()).toBe(getRotationDriver())
  })
})

describe("ownsRotation", () => {
  const record = signedRecord()

  it("owns the one-key account the change was built over and the two-key account, in any case", () => {
    expect(ownsRotation(record, word(10).toUpperCase())).toBe(true)
    expect(ownsRotation(record, TWO_KEY)).toBe(true)
  })

  it("owns no other account, and none while the address is unknown", () => {
    expect(ownsRotation(record, word(99))).toBe(false)
    expect(ownsRotation(record, undefined)).toBe(false)
    expect(ownsRotation(createdRecord(), word(10))).toBe(false)
  })
})

describe("awaitsApproval", () => {
  const drive = (over: Partial<RotationDrive>, attention?: "move"): RotationDrive => ({
    record: signedRecord(attention ? { phase: "attention", attention } : {}),
    approving: false,
    ...over,
  })

  it("waits on a tap for a chunk's send, a declined prompt, or a paused move", () => {
    expect(awaitsApproval(drive({ resume: { wait: "approval" } }))).toBe(true)
    expect(awaitsApproval(drive({ resume: { wait: "declined" } }))).toBe(true)
    expect(awaitsApproval(drive({}, "move"))).toBe(true)
  })

  it("waits on no tap while the chain answers next", () => {
    expect(awaitsApproval(drive({ resume: { wait: "chunk" } }))).toBe(false)
    expect(awaitsApproval(drive({}))).toBe(false)
  })
})
