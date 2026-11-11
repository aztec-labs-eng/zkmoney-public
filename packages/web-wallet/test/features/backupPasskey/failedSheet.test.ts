// @vitest-environment node
/** Guards: each failed sheet offers a way on that can work, and a way back. */
import { BackupPasskeyRefusedError, type BackupAddOptions } from "@obsidion/passkey-web"
import { BackupCredentialIdLengthError, BackupSetConflictError } from "@obsidion/sdk"
import { describe, expect, it } from "vitest"
import {
  backupFailure,
  stateFailure,
  type BackupFailure,
} from "../../../src/features/backupPasskey/backupFailure"
import type { BackupScreen } from "../../../src/features/backupPasskey/backupScreen"
import { failedSheet } from "../../../src/features/backupPasskey/screens/FailedScreen/failedSheet"
import { SignerKeyMismatchError } from "../../../src/platform/auth/webauthnSigning"
import { signedRecord } from "../../support/backupAdd"

const closed = () => new DOMException("closed", "NotAllowedError")
const PLACE: BackupAddOptions = {
  options: [
    { id: "phone", label: "phone", description: "", advice: [] },
    { id: "key", label: "key", description: "", advice: [] },
  ],
  selected: "key",
}
const OVER_PLACE: BackupScreen = { id: "place", place: PLACE, busy: false }

const sheet = (failure: BackupFailure, over: { under?: BackupScreen; canCancel?: boolean } = {}) =>
  failedSheet({ id: "failed", failure, canCancel: false, busy: false, checking: false, ...over })

describe("failedSheet", () => {
  it("retries a closed prompt, back to the picker before an attempt is saved, else dropping it", () => {
    expect(sheet(backupFailure(closed(), "add"), { under: OVER_PLACE })).toEqual({
      kind: "closed",
      primary: "retry",
      secondary: "back",
    })
    expect(sheet(backupFailure(closed(), "fund"), { canCancel: true }).secondary).toBe("cancel")
  })

  it("sends a security key's refusal to the phone only where the picker offers it", () => {
    const key = backupFailure(new BackupPasskeyRefusedError("key-no-prf"), "add")
    expect(sheet(key, { under: OVER_PLACE }).primary).toBe("phone")
    expect(sheet(key).primary).toBe("retry")
    const onPhone = { ...OVER_PLACE, place: { ...PLACE, selected: "phone" as const } }
    expect(sheet(key, { under: onPhone }).primary).toBe("retry")
    const unverified = backupFailure(new BackupPasskeyRefusedError("unverified"), "add")
    expect(sheet(unverified, { under: OVER_PLACE }).primary).toBe("retry")
  })

  it("offers no retry for a credential id the account cannot store, only dropping the attempt", () => {
    const tooLong = backupFailure(new BackupCredentialIdLengthError(129), "approve")
    expect(sheet(tooLong, { canCancel: true })).toEqual({ kind: "refused", primary: "cancel" })
  })

  it("always offers to read the keys again after another device's change", () => {
    const conflict = new BackupSetConflictError("keys", [], [])
    expect(sheet(backupFailure(conflict, "add")).primary).toBe("keys")
    expect(sheet(backupFailure(conflict, "approve"), { canCancel: true }).primary).toBe("keys")
    expect(sheet(stateFailure("changed", signedRecord())).primary).toBe("keys")
  })

  it("rechecks a route that is not paying, and retries an unknown failure with a report", () => {
    expect(sheet(stateFailure("route", signedRecord()), { canCancel: true })).toEqual({
      kind: "fees",
      primary: "check",
      secondary: "cancel",
    })
    expect(sheet(backupFailure(new Error("rpc"), "approve"))).toEqual({
      kind: "failed",
      primary: "retry",
      secondary: "report",
    })
  })

  it("offers no retry for a session key this browser recorded wrong", () => {
    const mismatch = backupFailure(new SignerKeyMismatchError(), "approve")
    expect(sheet(mismatch, { canCancel: true })).toEqual({
      kind: "mismatch",
      primary: "cancel",
      secondary: "report",
    })
  })
})
