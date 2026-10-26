import { NO_FROM } from "@aztec/aztec.js/account"
import type { AztecNode } from "@aztec/aztec.js/node"
import type { Contract, SimulateInteractionOptions } from "@aztec/aztec.js/contracts"
import { AztecAddress, EthAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { InboxContract } from "@aztec/ethereum/contracts"
import type { ViemClient } from "@aztec/ethereum/types"
import { OxidePortalAbi, OxidePortalContract } from "@oxide/l1-contracts"
import { resolveFreezeArchive } from "@oxide/oxide-client/archive_ref.js"
import {
  classifyDepositRefund,
  type DepositInbox,
} from "@oxide/oxide-client/deposit_refund_eligibility.js"
import type {
  DepositSpendMetadata,
  NullificationEffectData,
  SpendMetadataResolver,
} from "@oxide/oxide-client/token_operations_collector.js"
import { computeNoteNullifier } from "@oxide/oxide-lib/hash.js"
import { L1OperationCondition } from "@oxide/oxide-lib/l1_operation_calldata.js"
import { MAX_FROZEN_NOTES_PER_REFUND, TX_AMOUNT_CAP } from "@oxide/oxide-lib/oxide_constants.gen.js"
import type { InboxMessageSource } from "@oxide/oxide-client/inbox_sibling_path.js"
import { buildPlainExecutorCall } from "@oxide/oxide-lib/plain_withdrawal.js"
import {
  deriveRefundOwnerAddress,
  type RefundOwner,
} from "@oxide/oxide-lib/refund_authorization.js"
import type { TeeSigner } from "@oxide/oxide-lib/types.js"
import {
  erc20Abi,
  keccak256,
  parseEventLogs,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import { chunkedContractEvents } from "./l1Logs.js"
import type { FrozenDepositDescriptor, OxideEnvTuple } from "@obsidion/core/types"
import type { ObsidionWallet } from "../obsidion/ObsidionWallet.js"
import type { ObsidionAccount } from "../obsidion/alpha/account/ObsidionAccount.js"
import {
  WebAuthnAlphaAuthProvider,
  type SignChallengeOptions,
  type WebAuthnSignResult,
} from "../obsidion/alpha/auth/WebAuthnAlphaAuthProvider.js"
import {
  FrozenMetadataMigrationSource,
  type FrozenMigrationRuntime,
  type FrozenRefundCandidates,
  type FrozenRefundSelection,
  selectFrozenBatch,
} from "./FrozenMetadataMigrationSource.js"
import type { LiveMetadataMigrationSourceOptions } from "./LiveMetadataMigrationSource.js"
import { TokenService } from "./TokenService.js"

/** The Aztec major version this runtime proves refunds for. Older sources need their own SDK realm. */
const SOURCE_AZTEC_MAJOR = "5"

/** The source PXE a fresh scan syncs before it may establish completion. */
type SourcePxe = Pick<ObsidionWallet["pxe"], "sync" | "getSyncedBlockHeader">

/** The source rollup's L1 Inbox: the classifier's reads, the sibling path's, and its tree state. */
type SourceInbox = DepositInbox & InboxMessageSource & Pick<InboxContract, "getState">

/** A payment link's escrow the account created, as the owner its notes refund under. */
export interface FrozenEscrow {
  owner: RefundOwner
  resolveSpendMetadata: SpendMetadataResolver
}

interface Options {
  node: AztecNode
  pxe: SourcePxe
  token: Contract
  portal: OxidePortalContract
  inbox: SourceInbox
  rollup: Address
  rollupVersion: bigint
  owner: RefundOwner
  resolveSpendMetadata: SpendMetadataResolver
  depositMetadata: DepositSpendMetadata
  /** The owner's swept deposits on the source portal. A failed or partial scan must throw. */
  depositDescriptors(opts: { fresh: boolean }): Promise<FrozenDepositDescriptor[]>
  /** The account's payment link escrows on the source rollup. A failed or partial scan must throw. */
  escrows?(opts: { fresh: boolean }): Promise<FrozenEscrow[]>
  teeSigner: TeeSigner
  /** The source deployment's plain withdrawal executor; it pays the tip and forwards the rest. */
  executor: EthAddress
  withdrawalSubsidy?: EthAddress
  /** Paid the relayer tip: the destination's operation executor, which forwards it to the relayer. */
  tipRecipient: EthAddress
}

/** The alpha account's passkey as the owner a frozen refund authorizes with. */
export type RefundChallengeSigner = (
  challenge: Buffer,
  opts?: SignChallengeOptions,
) => Promise<WebAuthnSignResult>

/** `wrapSigner` lets the host reuse an approval it saved for the same challenge. */
export async function passkeyRefundOwner(
  wallet: ObsidionWallet,
  account: ObsidionAccount,
  wrapSigner: (sign: RefundChallengeSigner) => RefundChallengeSigner = (sign) => sign,
): Promise<RefundOwner> {
  const auth = account.getAuthProvider()
  if (!(auth instanceof WebAuthnAlphaAuthProvider))
    throw new Error("A frozen refund is authorized with the account's passkey")
  const signChallenge = wrapSigner((challenge, opts) => auth.signChallenge(challenge, opts))
  const address = account.getAddress()
  const instance = await wallet.pxe.getContractInstance(address)
  if (!instance) throw new Error("The account instance is not registered in this PXE")
  const [x, y] = await auth.getPubkeys()
  const owner: RefundOwner = {
    address,
    publicKeys: instance.publicKeys,
    instance: {
      contractClassId: instance.originalContractClassId,
      salt: instance.salt,
      initializationHash: instance.initializationHash,
      deployer: instance.deployer,
    },
    authorizer: {
      kind: "passkey",
      signer: {
        publicKey: { x, y },
        sign: async (message) => {
          const signed = await signChallenge(message.toBuffer())
          return {
            authenticatorData: Buffer.from(signed.authenticatorData),
            clientDataJSON: Buffer.from(signed.clientDataJSON),
            signature: Buffer.from(signed.signature),
          }
        },
      },
    },
  }
  if (!(await deriveRefundOwnerAddress(owner)).equals(address))
    throw new Error("The account's passkey does not derive its address")
  return owner
}

/**
 * Oxide's refund modules embed the three refund circuits (about 1.8 MB together), so they and the
 * circuit artifacts load with the first frozen source rather than with the SDK.
 */
const refundCalldata = () => import("@oxide/oxide-client/atlatl/process_refund_requests.js")

// A scan's concurrent reads share one import: vitest hands concurrent imports of a mocked module
// the real one.
let frozenNotes: Promise<typeof import("@oxide/oxide-client/frozen_notes.js")> | undefined

/** The owner's frozen notes that are still refundable, keyed by refund nullifier. */
export async function readRefundableFrozenNotes(o: {
  portal: OxidePortalContract
  token: Contract
  node: AztecNode
  owner: AztecAddress
  resolveSpendMetadata: SpendMetadataResolver
  /** How to reach the notes of an owner with no account entrypoint. */
  simulateOptions?: SimulateInteractionOptions
}) {
  frozenNotes ??= import("@oxide/oxide-client/frozen_notes.js")
  const { getRefundableFrozenNotes } = await frozenNotes
  const notes = await getRefundableFrozenNotes(
    o.portal,
    o.token,
    o.node,
    o.owner,
    o.resolveSpendMetadata,
    undefined,
    o.simulateOptions,
  )
  return Promise.all(
    notes.map(async (note) => ({
      note,
      id: (
        await computeNoteNullifier(
          note.provenNoteHash,
          o.token.address,
          (
            await o.resolveSpendMetadata(note)
          ).masterNullifierHidingKey,
        )
      ).toString(),
    })),
  )
}

/** The escrows' frozen notes that are still refundable, keyed by refund nullifier. */
export async function readRefundableEscrowNotes(o: {
  portal: OxidePortalContract
  token: Contract
  node: AztecNode
  escrows: FrozenEscrow[]
}) {
  const read = await Promise.all(
    o.escrows.map(async (escrow) => {
      const owner = escrow.owner.address
      const notes = await readRefundableFrozenNotes({
        ...o,
        owner,
        resolveSpendMetadata: escrow.resolveSpendMetadata,
        simulateOptions: { from: NO_FROM, additionalScopes: [owner] },
      })
      return notes.map((note) => ({ ...note, escrow }))
    }),
  )
  return read.flat()
}

/**
 * The owner's deposits that the frozen portal can still refund, keyed by refund nullifier. A deposit
 * an L2 transaction claimed before the freeze drops: its notes are frozen notes. Any classifier
 * error propagates, so a scan never reads as empty.
 *
 * An unprocessed deposit `waits` while its Inbox tree is open: the portal checks the Inbox's live
 * root, so any later message into that tree would make a refund built now unexecutable.
 */
export async function readRefundableFrozenDeposits(o: {
  portal: OxidePortalContract
  inbox: SourceInbox
  node: AztecNode
  depositMetadata: DepositSpendMetadata
  descriptors: FrozenDepositDescriptor[]
}) {
  if (!o.descriptors.length) return []
  const archive = await resolveFreezeArchive(o.portal, o.node)
  const classified = await Promise.all(
    o.descriptors.map(async (descriptor) => ({
      descriptor,
      ...(await classifyDepositRefund(
        o.portal,
        o.inbox,
        o.node,
        {
          messageKey: Fr.fromString(descriptor.messageKey),
          messageLeafIndex: BigInt(descriptor.messageLeafIndex),
          l1BlockNumber: BigInt(descriptor.l1BlockNumber),
          sharedSecretSalt: Fr.fromString(descriptor.sharedSecretSalt),
          amount: BigInt(descriptor.amount),
          recipient: o.depositMetadata.ownerAddressPreimage,
          recipientMasterNullifierHidingKey: o.depositMetadata.masterNullifierHidingKey,
        },
        archive,
      )),
    })),
  )
  const seen = new Set<string>()
  const out: Array<{
    id: string
    kind: "frozen-deposit" | "unprocessed-deposit"
    descriptor: FrozenDepositDescriptor
    waits: boolean
  }> = []
  let inProgress: bigint | undefined
  for (const { descriptor, kind, nullifier } of classified) {
    const id = nullifier.toString()
    if ((kind !== "frozen-deposit" && kind !== "unprocessed-deposit") || seen.has(id)) continue
    seen.add(id)
    let waits = false
    if (kind === "unprocessed-deposit") {
      inProgress ??= (await o.inbox.getState()).treeInProgress
      waits = inProgress <= (await inboxCheckpoint(o.inbox, descriptor))
    }
    out.push({ id, kind, descriptor, waits })
  }
  return out
}

/** The Inbox tree a deposit's message went into, read from its own `MessageSent`. */
async function inboxCheckpoint(inbox: SourceInbox, descriptor: FrozenDepositDescriptor) {
  const block = BigInt(descriptor.l1BlockNumber)
  const sent = (await inbox.getMessageSentEvents(block, block)).find((log) =>
    log.args.leaf.equals(Fr.fromString(descriptor.messageKey)),
  )
  if (!sent) throw new Error("The L1 Inbox has no message for the deposit in its L1 block")
  return BigInt(sent.args.checkpointNumber)
}

/**
 * Brings the source PXE to its node's tip. A sync that resolves behind it is an incomplete scan: the
 * block stream swallows its own failures, and an old anchor reads fewer events and notes.
 */
export async function syncSourcePxe(o: {
  node: Pick<AztecNode, "getBlockNumber">
  pxe: SourcePxe
  rollupVersion: bigint
}) {
  const tip = await o.node.getBlockNumber()
  await o.pxe.sync()
  const header = await o.pxe.getSyncedBlockHeader()
  if (
    header.globalVariables.blockNumber < tip ||
    header.globalVariables.version.toBigInt() !== o.rollupVersion
  )
    throw new Error("The source wallet did not sync to the source rollup's tip")
}

/** Whether `portal` is frozen: its rollup is retired, and funds leave it only by refund. */
export function isPortalFrozen(client: unknown, portal: Address): Promise<boolean> {
  return new OxidePortalContract(client as ViemClient, portal).isFrozen()
}

async function depositInbox(client: ViemClient, portal: OxidePortalContract) {
  return new InboxContract(client, await portal.getInbox())
}

/**
 * What the account can still refund from a frozen source portal, or `undefined` while it is live. A
 * refund pays on L1 and leaves the L2 notes in place, so the token balance overstates a frozen source.
 */
export async function frozenSourceSummary(o: {
  client: unknown
  wallet: ObsidionWallet
  account: ObsidionAccount
  tuple: OxideEnvTuple
  /** Read only once the portal is known frozen. */
  depositDescriptors: () => Promise<FrozenDepositDescriptor[]>
  /** The account's payment link escrows; read only once the portal is known frozen. */
  escrows?: () => Promise<FrozenEscrow[]>
}): Promise<
  | { notes: bigint; links: bigint; deposits: number; waiting: number; waitingAmount: bigint }
  | undefined
> {
  const client = o.client as ViemClient
  const portal = new OxidePortalContract(client, o.tuple.portal as Address)
  if (!(await portal.isFrozen())) return undefined
  await syncSourcePxe({
    node: o.wallet.node,
    pxe: o.wallet.pxe,
    rollupVersion: await portal.getRollupVersion(),
  })
  const tokenService = await TokenService.create(
    o.wallet,
    o.account,
    AztecAddress.fromStringUnsafe(o.tuple.l2Token),
  )
  const token = await tokenService.getTokenContract()
  // Inputs resolve before any read starts, so a failing input leaves no read unhandled.
  const resolveSpendMetadata = await o.account.makeSpendMetadataResolver()
  const escrows = (await o.escrows?.()) ?? []
  const inbox = await depositInbox(client, portal)
  const depositMetadata = await (
    await o.account.makeDepositSpendMetadataResolver()
  )(o.account.getAddress())
  const descriptors = await o.depositDescriptors()
  const [notes, links, deposits] = await Promise.all([
    readRefundableFrozenNotes({
      portal,
      token,
      node: o.wallet.node,
      owner: o.account.getAddress(),
      resolveSpendMetadata,
    }),
    readRefundableEscrowNotes({ portal, token, node: o.wallet.node, escrows }),
    readRefundableFrozenDeposits({
      portal,
      inbox,
      node: o.wallet.node,
      depositMetadata,
      descriptors,
    }),
  ])
  return {
    notes: notes.reduce((sum, { note }) => sum + note.amount.toBigInt(), 0n),
    links: links.reduce((sum, { note }) => sum + note.amount.toBigInt(), 0n),
    deposits: deposits.filter((d) => !d.waits).length,
    waiting: deposits.filter((d) => d.waits).length,
    waitingAmount: deposits
      .filter((d) => d.waits)
      .reduce((sum, d) => sum + BigInt(d.descriptor.amount), 0n),
  }
}

/** Current-generation refund adapter. Older source generations must run their own SDK realm. */
export class FrozenRefundMigrationRuntime implements FrozenMigrationRuntime {
  readonly identity: string
  private descriptors?: Promise<FrozenDepositDescriptor[]>
  private escrows?: Promise<FrozenEscrow[]>

  constructor(private readonly o: Options) {
    this.identity = keccak256(
      toHex(
        JSON.stringify({
          generation: `aztec-${SOURCE_AZTEC_MAJOR}`,
          portal: o.portal.address.toString(),
          rollup: o.rollup,
          version: String(o.rollupVersion),
          token: o.token.address.toString(),
          owner: o.owner.address.toString(),
          executor: o.executor.toString(),
        }),
      ),
    )
  }

  async validate(destinationAsset: Address): Promise<void> {
    const o = this.o
    const circuits = await Promise.all([
      import("@oxide/refund-proof/frozen_notes_refund/artifact.js").then((m) => m.RefundCircuit),
      import("@oxide/refund-proof/frozen_deposit_refund/artifact.js").then(
        (m) => m.FrozenDepositRefundCircuit,
      ),
      import("@oxide/refund-proof/unprocessed_deposit_refund/artifact.js").then(
        (m) => m.UnprocessedDepositRefundCircuit,
      ),
    ])
    if (circuits.some((circuit) => typeof circuit.bytecode !== "string"))
      throw new Error(
        "A frozen refund circuit is a build stub: run `pnpm --filter @obsidion/oxide-build build:refund-circuits`",
      )
    if (!o.owner.address.equals(o.depositMetadata.ownerAddressPreimage.address))
      throw new Error("The refund owner is not the deposit recipient")
    const [info, token, rollup, version, asset, frozen] = await Promise.all([
      o.node.getNodeInfo(),
      o.portal.getL2Portal(),
      o.portal.getRollup(),
      o.portal.getRollupVersion(),
      o.portal.getUnderlying(),
      o.portal.isFrozen(),
    ])
    if (
      info.nodeVersion.replace(/^v/, "").split(".")[0] !== SOURCE_AZTEC_MAJOR ||
      !frozen ||
      !token.equals(o.token.address) ||
      rollup.toString().toLowerCase() !== o.rollup.toLowerCase() ||
      !rollup.equals(info.l1ContractAddresses.rollupAddress) ||
      version !== o.rollupVersion ||
      BigInt(info.rollupVersion) !== version ||
      asset.toString().toLowerCase() !== destinationAsset.toLowerCase()
    ) {
      throw new Error(
        "Frozen source does not match its pinned proof generation or destination funding asset",
      )
    }
  }

  /** Brings the source PXE to the node's tip; a sync that resolves behind it is an incomplete scan. */
  private readDescriptors(fresh: boolean) {
    if (fresh || !this.descriptors) {
      const pending = this.o.depositDescriptors({ fresh })
      pending.catch(() => {
        if (this.descriptors === pending) this.descriptors = undefined
      })
      this.descriptors = pending
    }
    return this.descriptors
  }

  private readEscrows(fresh: boolean) {
    if (fresh || !this.escrows) {
      const pending = this.o.escrows?.({ fresh }) ?? Promise.resolve([])
      pending.catch(() => {
        if (this.escrows === pending) this.escrows = undefined
      })
      this.escrows = pending
    }
    return this.escrows
  }

  private notes() {
    return readRefundableFrozenNotes({ ...this.o, owner: this.o.owner.address })
  }

  private async escrowNotes(fresh = false) {
    return readRefundableEscrowNotes({ ...this.o, escrows: await this.readEscrows(fresh) })
  }

  private async deposits(fresh = false) {
    return readRefundableFrozenDeposits({
      ...this.o,
      descriptors: await this.readDescriptors(fresh),
    })
  }

  async candidates(opts: { fresh?: boolean } = {}): Promise<FrozenRefundCandidates> {
    if (opts.fresh) await syncSourcePxe(this.o)
    const [notes, all, escrowNotes] = await Promise.all([
      this.notes(),
      this.deposits(!!opts.fresh),
      this.escrowNotes(!!opts.fresh),
    ])
    const deposits = all.filter((d) => !d.waits)
    return {
      maxNotesPerBatch: MAX_FROZEN_NOTES_PER_REFUND,
      maxBatchAmount: TX_AMOUNT_CAP,
      waiting: all.filter((d) => d.waits).reduce((sum, d) => sum + BigInt(d.descriptor.amount), 0n),
      candidates: [
        ...notes.map(({ id, note }) => ({
          id,
          amount: String(note.amount.toBigInt()),
          kind: "note" as const,
        })),
        ...escrowNotes.map(({ id, note, escrow }) => ({
          id,
          amount: String(note.amount.toBigInt()),
          kind: "escrow-note" as const,
          owner: escrow.owner.address.toString(),
        })),
        ...deposits.map(({ id, kind, descriptor }) => ({ id, amount: descriptor.amount, kind })),
      ],
    }
  }

  private executorCall(recipient: Address, relayerTip: bigint) {
    const o = this.o
    return buildPlainExecutorCall({
      executor: o.executor,
      recipient: EthAddress.fromString(recipient),
      relayerTip,
      tipRecipient: o.tipRecipient,
      withdrawalSubsidy: o.withdrawalSubsidy,
    })
  }

  async build({ kind, ids }: FrozenRefundSelection, recipient: Address, relayerTip: bigint) {
    const o = this.o
    const ctx = { portal: o.portal, chain: o.node, signer: o.teeSigner, l2Token: o.token.address }
    let amount: bigint
    let calldata: `0x${string}`
    if (kind === "note" || kind === "escrow-note") {
      if (
        !ids.length ||
        ids.length > MAX_FROZEN_NOTES_PER_REFUND ||
        new Set(ids).size !== ids.length
      ) {
        throw new Error("Invalid frozen refund selection")
      }
      const candidates: Array<{
        id: string
        note: NullificationEffectData
        escrow?: FrozenEscrow
      }> = kind === "note" ? await this.notes() : await this.escrowNotes()
      const available = new Map(candidates.map((c) => [c.id, c]))
      const picked = ids.map((id) => {
        const candidate = available.get(id)
        if (!candidate) throw new Error("A selected frozen note is no longer refundable")
        return candidate
      })
      // The circuit and the enclave refund one owner's notes at a time.
      const escrow = picked[0]!.escrow
      if (picked.some((c) => c.escrow !== escrow))
        throw new Error("A frozen refund selection spans payment links")
      const notes = picked.map((c) => c.note)
      amount = notes.reduce((sum, note) => sum + note.amount.toBigInt(), 0n)
      if (relayerTip < 0n || amount <= relayerTip)
        throw new Error("Frozen refund cannot cover its relayer tip")
      const { buildRefundFrozenNotesPortalCalldata } = await refundCalldata()
      calldata = await buildRefundFrozenNotesPortalCalldata(ctx, {
        executorCall: this.executorCall(recipient, relayerTip),
        notesToRefund: notes,
        owner: escrow?.owner ?? o.owner,
        resolveSpendMetadata: escrow?.resolveSpendMetadata ?? o.resolveSpendMetadata,
      })
    } else {
      const deposit =
        ids.length === 1 &&
        (await this.deposits()).find((d) => !d.waits && d.id === ids[0] && d.kind === kind)
      if (!deposit) throw new Error("The selected frozen deposit is no longer refundable")
      const { descriptor } = deposit
      amount = BigInt(descriptor.amount)
      if (relayerTip < 0n || amount <= relayerTip)
        throw new Error("Frozen refund cannot cover its relayer tip")
      const refund = {
        executorCall: this.executorCall(recipient, relayerTip),
        amount,
        sharedSecretSalt: Fr.fromString(descriptor.sharedSecretSalt),
        l2Recipient: o.owner,
        l2RecipientMasterNullifierHidingKey: o.depositMetadata.masterNullifierHidingKey,
        messageLeafIndex: BigInt(descriptor.messageLeafIndex),
      }
      const {
        buildRefundFrozenDepositPortalCalldata,
        buildRefundUnprocessedDepositPortalCalldata,
      } = await refundCalldata()
      calldata =
        deposit.kind === "frozen-deposit"
          ? await buildRefundFrozenDepositPortalCalldata(ctx, {
              ...refund,
              messageKey: Fr.fromString(descriptor.messageKey),
            })
          : await buildRefundUnprocessedDepositPortalCalldata(ctx, {
              ...refund,
              l1BlockNumber: BigInt(descriptor.l1BlockNumber),
              inbox: o.inbox,
            })
    }
    return {
      amount,
      operation: {
        target: o.portal.address,
        payoutToken: await o.portal.getUnderlying(),
        calldata: Buffer.from(calldata.slice(2), "hex"),
        condition: L1OperationCondition.immediate(),
      },
    }
  }

  /** Refund nullifiers of the account's frozen notes, its escrows' included, that L1 refunded. */
  async refundedNoteIds(): Promise<string[]> {
    // The reader drops a note L1 refunded: through a portal that reports none, it lists them all.
    const portal = Object.assign(Object.create(this.o.portal), {
      isRefundNullifierSpent: async () => false,
    }) as OxidePortalContract
    const [notes, escrowNotes] = await Promise.all([
      readRefundableFrozenNotes({ ...this.o, portal, owner: this.o.owner.address }),
      readRefundableEscrowNotes({ ...this.o, portal, escrows: await this.readEscrows(false) }),
    ])
    const ids = [...notes, ...escrowNotes].map(({ id }) => id)
    const spent = await Promise.all(
      ids.map((id) => this.o.portal.isRefundNullifierSpent(Fr.fromString(id))),
    )
    return ids.filter((_, i) => spent[i])
  }

  /**
   * The note refunds L1 already paid this account since `fromBlock`, from the portal's logs. A batch
   * logs its first note's refund nullifier; its recipient is what the executor paid.
   */
  async refundsSent(client: PublicClient, fromBlock: bigint) {
    const ids = await this.refundedNoteIds()
    if (!ids.length) return []
    const executor = this.o.executor.toString().toLowerCase()
    const logs = (await chunkedContractEvents(
      client,
      {
        address: this.o.portal.address.toString() as Address,
        abi: OxidePortalAbi,
        eventName: "WithdrawalOrRefund",
        args: { nullifier: ids.map((id) => toHex(BigInt(id), { size: 32 })) },
      },
      fromBlock,
      await client.getBlockNumber(),
    )) as Array<{ transactionHash: Hex; blockNumber: bigint; args: { executionAmount: bigint } }>
    return Promise.all(
      logs.map(async (log) => {
        const receipt = await client.getTransactionReceipt({ hash: log.transactionHash })
        const paid = parseEventLogs({
          abi: erc20Abi,
          eventName: "Transfer",
          logs: receipt.logs,
        }).find((transfer) => transfer.args.from.toLowerCase() === executor)
        return {
          hash: log.transactionHash,
          amount: log.args.executionAmount,
          recipient: paid?.args.to,
          blockNumber: log.blockNumber,
        }
      }),
    )
  }

  async refunded(ids: string[]): Promise<boolean> {
    return (
      ids.length > 0 &&
      (
        await Promise.all(ids.map((id) => this.o.portal.isRefundNullifierSpent(Fr.fromString(id))))
      ).every(Boolean)
    )
  }
}

/** Select from actual portal state; never freezes a live source to reuse the refund path. */
export async function createLocalMetadataMigrationSource(
  options: LiveMetadataMigrationSourceOptions & {
    teeSigner: TeeSigner
    /** The account on the source's rollup; on one rollup it is the destination's. */
    sourceChain?: { wallet: ObsidionWallet; account: ObsidionAccount }
    /** The source account's swept deposits on the source portal, read on the source rollup. */
    depositDescriptors(opts: { fresh: boolean }): Promise<FrozenDepositDescriptor[]>
    /** The source account's payment link escrows, registered in the source chain's wallet. */
    escrows?(opts: { fresh: boolean }): Promise<FrozenEscrow[]>
    wrapRefundSigner?: (sign: RefundChallengeSigner) => RefundChallengeSigner
  } & Pick<ConstructorParameters<typeof FrozenMetadataMigrationSource>[0], "depositSettled">,
) {
  const client = options.client as unknown as ViemClient
  const tuple = options.source.tuple
  if (!(await new OxidePortalContract(client, tuple.portal as Address).isFrozen())) {
    const { LiveMetadataMigrationSource } = await import("./LiveMetadataMigrationSource.js")
    return new LiveMetadataMigrationSource(options)
  }
  const destination = new OxidePortalContract(client, options.destination.portal)
  return new FrozenMetadataMigrationSource({
    ...options,
    destinationAsset: (await destination.getUnderlying()).toString() as Address,
    runtime: await createFrozenRefundRuntime({
      client,
      tuple,
      chain: options.sourceChain ?? { wallet: options.wallet, account: options.account },
      token: await options.source.tokenService.getTokenContract(),
      teeSigner: options.teeSigner,
      depositDescriptors: options.depositDescriptors,
      escrows: options.escrows,
      wrapRefundSigner: options.wrapRefundSigner,
      tipRecipient: EthAddress.fromString(options.destination.operationExecutor),
    }),
  })
}

/** The refund runtime for `tuple`'s frozen portal and `chain`'s account on its rollup. */
export async function createFrozenRefundRuntime(o: {
  client: unknown
  tuple: OxideEnvTuple
  chain: { wallet: ObsidionWallet; account: ObsidionAccount }
  token: Contract
  teeSigner: TeeSigner
  depositDescriptors: Options["depositDescriptors"]
  escrows?: Options["escrows"]
  wrapRefundSigner?: (sign: RefundChallengeSigner) => RefundChallengeSigner
  tipRecipient: EthAddress
}) {
  const { tuple, chain } = o
  if (!tuple.plainWithdrawalExecutor)
    throw new Error("The frozen source has no withdrawal executor")
  const client = o.client as ViemClient
  const portal = new OxidePortalContract(client, tuple.portal as Address)
  const info = await chain.wallet.node.getNodeInfo()
  return new FrozenRefundMigrationRuntime({
    node: chain.wallet.node,
    pxe: chain.wallet.pxe,
    token: o.token,
    portal,
    inbox: await depositInbox(client, portal),
    rollup: info.l1ContractAddresses.rollupAddress.toString() as Address,
    rollupVersion: BigInt(info.rollupVersion),
    owner: await passkeyRefundOwner(chain.wallet, chain.account, o.wrapRefundSigner),
    resolveSpendMetadata: await chain.account.makeSpendMetadataResolver(),
    depositMetadata: await (
      await chain.account.makeDepositSpendMetadataResolver()
    )(chain.account.getAddress()),
    depositDescriptors: o.depositDescriptors,
    escrows: o.escrows,
    teeSigner: o.teeSigner,
    executor: EthAddress.fromString(tuple.plainWithdrawalExecutor),
    withdrawalSubsidy: tuple.withdrawalSubsidy
      ? EthAddress.fromString(tuple.withdrawalSubsidy)
      : undefined,
    tipRecipient: o.tipRecipient,
  })
}

/**
 * The next refund of a frozen portal that `recipient` submits itself, paid to it in full: no relayer
 * tip, so the runtime must name `recipient` as its tip recipient to take the deployment's subsidy.
 * None once nothing refundable is left; `waiting` is what the portal cannot refund yet.
 */
export async function nextFrozenSelfRefund(
  runtime: Pick<FrozenMigrationRuntime, "candidates" | "build">,
  recipient: Address,
  opts: { fresh?: boolean } = {},
) {
  const candidates = await runtime.candidates(opts)
  const waiting = candidates.waiting ?? 0n
  const remaining = candidates.candidates.reduce((sum, c) => sum + BigInt(c.amount), 0n)
  const batch = selectFrozenBatch({ ...candidates, minimumNetAmount: 1n, tip: 0n })
  if (!batch) return { remaining, waiting }
  const { amount, operation } = await runtime.build(batch, recipient, 0n)
  return {
    remaining,
    waiting,
    refund: {
      ids: batch.ids,
      amount,
      to: operation.target.toString() as Address,
      data: toHex(operation.calldata),
    },
  }
}
