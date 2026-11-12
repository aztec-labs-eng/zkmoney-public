import { Fr } from "@aztec-labs/aztec.js/fields"
import type { PrfSlot } from "@obsidion/core/types"
import type { PersistedRotation } from "@obsidion/sdk"
import type { Address, Hex } from "viem"
import { PASSKEY_ENVELOPE_BYTES } from "../oxide/passkeyEnvelope.js"
import { migrateBackupRotations } from "../storageMigrations/backupRotations"
import type { Database } from "./database"
import { bestEffort, bestEffortSync, WalletError } from "./errors"
import { loadRecords, type RecordSet } from "./persistentStore"
import type { SipaOrigin } from "./sipaDeposits"
import type { ReadonlyStore } from "./store"
import { strictRecords, type StrictRecords } from "./strictRecords"

/**
 * Where a backup-passkey rotation stands: the backup is created and sealed (`created`), the account
 * change is signed (`signed`), its deposit address is published to the relayer (`published`), a
 * funding is on its way (`funded`), the sweep that runs the change is settled (`swept`), the wallet
 * runs on the two-key account (`rerooted`), the balance has moved (`moved`) and the backup is ready
 * (`done`). `installed`: the change ran without this wallet's funding; it joins at `swept`.
 * `conflict`: the account's keys changed elsewhere. `recovered`: stranded funding was recovered.
 * `attention`: stopped for a reason the user must see.
 */
export const BACKUP_ROTATION_PHASES = [
  "created",
  "signed",
  "published",
  "funded",
  "swept",
  "rerooted",
  "moved",
  "done",
  "installed",
  "conflict",
  "recovered",
  "attention",
] as const
export type BackupRotationPhase = (typeof BACKUP_ROTATION_PHASES)[number]

/** Why a rotation needs attention: funding held at the deposit address, the sweep route not
 *  paying, a damaged record, or part of the balance left behind. */
export const BACKUP_ROTATION_ATTENTIONS = ["stranded", "route", "corrupt", "move"] as const
export type BackupRotationAttention = (typeof BACKUP_ROTATION_ATTENTIONS)[number]

/** The passkey being added; its envelope is dropped once the rotation is done. */
export interface BackupRotationPasskey {
  credentialId: string
  /** 64 bytes x‖y, hex. */
  pubkeyHex: string
  /** The master key sealed under this passkey's PRF, hex; absent from `done` on. */
  envelopeHex?: string
  /** The WebAuthn user handle it was created with, base64url; the identity map takes it at install. */
  userHandle: string
  prfSlot: PrfSlot
  prfAaguid?: string
  securityKey: boolean
  transports?: readonly string[]
}

/** What the signed change needs, shown on the Fund screen and kept for a resume. */
export interface BackupRotationPlan {
  /** The two-key account the balance moves to. */
  address: string
  /** Atomic token units, as decimal strings. */
  fundingAmount: string
  /**
   * What reaches the deposit address: the funding less the withdrawal's own charges. Less the
   * funding margin, it is the floor below which the flow takes money there as someone else's. The
   * recovery card shows it, not the funding, which never all lands. A record without it shows no
   * amount.
   */
  deposited?: string
  credited: string
  /** The prover tip inside `fundingAmount`, written when the funding is sent; absent when none. */
  proverTip?: string
  /** Prompts now, then prompts to take back open paylinks and to move the balance. */
  approvals: number
  /** A record planned before the add took back paylinks has none. */
  refunds?: number
  moves: number
  /** The add's time, as quoted when planned. */
  takesMs?: number
}

export interface StoredAddPasskeyIntent {
  rollupVersion: string
  recipientCommitment: Hex
  owner: Address
  nonce: string
  accountGasLimits: Hex
  record: StoredUserRecord
  namePortalRecipient: Hex
  key: StoredKey
  metadata: Hex
}

export interface StoredUserRecord {
  l2Address: Hex
  rollupVersion: string
  publicKey: { x: string; y: string }
  resolverOperator: Address
}

export interface StoredKey {
  qx: Hex
  qy: Hex
}

export interface StoredAuthKey {
  key: StoredKey
  metadata: Hex
}

export interface StoredDeployArgs {
  implementation: Address
  intentHash: Hex
  recoveryCommitment: Hex
  rollupVersion: string
  resweepable: boolean
  forwardingTable: Address
}

/**
 * The signed change as the sdk keeps it, in JSON: bigints as decimal strings, the salt as a field
 * hex. The signature and the backup's envelope leave at `done`; the salt leaves once no funding
 * can land unswept, since money stranded at the deposit address is recovered with it.
 */
export interface BackupRotationStored {
  owner: Address
  intent: StoredAddPasskeyIntent
  sharedSecretSalt?: Hex
  nonce: string
  builtOver: StoredUserRecord
  expectedKeys: StoredAuthKey[]
  implementation: Address
  deployArgs: StoredDeployArgs
  sipa: Address
  add: { pubkey: StoredKey; credentialId: Hex; envelope?: Hex }
  signature?: Hex
}

export function storeRotation(rotation: PersistedRotation): BackupRotationStored {
  const { intent, builtOver, deployArgs } = rotation
  return {
    owner: rotation.owner,
    intent: {
      rollupVersion: intent.rollupVersion.toString(),
      recipientCommitment: intent.recipientCommitment,
      owner: intent.owner,
      nonce: intent.nonce.toString(),
      accountGasLimits: intent.accountGasLimits,
      record: {
        l2Address: intent.record.l2Address,
        rollupVersion: intent.record.rollupVersion.toString(),
        publicKey: {
          x: intent.record.publicKey.x.toString(),
          y: intent.record.publicKey.y.toString(),
        },
        resolverOperator: intent.record.resolverOperator,
      },
      namePortalRecipient: intent.namePortalRecipient,
      key: { qx: intent.key.qx, qy: intent.key.qy },
      metadata: intent.metadata,
    },
    sharedSecretSalt: rotation.sharedSecretSalt.toString() as Hex,
    nonce: rotation.nonce.toString(),
    builtOver: {
      l2Address: builtOver.l2Address,
      rollupVersion: builtOver.rollupVersion.toString(),
      publicKey: { x: builtOver.publicKey.x.toString(), y: builtOver.publicKey.y.toString() },
      resolverOperator: builtOver.resolverOperator,
    },
    expectedKeys: rotation.expectedKeys.map(({ key, metadata }) => ({
      key: { qx: key.qx, qy: key.qy },
      metadata,
    })),
    implementation: rotation.implementation,
    deployArgs: { ...deployArgs, rollupVersion: deployArgs.rollupVersion.toString() },
    sipa: rotation.sipa,
    add: {
      pubkey: { qx: rotation.add.pubkey.qx, qy: rotation.add.pubkey.qy },
      credentialId: rotation.add.credentialId,
      envelope: rotation.add.envelope,
    },
    signature: rotation.signature,
  }
}

/**
 * The deposit address's CREATE2 origin, as its recovery needs it: the args that deploy the
 * add-passkey clone when no sweep has, and the account whose signature, with the salt, the clone
 * accepts.
 */
export function rotationDepositOrigin(
  rotation: Pick<BackupRotationStored, "owner" | "deployArgs">,
  factories: { sipaFactory: Address; accountFactory: Address },
): SipaOrigin {
  const { deployArgs } = rotation
  return {
    protocol: "account",
    sipaFactory: factories.sipaFactory,
    implementation: deployArgs.implementation,
    intentHash: deployArgs.intentHash,
    recoveryCommitment: deployArgs.recoveryCommitment,
    rollupVersion: deployArgs.rollupVersion,
    resweepable: deployArgs.resweepable,
    forwardingTable: deployArgs.forwardingTable,
    recoveryAccount: rotation.owner,
    accountFactory: factories.accountFactory,
  }
}

/** A record stripped of what the sdk's rotation needs cannot be checked or swept again. */
export class RotationStrippedError extends Error {
  constructor(readonly field: "salt" | "signature" | "envelope") {
    super(`backup rotation: the ${field} has left the record`)
    this.name = "RotationStrippedError"
  }
}

export function persistedRotation(stored: BackupRotationStored): PersistedRotation {
  if (!stored.sharedSecretSalt) throw new RotationStrippedError("salt")
  if (!stored.signature) throw new RotationStrippedError("signature")
  if (!stored.add.envelope) throw new RotationStrippedError("envelope")
  const { intent, builtOver, deployArgs } = stored
  return {
    owner: stored.owner,
    intent: {
      rollupVersion: BigInt(intent.rollupVersion),
      recipientCommitment: intent.recipientCommitment,
      owner: intent.owner,
      nonce: BigInt(intent.nonce),
      accountGasLimits: intent.accountGasLimits,
      record: {
        l2Address: intent.record.l2Address,
        rollupVersion: BigInt(intent.record.rollupVersion),
        publicKey: { x: BigInt(intent.record.publicKey.x), y: BigInt(intent.record.publicKey.y) },
        resolverOperator: intent.record.resolverOperator,
      },
      namePortalRecipient: intent.namePortalRecipient,
      key: { ...intent.key },
      metadata: intent.metadata,
    },
    sharedSecretSalt: Fr.fromHexString(stored.sharedSecretSalt),
    nonce: BigInt(stored.nonce),
    builtOver: {
      l2Address: builtOver.l2Address,
      rollupVersion: BigInt(builtOver.rollupVersion),
      publicKey: { x: BigInt(builtOver.publicKey.x), y: BigInt(builtOver.publicKey.y) },
      resolverOperator: builtOver.resolverOperator,
    },
    expectedKeys: stored.expectedKeys.map(({ key, metadata }) => ({ key: { ...key }, metadata })),
    implementation: stored.implementation,
    deployArgs: { ...deployArgs, rollupVersion: BigInt(deployArgs.rollupVersion) },
    sipa: stored.sipa,
    add: {
      pubkey: { ...stored.add.pubkey },
      credentialId: stored.add.credentialId,
      envelope: stored.add.envelope,
    },
    signature: stored.signature,
  }
}

/**
 * What became of one funding send. `pending` until its transaction is finalized on L2 or past its expiry;
 * `never-sent` when the send was aborted before the node took it; `swept` once its withdrawal
 * reached the deposit address and a sweep took the money.
 */
export type BackupFundingOutcome =
  | "pending"
  | "never-sent"
  | "mined"
  | "swept"
  | "reverted"
  | "dead"

/** One funding send, appended before it goes out and never rewritten by a later one. */
export interface BackupFunding {
  attemptId: string
  /** The withdrawal tracker's row for this send. */
  localId: string
  sentAt: number
  /** The life of the wallet that seeded the send. */
  session: string
  txHash?: Hex
  expiresAtMs?: number
  outcome: BackupFundingOutcome
}

export const fundingLocalId = (attemptId: string): string => `wdraw_backup_${attemptId}`

/** The republish accounting of the deposit address's broadcast; `count` is written before each send. */
export interface BackupPublish {
  txHash?: Hex
  l2Block?: number
  count: number
  lastAt?: number
  history: { txHash: Hex; l2Block: number; at: number }[]
}

/** `mined` once an L1 checkpoint holds the transaction; the sequencer alone can drop the tiers before. */
export type MoveChunkState = "planned" | "claimed" | "submitted" | "included" | "mined"

/** One sponsored send of the move, from its plan until an L1 checkpoint holds it. */
export interface MoveSend<State extends string = MoveChunkState> {
  state: State
  /** The send holding it before its hash; a claim from another life of the wallet is released. */
  claim?: { id: string; session: string }
  txHash?: Hex
  expiresAtMs?: number
  /** The block the send was seen in, kept once `mined`; a send first read as final has none. */
  inclusion?: { blockNumber: number; blockHash: string }
  /** An included send whose transaction reverted; nothing moved, re-read like any inclusion. */
  effect?: "reverted"
}

export interface MoveChunkRecord extends MoveSend {
  token: string
  /** Atomic units, decimal. */
  amount: string
}

/**
 * An open paylink the move takes back: its refund pays the one-key account, which the move then
 * empties. `skipped` once the link was spent another way, by a claim or another refund.
 */
export interface LinkRefundRecord extends MoveSend<MoveChunkState | "skipped"> {
  /**
   * The link's fragment, which its refund takes. Its create row drops the fragment once a refund
   * is included, and a reorg can still drop that refund.
   */
  link: string
}

/** The open paylinks the move takes back before its first run, listed once. */
export interface LinkRefunds {
  /** The user closed the prompt for the next refund; nothing is sent until they ask again. */
  declined?: true
  links: LinkRefundRecord[]
}

/** One forwarding run: `m` chunks planned together, counted as "n of m". */
export interface MoveRun {
  plannedAt: number
  m: number
  /** `m` is an upper bound: deposits were planned over. */
  depositBound: boolean
  /** The user closed the prompt for the next chunk; nothing is sent until they ask again. */
  declined?: true
  chunks: MoveChunkRecord[]
}

export interface BackupRotationRecord {
  /** The L1 account the backup is installed on; the record key. */
  owner: string
  /** Minted at `created`; the first funding's id. */
  attemptId: string
  phase: BackupRotationPhase
  attention?: BackupRotationAttention
  /** The phase the attention state interrupted; the record returns to it. */
  suspended?: BackupRotationPhase
  backup: BackupRotationPasskey
  plan?: BackupRotationPlan
  rotation?: BackupRotationStored
  /** The L1 block at `signed`; every read of the deposit address starts there. */
  fromBlock?: number
  publish?: BackupPublish
  fundings: BackupFunding[]
  /** The change ran without this wallet's funding, read so at this settled block. */
  installed?: { blockHash: Hex }
  /**
   * The sweep that ran the change, counted once its block is settled and re-read from the chain
   * until `L1_SWEEP_RECHECK_DEPTH` blocks deep (`deep`). `gone` while a reorg dropped it and the
   * relayer's re-sweep has yet to settle, `lost` once no re-sweep came within that depth.
   */
  sweep?: {
    index: string
    blockNumber?: number
    blockHash: Hex
    credited: string
    recheck?: "gone" | "deep" | "lost"
  }
  /** Money held at the deposit address when the change ran without a sweep: reported as stranded once the attempt ends, the salt kept for its recovery. */
  unswept?: true
  /** The user left the done screen; the record is removed once nothing is watched. */
  dismissed?: true
  /** The L1 transaction that sent the deposit address's money back out. */
  recovery?: { txHash: Hex }
  /** The recovery that ended the attempt at `recovered`; money recovered after it never replaces it. */
  recovered?: { txHash: Hex }
  /** The re-root's checkpoints, each written as it completes. */
  reroot?: { batch?: Hex; switched?: boolean; rebound?: boolean; receiveCode?: boolean }
  move?: { runs: MoveRun[] }
  refunds?: LinkRefunds
  createdAt: number
  updatedAt: number
}

const PRF_SLOTS: readonly PrfSlot[] = ["first", "second"]
const SWEEP_RECHECKS: readonly NonNullable<
  NonNullable<BackupRotationRecord["sweep"]>["recheck"]
>[] = ["gone", "deep", "lost"]
/** Phases from the signature to the end of the settlement, where the signed change is kept whole. */
const APPROVED: readonly BackupRotationPhase[] = [
  "signed",
  "published",
  "funded",
  "swept",
  "rerooted",
  "moved",
  "installed",
]
/** Phases a record reaches only through a signed change. */
const PLANNED: readonly BackupRotationPhase[] = [...APPROVED, "done"]
/** Phases where the envelope may already have left the record. */
const STRIPPED: readonly BackupRotationPhase[] = ["done", "recovered", "attention"]
export const BACKUP_FUNDING_OUTCOMES: readonly BackupFundingOutcome[] = [
  "pending",
  "never-sent",
  "mined",
  "swept",
  "reverted",
  "dead",
]
const CHUNK_STATES: readonly MoveChunkState[] = [
  "planned",
  "claimed",
  "submitted",
  "included",
  "mined",
]
const REFUND_STATES: readonly LinkRefundRecord["state"][] = [...CHUNK_STATES, "skipped"]

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === "string"
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const isBool = (v: unknown): v is boolean => typeof v === "boolean"
const isDecimal = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v)
const isHex = (v: unknown): v is Hex => typeof v === "string" && /^0x([0-9a-fA-F]{2})*$/.test(v)
const isHexOf = (v: unknown, bytes: number): v is Hex => isHex(v) && v.length === 2 + 2 * bytes
const isAddress = (v: unknown): v is Address => isHexOf(v, 20)
const isWord = (v: unknown): v is Hex => isHexOf(v, 32)
const isField = (v: unknown): v is Hex => isWord(v) && BigInt(v) < Fr.MODULUS
const isHexBytes = (v: unknown, bytes: number): v is string =>
  typeof v === "string" && v.length === 2 * bytes && /^[0-9a-f]+$/i.test(v)
const oneOf = <T extends string>(set: readonly T[], v: unknown): v is T => set.includes(v as T)
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v)
const arrayOf = <T>(v: unknown, check: (v: unknown) => v is T): v is T[] =>
  Array.isArray(v) && v.every(check)

function isPlan(v: unknown): v is BackupRotationPlan {
  return (
    isObj(v) &&
    isStr(v.address) &&
    isDecimal(v.fundingAmount) &&
    optional(v.deposited, isDecimal) &&
    isDecimal(v.credited) &&
    optional(v.proverTip, isDecimal) &&
    isNum(v.approvals) &&
    optional(v.refunds, isNum) &&
    isNum(v.moves) &&
    optional(v.takesMs, isNum)
  )
}

const isKey = (v: unknown): v is StoredKey => isObj(v) && isWord(v.qx) && isWord(v.qy)
const isAuthKey = (v: unknown): v is StoredAuthKey => isObj(v) && isKey(v.key) && isHex(v.metadata)

function isIntent(v: unknown): v is StoredAddPasskeyIntent {
  return (
    isObj(v) &&
    isDecimal(v.rollupVersion) &&
    isWord(v.recipientCommitment) &&
    isAddress(v.owner) &&
    isDecimal(v.nonce) &&
    isWord(v.accountGasLimits) &&
    isUserRecord(v.record) &&
    isWord(v.namePortalRecipient) &&
    isKey(v.key) &&
    isHex(v.metadata)
  )
}

function isUserRecord(v: unknown): v is StoredUserRecord {
  return (
    isObj(v) &&
    isWord(v.l2Address) &&
    isDecimal(v.rollupVersion) &&
    isObj(v.publicKey) &&
    isDecimal(v.publicKey.x) &&
    isDecimal(v.publicKey.y) &&
    isAddress(v.resolverOperator)
  )
}

function isDeployArgs(v: unknown): v is StoredDeployArgs {
  return (
    isObj(v) &&
    isAddress(v.implementation) &&
    isWord(v.intentHash) &&
    isWord(v.recoveryCommitment) &&
    isDecimal(v.rollupVersion) &&
    isBool(v.resweepable) &&
    isAddress(v.forwardingTable)
  )
}

function isStoredRotation(v: unknown, whole: boolean): v is BackupRotationStored {
  if (!isObj(v) || !isAddress(v.owner) || !isIntent(v.intent)) return false
  if (!isDecimal(v.nonce) || !isUserRecord(v.builtOver)) return false
  if (!arrayOf(v.expectedKeys, isAuthKey) || !isAddress(v.implementation)) return false
  if (!isDeployArgs(v.deployArgs) || !isAddress(v.sipa)) return false
  const add = v.add
  if (!isObj(add) || !isKey(add.pubkey) || !isHex(add.credentialId)) return false
  if (whole ? !isHex(add.envelope) : !optional(add.envelope, isHex)) return false
  if (whole ? !isField(v.sharedSecretSalt) : !optional(v.sharedSecretSalt, isField)) return false
  return whole ? isHex(v.signature) : optional(v.signature, isHex)
}

function isFunding(v: unknown): v is BackupFunding {
  return (
    isObj(v) &&
    isStr(v.attemptId) &&
    isStr(v.localId) &&
    isNum(v.sentAt) &&
    isStr(v.session) &&
    optional(v.txHash, isWord) &&
    optional(v.expiresAtMs, isNum) &&
    oneOf(BACKUP_FUNDING_OUTCOMES, v.outcome)
  )
}

function isPublish(v: unknown): v is BackupPublish {
  return (
    isObj(v) &&
    optional(v.txHash, isWord) &&
    optional(v.l2Block, isNum) &&
    isNum(v.count) &&
    optional(v.lastAt, isNum) &&
    arrayOf(
      v.history,
      (h): h is BackupPublish["history"][number] =>
        isObj(h) && isWord(h.txHash) && isNum(h.l2Block) && isNum(h.at),
    )
  )
}

function isSend(v: Record<string, unknown>, states: readonly string[]): boolean {
  return (
    oneOf(states, v.state) &&
    optional(v.claim, (k) => isObj(k) && isStr(k.id) && isStr(k.session)) &&
    optional(v.txHash, isWord) &&
    optional(v.expiresAtMs, isNum) &&
    optional(v.inclusion, (i) => isObj(i) && isNum(i.blockNumber) && isStr(i.blockHash)) &&
    optional(v.effect, (e) => e === "reverted")
  )
}

const isChunk = (v: unknown): v is MoveChunkRecord =>
  isObj(v) && isStr(v.token) && isDecimal(v.amount) && isSend(v, CHUNK_STATES)

const isRefunds = (v: unknown): v is LinkRefunds =>
  isObj(v) &&
  optional(v.declined, (d) => d === true) &&
  arrayOf(
    v.links,
    (l): l is LinkRefundRecord => isObj(l) && isStr(l.link) && isSend(l, REFUND_STATES),
  )

const isRun = (v: unknown): v is MoveRun =>
  isObj(v) &&
  isNum(v.plannedAt) &&
  isNum(v.m) &&
  isBool(v.depositBound) &&
  optional(v.declined, (d) => d === true) &&
  arrayOf(v.chunks, isChunk)

/** Whether a saved value is a record every reader can act on, stored under its own key. */
function isRecord(v: unknown, key: string): v is BackupRotationRecord {
  if (!isObj(v) || !isStr(v.owner) || v.owner.toLowerCase() !== key) return false
  if (!isStr(v.attemptId) || !oneOf(BACKUP_ROTATION_PHASES, v.phase)) return false
  if (v.phase === "attention" || v.attention !== undefined || v.suspended !== undefined) {
    if (v.phase !== "attention" || !oneOf(BACKUP_ROTATION_ATTENTIONS, v.attention)) return false
    if (!oneOf(BACKUP_ROTATION_PHASES, v.suspended) || v.suspended === "attention") return false
  }
  const b = v.backup
  if (!isObj(b) || !isStr(b.credentialId) || !isStr(b.pubkeyHex) || !isStr(b.userHandle))
    return false
  if (!oneOf(PRF_SLOTS, b.prfSlot) || !isBool(b.securityKey)) return false
  if (
    b.envelopeHex === undefined
      ? !STRIPPED.includes(v.phase)
      : !isHexBytes(b.envelopeHex, PASSKEY_ENVELOPE_BYTES)
  )
    return false
  if (v.plan === undefined ? PLANNED.includes(v.phase) : !isPlan(v.plan)) return false
  if (
    v.rotation === undefined
      ? PLANNED.includes(v.phase)
      : !isStoredRotation(v.rotation, APPROVED.includes(v.phase))
  )
    return false
  if (!optional(v.fromBlock, isNum) || !optional(v.publish, isPublish)) return false
  if (!arrayOf(v.fundings, isFunding)) return false
  if (!optional(v.installed, (i) => isObj(i) && isWord(i.blockHash))) return false
  if (
    !optional(
      v.sweep,
      (s) =>
        isObj(s) &&
        isDecimal(s.index) &&
        optional(s.blockNumber, isNum) &&
        isWord(s.blockHash) &&
        isDecimal(s.credited) &&
        optional(s.recheck, (r) => oneOf(SWEEP_RECHECKS, r)),
    )
  )
    return false
  if (!optional(v.unswept, (u) => u === true)) return false
  if (!optional(v.dismissed, (d) => d === true)) return false
  if (!optional(v.recovery, (r) => isObj(r) && isWord(r.txHash))) return false
  if (!optional(v.recovered, (r) => isObj(r) && isWord(r.txHash))) return false
  if (
    !optional(
      v.reroot,
      (r) =>
        isObj(r) &&
        optional(r.batch, isWord) &&
        optional(r.switched, isBool) &&
        optional(r.rebound, isBool) &&
        optional(r.receiveCode, isBool),
    )
  )
    return false
  if (!optional(v.move, (m) => isObj(m) && arrayOf(m.runs, isRun))) return false
  if (!optional(v.refunds, isRefunds)) return false
  return isNum(v.createdAt) && isNum(v.updatedAt)
}

/** Whether a funding can still land: sent, or seeded and not yet known to be aborted. */
export const fundingOpen = (funding: BackupFunding): boolean => funding.outcome === "pending"

/** Whether a funding's money may reach the deposit address with no sweep to take it: open, or on L2 and not swept. */
export const fundingLanding = (funding: BackupFunding): boolean =>
  fundingOpen(funding) || funding.outcome === "mined"

/** Whether a funding entry was ever appended; the next send mints its own id. */
export const fundingStarted = (record: Pick<BackupRotationRecord, "fundings">): boolean =>
  record.fundings.length > 0

/** Whether the sweep is still re-read from the chain: it has a block to compare and is not yet deep or lost. */
export const sweepWatched = (record: Pick<BackupRotationRecord, "sweep">): boolean =>
  record.sweep?.blockNumber !== undefined &&
  (record.sweep.recheck === undefined || record.sweep.recheck === "gone")

/** Whether a reorg dropped the sweep and the relayer's re-sweep has yet to settle. */
export const sweepGone = (record: Pick<BackupRotationRecord, "sweep">): boolean =>
  record.sweep?.recheck === "gone"

/**
 * Whether the rotation has yet to switch the wallet onto the two-key account. Until then the wallet
 * acts as the one-key account, so a paylink made now could be refunded only to that account.
 */
export function rerootAhead(
  record: Pick<BackupRotationRecord, "phase" | "suspended" | "reroot">,
): boolean {
  switch (record.phase === "attention" ? record.suspended : record.phase) {
    case "created":
    case "signed":
    case "published":
    case "funded":
      return true
    case "swept":
    case "installed":
      return record.reroot?.switched !== true
    default:
      return false
  }
}

/** The latest run's progress as "n of m": its included or mined chunks over its plan. */
export function moveProgress(
  record: Pick<BackupRotationRecord, "move">,
): { included: number; total: number; depositBound: boolean } | undefined {
  const run = record.move?.runs.at(-1)
  if (!run) return undefined
  const included = run.chunks.filter(
    (c) => c.state === "mined" || (c.state === "included" && c.effect !== "reverted"),
  ).length
  return { included, total: run.m, depositBound: run.depositBound }
}

/** The refunds' progress as "n of m" while one has yet to land; undefined once none has. */
export function refundProgress(
  record: Pick<BackupRotationRecord, "refunds">,
): { landed: number; total: number } | undefined {
  const links = record.refunds?.links ?? []
  const landed = links.filter(
    (l) =>
      l.state === "skipped" ||
      l.state === "mined" ||
      (l.state === "included" && l.effect !== "reverted"),
  ).length
  return landed < links.length ? { landed, total: links.length } : undefined
}

/** Whether the move waits for the user to ask again after they closed a refund's or a chunk's prompt. */
export const moveDeclined = (
  record: Pick<BackupRotationRecord, "phase" | "move" | "refunds">,
): boolean =>
  (record.phase === "rerooted" || record.phase === "moved") &&
  (!!record.move?.runs.at(-1)?.declined || !!record.refunds?.declined)

/**
 * Whether the balance move can be spending now: from the re-root's switch until the move ends. Its
 * chunks pay with the one-key account's subscription note, the same note the two-key account's
 * sponsored sends pay with. A move parked at `attention` sends nothing until the user retries it.
 */
export function movesBalance(record: Pick<BackupRotationRecord, "phase" | "reroot">): boolean {
  switch (record.phase) {
    case "swept":
    case "installed":
      return record.reroot?.switched === true
    case "rerooted":
    case "moved":
      return true
    default:
      return false
  }
}

/**
 * The record as `done` keeps it: the signature and the envelope gone, the salt too once no funding
 * can land unswept, nothing is held and the sweep is no longer re-read. A record whose funding
 * resolves later is stripped again by the same function.
 */
export function stripSettled(record: BackupRotationRecord): BackupRotationRecord {
  const { envelopeHex: _envelope, ...backup } = record.backup
  if (!record.rotation) return { ...record, backup }
  const { signature: _signature, sharedSecretSalt, add, ...rest } = record.rotation
  const { envelope: _sealed, ...addRest } = add
  const rotation: BackupRotationStored = { ...rest, add: addRest }
  const held = record.fundings.some(fundingLanding) || record.unswept || sweepWatched(record)
  if (held && sharedSecretSalt) {
    rotation.sharedSecretSalt = sharedSecretSalt
  }
  return { ...record, backup, rotation }
}

/**
 * Whether a backup passkey add on this device has yet to switch the account at `address` onto its
 * two-key account. A record not yet signed names no account, so it counts for any.
 */
export function rerootPending(
  records: readonly BackupRotationRecord[],
  address: string | undefined,
): boolean {
  if (!address) return false
  const key = address.toLowerCase()
  return records.some(
    (record) =>
      rerootAhead(record) &&
      (!record.rotation || record.rotation.builtOver.l2Address.toLowerCase() === key),
  )
}

/**
 * Whether a rotation on this device moves the balance of the account at `address`, the one-key
 * account it leaves or the two-key one it lands on.
 */
export function balanceMoving(
  records: readonly BackupRotationRecord[],
  address: string | undefined,
): boolean {
  if (!address) return false
  const key = address.toLowerCase()
  return records.some(
    (record) =>
      movesBalance(record) &&
      (record.plan?.address.toLowerCase() === key ||
        record.rotation?.builtOver.l2Address.toLowerCase() === key),
  )
}

/**
 * Whether a balance read at PXE block `anchor` holds the chunk. A chunk with no block saved was
 * final when first read, and is taken as held.
 */
const chunkHeld = (chunk: MoveChunkRecord, anchor: number | undefined): boolean =>
  (chunk.state === "mined" || (chunk.state === "included" && chunk.effect !== "reverted")) &&
  (!chunk.inclusion || (anchor !== undefined && chunk.inclusion.blockNumber <= anchor))

/**
 * What a backup passkey add still has to move into the two-key account at `address` in `token`,
 * beyond what that account's balance read at `anchor` holds. The session runs on the two-key
 * account from the re-root, so its balance alone leaves the rest out until the move ends. A run is
 * planned only once the one before is checkpointed, so only the latest counts.
 */
export function balanceToMove(
  records: readonly BackupRotationRecord[],
  address: string | undefined,
  token: string | null | undefined,
  anchor: number | undefined,
): bigint {
  if (!address || !token) return 0n
  const key = address.toLowerCase()
  const unit = token.toLowerCase()
  const record = records.find(
    (r) =>
      r.plan?.address.toLowerCase() === key &&
      // A move paused for the user's retry still owes its balance.
      movesBalance({ phase: r.suspended ?? r.phase, reroot: r.reroot }),
  )
  return (record?.move?.runs.at(-1)?.chunks ?? [])
    .filter((c) => c.token.toLowerCase() === unit && !chunkHeld(c, anchor))
    .reduce((total, c) => total + BigInt(c.amount), 0n)
}

/**
 * {@link balanceMoving} once the records have loaded, for callers outside React that defer while it
 * holds. Records that do not read count as moving: a rotation may resume over them after a reload.
 */
export async function balanceMovingNow(
  rotations: { view: ReadonlyStore<RecordSet<BackupRotationRecord>> } | null,
  address: string,
): Promise<boolean> {
  if (!rotations) return false
  const records = await bestEffort("unknown", loadRecords(rotations.view))
  return !records || balanceMoving(records, address)
}

/** The account's pending rotations, one per L1 owner, kept until each is done or cancelled. */
export interface BackupRotations extends StrictRecords<BackupRotationRecord> {
  put(record: BackupRotationRecord): Promise<void>
  remove(owner: string): Promise<void>
}

/**
 * What telemetry learns of a saved row that fails its check: whether funds may hang on it, never
 * the row, which may hold a salt.
 */
export interface UnreadableRotationRow {
  phase: BackupRotationPhase | "unknown"
  /** The latest funding's outcome; `none` when the row lists no funding. */
  outcome: BackupFundingOutcome | "none" | "unknown"
  /** The row's `unswept` flag; absent when the row holds one that is not a flag. */
  unswept?: boolean
}

function lastOutcome(fundings: unknown): UnreadableRotationRow["outcome"] {
  if (!Array.isArray(fundings)) return "unknown"
  if (fundings.length === 0) return "none"
  const last: unknown = fundings.at(-1)
  return isObj(last) && oneOf(BACKUP_FUNDING_OUTCOMES, last.outcome) ? last.outcome : "unknown"
}

function unreadableRow(v: unknown): UnreadableRotationRow {
  const row = isObj(v) ? v : {}
  return {
    phase: oneOf(BACKUP_ROTATION_PHASES, row.phase) ? row.phase : "unknown",
    outcome: isObj(v) ? lastOutcome(row.fundings) : "unknown",
    unswept: row.unswept === undefined ? false : row.unswept === true ? true : undefined,
  }
}

const damaged = (key: string) => new WalletError("unknown", `backup rotation ${key} is damaged`)

/** A stored record every reader can act on, or a throw that fails the read. */
export function rotationRecordOf(value: unknown, key: string): BackupRotationRecord {
  if (!isRecord(value, key)) throw damaged(key)
  return value
}

export function createBackupRotations({
  db,
  onUnreadable,
}: {
  db: Database
  /** Hears a saved row that fails its check, before the read fails. */
  onUnreadable?(row: UnreadableRotationRow): void
}): BackupRotations {
  const saved = (value: unknown, key: string): BackupRotationRecord => {
    if (isRecord(value, key)) return value
    // A hook that throws must not replace the damaged-row error the read fails with.
    bestEffortSync(() => onUnreadable?.(unreadableRow(value)), undefined)
    throw damaged(key)
  }
  const records = strictRecords(db, {
    prefix: "acct/backupRotations",
    field: "owner",
    check: rotationRecordOf,
    checkSaved: saved,
    migrate: (from, w, store) => migrateBackupRotations(from, w, store, saved),
  })
  return {
    ...records,
    put: async (record) => void (await records.update(record.owner, () => record)),
    remove: async (owner) => void (await records.removeIf(owner, () => true)),
  }
}
