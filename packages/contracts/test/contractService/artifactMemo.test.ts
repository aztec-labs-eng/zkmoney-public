/**
 * A page parses each bundled artifact once and hashes each artifact's class once, however often a
 * read resolves them: on a phone each costs tens to hundreds of ms.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ classHashes: 0 }))
vi.mock("@aztec-labs/stdlib/contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aztec-labs/stdlib/contract")>()
  return {
    ...actual,
    getContractClassFromArtifact: (
      ...args: Parameters<typeof actual.getContractClassFromArtifact>
    ) => {
      h.classHashes++
      return actual.getContractClassFromArtifact(...args)
    },
  }
})

import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"
import type { FetchFunction } from "@obsidion/core/types"
import { ContractService, DEFAULT_CONTRACTS, Network, NodeContractServiceStorage } from "../../src"

const explodingFetch: FetchFunction = async (url) => {
  throw new Error(`Unexpected network call (${url})`)
}

function buildService() {
  return ContractService.getInstance(
    new NodeContractServiceStorage(Network.TESTNET),
    undefined as never,
    undefined as never,
    Network.TESTNET,
    { fetchFunction: explodingFetch, source: "local-ledger", oxideEnvProfile: null },
  )
}

describe("bundled artifacts", () => {
  beforeEach(() => ContractService.resetInstance())
  afterAll(() => ContractService.resetInstance())

  it("are parsed once per page", async () => {
    const service = buildService()
    const first = await service.getArtifactForContract(DEFAULT_CONTRACTS.paylinkDirect)
    ContractService.resetInstance()
    const again = await buildService().getArtifactForContract(DEFAULT_CONTRACTS.paylinkDirect)
    expect(again).toBe(first)
  })

  it("have their class hashed once however often a read resolves it", async () => {
    const service = buildService()
    const bundled = await service.getArtifactForContract(DEFAULT_CONTRACTS.paylinkDirect)
    const classId = (await getContractClassFromArtifact(bundled)).id.toString()
    h.classHashes = 0
    for (let i = 0; i < 3; i++) {
      expect(await service.getArtifactForClass(classId, DEFAULT_CONTRACTS.paylinkDirect)).toBe(
        bundled,
      )
    }
    expect(await service.getKnownClassIds(DEFAULT_CONTRACTS.paylinkDirect)).toContain(classId)
    expect(h.classHashes).toBe(1)
  })
})
