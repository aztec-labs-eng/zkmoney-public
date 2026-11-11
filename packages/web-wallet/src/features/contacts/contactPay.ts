/**
 * Send + request rails to a saved contact. Send is a ClaimFPC-sponsored
 * `TokenService.sendTokenSponsored` — the same gasless rail as withdraw and paylink, so a first-ever
 * send folds the subscription (and account setup) into its own batch; the recipient discovers the
 * transfer from the chain (`Transfer.meta` carries tag / memo / request id). Request is an XMTP
 * announce, persisted to the requests store only on confirmed delivery.
 */
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { nextOperationId } from "@obsidion/sdk"
import {
  RequestBroadcaster,
  trackSubmission,
  TxInFlightError,
  resolveAssetConstants,
  WalletError,
  type Contacts,
} from "@obsidion/front-core"
import { parseUnits } from "viem"
import { runOperation, type OperationHandle } from "../operations/operations"
import { accountKitOf, type AccountKit, type Session } from "../../session/session"
import { accountContacts } from "../../session/contacts"
import {
  getXmtpSender,
  getXmtpUiState,
  xmtpUnavailableCode,
} from "../../platform/xmtp/xmtpLifecycle"
import { claimSponsorContext, noteSubscribed } from "../registration/claimSponsorship"
import { RAIL_REGISTERED } from "../registration/rails"
import { recipientNotUpgradedCopy } from "../migration/upgradeCopy"
import { resolveTagForCommit, resolveTagViaRegistry } from "./registryResolution"

export type PayStage = "resolving" | "proving" | "submitting"

type ContactPayKit = AccountKit & { session: Session; contacts: Contacts }

/** The recipient's tag is still on a retired rollup, so funds sent now would not reach them. */
export class RecipientNotUpgradedError extends Error {
  constructor(readonly tag: string) {
    super(recipientNotUpgradedCopy.title(tag))
    this.name = "RecipientNotUpgradedError"
  }
}

/**
 * Whether `tag` has upgraded, read from the cached manifest before the user enters an amount. A
 * failed read answers true: the commit-time resolution is the guard.
 */
export async function recipientUpgraded(
  session: Pick<Session, "page">,
  tag: string,
): Promise<boolean> {
  try {
    return (await resolveTagViaRegistry(session.page, tag)).status !== "staleRollup"
  } catch {
    return true
  }
}

async function resolveContact(session: Pick<Session, "page">, tag: string) {
  const resolved = await resolveTagForCommit(session.page, tag)
  if (resolved.status === "staleRollup") throw new RecipientNotUpgradedError(tag)
  if (resolved.status !== "resolved")
    throw new WalletError("contact.unregistered", `@${tag}`, { data: { tag } })
  return resolved
}

/**
 * Send `amountDisplay` to the contact's registry-resolved L2 address and wait for the mine. The
 * recipient discovers it from the chain — the send carries the sender tag / memo / request id in
 * `Transfer.meta`.
 *
 * The operation is the send's record: it takes what the row shows before the proof, because the
 * screen can close mid-flight and the contact chat is where the user lands. Its three states are
 * the tx's own: no hash while proving, the real hash, saved before the node takes the tx, then
 * settled. The chat draws them as a spinner, one tick, two ticks.
 */
export function sendToContact(
  session: Session,
  args: {
    tag: string
    senderTag: string
    amountDisplay: string
    /** The requester's L2 address, whole from a link or its first bytes from a Receive code. */
    requesterPin?: string
    note?: string
    /** Payment request this send fulfills; rides the on-chain `Transfer.meta`. */
    requestId?: string
    /**
     * Save the resolved tag as a contact. It is saved as `autoAdded` before the send's row shows, so
     * the send shows its name, and becomes a contact for requests only once the send lands.
     */
    saveContact?: boolean
  },
  onStage: (stage: PayStage) => void,
): Promise<{ txHash: string }> {
  // Correlates the TEE and prove benchmark legs → one tx_timing analytics event, and keys the
  // operation that is this send's record (there is no txHash until the wallet reaches Mining).
  const operationId = nextOperationId("send")
  return runOperation(
    session,
    { operationId, flow: "send", summary: `$${args.amountDisplay} to @${args.tag}` },
    (op) => sendToContactFlow(op, session, args, onStage),
    (r) => r.txHash,
  )
}

async function sendToContactFlow(
  op: OperationHandle,
  session: Session,
  args: {
    tag: string
    senderTag: string
    amountDisplay: string
    requesterPin?: string
    note?: string
    /** Payment request this send fulfills; rides the on-chain `Transfer.meta`. */
    requestId?: string
    saveContact?: boolean
  },
  onStage: (stage: PayStage) => void,
): Promise<{ txHash: string }> {
  onStage("resolving")
  const deps = { ...(await accountKitOf(session)), session, contacts: accountContacts(session) }
  const resolved = await resolveContact(session, args.tag)
  // The tag must still name the account the request was made for, or the funds go to its new one.
  if (
    args.requesterPin &&
    !resolved.l2Address.toLowerCase().startsWith(args.requesterPin.toLowerCase())
  ) {
    throw new WalletError("contact.requestMismatch", `@${args.tag}`, { data: { tag: args.tag } })
  }
  const contact = { name: args.tag, address: resolved.l2Address, verified: true, tag: args.tag }
  let added = false
  if (args.saveContact) {
    const unapproved = { ...contact, autoAdded: true }
    added = (await deps.contacts.addOrMergeContact(unapproved).catch(console.warn)) === unapproved
  }
  return sendResolved(op, deps, args, resolved.l2Address, onStage).catch(async (err) => {
    // A send that may still land keeps the row; one that cannot takes back the row it added.
    if (added && !(err instanceof TxInFlightError)) {
      await deps.contacts.removeEntry({ address: contact.address }).catch(console.warn)
    }
    throw err
  })
}

async function sendResolved(
  op: OperationHandle,
  deps: ContactPayKit,
  args: Parameters<typeof sendToContactFlow>[2],
  l2Address: string,
  onStage: (stage: PayStage) => void,
): Promise<{ txHash: string }> {
  const contact = { name: args.tag, address: l2Address, verified: true, tag: args.tag }
  const [sponsor, token, resolveSpendMetadata] = await Promise.all([
    claimSponsorContext(deps, RAIL_REGISTERED),
    deps.tokenService.fetchTokenInformation(),
    deps.account.makeSpendMetadataResolver(),
  ])

  onStage("proving")
  const { operationId } = op
  const walletAsset = resolveAssetConstants(deps.session.network).DAI
  await op.transfer({
    kind: "send",
    payload: {
      networkId: deps.wallet.networkId.toLowerCase(),
      token: {
        address: token.address,
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals,
        logo: walletAsset.logo,
        price: walletAsset.price,
        amount: Number(args.amountDisplay),
      },
      amountAtomic: parseUnits(args.amountDisplay, token.decimals).toString(),
      to: l2Address,
      toTag: args.tag,
      ...(args.note ? { memo: args.note } : {}),
      // Lets the feed hide the request this send pays while it is pending.
      ...(args.requestId ? { requestId: args.requestId } : {}),
    },
  })
  const submission = trackSubmission(deps.session.page.prover.progress, operationId)

  // Resolves on the L2 receipt: the sponsored rail owns simulate/attest/prove/submit as one step,
  // so there is no pre-mine handle to broadcast against.
  let result
  try {
    result = await deps.tokenService.sendTokenSponsored(
      AztecAddress.fromStringUnsafe(l2Address),
      args.amountDisplay,
      sponsor,
      {
        resolveSpendMetadata,
        userAccount: deps.account,
        operationId,
        requestId: args.requestId,
        senderTag: args.senderTag,
        recipientTag: args.tag,
        memo: args.note,
        // The operation is the send's record: one that did not save the hash sends nothing.
        onTxHash: op.sent,
      },
    )
  } catch (err) {
    // Failed only if the send never reached the node or a receipt says so; past the submit boundary
    // the operation stays sent for the chain to settle.
    const inFlight = await submission.survived(deps.wallet.node)
    if (inFlight) throw new TxInFlightError(inFlight, err)
    throw err
  } finally {
    submission.stop()
  }
  if (sponsor.subscribe) noteSubscribed(deps, sponsor.fpcAddress, sponsor.railId)
  deps.session.oweFpcRefuel({ address: sponsor.fpcAddress, artifact: sponsor.fpcArtifact })
  const txHash = result.txHash
  onStage("submitting")
  // Paying someone makes them a contact whose requests show as a contact's.
  if (args.saveContact) void deps.contacts.addEntry(contact).catch(console.warn)
  else void deps.contacts.approveAutoAdded(l2Address).catch(console.warn)
  return { txHash }
}

/** Announce a payment request over XMTP and persist the outgoing row on delivery. */
export async function requestFromContact(
  session: Session,
  args: { tag: string; requesterTag: string; amountDisplay: string; note?: string },
): Promise<void> {
  const xmtp = getXmtpSender()
  if (!xmtp) {
    throw new WalletError(xmtpUnavailableCode(getXmtpUiState()))
  }
  const resolved = await resolveContact(session, args.tag)
  const { tokenService, wallet } = await accountKitOf(session)
  const token = await tokenService.fetchTokenInformation()
  // A field: the fulfilling send carries it in the on-chain `Transfer.meta`.
  const requestId = Fr.random().toString()
  const amountAtomic = parseUnits(args.amountDisplay, token.decimals).toString()

  const status = await new RequestBroadcaster(xmtp).announce({
    recipientXmtpAddress: resolved.xmtpAddress,
    requestId,
    requesterTag: args.requesterTag,
    amountAtomic,
    token: { address: token.address, symbol: token.symbol, decimals: token.decimals },
    // The wire value a receiver compares: another network's packet is dropped.
    networkId: wallet.networkId,
    note: args.note,
  })
  if (status.status === "skipped") throw new WalletError("contact.cannotReceive", status.reason)
  if (status.status === "failed") {
    throw new WalletError("request.undelivered", status.reason, { data: { reason: status.reason } })
  }

  await session.requests.add({
    id: requestId,
    contactTag: args.tag,
    amount: Number(args.amountDisplay),
    asset: token.symbol,
    direction: "outgoing",
    status: "pending",
    note: args.note,
    createdAt: Date.now(),
    kind: "contact",
    tokenAddress: token.address,
    amountAtomic,
    tokenDecimals: token.decimals,
    networkId: wallet.networkId,
  })
}

export type ContactPayRequest = {
  id: string
  source?: "link"
  requesterPin?: string
}

type RunContactPayArgs =
  | {
      mode: "send"
      session: Session
      tag: string
      senderTag: string
      amountDisplay: string
      note?: string
      request?: ContactPayRequest
      saveUnsavedRequester?: boolean
    }
  | {
      mode: "request"
      session: Session
      tag: string
      senderTag: string
      amountDisplay: string
      note?: string
    }

/** Confirm-CTA body: send or request, then fulfill if this send closes a request. */
export async function runContactPay(
  args: RunContactPayArgs,
  onStage: (stage: PayStage) => void,
): Promise<{ txHash?: string }> {
  if (args.mode === "send") {
    const { txHash } = await sendToContact(
      args.session,
      {
        tag: args.tag,
        senderTag: args.senderTag,
        amountDisplay: args.amountDisplay,
        requesterPin: args.request?.requesterPin,
        note: args.note,
        requestId: args.request?.id,
        saveContact: !!args.request && args.saveUnsavedRequester,
      },
      onStage,
    )
    return { txHash }
  }
  onStage("submitting")
  await requestFromContact(args.session, {
    tag: args.tag,
    requesterTag: args.senderTag,
    amountDisplay: args.amountDisplay,
    note: args.note,
  })
  return {}
}
