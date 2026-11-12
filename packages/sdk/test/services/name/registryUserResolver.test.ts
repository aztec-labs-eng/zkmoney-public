/**
 * Registry user-record read — unit tests against a stub client (the call
 * shape + zero-address short-circuit + the throw-not-null transport contract
 * are ours; the RPC itself is viem's). Names and metadata live in separate
 * registries, so each read is asserted against the address it must go to. The
 * live acceptance is env-gated: LIVE_OXIDE=1 + LIVE_OXIDE_NAME cross-checks a
 * registered name on the deployed registries against a direct getUserRecord read.
 */

import { describe, expect, it } from "vitest"
import {
  ContractFunctionExecutionError,
  ContractFunctionZeroDataError,
  createPublicClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import { AccountMetadataRegistryAbi } from "@oxide/l1-contracts"
import { namehash } from "viem/ens"
import { extractPinnedOxideEnvTuple } from "@obsidion/core/oxide"
import { getUserRecord, readUserAddress } from "@oxide/l1-contracts"
import {
  readUserByNameHash,
  readUserL2AddressHistory,
  accountRecordState,
} from "../../../src/services/name/registryUserResolver.js"

const LIVE_MANIFEST_URL =
  process.env.OXIDE_MANIFEST_URL ?? "https://d1162cdsa8f9md.cloudfront.net/dev.v4.json"
const LIVE_PORTAL = process.env.OXIDE_PORTAL ?? ""
const NAME_REGISTRY = "0x0b903b955dbc0c97252f1ce9e43f8c26e8f5635f" as Address
const METADATA_REGISTRY = "0x00000000000000000000000000000000000000ab" as Address
const NAME_HASH = "0x362ff52ec1322af82c3743567f194601ce6513a0f846f8851a1334e3bdd706cd" as Hex
const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address
const BOOTSTRAP = "0x00000000000000000000000000000000000000b0" as Address
const ZERO = "0x0000000000000000000000000000000000000000"

const RECORD = {
  l2Address: `0x${"11".repeat(32)}` as Hex,
  rollupVersion: 4n,
  publicKey: { x: 0x1234n, y: 0x5678n },
  resolverOperator: "0x00000000000000000000000000000000000000cc" as Address,
}

type Call = { address: Address; functionName: string; args: unknown[] }

function stubClient(handlers: {
  ownerOf: () => unknown
  hasUserRecord?: () => unknown
  getUserRecord?: () => unknown
}) {
  const calls: Call[] = []
  const client = {
    readContract: async (params: Call) => {
      calls.push({ address: params.address, functionName: params.functionName, args: params.args })
      if (params.functionName === "ownerOf") return handlers.ownerOf()
      if (params.functionName === "hasUserRecord") {
        if (!handlers.hasUserRecord) throw new Error("hasUserRecord must not be called")
        return handlers.hasUserRecord()
      }
      if (params.functionName === "getUserRecord") {
        if (!handlers.getUserRecord) throw new Error("getUserRecord must not be called")
        return handlers.getUserRecord()
      }
      if (params.functionName === "bootstrapOwner") return BOOTSTRAP
      throw new Error(`unexpected read: ${params.functionName}`)
    },
  } as unknown as PublicClient
  return { client, calls }
}

const read = (client: PublicClient) =>
  readUserByNameHash(client, NAME_REGISTRY, METADATA_REGISTRY, NAME_HASH)

describe("readUserByNameHash", () => {
  it("composes the name lookup and the metadata read into a user record", async () => {
    const { client, calls } = stubClient({
      ownerOf: () => ACCOUNT,
      hasUserRecord: () => true,
      getUserRecord: () => RECORD,
    })

    const record = await read(client)

    expect(record).toMatchObject({
      account: ACCOUNT,
      l2Address: RECORD.l2Address,
      rollupVersion: 4n,
      sipaStealthPublicKey: { x: 0x1234n, y: 0x5678n },
      bootstrapOwner: BOOTSTRAP,
    })
    expect(calls).toEqual([
      { address: NAME_REGISTRY, functionName: "ownerOf", args: [NAME_HASH] },
      { address: METADATA_REGISTRY, functionName: "hasUserRecord", args: [ACCOUNT] },
      { address: METADATA_REGISTRY, functionName: "getUserRecord", args: [ACCOUNT] },
      { address: ACCOUNT, functionName: "bootstrapOwner", args: undefined },
    ])
  })

  it("returns null for an unregistered name without touching the metadata registry", async () => {
    const { client } = stubClient({ ownerOf: () => ZERO })

    expect(await read(client)).toBeNull()
  })

  it("returns null when the account holds no record, never calling the reverting read", async () => {
    const { client } = stubClient({ ownerOf: () => ACCOUNT, hasUserRecord: () => false })

    expect(await read(client)).toBeNull()
  })

  it("propagates a transport failure as a throw, never a null", async () => {
    const client = {
      readContract: async () => {
        throw new Error("RPC down")
      },
    } as unknown as PublicClient

    await expect(read(client)).rejects.toThrow(/RPC down/)
  })
})

describe.runIf(process.env.LIVE_OXIDE === "1")("live registry user record", () => {
  it.runIf(Boolean(process.env.LIVE_OXIDE_NAME))(
    "reads a registered name's record byte-equal to a direct getUserRecord",
    async () => {
      const manifest = await (await fetch(LIVE_MANIFEST_URL)).json()
      const { tuple } = extractPinnedOxideEnvTuple(manifest, { portal: LIVE_PORTAL })
      if (!tuple.registry || !tuple.accountMetadataRegistry) {
        throw new Error("live manifest lacks the name / metadata registries")
      }
      const nameRegistry = tuple.registry as Address
      const metadataRegistry = tuple.accountMetadataRegistry as Address
      const client = createPublicClient({
        transport: http(
          process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
        ),
      }) as PublicClient

      const nameHash = namehash(process.env.LIVE_OXIDE_NAME as string)
      const record = await readUserByNameHash(client, nameRegistry, metadataRegistry, nameHash)
      expect(record).not.toBeNull()

      const account = await readUserAddress(client, nameRegistry, nameHash)
      const direct = await getUserRecord(client, metadataRegistry, account)
      expect(record!.l2Address).toBe(direct.l2Address)
      expect(record!.rollupVersion).toBe(direct.rollupVersion)
    },
    120_000,
  )
})

describe("accountRecordState", () => {
  const ask = (client: PublicClient, l2Address: Hex, rollupVersion: bigint) =>
    accountRecordState(client, METADATA_REGISTRY, ACCOUNT, l2Address, rollupVersion)

  it.each([
    [
      "the same account on the same rollup",
      RECORD.l2Address.toUpperCase().replace("0X", "0x"),
      4n,
      "current",
    ],
    ["another rollup", RECORD.l2Address, 5n, "other"],
    ["another L2 account", `0x${"22".repeat(32)}`, 4n, "other"],
  ])("compares the record with %s", async (_, l2Address, rollupVersion, state) => {
    const { client, calls } = stubClient({
      ownerOf: () => ZERO,
      hasUserRecord: () => true,
      getUserRecord: () => RECORD,
    })
    expect(await ask(client, l2Address as Hex, rollupVersion)).toBe(state)
    expect(calls.every((c) => c.address === METADATA_REGISTRY)).toBe(true)
    expect(calls[0]!.args).toEqual([ACCOUNT])
  })

  it("reads an account with no record as none, without reading the record", async () => {
    const { client } = stubClient({ ownerOf: () => ZERO, hasUserRecord: () => false })
    expect(await ask(client, RECORD.l2Address, 4n)).toBe("none")
  })
})

describe("readUserL2AddressHistory", () => {
  const ROTATED = `0x${"22".repeat(32)}` as Hex
  const range = { fromBlock: 100n, toBlock: 200n }

  function historyClient(atStart: typeof RECORD | null, written: Hex[]) {
    const reads: { functionName: string; blockNumber?: bigint }[] = []
    const queries: unknown[] = []
    const client = {
      readContract: async (params: { functionName: string; blockNumber?: bigint }) => {
        reads.push({ functionName: params.functionName, blockNumber: params.blockNumber })
        if (params.functionName === "hasUserRecord") return atStart !== null
        if (params.functionName === "getUserRecord") return atStart
        throw new Error(`unexpected read: ${params.functionName}`)
      },
      getContractEvents: async (params: unknown) => {
        queries.push(params)
        return written.map((l2Address) => ({ args: { user: ACCOUNT, record: { l2Address } } }))
      },
    } as unknown as PublicClient
    return { client, reads, queries }
  }

  it("lists the record at the window's start, then each one written in it", async () => {
    const { client, reads, queries } = historyClient(RECORD, [ROTATED])

    expect(await readUserL2AddressHistory(client, METADATA_REGISTRY, ACCOUNT, range)).toEqual([
      RECORD.l2Address,
      ROTATED,
    ])
    expect(reads).toEqual([
      { functionName: "hasUserRecord", blockNumber: 100n },
      { functionName: "getUserRecord", blockNumber: 100n },
    ])
    expect(queries).toEqual([
      expect.objectContaining({
        address: METADATA_REGISTRY,
        eventName: "UserRecordUpdated",
        args: { user: ACCOUNT },
        fromBlock: 100n,
        toBlock: 200n,
      }),
    ])
  })

  it("lists only the records written when the account had none at the window's start", async () => {
    const { client, reads } = historyClient(null, [RECORD.l2Address, ROTATED])

    expect(await readUserL2AddressHistory(client, METADATA_REGISTRY, ACCOUNT, range)).toEqual([
      RECORD.l2Address,
      ROTATED,
    ])
    expect(reads.map((r) => r.functionName)).toEqual(["hasUserRecord"])
  })

  it("reads a registry deployed inside the window as holding no record at its start", async () => {
    const client = {
      readContract: async () => {
        throw new ContractFunctionExecutionError(
          new ContractFunctionZeroDataError({ functionName: "hasUserRecord" }),
          { abi: AccountMetadataRegistryAbi, functionName: "hasUserRecord", args: [ACCOUNT] },
        )
      },
      getContractEvents: async () => [{ args: { record: { l2Address: ROTATED } } }],
    } as unknown as PublicClient

    expect(await readUserL2AddressHistory(client, METADATA_REGISTRY, ACCOUNT, range)).toEqual([
      ROTATED,
    ])
  })

  it("propagates a failed record read as a throw", async () => {
    const client = {
      readContract: async () => {
        throw new Error("RPC down")
      },
      getContractEvents: async () => [],
    } as unknown as PublicClient

    await expect(
      readUserL2AddressHistory(client, METADATA_REGISTRY, ACCOUNT, range),
    ).rejects.toThrow(/RPC down/)
  })

  it("propagates a failed log read as a throw", async () => {
    const client = {
      readContract: async () => false,
      getContractEvents: async () => {
        throw new Error("RPC down")
      },
    } as unknown as PublicClient

    await expect(
      readUserL2AddressHistory(client, METADATA_REGISTRY, ACCOUNT, range),
    ).rejects.toThrow(/RPC down/)
  })
})
