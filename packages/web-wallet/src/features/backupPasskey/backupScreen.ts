/*
 * Screen ids follow the Passkeys redesign's frames (Figma, Web Wallet, Settings > Passkeys): A1-A7
 * the add, B1-B4 why it can't start, C1-C8 its errors.
 */
import {
  allowanceCovers,
  BACKUP_ADD_TAKES_MS,
  backupAddCharged,
  backupAddTiming,
  backupFundingQuote,
  cancellable,
  fundingLanding,
  moveDeclined,
  moveProgress,
  recoveryState,
  refundProgress,
  type AllowanceSnapshot,
  type BackupAddQuote,
  type BackupFunding,
  type BackupFundingQuote,
  type BackupRotationPhase,
  type BackupRotationPlan,
  type BackupRotationRecord,
  type FlowWait,
  type RecoveryState,
  type RotationDrive,
} from "@obsidion/front-core"
import {
  providerNameFor,
  type BackupAddChoice,
  type BackupAddOptions,
  type UserAgentInfo,
} from "@obsidion/passkey-web"
import type { Hex } from "viem"
import {
  backupFailure,
  charged,
  failureScreen,
  stateFailure,
  type BackupFailure,
  type BackupStep,
} from "./backupFailure"
import {
  entryBlocks,
  type EntryAction,
  type EntryBlock,
  type OpenEntryBlock,
} from "./backupPasskeyEntry"
import type { EntryFacts } from "./backupPasskeyFacts"
import type { BackupRotationState } from "./backupRotations"
import type { FundFit } from "./fundFitFlow"

/** A passkey on the account, as the key list read it. */
export interface BackupKey {
  pubkeyHex: string
  role: "sign-up" | "backup" | "unknown"
  /** The key signing this session. */
  signsHere: boolean
  /** The user's name for it. */
  name?: string
  /** Its passkey manager, where this browser recorded one. */
  provider?: string
}

/** The account's keys; undefined while the read is out, `unverified` before registration. */
export type KeysRead =
  | undefined
  | "unreadable"
  | "unverified"
  | { keys: readonly BackupKey[]; count: number }

/** What the add's conditions are read from. */
export interface EntryInput {
  allowance: AllowanceSnapshot
  facts: "checking" | "unreadable" | EntryFacts
  railFailed: boolean
  /** The sign-up registration is still reaching the rollup; undefined until read. */
  registering?: boolean
  /** The browser's user agent, once read. */
  device?: UserAgentInfo
  /** The picker's options on a laptop, once the phone probe settled. */
  place?: BackupAddOptions
}

export interface BackupScreenInput {
  keys: KeysRead
  saved: BackupRotationState
  /** The pending record's flow dependencies; `none` without a wallet to build them over. */
  deps: "none" | "building" | "ready" | "failed"
  /** The driver's lane for the record's account. */
  drive?: RotationDrive
  /** Read only while a new add can show; see `entryShows`. */
  entry?: EntryInput
  /** Whether one transfer funds the add; read only while the funding waits on the user. */
  fit?: FundFit
  /** A new add may start from this build. */
  addable: boolean
  laptop: boolean
  /** How far into the start screens the user went. */
  start?: "intro" | "place"
  picked?: BackupAddChoice
  /** The last tapped step's failure; one for an attempt shows only over that attempt. */
  failure?: { step: BackupStep; error: unknown; attemptId?: string }
  /** A tapped step is running. */
  busy: boolean
  /** The recovery the deposit address was last found empty under; see `recoveryKey`. */
  emptyUnder?: string
  /** The user dropped an attempt since the sheet opened. */
  cancelled: boolean
  /** Wall time, epoch ms. */
  now: number
}

/**
 * Where an attempt is on the tracker. Step 1 saves the backup, 2 approves and pays (two prompts
 * shown as one step), 3 waits on the network and 4 finishes.
 */
export type BackupStage =
  | "sign"
  | "publish"
  | "pay"
  | "landing"
  | "funded"
  | "final"
  | "installing"
  | "moving"

export interface BackupProgress {
  step: 2 | 3 | 4
  stage: BackupStage
  /** Open paylinks taken back, while one has yet to land. */
  refunds?: { landed: number; total: number }
  /** The latest move run: chunks in over chunks planned. */
  moved?: { included: number; total: number }
}

/** Why a step is slower than it should be (C6); `late` is past the time the add quoted. */
export type BackupDelay = "route" | "uses" | "late"

/** The funding's figures, priced without a tip; a speed's tip is priced on `plan` over them. */
export interface BackupPayFacts extends BackupFundingQuote {
  plan: BackupRotationPlan
  fit?: FundFit
  /** The most the add takes once paid. */
  takesMs: number
  /** The two-key account the funds move to. */
  address: string
  /** Prompts now, then one per paylink taken back and per part of the balance moved. */
  approvals: number
  refunds: number
  moves: number
}

/** Whether a new add can start, and what holds it. */
export type BackupAddState =
  | { kind: "none" }
  | { kind: "checking" }
  | { kind: "unreadable" }
  | { kind: "ready"; links: number }
  /** `block`: the first unmet of `blocks`, every condition. */
  | {
      kind: "blocked"
      screen: "blocked" | "unavailable" | "firstPasskey"
      block: OpenEntryBlock
      blocks: readonly EntryBlock[]
    }

/** The read a `unreadable` screen retries. */
export type BackupRead = "keys" | "records" | "deps" | "entry"

/** Where the new backup was saved, as far as its creation said. */
export type BackupSaved = { securityKey: true } | { manager: string }

/** A paid add's quoted time and what is left of it. */
export interface BackupTiming {
  takesMs: number
  leftMs: number
}

/** What the attempt's tracker screens share. */
export interface Tracked {
  progress: BackupProgress
  /** The approving passkey's name, where it has one. */
  approver?: string
  savedIn?: BackupSaved
  /** What the add charged, once a funding went out. */
  paid?: bigint
  /** How long ago the driver last read the chain for the attempt in full. */
  checkedAgoMs?: number
  busy: boolean
  /** The driver has yet to answer for the record as it stands. */
  checking: boolean
  canCancel: boolean
  failure?: BackupFailure
}

export type BackupScreen =
  /**
   * A read is out; `rotation` once a pending record waits on its dependencies. `cancelled` as on
   * the key list, which waits on the read.
   */
  | { id: "loading"; rotation: boolean; cancelled?: boolean }
  /** A1: the key list and its add. */
  | {
      id: "keys"
      keys: readonly BackupKey[]
      add: BackupAddState
      place?: BackupAddOptions
      device?: UserAgentInfo
      busy: boolean
      cancelled: boolean
    }
  /** A2: before the add starts. `picker` when A3 follows; without it Continue starts the add. */
  | {
      id: "intro"
      links: number
      quote?: BackupAddQuote
      picker: boolean
      device?: UserAgentInfo
      busy: boolean
    }
  /** A3: where the backup lives. */
  | { id: "place"; place: BackupAddOptions; device?: UserAgentInfo; busy: boolean }
  /** B1: what holds the add. */
  | { id: "blocked"; blocks: readonly EntryBlock[] }
  /** B2: entered from A1, or raised over the step a missing route stopped. */
  | { id: "unavailable"; under?: BackupScreen; failure?: BackupFailure }
  /** B3: a read failed. `cancelled` as on the key list, which the read stopped. */
  | { id: "unreadable"; read: BackupRead; cancelled?: boolean }
  /** B4: entered from A1, or raised over the step only the first passkey can sign. */
  | {
      id: "firstPasskey"
      keys: readonly BackupKey[]
      under?: BackupScreen
      failure?: BackupFailure
    }
  /**
   * A4, the pay step and C3. `pay` once the driver waits for the funding, and while a funding's
   * prompt or proof is out, which `sending` marks.
   */
  | ({ id: "approve"; pay?: BackupPayFacts; sending?: true; sipa?: string } & Tracked)
  /** A5 and C6. `timing` while the add waits on the chain after paying. */
  | ({
      id: "adding"
      timing?: BackupTiming
      delay?: BackupDelay
    } & Tracked)
  /** A6 and C7. `paused` when part of the balance could not move. */
  | ({
      id: "finish"
      /** What the user's tap does next. */
      ask?: "approve" | "retry"
      /** The driver runs a step the user tapped. */
      approving: boolean
      declined: boolean
      paused: boolean
      linkExpiring: boolean
      delay?: BackupDelay
    } & Tracked)
  /** A7: the backup is added. `unlisted` while the key read predates it. */
  | {
      id: "done"
      keys: readonly BackupKey[]
      unlisted?: { savedIn?: BackupSaved }
      paid?: bigint
      failure?: BackupFailure
    }
  /** Funding held at the deposit address, on its way back, or back. */
  | {
      id: "recovery"
      state: RecoveryState
      /** Funding that landed after the backup was added. */
      extra: boolean
      damaged: boolean
      /** What reached the deposit address. */
      deposited?: bigint
      sipa?: string
      recoveryTx?: Hex
      startedAt: number
      /** The address held nothing when the user last asked to recover it. */
      empty: boolean
      busy: boolean
      failure?: BackupFailure
    }
  /** C1, C2, C4, C5 and C8: over the screen it stopped, or the record's own state. */
  | {
      id: "failed"
      failure: BackupFailure
      under?: BackupScreen
      canCancel: boolean
      busy: boolean
      checking: boolean
      /** A recheck or a tap that failed on this sheet. */
      inline?: BackupFailure
    }

export type BackupScreenId = BackupScreen["id"]

/** The screens a saved rotation shows. */
export type RotationScreen = Extract<
  BackupScreen,
  { id: "approve" | "adding" | "finish" | "done" | "recovery" | "failed" }
>

/** What a screen's taps do; the host runs each and keeps its failure. */
export interface BackupActions {
  /** Creates the backup passkey where `choice` says, and saves the attempt. */
  add(choice?: BackupAddChoice): void
  pick(choice: BackupAddChoice): void
  /** Moves through the start screens; undefined is the key list. */
  start(to?: "intro" | "place"): void
  approve(): void
  /**
   * Sends the funding with the chosen speed's tip inside it; without one, the last send's, which a
   * failure's retry repeats.
   */
  fund(proverTip?: bigint): void
  approveMove(): void
  retryMove(): void
  /** Asks the driver about the record again now. */
  check(): void
  cancel(): void
  recover(): void
  /** Ends a finished attempt and reads the keys again. */
  finish(): void
  /** Clears the failure shown, back to the screen under it. */
  dismiss(): void
  retryRead(read: BackupRead): void
  /** Opens what clears an entry block. */
  act?(action: EntryAction): void
  /** Closes the sheet; the add goes on without it. */
  close?(): void
}

export interface BackupScreenProps<Id extends BackupScreenId> {
  screen: Extract<BackupScreen, { id: Id }>
  actions: BackupActions
}

/** The sponsored sends the whole flow takes besides the refunds and moves: the publish and the funding. */
const FIXED_USES = 2

/** Stands in for the chain facts on an account not registered yet: that condition is named first. */
const UNREGISTERED_FACTS: EntryFacts = {
  routeLive: true,
  balance: 0n,
  fundingAmount: 0n,
  chunk: { kind: "fits" },
  plan: true,
  moves: 0,
  savingsMoving: false,
  withdrawalInFlight: false,
  links: 0,
  historicBalance: false,
}

const TRACKED = [
  "created",
  "signed",
  "published",
  "funded",
  "swept",
  "installed",
  "rerooted",
  "moved",
] as const
type TrackedPhase = (typeof TRACKED)[number]
const tracked = (phase: BackupRotationPhase | undefined): phase is TrackedPhase =>
  (TRACKED as readonly (BackupRotationPhase | undefined)[]).includes(phase)

/** A funding is sent once it has a hash; before that its passkey prompt or proof is still out. */
const sent = (f: BackupFunding) => f.txHash !== undefined
const landing = (record: BackupRotationRecord) =>
  record.fundings.some((f) => sent(f) && fundingLanding(f))
const paying = (record: BackupRotationRecord) =>
  record.fundings.some((f) => !sent(f) && fundingLanding(f))

const rowsOf = (keys: KeysRead) => (typeof keys === "object" ? keys.keys : [])

/** What the user calls a passkey: their name for it, else its manager. */
export const keyName = (key?: Pick<BackupKey, "name" | "provider">): string | undefined =>
  key?.name || key?.provider

/**
 * Whether a new add can show: the flag is on, the account has one key or is not registered yet,
 * and the saved records read none. The add's own reads run only then.
 */
export const entryShows = ({ addable, keys, saved }: BackupScreenInput): boolean =>
  addable &&
  (keys === "unverified" || (typeof keys === "object" && keys.count === 1)) &&
  saved === null

/** What the user last found the deposit address empty under: the attempt and its recovery. */
export const recoveryKey = (record: BackupRotationRecord): string =>
  `${record.attemptId}:${record.recovery?.txHash ?? "held"}`

/** The saved record to act on: none while the key read is out, so another account's never is. */
export const pendingRecord = (
  keys: KeysRead,
  saved: BackupRotationState,
): BackupRotationRecord | null =>
  keys !== undefined && saved !== null && typeof saved === "object" ? saved : null

/** The screen for what the wallet holds, the driver answered and the user did, with its props. */
export function selectBackupScreen(input: BackupScreenInput): BackupScreen {
  const { keys, saved } = input
  const record = pendingRecord(keys, saved)
  if (record) return rotationScreen(record, input)
  if (saved === "unreadable") return { id: "unreadable", read: "records" }
  const cancelled = saved === null && input.cancelled ? { cancelled: true } : {}
  if (keys === undefined || saved !== null) return { id: "loading", rotation: false, ...cancelled }
  if (keys === "unreadable") return { id: "unreadable", read: "keys", ...cancelled }
  const screen = startScreen(input, keys)
  if (input.failure?.step !== "add") return screen
  return raise(screen, backupFailure(input.failure.error, "add"), rowsOf(keys), {
    canCancel: false,
    busy: input.busy,
    checking: false,
  })
}

function startScreen(
  input: BackupScreenInput,
  keys: Exclude<KeysRead, undefined | "unreadable">,
): BackupScreen {
  const add = addState(input, keys)
  const device = input.entry?.device
  const place = placeOf(input)
  if (input.start === undefined || add.kind === "none" || add.kind === "checking")
    return {
      id: "keys",
      keys: rowsOf(keys),
      add,
      ...(place && { place }),
      ...(device && { device }),
      busy: input.busy,
      cancelled: input.cancelled,
    }
  if (add.kind === "unreadable") return { id: "unreadable", read: "entry" }
  if (add.kind === "blocked") {
    if (add.screen === "blocked") return { id: "blocked", blocks: add.blocks }
    if (add.screen === "unavailable") return { id: "unavailable" }
    return { id: "firstPasskey", keys: rowsOf(keys) }
  }
  if (input.start === "place" && place)
    return { id: "place", place, ...(device && { device }), busy: input.busy }
  const facts = input.entry?.facts
  const quote = typeof facts === "object" ? facts.quote : undefined
  return {
    id: "intro",
    links: add.links,
    ...(quote && { quote }),
    picker: place !== undefined,
    ...(device && { device }),
    busy: input.busy,
  }
}

function addState(
  input: BackupScreenInput,
  keys: Exclude<KeysRead, undefined | "unreadable">,
): BackupAddState {
  if (!input.entry || !entryShows(input)) return { kind: "none" }
  const { allowance, railFailed, registering, device } = input.entry
  const verified = keys !== "unverified"
  // An account not registered yet has no rail to read: its own line names that first.
  const facts = verified ? input.entry.facts : UNREGISTERED_FACTS
  if (allowance.status === "unavailable" || facts === "unreadable" || (verified && railFailed))
    return { kind: "unreadable" }
  if (
    allowance.status !== "ready" ||
    facts === "checking" ||
    !device ||
    (verified && registering === undefined)
  )
    return { kind: "checking" }
  // On a one-key account the installed key is the sign-up passkey, so the session is root when its
  // key is the one installed; an unregistered account has that key alone.
  const sessionIsRoot = !verified || keys.keys.some((key) => key.signsHere)
  const blocks = entryBlocks({
    ...facts,
    sessionIsRoot,
    verified,
    registering: registering === true,
    // An account with no subscription yet can start: the publish, its first batch, subscribes.
    usesLeft: allowanceCovers(allowance.state, FIXED_USES + facts.links + facts.moves),
  })
  const block = blocks.find((b) => !b.done)
  if (block) {
    const screen =
      block.id === "firstPasskey"
        ? "firstPasskey"
        : block.id === "route"
        ? "unavailable"
        : "blocked"
    return { kind: "blocked", screen, block, blocks }
  }
  // Only a ready laptop entry waits on the phone probe; a blocked one keeps its reason.
  if (input.laptop && !input.entry.place) return { kind: "checking" }
  return { kind: "ready", links: facts.links }
}

/** The picker's options with the user's choice, or the one it opens on. */
function placeOf({ entry, picked }: BackupScreenInput): BackupAddOptions | undefined {
  const sheet = entry?.place
  const option =
    sheet && (sheet.options.find((o) => o.id === (picked ?? sheet.selected)) ?? sheet.options[0])
  return sheet && option && { options: sheet.options, selected: option.id }
}

type Context = Pick<Tracked, "busy" | "checking" | "canCancel">

/** What the driver answered for this attempt; an answer for another attempt is not shown. */
type Answer = {
  wait?: FlowWait
  /** The driver answered for the attempt since the page loaded. */
  answered: boolean
  approving: boolean
  declined: boolean
  checkedAt?: number
}

function rotationScreen(record: BackupRotationRecord, input: BackupScreenInput): BackupScreen {
  // Without a wallet neither the flow nor the key read runs; the key read's sheet has the retry.
  if (input.deps === "none")
    return input.keys === "unreadable"
      ? { id: "unreadable", read: "keys" }
      : { id: "loading", rotation: false }
  if (input.deps === "failed") return { id: "unreadable", read: "deps" }
  if (input.deps === "building") return { id: "loading", rotation: true }
  const drive = input.drive?.record.attemptId === record.attemptId ? input.drive : undefined
  const resume = drive?.resume
  const answer: Answer = {
    ...(resume?.wait && { wait: resume.wait }),
    answered: resume !== undefined || drive?.checkedAt !== undefined,
    approving: drive?.approving ?? false,
    // Only once the driver answers `declined`: an earlier chunk in flight comes first.
    declined: moveDeclined(record) && resume?.wait === "declined",
    ...(drive?.checkedAt !== undefined && { checkedAt: drive.checkedAt }),
  }
  const context: Context = {
    busy: input.busy,
    checking: record.phase !== "created" && (resume === undefined || drive?.rechecking === true),
    canCancel: cancellable(record),
  }
  const screen = recordScreen(record, input, answer, context)
  const failure: BackupFailure | undefined =
    input.failure?.attemptId === record.attemptId
      ? backupFailure(input.failure.error, input.failure.step, record)
      : answer.declined
      ? { kind: "declined", step: "move", charged: charged(record), leftover: false }
      : resume?.error !== undefined
      ? backupFailure(resume.error, "resume", record)
      : undefined
  if (!failure) return screen
  if (screen.id === "failed") return { ...screen, inline: failure }
  // A recovery or a finished attempt has no step to raise a sheet over.
  if (screen.id === "recovery" || screen.id === "done" || failureScreen(failure) === "inline")
    return { ...screen, failure }
  return raise(screen, failure, rowsOf(input.keys), context)
}

/**
 * A failure with a sheet of its own, over the screen it stopped. The start screens have no line of
 * their own, so a failure that would sit on its step gets the sheet there.
 */
function raise(
  under: BackupScreen,
  failure: BackupFailure,
  keys: readonly BackupKey[],
  context: Context,
): BackupScreen {
  switch (failureScreen(failure)) {
    case "unavailable":
      return { id: "unavailable", under, failure }
    case "firstPasskey":
      return { id: "firstPasskey", keys, under, failure }
    case "failed":
    case "inline":
      return { id: "failed", failure, under, ...context }
  }
}

function recordScreen(
  record: BackupRotationRecord,
  input: BackupScreenInput,
  answer: Answer,
  context: Context,
): RotationScreen {
  const recovery = recoveryState(record)
  if (recovery) return recoveryScreen(record, recovery, input)
  const approver = keyName(rowsOf(input.keys).find((key) => key.signsHere))
  const savedIn = savedOf(record)
  const amount = record.fundings.some(
    (f) => sent(f) && (fundingLanding(f) || f.outcome === "swept"),
  )
    ? backupAddCharged(record)
    : undefined
  const paid = amount === undefined ? {} : { paid: amount }
  const at = (phase: TrackedPhase): Tracked => ({
    progress: progressAt(record, phase),
    ...(approver && { approver }),
    ...(savedIn && { savedIn }),
    ...paid,
    // The clock is floored to its tick, so a check within the tick reads as now.
    ...(answer.checkedAt !== undefined && {
      checkedAgoMs: Math.max(0, input.now - answer.checkedAt),
    }),
    ...context,
  })
  const waiting = (phase: TrackedPhase): Extract<BackupScreen, { id: "adding" }> => ({
    id: "adding",
    ...at(phase),
    ...timingOf(record, input.now, answer.answered),
  })
  const failed = (kind: "changed" | "route" | "corrupt"): RotationScreen => ({
    id: "failed",
    failure: stateFailure(kind, record),
    ...context,
  })
  switch (record.phase) {
    case "created":
      return { id: "approve", ...at("created") }
    case "signed":
      return {
        id: "approve",
        ...at("signed"),
        ...(record.rotation && { sipa: record.rotation.sipa }),
      }
    case "published":
      if (landing(record)) return waiting("published")
      return {
        id: "approve",
        ...at("published"),
        ...((answer.wait === "funding" || paying(record)) &&
          record.plan && { pay: payFacts(record.plan, input.fit) }),
        ...(paying(record) && { sending: true as const }),
      }
    case "funded":
    case "swept":
    case "installed":
      return waiting(record.phase)
    case "rerooted":
    case "moved":
      return finish(at(record.phase), answer, false)
    case "done": {
      const keys = rowsOf(input.keys)
      const listed = keys.some((key) => hexKey(key.pubkeyHex) === hexKey(record.backup.pubkeyHex))
      return {
        id: "done",
        keys,
        ...(!listed && { unlisted: savedIn ? { savedIn } : {} }),
        ...paid,
      }
    }
    case "conflict":
      return failed("changed")
    case "recovered":
      return recoveryScreen(record, "recovered", input)
    case "attention": {
      const left = tracked(record.suspended) ? record.suspended : undefined
      // Once paid, a route that is not paying is a delay the chain lifts; before, a wait to retry.
      if (record.attention === "route")
        return left && charged(record) === "funding"
          ? { ...waiting(left), delay: "route" }
          : failed("route")
      if (record.attention === "move" && left) return finish(at(left), answer, true)
      return failed("corrupt")
    }
  }
}

function finish(
  tracker: Tracked,
  { wait, approving, declined }: Answer,
  paused: boolean,
): Extract<BackupScreen, { id: "finish" }> {
  const ask = paused || declined ? "retry" : wait === "approval" ? "approve" : undefined
  return {
    id: "finish",
    ...tracker,
    ...(ask && { ask }),
    approving,
    declined,
    paused,
    linkExpiring: wait === "link",
    ...(wait === "uses" && { delay: "uses" as const }),
  }
}

function recoveryScreen(
  record: BackupRotationRecord,
  state: RecoveryState,
  input: BackupScreenInput,
): RotationScreen {
  const recoveryTx = state !== "held" ? record.recovery?.txHash : undefined
  return {
    id: "recovery",
    state,
    extra: record.suspended === "done",
    damaged: record.attention === "corrupt",
    ...(record.plan?.deposited && { deposited: BigInt(record.plan.deposited) }),
    ...(record.rotation && { sipa: record.rotation.sipa }),
    ...(recoveryTx && { recoveryTx }),
    startedAt: record.createdAt,
    empty: input.emptyUnder === recoveryKey(record),
    busy: input.busy,
  }
}

function savedOf({ backup }: BackupRotationRecord): BackupSaved | undefined {
  if (backup.securityKey) return { securityKey: true }
  const manager = providerNameFor(backup.prfAaguid)
  return manager ? { manager } : undefined
}

/**
 * A paid add's time against its quote, delayed once well past it. A sheet reopened long after
 * paying waits for the driver's first answer: the chain may have moved on meanwhile.
 */
function timingOf(
  record: BackupRotationRecord,
  now: number,
  answered: boolean,
): { timing?: BackupTiming; delay?: BackupDelay } {
  const timing = backupAddTiming(record, now)
  if (!timing) return {}
  const takesMs = takesOf(record.plan)
  return {
    timing: { takesMs, leftMs: Math.min(timing.leftMs, takesMs) },
    ...(timing.delayed && answered && { delay: "late" as const }),
  }
}

const takesOf = (plan?: BackupRotationPlan) => plan?.takesMs ?? BACKUP_ADD_TAKES_MS

const hexKey = (hex: string) => hex.toLowerCase().replace(/^0x/, "")

const payFacts = (plan: BackupRotationPlan, fit?: FundFit): BackupPayFacts => ({
  ...backupFundingQuote(plan),
  plan,
  ...(fit && { fit }),
  takesMs: takesOf(plan),
  address: plan.address,
  approvals: plan.approvals,
  refunds: plan.refunds ?? 0,
  moves: plan.moves,
})

/** The record's place on the tracker, at `phase`: its own, or the one a parked record left. */
function progressAt(record: BackupRotationRecord, phase: TrackedPhase): BackupProgress {
  switch (phase) {
    case "created":
      return { step: 2, stage: "sign" }
    case "signed":
      return { step: 2, stage: "publish" }
    case "published":
      return landing(record) ? { step: 3, stage: "landing" } : { step: 2, stage: "pay" }
    case "funded":
      return { step: 3, stage: "funded" }
    case "swept":
    case "installed":
      return { step: 3, stage: "final" }
    case "rerooted":
    case "moved": {
      const refunds = refundProgress(record)
      const run = moveProgress(record)
      return {
        step: 4,
        stage: phase === "rerooted" && !record.refunds && !run ? "installing" : "moving",
        ...(refunds && { refunds }),
        ...(run && { moved: { included: run.included, total: run.total } }),
      }
    }
  }
}
