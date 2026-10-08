/**
 * The name-ownership message the ClaimFPC's registration gate consumes, from the client side: the
 * content hash both languages have to agree on, and the Inbox scan that recovers the leaf index a
 * `subscribe` needs and reports where the message stands.
 *
 * The recovery is what makes the rail survive a lost device: the witness is public L1 log data plus
 * a public secret, so a fresh PXE can rebuild it with nothing kept locally. The negative cases pin
 * that the match binds the whole message — an Inbox leaf commits sender, recipient, version and
 * content, so a message from another sender, to another FPC, or about another L1 account is simply
 * not this one.
 */
import { describe, expect, it } from "vitest"
import { Fr } from "@aztec/aztec.js/fields"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { EthAddress } from "@aztec/foundation/eth-address"
import { L1Actor, L1ToL2Message, L2Actor } from "@aztec/stdlib/messaging"
import { computeSecretHash } from "@aztec/stdlib/hash"
import type {
  InboxMessageSentLog,
  InboxMessageSource,
} from "../../src/services/inboxSiblingPath.js"
import {
  REGISTRATION_MESSAGE_SECRET,
  findRegistrationMessage,
  nameOwnershipMessageContent,
  type RegistrationMessageNode,
} from "../../src/services/registrationMessage.js"

const CHAIN_ID = 31337
const OTHER_CHAIN_ID = 11155111
const ROLLUP_VERSION = 4138062237

const FPC = AztecAddress.fromFieldUnsafe(new Fr(0xfbc0n))
const NAME_PORTAL = EthAddress.fromString("0x00000000000000000000000000000000000eeee1")
/** The registrant the portal attests about, and the name it holds. */
const OWNER = EthAddress.fromString("0x0ead00000000000000000000000000000000bee0")
const NAME_HASH = Buffer.from(
  "0da1000000000000000000000000000000000000000000000000000000001e55",
  "hex",
)
const OTHER_OWNER = EthAddress.fromString("0x1111111111111111111111111111111111111111")

/** Pinned in `claim_fpc/src/registration.nr::content_hash_matches_the_typescript_mirror`. */
const PINNED_CONTENT_HASH = "0x0076965bb2b826b57030fd020a5c87ab48ca8086410dbb797d788534438ae5c6"

async function inboxLeaf(over: {
  sender?: EthAddress
  recipient?: AztecAddress
  content?: Fr
  version?: number
  chainId?: number
  index: bigint
}): Promise<InboxMessageSentLog & { l1BlockNumber: bigint }> {
  const message = new L1ToL2Message(
    new L1Actor(over.sender ?? NAME_PORTAL, over.chainId ?? CHAIN_ID),
    new L2Actor(over.recipient ?? FPC, over.version ?? ROLLUP_VERSION),
    over.content ?? nameOwnershipMessageContent(OWNER, NAME_HASH),
    await computeSecretHash(REGISTRATION_MESSAGE_SECRET),
    new Fr(over.index),
  )
  // One leaf per L1 block, at block 1000 + index, so chunk bounds are easy to reason about.
  return {
    l1BlockNumber: 1000n + over.index,
    args: { index: over.index, checkpointNumber: 1n, leaf: message.hash() },
  }
}

/** An Inbox at `head` whose logs answer range queries by block, recording the ranges asked. */
function fakeInbox(
  logs: (InboxMessageSentLog & { l1BlockNumber: bigint })[],
  head = 100_000n,
): InboxMessageSource & { ranges: [bigint, bigint][] } {
  const ranges: [bigint, bigint][] = []
  return {
    ranges,
    client: { getBlockNumber: async () => head },
    getMessageSentEvents: async (from, to) => {
      ranges.push([from, to])
      return logs.filter((l) => l.l1BlockNumber >= from && l.l1BlockNumber <= to)
    },
  }
}

/**
 * A node that has imported every checkpoint up to `syncedCheckpoint`, and in which the given
 * siloed nullifiers already exist (a consumed message leaves one). It answers no chain id: the
 * target carries it.
 */
function fakeNode(syncedCheckpoint: number, consumed = false): RegistrationMessageNode {
  return {
    getChainId: async () => {
      throw new Error("the node was asked for the chain id")
    },
    getL1ToL2MessageCheckpoint: async () => 1,
    getBlockData: async () => ({ checkpointNumber: syncedCheckpoint }),
    getL1ToL2MessageMembershipWitness: async () => (syncedCheckpoint >= 1 ? [42n, []] : undefined),
    findLeavesIndexes: async () => [consumed ? { index: 7n } : undefined],
  } as never
}

const target = {
  fpc: FPC,
  namePortal: NAME_PORTAL,
  owner: OWNER,
  nameHash: NAME_HASH,
  rollupVersion: ROLLUP_VERSION,
  l1ChainId: CHAIN_ID,
}

describe("name ownership message content", () => {
  it("hashes a fixed owner and name to the vector the circuit pins", () => {
    expect(nameOwnershipMessageContent(OWNER, NAME_HASH).toString()).toBe(PINNED_CONTENT_HASH)
  })

  it("binds the owner and the name independently", () => {
    const pinned = nameOwnershipMessageContent(OWNER, NAME_HASH).toString()
    expect(nameOwnershipMessageContent(OTHER_OWNER, NAME_HASH).toString()).not.toBe(pinned)
    expect(nameOwnershipMessageContent(OWNER, Buffer.alloc(32, 0x22)).toString()).not.toBe(pinned)
  })

  it("refuses a name hash that is not 32 bytes", () => {
    expect(() => nameOwnershipMessageContent(OWNER, Buffer.alloc(31))).toThrow("32 bytes")
  })
})

describe("finding the registration message in the inbox", () => {
  it("returns the leaf index and hash of the portal's message for this account", async () => {
    const leaf = await inboxLeaf({ index: 42n })
    const found = await findRegistrationMessage(fakeInbox([leaf]), fakeNode(1), target)
    expect(found?.leafIndex).toBe(42n)
    expect(found?.messageHash.toString()).toBe((leaf.args.leaf as Fr).toString())
  })

  it("ignores a message sent by another L1 address", async () => {
    const inbox = fakeInbox([
      await inboxLeaf({
        index: 42n,
        sender: EthAddress.fromString("0x00000000000000000000000000000000000eeee2"),
      }),
    ])
    expect(await findRegistrationMessage(inbox, fakeNode(1), target)).toBeUndefined()
  })

  it("ignores a message addressed to another recipient", async () => {
    const inbox = fakeInbox([
      await inboxLeaf({ index: 42n, recipient: AztecAddress.fromFieldUnsafe(new Fr(0x0f9cn)) }),
    ])
    expect(await findRegistrationMessage(inbox, fakeNode(1), target)).toBeUndefined()
  })

  it("ignores a message about another L1 account", async () => {
    const inbox = fakeInbox([
      await inboxLeaf({ index: 42n, content: nameOwnershipMessageContent(OTHER_OWNER, NAME_HASH) }),
    ])
    expect(await findRegistrationMessage(inbox, fakeNode(1), target)).toBeUndefined()
  })

  it("ignores a message about another name of the same account", async () => {
    const inbox = fakeInbox([
      await inboxLeaf({
        index: 42n,
        content: nameOwnershipMessageContent(OWNER, Buffer.alloc(32, 0x22)),
      }),
    ])
    expect(await findRegistrationMessage(inbox, fakeNode(1), target)).toBeUndefined()
  })

  it("ignores a message bound to another rollup version", async () => {
    const inbox = fakeInbox([await inboxLeaf({ index: 42n, version: ROLLUP_VERSION + 1 })])
    expect(await findRegistrationMessage(inbox, fakeNode(1), target)).toBeUndefined()
  })

  it("binds the L1 sender to the target's chain id, never the node's", async () => {
    const leaf = await inboxLeaf({ index: 42n, chainId: OTHER_CHAIN_ID })
    const inbox = fakeInbox([leaf])
    expect(await findRegistrationMessage(inbox, fakeNode(1), target)).toBeUndefined()
    const found = await findRegistrationMessage(inbox, fakeNode(1), {
      ...target,
      l1ChainId: OTHER_CHAIN_ID,
    })
    expect(found?.messageHash.toString()).toBe((leaf.args.leaf as Fr).toString())
  })

  it("finds this account's message among unrelated inbox traffic", async () => {
    const inbox = fakeInbox([
      await inboxLeaf({ index: 40n, content: Fr.fromHexString("0x1234") }),
      await inboxLeaf({ index: 41n, sender: EthAddress.ZERO }),
      await inboxLeaf({ index: 42n }),
    ])
    expect((await findRegistrationMessage(inbox, fakeNode(1), target))?.leafIndex).toBe(42n)
  })

  it("prefers the newest of several messages for the same account", async () => {
    // `notify` is repeatable, and a migration re-emits; the spent original must not shadow it.
    const inbox = fakeInbox([await inboxLeaf({ index: 42n }), await inboxLeaf({ index: 900n })])
    expect((await findRegistrationMessage(inbox, fakeNode(1), target))?.leafIndex).toBe(900n)
  })

  it("walks back from the head in capped chunks and stops at the floor", async () => {
    const inbox = fakeInbox([await inboxLeaf({ index: 42n })], 20_000n)
    expect(
      await findRegistrationMessage(inbox, fakeNode(1), target, { fromBlock: 5_000n }),
    ).toBeUndefined()
    // Two chunks cover [5000, 20000]; none reaches below the floor.
    expect(inbox.ranges).toEqual([
      [11_001n, 20_000n],
      [5_000n, 11_000n],
    ])
  })

  it("gives up after the chunk budget", async () => {
    const inbox = fakeInbox([await inboxLeaf({ index: 42n })], 100_000n)
    expect(
      await findRegistrationMessage(inbox, fakeNode(1), target, { chunkBudget: 2 }),
    ).toBeUndefined()
    expect(inbox.ranges).toHaveLength(2)
  })
})

describe("where a found message stands", () => {
  it("is pending while the rollup has not imported it", async () => {
    const inbox = fakeInbox([await inboxLeaf({ index: 42n })])
    expect((await findRegistrationMessage(inbox, fakeNode(0), target))?.status).toBe("pending")
  })

  it("is consumable once imported and not yet spent by this FPC", async () => {
    const inbox = fakeInbox([await inboxLeaf({ index: 42n })])
    expect((await findRegistrationMessage(inbox, fakeNode(1), target))?.status).toBe("consumable")
  })

  it("is consumed once the FPC's nullifier for it exists", async () => {
    const inbox = fakeInbox([await inboxLeaf({ index: 42n })])
    expect((await findRegistrationMessage(inbox, fakeNode(1, true), target))?.status).toBe(
      "consumed",
    )
  })
})
