import {
  fundingLocalId,
  RootPasskeyRequiredError,
  WalletError,
  type AllowanceSnapshot,
  type BackupAddRelease,
  type BackupRotationRecord,
  type BackupRotationStored,
  type ResumeAnswer,
} from "@obsidion/front-core"
import {
  backupAddOptionsFor,
  BackupPasskeyRefusedError,
  type BackupAddOptions,
  type UserAgentInfo,
} from "@obsidion/passkey-web"
import { GPM_AAGUID } from "@obsidion/core/constants"
import { EcdsaK256AlphaAuthProvider, pubkeyHexOf, RotationRouteNotLiveError } from "@obsidion/sdk"
import type { Address, Hex } from "viem"
import { isDemoMode } from "../../../src/dev/demoFlag"
import { DEMO_SIGNING_KEY_HEX } from "../../../src/dev/demoFixtures"
import type { EntryFacts } from "../../../src/features/backupPasskey/backupPasskeyFacts"
import { CAPTURE_OFFER } from "./faster-offer"
import type {
  BackupScreenId,
  BackupScreenInput,
  EntryInput,
} from "../../../src/features/backupPasskey/backupScreen"

/*
 * `?backupFixture=<name>` opens the Passkeys sheet on one screen of the backup passkey flow. Each
 * fixture is what the selector reads, with the key list the sheet's own read returns; the real
 * selector picks the screen and its props from it.
 */

const DAI = 10n ** 18n
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address

/** The L1 account the keys are installed on. */
export const BACKUP_OWNER = addr(0x0b0e)
const SIPA = addr(0x51)
const TWO_KEY = word(0x2b)
const BACKUP_PUBKEY = "b2".repeat(64)
const OTHER_PUBKEY = "a1".repeat(64)

let sessionPubkey: Promise<string> | undefined
/** The session's own key, as the sheet's read compares it. */
export const sessionPubkeyHex = () =>
  (sessionPubkey ??= pubkeyHexOf(
    new EcdsaK256AlphaAuthProvider(Buffer.from(DEMO_SIGNING_KEY_HEX, "hex")),
  ))

/** A key on the account; `session` is the one this session signs with. */
export interface FixtureKey {
  role: "sign-up" | "backup"
  session: boolean
  name?: string
  /** The manager id this browser recorded at the key's creation. */
  aaguid?: string
}

/** What the sheet's key read answers. */
export type FixtureKeys = "loading" | "unreadable" | "unverified" | readonly FixtureKey[]

interface BackupFixture {
  /** The screen the selector must pick, which the capture plans are keyed by. */
  screen: BackupScreenId
  keys: FixtureKeys
  /** What overrides the host's own input. */
  input: Partial<BackupScreenInput>
  /** The session passkey lives on one device: Settings shows its card and badge. */
  oneDevice?: true
}

const SIGN_UP: FixtureKey = { role: "sign-up", session: true, name: "This Mac" }
/** Unnamed, so the key list names its manager. */
const SIGN_UP_GPM: FixtureKey = { role: "sign-up", session: true, aaguid: GPM_AAGUID }
const BOTH: readonly FixtureKey[] = [SIGN_UP, { role: "backup", session: false, name: "iPhone" }]
/** A session signed in with a key the account doesn't list as installed here. */
const ELSEWHERE: readonly FixtureKey[] = [{ ...SIGN_UP, session: false }]

/** The installed key's pubkey: the session's own, else one the session doesn't hold. */
export const keyPubkey = (key: FixtureKey, session: string) =>
  key.session ? session : key.role === "backup" ? BACKUP_PUBKEY : OTHER_PUBKEY

const ALLOWANCE: AllowanceSnapshot = {
  status: "ready",
  read: {
    fpcAddress: "0x1",
    railId: 0,
    payer: "0x2",
    allowance: { subscribed: true, uses: 10, maxTx: 10, refillPeriod: 0 },
  },
  state: { kind: "available", available: 10, renews: false },
  refreshing: false,
}
/** A funding and credit with fractions of a cent, so figures rounded apart would disagree. */
const FUNDING = (20551n * DAI) / 10000n
const CREDITED = (15004n * DAI) / 10000n
const FACTS: EntryFacts = {
  routeLive: true,
  balance: 120n * DAI,
  fundingAmount: FUNDING,
  credited: CREDITED,
  chunk: { kind: "fits" },
  fits: () => true,
  plan: true,
  moves: 2,
  savingsMoving: false,
  withdrawalInFlight: false,
  links: 0,
  historicBalance: false,
  quote: {
    total: FUNDING - CREDITED,
    fixed: (35n * DAI) / 100n,
    network: FUNDING - CREDITED - (35n * DAI) / 100n,
  },
}
/** A funding's release read: a minute to land, a 20 minute release, 3 minutes with a tip. */
const RELEASE: BackupAddRelease = {
  landingSeconds: 60,
  standardEtaSeconds: 20 * 60,
  tippedEtaSeconds: 3 * 60,
  l1SlotSeconds: 12,
}
const DEVICE: UserAgentInfo = {
  osFamily: "macos",
  osVersionReported: "15",
  browserFamily: "chrome",
  browserVersionReported: "140",
}
const PLACE: BackupAddOptions = backupAddOptionsFor({
  reach: "ok",
  extension: "none",
  protonKept: false,
  ignoresHints: false,
  os: "macos",
})
const entry = (over: Partial<EntryInput> = {}): EntryInput => ({
  allowance: ALLOWANCE,
  facts: FACTS,
  railFailed: false,
  registering: false,
  device: DEVICE,
  place: PLACE,
  ...over,
})
const WITHDRAWING = entry({ facts: { ...FACTS, withdrawalInFlight: true } })
const SHORT = entry({ facts: { ...FACTS, balance: (8n * DAI) / 10n } })
const SHORT_WITHDRAWING = entry({
  facts: { ...FACTS, balance: (8n * DAI) / 10n, withdrawalInFlight: true },
})
/** Enough for the add, not for Faster's tip on top. */
const fitsUntipped = (amount: bigint) => amount <= FUNDING
const TIP_SHORT = entry({ facts: { ...FACTS, fits: fitsUntipped } })
const NO_ROUTE = entry({ facts: { ...FACTS, routeLive: false } })
/** A one-key account that may start an add. */
const start = (over: Partial<BackupScreenInput> = {}): Partial<BackupScreenInput> => ({
  saved: null,
  addable: true,
  laptop: true,
  entry: entry(),
  ...over,
})

const ATTEMPT = "capture-attempt"
const PLAN = {
  address: TWO_KEY,
  fundingAmount: FUNDING.toString(),
  deposited: ((185n * DAI) / 100n).toString(),
  credited: CREDITED.toString(),
  approvals: 1,
  moves: 2,
}
const ROTATION: BackupRotationStored = {
  owner: BACKUP_OWNER,
  intent: {
    rollupVersion: "6",
    recipientCommitment: word(5),
    owner: BACKUP_OWNER,
    nonce: "7",
    accountGasLimits: word(8),
    record: {
      l2Address: TWO_KEY,
      rollupVersion: "6",
      publicKey: { x: "11", y: "12" },
      resolverOperator: addr(13),
    },
    namePortalRecipient: TWO_KEY,
    key: { qx: word(21), qy: word(22) },
    metadata: "0x0134",
  },
  sharedSecretSalt: word(9),
  nonce: "7",
  builtOver: {
    l2Address: word(10),
    rollupVersion: "6",
    publicKey: { x: "11", y: "12" },
    resolverOperator: addr(13),
  },
  expectedKeys: [{ key: { qx: word(14), qy: word(15) }, metadata: "0x" }],
  implementation: addr(16),
  deployArgs: {
    implementation: addr(16),
    intentHash: word(17),
    recoveryCommitment: word(18),
    rollupVersion: "6",
    resweepable: false,
    forwardingTable: addr(19),
  },
  sipa: SIPA,
  add: { pubkey: { qx: word(21), qy: word(22) }, credentialId: "0x2324", envelope: "0x25" },
  signature: "0x26",
}
const STARTED = Date.parse("2026-09-01T11:48:00.000Z")
/** The capture's wall time: 15 minutes after the funding went out, inside the quoted time. */
export const CAPTURE_NOW = STARTED + 19 * 60_000

const created = (over: Partial<BackupRotationRecord> = {}): BackupRotationRecord => ({
  owner: BACKUP_OWNER,
  attemptId: ATTEMPT,
  phase: "created",
  backup: {
    credentialId: "capture-backup",
    pubkeyHex: BACKUP_PUBKEY,
    envelopeHex: "01".repeat(62),
    userHandle: "Y2FwdHVyZQ",
    prfSlot: "first",
    securityKey: false,
  },
  fundings: [],
  createdAt: STARTED,
  updatedAt: STARTED,
  ...over,
})
const signed = (over: Partial<BackupRotationRecord> = {}) =>
  created({ phase: "signed", plan: PLAN, rotation: ROTATION, fromBlock: 50, ...over })
const funding = (
  outcome: BackupRotationRecord["fundings"][number]["outcome"] = "pending",
): Pick<BackupRotationRecord, "fundings"> => ({
  fundings: [
    {
      attemptId: ATTEMPT,
      localId: fundingLocalId(ATTEMPT),
      sentAt: STARTED + 4 * 60_000,
      session: "capture",
      txHash: word(0x101),
      expiresAtMs: STARTED + 60 * 60_000,
      outcome,
    },
  ],
})
/** The funding landed a minute after it went out. */
const LANDED: Pick<BackupScreenInput, "funding" | "release"> = {
  funding: {
    phase: "awaiting_proven",
    startTime: STARTED + 4 * 60_000,
    minedAt: STARTED + 5 * 60_000,
  },
  release: RELEASE,
}
const moving = (over: Partial<BackupRotationRecord> = {}) =>
  signed({ phase: "moved", ...funding("swept"), ...over })
const MAIN = word(0x7a)
const SAVINGS = word(0x7b)
const TOKENS = { main: MAIN, savings: SAVINGS }
type Run = NonNullable<BackupRotationRecord["move"]>["runs"][number]
type Chunk = Run["chunks"][number]
const chunk = (token: string, state: Chunk["state"]): Chunk => ({
  token,
  amount: (60n * DAI).toString(),
  state,
  ...(state !== "planned" && state !== "claimed" && { txHash: word(0x201) }),
})
/** One paylink taken back, as a run finds it. */
const TAKEN: Pick<BackupRotationRecord, "refunds"> = {
  refunds: { links: [{ link: "capture-link", state: "mined", txHash: word(0x200) }] },
}
/** A move at its latest run, with the driver's answer and the tokens read. */
const run = (chunks: Chunk[], resume: ResumeAnswer, over: Partial<Run> = {}) =>
  saved(
    moving({
      phase: "rerooted",
      ...TAKEN,
      move: { runs: [{ plannedAt: 1, m: chunks.length, depositBound: false, chunks, ...over }] },
    }),
    resume,
    { tokens: TOKENS },
  )
const parked = (
  attention: BackupRotationRecord["attention"],
  over: Partial<BackupRotationRecord> = {},
) => signed({ phase: "attention", ...(attention && { attention }), suspended: "funded", ...over })
/** A sweep a reorg dropped, while the relayer's re-sweep has yet to settle. */
const GONE: BackupRotationRecord["sweep"] = {
  index: "3",
  blockNumber: 90,
  blockHash: word(0x90),
  credited: ((14n * DAI) / 10n).toString(),
  recheck: "gone",
}

/** The saved record, with the driver's answer for it. */
const saved = (
  record: BackupRotationRecord,
  resume: ResumeAnswer | null = {},
  over: Partial<BackupScreenInput> = {},
): Partial<BackupScreenInput> => ({
  saved: record,
  deps: "ready",
  drive: { record, ...(resume && { resume }), approving: false },
  ...over,
})
/** A fresh attempt whose Approve tap failed with `error`. */
const approveFailed = (error: unknown) =>
  saved(created(), null, { failure: { step: "approve", error, attemptId: ATTEMPT } })
const closed = () => new DOMException("The passkey request was closed", "NotAllowedError")

export const BACKUP_FIXTURES = {
  "loading": { screen: "loading", keys: "loading", input: {} },
  "loading-rotation": {
    screen: "loading",
    keys: [SIGN_UP],
    input: { saved: signed(), deps: "building" },
  },
  // A1. Only Settings reads the one-device flag; `keys` names the sign-up key's manager.
  "keys": { screen: "keys", keys: [SIGN_UP_GPM], input: start() },
  "keys-one-device": { screen: "keys", keys: [SIGN_UP], input: start(), oneDevice: true },
  "keys-two": { screen: "keys", keys: BOTH, input: { saved: null } },
  "keys-unregistered": { screen: "keys", keys: "unverified", input: start() },
  // A2, A3
  "intro": {
    screen: "intro",
    keys: [SIGN_UP],
    input: start({ start: "intro", release: RELEASE, offer: CAPTURE_OFFER }),
  },
  "intro-tip-short": {
    screen: "intro",
    keys: [SIGN_UP],
    input: start({ start: "intro", release: RELEASE, offer: CAPTURE_OFFER, entry: TIP_SHORT }),
  },
  "place": { screen: "place", keys: [SIGN_UP], input: start({ start: "place" }) },
  // B1-B4
  "blocked": {
    screen: "blocked",
    keys: [SIGN_UP],
    input: start({ start: "intro", entry: WITHDRAWING }),
  },
  "blocked-balance": {
    screen: "blocked",
    keys: [SIGN_UP],
    input: start({ start: "intro", entry: SHORT_WITHDRAWING }),
  },
  "low-balance": {
    screen: "lowBalance",
    keys: [SIGN_UP],
    input: start({ start: "intro", entry: SHORT }),
  },
  "unavailable": {
    screen: "unavailable",
    keys: [SIGN_UP],
    input: start({ start: "intro", entry: NO_ROUTE }),
  },
  "unavailable-raised": {
    screen: "unavailable",
    keys: [SIGN_UP],
    input: approveFailed(new RotationRouteNotLiveError("capture")),
  },
  "unreadable-keys": { screen: "unreadable", keys: "unreadable", input: { saved: null } },
  "unreadable-entry": {
    screen: "unreadable",
    keys: [SIGN_UP],
    input: start({ start: "intro", entry: entry({ facts: "unreadable" }) }),
  },
  "unreadable-deps": {
    screen: "unreadable",
    keys: [SIGN_UP],
    input: { saved: signed(), deps: "failed" },
  },
  "first-passkey": { screen: "firstPasskey", keys: ELSEWHERE, input: start({ start: "intro" }) },
  "first-passkey-raised": {
    screen: "firstPasskey",
    keys: ELSEWHERE,
    input: approveFailed(new RootPasskeyRequiredError()),
  },
  // A4, the pay step, C3
  "approve": { screen: "approve", keys: [SIGN_UP], input: saved(created(), null) },
  "approve-publish": { screen: "approve", keys: [SIGN_UP], input: saved(signed()) },
  "approve-pay": {
    screen: "approve",
    keys: [SIGN_UP],
    input: saved(signed({ phase: "published" }), { wait: "funding" }, { release: RELEASE }),
  },
  "approve-pay-tip-short": {
    screen: "approve",
    keys: [SIGN_UP],
    input: saved(
      signed({ phase: "published" }),
      { wait: "funding" },
      { release: RELEASE, fit: { fits: fitsUntipped, done: true } },
    ),
  },
  "approve-declined": {
    screen: "approve",
    keys: [SIGN_UP],
    input: approveFailed(closed()),
  },
  // A5, C6
  "adding": {
    screen: "adding",
    keys: [SIGN_UP],
    input: saved(signed({ phase: "funded", ...funding() }), {}, LANDED),
  },
  "adding-delayed": {
    screen: "adding",
    keys: [SIGN_UP],
    input: saved(parked("route", funding())),
  },
  "adding-relanding": {
    screen: "adding",
    keys: [SIGN_UP],
    input: saved(signed({ phase: "swept", ...funding("swept"), sweep: GONE }), { watch: true }),
  },
  // A6, C6, C7
  "finish": {
    screen: "finish",
    keys: [SIGN_UP],
    input: saved(moving(), { wait: "approval" }),
  },
  "finish-declined": {
    screen: "finish",
    keys: [SIGN_UP],
    input: saved(
      moving({
        move: { runs: [{ plannedAt: 1, m: 1, depositBound: false, declined: true, chunks: [] }] },
      }),
      { wait: "declined" },
    ),
  },
  "finish-uses": {
    screen: "finish",
    keys: [SIGN_UP],
    input: saved(moving(), { wait: "uses" }),
  },
  "finish-paused": {
    screen: "finish",
    keys: [SIGN_UP],
    input: saved(parked("move", { suspended: "moved", ...funding("swept") })),
  },
  "finish-relanding": {
    screen: "finish",
    keys: [SIGN_UP],
    input: saved(moving({ sweep: GONE }), { watch: true }),
  },
  "finish-relanding-approve": {
    screen: "finish",
    keys: [SIGN_UP],
    input: saved(moving({ sweep: GONE }), { wait: "approval", watch: true }),
  },
  // Step 4 as the move's rows.
  "finish-links": {
    screen: "finish",
    keys: [SIGN_UP],
    input: saved(
      moving({
        phase: "rerooted",
        refunds: { links: [{ link: "capture-link", state: "planned" }] },
      }),
      { wait: "approval" },
      { tokens: TOKENS },
    ),
  },
  "finish-main-confirming": {
    screen: "finish",
    keys: [SIGN_UP],
    input: run([chunk(MAIN, "submitted"), chunk(SAVINGS, "planned")], { wait: "chunk" }),
  },
  "finish-savings-asking": {
    screen: "finish",
    keys: [SIGN_UP],
    input: run([chunk(MAIN, "mined"), chunk(SAVINGS, "planned")], { wait: "approval" }),
  },
  "finish-upper-bound": {
    screen: "finish",
    keys: [SIGN_UP],
    input: run(
      [chunk(MAIN, "planned"), chunk(MAIN, "planned"), chunk(SAVINGS, "planned")],
      { wait: "approval" },
      { depositBound: true },
    ),
  },
  "finish-rows-declined": {
    screen: "finish",
    keys: [SIGN_UP],
    input: run(
      [chunk(MAIN, "mined"), chunk(SAVINGS, "planned")],
      { wait: "declined" },
      { declined: true },
    ),
  },
  // A7
  "done": { screen: "done", keys: BOTH, input: saved(signed({ phase: "done" })) },
  "done-relanding": {
    screen: "done",
    keys: BOTH,
    input: saved(signed({ phase: "done", sweep: GONE }), { watch: true }),
  },
  // C1, C2, C4, C5, C8
  "failed-closed": {
    screen: "failed",
    keys: [SIGN_UP],
    input: start({ failure: { step: "add", error: closed() } }),
  },
  "failed-refused": {
    screen: "failed",
    keys: [SIGN_UP],
    input: start({
      picked: "key",
      failure: {
        step: "add",
        error: new BackupPasskeyRefusedError("key-no-prf", { userAgent: DEVICE }),
      },
    }),
  },
  "failed-changed": {
    screen: "failed",
    keys: [SIGN_UP],
    input: saved(signed({ phase: "conflict" })),
  },
  "failed-unknown": {
    screen: "failed",
    keys: [SIGN_UP],
    input: approveFailed(new Error("capture failure")),
  },
  "failed-route": {
    screen: "failed",
    keys: [SIGN_UP],
    input: saved(parked("route", { suspended: "signed" })),
  },
  // Funding held at the deposit address, on its way back, or back.
  "recovery": {
    screen: "recovery",
    keys: [SIGN_UP],
    input: saved(parked("stranded", funding("mined"))),
  },
  "recovery-sent": {
    screen: "recovery",
    keys: [SIGN_UP],
    input: saved(parked("stranded", { ...funding("mined"), recovery: { txHash: word(0xab) } })),
  },
  "recovery-recovered": {
    screen: "recovery",
    keys: [SIGN_UP],
    input: saved(signed({ phase: "recovered", recovery: { txHash: word(0xab) } })),
  },
} as const satisfies Record<string, BackupFixture>

/** The fixture this page was opened on, in demo mode only. */
export function backupFixture(): BackupFixture | null {
  if (!isDemoMode()) return null
  const name = new URLSearchParams(location.search).get("backupFixture")
  if (name === null) return null
  if (!Object.hasOwn(BACKUP_FIXTURES, name))
    throw new WalletError("invariant", `Unknown backup fixture: ${name}`)
  return BACKUP_FIXTURES[name as keyof typeof BACKUP_FIXTURES]
}
