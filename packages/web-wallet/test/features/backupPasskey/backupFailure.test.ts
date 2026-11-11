// @vitest-environment node
/** The error table: each failure's kind, where it shows, and what it had charged. */
import {
  RootPasskeyRequiredError,
  RotationFlowError,
  type BackupFundingOutcome,
} from "@obsidion/front-core"
import {
  BACKUP_REFUSAL_KINDS,
  BackupPasskeyRefusedError,
  markPasskeyWritten,
  parseUserAgent,
  PROTON_PASS,
  WINDOWS_HELLO,
} from "@obsidion/passkey-web"
import {
  AccountRecordMismatchError,
  BackupCredentialIdLengthError,
  BackupSetConflictError,
  RotationRouteNotLiveError,
} from "@obsidion/sdk"
import { describe, expect, it } from "vitest"
import {
  backupFailure,
  charged,
  failureLine,
  failureScreen,
  stateFailure,
  type BackupStep,
} from "../../../src/features/backupPasskey/backupFailure"
import { LeftoverPasskeyError } from "../../../src/features/backupPasskey/backupPasskeyAdd"
import { panelCopy } from "../../../src/features/backupPasskey/backupPasskeyCopy"
import { DepositReadError } from "../../../src/features/deposit/depositReadErrors"
import { sent, signedRecord } from "../../support/backupAdd"

const closed = () => new DOMException("closed", "NotAllowedError")
const IPHONE = parseUserAgent({
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like " +
    "Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
})
const paid = (outcome: BackupFundingOutcome = "pending") =>
  signedRecord({ phase: "published", ...sent(5, { outcome }) })
const screen = (error: unknown, step: BackupStep, record = signedRecord()) =>
  failureScreen(backupFailure(error, step, record))

describe("backupFailure", () => {
  it("names each error the flow can throw", () => {
    const kinds: [unknown, string][] = [
      [closed(), "declined"],
      [new BackupPasskeyRefusedError("no-prf"), "refused"],
      [new BackupCredentialIdLengthError(129), "credential-too-long"],
      [
        new AccountRecordMismatchError({ l2Address: "0x1", rollupVersion: 6n }, undefined),
        "changed",
      ],
      [new BackupSetConflictError("nonce", [], []), "changed"],
      [new RootPasskeyRequiredError(), "first-passkey"],
      [new RotationRouteNotLiveError("no subsidy"), "route-not-live"],
      [new RotationFlowError("funding-open", "open"), "funding-open"],
      [new RotationFlowError("not-cancellable", "landed"), "not-cancellable"],
      [new DepositReadError("not a token"), "deposit-read"],
      [new Error("rpc"), "unknown"],
    ]
    for (const [error, kind] of kinds) expect(backupFailure(error, "approve").kind).toBe(kind)
  })

  it("reads the cause of a failure after creation, and marks the passkey it left", () => {
    const failure = backupFailure(
      new LeftoverPasskeyError(new BackupCredentialIdLengthError(9)),
      "add",
    )
    expect(failure).toMatchObject({ kind: "credential-too-long", leftover: true })
    expect(backupFailure(markPasskeyWritten(closed()), "add").leftover).toBe(true)
    expect(backupFailure(closed(), "add").leftover).toBe(false)
  })
})

describe("charged", () => {
  it("counts a funding sent or still able to land, and none that never moved money", () => {
    expect(charged(undefined)).toBe("nothing")
    expect(charged(signedRecord())).toBe("nothing")
    for (const outcome of ["pending", "mined", "swept"] as const)
      expect(charged(paid(outcome))).toBe("funding")
    for (const outcome of ["never-sent", "reverted", "dead"] as const)
      expect(charged(paid(outcome))).toBe("nothing")
  })
})

describe("failureScreen", () => {
  it("raises a closed prompt over the add and the payment, and keeps it on the approvals", () => {
    expect(screen(closed(), "add")).toBe("failed")
    expect(screen(closed(), "fund")).toBe("failed")
    expect(screen(closed(), "approve")).toBe("inline")
    expect(screen(closed(), "move")).toBe("inline")
  })

  it("ends an unknown failure before paying on its own sheet, and keeps it on the tracker after", () => {
    for (const step of ["add", "approve", "fund"] as const)
      expect(screen(new Error("rpc"), step)).toBe("failed")
    expect(screen(new Error("rpc"), "fund", paid())).toBe("inline")
    for (const step of ["move", "cancel", "recover", "finish", "resume"] as const)
      expect(screen(new Error("rpc"), step)).toBe("inline")
  })

  it("sends a missing route to the network's sheet and a backup session to the first passkey's", () => {
    expect(screen(new RotationRouteNotLiveError("off"), "approve")).toBe("unavailable")
    expect(screen(new RotationRouteNotLiveError("off"), "resume")).toBe("inline")
    expect(screen(new RootPasskeyRequiredError(), "resume")).toBe("firstPasskey")
    expect(screen(new RootPasskeyRequiredError(), "move")).toBe("firstPasskey")
  })

  it("raises another device's change over a tap, and leaves the driver's run to retry it", () => {
    expect(screen(new BackupSetConflictError("keys", [], []), "approve")).toBe("failed")
    expect(screen(new BackupSetConflictError("keys", [], []), "resume")).toBe("inline")
  })

  it("keeps the refusals and the recovery's own reads on the screen they came from", () => {
    expect(screen(new BackupPasskeyRefusedError("provider"), "add")).toBe("failed")
    expect(screen(new BackupCredentialIdLengthError(129), "approve")).toBe("failed")
    expect(screen(new RotationFlowError("not-cancellable", "x"), "cancel")).toBe("inline")
    expect(screen(new RotationFlowError("funding-open", "x"), "fund")).toBe("inline")
    expect(screen(new DepositReadError("x"), "recover")).toBe("inline")
  })

  it("gives a state the record is in its own sheet, with what it charged", () => {
    for (const kind of ["changed", "route", "corrupt"] as const) {
      expect(failureScreen(stateFailure(kind, signedRecord()))).toBe("failed")
      expect(stateFailure(kind, paid()).charged).toBe("funding")
    }
  })
})

describe("failureLine", () => {
  const line = (error: unknown) => failureLine(backupFailure(error, "add"))

  it("names a credential id the account cannot store, and shows a deposit read's own words", () => {
    expect(line(new BackupCredentialIdLengthError(129))).toBe(panelCopy.credentialIdTooLong)
    const read = new DepositReadError("not a token")
    expect(line(read)).toBe(read.message)
    expect(line(new Error("rpc"))).toBe(panelCopy.unverifiable)
  })

  it("adds the leftover line once when a passkey was written before the failure", () => {
    const written = markPasskeyWritten(closed())
    const declinedLeft = `${panelCopy.declined} ${panelCopy.leftoverPasskey}`
    // A line with no full stop of its own gets one before the leftover line.
    const failedLeft = `${panelCopy.unverifiable}. ${panelCopy.leftoverPasskey}`
    expect(line(written)).toBe(declinedLeft)
    expect(line(new LeftoverPasskeyError(written))).toBe(declinedLeft)
    expect(line(new LeftoverPasskeyError(new Error("seal broke")))).toBe(failedLeft)
    expect(line(closed())).toBe(panelCopy.declined)
  })

  it("says why a passkey can't be a backup, in the refusal's own words", () => {
    for (const kind of BACKUP_REFUSAL_KINDS) {
      const refusal = markPasskeyWritten(new BackupPasskeyRefusedError(kind))
      if (refusal.removalAdvice) continue
      expect(line(refusal)).toBe([refusal.message, panelCopy.leftoverPasskey].join(" "))
      expect(line(new LeftoverPasskeyError(refusal))).toBe(line(refusal))
    }
  })

  it("keeps a refusal's own removal advice instead of the leftover line", () => {
    for (const refusal of [
      new BackupPasskeyRefusedError("no-prf", { providerName: WINDOWS_HELLO }),
      new BackupPasskeyRefusedError("provider", { providerName: PROTON_PASS, userAgent: IPHONE }),
      new BackupPasskeyRefusedError("key-no-prf"),
    ])
      expect(line(markPasskeyWritten(refusal))).toBe(refusal.message)
  })
})
