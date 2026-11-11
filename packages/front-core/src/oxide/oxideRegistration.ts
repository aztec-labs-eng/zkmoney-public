import type { Pace } from "@obsidion/core/cadence"
import type { LegacySipaDeployArgs } from "@oxide/l1-contracts/legacy_sipa.js"
/**
 * Deposit-gated name registration (registration-fee.md: registration by deposit). The name is
 * registered by funding a registration SIPA whose address commits to the record and the owner's
 * consent; a relayer sweeps the deposit, and the sweep runs `RegistrationController.register` — writing the
 * name, paying the fee to the selected beneficiary, deploying the owner's 4337 account, installing the
 * owner's passkey (r1) key, and bridging the rest. The wallet runs no bundler and pays no gas: it signs
 * a zero-fee install UserOp with the bootstrap key, carried in the proofs, and the controller submits it
 * to the EntryPoint inside the sweep. `/domain/sign` is bootstrap-key gated, and custody is "the L1
 * deposit landed and was swept."
 *
 * One machine, two entry points. `startOxideRegistrationSession` prechecks the name, derives the
 * registration SIPA, obtains the NameClaim (+ signed terms) and the consent signature,
 * persists an `awaiting_deposit` record, and returns the deposit address with the broadcast payload,
 * which the sheet that shows the address owes to the broadcast ledger. `resumeOxideRegistration`
 * ticks the pending record from ANY point to on-chain confirmation: it reads the Registry
 * (authoritative) and observes the deposit and sweep for progress; a forced tick re-derives the
 * consent and re-requests the claim. The record exists before the claim, so no crash strands a
 * registration.
 *
 * Pure over injected collaborators (claim server client, L1 reader, SIPA deriver, broadcaster,
 * deposit reader) so the full sequence is testable without HTTP/RPC/real passkeys. Deterministic
 * key material makes it resumable: a crash mid-flow re-derives the SAME account and SIPA.
 */

import { type Address, type Hex, zeroAddress } from "viem"
import {
  buildR1InstallUserOp,
  computeUserOpHash,
  type AuthKeyEntry,
  type R1InstallArg,
  type R1InstallGas,
  type R1PublicKeyArg,
  type UserRecordArg,
} from "@oxide/l1-contracts"
import {
  EMPTY_SIGNED_TERMS,
  type DomainAuthArg,
  type SignedTermsArg,
  type SipaDeployArgs,
} from "@obsidion/sdk"

import { composeWireNameHash } from "../core/services/wireDomain"
import {
  isTerminalRegistrationPhase,
  type PendingRegistrationRecord,
  type RegistrationRoute,
  type RegistrationTerms,
} from "../engine/registrationRecord"
import {
  currentRegistration,
  latestRegistration,
  type RegistrationEvent,
  type RegistrationStore,
} from "../engine/registrations"
import { loadRecords } from "../engine/persistentStore"
import type { NameClaimResponse, SignedTermsResponse } from "@obsidion/core/types"
import type { AccountServiceClient } from "./accountServiceClient"
import {
  AccountServiceError,
  isClaimAttemptsExhausted,
  isNameBlocked,
  isNameReserved,
} from "./accountServiceClient"
import { deriveBootstrapKey, type FieldLike } from "./oxideAccountKeys"
import { credentialIdToMetadata } from "./oxideWebAuthn"
import { consentDigest } from "./oxideRegistrationData"
import { signAccountDigest, type AccountPasskey } from "./accountSignature"
import type { SipaOrigin } from "../engine/sipaDeposits"
import { WalletError, bestEffort } from "../engine/errors"
import type { Turn } from "../engine/turns"
import { logger } from "../utils/logger"

/**
 * The shared L1 reader (`createOxideL1Reader`) — used by registration, the passkey-first enter flow,
 * and the migration relay. `getAccountNonce` serves the minimal 4337 relay
 * (`updateUserL2Address`), not registration; registration itself uses only the registry reads below.
 *
 * Names live in the NameRegistry and per-account metadata in the AccountMetadataRegistry it points
 * at, so the two are addressed separately.
 */
export interface OxideL1Reader {
  predictAccountAddress(factory: Address, bootstrap: Address): Promise<Address>
  getAccountNonce(entryPoint: Address, account: Address): Promise<bigint>
  readUserAddress(registry: Address, nameHash: Hex): Promise<Address>
  /** `account → nameHash`; zero when the account holds no name. Reverse lookup for recovery. */
  readNameOf(registry: Address, account: Address): Promise<Hex>
  /** The NameRegistry's current AccountMetadataRegistry — an owner-mutable pointer, so always live. */
  readAccountMetadataRegistry(registry: Address): Promise<Address>
  /** The account's metadata record, or null when it has none. */
  readUserRecord(accountMetadataRegistry: Address, account: Address): Promise<UserRecordArg | null>
  /** The R1 install gas limits of the controller the registry names, which rebuilds the op it sweeps. */
  readR1InstallGas(registry: Address): Promise<R1InstallGas>
  /** The account's installed r1 keys — the enter flow's passkey match. */
  getAuthKeys(account: Address): Promise<readonly AuthKeyEntry[]>
  /**
   * At most `max` installed r1 keys in storage order, read by count and index so an account with
   * many keys never sends the whole array.
   */
  readAuthKeys(account: Address, max: number): Promise<readonly AuthKeyEntry[]>
  /**
   * The same bounded read, keeping the account's total key count beside the entries, so a reader
   * can tell a full read from a truncated one.
   */
  readAuthKeysCounted(account: Address, max: number): Promise<BoundedAuthKeys>
  /** Deployed bytecode at `address`, or undefined/"0x" when absent. */
  getCode(address: Address): Promise<Hex | undefined>
  readNamePortalRegistry(namePortal: Address): Promise<Address>
  readFactoryImplementation(accountFactory: Address): Promise<Address>
}

/** A bounded auth-key read with the account's total count, so completeness is knowable. */
export interface BoundedAuthKeys {
  entries: readonly AuthKeyEntry[]
  /** The account's total installed key count; entries hold at most `max` of them. */
  authKeyCount: number
}

/** The registry reads the registration machine actually calls — a narrow slice of the shared reader. */
export type RegistrationL1Reads = Pick<
  OxideL1Reader,
  | "predictAccountAddress"
  | "readUserAddress"
  | "readNameOf"
  | "readAccountMetadataRegistry"
  | "readUserRecord"
  | "readR1InstallGas"
  | "getCode"
  | "readAuthKeys"
>

/** The claim-server routes the flow drives — just the NameClaim signer now (registration-fee.md §Removed). */
export type OxideAccountServiceRoutes = Pick<AccountServiceClient, "signDomain">

/** Resolved registration environment (from the OxideEnvTuple + the resolved factory/resolver). */
export interface OxideRegistrationEnv {
  registry: Address
  factory: Address
  ensDomain: string
  /** The gateway operator EOA recorded as `UserRecord.resolverOperator`. */
  resolverOperator: Address
  rollupVersion: bigint
  l1ChainId: number
  /** The fee token registration deposits must be paid in (`RegistrationController.FEE_TOKEN`). */
  feeToken: Address
  /**
   * The L2 address oxide's NamePortal reports the claimed name to, committed into the registration
   * intent. Zero notifies nobody — correct only where no L2 contract gates on the message.
   */
  namePortalRecipient: Hex
  /** ERC-4337 EntryPoint the passkey-install op binds to. Optional because the SIPA deposit and
   *  detection flows share this env and never install a key; registration guards it at use
   *  (`requireEntryPoint` rejects a missing or zero value). */
  entryPoint?: Address
}

/** Inputs the SIPA deriver needs beyond the env it closes over. */
export interface RegistrationDerivationInput {
  owner: Address
  nameHash: Hex
  l2Address: Hex
  /** The exact fee the registration pays, in the fee token's base units: the signed terms' fee when
   *  the claim carries terms, else the controller's schedule fee. Committed into the SIPA address;
   *  the sweep pays exactly this and the controller only checks it. */
  fee: bigint
  /** The allowlisted funder the fee goes to. Committed into the SIPA address. */
  beneficiary: Address
  masterSecret: FieldLike
  /** A salt seeded with an address shown before the wallet's salt key, replayed in its place. */
  sharedSecretSalt?: Hex
}

/** The derived registration SIPA and the record it commits to. */
export interface RegistrationDerivation {
  sipaAddress: Address
  /** CREATE2 args (incl. the nonzero `registration`) a relayer deploys the clone with. */
  sipaArgs: SipaDeployArgs | LegacySipaDeployArgs
  origin: SipaOrigin
  /** ABI-encoded registration intent — the `registrationData` the sweep passes to `register`. */
  registrationData: Hex
  /** The identity slice of `registrationData` — the bytes `consentSig` covers. */
  recordData: Hex
  /** `keccak256(registrationData)` — the SIPA's `registration` arg. */
  registration: Hex
  /** The stealth scalar the SIPA recovery key derives from; persisted so SP-B can sweep. */
  stealthScalar: bigint
  /** The L2 recipient the broadcast `SIPA` event is delivered to (`UserRecord.l2Address`). */
  recipient: Hex
  /** The `SIPA` event's `shared_secret_salt` the recipient commitment binds to. */
  sharedSecretSalt: Hex
  /** The stealth recipient commitment the post-fee remainder bridges to (the intent's `recipientCommitment`). */
  recipientCommitment: Hex
}

/**
 * Self-initiated intent tracking (sipa-intents.md §Wallet): a registration deposit cannot be
 * identified from its discovery event (the event carries no intent type), so the wallet records the
 * claim inputs itself — the SIPA rail's known-address scan then reads the sweep and claims. Seeded
 * wherever the derivation is in hand; idempotent by address.
 */
export interface RegistrationSipaSeed {
  sipaAddress: Address
  /** The event's shared_secret_salt — the rail's `messageSecret`. */
  messageSecret: Hex
  /** The stealth recipient commitment — the rail's `recipientHash`. */
  recipientHash: Hex
  origin: SipaOrigin
  recipientL2Address: Hex
  /** Registration fee the sweep takes, base units. */
  registrationFee: bigint
}

/** Derives the registration SIPA for a record; closes over env + resolver so the session stays pure. */
export type RegistrationSipaDeriver = (
  input: RegistrationDerivationInput,
) => Promise<RegistrationDerivation>

/** Everything a relayer needs to deploy the SIPA and call the 7-arg registration sweep, plus the
 *  event-delivery pair (`recipient` + `sharedSecretSalt`) the L2 broadcast delivers the recipient's
 *  `SIPA` event from. */
export interface RegistrationBroadcastPayload {
  sipaAddress: Address
  sipaArgs: SipaDeployArgs | LegacySipaDeployArgs
  registrationData: Hex
  consentSig: Hex
  bootstrap: Address
  domainAuth: DomainAuthArg
  /** {@link EMPTY_SIGNED_TERMS} to register on the contract's immutable schedule. */
  signedTerms: SignedTermsArg
  /** The passkey install the sweep bundles through the EntryPoint: the r1 key, its credential-id
   *  metadata, and the bootstrap-key signature over the install UserOp. */
  r1Install: R1InstallArg
  /** The L2 recipient the broadcast `SIPA` event is delivered to; the contract commits it into the hash. */
  recipient: Hex
  /** The `SIPA` event's `shared_secret_salt` the recipient commitment binds to. */
  sharedSecretSalt: Hex
}

/**
 * Publishes a registration SIPA to relayers so one can sweep it (D3a). Registration rides the same
 * `SIPA` event plus L1-operation broadcast as a deposit — it is just one more intent, the registration
 * record plus its consent/domain/terms proofs packed as the intent payload. Platform-specific (the send
 * rides a sponsored L2 tx): web's impl is `createWebRegistrationBroadcaster`, over `buildSipaBroadcast`
 * in the sdk.
 */
export type RegistrationBroadcaster = (
  payload: RegistrationBroadcastPayload,
  attempt?: { operationId?: string; onTxHash?: (txHash: string) => Promise<void> },
) => Promise<string>

export type OxideRegistrationStage = "derive" | "claim" | "broadcast"

const eqAddr = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const ZERO_HASH_RE = /^0x0+$/

/** Back off for at least the server's Retry-After (429/503) but never below our own floor. */
function retryDelayMs(err: unknown, floorMs: number): number {
  return err instanceof AccountServiceError && err.retryAfterSec !== undefined
    ? Math.max(floorMs, err.retryAfterSec * 1000)
    : floorMs
}

// Detection cadences. Confirmation (registry read) opens the in-app gate, so ticks run seconds
// apart; a dependency that cannot answer yet gets the transient window.
export const RESUME_TRANSIENT_RETRY_MS = 30_000
const RESUME_DETECT_POLL_MS = 5_000

export const signedTermsStruct = (terms?: SignedTermsResponse): SignedTermsArg =>
  terms
    ? {
        fee: BigInt(terms.fee),
        minDeposit: BigInt(terms.minDeposit),
        nonce: BigInt(terms.nonce),
        deadline: BigInt(terms.deadline),
        signature: terms.signature,
      }
    : EMPTY_SIGNED_TERMS

function assemblePayload(
  derivation: RegistrationDerivation,
  claim: NameClaimResponse,
  consentSig: Hex,
  r1Install: R1InstallArg,
  bootstrap: Address,
): RegistrationBroadcastPayload {
  return {
    sipaAddress: derivation.sipaAddress,
    sipaArgs: derivation.sipaArgs,
    registrationData: derivation.registrationData,
    consentSig,
    bootstrap,
    domainAuth: {
      nonce: BigInt(claim.nonce),
      deadline: BigInt(claim.deadline),
      signature: claim.signature,
    },
    signedTerms: signedTermsStruct(claim.terms),
    r1Install,
    recipient: derivation.recipient,
    sharedSecretSalt: derivation.sharedSecretSalt,
  }
}

/** The EntryPoint the install op is bound to; registration needs it present and non-zero. */
function requireEntryPoint(env: OxideRegistrationEnv): Address {
  if (!env.entryPoint || /^0x0+$/.test(env.entryPoint)) {
    throw new WalletError(
      "config.invalid",
      "oxide registration env lacks a non-zero EntryPoint — the sweep installs the passkey through it",
    )
  }
  return env.entryPoint
}

/**
 * The passkey install the sweep bundles: an ERC-4337 UserOp calling `addAuthKey(r1Key, credentialId)`
 * on the owner's account, signed by the bootstrap key over the EntryPoint's hash of it. The controller
 * rebuilds this exact op at sweep time, so any deviation fails the sweep. Deterministic in the inputs —
 * a resumed rebuild re-signs identical bytes — since the op fixes nonce 0 and zero gas fees.
 */
export async function buildRegistrationR1Install(
  masterSecret: FieldLike,
  owner: Address,
  env: OxideRegistrationEnv,
  l1: Pick<RegistrationL1Reads, "readR1InstallGas">,
  r1Key: R1PublicKeyArg,
  credentialId: string,
): Promise<R1InstallArg> {
  const entryPoint = requireEntryPoint(env)
  const metadata = credentialIdToMetadata(credentialId)
  const gas = await l1.readR1InstallGas(env.registry)
  const op = buildR1InstallUserOp(owner, 0n, r1Key, metadata, gas)
  const userOpHash = computeUserOpHash(env.l1ChainId, entryPoint, op)
  const bootstrap = deriveBootstrapKey(masterSecret)
  const signature = await bootstrap.sign({ hash: userOpHash })
  return { qx: r1Key.qx, qy: r1Key.qy, metadata, signature }
}

/**
 * The consent signature over a derivation's identity record — deterministic in the master secret.
 * The digest binds the AccountMetadataRegistry the controller resolves at sweep time, so the
 * pointer is read off the NameRegistry here rather than taken from the manifest-built env: signing
 * against a rotated-away registry buys a consent the sweep rejects, after the deposit is paid.
 *
 * It also binds this derivation's own SIPA, so the signature settles the registration only from the
 * address the payer funded.
 */
async function consentFor(
  masterSecret: FieldLike,
  account: Address,
  derivation: RegistrationDerivation,
  env: OxideRegistrationEnv,
  l1: RegistrationL1Reads,
  passkey?: AccountPasskey,
): Promise<Hex> {
  const metadata = await l1.readAccountMetadataRegistry(env.registry)
  if ("recoveryAddress" in derivation.sipaArgs) {
    return deriveBootstrapKey(masterSecret).sign({
      hash: consentDigest(derivation.recordData, env.l1ChainId, metadata, derivation.sipaAddress),
    })
  }
  return signAccountDigest({
    account,
    chainId: env.l1ChainId,
    hash: consentDigest(derivation.recordData, env.l1ChainId, metadata, derivation.sipaAddress),
    bootstrap: deriveBootstrapKey(masterSecret),
    reader: l1,
    passkey,
  })
}

/** Whether the account's metadata record still points at `l2Address` — the name-adoption gate. */
async function recordHoldsL2Address(
  l1: Pick<RegistrationL1Reads, "readAccountMetadataRegistry" | "readUserRecord">,
  registry: Address,
  account: Address,
  l2Address: string,
): Promise<boolean> {
  const record = await l1.readUserRecord(await l1.readAccountMetadataRegistry(registry), account)
  return record !== null && eqAddr(record.l2Address, l2Address)
}

// ── Store surface + detection collaborators ─────────────────────────────────────

/** The registrations the session and the tick drive. */
export type RegistrationRecords = Pick<RegistrationStore, "view" | "get" | "apply" | "start">

/** A close that loses the name, or settles it. */
export type RegistrationClose = Extract<RegistrationEvent, { type: "closed" | "replaced" }>

/**
 * L1 deposit/sweep reads for a registration SIPA — the progress signal behind the registry read.
 *
 * What the tick expects of the set: `readBalance` and `floor` may each come back without a figure.
 * Either gap leaves the funding verdict unknown, so the record keeps its phase. `readSweeps` and
 * `scheduleFee` must produce a value; a rejection
 * there ends the tick on its transient retry.
 */
export interface RegistrationDepositReader {
  /** ERC-20 transfers of `token` into `sipa` (bounded window): names the funding tx. */
  readFunding(sipa: Address, token: Address): Promise<{ amount: bigint; txHash: Hex }[]>
  /** `sipa`'s held `token` balance — the funded signal, the read the relayer sweeps on. */
  readBalance(sipa: Address, token: Address): Promise<bigint>
  /** `Sweep` events on `sipa`. */
  readSweeps(sipa: Address): Promise<{ txHash: Hex }[]>
  /** The least `account`'s deposit must hold, in `token` base units. Undefined while a read
   *  is outstanding. Null when the schedule's fee is below the SIPA's sweep fee: the controller
   *  rejects that sweep, so no balance can ever fund it. */
  floor(token: Address, account: string): Promise<bigint | null | undefined>
  /** The controller's current schedule fee, base units: what a terms-less quote commits. */
  scheduleFee(): Promise<bigint>
}

/** What rebuilding a broadcast needs: the unlocked wallet's keys and the claim server. */
export interface OxideSignDeps {
  masterSecret: FieldLike
  accountService: OxideAccountServiceRoutes
  /** The device passkey's P-256 public key — installed on the account by the sweep. */
  r1Key: R1PublicKeyArg
  passkey?: AccountPasskey
  /** The passkey credential id (base64url) — the install's `addAuthKey` metadata. */
  credentialId: string
  /** L1 reads a broadcast rebuild needs (the AccountMetadataRegistry pointer + the install op hash). */
  l1: RegistrationL1Reads
  deriveRegistrationSipa: RegistrationSipaDeriver
  persistStealthScalar?: (scalar: bigint) => Promise<void>
  /** Records the deposit's claim inputs for the SIPA rail (self-initiated intent tracking). */
  seedSipaDeposit?: (seed: RegistrationSipaSeed) => Promise<void>
  /** The salt `seedSipaDeposit` recorded for an address on this device. */
  seededSipaSalt?: (sipaAddress: Address) => Promise<Hex | undefined>
}

export interface OxideRegistrationDeps {
  /** Bare tag ("alice"); the wire nameHash is composed from it + `env.ensDomain`. */
  tag: string
  env: OxideRegistrationEnv
  /** Wallet master secret — derives the deterministic bootstrap + stealth keys and the consent sig. */
  masterSecret: FieldLike
  /** The user's Aztec L2 account address, recorded as `UserRecord.l2Address`. */
  l2Address: Hex
  accountService: OxideAccountServiceRoutes
  /** The allowlisted funder the fee is committed to (config; the sandbox seeds id 1's address). */
  beneficiary: Address
  /** The controller's schedule fee, read live: what the intent commits when the claim carries no
   *  signed terms. Signed terms override it, which is why the claim is requested before the SIPA
   *  is derived. */
  scheduleFee: () => Promise<bigint>
  /** The device passkey's P-256 public key — installed on the account by the sweep. */
  r1Key: R1PublicKeyArg
  passkey?: AccountPasskey
  /** The passkey credential id (base64url) — the install's `addAuthKey` metadata. */
  credentialId: string
  /** Records the deposit's claim inputs for the SIPA rail (self-initiated intent tracking). */
  seedSipaDeposit?: (seed: RegistrationSipaSeed) => Promise<void>
  l1: RegistrationL1Reads
  deriveRegistrationSipa: RegistrationSipaDeriver
  /** Optional: persist the stealth scalar. SP-B can also re-derive it from the wallet secret. */
  persistStealthScalar?: (scalar: bigint) => Promise<void>
  onStage?: (stage: OxideRegistrationStage) => void
}

export interface OxideRegistrationSessionDeps extends OxideRegistrationDeps {
  turn: OxideResumeDeps["turn"]
  registrations: RegistrationRecords
  /** Maps an on-chain nameHash to a locally-known plaintext tag (adoption gate). */
  resolveLocalTag?: (nameHash: Hex) => Promise<string | null>
  /** Written with the record at its checkpoint: the entry a verified refund of the prior address bought. */
  refundedEntry?: PendingRegistrationRecord["refundedEntry"]
  /** Written with the record at its checkpoint: the address this session replaces. */
  replaced?: PendingRegistrationRecord["replaced"]
  /** The terms the claim states, written with the record. */
  termsOf?: (claim: NameClaimResponse) => RegistrationTerms
  /** How the tag was got, written with the record. */
  route?: RegistrationRoute
}

export interface OxideResumeDeps {
  /** The one turn every registration session and tick shares: two ticks would double-broadcast,
   *  and a session racing a tick would double-claim. */
  turn: Turn
  env: OxideRegistrationEnv
  l1: RegistrationL1Reads
  deposits: RegistrationDepositReader
  registrations: RegistrationRecords
  /** Writes a close; the page closes a lost name and retracts its identity in one write. */
  close: (record: PendingRegistrationRecord, event: RegistrationClose) => Promise<void>
  /** Lazy + account-scoped: called only for a forced tick renewing a spent-rail record's claim.
   *  Return null (or throw) when secrets are unavailable — the tick stays pending. */
  getSignDeps?: (record: PendingRegistrationRecord) => Promise<OxideSignDeps | null>
  /**
   * Owes the record's broadcast to the ledger, for a forced tick: the user asked from the sheet that
   * shows the address. Idempotent. `payload` is one this tick just signed; `now` drops the backoff.
   */
  oweBroadcast?: (
    record: PendingRegistrationRecord,
    owed?: { payload?: RegistrationBroadcastPayload; now?: boolean },
  ) => Promise<void>
  resolveLocalTag?: (nameHash: Hex) => Promise<string | null>
  /** Files a sweep the tick saw on the address's deposit record. */
  sweepSent?: (sipa: Address, txHash: Hex) => Promise<void>
  /** The page's: the next detection read is a poll. */
  pace: Pick<Pace, "gateMs">
}

/**
 * `claim`/`terms`/`payload` are handed to the caller in memory (persisted nowhere): the deposit
 * screen shows the address and, once oxide's relayer rail carries the payload (D3a), the sweep
 * consumes it. `awaiting_deposit` is the normal terminal state of the session — the record is
 * durable and the resume tick carries it to confirmation.
 */
/**
 * Why a name could not be taken. They lead different places: a registered name belongs to an
 * account already, a reserved one is held by another key's live claim, and a blocked one is on the
 * server's list and will not free up.
 */
export type NameTakenReason = "registered" | "reserved" | "blocked"

export type OxideSessionResult =
  | { status: "registered"; name: string; oxideAccount: Address }
  | {
      status: "awaiting_deposit"
      name: string
      oxideAccount: Address
      sipaAddress: Address
      depositToken: Address
      claim: NameClaimResponse
      terms?: SignedTermsResponse
      payload: RegistrationBroadcastPayload
      /** The caller owes this payload's broadcast; false when a predecessor spent the rail. */
      broadcastOwed: boolean
    }
  | { status: "taken"; reason: NameTakenReason }
  /** The account already holds a different name on-chain — the chain wins. `name` is set only when a
   *  local source maps that nameHash to a tag AND the Registry l2Address matches. */
  | { status: "already_registered"; name: string | null; nameHash: Hex; oxideAccount: Address }

export type OxideResumeOutcome =
  | "idle"
  | "pending"
  | "confirmed"
  | "taken"
  | "failed"
  /** The account holds a name no local source can map — route to the enter/recovery flow. */
  | "needs_recovery"

/**
 * This wallet's registration address for `nameHash` at the committed `fee`, with its deposit
 * record's claim inputs. The session commits to it; recovery finds it again with the same call,
 * passing `sharedSecretSalt` for an address salted before the self-SIPA key.
 */
export async function deriveRegistrationAddress(
  deps: Pick<
    OxideRegistrationDeps,
    "masterSecret" | "l2Address" | "beneficiary" | "deriveRegistrationSipa"
  >,
  owner: Address,
  nameHash: Hex,
  fee: bigint,
  sharedSecretSalt?: Hex,
): Promise<{ derivation: RegistrationDerivation; seed: RegistrationSipaSeed }> {
  const derivation = await deps.deriveRegistrationSipa({
    owner,
    nameHash,
    l2Address: deps.l2Address,
    fee,
    beneficiary: deps.beneficiary,
    masterSecret: deps.masterSecret,
    sharedSecretSalt,
  })
  return {
    derivation,
    seed: {
      sipaAddress: derivation.sipaAddress,
      messageSecret: derivation.sharedSecretSalt,
      recipientHash: derivation.recipientCommitment,
      origin: derivation.origin,
      recipientL2Address: deps.l2Address,
      registrationFee: fee,
    },
  }
}

// ── Session ───────────────────────────────────────────────────────────────────

export function startOxideRegistrationSession(
  deps: OxideRegistrationSessionDeps,
): Promise<OxideSessionResult> {
  return deps.turn(() => sessionBody(deps))
}

async function sessionBody(deps: OxideRegistrationSessionDeps): Promise<OxideSessionResult> {
  const { env, l1, accountService, registrations } = deps
  const name = `${deps.tag}.${env.ensDomain}`
  const t0 = Date.now()

  const bootstrap = deriveBootstrapKey(deps.masterSecret)
  const nameHash = composeWireNameHash(deps.tag, env.ensDomain)
  const [oxideAccount, existing] = await Promise.all([
    l1.predictAccountAddress(env.factory, bootstrap.address as Address),
    l1.readUserAddress(env.registry, nameHash),
  ])
  logger.info("[oxideRegistration] session start:", name, "as", oxideAccount)

  if (eqAddr(existing, oxideAccount)) {
    const open = latestRegistration(await loadRecords(registrations.view), oxideAccount)
    if (open && !isTerminalRegistrationPhase(open.phase))
      await registrations.apply(open.sipaAddress, { type: "closed", outcome: "confirmed" })
    return { status: "registered", name, oxideAccount }
  }
  if (existing !== zeroAddress) {
    return { status: "taken", reason: "registered" }
  }

  // The account may already hold a DIFFERENT name (a prior claim swept after a crash) — chain wins.
  const heldName = await l1.readNameOf(env.registry, oxideAccount)
  if (!ZERO_HASH_RE.test(heldName) && heldName.toLowerCase() !== nameHash.toLowerCase()) {
    const localTag = (await deps.resolveLocalTag?.(heldName)) ?? null
    const adoptable =
      localTag !== null &&
      (await recordHoldsL2Address(l1, env.registry, oxideAccount, deps.l2Address))
    return {
      status: "already_registered",
      name: adoptable ? `${localTag}.${env.ensDomain}` : null,
      nameHash: heldName,
      oxideAccount,
    }
  }

  // The claim comes first: the fee the intent commits is the signed terms' fee when the claim
  // carries terms, so the address cannot be derived until the quote is in hand. The claim is
  // re-requestable and persists nowhere, so nothing is lost if the session dies before the record
  // is written.
  deps.onStage?.("claim")
  const tClaim = Date.now()
  let claim: NameClaimResponse
  try {
    claim = await accountService.signDomain({ nameHash, userAddress: oxideAccount })
  } catch (err) {
    // A name reserved or blocked by policy is a real loss; the wait-and-retry 409s (our own device)
    // propagate typed so the caller retries.
    if (isNameReserved(err) || isNameBlocked(err)) {
      return { status: "taken", reason: isNameBlocked(err) ? "blocked" : "reserved" }
    }
    throw err
  }
  logger.info("[oxideRegistration] NameClaim signed", `${Date.now() - tClaim}ms`)
  const fee = claim.terms ? BigInt(claim.terms.fee) : await deps.scheduleFee()

  deps.onStage?.("derive")
  const { derivation, seed } = await deriveRegistrationAddress(deps, oxideAccount, nameHash, fee)

  // The rail's claim inputs are recorded the moment the derivation exists — the discovery event
  // cannot identify a registration deposit, so this local seed is what credits the funds.
  await deps.seedSipaDeposit?.(seed)

  // Durable checkpoint BEFORE the consent: a crash in the signing leaves an `awaiting_deposit`
  // record the resume tick re-drives. A live record at the same address is a re-entry: it keeps its
  // deposit bookmarks and takes the renewed terms. The account's other open records close as
  // replaced, and stay recoverable.
  await registrations.start({
    type: "started",
    record: {
      account: oxideAccount,
      tag: deps.tag,
      nameHash,
      l2Address: deps.l2Address,
      r1Key: { qx: deps.r1Key.qx, qy: deps.r1Key.qy },
      credentialId: deps.credentialId,
      l1ChainId: env.l1ChainId,
      sipaAddress: derivation.sipaAddress,
      fee: fee.toString(),
      beneficiary: deps.beneficiary,
      depositToken: env.feeToken,
      ...(deps.refundedEntry ? { refundedEntry: deps.refundedEntry } : {}),
      ...(deps.replaced ? { replaced: deps.replaced } : {}),
    },
    ...(deps.termsOf ? { terms: deps.termsOf(claim) } : {}),
    ...(deps.route ? { route: deps.route } : {}),
  })
  // Re-derivable, so a failed write does not stop the registration.
  if (deps.persistStealthScalar)
    await bestEffort("unknown", deps.persistStealthScalar(derivation.stealthScalar))

  const consentSig = await consentFor(
    deps.masterSecret,
    oxideAccount,
    derivation,
    env,
    l1,
    deps.passkey,
  )
  const r1Install = await buildRegistrationR1Install(
    deps.masterSecret,
    oxideAccount,
    env,
    l1,
    deps.r1Key,
    deps.credentialId,
  )
  const payload = assemblePayload(derivation, claim, consentSig, r1Install, bootstrap.address)

  // The broadcast is the ledger's: the caller owes it, and it retries until it lands. A predecessor
  // that spent the account's one-shot rail leaves nothing to broadcast.
  const broadcastOwed = deps.replaced?.broadcastSpent !== true
  logger.info(
    "[oxideRegistration] awaiting deposit at",
    derivation.sipaAddress,
    `(session ${Date.now() - t0}ms)`,
  )
  return {
    status: "awaiting_deposit",
    name,
    oxideAccount,
    sipaAddress: derivation.sipaAddress,
    depositToken: env.feeToken,
    claim,
    terms: claim.terms,
    payload,
    broadcastOwed,
  }
}

// ── Resume / detection tick ─────────────────────────────────────────────────────

/** Select the record `deps` were built for and refuse it if its name changed while queued. */
export interface ResumeOptions {
  force?: boolean
  expectedRecord?: { account: string; nameHash: string }
}

/** A tick's outcome, and the least time before the next tick may help. */
export interface OxideResume {
  outcome: OxideResumeOutcome
  nextMs: number
}

export function resumeOxideRegistration(
  deps: OxideResumeDeps,
  opts: ResumeOptions = {},
): Promise<OxideResume> {
  return deps.turn(() => resumeTick(deps, opts))
}

const settled = (outcome: OxideResumeOutcome): OxideResume => ({ outcome, nextMs: 0 })

async function resumeTick(deps: OxideResumeDeps, opts: ResumeOptions): Promise<OxideResume> {
  const records = await loadRecords(deps.registrations.view)
  const record = opts.expectedRecord
    ? latestRegistration(records, opts.expectedRecord.account)
    : currentRegistration(records)
  if (!record) return settled(opts.expectedRecord ? "pending" : "idle")
  if (isTerminalRegistrationPhase(record.phase)) return settled("idle")
  const t0 = Date.now()
  const resume = await resumeTickBody(deps, opts, record)
  logger.info(
    "[oxideRegistration] resume tick:",
    resume.outcome,
    "for",
    record.account,
    `phase=${record.phase} ${Date.now() - t0}ms`,
  )
  return resume
}

async function resumeTickBody(
  deps: OxideResumeDeps,
  opts: ResumeOptions,
  record: PendingRegistrationRecord,
): Promise<OxideResume> {
  const { env, l1, deposits, registrations } = deps
  if (
    opts.expectedRecord &&
    (record.account.toLowerCase() !== opts.expectedRecord.account.toLowerCase() ||
      record.nameHash.toLowerCase() !== opts.expectedRecord.nameHash.toLowerCase())
  ) {
    return settled("pending")
  }

  const account = record.account as Address
  const nameHash = record.nameHash as Hex
  const sipa = record.sipaAddress as Address
  const backoff = (ms: number): OxideResume => ({ outcome: "pending", nextMs: ms })
  const closed = async (
    outcome: OxideResumeOutcome,
    event: RegistrationClose,
  ): Promise<OxideResume> => {
    await deps.close(record, event)
    return settled(outcome)
  }

  // ── Registry confirmation — authoritative. The sweep writes it, so this is the only "done". ──
  const owner = await l1.readUserAddress(env.registry, nameHash)
  if (eqAddr(owner, account)) return closed("confirmed", { type: "closed", outcome: "confirmed" })
  if (owner !== zeroAddress) return closed("taken", { type: "closed", outcome: "taken" })

  // Reverse lookup: the account may hold a DIFFERENT name — the chain wins. Adopt only when a local
  // source maps the hash to a tag AND the metadata record's l2Address matches; otherwise route to
  // recovery.
  const heldName = await l1.readNameOf(env.registry, account)
  if (!ZERO_HASH_RE.test(heldName) && heldName.toLowerCase() !== nameHash.toLowerCase()) {
    const localTag = (await deps.resolveLocalTag?.(heldName)) ?? null
    if (
      localTag !== null &&
      (await recordHoldsL2Address(l1, env.registry, account, record.l2Address))
    ) {
      return closed("confirmed", {
        type: "closed",
        outcome: "confirmed",
        tag: localTag,
        nameHash: heldName,
      })
    }
    return closed("needs_recovery", { type: "closed", outcome: "recovery", nameHash: heldName })
  }

  // ── Deposit / sweep observation — progress, not confirmation. ──
  const depositToken = record.depositToken as Address
  // A balance or floor read that cannot answer is unknown: the funding verdict waits for it.
  const [balance, sweeps, floor] = await Promise.all([
    bestEffort("unknown", deposits.readBalance(sipa, depositToken)),
    deposits.readSweeps(sipa),
    bestEffort("unknown", deposits.floor(depositToken, record.account)),
  ])
  // Funded is what the address holds now: a recovery leaves the incoming transfers behind, so
  // their sum overstates a refunded address. An unread balance or an unknown floor leaves the
  // verdict undefined: the record keeps its phase and the nudge below falls back to a positive
  // balance. A null floor stamps nothing and nudges nothing.
  const funded =
    balance === undefined || floor === undefined
      ? undefined
      : floor !== null && balance > 0n && balance >= floor
  const unreadDeposit = balance === undefined || floor === undefined
  const swept = sweeps.length > 0

  if (swept && record.sweptAt === undefined) {
    // The sweep landed but the registry read above is still zero (RPC lag / reorg window): stamp it
    // and keep polling the registry, which is the authoritative close. A sweep only succeeds on a
    // deposit at the floor, so a swept record is funded even when no tick saw the funds first.
    await registrations.apply(sipa, { type: "swept", txHash: sweeps[0].txHash })
    if (deps.sweepSent) await bestEffort("unknown", deps.sweepSent(sipa, sweeps[0].txHash))
    return backoff(deps.pace.gateMs(RESUME_DETECT_POLL_MS))
  }
  if (funded === true && record.fundedAt === undefined) {
    // An unread funding transfer leaves the record funded without its hash.
    const funding = (await bestEffort("unknown", deposits.readFunding(sipa, depositToken))) ?? []
    await registrations.apply(sipa, { type: "funded", fundingTxHash: funding[0]?.txHash })
  }
  // The quote ran out with nothing at the address: the funnel hears it once.
  const deadline = record.terms?.deadline ?? 0
  if (funded === false && !swept && deadline > 0 && Date.now() > deadline * 1000)
    await registrations.apply(sipa, { type: "lapsed" })

  // ── The broadcast is the ledger's, owed by the surface that shows the address; a tick only reads.
  //    A forced tick (the user refreshing a lapsed quote, or retrying) re-signs the claim now and
  //    hands the ledger the fresh payload. A record whose predecessor spent the account's one-shot
  //    rail has nothing to publish: only a manual sweep registers it, and a forced tick only
  //    renews its claim. ──
  const spent = record.replaced?.broadcastSpent === true
  const sweptBefore = record.sweptAt !== undefined || record.sweepTxHash !== undefined
  if (swept || sweptBefore || (spent && !opts.force))
    return backoff(deps.pace.gateMs(RESUME_DETECT_POLL_MS))
  if (!opts.force || (!spent && record.broadcast))
    return backoff(
      unreadDeposit ? RESUME_TRANSIENT_RETRY_MS : deps.pace.gateMs(RESUME_DETECT_POLL_MS),
    )
  const signDeps = deps.getSignDeps
    ? (await bestEffort("unknown", deps.getSignDeps(record))) ?? null
    : null
  if (!signDeps) {
    if (!spent && deps.oweBroadcast)
      await bestEffort("deposit.broadcastFailed", deps.oweBroadcast(record, { now: true }))
    return backoff(RESUME_TRANSIENT_RETRY_MS)
  }
  const rebuilt = await rebuildBody(deps, record, signDeps)
  if (rebuilt.kind === "closed") return settled(rebuilt.outcome)
  if (rebuilt.kind === "payload") {
    if (deps.oweBroadcast)
      await bestEffort(
        "deposit.broadcastFailed",
        deps.oweBroadcast(record, { payload: rebuilt.payload, now: true }),
      )
  }
  return backoff(rebuilt.kind === "wait" ? rebuilt.ms : deps.pace.gateMs(RESUME_DETECT_POLL_MS))
}

// ── Rebuilding a broadcast ──────────────────────────────────────────────────────

/**
 * `payload`: ready to send. `spent`: the rail was spent by a predecessor, so the claim was renewed
 * and nothing is published. `wait`: not possible yet, ask again in `ms`. `closed`: the record ended
 * (the name was lost, the claim budget ran out, or its address no longer derives), so nothing is
 * owed.
 */
export type RegistrationRebuild =
  | { kind: "payload"; payload: RegistrationBroadcastPayload }
  | { kind: "spent" }
  | { kind: "wait"; ms: number; reason: string }
  | { kind: "closed"; outcome: "failed" | "taken" }

/**
 * The derivation that lands at `sipaAddress`: the wallet key's, else one replaying the salt seeded
 * with an address shown before that key. The key's when neither lands, for the caller to refuse.
 */
export async function deriveRecordedRegistrationSipa(
  derive: RegistrationSipaDeriver,
  input: RegistrationDerivationInput,
  sipaAddress: Address,
  seededSalt?: (sipaAddress: Address) => Promise<Hex | undefined>,
): Promise<RegistrationDerivation> {
  const derivation = await derive(input)
  if (eqAddr(derivation.sipaAddress, sipaAddress)) return derivation
  // An unread seed is no salt: the wallet key's derivation stands.
  const salt = seededSalt && (await bestEffort("unknown", seededSalt(sipaAddress)))
  if (!salt) return derivation
  const replayed = await derive({ ...input, sharedSecretSalt: salt })
  return eqAddr(replayed.sipaAddress, sipaAddress) ? replayed : derivation
}

/**
 * The broadcast for a record whose session payload is gone: its committed address is re-derived,
 * the claim re-requested and the consent re-signed. Serialized with sessions and ticks, which also
 * request claims.
 */
export function rebuildRegistrationBroadcast(
  deps: Pick<OxideResumeDeps, "env" | "l1" | "deposits" | "registrations" | "close" | "turn">,
  record: PendingRegistrationRecord,
  signDeps: OxideSignDeps,
): Promise<RegistrationRebuild> {
  return deps.turn(async () => {
    const current = await deps.registrations.get(record.sipaAddress)
    if (!current || isTerminalRegistrationPhase(current.phase))
      return { kind: "closed", outcome: "failed" } satisfies RegistrationRebuild
    return rebuildBody(deps, current, signDeps)
  })
}

async function rebuildBody(
  deps: Pick<OxideResumeDeps, "env" | "l1" | "deposits" | "registrations" | "close">,
  record: PendingRegistrationRecord,
  signDeps: OxideSignDeps,
): Promise<RegistrationRebuild> {
  const { env, l1, deposits, registrations } = deps
  const sipa = record.sipaAddress as Address
  const account = record.account as Address
  const nameHash = record.nameHash as Hex
  const wait = (ms: number, reason: string): RegistrationRebuild => ({ kind: "wait", ms, reason })

  // Account-scoped: the unlocked secret must derive THIS record's account.
  const bootstrap = deriveBootstrapKey(signDeps.masterSecret)
  const predicted = await l1.predictAccountAddress(env.factory, bootstrap.address as Address)
  if (!eqAddr(predicted, account))
    return wait(RESUME_TRANSIENT_RETRY_MS, "Another account is unlocked")

  // Counted before anything is spent; a strict-write failure aborts.
  await registrations.apply(sipa, { type: "retried" })

  // The record's own committed payment, never a fresh quote: the SIPA address commits to it.
  const committed = { fee: BigInt(record.fee), beneficiary: record.beneficiary as Address }
  const derivation = await deriveRecordedRegistrationSipa(
    signDeps.deriveRegistrationSipa,
    {
      owner: account,
      nameHash,
      l2Address: record.l2Address,
      fee: committed.fee,
      beneficiary: committed.beneficiary,
      masterSecret: signDeps.masterSecret,
    },
    record.sipaAddress as Address,
    signDeps.seededSipaSalt,
  )
  // A derivation that no longer lands at the recorded SIPA means the system iterated under the
  // record (new derivation scheme, redeployed stack). A clean record closes as replaced, and the
  // caller falls back to a fresh claim. A record money already touched holds for manual recovery:
  // funds follow the address.
  if (!eqAddr(derivation.sipaAddress, record.sipaAddress)) {
    const custodial =
      record.fundedAt !== undefined ||
      record.sweptAt !== undefined ||
      record.fundingTxHash !== undefined
    if (custodial) return wait(RESUME_TRANSIENT_RETRY_MS, "The address no longer derives")
    // Those flags are written by deposit detection, which only ever polls the record's CURRENT
    // SIPA — so a deposit sent to the address this record is about to be dropped for leaves no
    // trace on it, and the record reads as clean. Ask the chain before discarding: money at the
    // old address makes the record custodial no matter what the flags say. An unread balance is
    // no proof the address is empty, so the record holds for a read that can tell.
    const held = await bestEffort(
      "unknown",
      deposits.readBalance(record.sipaAddress as Address, env.feeToken as Address),
    )
    if (held === undefined || held > 0n)
      return wait(RESUME_TRANSIENT_RETRY_MS, "The address no longer derives")
    // Closed, not dropped: the old address stays recoverable on the registration route.
    await deps.close(record, { type: "replaced" })
    return { kind: "closed", outcome: "failed" }
  }
  if (signDeps.seedSipaDeposit)
    await bestEffort(
      "unknown",
      signDeps.seedSipaDeposit({
        sipaAddress: derivation.sipaAddress,
        messageSecret: derivation.sharedSecretSalt,
        recipientHash: derivation.recipientCommitment,
        origin: derivation.origin,
        recipientL2Address: record.l2Address,
        registrationFee: committed.fee,
      }),
    )

  let claim: NameClaimResponse
  try {
    claim = await signDeps.accountService.signDomain({ nameHash, userAddress: account })
  } catch (err) {
    if (isClaimAttemptsExhausted(err)) {
      await deps.close(record, { type: "closed", outcome: "failed" })
      return { kind: "closed", outcome: "failed" }
    }
    if (isNameReserved(err) || isNameBlocked(err)) {
      await deps.close(record, { type: "closed", outcome: "taken" })
      return { kind: "closed", outcome: "taken" }
    }
    return wait(retryDelayMs(err, RESUME_TRANSIENT_RETRY_MS), "The claim server did not answer")
  }

  // The re-issued quote must price the fee the address committed to: the sweep pays exactly that
  // fee and the controller refuses any other, so a payload carrying different terms cannot land.
  const quotedFee = claim.terms ? BigInt(claim.terms.fee) : await deposits.scheduleFee()
  if (quotedFee !== committed.fee) {
    logger.warn("[oxideRegistration] re-issued quote does not match the committed fee", {
      committed: committed.fee.toString(),
      quoted: quotedFee.toString(),
    })
    return wait(RESUME_TRANSIENT_RETRY_MS, "The quote no longer matches the address")
  }
  // The renewed claim is all a spent rail gets: nothing to publish.
  if (record.replaced?.broadcastSpent === true) return { kind: "spent" }

  const consentSig = await consentFor(
    signDeps.masterSecret,
    account,
    derivation,
    env,
    l1,
    signDeps.passkey,
  )
  const r1Install = await buildRegistrationR1Install(
    signDeps.masterSecret,
    account,
    env,
    signDeps.l1,
    signDeps.r1Key,
    signDeps.credentialId,
  )
  // The scalar re-derives from the master secret.
  if (signDeps.persistStealthScalar)
    await bestEffort("unknown", signDeps.persistStealthScalar(derivation.stealthScalar))
  return {
    kind: "payload",
    payload: assemblePayload(derivation, claim, consentSig, r1Install, bootstrap.address),
  }
}
