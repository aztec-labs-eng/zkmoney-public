/**
 * Forward tag resolution against the Registry — unit tests over a stub viem
 * client (the sdk primitives' contract reads are exercised through it, so this
 * pins the full normalize → compose → read → shape path plus the rollup guard,
 * the throw-vs-null contract, and the bootstrap-owner read that is the messaging address).
 */

import { describe, expect, it } from "vitest"
import type { Address, Hex, PublicClient } from "viem"
import {
  RegistryTagResolver,
  TagValidationError,
} from "../../src/core/services/RegistryTagResolver"
import { composeWireNameHash } from "../../src/core/services/wireDomain"

const REGISTRY = "0x0b903b955dbc0c97252f1ce9e43f8c26e8f5635f" as Address
const AMR = "0x1c903b955dbc0c97252f1ce9e43f8c26e8f5635f" as Address
const ENS_DOMAIN = "oxidestaging.eth"
const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const BOOTSTRAP = "0x00000000000000000000000000000000000000b0"
const ZERO = "0x0000000000000000000000000000000000000000"
const L2_ADDRESS = `0x${"11".repeat(32)}` as Hex
const STEALTH = { x: 0x1234n, y: 0x5678n }

// `cast namehash "alice.oxidestaging.eth"` — the byte-exact wire node.
const ALICE_NAME_HASH = "0x362ff52ec1322af82c3743567f194601ce6513a0f846f8851a1334e3bdd706cd"

function userRecord(overrides: { rollupVersion?: bigint } = {}) {
  return {
    l2Address: L2_ADDRESS,
    rollupVersion: overrides.rollupVersion ?? 4n,
    // Registry field name; the resolver re-exposes it as `sipaStealthPublicKey`.
    publicKey: STEALTH,
    resolverOperator: "0x00000000000000000000000000000000000000cc",
  }
}

function stubClient(opts: { account: string; user?: unknown; throws?: boolean }) {
  const calls: { functionName: string; args: unknown[] }[] = []
  const client = {
    readContract: async (params: { functionName: string; args: unknown[] }) => {
      calls.push({ functionName: params.functionName, args: params.args })
      if (opts.throws) throw new Error("RPC down")
      if (params.functionName === "ownerOf") return opts.account
      if (params.functionName === "hasUserRecord") return opts.user !== undefined
      if (params.functionName === "getUserRecord") return opts.user
      if (params.functionName === "bootstrapOwner") return BOOTSTRAP
      throw new Error(`unexpected read: ${params.functionName}`)
    },
  } as unknown as PublicClient
  return { client, calls }
}

function resolver(client: PublicClient) {
  return new RegistryTagResolver({
    client,
    registry: REGISTRY,
    accountMetadataRegistry: AMR,
    ensDomain: ENS_DOMAIN,
  })
}

describe("RegistryTagResolver.resolveTag", () => {
  it("maps a registered on-rollup record to a resolved result with the bootstrap owner as the messaging address", async () => {
    const { client } = stubClient({ account: ACCOUNT, user: userRecord() })

    const result = await resolver(client).resolveTag("alice", 4n)

    expect(result).toEqual({
      status: "resolved",
      account: ACCOUNT,
      l2Address: L2_ADDRESS,
      rollupId: "4",
      sipaStealthPublicKey: STEALTH,
      xmtpAddress: BOOTSTRAP,
    })
  })

  it("returns notFound for an unregistered name", async () => {
    const { client } = stubClient({ account: ZERO })
    expect(await resolver(client).resolveTag("ghost", 4n)).toEqual({ status: "notFound" })
  })

  it("returns notFound when the name's account carries no metadata record", async () => {
    const { client } = stubClient({ account: ACCOUNT })
    expect(await resolver(client).resolveTag("alice", 4n)).toEqual({ status: "notFound" })
  })

  it("returns staleRollup when the record is scoped to a different rollup", async () => {
    const { client } = stubClient({ account: ACCOUNT, user: userRecord({ rollupVersion: 3n }) })
    expect(await resolver(client).resolveTag("alice", 4n)).toEqual({ status: "staleRollup" })
  })

  it("propagates a transport failure as a throw (deferred-retry contract)", async () => {
    const { client } = stubClient({ account: ACCOUNT, throws: true })
    await expect(resolver(client).resolveTag("alice", 4n)).rejects.toThrow(/RPC down/)
  })

  it("normalizes display chrome to the same wire nameHash as the bare tag", async () => {
    const bare = stubClient({ account: ZERO })
    await resolver(bare.client).resolveTag("alice", 4n)
    const display = stubClient({ account: ZERO })
    await resolver(display.client).resolveTag("@Alice.zk.money", 4n)

    expect(bare.calls[0].args[0]).toBe(ALICE_NAME_HASH)
    expect(display.calls[0].args[0]).toBe(ALICE_NAME_HASH)
    expect(bare.calls[0].args[0]).toBe(composeWireNameHash("alice", ENS_DOMAIN))
  })

  it("rejects invalid / non-ASCII input before hashing or reading the Registry", async () => {
    const { client, calls } = stubClient({ account: ZERO })

    await expect(resolver(client).resolveTag("", 4n)).rejects.toBeInstanceOf(TagValidationError)
    await expect(resolver(client).resolveTag("bad tag!", 4n)).rejects.toBeInstanceOf(
      TagValidationError,
    )
    await expect(resolver(client).resolveTag("café", 4n)).rejects.toBeInstanceOf(TagValidationError)
    expect(calls).toHaveLength(0)
  })

  it("reads the Registry for short, leading-underscore and hyphenated tags", async () => {
    const { client, calls } = stubClient({ account: ZERO })

    for (const tag of ["x", "_alice", "honk-goose"]) {
      await resolver(client).resolveTag(tag, 4n)
    }
    expect(calls).toHaveLength(3)
  })

  it("refuses a tag ENSIP-15 would reject before it reads", async () => {
    const { client, calls } = stubClient({ account: ZERO })

    for (const tag of ["honk_the_g00se", "xn--foo"]) {
      await expect(resolver(client).resolveTag(tag, 4n)).rejects.toBeInstanceOf(TagValidationError)
    }
    expect(calls).toHaveLength(0)
  })
})
