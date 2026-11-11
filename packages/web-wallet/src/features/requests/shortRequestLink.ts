import { useCallback, useEffect, useMemo, useReducer, useState } from "react"
import { NO_FROM } from "@aztec-labs/aztec.js/account"
import { WalletError } from "@obsidion/core/errors"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import {
  requestLinkOperationId,
  trackSubmission,
  TxInFlightError,
  NO_SERVICE,
  serviceStatus,
  useStore,
} from "@obsidion/front-core"
import {
  base64UrlToBytes,
  buildClaimSponsorPayload,
  buildClaimSubscribePayload,
  bytesToBase64Url,
  claimFpcSponsoredFee,
  findLinkPayloads,
  linkAnnounceInteraction,
  type LinkKey,
  LinkKind,
  type LinkLocatorClasses,
  MAX_LINK_PAYLOAD_BYTES,
  randomLinkKey,
  shortLinksEnabled,
} from "@obsidion/sdk"
import { requestAmountLabel } from "../../ui/format"
import { runOperation, type OperationHandle } from "../operations/operations"
import {
  claimSponsorContext,
  noteSubscribed,
  type ClaimSponsorDeps,
} from "../registration/claimSponsorship"
import { RAIL_REGISTERED } from "../registration/rails"
import { shortRequestUrl } from "../shortLinks"
import { signerKitOf, useSession, type Session } from "../../session/session"
import type { Operations, ReceiveCode } from "@obsidion/front-core"

/** What a short link publishes: a request, its full link and its amount. A Receive code is one. */
export type ShareableRequest = Pick<ReceiveCode, "requestId" | "url" | "amount">

/** A code's fragment as the bytes its short link announces, or undefined when they don't fit. */
export function codePayload(code: ShareableRequest): Uint8Array | undefined {
  const fragment = code.url.slice(code.url.indexOf("#") + 1)
  const bytes = base64UrlToBytes(fragment)
  return bytes.length > 0 && bytes.length <= MAX_LINK_PAYLOAD_BYTES ? bytes : undefined
}

/**
 * Publish a code signed by its short link's key: one sponsored call, no passkey. The FPC
 * subscription pays, folded into this tx when the account has none yet.
 */
export async function announceCode(
  deps: ClaimSponsorDeps,
  key: LinkKey,
  bytes: Uint8Array,
  op: OperationHandle,
) {
  const { operationId } = op
  const { wallet, account, contractService } = deps
  const user = account.getAddress()
  const { fpcAddress, fpcArtifact, railId, policy, subscribe } = await claimSponsorContext(
    deps,
    RAIL_REGISTERED,
  )
  const announce = await linkAnnounceInteraction(
    wallet,
    contractService,
    LinkKind.Request,
    key,
    bytes,
  )
  const innerCalls = (await announce.request()).calls
  // The locator matches the rail's `ByAny` entry: no class witness.
  const common = { fpcAddress, fpcArtifact, railId, policy, user, innerCalls, classWitnesses: [] }
  const payload = subscribe
    ? await buildClaimSubscribePayload({ ...common, gate: subscribe.gate })
    : await buildClaimSponsorPayload(common)
  const submission = trackSubmission(deps.session.page.prover.progress, operationId)
  try {
    // The user tags the tx, so the FPC's refreshed SubscriptionNote stays discoverable.
    await wallet.sendTx(payload, {
      from: NO_FROM,
      sendMessagesAs: user,
      additionalScopes: [user],
      fee: claimFpcSponsoredFee(policy, innerCalls),
      operationId,
      // The operation is this tx's only record: one that did not save the hash sends nothing.
      onTxHash: op.sent,
    })
  } catch (e) {
    const inFlight = await submission.survived(wallet.node)
    if (inFlight) throw new TxInFlightError(inFlight, e)
    throw e
  } finally {
    submission.stop()
  }
  if (subscribe) noteSubscribed({ session: deps.session, account }, fpcAddress, railId)
}

/** Resolves once the chain settles a sent operation; rejects once it fails. */
function chainOutcome(operations: Operations, operationId: string): Promise<void> {
  const { view } = operations
  return new Promise((resolve, reject) => {
    const check = () => {
      const record = view.get().records.find((r) => r.operationId === operationId)
      if (record?.state === "settled") resolve()
      else if (!record || record.state === "failed")
        reject(new WalletError("tx.failed", record?.error ?? "dropped"))
      else return
      off()
    }
    const off = view.subscribe(check)
    check()
  })
}

/** Publish a code as an operation the bell lists; resolves once the chain includes it. */
export async function publishCode(
  session: Pick<Session, "operations" | "page">,
  deps: ClaimSponsorDeps,
  requestId: string,
  key: LinkKey,
  bytes: Uint8Array,
  amount: number,
): Promise<void> {
  const operationId = requestLinkOperationId(requestId)
  const summary = `Request for ${amount > 0 ? requestAmountLabel(amount) : "any amount"}`
  const { operations } = session
  try {
    await runOperation(session, { operationId, flow: "request-link", summary }, async (op) => {
      // No screen waits on it, so the bell reports how it ends.
      await operations.apply(operationId, { type: "handedOff", at: Date.now() })
      await announceCode(deps, key, bytes, op)
    })
  } catch (e) {
    if (!(e instanceof TxInFlightError)) throw e
    await chainOutcome(operations, operationId)
  }
}

/** `idle` until handed out; `failed` already holds the fresh key the next hand-out publishes. */
export type ShortLinkStatus = "idle" | "publishing" | "ready" | "failed"

interface ShortLink {
  key: LinkKey
  status: ShortLinkStatus
}

// One record per request across every mount, so a remounted sheet neither re-keys nor re-sends.
// eslint-disable-next-line no-restricted-syntax -- debt
const links = new Map<string, ShortLink>()
// eslint-disable-next-line no-restricted-syntax -- debt
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((listener) => listener())

/**
 * The short link to share for a request, and the hand-out that publishes it. Each request gets
 * one key, whose hash is the link's seed, and its announce tx goes out once, on the first hand-out: codes re-mint unseen, so only
 * a tap may send it. The code's own link stands in while the wallet can't publish, on a deployment
 * that states no locator, and in the QR until the short one resolves.
 */
export function useShortRequestLink(code: ShareableRequest | undefined) {
  const session = useSession()
  const walletBuilt = useStore(session.wallet, serviceStatus) === "ready"
  const unlocked = useStore(session.account ?? NO_SERVICE, serviceStatus) === "ready"
  const contracts = useStore(session.contractService, serviceStatus) === "ready"
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    listeners.add(rerender)
    return () => void listeners.delete(rerender)
  }, [])

  const enabled = useShortLinksEnabled(contracts)
  const deps = walletBuilt && unlocked && contracts && enabled

  const bytes = useMemo(() => (code ? codePayload(code) : undefined), [code])
  let link: ShortLink | undefined
  if (code && bytes && deps) {
    link = links.get(code.requestId) ?? { key: randomLinkKey(), status: "idle" }
    links.set(code.requestId, link)
  }
  const url = link ? shortRequestUrl(link.key.seed, session.network) : code?.url
  const status = link?.status ?? "idle"
  const qrUrl = status === "ready" ? url : code?.url

  const publish = useCallback(() => {
    if (!code || !bytes || !deps) return
    const requestId = code.requestId
    const current = links.get(requestId)
    if (!current || current.status === "publishing" || current.status === "ready") return
    current.status = "publishing"
    changed()
    void signerKitOf(session)
      .then((kit) =>
        publishCode(session, { session, ...kit }, requestId, current.key, bytes, code.amount),
      )
      .then(
        () => {
          current.status = "ready"
          changed()
          // Later shares of this request, from Activity too, use the short link.
          void Promise.resolve()
            .then(() =>
              session.requests.setShortLink(
                requestId,
                shortRequestUrl(current.key.seed, session.network),
              ),
            )
            .catch((e: unknown) => console.warn("[request] short link not saved:", e))
        },
        (e: unknown) => {
          // The next hand-out shares and publishes a fresh link rather than one that never resolves.
          links.set(requestId, { key: randomLinkKey(), status: "failed" })
          changed()
          // The bell row and Receive tell the user; no dialog for a background publish.
          console.warn("[request] short link not published:", e)
        },
      )
  }, [code, bytes, deps, session])

  return { url, qrUrl, status, publish }
}

function useShortLinksEnabled(contracts: boolean): boolean {
  const { contractService } = useSession()
  const [enabled, setEnabled] = useState(false)
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (!contracts) return
    let stopped = false
    void contractService
      .ready()
      .then(shortLinksEnabled)
      .then((on) => !stopped && setEnabled(on))
    return () => {
      stopped = true
    }
  }, [contracts, contractService])
  return enabled
}

/**
 * The fragment a short request link stands for, or undefined until its announce tx lands. Only
 * what the link's key signed counts, so a link holder cannot redirect it.
 */
export async function resolveShortRequest(
  node: Pick<AztecNode, "getPrivateLogsByTags">,
  contractService: LinkLocatorClasses,
  seed: Uint8Array,
): Promise<string | undefined> {
  const [first] = await findLinkPayloads(node, contractService, LinkKind.Request, seed)
  return first && bytesToBase64Url(first.bytes)
}
