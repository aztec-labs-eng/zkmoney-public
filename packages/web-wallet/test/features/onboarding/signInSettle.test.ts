// @vitest-environment node
// The sign-in's pure readings: the card and code each failure and each pinned miss gets.
import { afterEach, describe, expect, it } from "vitest"
import {
  AccountServiceTimeoutError,
  PasskeyEnvelopeError,
  StoredAddressMismatchError,
} from "@obsidion/front-core"
import { PhoneRequiredError } from "@obsidion/passkey-web"
import { BY_TAG_FAILURE_CODES } from "../../../src/features/onboarding/findPasskeyByTag"
import { PasskeyMismatchError } from "../../../src/features/identity/passkeyAccount"
import { PasskeySetUnreadError } from "../../../src/features/onboarding/oxideOnboarding"
import {
  classifyEntryFailure,
  pinnedMiss,
  walletPath,
  type SignInKind,
} from "../../../src/features/onboarding/EnterAppScreen/signInSettle"
import type { FailureCode } from "../../../src/lib/analytics"

const L2 = `0x${"ac".repeat(32)}`
const OTHER = `0x${"bd".repeat(32)}`
const closed = () => new DOMException("closed", "NotAllowedError")
const committed = () => Object.assign(new Error("disk full"), { committed: true })
const mismatch = (verdict: string) =>
  Object.assign(new StoredAddressMismatchError(), { verdict, observed: undefined })
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/155.0.0.0 Safari/537.36"
const agent = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent")!
afterEach(() => Object.defineProperty(navigator, "userAgent", agent))

describe("classifyEntryFailure", () => {
  it.each<[string, () => unknown, SignInKind, object]>([
    [
      "a chooser's closed prompt",
      closed,
      "enter",
      { code: "passkey_prompt_closed", refusal: { name: "PasskeyNotOfferedError" } },
    ],
    [
      "a pinned prompt that closed",
      closed,
      "pinned",
      { code: "passkey_not_on_device", refusal: { name: "PasskeyNotOnDeviceError" } },
    ],
    [
      "a record that no longer reproduces",
      () => mismatch("not-reproduced"),
      "probe",
      { refusal: { name: "StoredAddressMismatchError", verdict: "not-reproduced" } },
    ],
    [
      "a pinned answer from another account's passkey",
      () => new PasskeyMismatchError(),
      "pinned",
      { code: "passkey_wrong_credential", refusal: { name: "PasskeyMismatchError" } },
    ],
    [
      "a policy refusal",
      () => new PhoneRequiredError(),
      "pinned",
      { code: "passkey_wrong_device", refusal: { name: "PhoneRequiredError" } },
    ],
    [
      "a backup envelope that did not open",
      () => new PasskeyEnvelopeError("unverified"),
      "pinned",
      { code: "backup_envelope_failed", refusal: { name: "PasskeyEnvelopeError" } },
    ],
    [
      "a passkey set too large to read",
      () => new PasskeySetUnreadError(),
      "enter",
      { refusal: { name: "PasskeySetUnreadError" } },
    ],
    [
      "a probe's read that failed before anything was asked",
      () => new Error("rpc down"),
      "probe",
      { code: "unknown", refusal: undefined, reported: undefined },
    ],
    [
      "a probe's backup envelope, which no prompt opened",
      () => new PasskeyEnvelopeError("unverified"),
      "probe",
      { code: "backup_envelope_failed", refusal: undefined },
    ],
    [
      "a write that failed after the commit",
      committed,
      "pinned",
      { code: undefined, reported: true, refusal: { name: "error", probeCommitted: true } },
    ],
    [
      "an account-service lookup that timed out",
      () => new AccountServiceTimeoutError("/domain/reservation", 15_000),
      "pinned",
      { code: undefined, reported: true, refusal: { name: "error" } },
    ],
  ])("%s", (_l, error, kind, expected) => {
    const { refusal, code, reported } = classifyEntryFailure(error(), kind, "alice")
    expect({ refusal, code, reported }).toMatchObject(expected)
  })
})

describe("pinnedMiss", () => {
  const miss = (extra: object = {}) => ({
    entered: false as const,
    reason: "unknown" as const,
    credentialId: "cred-alice",
    addresses: [OTHER],
    ...extra,
  })
  const LOCAL = { credentialId: "cred-alice", attachment: "platform" as const }

  it.each<[string, object, boolean | undefined, object]>([
    [
      "a key that reproduces another account",
      {},
      false,
      { code: "passkey_key_mismatch", refusal: { name: "PasskeyKeyMismatchError" } },
    ],
    [
      "a key whose account is unconfirmed",
      { addresses: [OTHER, L2] },
      false,
      { code: "registry_unanchored", refusal: { name: "RegistryUnanchoredError" } },
    ],
    [
      "this laptop's copy of the one key, missing on both slots",
      { addresses: [OTHER, `0x${"ce".repeat(32)}`], observed: LOCAL },
      false,
      {
        code: "bytag_local_copy_wrong_key",
        refusal: { name: "StoredAddressMismatchError", verdict: "wrong-key" },
      },
    ],
    [
      "a row's miss on both slots, which no read proved sole",
      { addresses: [OTHER, `0x${"ce".repeat(32)}`], observed: LOCAL },
      undefined,
      { code: "passkey_key_mismatch", refusal: { name: "PasskeyKeyMismatchError" } },
    ],
    [
      "a stored record that no longer reproduces",
      { addresses: [L2], storedAddressMismatch: true },
      false,
      { code: "passkey_key_mismatch", refusal: { name: "PasskeyKeyMismatchError" } },
    ],
    [
      "a stored record with its weaker verdict",
      { storedAddressMismatch: true, verdict: "not-reproduced" },
      false,
      {
        code: "passkey_key_mismatch",
        refusal: { name: "StoredAddressMismatchError", verdict: "not-reproduced" },
      },
    ],
  ])("%s", (_l, result, moreKeys, expected) => {
    expect(pinnedMiss(miss(result), { tag: "alice", l2Address: L2, moreKeys })).toMatchObject(
      expected,
    )
  })

  it("on a Mac, suggests an update for this computer's answer, not another device's", () => {
    Object.defineProperty(navigator, "userAgent", { value: MAC, configurable: true })
    const read = (attachment: string) =>
      pinnedMiss(miss({ observed: { ...LOCAL, attachment } }), {
        tag: "alice",
        l2Address: L2,
        moreKeys: true,
      }).refusal
    expect(read("platform")).toMatchObject({ name: "PasskeyKeyMismatchError", macUpdate: true })
    expect(read("cross-platform").macUpdate).toBeUndefined()
  })

  it("on a Mac, this computer's wrong key leads with the phone", () => {
    Object.defineProperty(navigator, "userAgent", { value: MAC, configurable: true })
    const result = miss({ addresses: [OTHER, `0x${"ce".repeat(32)}`], observed: LOCAL })
    expect(pinnedMiss(result, { tag: "alice", l2Address: L2, moreKeys: false })).toMatchObject({
      refusal: { verdict: "wrong-key", macPhone: true, macUpdate: true },
    })
  })
})

describe("the code table", () => {
  it("the by-tag codes are distinct; the annotation pins each to FailureCode at typecheck", () => {
    const codes: FailureCode[] = [...Object.values(BY_TAG_FAILURE_CODES), "passkey_prompt_closed"]
    expect(new Set(codes).size).toBe(codes.length)
  })
})

describe("walletPath", () => {
  it.each([
    ["/request?x=1#gift", "/request?x=1#gift"],
    ["//evil.example/x", undefined],
    ["/\\evil.example/x", undefined],
    ["https://evil.example/", undefined],
    [undefined, undefined],
  ])("reads %s inside the page's origin as %s", (raw, path) => {
    expect(walletPath(raw, "https://zk.money")).toBe(path)
  })
})
