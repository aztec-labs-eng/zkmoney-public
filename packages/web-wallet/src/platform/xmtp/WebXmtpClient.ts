/**
 * WebXmtpClient — browser-sdk implementation of front-core's `XmtpClientManagerLike` port.
 *
 * Identity: the inbox signer is the wallet's bootstrap EOA (`deriveBootstrapKey(msk)`),
 * the address the oxide account publishes as `bootstrapOwner()`, so senders reach the inbox by
 * name and the inbox has exactly one identity; the OPFS DB is encrypted under the shared
 * `deriveKeyFromSecret(msk, "xmtp-store")` key (never persisted). Warm start (`Client.build`) is
 * keyed by a per-account cached inboxId (`xmtp.v2.inboxId.<xmtpAddress>`); cold start
 * (`Client.create`) registers a fresh installation, first revoking the inbox's oldest one when the
 * inbox is at XMTP's per-inbox installation cap; a warm start that throws or whose local DB
 * holds no registered installation falls back to the cold path. Adapter methods normalize browser-sdk shapes to
 * the port DTOs: bigint `sentAtNs` passes straight through, numeric consent enums map to the
 * driver's `"allowed" | "unknown" | "denied"` strings.
 */

import {
  Client,
  ConsentState,
  IdentifierKind,
  LogLevel,
  Opfs,
  SortDirection,
  createBackend,
  getInboxIdForIdentifier,
  type ClientOptions,
  type Conversation,
  type DecodedMessage,
  type Dm,
  type Identifier,
  type Installation,
  type Signer,
} from "@xmtp/browser-sdk"
import { hexToBytes } from "viem"
import type { PrivateKeyAccount } from "viem/accounts"
import {
  deriveBootstrapKey,
  type FieldLike,
  type IStorageAdapter,
  type HistorySyncPort,
  type IXmtpSender,
  type InboxConversation,
  type InboxMessage,
  type XmtpClientManagerLike,
} from "@obsidion/front-core"
import { buildConnectBack, type AztecPaymentRequestContent } from "@obsidion/sdk"
import { webConnectBackCodec, webPaymentRequestCodec, webXmtpCodecs } from "./codecs"

/** Legacy unkeyed cache; ignored for warm start, dropped after a successful create. */
export const XMTP_INBOX_ID_STORAGE_KEY = "xmtp.v2.inboxId"

/** Per-account warm-start flag — two wallets on one origin each keep their own installation. */
export function xmtpInboxIdStorageKey(xmtpAddress: string): string {
  return `${XMTP_INBOX_ID_STORAGE_KEY}.${xmtpAddress.toLowerCase()}`
}

export type WebXmtpEnv = "local" | "dev" | "production"

/** XMTP's per-inbox installation limit. Registration fails once an inbox holds this many. */
const XMTP_INSTALLATION_CAP = 10

/** One eviction per inbox per window, so a retry loop cannot empty the inbox device by device. */
const XMTP_REVOKE_COOLDOWN_MS = 10 * 60_000

/** At 10/10 a cap check lost to a transient error hands `Client.create` a full inbox, so retry it. */
const XMTP_CAP_CHECK_ATTEMPTS = 3
const XMTP_CAP_CHECK_BACKOFF_MS = 500

const XMTP_ABANDONED = "xmtp cold start abandoned"

function revokedAtStorageKey(inboxId: string): string {
  return `xmtp.v2.revokedAt.${inboxId}`
}

// Driver's receive set: allowed + unknown, denied excluded.
const RECEIVE_CONSENT_STATES = [ConsentState.Allowed, ConsentState.Unknown]

type NativeConversation = Conversation<unknown>
type NativeClient = Client<unknown>

interface WrappedConversation extends InboxConversation {
  native: NativeConversation
}

export interface WebXmtpClientOptions {
  /** In-memory master secret (aztec `Fr`, structural). */
  msk: FieldLike
  /** The shared `deriveKeyFromSecret(msk, "xmtp-store")` key. */
  dbEncryptionKey: Uint8Array
  env: WebXmtpEnv
  storage: IStorageAdapter
  /** Fires if the tab lifecycle gives up on this attempt; `create` then starts no further SDK call. */
  signal?: AbortSignal
}

/** The wallet's bootstrap EOA as an XMTP signer: the inbox's only identity. */
export function bootstrapXmtpSigner(bootstrap: PrivateKeyAccount): {
  signer: Signer
  identifier: Identifier
} {
  const identifier: Identifier = {
    identifier: bootstrap.address,
    identifierKind: IdentifierKind.Ethereum,
  }
  const signer: Signer = {
    type: "EOA",
    getIdentifier: () => identifier,
    signMessage: async (message: string) => hexToBytes(await bootstrap.signMessage({ message })),
  }
  return { signer, identifier }
}

/**
 * Build against the local DB; undefined when it throws or holds no registered installation
 * (wallet re-create, OPFS wipe, env switch) so the caller cold-starts via `Client.create`.
 * Closes the built client first — the OPFS VFS supports a single connection.
 */
async function warmStart(
  identifier: Identifier,
  clientOptions: ClientOptions,
  signal?: AbortSignal,
): Promise<NativeClient | undefined> {
  let built: NativeClient | undefined
  try {
    built = (await Client.build(identifier, clientOptions)) as NativeClient
    if (!signal?.aborted && (await built.isRegistered())) return built
  } catch {
    // Fall through to close + cold start.
  }
  try {
    built?.close()
  } catch {
    // Build threw before a handle existed, or close itself failed.
  }
  return undefined
}

function closeQuietly(client: NativeClient): void {
  try {
    client.close()
  } catch {}
}

/** Resolves after `ms`, or at once when `signal` fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function createdAt(installation: Installation): bigint {
  return installation.clientTimestampNs ?? 0n
}

/**
 * Revoke the inbox's oldest installation when the inbox is at the cap and this origin has not
 * revoked one recently. Runs before the client is built: libxmtp refuses to build an installation
 * for a full inbox, and a failed build leaves its worker holding the OPFS database. The revoked
 * device is evicted for good: it keeps thinking it is registered and fails at its next network call.
 */
async function freeInstallationSlot(
  signer: Signer,
  identifier: Identifier,
  env: WebXmtpEnv,
  storage: IStorageAdapter,
  signal?: AbortSignal,
): Promise<void> {
  const backend = await createBackend({ env })
  if (signal?.aborted) throw new Error(XMTP_ABANDONED)
  const inboxId = await getInboxIdForIdentifier(backend, identifier)
  if (!inboxId) return
  if (signal?.aborted) throw new Error(XMTP_ABANDONED)
  const [state] = await Client.fetchInboxStates([inboxId], backend)
  // Above the cap (an inbox from before XMTP enforced it) one revoke would not free a slot.
  if (!state || state.installations.length !== XMTP_INSTALLATION_CAP) return
  const sinceLastRevoke = Date.now() - Number(await storage.getItem(revokedAtStorageKey(inboxId)))
  if (sinceLastRevoke >= 0 && sinceLastRevoke < XMTP_REVOKE_COOLDOWN_MS) return
  if (signal?.aborted) throw new Error(XMTP_ABANDONED)
  const oldest = state.installations.reduce((min, i) => (createdAt(i) < createdAt(min) ? i : min))
  // Reserve the window first: a revoke that outlives this tab's lock must still count.
  await storage.setItem(revokedAtStorageKey(inboxId), String(Date.now()))
  if (signal?.aborted) {
    await storage.removeItem(revokedAtStorageKey(inboxId))
    throw new Error(XMTP_ABANDONED)
  }
  try {
    await Client.revokeInstallations(signer, inboxId, [oldest.bytes], backend)
  } catch (err) {
    // Safe to retry at once: a revoke that landed anyway leaves nine, which the count check skips.
    await storage.removeItem(revokedAtStorageKey(inboxId))
    throw err
  }
  console.warn("[xmtp] revoked installation", oldest.id, "created", String(createdAt(oldest)))
}

async function coldStart(
  signer: Signer,
  identifier: Identifier,
  clientOptions: ClientOptions,
  env: WebXmtpEnv,
  storage: IStorageAdapter,
  signal?: AbortSignal,
): Promise<NativeClient> {
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw new Error(XMTP_ABANDONED)
    try {
      await freeInstallationSlot(signer, identifier, env, storage, signal)
      break
    } catch (err) {
      if (signal?.aborted) throw err
      if (attempt === XMTP_CAP_CHECK_ATTEMPTS) {
        // A failed check does not block construction.
        console.warn("[xmtp] installation cap check failed", err)
        break
      }
      await sleep(XMTP_CAP_CHECK_BACKOFF_MS * attempt, signal)
    }
  }
  if (signal?.aborted) throw new Error(XMTP_ABANDONED)
  const client = (await Client.create(signer, {
    ...clientOptions,
    disableAutoRegister: true,
  })) as NativeClient
  if (signal?.aborted) {
    closeQuietly(client)
    throw new Error(XMTP_ABANDONED)
  }
  try {
    await client.register()
  } catch (err) {
    closeQuietly(client)
    throw err
  }
  return client
}

export class WebXmtpClient implements XmtpClientManagerLike, IXmtpSender, HistorySyncPort {
  private constructor(
    private readonly client: NativeClient,
    /** This wallet's messaging address: the bootstrap EOA, the inbox's only identity. */
    readonly xmtpAddress: string,
    /** True on the cold `Client.create` path — the mount imports history then (KTD-10). */
    readonly isFirstInstallation: boolean,
  ) {}

  static async create(options: WebXmtpClientOptions): Promise<WebXmtpClient> {
    if (options.dbEncryptionKey.length !== 32) {
      throw new Error("dbEncryptionKey must be the 32-byte derived xmtp-store key")
    }
    const bootstrap = deriveBootstrapKey(options.msk)
    const { signer, identifier } = bootstrapXmtpSigner(bootstrap)
    const clientOptions = {
      env: options.env,
      dbEncryptionKey: options.dbEncryptionKey,
      codecs: webXmtpCodecs,
      // Silences libxmtp's wasm tracing output and the SDK's per-action worker-bridge logging.
      // Raise to LogLevel.Debug to get either back.
      loggingLevel: LogLevel.Off,
    } as unknown as ClientOptions
    const cacheKey = xmtpInboxIdStorageKey(bootstrap.address)
    const cachedInboxId = await options.storage.getItem(cacheKey)
    if (options.signal?.aborted) throw new Error(XMTP_ABANDONED)
    const warm = cachedInboxId
      ? await warmStart(identifier, clientOptions, options.signal)
      : undefined
    const client =
      warm ??
      (await coldStart(
        signer,
        identifier,
        clientOptions,
        options.env,
        options.storage,
        options.signal,
      ))
    const isFirstInstallation = !warm
    if (client.inboxId) {
      await options.storage.setItem(cacheKey, client.inboxId)
      await options.storage.removeItem(XMTP_INBOX_ID_STORAGE_KEY)
    }
    // The installation is registered and cached either way; an abandoned attempt just lets it go.
    if (options.signal?.aborted) {
      closeQuietly(client)
      throw new Error(XMTP_ABANDONED)
    }
    return new WebXmtpClient(client, bootstrap.address, isFirstInstallation)
  }

  close(): void {
    this.client.close()
  }

  // ── Port surface (XmtpClientManagerLike) ──────────────────────────────────

  isReady(): boolean {
    return this.client.isReady
  }

  get installationId(): string | null {
    return this.client.installationId ?? null
  }

  async listConversations(): Promise<InboxConversation[]> {
    await this.client.conversations.sync()
    const list = await this.client.conversations.list()
    return list.map((c) => this.wrapConversation(c))
  }

  async messagesAfter(
    conversation: InboxConversation,
    sentNs: number | bigint,
    limit?: number,
  ): Promise<InboxMessage[]> {
    const native = this.nativeOf(conversation)
    await native.sync()
    return this.readMessages(native, sentNs, limit)
  }

  async messagesAfterLocal(
    conversation: InboxConversation,
    sentNs: number | bigint,
    limit?: number,
  ): Promise<InboxMessage[]> {
    return this.readMessages(this.nativeOf(conversation), sentNs, limit)
  }

  async syncAllConversations(): Promise<{ numEligible: number; numSynced: number }> {
    await this.client.conversations.syncAll(RECEIVE_CONSENT_STATES)
    // browser-sdk's syncAll returns void; the driver only awaits completion.
    return { numEligible: 0, numSynced: 0 }
  }

  async findConversation(id: string): Promise<InboxConversation | undefined> {
    const native = await this.client.conversations.getConversationById(id)
    return native ? this.wrapConversation(native) : undefined
  }

  async subscribeAllMessages(
    onMessage: (message: InboxMessage) => void,
    onClose?: () => void,
  ): Promise<() => void> {
    const stream = await this.client.conversations.streamAllMessages({
      consentStates: RECEIVE_CONSENT_STATES,
      onValue: (message) => onMessage(wrapMessage(message)),
      onEnd: () => onClose?.(),
      onFail: () => onClose?.(),
    })
    return () => {
      void stream.end().catch(() => {})
    }
  }

  async getDmPeerAddresses(conversation: InboxConversation): Promise<string[]> {
    try {
      const native = this.nativeOf(conversation) as Partial<Dm<unknown>>
      if (typeof native.peerInboxId !== "function") return []
      const peerInboxId = await native.peerInboxId()
      if (!peerInboxId) return []
      // Sender verification must see identities linked or revoked since the inbox was cached.
      const states = await this.client.preferences.fetchInboxStates([peerInboxId])
      return (states?.[0]?.accountIdentifiers ?? [])
        .filter((identity) => identity.identifierKind === IdentifierKind.Ethereum)
        .map((identity) => identity.identifier)
    } catch {
      return []
    }
  }

  // ── Sender surface (front-core's `IXmtpSender` + the connect-back outbox port) ─

  async canMessage(addresses: string[]): Promise<Record<string, boolean>> {
    const identifiers: Identifier[] = addresses.map((address) => ({
      identifier: address,
      identifierKind: IdentifierKind.Ethereum,
    }))
    return Object.fromEntries(await this.client.canMessage(identifiers))
  }

  async sendRequest(peerAddress: string, content: AztecPaymentRequestContent): Promise<string> {
    return this.sendEncoded(peerAddress, webPaymentRequestCodec, content)
  }

  async sendConnectBack(
    peerXmtp: string,
    content: { version: number; uuid: string; tag?: string },
  ): Promise<{ ok: boolean; reason?: "recipient-not-reachable" }> {
    const reachability = await this.canMessage([peerXmtp])
    if (!(reachability[peerXmtp.toLowerCase()] === true || reachability[peerXmtp] === true)) {
      return { ok: false, reason: "recipient-not-reachable" }
    }
    await this.sendEncoded(
      peerXmtp,
      webConnectBackCodec,
      buildConnectBack({ version: content.version, uuid: content.uuid, tag: content.tag }),
    )
    return { ok: true }
  }

  /** Open (or find) the DM and send codec-encoded content; resolves to the XMTP message id.
   *  browser-sdk v7 sends pre-encoded content — the shared codec produces the wire bytes. */
  private async sendEncoded<T>(
    peerAddress: string,
    codec: { encode(content: T): unknown; shouldPush(content: T): boolean },
    content: T,
  ): Promise<string> {
    const dm = await this.client.conversations.createDmWithIdentifier({
      identifier: peerAddress,
      identifierKind: IdentifierKind.Ethereum,
    })
    const encoded = codec.encode(content)
    return dm.send(encoded as Parameters<typeof dm.send>[0], {
      shouldPush: codec.shouldPush(content),
    })
  }

  /** Revoke this installation on the network (wallet reset). */
  async revokeInstallation(): Promise<void> {
    const bytes = this.client.installationIdBytes
    if (bytes) await this.client.revokeInstallations([bytes])
  }

  // ── Device sync (front-core `DeviceSyncPort`) ─────────────────────────────

  async sendSyncRequest(): Promise<void> {
    await this.client.sendSyncRequest()
  }

  async sendSyncArchive(pin: string): Promise<void> {
    await this.client.sendSyncArchive(pin)
  }

  async processSyncArchive(pin?: string): Promise<void> {
    await this.client.processSyncArchive(pin)
  }

  async listSyncArchivePins(): Promise<string[]> {
    return (await this.client.listAvailableArchives(7)).map((archive) => archive.pin)
  }

  async syncAllDeviceSyncGroups(): Promise<unknown> {
    return this.client.syncAllDeviceSyncGroups()
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private wrapConversation(native: NativeConversation): WrappedConversation {
    return {
      id: native.id,
      // The port maps stream messages topic -> id; browser-sdk stream messages carry
      // conversationId, so both sides of the map use the conversation id.
      topic: native.id,
      consentState: async () => consentStateToString(await native.consentState()),
      native,
    }
  }

  private nativeOf(conversation: InboxConversation): NativeConversation {
    const native = (conversation as Partial<WrappedConversation>).native
    if (!native) throw new Error("conversation handle did not originate from WebXmtpClient")
    return native
  }

  private async readMessages(
    native: NativeConversation,
    sentNs: number | bigint,
    limit?: number,
  ): Promise<InboxMessage[]> {
    const messages = await native.messages({
      sentAfterNs: typeof sentNs === "bigint" ? sentNs : BigInt(sentNs),
      direction: SortDirection.Ascending,
      limit: limit === undefined ? undefined : BigInt(limit),
    })
    return messages.map(wrapMessage)
  }
}

function consentStateToString(state: ConsentState): string {
  switch (state) {
    case ConsentState.Allowed:
      return "allowed"
    case ConsentState.Denied:
      return "denied"
    default:
      return "unknown"
  }
}

function wrapMessage(message: DecodedMessage<unknown>): InboxMessage {
  const t = message.contentType
  return {
    id: message.id,
    sentNs: message.sentAtNs,
    contentTypeId: `${t.authorityId}/${t.typeId}:${t.versionMajor}.${t.versionMinor}`,
    content: () => message.content,
    topic: message.conversationId,
  }
}

/**
 * Wallet reset: revoke this installation (best-effort, needs a live client) and drop the encrypted
 * OPFS DBs + cached inboxId so the next unlock cold-starts. No web reset flow calls this yet; it is
 * the seam that flow wires up.
 */
export async function wipeXmtpLocalState(
  storage: IStorageAdapter,
  liveClient?: WebXmtpClient,
): Promise<void> {
  if (liveClient) {
    try {
      await liveClient.revokeInstallation()
    } catch {
      // Best-effort — a failed revoke never blocks the local wipe.
    }
  }
  await storage.removeItem(XMTP_INBOX_ID_STORAGE_KEY)
  if (liveClient) await storage.removeItem(xmtpInboxIdStorageKey(liveClient.xmtpAddress))
  try {
    const opfs = await Opfs.create()
    for (const file of await opfs.listFiles()) {
      if (file.includes("xmtp-")) await opfs.deleteFile(file).catch(() => false)
    }
  } catch {
    // OPFS unavailable — nothing to wipe.
  }
}
