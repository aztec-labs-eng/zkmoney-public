/**
 * The L1->L2 message oxide's NamePortal emits for a registered user, from the client side.
 *
 * `NamePortal.notify` reads the AccountRegistry's `nameOf` and attests that an L1 OxideAccount
 * holds a name. That is all the message says: it names no L2 address, so consuming one admits
 * nobody by itself — the gate derives the same account from a bootstrap key and takes that key's
 * signature over the L2 address being subscribed. Both message witnesses are public (the secret is
 * a published constant, the leaf index comes from the Inbox's `MessageSent` logs) and the key
 * re-derives from the master secret, so a wallet restored on a new device rebuilds the whole set.
 *
 * `notify` is permissionless and repeatable, so a message is not a one-shot admission ticket: a
 * second one for the same owner is equally consumable, which is how the rail re-opens after an FPC
 * roll or a rollup migration. The rail's one-subscription-per-identity nullifier is the limiter.
 *
 * MESSAGE LAYOUT: `abi.encodeWithSignature` over the handler signature — a 4-byte keccak selector
 * then 32-byte big-endian arguments — sha256-compressed to a field. `registration.nr` mirrors it,
 * and the pinned cross-language vector in both test suites is what keeps the two in step.
 */
import { Fr } from "@aztec/aztec.js/fields"
import type { AztecAddress } from "@aztec/stdlib/aztec-address"
import type { EthAddress } from "@aztec/foundation/eth-address"
import type { AztecNode } from "@aztec/aztec.js/node"
import { isL1ToL2MessageReady, waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging"
import { InboxContract } from "@aztec/ethereum/contracts"
import type { ViemClient } from "@aztec/ethereum/types"
import { keccak256 } from "@aztec/foundation/crypto/keccak"
import { sha256ToField } from "@aztec/foundation/crypto/sha256"
import { computeSecretHash } from "@aztec/stdlib/hash"
import {
  getNonNullifiedL1ToL2MessageWitness,
  L1Actor,
  L1ToL2Message,
  L2Actor,
} from "@aztec/stdlib/messaging"
import type { Hex, PublicClient } from "viem"
import type { InboxMessageSource } from "./inboxSiblingPath.js"

/** The L2-side handler signature the portal's message content commits to. */
const NAME_OWNERSHIP_SIGNATURE = "name_ownership_verified(address,bytes32)"

/**
 * The message's spending secret. PUBLIC BY DESIGN: it gates nothing — the message is a public
 * attestation about public L1 state, and what admits a user is the bootstrap signature the gate
 * checks beside it — and a secret would only cost the phone-in-the-ocean recovery.
 */
export const REGISTRATION_MESSAGE_SECRET = Fr.ZERO

/** Content of the message attesting that `owner` holds `nameHash`. Mirrored by `registration.nr`. */
export function nameOwnershipMessageContent(owner: EthAddress, nameHash: Buffer): Fr {
  if (nameHash.length !== 32) throw new Error("a name hash is 32 bytes")
  const selector = keccak256(Buffer.from(NAME_OWNERSHIP_SIGNATURE)).subarray(0, 4)
  return sha256ToField([Buffer.concat([selector, owner.toBuffer32(), nameHash])])
}

/** The deployment and L1 identity a message has to name to be this account's. */
export interface RegistrationMessageTarget {
  /** The ClaimFPC the message is addressed to — the gate consumes it as that contract. */
  fpc: AztecAddress
  /** The L1 NamePortal the gate's config pins as the only accepted sender. */
  namePortal: EthAddress
  /** The user's OxideAccount — what the portal attests about, and what the gate re-derives. */
  owner: EthAddress
  /** The name that account holds, as the registry stores it. */
  nameHash: Buffer
  /** Rollup version the message is bound to; a migration re-emits against the new one. */
  rollupVersion: number
}

/**
 * Where a found message stands: not yet imported into the L1-to-L2 tree (a subscribe cannot prove
 * against it), importable and unspent, or already consumed by this FPC (the account's note is what
 * sponsors from here on).
 */
export type RegistrationMessageStatus = "pending" | "consumable" | "consumed"

/** A registration message found in the Inbox. */
export interface RegistrationMessage {
  /** The gate's `message_leaf_index` witness. */
  leafIndex: bigint
  /** The Inbox leaf — what the readiness and consumption checks key on. */
  messageHash: Fr
  status: RegistrationMessageStatus
}

export type RegistrationMessageNode = Pick<
  AztecNode,
  | "getChainId"
  | "getBlockData"
  | "getL1ToL2MessageCheckpoint"
  | "getL1ToL2MessageMembershipWitness"
  | "findLeavesIndexes"
>

/** The canonical Inbox reader over an L1 client; `InboxMessageSource` is the slice the scan needs. */
export function registrationInbox(
  client: PublicClient,
  inbox: EthAddress | Hex,
): InboxMessageSource {
  return new InboxContract(client as unknown as ViemClient, inbox)
}

// Public RPCs cap eth_getLogs ranges (commonly 10k blocks or less), so the scan walks back from the
// head in chunks under that cap. A message worth looking for is recent: a held note makes the scan
// unnecessary, so only a just-registered (or just-migrated) user ever reaches it.
const SCAN_CHUNK_BLOCKS = 9_000n
const SCAN_CHUNK_BUDGET = 30

export interface FindRegistrationMessageOptions {
  /** Oldest L1 block worth scanning (e.g. the registry's deployment); defaults to genesis. */
  fromBlock?: bigint
  /** How many chunks back from the head to look before giving up. */
  chunkBudget?: number
}

/**
 * The account's newest name-ownership message, or undefined when none is within the scan window.
 *
 * An Inbox leaf is the hash of the whole message, index included, so there is no hash to filter
 * logs by: each candidate leaf is recomputed from the target instead, which binds sender, recipient,
 * rollup version and content at once — a message from another L1 address, to another ClaimFPC, or
 * about another account never produces this leaf. Newest first, so a re-emitted message wins over
 * a spent one.
 */
export async function findRegistrationMessage(
  inbox: InboxMessageSource,
  node: RegistrationMessageNode,
  target: RegistrationMessageTarget,
  opts: FindRegistrationMessageOptions = {},
): Promise<RegistrationMessage | undefined> {
  const chainId = await node.getChainId()
  const sender = new L1Actor(target.namePortal, chainId)
  const recipient = new L2Actor(target.fpc, target.rollupVersion)
  const content = nameOwnershipMessageContent(target.owner, target.nameHash)
  const secretHash = await computeSecretHash(REGISTRATION_MESSAGE_SECRET)
  const leafFor = (index: bigint) =>
    new L1ToL2Message(sender, recipient, content, secretHash, new Fr(index)).hash()

  const floor = opts.fromBlock ?? 0n
  let to = BigInt(await inbox.client.getBlockNumber())
  for (let i = 0; i < (opts.chunkBudget ?? SCAN_CHUNK_BUDGET) && to >= floor; i++) {
    const from = to - SCAN_CHUNK_BLOCKS + 1n > floor ? to - SCAN_CHUNK_BLOCKS + 1n : floor
    const logs = (await inbox.getMessageSentEvents(from, to)).sort((a, b) =>
      Number(b.args.index - a.args.index),
    )
    for (const log of logs) {
      const leaf = log.args.leaf ?? log.args.hash
      if (leaf === undefined) continue
      const actual = typeof leaf === "string" ? Fr.fromString(leaf) : (leaf as Fr)
      const expected = leafFor(log.args.index)
      if (!actual.equals(expected)) continue
      return {
        leafIndex: log.args.index,
        messageHash: expected,
        status: await registrationMessageStatus(node, target.fpc, expected),
      }
    }
    to = from - 1n
  }
  return undefined
}

/**
 * Whether the rollup has imported the message and whether this FPC has consumed it yet. The
 * consumption check derives the same nullifier the gate's `consume_l1_to_l2_message` emits, siloed
 * to the FPC — the canonical stdlib check for a message spendable with a known secret.
 */
export async function registrationMessageStatus(
  node: RegistrationMessageNode,
  fpc: AztecAddress,
  messageHash: Fr,
): Promise<RegistrationMessageStatus> {
  const aztecNode = node as AztecNode
  if (!(await isL1ToL2MessageReady(aztecNode, messageHash))) return "pending"
  try {
    await getNonNullifiedL1ToL2MessageWitness(
      aztecNode,
      fpc,
      messageHash,
      REGISTRATION_MESSAGE_SECRET,
    )
    return "consumable"
  } catch {
    return "consumed"
  }
}

/** Block until the rollup imports the message (a few L1 blocks after the registry sends it). */
export function waitForRegistrationMessage(
  node: RegistrationMessageNode,
  messageHash: Fr,
  opts: { timeoutSeconds: number },
): Promise<boolean> {
  return waitForL1ToL2MessageReady(node as AztecNode, messageHash, opts)
}
