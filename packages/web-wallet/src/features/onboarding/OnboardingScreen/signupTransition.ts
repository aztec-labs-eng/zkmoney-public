import type { NameClaimResponse } from "@obsidion/core/types"
import type { RefusalState } from "../../identity/PasskeyRefusal"
import type { TicketSignupAttempt } from "../../paylink/ticketSignupAccount"
import type { ChosenTag } from "../../registration/signupStash"
import type { OnboardingKeys } from "../../../session/account"
import type { TicketActivation } from "../../paylink/ticketContinuation"
import type { SignupStage } from "../oxideOnboarding"
import type { CreateRefusal } from "./createFailure"

export type Step = "invite" | "tag" | "terms" | "create" | "claim" | "pending"

/** Why the invitation shows a notice: the copy is the view's. */
export type InviteNote =
  | { kind: "taken"; handle: string }
  | { kind: "unverified"; error: unknown }
  | { kind: "drawFailed" }
  | { kind: "refused"; error: unknown }
  | { kind: "failed" }

/** What the pending step says under its sheet. */
export type PendingNote =
  | { kind: "mismatch" | "notOffered" | "ticketPaused" | "ticketRefused" }
  | { kind: "ticketHold"; state: TicketActivation["state"]; tag: string }

export interface SignupState {
  step: Step
  handle: string
  /** How the tag came: drawn, paid for, or a past user's grant. A drawn or granted one is free. */
  route?: ChosenTag["route"]
  chosenTag?: string
  pickingName: boolean
  inviteBusy: boolean
  inviteNote?: InviteNote
  modalBusy: boolean
  busyPhase: "passkey" | "claim"
  signupStage?: SignupStage
  creationWarning?: string
  /** What failed in the sheet, for the view's message: a passkey, a claim or an entry. */
  modalError?: { kind: "passkey" | "claim" | "enter"; error: unknown }
  modalRefusal?: CreateRefusal
  /** The pending step's commands running, and the stage the latest one reached. */
  busy: number
  busyStage?: "checking" | "passkey" | "claiming"
  retrying: boolean
  note?: PendingNote
  pendingRefusal?: RefusalState
  checkedAt?: number
  reading: boolean
  /** An identity save failed: only the user's retry enters. */
  entryFailed: boolean
  /** The claim was sent and the signup entered: its end is the bell's to report. */
  claimLeft: boolean
  /** The claim a live signup just returned: the deposit panel's deadline and waiver. */
  freshClaim?: NameClaimResponse
  /** The account the pending step watches, kept after its record closes. */
  oxideAccount?: string
  ticketAttempt: TicketSignupAttempt | null
  keys?: OnboardingKeys
  address?: string
  /** The account this tab's ceremony created, as against one it signed back in to. */
  created?: string
  /** The keys came from the pending step's recovery, not a live signup. */
  recovered: boolean
}

export type SignupEvent =
  | { type: "to"; step: Step }
  | { type: "checking"; handle: string }
  | { type: "checked"; taken: boolean }
  | { type: "inviteFailed"; note?: InviteNote }
  | { type: "inviteSettled" }
  | { type: "settled"; route?: ChosenTag["route"]; handle: string; chosen?: string }
  | { type: "picking"; open: boolean }
  | { type: "creating"; keepWarning: boolean }
  | { type: "claiming" }
  | { type: "stage"; stage?: SignupStage }
  | { type: "keys"; keys?: OnboardingKeys; address?: string; created?: string; recovered: boolean }
  | { type: "claimed"; account: string; claim?: NameClaimResponse }
  | { type: "claimFailed"; error: unknown }
  | { type: "createFailed"; refusal?: CreateRefusal; error?: unknown; toCreate?: boolean }
  | { type: "opEnded" }
  | { type: "cancelled"; toTerms: boolean }
  | { type: "steered"; note?: InviteNote; step: Step }
  | { type: "warning"; warning?: string }
  | { type: "resumed"; account: string; handle: string }
  | { type: "followed"; account: string }
  | { type: "ticketAttempt"; attempt: TicketSignupAttempt | null; error?: unknown }
  | { type: "busy"; delta: 1 | -1 }
  | { type: "busyStage"; stage?: SignupState["busyStage"] }
  | { type: "retrying"; on: boolean }
  | { type: "note"; note?: PendingNote }
  | { type: "pendingRefusal"; refusal?: RefusalState }
  | { type: "checkedAt"; at: number }
  | { type: "reading"; on: boolean }
  | { type: "entry"; failed: boolean }
  | { type: "claimLeft"; left: boolean }

const OP_ENDED = { modalBusy: false, busyPhase: "passkey" } as const

/** The signup screen's one state change. */
export function signupTransition(s: SignupState, e: SignupEvent): SignupState {
  switch (e.type) {
    case "to":
      return { ...s, step: e.step }
    case "checking":
      return { ...s, handle: e.handle, inviteBusy: true, inviteNote: undefined }
    case "checked":
      if (e.taken)
        return { ...s, inviteBusy: false, inviteNote: { kind: "taken", handle: s.handle } }
      // Keys from a cancelled ceremony that completed anyway claim without a second click.
      return s.keys
        ? { ...s, inviteBusy: false, step: "create", modalBusy: true, busyPhase: "claim" }
        : { ...s, inviteBusy: false, step: "terms" }
    case "inviteFailed":
      return { ...s, inviteBusy: false, inviteNote: e.note }
    case "inviteSettled":
      return { ...s, inviteBusy: false }
    case "settled":
      return { ...s, route: e.route, handle: e.handle, chosenTag: e.chosen, pickingName: false }
    case "picking":
      return { ...s, pickingName: e.open }
    case "creating":
      return {
        ...s,
        modalError: undefined,
        modalRefusal: undefined,
        modalBusy: true,
        busyPhase: "passkey",
        creationWarning: e.keepWarning ? s.creationWarning : undefined,
      }
    case "claiming":
      return {
        ...s,
        modalError: undefined,
        modalRefusal: undefined,
        modalBusy: true,
        busyPhase: "claim",
        signupStage: undefined,
      }
    case "stage":
      return { ...s, signupStage: e.stage }
    case "keys":
      return {
        ...s,
        keys: "keys" in e ? e.keys : s.keys,
        address: e.address ?? s.address,
        created: e.created ?? s.created,
        recovered: e.recovered,
      }
    case "claimed":
      return { ...s, oxideAccount: e.account, freshClaim: e.claim ?? s.freshClaim }
    case "claimFailed":
      return { ...s, step: "claim", modalError: { kind: "claim", error: e.error } }
    case "createFailed":
      return {
        ...s,
        ...(e.toCreate ? { step: "create" as const } : {}),
        modalRefusal: e.refusal ?? s.modalRefusal,
        modalError: e.error === undefined ? s.modalError : { kind: "passkey", error: e.error },
      }
    case "opEnded":
      return { ...s, ...OP_ENDED }
    case "cancelled":
      return { ...s, ...OP_ENDED, step: e.toTerms ? "terms" : s.step }
    case "steered":
      return { ...s, ...OP_ENDED, modalRefusal: undefined, inviteNote: e.note, step: e.step }
    case "warning":
      return { ...s, creationWarning: e.warning }
    case "resumed":
      return { ...s, oxideAccount: e.account, handle: e.handle, recovered: true, step: "pending" }
    case "followed":
      return { ...s, oxideAccount: e.account }
    case "ticketAttempt":
      return e.error === undefined
        ? { ...s, ticketAttempt: e.attempt }
        : {
            ...s,
            ticketAttempt: e.attempt,
            modalRefusal: undefined,
            modalError: { kind: "enter", error: e.error },
            step: "create",
          }
    case "busy":
      return { ...s, busy: s.busy + e.delta }
    case "busyStage":
      return { ...s, busyStage: e.stage }
    case "retrying":
      return { ...s, retrying: e.on }
    case "note":
      return { ...s, note: e.note }
    case "pendingRefusal":
      return { ...s, pendingRefusal: e.refusal }
    case "checkedAt":
      return { ...s, checkedAt: e.at }
    case "reading":
      return { ...s, reading: e.on }
    case "entry":
      return { ...s, entryFailed: e.failed }
    case "claimLeft":
      return { ...s, claimLeft: e.left, ...(e.left ? { modalBusy: false } : {}) }
  }
}
