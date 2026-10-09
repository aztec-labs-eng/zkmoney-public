/**
 * Send + request rails to a saved contact. Send is a ClaimFPC-sponsored
 * `TokenService.sendTokenSponsored` — the same gasless rail as withdraw and paylink, so a first-ever
 * send folds the subscription (and account setup) into its own batch; the recipient discovers the
 * transfer from the chain (`Transfer.meta` carries tag / memo / request id). Request is an XMTP
 * announce, persisted to RequestStorage only on confirmed delivery.
 */
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { Fr } from "@aztec/aztec.js/fields"
import {
  ContractService,
  nextOperationId,
  type ObsidionAccount,
  type ObsidionWallet,
  type TokenService,
} from "@obsidion/sdk"
import {
  ContactStorage,
  RequestStorage,
  getActiveNetworkId,
  RequestBroadcaster,
  TransactionStorage,
  trackSubmission,
  TxInFlightError,
  resolveAssetConstants,
  type TokenTransaction,
  type Transaction,
} from "@obsidion/front-core"
import { parseUnits } from "viem"
import { QueueStatus } from "@obsidion/core/constants"
import { getConfig } from "../../config/env"
import { isFlowCancelled, runOperation } from "../operations/operations"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import {
  getXmtpSender,
  getXmtpUiState,
  xmtpUnavailableMessage,
} from "../../platform/xmtp/xmtpLifecycle"
import { maybeRefuelFpc } from "../fees/fpcRefuel"
import { claimSponsorContext, noteSubscribed } from "../onboarding/claimSponsorship"
import { RAIL_REGISTERED } from "../onboarding/rails"
import { resolveTagForCommit } from "./registryResolution"
import { markRequestPaidById } from "./requestActions"

export type PayStage = "resolving" | "proving" | "submitting"

export interface ContactPayDeps {
  wallet: ObsidionWallet
  account: ObsidionAccount
  tokenService: TokenService
  contractService: ContractService
}

/**
 * The rollup address front-core published at boot — the wire value a receiver compares
 * (`packet.networkId !== rollupAddress` drops the packet). Every pay surface mounts post-boot.
 */
function networkId(): string {
  return getActiveNetworkId()!
}

async function resolveContact(tag: string) {
  const resolved = await resolveTagForCommit(tag)
  if (resolved.status !== "resolved") {
    throw new Error(
      resolved.status === "staleRollup"
        ? `@${tag} hasn't upgraded to the current network yet`
        : `@${tag} is no longer registered`,
    )
  }
  return resolved
}

/**
 * Send `amountDisplay` to the contact's registry-resolved L2 address and wait for the mine. The
 * recipient discovers it from the chain — the send carries the sender tag / memo / request id in
 * `Transfer.meta`.
 *
 * The transaction row is written before the proof rather than after the mine, and advanced in
 * place, because the screen can close mid-flight and the contact chat is where the user lands. Its
 * three states are the tx's own: no hash while proving, the real hash the wallet emits at `Mining`
 * (computed from the proven tx just before submission) once it is in the mempool, then `success`.
 * The chat draws them as a spinner, one tick, two ticks.
 */
export function sendToContact(
  deps: ContactPayDeps,
  args: {
    tag: string
    senderTag: string
    amountDisplay: string
    expectedL2Address?: string
    note?: string
    /** Payment request this send fulfills; rides the on-chain `Transfer.meta`. */
    requestId?: string
    /**
     * Save the resolved tag as a contact. It is saved as `autoAdded` before the row is written, so
     * the send shows its name, and becomes a contact for requests only once the send lands.
     */
    saveContact?: boolean
  },
  onStage: (stage: PayStage) => void,
): Promise<{ txHash: string }> {
  // Correlates the TEE and prove benchmark legs → one tx_timing analytics event, and keys the row
  // this send advances (there is no txHash to key it by until the wallet reaches Mining).
  const operationId = nextOperationId("send")
  return runOperation(
    { operationId, flow: "send", summary: `$${args.amountDisplay} to @${args.tag}` },
    () => sendToContactFlow(operationId, deps, args, onStage),
    (r) => r.txHash,
  )
}

async function sendToContactFlow(
  operationId: string,
  deps: ContactPayDeps,
  args: {
    tag: string
    senderTag: string
    amountDisplay: string
    expectedL2Address?: string
    note?: string
    /** Payment request this send fulfills; rides the on-chain `Transfer.meta`. */
    requestId?: string
    saveContact?: boolean
  },
  onStage: (stage: PayStage) => void,
): Promise<{ txHash: string }> {
  onStage("resolving")
  const resolved = await resolveContact(args.tag)
  // requesterAddress pin from a v3 request link: the tag must still resolve to
  // the address the link was minted for, or the funds go to a re-registered tag.
  if (
    args.expectedL2Address &&
    resolved.l2Address.toLowerCase() !== args.expectedL2Address.toLowerCase()
  ) {
    throw new Error(`@${args.tag} no longer matches this payment request — payment cancelled`)
  }
  const contact = { name: args.tag, address: resolved.l2Address, verified: true, tag: args.tag }
  if (args.saveContact) {
    await ContactStorage.get()
      .addOrMergeContact({ ...contact, autoAdded: true })
      .catch(console.warn)
  }
  const [sponsor, token, resolveSpendMetadata] = await Promise.all([
    claimSponsorContext(deps, RAIL_REGISTERED),
    deps.tokenService.fetchTokenInformation(),
    deps.account.makeSpendMetadataResolver(),
  ])

  onStage("proving")
  const store = TransactionStorage.get(webStorage)
  const walletAsset = resolveAssetConstants(getConfig().network).DAI
  const rowToken = {
    address: token.address,
    name: token.name,
    symbol: token.symbol,
    decimals: token.decimals,
    logo: walletAsset.logo,
    price: walletAsset.price,
    amount: Number(args.amountDisplay),
  }
  const patchRow = (updater: (tx: Transaction) => void) =>
    store.updateTransaction((tx) => tx.queueId === operationId, updater)

  await store.addTokenTransaction(
    "send",
    rowToken,
    "pending",
    undefined,
    resolved.l2Address,
    operationId,
    undefined,
    args.note,
    args.tag,
  )
  // Lets the feed hide the request this send pays while the row is pending.
  if (args.requestId) {
    const requestId = args.requestId
    await patchRow((tx) => {
      ;(tx as TokenTransaction).requestId = requestId
    })
  }
  // A missing row saved nothing, so it must not read as saved.
  const submission = trackSubmission(operationId, async (txHash) => {
    const saved = await patchRow((tx) => {
      tx.txHash = txHash
      tx.detailedStatus = QueueStatus.MINING
    })
    if (!saved) throw new Error("send row missing")
  })

  // Resolves on the L2 receipt: the sponsored rail owns simulate/attest/prove/submit as one step,
  // so there is no pre-mine handle to broadcast against.
  let result
  try {
    result = await deps.tokenService.sendTokenSponsored(
      AztecAddress.fromStringUnsafe(resolved.l2Address),
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
      },
    )
  } catch (err) {
    // Failed only if the send never reached the node or a receipt says so; past the submit boundary
    // the row stays at MINING for ReorgMonitor to settle from the chain.
    const inFlight = await submission.survived(deps.wallet.node)
    if (inFlight) throw new TxInFlightError(inFlight, err)
    // A closed passkey prompt sent nothing: drop the row rather than leave a failed send behind.
    if (isFlowCancelled(err)) {
      await store.removeTransaction((tx) => tx.queueId === operationId).catch(() => {})
    } else {
      await patchRow((tx) => {
        tx.status = "failed"
        tx.detailedStatus = QueueStatus.FAILED
        tx.error = err instanceof Error ? err.message : String(err)
      }).catch(() => {})
    }
    throw err
  } finally {
    await submission.stop()
  }
  if (sponsor.subscribe) noteSubscribed(deps.account, sponsor.fpcAddress, sponsor.railId)
  maybeRefuelFpc({ ...deps, fpc: { address: sponsor.fpcAddress, artifact: sponsor.fpcArtifact } })
  const txHash = result.txHash
  onStage("submitting")

  // Mined: a failed write leaves the row at its hash for the chain to settle, not the send failed.
  await patchRow((tx) => {
    tx.status = "success"
    tx.txHash = txHash
    tx.detailedStatus = QueueStatus.SUCCESS
  }).catch(console.warn)
  if (args.saveContact) void ContactStorage.get().addEntry(contact).catch(console.warn)
  return { txHash }
}

/** Announce a payment request over XMTP and persist the outgoing row on delivery. */
export async function requestFromContact(
  deps: Pick<ContactPayDeps, "tokenService">,
  args: { tag: string; requesterTag: string; amountDisplay: string; note?: string },
): Promise<void> {
  const xmtp = getXmtpSender()
  if (!xmtp) {
    throw new Error(xmtpUnavailableMessage(getXmtpUiState()))
  }
  const resolved = await resolveContact(args.tag)
  const token = await deps.tokenService.fetchTokenInformation()
  // A field: the fulfilling send carries it in the on-chain `Transfer.meta`.
  const requestId = Fr.random().toString()
  const amountAtomic = parseUnits(args.amountDisplay, token.decimals).toString()

  const status = await new RequestBroadcaster(xmtp).announce({
    recipientXmtpAddress: resolved.xmtpAddress,
    requestId,
    requesterTag: args.requesterTag,
    amountAtomic,
    token: { address: token.address, symbol: token.symbol, decimals: token.decimals },
    networkId: networkId(),
    note: args.note,
  })
  if (status.status !== "sent") {
    throw new Error(
      status.status === "skipped"
        ? "This contact can't receive requests yet"
        : `Request delivery failed: ${status.reason}`,
    )
  }

  await RequestStorage.get().add({
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
    networkId: networkId(),
  })
}

export type ContactPayRequest = {
  id: string
  source?: "link"
  requesterAddress?: string
}

type RunContactPayArgs =
  | {
      mode: "send"
      deps: ContactPayDeps
      tag: string
      senderTag: string
      amountDisplay: string
      note?: string
      request?: ContactPayRequest
      saveUnsavedRequester?: boolean
    }
  | {
      mode: "request"
      deps: Pick<ContactPayDeps, "tokenService">
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
      args.deps,
      {
        tag: args.tag,
        senderTag: args.senderTag,
        amountDisplay: args.amountDisplay,
        expectedL2Address: args.request?.requesterAddress,
        note: args.note,
        requestId: args.request?.id,
        saveContact: !!args.request && args.saveUnsavedRequester,
      },
      onStage,
    )
    // Fire-and-forget: flip the local row (a link request has none). The
    // requester's row flips from the on-chain meta. An in-flight send throws past this on purpose:
    // `fulfilled` is terminal, so only a landed send may write it.
    if (args.request) void markRequestPaidById(args.request.id, txHash).catch(console.warn)
    return { txHash }
  }
  onStage("submitting")
  await requestFromContact(args.deps, {
    tag: args.tag,
    requesterTag: args.senderTag,
    amountDisplay: args.amountDisplay,
    note: args.note,
  })
  return {}
}
