// @vitest-environment node
// The signup screen's one state change, as a table of events over the states they meet.
import { describe, expect, it } from "vitest"
import {
  signupTransition,
  type SignupEvent,
  type SignupState,
} from "../../../src/features/onboarding/OnboardingScreen/signupTransition"
import type { OnboardingKeys } from "../../../src/session/account"

const START: SignupState = {
  step: "invite",
  handle: "taga",
  pickingName: false,
  inviteBusy: false,
  modalBusy: false,
  busyPhase: "passkey",
  busy: 0,
  retrying: false,
  reading: false,
  entryFailed: false,
  claimLeft: false,
  ticketAttempt: null,
  recovered: false,
}
const KEYS = {} as OnboardingKeys
const after = (...events: SignupEvent[]) => events.reduce(signupTransition, START as SignupState)

describe("signupTransition", () => {
  it.each<[string, SignupEvent[], Partial<SignupState>]>([
    [
      "a taken tag",
      [
        { type: "checking", handle: "bob" },
        { type: "checked", taken: true },
      ],
      {
        handle: "bob",
        inviteBusy: false,
        inviteNote: { kind: "taken", handle: "bob" },
      },
    ],
    ["a free tag", [{ type: "checked", taken: false }], { step: "terms" }],
    [
      "a free tag with keys in hand",
      [
        { type: "keys", keys: KEYS, recovered: false },
        { type: "checked", taken: false },
      ],
      { step: "create", modalBusy: true, busyPhase: "claim" },
    ],
    [
      "a refused create",
      [{ type: "createFailed", refusal: { name: "Error", message: "" }, toCreate: true }],
      { step: "create", modalRefusal: { name: "Error", message: "" } },
    ],
    [
      "a failed claim",
      [{ type: "claiming" }, { type: "claimFailed", error: "down" }],
      { step: "claim", modalBusy: true, modalError: { kind: "claim", error: "down" } },
    ],
    [
      "a cancel at the gate",
      [
        { type: "to", step: "create" },
        { type: "creating", keepWarning: false },
        { type: "cancelled", toTerms: true },
      ],
      { step: "terms", modalBusy: false },
    ],
    [
      "a ticket resume",
      [{ type: "resumed", account: "0xacc", handle: "bob" }],
      { step: "pending", oxideAccount: "0xacc", handle: "bob", recovered: true },
    ],
    [
      "a refused ticket restart",
      [{ type: "ticketAttempt", attempt: null, error: "moved" }],
      { step: "create", modalError: { kind: "enter", error: "moved" } },
    ],
    [
      "a claim handed off",
      [{ type: "claiming" }, { type: "claimLeft", left: true }],
      { claimLeft: true, modalBusy: false },
    ],
  ])("%s", (_, events, expected) => {
    expect(after(...events)).toMatchObject(expected)
  })

  it("steers back with the notice, ending the op and dropping the last refusal", () => {
    const refused = after(
      { type: "creating", keepWarning: false },
      { type: "createFailed", refusal: { name: "Error", message: "" } },
    )
    expect(
      signupTransition(refused, { type: "steered", step: "tag", note: { kind: "failed" } }),
    ).toMatchObject({
      step: "tag",
      modalBusy: false,
      modalRefusal: undefined,
      inviteNote: { kind: "failed" },
    })
  })

  it("keeps a sheet pick's warning into its run and clears it for any other", () => {
    const warned = after({ type: "warning", warning: "w" })
    expect(signupTransition(warned, { type: "creating", keepWarning: true }).creationWarning).toBe(
      "w",
    )
    expect(signupTransition(warned, { type: "creating", keepWarning: false }).creationWarning).toBe(
      undefined,
    )
  })

  it("keeps the keys a creation's account marks, and drops them on a sign-out", () => {
    const held = after({ type: "keys", keys: KEYS, address: "0xa", recovered: false })
    expect(
      signupTransition(held, { type: "keys", created: "0xa", recovered: false }),
    ).toMatchObject({
      keys: KEYS,
      created: "0xa",
    })
    expect(signupTransition(held, { type: "keys", keys: undefined, recovered: false }).keys).toBe(
      undefined,
    )
  })

  it("counts the pending step's running commands", () => {
    expect(
      after({ type: "busy", delta: 1 }, { type: "busy", delta: 1 }, { type: "busy", delta: -1 })
        .busy,
    ).toBe(1)
  })
})
