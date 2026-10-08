import { describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec/aztec.js/fields"
import { getContractAddress, type Address } from "viem"
import { predictAccountAddressLocally } from "@oxide/l1-contracts"
import { registryCandidateProbe } from "../../src/oxide/registryCandidateProbe"
import { resolveRecoveredMsk } from "../../src/core/services/resolveRecoveredMsk"
import { deriveBootstrapKey } from "../../src/oxide/oxideAccountKeys"

const FACTORY = "0x00000000000000000000000000000000000000f1" as Address
const IMPLEMENTATION = getContractAddress({ from: FACTORY, nonce: 1n })
const NAME_PORTAL = "0x00000000000000000000000000000000000000e1"
const ROLLUP = "7"
const CATALOG = [
  {
    fpcAddress: `0x${"0a".repeat(32)}`,
    accountFactory: FACTORY,
    namePortal: NAME_PORTAL,
    rollupVersion: ROLLUP,
  },
] as const
const REGISTRY = "0x00000000000000000000000000000000000000f2" as Address
const METADATA = "0x00000000000000000000000000000000000000f3" as Address
const L2 = `0x${"11".repeat(32)}`
const ZERO_HASH = `0x${"00".repeat(32)}`
const NAME_HASH = `0x${"ab".repeat(32)}`

const msk = Fr.random()
/** The account the probe predicts for `msk` under the catalog's factory. */
const ACCOUNT = predictAccountAddressLocally(FACTORY, deriveBootstrapKey(msk).address)

function probeWith(chain: {
  nameHash: string
  record: { l2Address: string; rollupVersion?: bigint } | null
}) {
  const readNameOf = vi.fn(async () => chain.nameHash as `0x${string}`)
  const readAccountMetadataRegistry = vi.fn(async () => METADATA)
  const readUserRecord = vi.fn(
    async () =>
      (chain.record
        ? { ...chain.record, rollupVersion: chain.record.rollupVersion ?? BigInt(ROLLUP) }
        : null) as never,
  )
  const readNamePortalRegistry = vi.fn(async () => REGISTRY)
  const readFactoryImplementation = vi.fn(async () => IMPLEMENTATION)
  const probe = registryCandidateProbe({
    reader: {
      readNameOf,
      readAccountMetadataRegistry,
      readUserRecord,
      readNamePortalRegistry,
      readFactoryImplementation,
    },
    catalog: [...CATALOG],
    registry: REGISTRY,
    rollupVersion: ROLLUP,
  })
  return { probe, readNameOf, readAccountMetadataRegistry, readUserRecord }
}

describe("registryCandidateProbe", () => {
  it("anchors when the predicted account is named and registered under the candidate's address", async () => {
    const { probe, readNameOf, readUserRecord } = probeWith({
      nameHash: NAME_HASH,
      record: { l2Address: L2 },
    })
    expect(await probe(msk, L2.toUpperCase())).toBe("anchored")
    expect(readNameOf).toHaveBeenCalledWith(REGISTRY, ACCOUNT)
    expect(readUserRecord).toHaveBeenCalledWith(METADATA, ACCOUNT)
  })

  it("a zero name is absent, and costs no record read", async () => {
    const { probe, readUserRecord } = probeWith({ nameHash: ZERO_HASH, record: null })
    expect(await probe(msk, L2)).toBe("absent")
    expect(readUserRecord).not.toHaveBeenCalled()
  })

  it("a named account with no metadata record is absent", async () => {
    const { probe } = probeWith({ nameHash: NAME_HASH, record: null })
    expect(await probe(msk, L2)).toBe("absent")
  })

  it("a record written for another rollup is absent for this candidate", async () => {
    const { probe } = probeWith({
      nameHash: NAME_HASH,
      record: { l2Address: L2, rollupVersion: 6n },
    })
    expect(await probe(msk, L2)).toBe("absent")
  })

  it("a record registered under another L2 address is absent for this candidate", async () => {
    const { probe } = probeWith({
      nameHash: NAME_HASH,
      record: { l2Address: `0x${"22".repeat(32)}` },
    })
    expect(await probe(msk, L2)).toBe("absent")
  })

  it("an RPC failure propagates", async () => {
    const probe = registryCandidateProbe({
      reader: {
        readNameOf: async () => {
          throw new Error("rpc down")
        },
        readAccountMetadataRegistry: async () => METADATA,
        readUserRecord: async () => null,
        readNamePortalRegistry: async () => REGISTRY,
        readFactoryImplementation: async () => IMPLEMENTATION,
      },
      catalog: [...CATALOG],
      registry: REGISTRY,
      rollupVersion: ROLLUP,
    })
    await expect(probe(msk, L2)).rejects.toThrow(/rpc down/)
  })
})

describe("a registry that names no usable generation stops recovery", () => {
  it("rejects and never consults a weaker tier", async () => {
    const probe = registryCandidateProbe({
      reader: {
        readNameOf: async () => NAME_HASH as `0x${string}`,
        readAccountMetadataRegistry: async () => METADATA,
        readUserRecord: async () => null,
        readNamePortalRegistry: async () => REGISTRY,
        readFactoryImplementation: async () => IMPLEMENTATION,
      },
      catalog: [],
      registry: REGISTRY,
      rollupVersion: ROLLUP,
    })
    const weaker = vi.fn(async () => "anchored" as const)

    await expect(
      resolveRecoveredMsk(
        { candidates: { first: Fr.random() }, preferredSlot: "first" } as never,
        async () => L2,
        [
          { name: "registry", probes: [probe] },
          { name: "campaign", probes: [weaker] },
        ],
      ),
    ).rejects.toThrow(/cannot say which account/)
    expect(weaker).not.toHaveBeenCalled()
  })
})
