/**
 * The shared resolution entrypoint's manifest sourcing: a caller-supplied pre-loaded tuple
 * short-circuits the manifest fetch (web type-ahead reads its cached tuple), while omitting it
 * fetches the pinned manifest as always.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import type { PublicClient } from "viem"
import { Network } from "@obsidion/sdk"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { resolveTagViaRegistry } from "../../src/oxide/registryTagResolution"

const REGISTRY = "0x0b903b955dbc0c97252f1ce9e43f8c26e8f5635f"
const AMR = "0x1c903b955dbc0c97252f1ce9e43f8c26e8f5635f"
const OTHER_REGISTRY = "0x" + "77".repeat(20)
const OTHER_PORTAL = "0x" + "55".repeat(20)
const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const BOOTSTRAP = "0x00000000000000000000000000000000000000bb"
const L2_ADDRESS = `0x${"11".repeat(32)}`
const MANIFEST_URL = "http://registry.local/oxide/dev.v4.json"

function stubClient(seen: string[] = []): PublicClient {
  return {
    readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
      seen.push(address)
      if (functionName === "ownerOf") return ACCOUNT
      if (functionName === "hasUserRecord") return true
      if (functionName === "getUserRecord")
        return {
          l2Address: L2_ADDRESS,
          rollupVersion: 4n,
          publicKey: { x: 1n, y: 2n },
          resolverOperator: ACCOUNT,
        }
      if (functionName === "bootstrapOwner") return BOOTSTRAP
      throw new Error(`unexpected read: ${functionName}`)
    },
  } as unknown as PublicClient
}

const TUPLE: OxideEnvTuple = {
  version: "v4",
  gitSha: "",
  timestamp: "2026-07-29T00:00:00Z",
  portal: REGISTRY,
  token: REGISTRY,
  l2Token: L2_ADDRESS,
  enclaveUrl: "http://enclave.local",
  pcr0: "",
  rollupVersion: "4",
  registry: REGISTRY,
  accountMetadataRegistry: AMR,
  ensDomain: "oxidestaging.eth",
}

function manifest(): unknown {
  return {
    schemaVersion: "4",
    deployments: [
      {
        schemaVersion: "1",
        label: "v4",
        portal: TUPLE.portal,
        deployedAt: TUPLE.timestamp,
        updatedAt: TUPLE.timestamp,
        rollupVersion: TUPLE.rollupVersion,
        chainId: "31337",
        token: TUPLE.token,
        l2Token: TUPLE.l2Token,
        enclaveUrl: TUPLE.enclaveUrl,
        nameRegistry: TUPLE.registry,
        accountMetadataRegistry: TUPLE.accountMetadataRegistry,
        ensDomain: TUPLE.ensDomain,
      },
      {
        schemaVersion: "1",
        label: "v5",
        portal: OTHER_PORTAL,
        deployedAt: TUPLE.timestamp,
        updatedAt: TUPLE.timestamp,
        rollupVersion: TUPLE.rollupVersion,
        chainId: "31337",
        token: TUPLE.token,
        l2Token: "0x" + "05".repeat(32),
        enclaveUrl: TUPLE.enclaveUrl,
        nameRegistry: OTHER_REGISTRY,
        ensDomain: TUPLE.ensDomain,
      },
    ],
  }
}

function baseOpts() {
  return {
    publicClient: stubClient(),
    manifestUrl: MANIFEST_URL,
    portal: TUPLE.portal,
    network: Network.SANDBOX,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("resolveTagViaRegistry manifest sourcing", () => {
  it("a supplied tuple short-circuits the manifest fetch", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)

    const result = await resolveTagViaRegistry("alice", { ...baseOpts(), tuple: TUPLE })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: "resolved", xmtpAddress: BOOTSTRAP })
  })

  it("without a tuple the pinned manifest is fetched", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => manifest() }))
    vi.stubGlobal("fetch", fetchSpy)

    const result = await resolveTagViaRegistry("alice", baseOpts())

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledWith(MANIFEST_URL)
    expect(result).toMatchObject({ status: "resolved", xmtpAddress: BOOTSTRAP })
  })
})

describe("resolveTagViaRegistry with a portal pin", () => {
  it("selects the entry by portal and reads its own registry", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => manifest() }))
    vi.stubGlobal("fetch", fetchSpy)
    const seen: string[] = []

    const result = await resolveTagViaRegistry("alice", {
      ...baseOpts(),
      publicClient: stubClient(seen),
    })

    expect(result).toMatchObject({ status: "resolved", xmtpAddress: BOOTSTRAP })
    expect(seen).toContain(TUPLE.registry)
    expect(seen).not.toContain(OTHER_REGISTRY)
  })

  it("a pin absent from the manifest is fatal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => manifest() })),
    )

    await expect(
      resolveTagViaRegistry("alice", { ...baseOpts(), portal: "0x" + "99".repeat(20) }),
    ).rejects.toThrow(/no deployment for pinned portal/)
  })
})
