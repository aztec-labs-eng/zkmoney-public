import { Fr } from "@aztec/aztec.js/fields"
import { PASSKEY_RP_NAME } from "@obsidion/core/constants"
import type { SignInRoute } from "@obsidion/core/types"
import {
  DOMAIN_SEPARATORS,
  StoredAddressMismatchError,
  deriveKeyFromSecret,
  selectRecoveredMsk,
  type IStorageAdapter,
  type RecoveredCandidates,
} from "@obsidion/front-core"
import {
  BrowserPasskeyCeremony,
  type DevicePosture,
  NoPrfError,
  type PasskeyAssertResult,
  type PasskeyAttachment,
  type PasskeyCeremony,
  type PasskeyHint,
  type PasskeyRequestScope,
  type PhoneReach,
  type PrfCandidates,
  RotatedCredentialError,
  candidatePubkeys,
  candidatesFrom,
  currentDevicePosture,
  currentMisreportsCrossDevice,
  currentTrustsAttachmentLabel,
  currentPhoneReach,
  impliedKeyTransports,
  isPhysicalOnly,
  preferredSlot,
  recordPasskeyEnvironment,
  recoverPubkeyFromAssertions,
  runPasskeyAssertion,
  runPasskeyCreation,
  decodeUserHandle,
} from "@obsidion/passkey-web"
import {
  clearActiveCredentialId,
  clearActiveStorage,
  clearCachedMsk,
  getActiveCredentialId,
  getActiveStorageId,
  readCachedMsk,
  readCommittedSession,
  readSessionTuple,
  setActiveCredentialId,
  setActiveStorageId,
  storageIdFromSecret,
  withSessionLock,
  writeCachedMsk,
  writeSessionTuple,
  type CachedMsk,
} from "../storage/activeStorage"
import { walletStorage } from "../storage/walletStorage"
import type { HandoffMaterial } from "../storage/handoffMaterial"
import { holdsAccountRecords } from "../storage/WebStorageAdapter"
import {
  type AlphaAuthProvider,
  type AlphaAuthService,
  type CommitSecretInput,
  type PrfSlot,
  type RecoverPasskeyResult,
  type RecoveryMetadata,
  WebAuthnAlphaAuthProvider,
  deriveMskFromPrfOutput,
} from "@obsidion/sdk"
import { scopeOfStatus } from "./passkeyAttemptScope"
import { PASSKEY_ENVIRONMENT_KEY } from "./passkeyEnvironmentKey"
import { NoPasskeySessionError, SessionChangedError } from "./sessionErrors"
import { UNASKED_PASSKEY_MESSAGE } from "./unaskedPasskey"
import { type SigningSteering, makeWebauthnSignFn } from "./webauthnSigning"
import { WebPasskeyIdentityMap } from "./WebPasskeyIdentityMap"

/** The package's PRF candidates as the field elements the wallet's anchors compare. */
const toFrCandidates = (prf: PrfCandidates): RecoverPasskeyResult["candidates"] => ({
  first: prf.first && deriveMskFromPrfOutput(prf.first),
  second: prf.second && deriveMskFromPrfOutput(prf.second),
})

/**
 * Which passkey a recovery ceremony asks for; `discover` leaves the browser's list open. `signal`
 * ends the assertion — sheet, queue and retries — wherever it is. `own` is the attempt the requests
 * are reported as.
 */
export type RecoverPasskeyRequest = {
  credentialId?: string
  discover?: boolean
  signal?: AbortSignal
  own?: PasskeyRequestScope
}

/** Which device answered and its class, kept beside a recovery result the plain result drops. */
export type Observation = { credentialId: string; attachment?: PasskeyAttachment }

/** A recovery result plus the observation the screens read to diagnose a miss. */
export type WebRecoverResult = RecoverPasskeyResult & { observed?: Observation }

/**
 * What a record-anchored mismatch means for the UI. `wrong-key` is a certain wrong key on this
 * computer — a `this-device` answer whose bound slot was evaluated and still did not derive the
 * recorded address; `not-reproduced` is the weaker "this attempt didn't open it", the copy a re-run
 * or another device may still fix.
 */
export type MismatchVerdict = "wrong-key" | "not-reproduced"

/** An unlock ceremony in flight, with the signal that decides who may join it. */
type UnlockFlight = { promise: Promise<void>; signal?: AbortSignal }

/** A `StoredAddressMismatchError` the wallet tagged with which verdict the screens should render. */
export const mismatchVerdictOf = (err: unknown): MismatchVerdict | undefined =>
  err instanceof StoredAddressMismatchError
    ? (err as { verdict?: MismatchVerdict }).verdict
    : undefined

/**
 * A recovery whose public key is still one of two. It carries what the anchors need to name the
 * master key, and `settle` finishes it: with the candidate the account confirmed, or with none,
 * which runs the second assertion — one `attempt` can end, sheet and retries included. Only a
 * settled result carries a signer.
 */
export type UnsettledRecovery = RecoveredCandidates & {
  credentialId: string
  /** The two keys the sign-in signature recovers to, as 64-byte `x||y` hex. Exactly one is the passkey's. */
  pubkeyCandidates: readonly string[]
  /** Which device answered the first assertion; a key-settling second one never overwrites it. */
  observed?: Observation
  settle: (pubkey?: string, attempt?: AbortSignal) => Promise<WebRecoverResult>
}

export type BeginRecoveryResult = WebRecoverResult | UnsettledRecovery

export const isUnsettled = (result: BeginRecoveryResult): result is UnsettledRecovery =>
  "settle" in result

/** The assertion succeeded, but the hinted key is not one its signature recovers to, or not this browser's record's. */
export class HintedKeyMismatchError extends Error {
  constructor() {
    super("The hinted passkey key does not match the passkey that signed")
    this.name = "HintedKeyMismatchError"
  }
}

const randomChallenge = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32)))

/** The stored account as a restore compares it: who signs for it and where it lives. */
export type StoredAccountSnapshot =
  | { kind: "webauthn"; credentialId: string; pubkey: string; address: string }
  | { kind: "other" }

const hexBytes = (hex: string) => new Uint8Array(Buffer.from(hex.replace(/^0x/i, ""), "hex"))
const sameHex = (a: string, b: string) =>
  a.replace(/^0x/i, "").toLowerCase() === b.replace(/^0x/i, "").toLowerCase()
export type WebAlphaAuthServiceOptions = {
  storage: IStorageAdapter
  /** Production: `"auth.zk.money"` (via related-origins). Dev/e2e: `"localhost"`. */
  rpId: string
  rpName?: string
  ceremony?: PasskeyCeremony
  posture?: () => DevicePosture
  /** Whether the browser labels a cross-device answer as its own; tests fix it, production reads
   * the user agent. */
  misreportsCrossDevice?: () => boolean
  /** Whether the browser reports truthfully which device answered, so a refused sign-up may name
   * it; tests fix it, production reads the user agent. */
  trustsAttachmentLabel?: () => boolean
  /** `null` sends laptop ceremonies no steering hints (the e2e build's virtual authenticators). */
  laptopHints?: null
  /** Provider ids admitted beyond the measured set; only the e2e build passes any. */
  extraProviders?: readonly string[]
}

/**
 * Browser `AlphaAuthService`: passkey signing + PRF-derived MSK.
 *
 * The ceremony sequence and every rule in it (which device may answer, which slot binds, the
 * backup, PRF and provider gates) come from `@obsidion/passkey-web`; this service adds what only
 * the wallet knows: its record of the credential, the anchors and the cache.
 *
 * The MSK is held in memory and, once committed with its passkey, cached in the clear in this
 * origin's local storage beside the session pointers (an accepted risk: anyone with the browser
 * profile reads it). A cold session restores it from that cache without a ceremony, but only after
 * the key is proved against the stored account: the wallet injects an address deriver and an
 * account reader, and the cached key must re-derive the storage id, derive the recorded address,
 * and match the stored account's passkey. A cache that fails a check is removed with the pointers
 * and the service stays locked; a check the wallet cannot run yet leaves the cache for the next
 * read. Locked, the session re-derives from the passkey (`beginRecovery` → the caller settles the
 * key, then verifies the address it derives with it → `commitSecret`). `getSecretKey()` returning
 * `undefined` means "locked".
 * Sign-out removes the cache with the pointers.
 */
export class WebAlphaAuthService implements AlphaAuthService {
  private readonly ceremony: PasskeyCeremony
  private readonly identityMap: WebPasskeyIdentityMap
  readonly rpId: string
  private readonly rpName: string
  private readonly posture: () => DevicePosture
  private readonly misreportsCrossDevice: () => boolean
  private readonly trustsAttachmentLabel: () => boolean
  private readonly laptopHints: null | undefined
  private readonly extraProviders: readonly string[] | undefined
  private readonly probeEnabled: boolean

  private msk?: Fr
  private authProvider?: AlphaAuthProvider
  /** The in-flight unlock and what it is for: a later call joins only when the route matches and the
   *  owner's signal is still live, otherwise it starts its own. */
  private unlocking?: UnlockFlight
  private restoring?: Promise<void>
  /** Set by a sign-out's fence: no restore until the next commit, whatever the store still holds. */
  private restoreSuppressed = false
  /** Advances on every commit and clear, so a restore that awaited across one installs nothing. */
  private epoch = 0
  /** Advances on every sign-out, so a commit that awaited across one installs nothing. */
  private fence = 0
  /** Session writes started, and those not yet settled: a restore that saw either move stands down. */
  private sessionWrites = 0
  private sessionWritesInFlight = 0
  /** Set once a commit moves the session under record stores loaded for another account. */
  private staleRecords = false
  private deriveAddress?: (msk: Fr, pubkeyHex: string) => Promise<string>
  private readAccount?: () => Promise<StoredAccountSnapshot | null>
  private readonly derivedKeys = new Map<string, Uint8Array>()

  constructor(options: WebAlphaAuthServiceOptions) {
    this.ceremony = options.ceremony ?? new BrowserPasskeyCeremony()
    this.identityMap = new WebPasskeyIdentityMap(options.storage, options.rpId)
    this.rpId = options.rpId
    this.rpName = options.rpName ?? PASSKEY_RP_NAME
    this.posture = options.posture ?? currentDevicePosture
    this.misreportsCrossDevice = options.misreportsCrossDevice ?? currentMisreportsCrossDevice
    this.trustsAttachmentLabel = options.trustsAttachmentLabel ?? currentTrustsAttachmentLabel
    this.laptopHints = options.laptopHints
    this.extraProviders = options.extraProviders
    this.probeEnabled = options.laptopHints !== null
  }

  /**
   * The UI hints for a creation route: a phone opens the sheet on the QR flow, a security key names
   * itself so a manager's extension stands aside. `creationHintsFor` adds the security-key hint where
   * it must. A configuration that sends no hints (the browser tests) keeps sending none.
   */
  private laptopHintsForRoute(route?: SignInRoute): readonly PasskeyHint[] | null | undefined {
    if (this.laptopHints === null) return null
    if (route === "phone") return ["hybrid"]
    if (route === "security-key") return ["security-key"]
    return undefined
  }

  /** The steering a sign-in assertion sends: none, except the e2e build's null (no hints at all). */
  private signInHints(): null | undefined {
    return this.laptopHints === null ? null : undefined
  }

  /** Credential behind each provider, persisted as the session's passkey only once its MSK commits. */
  private readonly providerCredential = new WeakMap<AlphaAuthProvider, string>()

  /**
   * What this session's assertions implied about each credential's authenticator: a hardware
   * key's physical transports, or `refused` after the browser turned down a request steered by
   * that inference. Persisted beside the record where the record has no creation list.
   */
  private readonly implied = new Map<string, readonly string[] | "refused">()

  /**
   * Learn from any assertion this credential answered; a key's transports are offered to the
   * record. Never awaited by a ceremony: a slow or refused write costs the hint, not the sign-in.
   * `owns` is the assertion's ownership: a cancelled attempt teaches nothing, in session or on disk.
   */
  private async learn(
    evidence: {
      credentialId: string
      authenticatorAttachment?: PasskeyAttachment
      backupEligible?: boolean
    },
    owns?: () => boolean,
  ): Promise<void> {
    const transports = impliedKeyTransports(evidence)
    if (!transports) return
    if (owns && !owns()) return
    this.implied.set(evidence.credentialId, transports)
    await this.identityMap
      .setInferredTransports(evidence.credentialId, transports, owns)
      .catch((err) => console.warn("passkey transports not recorded", err))
  }

  /**
   * The transports a hardware key is reached over, when this browser knows the credential to be
   * one. A creation list decides by itself: a hardware key's is returned, a synced passkey's
   * nothing, so the local copy can answer. Without one, what this browser inferred, unless the
   * browser refused it.
   */
  private async keyTransports(
    credentialId: string,
  ): Promise<{ transports: readonly string[]; inferred: boolean } | undefined> {
    const record = await this.identityMap.get(credentialId)
    if (record?.transports) {
      return isPhysicalOnly(record.transports)
        ? { transports: record.transports, inferred: false }
        : undefined
    }
    const implied = this.implied.get(credentialId)
    if (implied === "refused") return undefined
    const transports = record?.inferredTransports ?? implied
    return transports ? { transports, inferred: true } : undefined
  }

  /** Whether this browser knows the credential to be a hardware key; a synced passkey, and a
   *  credential it never saw, are not. */
  private async knownSecurityKey(credentialId: string): Promise<boolean> {
    return (await this.keyTransports(credentialId)) !== undefined
  }

  /** Steering for a signature: the sheet opens on the hardware key a credential is known to be. */
  private steeringFor(credentialId: string): SigningSteering {
    return {
      transports: () => this.keyTransports(credentialId),
      learned: (assertion) => void this.learn(assertion),
      refused: () => {
        this.implied.set(credentialId, "refused")
        void this.identityMap
          .setInferredTransports(credentialId, undefined)
          .catch((err) => console.warn("passkey transports not cleared", err))
      },
    }
  }

  /** The wallet's address derivation from a master key and a signing key; a cache restore proves the key with it. */
  setAddressDeriver(derive: (msk: Fr, pubkeyHex: string) => Promise<string>): void {
    this.deriveAddress = derive
  }

  /** The stored account's signer and address; a cache restore checks the key against it. */
  setAccountReader(read: () => Promise<StoredAccountSnapshot | null>): void {
    this.readAccount = read
  }

  /** A signing provider for a known passkey; no ceremony, so its first signature costs a prompt. */
  providerFor(passkey: { credentialId: string; pubkeyHex: string }): AlphaAuthProvider {
    return this.buildProvider(hexBytes(passkey.pubkeyHex), passkey.credentialId)
  }

  /**
   * The ceremony a caller's requests are reported as. Without a scope they belong to the newest
   * passkey attempt open when each request is made.
   */
  private asking(own?: PasskeyRequestScope): PasskeyCeremony {
    return own ? own(this.ceremony) : this.ceremony
  }

  /**
   * One PRF-reading assertion over `challenge`. On a laptop the browser's own account chooser
   * decides which device answers — this computer's synced copy, a phone over QR, or a security key —
   * so the assertion admits the local copy (`localAllowed`) and sends no transport restriction; a
   * `platform` or a cross-device answer is accepted either way, and the anchors settle it.
   * `securityKey` names a hardware key in the hints, so the sheet keeps that row and a password
   * manager's extension stands aside; for anything else the extension may answer. `signal` can end
   * it.
   */
  private async assertForRecovery(
    posture: DevicePosture,
    challenge: Buffer,
    credentialIds?: string[],
    transports?: readonly string[],
    securityKey = false,
    signal?: AbortSignal,
    own?: PasskeyRequestScope,
  ): Promise<PasskeyAssertResult> {
    const localAllowed = posture === "laptop"
    return runPasskeyAssertion(this.asking(own), {
      posture,
      rpId: this.rpId,
      challenge: new Uint8Array(challenge),
      credentialIds,
      transports,
      laptopHints: this.signInHints(),
      misreportsCrossDevice: this.misreportsCrossDevice(),
      localAllowed,
      securityKey,
      ...(signal ? { signal } : {}),
      observe: async ({ result }) => {
        void this.learn(result, () => !signal?.aborted)
        // Assertions carry no provider id; the creation record does, when this browser made the
        // key. The record waits on Client Hints and never holds the ceremony.
        const known = await this.identityMap.get(result.credentialId)
        void recordPasskeyEnvironment(
          { aaguid: known?.prfAaguid, posture },
          PASSKEY_ENVIRONMENT_KEY,
        )
      },
    })
  }

  /** Which device answered and its class, for a screen diagnosing a miss. */
  private observationOf(assertion: PasskeyAssertResult): Observation {
    return { credentialId: assertion.credentialId, attachment: assertion.authenticatorAttachment }
  }

  /** This browser's record for the credential. A rotated signing credential never derives the key. */
  private async rootRecord(credentialId: string): Promise<RecoveryMetadata | undefined> {
    const record = await this.identityMap.get(credentialId)
    if (record && !record.isMskRoot) throw new RotatedCredentialError()
    return record
  }

  /**
   * Whether this browser can hand a ceremony to a phone. Asked by the screens on laptop posture
   * before the phone explainer; the ceremonies themselves never ask. Off under the e2e seam, whose
   * virtual authenticators report no hybrid transport.
   */
  async probePhoneReach(): Promise<PhoneReach> {
    if (!this.probeEnabled) return "unknown"
    return currentPhoneReach(this.posture())
  }

  private recovered(
    assertion: PasskeyAssertResult,
    candidates: RecoverPasskeyResult["candidates"],
    pubkey: Uint8Array,
    record: RecoveryMetadata | undefined,
  ): WebRecoverResult {
    const userHandle = decodeUserHandle(assertion.userHandle)
    return {
      authProvider: this.buildProvider(pubkey, assertion.credentialId),
      credentialId: assertion.credentialId,
      pubkey: Buffer.from(pubkey).toString("hex"),
      candidates,
      preferredSlot: preferredSlot(assertion.authenticatorAttachment, record?.prfSlot),
      hasPersistedSlot: record?.prfSlot !== undefined,
      candidateSource: "webauthn",
      expectedAddress: record?.l2Address,
      authenticatorType: record?.authenticatorType ?? "platform",
      ...(userHandle ? { userHandle } : {}),
      // The device that answered, which the result otherwise drops; a screen reads it to diagnose a
      // miss. On a settled key it names the first assertion, never the salt-free second one.
      observed: this.observationOf(assertion),
    }
  }

  private buildProvider(pubkey: Uint8Array, credentialId: string): WebAuthnAlphaAuthProvider {
    const buf = Buffer.from(pubkey)
    const sign = makeWebauthnSignFn(
      this.ceremony,
      this.rpId,
      credentialId,
      pubkey,
      this.steeringFor(credentialId),
    )
    const provider = new WebAuthnAlphaAuthProvider(buf.subarray(0, 32), buf.subarray(32, 64), sign)
    this.providerCredential.set(provider, credentialId)
    return provider
  }

  async getAuthProvider(): Promise<AlphaAuthProvider | undefined> {
    if (!this.msk) await this.restoreFromCache()
    if (this.authProvider) return this.authProvider
    const root = await this.identityMap.getMskRoot()
    if (!root) return undefined
    this.authProvider = this.buildProvider(
      new Uint8Array(Buffer.from(root.pubkey, "hex")),
      root.credentialId,
    )
    return this.authProvider
  }

  async getSecretKey(): Promise<Fr | undefined> {
    if (!this.msk) await this.restoreFromCache()
    return this.msk
  }

  /**
   * Install the cached key without a ceremony, once every check passes. Runs only while locked and
   * only when the wallet has injected a deriver and an account reader; one restore at a time.
   */
  private restoreFromCache(): Promise<void> {
    if (this.msk || this.restoreSuppressed || !this.deriveAddress || !this.readAccount) {
      return Promise.resolve()
    }
    if (!this.restoring) {
      const run = this.runRestore().finally(() => {
        if (this.restoring === run) this.restoring = undefined
      })
      this.restoring = run
    }
    return this.restoring
  }

  private async runRestore(): Promise<void> {
    // Saved values only, and none while a session write is in flight: it may yet fail.
    if (this.sessionWritesInFlight > 0) return
    const { cache, storageId, credentialId } = readCommittedSession()
    if (!cache) return
    const epoch = this.epoch
    const writes = this.sessionWrites
    const proof = await this.proveCache(cache, storageId, credentialId)
    // A commit or a sign-out landed while this restore awaited: it owns the session now.
    if (this.epoch !== epoch) return
    if (this.sessionWritesInFlight > 0 || this.sessionWrites !== writes) return
    if (proof.kind === "unknown") return
    if (proof.kind === "invalid") {
      await this.dropInvalidCache(cache, storageId, credentialId)
      return
    }
    this.msk = proof.msk
    this.derivedKeys.clear()
    this.authProvider = this.buildProvider(hexBytes(proof.record.pubkey), cache.credentialId)
  }

  /**
   * Drop a cache that failed its proof. When the failed tuple names the active session
   * the whole session goes (the account it points at is not this key's); otherwise only the blob
   * goes. Only the active tab opens the wallet database, so a plain removal is enough — no
   * cross-tab compare-and-remove.
   */
  private dropInvalidCache(
    cache: CachedMsk,
    storageId: string | null,
    credentialId: string | null,
  ): Promise<void> {
    // Saved before the restore settles, so nothing after it reads the rejected session.
    if (storageId && cache.storageId === storageId && cache.credentialId === credentialId) {
      return walletStorage.batch(() => clearActiveStorage())
    }
    // A blob for another session, or one with no session at all: the blob goes, nothing else.
    return walletStorage.batch(() => clearCachedMsk())
  }

  /**
   * Whether the cache is this session's key for this browser's account. `unknown` is a check that
   * could not run (the wallet threw), which leaves the cache in place for the next attempt.
   */
  private async proveCache(
    cache: CachedMsk,
    storageId: string | null,
    credentialId: string | null,
  ): Promise<
    { kind: "valid"; msk: Fr; record: RecoveryMetadata } | { kind: "invalid" } | { kind: "unknown" }
  > {
    const { deriveAddress, readAccount } = this
    if (!deriveAddress || !readAccount) return { kind: "unknown" }
    if (!storageId || storageId !== cache.storageId || credentialId !== cache.credentialId) {
      return { kind: "invalid" }
    }
    const record = await this.identityMap.get(cache.credentialId)
    if (!record?.l2Address || !record.isMskRoot) return { kind: "invalid" }
    let msk: Fr
    try {
      msk = Fr.fromHexString(cache.msk)
    } catch {
      return { kind: "invalid" }
    }
    if ((await storageIdFromSecret(new Uint8Array(msk.toBuffer()))) !== cache.storageId) {
      return { kind: "invalid" }
    }
    let snapshot: StoredAccountSnapshot | null
    let derived: string
    try {
      snapshot = await readAccount()
      derived = await deriveAddress(msk, record.pubkey)
    } catch {
      return { kind: "unknown" }
    }
    if (
      snapshot?.kind !== "webauthn" ||
      snapshot.credentialId !== cache.credentialId ||
      !sameHex(snapshot.pubkey, record.pubkey) ||
      !sameHex(derived, record.l2Address) ||
      !sameHex(derived, snapshot.address)
    ) {
      return { kind: "invalid" }
    }
    return { kind: "valid", msk, record }
  }

  async getDerivedKey(domain: string): Promise<Uint8Array> {
    if (DOMAIN_SEPARATORS[domain] === undefined) {
      throw new Error(`Unknown derived-key domain: ${domain}`)
    }
    const hit = this.derivedKeys.get(domain)
    if (hit) return hit
    if (!this.msk) {
      throw new Error("MSK is not available; unlock (recover + commit) before deriving keys")
    }
    const key = await deriveKeyFromSecret(this.msk, domain)
    this.derivedKeys.set(domain, key)
    return key
  }

  async createPasskey(
    accountName: string,
    updateStatus?: (status: string) => void,
    opts?: { mode?: "combined" | "platform" | "security-key"; route?: SignInRoute },
  ): Promise<{
    authProvider: AlphaAuthProvider
    credentialId: string
    pubkey: string
    secretKey: Fr
    prfSlot?: PrfSlot
    prfAaguid?: string
    authenticatorType?: "platform" | "security-key"
    transports?: readonly string[]
  }> {
    const posture = this.posture()
    // The screen's attempt rides on the status callback front-core hands over; see
    // `passkeyAttemptScope`.
    const asking = this.asking(scopeOfStatus(updateStatus))
    updateStatus?.("Creating passkey…")
    // `securityKey` from the driver is deliberately not persisted: every record this wallet writes
    // says "platform". Storing the real class turns on front-core's no-anchor commit branch and the
    // no-backup acknowledgement, which land together with the screen that warns the user.
    const { created, slot, prfOutput } = await runPasskeyCreation(asking, {
      posture,
      rpId: this.rpId,
      rpName: this.rpName,
      userName: accountName,
      laptopHints: this.laptopHintsForRoute(opts?.route),
      extraProviders: this.extraProviders,
      misreportsCrossDevice: this.misreportsCrossDevice(),
      attachmentLabelTrusted: this.trustsAttachmentLabel(),
      challengeForChained: async () => {
        updateStatus?.("Reading key material…")
        return new Uint8Array(randomChallenge())
      },
      observe: ({ phase, result }) => {
        // Only the creation response carries the provider id and the route as the browser reported
        // it; a chained assertion must not overwrite them. The record waits on Client Hints and
        // never holds the ceremony.
        if (phase === "created") {
          void recordPasskeyEnvironment(
            {
              aaguid: result.aaguid,
              created: {
                attachment: result.authenticatorAttachment,
                transports: result.transports,
              },
              posture,
            },
            PASSKEY_ENVIRONMENT_KEY,
          )
        }
      },
    })
    const secretKey = deriveMskFromPrfOutput(prfOutput)
    const authProvider = this.buildProvider(created.pubkey, created.credentialId)

    return {
      authProvider,
      credentialId: created.credentialId,
      pubkey: Buffer.from(created.pubkey).toString("hex"),
      secretKey,
      prfSlot: slot,
      prfAaguid: created.aaguid,
      authenticatorType: "platform",
      transports: created.transports,
    }
  }

  /**
   * The credential this origin derives its wallet key from, if one was recorded: the one that
   * opened `l2Address` when given, so a browser with several roots never pins another account's.
   */
  async rootCredentialId(l2Address?: string): Promise<string | undefined> {
    return (await this.identityMap.getMskRoot(l2Address))?.credentialId
  }

  /** `stillOwns` is checked under the map's lock, so a cancel that landed while waiting writes nothing. */
  async recordRecoveryMetadata(meta: RecoveryMetadata, stillOwns?: () => boolean): Promise<void> {
    await this.identityMap.upsert(meta, stillOwns)
    const implied = this.implied.get(meta.credentialId)
    if (!implied || implied === "refused") return
    await this.identityMap
      .setInferredTransports(meta.credentialId, implied, stillOwns)
      .catch((err) => console.warn("passkey transports not recorded", err))
  }

  /**
   * Nothing is held or pointed at until every value the switch needs exists. The pointers go down
   * first, so every write that follows lands under the new session, and the key is installed only
   * once they are there. A store that refuses them refuses everything, so that throws and the
   * previous session stands. The cached key is the one part that may be missing and still leave a
   * usable session: without it a reload asks for the passkey, which the wallet already knows how
   * to do. A commit without a passkey (the demo seed) caches nothing and removes a passkey
   * session's cache and credential pointer. False, with nothing written, when `stillOwns` says the
   * caller's operation ended while the storage id was being derived.
   */
  commitSecret(input: CommitSecretInput): Promise<void>
  commitSecret(input: CommitSecretInput, stillOwns: () => boolean): Promise<boolean>
  async commitSecret(input: CommitSecretInput, stillOwns?: () => boolean): Promise<boolean | void> {
    return this.commit(input, stillOwns)
  }

  /** Whether this session's key is cached, so the next reload opens without a passkey prompt. */
  keyCached(): boolean {
    const id = getActiveStorageId()
    return id !== null && readCachedMsk()?.storageId === id
  }

  /**
   * Whether this page's record stores may still hold another account's records: a commit moved
   * the session away from an active one, or onto an account this browser already held records
   * for. The stores load once per page, so only a reload clears it.
   */
  recordsStale(): boolean {
    return this.staleRecords
  }

  /** `stillOwns` lets a ceremony that outlived its session (a commit or clear landed while its
   * prompt was open) write nothing. The tuple is written under the session lock, so no other
   * commit or sign-out on this page runs between reading the session it replaces and saving. */
  private async commit(input: CommitSecretInput, stillOwns?: () => boolean): Promise<boolean> {
    // Read before the first await: a sign-out during the derivation or the lock wait fences it.
    const fence = this.fence
    const storageId = await storageIdFromSecret(new Uint8Array(input.secretKey.toBuffer()))
    const credentialId = this.providerCredential.get(input.authProvider)
    return withSessionLock(async () => {
      if (this.fence !== fence) return false
      if (stillOwns && !stillOwns()) return false
      const held = getActiveStorageId()
      const replaced = readSessionTuple()
      // Read before anything is written under the new account, which the sign-in does right after.
      const leavesStale = held !== storageId && (held !== null || holdsAccountRecords(storageId))
      // Pointers and cache as one transaction: a rejection leaves the stored session as it was.
      // Restores stand down until this settles, cleanup included.
      this.sessionWrites++
      this.sessionWritesInFlight++
      try {
        await walletStorage.batch(() => {
          setActiveStorageId(storageId)
          if (credentialId) {
            setActiveCredentialId(credentialId)
            writeCachedMsk({ v: 1, storageId, credentialId, msk: input.secretKey.toString() })
          } else {
            clearActiveCredentialId()
            clearCachedMsk()
          }
        })
        // A sign-out queued its removals behind this write; they undo it.
        if (this.fence !== fence) return false
        if (stillOwns && !stillOwns()) {
          // Cancelled while saving. Still inside the session lock, so no newer commit has saved
          // since: put back the session this one replaced. If that fails, nothing restores the
          // cancelled one.
          try {
            await walletStorage.batch(() => writeSessionTuple(replaced))
          } catch (err) {
            this.clear()
            this.restoreSuppressed = true
            throw err
          }
          return false
        }

        if (leavesStale) this.staleRecords = true
        this.epoch++
        this.restoreSuppressed = false
        this.msk = input.secretKey
        this.authProvider = input.authProvider
        this.derivedKeys.clear()
        return true
      } finally {
        this.sessionWritesInFlight--
      }
    })
  }

  isUnlocked(): boolean {
    return this.msk !== undefined
  }

  /**
   * Warm-session unlock: re-derive the MSK from the session's passkey (one assertion), verify the
   * candidate against this browser's own record with `deriveAddress`, and commit it. The local
   * identity map + OPFS PXE store already hold the account, so — unlike /enter's cross-device
   * recovery — no L1 lookup or L2 re-register is needed; only the in-memory MSK was lost to the
   * refresh. Bound to this tab's session credential: a session with no record for it goes through
   * /enter, never to whichever root is newest on the device. No-op when already unlocked, and a
   * cache that proves out now costs no ceremony. A session that changed while the prompt was open
   * (a commit or sign-out here, a logout or account switch elsewhere) keeps the result out:
   * `SessionChangedError`, and whoever changed it owns the tab.
   */
  async unlock(
    deriveAddress: (msk: Fr, pubkeyHex: string) => Promise<string>,
    options?: { signal?: AbortSignal; own?: PasskeyRequestScope },
  ): Promise<void> {
    await this.restoreFromCache()
    if (this.msk) return
    // Concurrent callers share one ceremony. The unlock gate, a `/link` claim and a re-tapped
    // button can all land within the same window, and a second passkey request while the first is up
    // is exactly what the browser rejects with "A request is already pending." A later call joins the
    // flight only while its owner's signal is still live; an owner that has gone away starts its own.
    // The shared ceremony is the flight owner's, so its attempt is the one the requests are
    // reported as.
    const { signal, own } = options ?? {}
    const current = this.unlocking
    if (current && !current.signal?.aborted) return current.promise
    const flight: UnlockFlight = {
      signal,
      promise: this.runUnlock(deriveAddress, signal, own).finally(() => {
        if (this.unlocking === flight) this.unlocking = undefined
      }),
    }
    this.unlocking = flight
    return flight.promise
  }

  private async runUnlock(
    deriveAddress: (msk: Fr, pubkeyHex: string) => Promise<string>,
    signal?: AbortSignal,
    own?: PasskeyRequestScope,
  ): Promise<void> {
    const storageId = getActiveStorageId()
    const credentialId = getActiveCredentialId()
    const epoch = this.epoch
    const record = credentialId ? await this.identityMap.get(credentialId) : undefined
    if (!storageId || !credentialId || !record?.l2Address) throw new NoPasskeySessionError()
    const stillOwns = () => this.epoch === epoch && !signal?.aborted
    signal?.throwIfAborted()
    const recovered = await this.recoverPasskey({ credentialId, signal, ...(own ? { own } : {}) })
    let msk: Fr
    try {
      msk = await selectRecoveredMsk(recovered, (candidate) =>
        deriveAddress(candidate, recovered.pubkey),
      )
    } catch (err) {
      throw this.tagRecordMismatch(err, recovered)
    }
    signal?.throwIfAborted()
    const committed = await this.commit(
      { secretKey: msk, authProvider: recovered.authProvider },
      stillOwns,
    )
    if (!committed) throw new SessionChangedError()
  }

  /**
   * Which verdict a mismatch against this browser's record is. `wrong-key` — a certain wrong key on
   * this computer — needs this computer's own copy to have answered (a `platform` attachment) and the
   * record's bound slot to have been evaluated: `selectRecoveredMsk` skips an absent candidate and
   * throws the same mismatch, so a one-slot answer proves nothing. Anything else is the weaker
   * `not-reproduced`.
   */
  mismatchVerdict(recovered: WebRecoverResult): MismatchVerdict {
    const boundSlotEvaluated =
      recovered.hasPersistedSlot && recovered.candidates[recovered.preferredSlot] !== undefined
    return this.answeredLocally(recovered.observed?.attachment) && boundSlotEvaluated
      ? "wrong-key"
      : "not-reproduced"
  }

  /** Whether this computer's own copy answered: a `platform` attachment on a laptop, not another device. */
  answeredLocally(attachment: PasskeyAttachment | undefined): boolean {
    return this.posture() === "laptop" && attachment === "platform"
  }

  /**
   * A mismatch against a record we hold: decide the verdict and tag the error so the screen renders
   * the right card. Any other error passes through untouched.
   */
  private tagRecordMismatch(err: unknown, recovered: WebRecoverResult): unknown {
    if (!(err instanceof StoredAddressMismatchError)) return err
    return Object.assign(err, { verdict: this.mismatchVerdict(recovered) })
  }

  /** Attach which device answered to an early refusal so the screen can diagnose it. */
  private withObservation(err: unknown, assertion: PasskeyAssertResult): unknown {
    const observed = this.observationOf(assertion)
    return typeof err === "object" && err ? Object.assign(err, { observed }) : err
  }

  /**
   * One assertion reads both PRF slots. Nothing is committed here: the caller derives each
   * candidate's address and lets an anchor pick (`selectRecoveredMsk`, or the onboarding resolver
   * on a fresh browser). This browser's own record is checked before the package's gates: a rotated
   * credential is refused whatever its assertion carried.
   *
   * With a record for the credential the result is settled: the record names the key. With no
   * record the result is unsettled: the signature recovers to two keys, and `settle` takes the one
   * a caller can name (a record elsewhere, the L1 account's installed key) or runs a second
   * assertion over another random challenge, which only one of the two keys can also have signed.
   */
  async beginRecovery(request?: string | RecoverPasskeyRequest): Promise<BeginRecoveryResult> {
    const posture = this.posture()
    const asked = typeof request === "string" ? { credentialId: request } : request
    // A recorded root passkey is named to the authenticator, so the browser never asks the user
    // to pick one. A discoverable request, and a fresh device (no record), leave the list open, so
    // the browser's sheet offers every passkey for the relying party.
    const rootId = asked?.discover
      ? undefined
      : asked?.credentialId ?? (await this.identityMap.getMskRoot())?.credentialId
    // The record for that credential, when this browser holds one: what it says about reaching the
    // authenticator is what steers the sheet. A credential this browser never saw sends nothing.
    const known = rootId ? await this.identityMap.get(rootId) : undefined
    const assertion = await this.assertForRecovery(
      posture,
      randomChallenge(),
      rootId ? [rootId] : undefined,
      known?.transports,
      rootId ? await this.knownSecurityKey(rootId) : false,
      asked?.signal,
      asked?.own,
    )
    const record = await this.rootRecord(assertion.credentialId)
    // The sheet was held to the recorded credential; an answer from any other is not the session's.
    if (known && !record) throw new Error(UNASKED_PASSKEY_MESSAGE)
    let candidates: RecoverPasskeyResult["candidates"]
    try {
      candidates = toFrCandidates(candidatesFrom(assertion))
    } catch (err) {
      // The observation rides the error so the screen can diagnose the miss.
      throw this.withObservation(err, assertion)
    }

    const pubkeyCandidates = await candidatePubkeys(assertion)
    if (record) {
      // A record whose key the signature cannot have come from is another credential's.
      if (!pubkeyCandidates.includes(record.pubkey.toLowerCase()))
        throw new RotatedCredentialError()
      return this.recovered(assertion, candidates, hexBytes(record.pubkey), record)
    }

    return {
      candidates,
      preferredSlot: preferredSlot(assertion.authenticatorAttachment, undefined),
      expectedAddress: undefined,
      candidateSource: "webauthn",
      authenticatorType: "platform",
      credentialId: assertion.credentialId,
      pubkeyCandidates,
      observed: this.observationOf(assertion),
      settle: async (pubkey?: string, attempt?: AbortSignal) => {
        if (pubkey !== undefined) {
          const wanted = pubkey.toLowerCase().replace(/^0x/, "")
          if (!pubkeyCandidates.includes(wanted)) {
            throw new Error("That key is not a candidate of this sign-in's signature")
          }
          return this.recovered(assertion, candidates, hexBytes(wanted), undefined)
        }
        // The second assertion signs another random challenge, so the two signatures share exactly
        // one recovered key. It sends no salts and is deliberately left unsteered and unchecked: a
        // laptop holding a synced copy answers it on the spot, where demanding the phone a second
        // time refuses an answer that was never going to be wrong.
        const second = await this.asking(asked?.own).assert({
          rpId: this.rpId,
          challenge: new Uint8Array(randomChallenge()),
          credentialIds: [assertion.credentialId],
          ...(attempt ? { signal: attempt } : {}),
        })
        const recoveredKey = await recoverPubkeyFromAssertions(assertion, second)
        return this.recovered(assertion, candidates, recoveredKey, undefined)
      },
    }
  }

  /** `beginRecovery`, settled by the second assertion when the key is not known. */
  async recoverPasskey(request?: string | RecoverPasskeyRequest): Promise<WebRecoverResult> {
    const begun = await this.beginRecovery(request)
    return isUnsettled(begun) ? begun.settle() : begun
  }

  /**
   * A passkey another origin of this RP created (the campaign funnel), identified by the hand-off:
   * one assertion reads both PRF slots, and the hinted public key is checked against its signature
   * before anything is committed. A hint the signature does not match throws, never selects a key.
   * A record this browser already holds for the credential counts the same as in `beginRecovery`.
   */
  async adoptKnownPasskey(hint: {
    credentialId: string
    pubkeyHex: string
    signal?: AbortSignal
    own?: PasskeyRequestScope
  }): Promise<WebRecoverResult> {
    const posture = this.posture()
    // What this browser recorded about reaching the authenticator steers the sheet, as in
    // `beginRecovery`; a credential it never saw sends nothing.
    const known = await this.identityMap.get(hint.credentialId)
    const assertion = await this.assertForRecovery(
      posture,
      randomChallenge(),
      [hint.credentialId],
      known?.transports,
      await this.knownSecurityKey(hint.credentialId),
      hint.signal,
      hint.own,
    )
    const record = await this.rootRecord(assertion.credentialId)
    let candidates: RecoverPasskeyResult["candidates"]
    try {
      candidates = toFrCandidates(candidatesFrom(assertion))
    } catch (err) {
      throw this.withObservation(err, assertion)
    }
    const wanted = hint.pubkeyHex.toLowerCase().replace(/^0x/, "")
    if (!(await candidatePubkeys(assertion)).includes(wanted)) throw new HintedKeyMismatchError()
    // This browser's own record for the credential outranks the hint.
    if (record && !sameHex(record.pubkey, wanted)) throw new HintedKeyMismatchError()
    const pubkey = new Uint8Array(Buffer.from(wanted, "hex"))
    return this.recovered(assertion, candidates, pubkey, record)
  }

  /**
   * A recovery result from material the campaign handed off, with no ceremony: the candidates
   * the campaign evaluated, a provider for its passkey, the creation transports the material
   * carried, and this browser's own record as the first anchor when it has one. A record for the
   * credential that names another key is the rotated-credential refusal, the same as after a
   * ceremony. The anchors decide, as always.
   */
  async recoverFromHandoffMaterial(material: HandoffMaterial): Promise<RecoverPasskeyResult> {
    const record = await this.rootRecord(material.credentialId)
    if (record && !sameHex(record.pubkey, material.pubkeyHex)) throw new RotatedCredentialError()
    const candidates: RecoverPasskeyResult["candidates"] = {}
    for (const slot of ["first", "second"] as const) {
      const hex = material.candidates[slot]
      if (!hex) continue
      try {
        candidates[slot] = Fr.fromHexString(hex)
      } catch {
        // A candidate that is not a field element is no candidate.
      }
    }
    if (!candidates.first && !candidates.second) throw new NoPrfError()
    const pubkey = material.pubkeyHex.replace(/^0x/i, "").toLowerCase()
    return {
      authProvider: this.providerFor({ credentialId: material.credentialId, pubkeyHex: pubkey }),
      credentialId: material.credentialId,
      pubkey,
      candidates,
      preferredSlot: record?.prfSlot ?? "first",
      hasPersistedSlot: false,
      candidateSource: "webauthn",
      expectedAddress: record?.l2Address,
      authenticatorType: record?.authenticatorType ?? "platform",
      ...(material.transports ? { transports: material.transports } : {}),
    }
  }

  /**
   * A recovery result from the key this session already holds (restored or freshly committed),
   * under the passkey it is bound to, when that passkey has a record here. One candidate, the
   * record's address as its anchor; nothing when locked or unbound. `restore: false` consults only
   * the key already in memory: a caller answering a tap must not start the cache proof, which reads
   * the account and derives its address, on the way to the prompt.
   */
  async recoverFromCache(options?: {
    restore?: boolean
  }): Promise<RecoverPasskeyResult | undefined> {
    if (!this.msk && options?.restore !== false) await this.restoreFromCache()
    const credentialId = getActiveCredentialId()
    if (!this.msk || !this.authProvider || !credentialId) return undefined
    const record = await this.rootRecord(credentialId)
    if (!record?.l2Address) return undefined
    const slot = record.prfSlot ?? "first"
    return {
      authProvider: this.authProvider,
      credentialId,
      pubkey: record.pubkey,
      candidates: { [slot]: this.msk },
      preferredSlot: slot,
      hasPersistedSlot: false,
      candidateSource: "webauthn",
      expectedAddress: record.l2Address,
      authenticatorType: record.authenticatorType ?? "platform",
    }
  }

  /** Drop the key from memory. A cache that still exists restores it on the next read. */
  clear(): void {
    this.epoch++
    this.msk = undefined
    this.authProvider = undefined
    this.restoring = undefined
    this.derivedKeys.clear()
  }

  /**
   * A sign-out's fence, at once: the key is gone from memory and no cache restores it until the
   * next commit, so the tuple's removal can follow under the lock without a read slipping between.
   */
  lockOut(): void {
    this.clear()
    this.fence++
    this.restoreSuppressed = true
  }
}
