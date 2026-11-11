// @vitest-environment node
// How a sign-in on /enter ends when it does not enter: the card, its retry, and the cancels.
import { describe, expect, it } from "vitest"
import { AccountServiceTimeoutError, StoredAddressMismatchError } from "@obsidion/front-core"
import { DeviceBoundPasskeyError, PhoneRequiredError } from "@obsidion/passkey-web"
import copy from "../../../src/features/onboarding/EnterAppScreen/EnterAppScreen.copy"
import { missDiagnosisCard } from "../../../src/features/onboarding/EnterAppScreen/signInSettle"
import { BY_TAG_FAILURE_CODES } from "../../../src/features/onboarding/findPasskeyByTag"
import { saveTicketSignupAccount } from "../../../src/features/paylink/ticketSignupAccount"
import { linkIdentity } from "../../../src/features/paylink/linkIdentity"
import { stashClaimLink } from "../../../src/features/paylink/claimStash"
import { tabStash } from "../../../src/platform/storage/tabStash"
import { PAYLINK_FRAGMENT } from "../../fixtures/scanPayloads"
import { savedIdentity } from "../../support/identity"
import { committed, seedDeviceKeys, testCore } from "../../support/page"
import {
  confirmResult,
  flush,
  L2,
  named,
  nameless,
  OTHER,
  remember,
  unknownResult,
} from "../../support/signIn"
import { asBrowser, deferred, MAC_CHROME, signInSuite } from "../../support/signInFlow"

const open = signInSuite()
const closed = () => new DOMException("closed", "NotAllowedError")
const PLATFORM = { credentialId: "cred-alice", attachment: "platform" }
const CROSS = { credentialId: "cred-alice", attachment: "cross-platform" }
/** The screen, shown after an arrival probe that found no cached key, with no failure counted. */
const toScreen = async (search = "") => {
  const opened = await open(search)
  opened.io.fire.mockClear()
  return opened
}
const toClaim = (navigate: { mock: { calls: unknown[][] } }) =>
  navigate.mock.calls.some(([to]) => to === "/claim")

describe("a refusal or a failed read", () => {
  it("a policy refusal stays on /enter, unreported, and its retry runs the sign-in again", async () => {
    const { flow, io, navigate, failures, start } = await open("", { start: false })
    io.enterWithPasskey.mockRejectedValueOnce(new PhoneRequiredError())
    await start()
    const { refusal } = flow.state.get()
    expect(refusal?.name).toBe("PhoneRequiredError")
    expect(flow.retryable(refusal!)).toBe(true)
    expect(io.report).not.toHaveBeenCalled()
    expect(failures()).toEqual([["enter", "passkey_wrong_device"]])
    io.enterWithPasskey.mockRejectedValueOnce(new DeviceBoundPasskeyError())
    flow.rerun()
    await flush()
    expect(io.enterWithPasskey).toHaveBeenCalledTimes(2)
    expect(flow.state.get().refusal?.name).toBe("DeviceBoundPasskeyError")
    expect(toClaim(navigate)).toBe(false)
  })

  it("a passkey no anchor names on an incomplete catalog is the network card, not no wallet", async () => {
    const { flow, io, navigate, start } = await open("", { start: false })
    io.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "unknown",
      catalogIncomplete: true,
    })
    await start()
    const { refusal } = flow.state.get()
    expect(refusal).toMatchObject({ name: "error", message: copy.network })
    expect(flow.retryable(refusal!)).toBe(true)
    expect(toClaim(navigate)).toBe(false)
  })

  it("a passkey no anchor names is no wallet with no retry; Back prepares the screen again", async () => {
    const { flow, io, start } = await open("", { start: false })
    io.enterWithPasskey.mockResolvedValueOnce({ entered: false, reason: "unknown" })
    await start()
    const { refusal } = flow.state.get()
    expect(refusal?.name).toBe("NoWalletForPasskeyError")
    expect(flow.retryable(refusal!)).toBe(false)
    flow.back()
    await flush()
    expect(flow.state.get()).toMatchObject({ refusal: undefined, shown: true, prepared: "ready" })
    expect(io.warm).toHaveBeenCalledTimes(1)
    expect(io.enterWithPasskey).toHaveBeenCalledTimes(1)
  })

  it("an account-service timeout on the chooser is the network card with a retry, not a closed prompt", async () => {
    const { flow, io, navigate, failures } = await toScreen()
    io.enterWithPasskey.mockRejectedValueOnce(
      new AccountServiceTimeoutError("/domain/reservation", 15_000),
    )
    flow.showPasskeys()
    await flush()
    const { refusal } = flow.state.get()
    expect(refusal).toMatchObject({ name: "error", message: copy.network })
    expect(refusal?.committed).toBeUndefined()
    expect(flow.retryable(refusal!)).toBe(true)
    expect(failures()).not.toContainEqual(["enter", "passkey_prompt_closed"])
    expect(toClaim(navigate)).toBe(false)
  })

  it.each([
    ["NotAllowedError", () => closed()],
    ["AbortError", () => new DOMException("closed", "AbortError")],
    ["no credential", () => new Error("Passkey assertion returned no credential")],
  ])(
    "a chooser closed with %s is unreported, with no retry; Back returns to the screen",
    async (_l, error) => {
      const { flow, io, navigate, failures } = await toScreen()
      io.enterWithPasskey.mockRejectedValueOnce(error())
      flow.showPasskeys()
      await flush()
      const { refusal } = flow.state.get()
      expect(refusal).toMatchObject({ name: "PasskeyNotOfferedError", message: copy.notOffered })
      expect(flow.retryable(refusal!)).toBe(false)
      expect(io.report).not.toHaveBeenCalled()
      expect(failures()).toEqual([["enter", "passkey_prompt_closed"]])
      flow.back()
      expect(flow.state.get()).toMatchObject({ refusal: undefined, shown: true })
      expect(toClaim(navigate)).toBe(false)
      flow.cancel()
      expect(toClaim(navigate)).toBe(true)
    },
  )

  it.each(["wrong-key", "not-reproduced"])(
    "a record mismatch read as %s keeps its verdict and a retry; Show passkeys runs the chooser",
    async (verdict) => {
      const { flow, io, lastEntry } = await toScreen()
      io.enterWithPasskey.mockRejectedValueOnce(
        Object.assign(new StoredAddressMismatchError(), { verdict }),
      )
      flow.showPasskeys()
      await flush()
      const { refusal } = flow.state.get()
      expect(refusal).toMatchObject({ name: "StoredAddressMismatchError", verdict })
      expect(flow.retryable(refusal!)).toBe(true)
      io.enterWithPasskey.mockRejectedValueOnce(closed())
      flow.showPasskeys()
      await flush()
      expect(lastEntry()).toMatchObject({ chooser: true, restoreCache: false })
    },
  )
})

describe("a miss the tag diagnoses", () => {
  const miss = () => unknownResult({ pubkey: "ab".repeat(64), observed: PLATFORM })

  it.each(["DIFFERENT_PASSKEY", "INCONCLUSIVE", "NOT_REPRODUCED_HERE"] as const)(
    "a %s verdict shows its card, counted, with no retry",
    async (diagnosis) => {
      const { flow, io, failures } = await toScreen("handle=alice")
      io.diagnoseMiss.mockResolvedValueOnce(diagnosis)
      io.enterWithPasskey.mockResolvedValueOnce(miss())
      flow.showPasskeys()
      await flush()
      const { refusal } = flow.state.get()
      expect(refusal).toEqual(missDiagnosisCard(diagnosis, "alice"))
      expect(flow.retryable(refusal!)).toBe(false)
      expect(failures()).toEqual([["enter", BY_TAG_FAILURE_CODES[diagnosis]]])
    },
  )

  it("a cancel during the diagnosis shows no card and counts nothing", async () => {
    const { flow, io, failures } = await toScreen("handle=alice")
    const diagnosis = deferred<string>()
    io.diagnoseMiss.mockReturnValueOnce(diagnosis.promise)
    io.enterWithPasskey.mockResolvedValueOnce(miss())
    flow.showPasskeys()
    await flush()
    expect(io.diagnoseMiss).toHaveBeenCalledTimes(1)
    flow.cancel()
    diagnosis.resolve("DIFFERENT_PASSKEY")
    await flush()
    expect(flow.state.get().refusal).toBeUndefined()
    expect(failures()).toEqual([])
  })
})

describe("a cancel", () => {
  it("past the prompt ends the attempt and its gate, and leaves for /claim", async () => {
    const { flow, io, gate, navigate, lastEntry } = await toScreen()
    io.enterWithPasskey.mockReturnValueOnce(new Promise(() => {}))
    flow.showPasskeys()
    expect((lastEntry().signal as AbortSignal).aborted).toBe(false)
    flow.cancel()
    expect((lastEntry().signal as AbortSignal).aborted).toBe(true)
    expect(gate.cancel).toHaveBeenCalled()
    expect(toClaim(navigate)).toBe(true)
  })

  it("while the identity is saved leaves the passkey hint unwritten and navigates nowhere", async () => {
    await seedDeviceKeys({ storageId: "storage-a", credentialId: "cred-alice" })
    await remember({ credentialId: "cred-alice" })
    const { flow, io, navigate, entered } = await toScreen()
    // The save's write waits behind this one, so the cancel lands while it is pending.
    const held = deferred<void>()
    const writing = testCore().database.write(() => held.promise)
    io.enterWithPasskey.mockResolvedValueOnce(named())
    flow.showPasskeys()
    await flush()
    expect(entered()).toBe(false)
    flow.cancel()
    expect(toClaim(navigate)).toBe(true)
    held.resolve()
    await writing
    await flush()
    expect(entered()).toBe(false)
    const map = JSON.parse(committed().passkeyMap!)
    expect(map.entries["cred-alice"].usertag).toBeUndefined()
  })
})

describe("a nameless account", () => {
  it("with no reservation gets the signup card, saves nothing, and continues that signup", async () => {
    await seedDeviceKeys({ storageId: "storage-a" })
    const { flow, io, session, navigate, entered, start } = await open("", { start: false })
    io.enterWithPasskey.mockResolvedValueOnce(nameless(session))
    await start()
    expect(io.reservedNameHashes).toHaveBeenCalledTimes(1)
    expect(flow.state.get().refusal?.name).toBe("GrantedRegistrationError")
    expect(entered()).toBe(false)
    expect(await savedIdentity()).toBeNull()
    expect(session.identity.get().value).toBeNull()
    expect(toClaim(navigate)).toBe(false)
    flow.continueSignup()
    expect(navigate).toHaveBeenCalledWith("/claim?resume=1", { replace: true })
  })

  it.each([
    ["is the stashed link's unfinished signup goes back to that link", L2, true],
    ["is not the stashed link's signup gets the signup card", OTHER, false],
  ])("that %s", async (_l, l2Address, onLink) => {
    stashClaimLink(tabStash, PAYLINK_FRAGMENT)
    await saveTicketSignupAccount(testCore(), "localhost", linkIdentity(PAYLINK_FRAGMENT), {
      credentialId: "cred",
      l2Address,
      tag: "river",
    })
    const { flow, io, session, navigate, start } = await open("", { start: false })
    io.enterWithPasskey.mockResolvedValueOnce(nameless(session))
    await start()
    const link = [`/link#${PAYLINK_FRAGMENT}`, { replace: true }]
    if (onLink) {
      expect(navigate).toHaveBeenCalledWith(...link)
      expect(io.reservedNameHashes).not.toHaveBeenCalled()
      expect(flow.state.get().refusal).toBeUndefined()
    } else {
      expect(navigate).not.toHaveBeenCalledWith(...link)
      expect(flow.state.get().refusal?.name).toBe("GrantedRegistrationError")
    }
  })
})

describe("the chooser", () => {
  it("keeps asking the browser when a refusal on its attempt is retried", async () => {
    const { flow, io, lastEntry, start } = await open("", { start: false })
    io.enterWithPasskey.mockResolvedValueOnce(confirmResult())
    await start()
    flow.back()
    io.enterWithPasskey.mockRejectedValueOnce(new PhoneRequiredError())
    flow.showPasskeys()
    await flush()
    expect(flow.state.get().refusal?.name).toBe("PhoneRequiredError")
    io.enterWithPasskey.mockRejectedValueOnce(closed())
    flow.rerun()
    await flush()
    expect(lastEntry()).toMatchObject({ chooser: true, restoreCache: false })
  })
})

describe("on a Mac", () => {
  const phone = (opened: { lastEntry: () => Record<string, unknown> }) => opened.lastEntry().phone

  it("a record-anchored wrong key leads with the phone; a phone that offered nothing keeps a retry there", async () => {
    asBrowser(MAC_CHROME)
    const opened = await toScreen()
    const { flow, io } = opened
    io.enterWithPasskey.mockRejectedValueOnce(
      Object.assign(new StoredAddressMismatchError(), { verdict: "wrong-key", observed: PLATFORM }),
    )
    flow.showPasskeys()
    await flush()
    expect(flow.state.get().refusal).toMatchObject({ verdict: "wrong-key", macPhone: true })
    io.enterWithPasskey.mockRejectedValueOnce(closed())
    flow.usePhone()
    await flush()
    expect(phone(opened)).toBe(true)
    const { refusal } = flow.state.get()
    expect(refusal?.name).toBe("PasskeyNotOfferedError")
    expect(flow.retryable(refusal!)).toBe(true)
    io.enterWithPasskey.mockRejectedValueOnce(closed())
    flow.rerun()
    await flush()
    expect(phone(opened)).toBe(true)
  })

  it("no wallet for this computer's answer leads with the phone; another device's does not", async () => {
    asBrowser(MAC_CHROME)
    const opened = await toScreen()
    const { flow, io } = opened
    io.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "unknown",
      observed: PLATFORM,
    })
    flow.showPasskeys()
    await flush()
    expect(flow.state.get().refusal).toMatchObject({
      name: "NoWalletForPasskeyError",
      macPhone: true,
      macUpdate: true,
    })
    io.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "unknown",
      observed: PLATFORM,
    })
    flow.usePhone()
    await flush()
    expect(phone(opened)).toBe(true)
    expect(flow.state.get().refusal?.macPhone).toBe(true)
    io.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "unknown",
      observed: CROSS,
    })
    flow.showPasskeys()
    await flush()
    expect(phone(opened)).toBeUndefined()
    const { refusal } = flow.state.get()
    expect(refusal?.name).toBe("NoWalletForPasskeyError")
    expect(refusal?.macPhone).toBeUndefined()
    expect(refusal?.macUpdate).toBeUndefined()
  })
})
