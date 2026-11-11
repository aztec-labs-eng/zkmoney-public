/**
 * XmtpMount — side-effect-only component mounted inside WalletGate (unlocked wallet only). Runs the
 * resilient KTD-3 lifecycle: capability gate, visibility-scoped `xmtp-client` Web Lock, and — as
 * leader — the stage-3 inbox: payment-request receive via the hoisted driver. (Transfer receive is
 * chain-native — the `transferScan` task — and independent of XMTP.) A catch-up drain runs on
 * every leader acquisition (unlock / tab promotion); the inbox reads "ready" when it completes or
 * after a bounded wait (KTD-10). Non-leader / unsupported tabs render nothing and only publish the
 * shared UI state.
 */

import { useEffect } from "react"
import {
  RequestReceiver,
  XmtpInboxReceiverDriver,
  importHistory,
  startArchivePublisher,
  startHistoryImporter,
  useAfter,
  type After,
  type Contacts,
  type XmtpCursors,
  type XmtpInbox,
  useStore,
} from "@obsidion/front-core"
import { useSession, type Session } from "../../session/session"
import {
  createRequestBindingResolver,
  createRequestSenderPolicy,
  createRequestStoreWrites,
} from "./adapters"
import { WebXmtpClient } from "./WebXmtpClient"
import {
  XmtpLifecycle,
  messagingCapability,
  setXmtpInboxState,
  setXmtpSender,
  setXmtpUiState,
  withTimeout,
  type XmtpClientHandle,
} from "./xmtpLifecycle"

/** Bound on the KTD-10 catch-up gate: after this the inbox reads "ready" with local content. */
const XMTP_CATCH_UP_TIMEOUT_MS = 120_000

/** The account's stores the inbox reads; a visitor's session has none. */
interface AccountStores {
  requests: Session["requests"]
  contacts: Contacts
  xmtpCursors: XmtpCursors
  xmtpInbox: XmtpInbox
}

/** Construct the client and mount the full receive pipeline; runs only as the lock leader. */
async function createLeaderClient(
  dbEncryptionKey: Uint8Array,
  signal: AbortSignal,
  networkId: string,
  {
    auth,
    device,
    identity,
    requests,
    contacts,
    xmtpCursors,
    xmtpInbox,
    page: { config, verifyTag },
  }: Pick<Session, "auth" | "device" | "identity" | "page"> & AccountStores,
): Promise<XmtpClientHandle> {
  const allowNonContactRequests = () => device.get().allowNonContactRequests
  const msk = await auth.getSecretKey()
  if (!msk) throw new Error("wallet locked — cannot derive the XMTP identity")
  const client = await WebXmtpClient.create({
    msk,
    dbEncryptionKey,
    env: config.xmtpEnv,
    inbox: xmtpInbox,
    signal,
  })
  if (signal.aborted) {
    client.close()
    throw new Error("xmtp client construction abandoned")
  }
  // Sends are usable the moment the client exists — don't hold them behind the catch-up drain
  // below, which can run for a long time on a fresh installation.
  setXmtpSender(client)

  try {
    return await mountReceivePipeline(client, signal, allowNonContactRequests, {
      networkId,
      identity,
      requests,
      contacts,
      xmtpCursors,
      xmtpEnv: config.xmtpEnv,
      verifyTag,
    })
  } catch (err) {
    setXmtpSender(null)
    client.close()
    throw err
  }
}

/** The stage-3 receive pipeline over an already-constructed leader client. */
async function mountReceivePipeline(
  client: WebXmtpClient,
  signal: AbortSignal,
  allowNonContactRequests: () => boolean,
  {
    networkId,
    identity,
    requests,
    contacts,
    xmtpCursors,
    xmtpEnv,
    verifyTag,
  }: {
    networkId: string
    identity: Session["identity"]
    requests: Session["requests"]
    contacts: Contacts
    xmtpCursors: XmtpCursors
    xmtpEnv: Session["page"]["config"]["xmtpEnv"]
    verifyTag: Session["page"]["verifyTag"]
  },
): Promise<XmtpClientHandle> {
  // KTD-10: a fresh installation pulls history from the account's other installations. Must
  // finish before the driver starts so its cursors still sit at zero. No history server on `local`.
  const deviceSyncAvailable = xmtpEnv !== "local"
  if (deviceSyncAvailable && client.isFirstInstallation) {
    await importHistory(client, console)
    if (signal.aborted) throw new Error("xmtp client construction abandoned")
  }

  const receiverLogger = {
    warn: (message: string, context?: Record<string, unknown>) => {
      if (context) console.warn(message, context)
      else console.warn(message)
    },
  }

  // Sender- and binding-gated — see RequestReceiver.
  const requestReceiver = new RequestReceiver(
    createRequestStoreWrites(requests),
    receiverLogger,
    createRequestBindingResolver(verifyTag),
    createRequestSenderPolicy(contacts, allowNonContactRequests),
  )

  const driver = XmtpInboxReceiverDriver.getOrCreate({
    xmtp: client,
    requestReceiver,
    currentAccount: async () => {
      const own = identity.get().value
      // Nameless accounts have no messaging identity yet: XMTP rows key on the tag.
      if (!own?.handle) return null
      // The driver stamps received rows with the rollup id.
      return { tag: own.handle, l2Address: own.address, rollupId: networkId }
    },
    cursors: xmtpCursors,
  })

  // KTD-10 catch-up: start the loop + stream, then flip the inbox to "ready" once one full drain
  // completes — or after XMTP_CATCH_UP_TIMEOUT_MS, whichever comes first, so a wedged drain can't
  // pin "catching-up" forever (the drain keeps running in the background; local content shows
  // meanwhile). Not awaited here: client construction is bounded by the lifecycle's own timeout.
  let disposed = false
  let stopPublisher: (() => void) | null = null
  setXmtpInboxState("catching-up")
  await driver.start()
  if (signal.aborted) {
    setXmtpInboxState("idle")
    XmtpInboxReceiverDriver.resetInstance()
    // The driver's first poll is already queued; a closed client is what stops it.
    client.close()
    throw new Error("xmtp client construction abandoned")
  }
  const stopImporter = deviceSyncAvailable ? startHistoryImporter(client, console) : null
  void driver.startStream()
  const drain = driver
    .pollNow()
    .catch((err) => console.warn("[XmtpMount] catch-up drain failed", err))
  void withTimeout(drain, XMTP_CATCH_UP_TIMEOUT_MS, "xmtp catch-up drain")
    .catch(() => {}) // a wedged drain flips "ready" anyway; it keeps running in the background
    .then(() => {
      if (disposed) return
      setXmtpInboxState("ready")
      // Publish history for other installations that can access the sync group.
      if (deviceSyncAvailable) stopPublisher = startArchivePublisher(client, console)
    })

  return {
    close: () => {
      disposed = true
      stopPublisher?.()
      stopImporter?.()
      setXmtpSender(null)
      setXmtpInboxState("idle")
      XmtpInboxReceiverDriver.resetInstance()
      client.close()
    },
  }
}

/** The client is a large WASM, a database and a network sync. */
const AFTER: After = { firstBalance: true }
export function XmtpMount(): null {
  const session = useSession()
  const ready = useAfter(session.milestones, AFTER)
  const networkId = useStore(session.page.networkId)
  // eslint-disable-next-line local/effect-hook -- ZKM-1806
  useEffect(() => {
    if (messagingCapability() !== "ok") {
      setXmtpUiState("unsupported")
      return () => setXmtpUiState("off")
    }
    const { contacts, xmtpCursors, xmtpInbox } = session
    if (!ready || !networkId || !contacts || !xmtpCursors || !xmtpInbox) return
    const lifecycle = new XmtpLifecycle({
      locks: navigator.locks,
      isVisible: () => document.visibilityState === "visible",
      onVisibilityChange: (listener) => {
        document.addEventListener("visibilitychange", listener)
        return () => document.removeEventListener("visibilitychange", listener)
      },
      deriveDbKey: () => session.auth.getDerivedKey("xmtp-store"),
      createClient: (key, signal) =>
        createLeaderClient(key, signal, networkId, {
          ...session,
          contacts,
          xmtpCursors,
          xmtpInbox,
        }),
      onState: setXmtpUiState,
      log: (message, ...args) => console.warn(message, ...args),
    })
    lifecycle.start()
    return () => lifecycle.stop()
  }, [ready, networkId, session])
  return null
}
