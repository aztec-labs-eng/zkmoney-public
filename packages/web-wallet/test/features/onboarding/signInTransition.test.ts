// @vitest-environment node
// The sign-in screen's one state change, as a table of events over the states they meet.
import { describe, expect, it } from "vitest"
import {
  signInTransition,
  type SignInEvent,
  type SignInState,
} from "../../../src/features/onboarding/EnterAppScreen/signInTransition"

const START: SignInState = {
  shown: false,
  prepared: "pending",
  typed: "",
  resolving: false,
  selectedTag: "alice",
  confirming: false,
  prompted: false,
  busy: false,
  retired: [],
}
const REFUSAL = { name: "error", message: "" }
const after = (...events: SignInEvent[]) => events.reduce(signInTransition, START)

describe("signInTransition", () => {
  it.each<[string, SignInEvent[], Partial<SignInState>]>([
    [
      "the screen shows over a refusal",
      [{ type: "refused", refusal: REFUSAL }, { type: "shown" }],
      { shown: true, refusal: undefined },
    ],
    [
      "an edit drops what the last tag found",
      [
        { type: "field", notice: { kind: "notFound", tag: "bob" } },
        { type: "resolving", on: true },
        { type: "typed", typed: "bobb" },
      ],
      { typed: "bobb", notice: undefined, found: undefined, resolving: false },
    ],
    [
      "a read's answer ends the resolve",
      [
        { type: "resolving", on: true },
        { type: "field", notice: { kind: "reserved", tag: "bob" } },
      ],
      { resolving: false, notice: { kind: "reserved", tag: "bob" } },
    ],
    [
      "a pinned sign-in leaves the screen and selects its tag",
      [{ type: "shown" }, { type: "prompted" }, { type: "running", tag: "bob" }],
      { shown: false, prompted: false, selectedTag: "bob", refusal: undefined },
    ],
    ["a chooser keeps the selected tag", [{ type: "running" }], { selectedTag: "alice" }],
    [
      "Back leaves the confirm step for a blank screen on the URL's tag",
      [
        { type: "running", tag: "bob" },
        { type: "typed", typed: "bob" },
        { type: "confirm" },
        { type: "confirmError", error: { kind: "finishFailed" } },
        { type: "back", tag: "alice" },
      ],
      { confirming: false, confirmError: undefined, typed: "", selectedTag: "alice" },
    ],
    [
      "a confirmed reservation closes the step",
      [{ type: "confirm", reserved: {} as never }, { type: "confirmed" }],
      { confirming: false, reserved: undefined },
    ],
  ])("%s", (_l, events, expected) => {
    expect(after(...events)).toMatchObject(expected)
  })
})
