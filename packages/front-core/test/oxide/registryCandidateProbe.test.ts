import { describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec/aztec.js/fields"
import { registryCandidateProbe } from "../../src/oxide/registryCandidateProbe"
import { resolveRecoveredMsk } from "../../src/core/services/resolveRecoveredMsk"
import { deriveBootstrapKey } from "../../src/oxide/oxideAccountKeys"

const FACTORY = "0x00000000000000000000000000000000000000f1"
const IMPLEMENTATION = "0x00000000000000000000000000000000000000d1"
const NAME_PORTAL = "0x00000000000000000000000000000000000000e1"
const ROLLUP = "7"
const CATALOG = [
  {
    fpcAddress: `0x${"0a".repeat(32)}`,
    accountFactory: FACTORY,
    implementation: IMPLEMENTATION,
    namePortal: NAME_PORTAL,
    rollupVersion: ROLLUP,
  },
] as const
const REGISTRY = "0x00000000000000000000000000000000000000f2"
const METADATA = "0x00000000000000000000000000000000000000f3"
const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const L2 = `0x${"11".repeat(32)}`
const ZERO_HASH = `0x${"00".repeat(32)}`
const NAME_HASH = `0x${"ab".repeat(32)}`

function probeWith(chain: {
  nameHash: string
  record: { l2Address: string; rollupVersion?: bigint } | null
}) {
  const predictAccountAddress = vi.fn(async () => ACCOUNT as `0x${string}`)
  const readNameOf = vi.fn(async () => chain.nameHash as `0x${string}`)
  const readAccountMetadataRegistry = vi.fn(async () => METADATA as `0x${string}`)
  const readUserRecord = vi.fn(
    async () =>
      (chain.record
        ? { ...chain.record, rollupVersion: chain.record.rollupVersion ?? BigInt(ROLLUP) }
        : null) as never,
  )
  const readNamePortalRegistry = vi.fn(async () => REGISTRY as `0x${string}`)
  const readFactoryImplementation = vi.fn(async () => IMPLEMENTATION as `0x${string}`)
  const probe = registryCandidateProbe({
    reader: {
      predictAccountAddress,
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
  return { probe, predictAccountAddress, readNameOf, readAccountMetadataRegistry, readUserRecord }
}

describe("registryCandidateProbe", () => {
  const msk = Fr.random()

  it("anchors when the predicted account is named and registered under the candidate's address", async () => {
    const { probe, predictAccountAddress, readNameOf, readUserRecord } = probeWith({
      nameHash: NAME_HASH,
      record: { l2Address: L2 },
    })
    expect(await probe(msk, L2.toUpperCase())).toBe("anchored")
    expect(predictAccountAddress).toHaveBeenCalledWith(FACTORY, deriveBootstrapKey(msk).address)
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
        predictAccountAddress: async () => ACCOUNT,
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
        predictAccountAddress: async () => ACCOUNT,
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
