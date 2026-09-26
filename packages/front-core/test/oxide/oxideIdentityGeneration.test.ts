import { describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"
import {
  AmbiguousOxideIdentityError,
  resolveOxideIdentity,
  type IdentityGeneration,
} from "../../src/oxide/oxideIdentityGeneration"

const REGISTRY = "0x00000000000000000000000000000000000000f2" as Address
const OTHER_REGISTRY = "0x00000000000000000000000000000000000000f9" as Address
const METADATA = "0x00000000000000000000000000000000000000f3" as Address
const BOOTSTRAP = "0x00000000000000000000000000000000000000b0" as Address

const OLD_ACCOUNT = "0x00000000000000000000000000000000000000a1" as Address
const NEW_ACCOUNT = "0x00000000000000000000000000000000000000a2" as Address
const L2 = `0x${"11".repeat(32)}`
const OTHER_L2 = `0x${"22".repeat(32)}`
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex
const NAME_HASH = `0x${"ab".repeat(32)}` as Hex

const ROLLUP = "7"

const generation = (
  over: Partial<IdentityGeneration> & { fpcAddress: string },
): IdentityGeneration => ({
  accountFactory: "0x00000000000000000000000000000000000000c1" as Address,
  implementation: "0x00000000000000000000000000000000000000d1" as Address,
  namePortal: "0x00000000000000000000000000000000000000e1" as Address,
  rollupVersion: ROLLUP,
  ...over,
})

const OLD = generation({
  fpcAddress: `0x${"aa".repeat(32)}`,
  accountFactory: "0x00000000000000000000000000000000000000c1" as Address,
  implementation: "0x00000000000000000000000000000000000000d1" as Address,
  namePortal: "0x00000000000000000000000000000000000000e1" as Address,
})

const CURRENT = generation({
  fpcAddress: `0x${"bb".repeat(32)}`,
  accountFactory: "0x00000000000000000000000000000000000000c2" as Address,
  implementation: "0x00000000000000000000000000000000000000d2" as Address,
  namePortal: "0x00000000000000000000000000000000000000e2" as Address,
})

interface Chain {
  accounts?: Record<string, Address>
  names?: Record<string, Hex>
  records?: Record<string, { l2Address: string; rollupVersion?: bigint }>
  portals?: Record<string, Address>
  implementations?: Record<string, Address>
}

function readerFor(chain: Chain) {
  const predictAccountAddress = vi.fn(
    async (factory: Address) =>
      chain.accounts?.[factory.toLowerCase()] ??
      (`0x${factory.slice(-2).padStart(40, "0")}` as Address),
  )
  const readNameOf = vi.fn(
    async (_registry: Address, account: Address) =>
      chain.names?.[account.toLowerCase()] ?? ZERO_HASH,
  )
  const readAccountMetadataRegistry = vi.fn(async () => METADATA)
  const readUserRecord = vi.fn(async (_metadata: Address, account: Address) => {
    const record = chain.records?.[account.toLowerCase()]
    if (!record) return null
    return {
      l2Address: record.l2Address,
      rollupVersion: record.rollupVersion ?? BigInt(ROLLUP),
    } as never
  })
  const readNamePortalRegistry = vi.fn(
    async (portal: Address) => chain.portals?.[portal.toLowerCase()] ?? REGISTRY,
  )
  const readFactoryImplementation = vi.fn(
    async (factory: Address) =>
      chain.implementations?.[factory.toLowerCase()] ??
      (factory.toLowerCase() === OLD.accountFactory.toLowerCase()
        ? OLD.implementation
        : CURRENT.implementation),
  )
  return {
    predictAccountAddress,
    readNameOf,
    readAccountMetadataRegistry,
    readUserRecord,
    readNamePortalRegistry,
    readFactoryImplementation,
  }
}

const registeredUnderOld: Chain = {
  accounts: { [OLD.accountFactory.toLowerCase()]: OLD_ACCOUNT },
  names: { [OLD_ACCOUNT.toLowerCase()]: NAME_HASH },
  records: { [OLD_ACCOUNT.toLowerCase()]: { l2Address: L2 } },
}

const resolve = (chain: Chain, catalog: IdentityGeneration[], l2Address = L2) =>
  resolveOxideIdentity(
    { reader: readerFor(chain), registry: REGISTRY, catalog, rollupVersion: ROLLUP },
    BOOTSTRAP,
    l2Address,
  )

const verified = async (chain: Chain, catalog: IdentityGeneration[], l2Address = L2) => {
  const outcome = await resolve(chain, catalog, l2Address)
  return outcome.kind === "verified" ? outcome.identity : undefined
}

const kindOf = async (chain: Chain, catalog: IdentityGeneration[], l2Address = L2) =>
  (await resolve(chain, catalog, l2Address)).kind

describe("resolveOxideIdentity", () => {
  it("finds the account a previous factory holds while the active factory holds none", async () => {
    const identity = await verified(registeredUnderOld, [CURRENT, OLD])
    expect(identity?.account).toBe(OLD_ACCOUNT)
    expect(identity?.nameHash).toBe(NAME_HASH)
    expect(identity?.generations.map((g) => g.fpcAddress)).toEqual([OLD.fpcAddress])
  })

  it("keeps a new user on the active factory", async () => {
    const identity = await verified(
      {
        accounts: { [CURRENT.accountFactory.toLowerCase()]: NEW_ACCOUNT },
        names: { [NEW_ACCOUNT.toLowerCase()]: NAME_HASH },
        records: { [NEW_ACCOUNT.toLowerCase()]: { l2Address: L2 } },
      },
      [CURRENT, OLD],
    )
    expect(identity?.account).toBe(NEW_ACCOUNT)
    expect(identity?.generations.map((g) => g.fpcAddress)).toEqual([CURRENT.fpcAddress])
  })

  it("reports every generation that binds one account, and is not ambiguous", async () => {
    const twin = generation({ ...OLD, fpcAddress: `0x${"cc".repeat(32)}` })
    const identity = await verified(registeredUnderOld, [CURRENT, OLD, twin])
    expect(identity?.account).toBe(OLD_ACCOUNT)
    expect(identity?.generations.map((g) => g.fpcAddress)).toEqual([
      OLD.fpcAddress,
      twin.fpcAddress,
    ])
  })

  it("refuses two distinct accounts rather than choosing one", async () => {
    const chain: Chain = {
      accounts: {
        [OLD.accountFactory.toLowerCase()]: OLD_ACCOUNT,
        [CURRENT.accountFactory.toLowerCase()]: NEW_ACCOUNT,
      },
      names: { [OLD_ACCOUNT.toLowerCase()]: NAME_HASH, [NEW_ACCOUNT.toLowerCase()]: NAME_HASH },
      records: {
        [OLD_ACCOUNT.toLowerCase()]: { l2Address: L2 },
        [NEW_ACCOUNT.toLowerCase()]: { l2Address: L2 },
      },
    }
    await expect(resolve(chain, [CURRENT, OLD])).rejects.toThrow(AmbiguousOxideIdentityError)
  })

  it("separates an empty catalog from a catalog whose accounts hold no name", async () => {
    expect(await kindOf({}, [])).toBe("no-generation")
    expect(await kindOf({}, [CURRENT])).toBe("none")
  })

  it("names no account when no generation holds a name for this key", async () => {
    expect(await kindOf({}, [CURRENT, OLD])).toBe("none")
  })

  it("skips a generation whose name portal reads another registry", async () => {
    const chain: Chain = {
      ...registeredUnderOld,
      portals: { [OLD.namePortal.toLowerCase()]: OTHER_REGISTRY },
    }
    expect(await kindOf(chain, [CURRENT, OLD])).toBe("none")
  })

  it("skips a generation whose factory no longer clones the pinned implementation", async () => {
    const chain: Chain = {
      ...registeredUnderOld,
      implementations: {
        [OLD.accountFactory.toLowerCase()]: "0x00000000000000000000000000000000000000dd" as Address,
      },
    }
    expect(await kindOf(chain, [CURRENT, OLD])).toBe("none")
  })

  it("skips a generation from another rollup without reading L1", async () => {
    const reader = readerFor(registeredUnderOld)
    const outcome = await resolveOxideIdentity(
      {
        reader,
        registry: REGISTRY,
        catalog: [generation({ ...OLD, rollupVersion: "6" })],
        rollupVersion: ROLLUP,
      },
      BOOTSTRAP,
      L2,
    )
    expect(outcome.kind).toBe("no-generation")
    expect(reader.predictAccountAddress).not.toHaveBeenCalled()
    expect(reader.readNamePortalRegistry).not.toHaveBeenCalled()
  })

  it("reports a named account recorded under another L2 address as unverified", async () => {
    const outcome = await resolve(registeredUnderOld, [CURRENT, OLD], OTHER_L2)
    expect(outcome).toEqual({ kind: "unverified", accounts: [OLD_ACCOUNT] })
  })

  it("compares the recorded L2 address without case", async () => {
    const identity = await verified(registeredUnderOld, [OLD], L2.toUpperCase())
    expect(identity?.account).toBe(OLD_ACCOUNT)
  })

  it("reports a record written for another rollup as unverified, never as this rollup's account", async () => {
    const chain: Chain = {
      ...registeredUnderOld,
      records: { [OLD_ACCOUNT.toLowerCase()]: { l2Address: L2, rollupVersion: 6n } },
    }
    expect(await resolve(chain, [OLD])).toEqual({ kind: "unverified", accounts: [OLD_ACCOUNT] })
  })

  it("reports a named account with no metadata record as unverified, never as a new user", async () => {
    const chain: Chain = { ...registeredUnderOld, records: {} }
    expect(await resolve(chain, [OLD])).toEqual({ kind: "unverified", accounts: [OLD_ACCOUNT] })
  })

  it("reads each generation's validations once for one call", async () => {
    const reader = readerFor(registeredUnderOld)
    await resolveOxideIdentity(
      { reader, registry: REGISTRY, catalog: [OLD, OLD], rollupVersion: ROLLUP },
      BOOTSTRAP,
      L2,
    )
    expect(reader.readNamePortalRegistry).toHaveBeenCalledTimes(1)
    expect(reader.readFactoryImplementation).toHaveBeenCalledTimes(1)
  })

  it("propagates an RPC failure instead of reporting no identity", async () => {
    const reader = readerFor(registeredUnderOld)
    reader.readNameOf.mockRejectedValueOnce(new Error("rpc down"))
    await expect(
      resolveOxideIdentity(
        { reader, registry: REGISTRY, catalog: [OLD], rollupVersion: ROLLUP },
        BOOTSTRAP,
        L2,
      ),
    ).rejects.toThrow(/rpc down/)
  })
})
