import type { Hex } from "viem"
import type { RememberedAccount } from "../../../platform/auth/WebPasskeyIdentityMap"
import type { EnterResult } from "../oxideOnboarding"
import type { Found, KeyOption } from "../rowKeys"
import type { ByTagNotice } from "../steps/ConfirmTagModal/ConfirmTagModal"
import type { Refusal } from "./signInSettle"

export type Unclaimed = Extract<EnterResult, { reason: "unclaimed" }>

/** The analytics action a sign-in reports under: the open chooser, or pinned to a tag's passkey. */
export type EntryAction = "enter" | "enter:by-tag"

/** A nameless account's claims as account-service holds them, the tag the attempt carried, and the
 *  attempt itself, so the tag the user confirms picks the signup up in place. */
export type Reserved = {
  nameHashes: Hex[]
  ensDomain: string
  tag: string
  result: Unclaimed
  action: EntryAction
}

/** Why the confirm step refused the typed tag: the copy is the view's. */
export type ConfirmError =
  | { kind: "notReserved"; tag: string }
  | { kind: "unmatched"; error: unknown }
  | { kind: "finishFailed" }

/** A remembered row's keys as the screen holds them, each option with its sign-in. */
export type RowChoice = {
  account: RememberedAccount
  options: KeyOption[]
  reading?: boolean
  failed?: boolean
}

export interface SignInState {
  /** The screen shows: no cached key answered, or the user came back to it. */
  shown: boolean
  /** The manifest and the cache proof are in hand; until then no ceremony action is live. */
  prepared: "pending" | "ready" | "failed"
  typed: string
  found?: Found
  notice?: ByTagNotice
  resolving: boolean
  /** The selected row's keys, shown in place of Login. */
  row?: RowChoice
  refusal?: Refusal
  /** The tag naming the claim: the URL's until a row or the field selects another. */
  selectedTag: string
  confirming: boolean
  /** Set when the confirm step names a reservation rather than a claim. */
  reserved?: Reserved
  confirmError?: ConfirmError
  /** A sign-in reached the gate on its way to a prompt; a key this browser holds skips both. */
  prompted: boolean
  busy: boolean
  /** The accounts this browser remembers on earlier rollups. */
  retired: RememberedAccount[]
}

export type SignInEvent =
  | { type: "shown" }
  | { type: "prepared"; prepared: SignInState["prepared"] }
  | { type: "typed"; typed: string }
  | { type: "resolving"; on: boolean }
  | { type: "field"; found?: Found; notice?: ByTagNotice }
  | { type: "row"; row?: RowChoice }
  | { type: "running"; tag?: string }
  | { type: "prompted" }
  | { type: "refused"; refusal?: Refusal }
  | { type: "confirm"; reserved?: Reserved }
  | { type: "confirmed" }
  | { type: "confirmError"; error?: ConfirmError }
  | { type: "back"; tag: string }
  | { type: "busy"; on: boolean }
  | { type: "retired"; rows: RememberedAccount[] }

/** The sign-in screen's one state change. */
export function signInTransition(s: SignInState, e: SignInEvent): SignInState {
  switch (e.type) {
    case "shown":
      return { ...s, refusal: undefined, shown: true }
    case "prepared":
      return { ...s, prepared: e.prepared }
    case "typed":
      return { ...s, typed: e.typed, found: undefined, notice: undefined, resolving: false }
    case "resolving":
      return { ...s, resolving: e.on }
    case "field":
      return { ...s, found: e.found, notice: e.notice, resolving: false }
    case "row":
      return { ...s, row: e.row }
    case "running":
      return {
        ...s,
        refusal: undefined,
        shown: false,
        prompted: false,
        selectedTag: e.tag ?? s.selectedTag,
      }
    case "prompted":
      return { ...s, prompted: true }
    case "refused":
      return { ...s, refusal: e.refusal }
    case "confirm":
      return { ...s, confirming: true, reserved: e.reserved, confirmError: undefined }
    case "confirmed":
      return { ...s, confirming: false, reserved: undefined }
    case "confirmError":
      return { ...s, confirmError: e.error }
    case "back":
      return {
        ...s,
        confirming: false,
        reserved: undefined,
        confirmError: undefined,
        typed: "",
        found: undefined,
        notice: undefined,
        selectedTag: e.tag,
      }
    case "busy":
      return { ...s, busy: e.on }
    case "retired":
      return { ...s, retired: e.rows }
  }
}
