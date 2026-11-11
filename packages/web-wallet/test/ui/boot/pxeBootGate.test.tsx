// @vitest-environment node
/**
 * The boot's identity check: L1 is the identity source and the node must agree. The default node
 * alone may boot on its own answers when L1 yields no identity. A refusal names the endpoint at
 * fault, never the default RPC's provider key.
 */
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { ChainIdentity } from "@obsidion/core/types"
import type { PortalIdentityCall } from "@obsidion/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BootError } from "../../../src/ui/PxeBoot"
import type { EndpointProvenance } from "../../../src/config/env"

vi.setConfig({ testTimeout: 30_000 })

const h = vi.hoisted(() => ({
  readPortal: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  getNodeInfo: vi.fn<() => Promise<unknown>>(),
  fireEvent: vi.fn(),
  showReportableError: vi.fn(),
  config: {} as Record<string, unknown>,
}))

vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readPortalChainIdentity: (...args: unknown[]) => h.readPortal(...args),
}))
vi.mock("../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/oxideTuple")>()),
  l1PublicClient: () => "l1-client",
}))
vi.mock("../../../src/errors/errorModal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/errors/errorModal")>()),
  showReportableError: h.showReportableError,
}))
vi.mock("../../../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/analytics")>()),
  fireEvent: h.fireEvent,
}))

const NODE_URL = "https://node.default.test"
const RPC_HOST = "rpc.default.test"
const RPC_KEY = "provider-key"
/** The default RPC carries its provider key in the path, as the hosted profile's does. */
const RPC_URL = `https://${RPC_HOST}/v2/${RPC_KEY}`
const PORTAL = "0x" + "c".repeat(40)
const L1 = {
  l1ChainId: 11155111,
  rollupVersion: "1821665230",
  rollupAddress: "0x" + "a".repeat(40),
  inboxAddress: "0x" + "b".repeat(40),
}
const DEFAULT: EndpointProvenance = { source: "default", isDefault: true }
const SETTINGS: EndpointProvenance = { source: "settings", isDefault: false }
const DIGEST = "0123456789abcdef0123456789abcdef"

type NodeAnswer = {
  l1ChainId: number
  rollupVersion: number
  rollupAddress: string
  inboxAddress: string
}

/** A `getNodeInfo()` answer, addresses as the EthAddress-like objects the node client returns. */
const nodeAnswer = (over: Partial<NodeAnswer> = {}) => {
  const a = {
    l1ChainId: L1.l1ChainId,
    rollupVersion: Number(L1.rollupVersion),
    // Case differs from L1's lower-cased form on purpose: the compare is case-insensitive.
    rollupAddress: L1.rollupAddress.toUpperCase().replace("0X", "0x"),
    inboxAddress: L1.inboxAddress,
    ...over,
  }
  return {
    l1ChainId: a.l1ChainId,
    rollupVersion: a.rollupVersion,
    l1ContractAddresses: {
      rollupAddress: { toString: () => a.rollupAddress },
      inboxAddress: { toString: () => a.inboxAddress },
    },
  }
}

const baseConfig = () => ({
  nodeUrl: NODE_URL,
  l1RpcUrl: RPC_URL,
  l1ChainId: L1.l1ChainId,
  proverEnabled: false,
  profileRollupVersion: L1.rollupVersion,
  nodeEndpointDigest: undefined as string | undefined,
  oxideProfile: { portal: PORTAL },
  endpoints: { node: DEFAULT, l1Rpc: DEFAULT, enclave: DEFAULT },
})

const customNode = () => {
  h.config.endpoints = { node: SETTINGS, l1Rpc: DEFAULT, enclave: DEFAULT }
  h.config.nodeEndpointDigest = DIGEST
}

const node = { getNodeInfo: () => h.getNodeInfo() } as unknown as AztecNode

let consoleError: ReturnType<typeof vi.spyOn>

const identityErrors = () => import("@obsidion/front-core")
const wrongChain = async () => {
  const { PortalIdentityMismatchError } = await identityErrors()
  return new PortalIdentityMismatchError({ field: "l1RpcChainId", expected: L1.l1ChainId, got: 1 })
}
const l1Unavailable = async (call: PortalIdentityCall, cause: unknown) => {
  const { L1IdentityUnavailableError } = await identityErrors()
  return new L1IdentityUnavailableError({ call, cause })
}

/** Runs the identity check as the gate does: the identity, or the refusal and its description. */
async function check(): Promise<{ identity?: ChainIdentity; thrown?: unknown; error?: BootError }> {
  const { describeBootError, verifiedIdentity } = await import("../../../src/ui/PxeBoot")
  try {
    return { identity: await verifiedIdentity(h.config as never, node) }
  } catch (thrown) {
    return { thrown, error: describeBootError(thrown, h.config as never) }
  }
}

beforeEach(() => {
  h.readPortal.mockReset().mockResolvedValue(L1)
  h.getNodeInfo.mockReset().mockResolvedValue(nodeAnswer())
  h.fireEvent.mockClear()
  h.showReportableError.mockClear()
  h.config = baseConfig()
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
  vi.unstubAllGlobals()
})

describe("verifiedIdentity", () => {
  it("all agree: the wallet boots on the L1 identity", async () => {
    const { identity } = await check()
    expect(identity).toEqual(L1)
    expect(h.readPortal).toHaveBeenCalledWith("l1-client", PORTAL, L1.l1ChainId)
    expect(h.fireEvent).not.toHaveBeenCalledWith("node_identity_unverified", expect.anything())
    expect(h.fireEvent).not.toHaveBeenCalledWith("profile_rollup_skew", expect.anything())
  })

  it("a node that disagrees on a field is refused, naming the node", async () => {
    h.getNodeInfo.mockResolvedValue(nodeAnswer({ rollupVersion: 999 }))
    const { error } = await check()
    expect(error).toMatchObject({ kind: "mismatch", field: "rollupVersion" })
    expect(error?.title).toContain(NODE_URL)
    expect(error?.message).toContain("999")
  })

  it("a wrong-chain L1 RPC refuses even the default node, naming the RPC", async () => {
    h.readPortal.mockRejectedValue(await wrongChain())
    const { error } = await check()
    expect(error).toMatchObject({ kind: "mismatch", field: "l1RpcChainId" })
    expect(error?.title).toContain(RPC_HOST)
    expect(error?.title).not.toContain(RPC_KEY)
    expect(error?.title).not.toContain(NODE_URL)
  })

  it.each([
    ["a transport failure", () => new TypeError("Failed to fetch")],
    [
      "a revert",
      () =>
        Object.assign(new Error("execution reverted"), { name: "ContractFunctionExecutionError" }),
    ],
  ])(
    "L1 unavailable on %s: the default node boots on its own answers and says so",
    async (_label, makeCause) => {
      const cause = makeCause()
      h.readPortal.mockRejectedValue(await l1Unavailable("ROLLUP", cause))
      // The node's Inbox differs from L1's fixture, so what reaches the wallet is provably theirs.
      // Its version matches the profile's, the one check left when L1 is silent.
      const theirs = { rollupVersion: 7, inboxAddress: "0x" + "d".repeat(40) }
      h.config.profileRollupVersion = "7"
      h.getNodeInfo.mockResolvedValue(nodeAnswer(theirs))
      const { identity } = await check()
      expect(identity).toEqual({
        l1ChainId: L1.l1ChainId,
        rollupVersion: "7",
        rollupAddress: L1.rollupAddress,
        inboxAddress: theirs.inboxAddress,
      })
      expect(h.fireEvent).toHaveBeenCalledWith("node_identity_unverified", { call: "ROLLUP" })
      expect(consoleError).toHaveBeenCalledWith(expect.any(String), cause)
    },
  )

  it("L1 unavailable with a default node on another chain is refused", async () => {
    h.readPortal.mockRejectedValue(await l1Unavailable("ROLLUP", new TypeError("Failed to fetch")))
    h.getNodeInfo.mockResolvedValue(nodeAnswer({ l1ChainId: 1 }))
    const { error } = await check()
    expect(error).toMatchObject({ kind: "mismatch", field: "l1ChainId" })
    expect(error?.message).toContain(`this network is chain ${L1.l1ChainId}`)
    expect(error?.message).not.toContain("L1 says")
    expect(h.fireEvent).not.toHaveBeenCalledWith("node_identity_unverified", expect.anything())
  })

  it("L1 unavailable with a custom node is refused", async () => {
    customNode()
    h.readPortal.mockRejectedValue(await l1Unavailable("eth_chainId", new TypeError("timeout")))
    const { error } = await check()
    expect(error?.kind).toBe("l1-unavailable")
    expect(error?.title).toContain(RPC_HOST)
    expect(error?.title).not.toContain(RPC_KEY)
    expect(error?.message).toContain("eth_chainId")
    expect(error?.message).toContain(NODE_URL)
    expect(h.fireEvent).not.toHaveBeenCalledWith("node_identity_unverified", expect.anything())
  })

  it("a node that does not answer is unreachable", async () => {
    h.getNodeInfo.mockRejectedValue(new TypeError("Failed to fetch"))
    const { error } = await check()
    expect(error?.kind).toBe("unreachable")
  })

  it("a node that accepts the connection but never answers is unreachable once the deadline passes", async () => {
    vi.useFakeTimers()
    try {
      const { verifiedIdentity } = await import("../../../src/ui/PxeBoot")
      h.getNodeInfo.mockReturnValue(new Promise(() => {}))
      let outcome: string | undefined
      void verifiedIdentity(h.config as never, node).then(
        () => (outcome = "resolved"),
        (e: Error) => (outcome = e.name),
      )
      await vi.advanceTimersByTimeAsync(29_000)
      expect(outcome).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(outcome).toBe("NodeUnreachableError")
    } finally {
      vi.useRealTimers()
    }
  })

  it("a node that does not answer beside a wrong-chain RPC reports the mismatch", async () => {
    h.getNodeInfo.mockRejectedValue(new TypeError("Failed to fetch"))
    h.readPortal.mockRejectedValue(await wrongChain())
    const { error } = await check()
    expect(error).toMatchObject({ kind: "mismatch", field: "l1RpcChainId" })
  })

  it("a node that does not answer beside an unavailable L1 reports the node", async () => {
    h.getNodeInfo.mockRejectedValue(new TypeError("Failed to fetch"))
    h.readPortal.mockRejectedValue(await l1Unavailable("ROLLUP", new TypeError("timeout")))
    const { error } = await check()
    expect(error?.kind).toBe("unreachable")
  })

  it("a profile whose rollup version differs from L1's refuses and reports the skew", async () => {
    h.config.profileRollupVersion = "4"
    const { error } = await check()
    expect(error).toMatchObject({ kind: "profile-skew", field: "rollupVersion" })
    expect(error?.message).toContain("rollup version 4")
    expect(error?.message).toContain("operator")
    expect(h.fireEvent).toHaveBeenCalledWith("profile_rollup_skew", {
      profile_version: 4,
      l1_version: Number(L1.rollupVersion),
    })
  })

  it("L1 unavailable with a default node on another rollup version than the profile refuses", async () => {
    h.readPortal.mockRejectedValue(await l1Unavailable("ROLLUP", new TypeError("Failed to fetch")))
    h.getNodeInfo.mockResolvedValue(nodeAnswer({ rollupVersion: 9 }))
    const { error } = await check()
    expect(error).toMatchObject({ kind: "profile-skew" })
  })
})

describe("assertCustomL1RpcSimulates", () => {
  const CUSTOM_RPC = "https://my-node.example/rpc"
  const rpcAnswers = (body: unknown) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body)))
    vi.stubGlobal("fetch", fetchImpl)
    return fetchImpl
  }
  const customRpc = (network = "mainnet") => {
    h.config.network = network
    h.config.l1RpcUrl = CUSTOM_RPC
    h.config.endpoints = { node: DEFAULT, l1Rpc: SETTINGS, enclave: DEFAULT }
  }
  async function probe(): Promise<{ thrown?: unknown; error?: BootError }> {
    const { assertCustomL1RpcSimulates, describeBootError } = await import(
      "../../../src/ui/PxeBoot"
    )
    try {
      await assertCustomL1RpcSimulates(h.config as never)
      return {}
    } catch (thrown) {
      return { thrown, error: describeBootError(thrown, h.config as never) }
    }
  }
  const UNSUPPORTED = { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "not available" } }

  it("a custom RPC without eth_simulateV1 refuses the boot, naming the RPC", async () => {
    customRpc()
    rpcAnswers(UNSUPPORTED)
    const { error } = await probe()
    expect(error?.kind).toBe("l1-rpc-no-simulate")
    expect(error?.title).toContain(CUSTOM_RPC)
    expect(error?.message).toContain("eth_simulateV1")
  })

  it("a custom RPC that simulates boots", async () => {
    customRpc()
    const fetchImpl = rpcAnswers({ jsonrpc: "2.0", id: 1, result: [{ calls: [] }] })
    expect(await probe()).toEqual({})
    expect(fetchImpl).toHaveBeenCalledWith(CUSTOM_RPC, expect.anything())
  })

  it("a custom RPC that cannot be probed refuses the boot", async () => {
    customRpc()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch")
      }),
    )
    const { thrown } = await probe()
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain("eth_simulateV1 probe failed: Failed to fetch")
  })

  it.each([
    ["the default RPC", () => (h.config.network = "mainnet")],
    ["a custom RPC on a network without swaps", () => customRpc("testnet")],
  ])("%s is not probed", async (_label, setup) => {
    setup()
    const fetchImpl = rpcAnswers(UNSUPPORTED)
    expect(await probe()).toEqual({})
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe("reportBootFailure", () => {
  const report = async (e: unknown) => {
    const { reportBootFailure } = await import("../../../src/ui/PxeBoot")
    reportBootFailure(e, h.config as never, { bootStartedAt: undefined, attempts: 0 })
  }
  const bootFailedCode = () =>
    h.fireEvent.mock.calls.find(([event]) => event === "pxe_boot_failed")?.[1]?.code

  it("a refusal reports its kind and leaves the explaining to the screen", async () => {
    h.getNodeInfo.mockResolvedValue(nodeAnswer({ l1ChainId: 1 }))
    await report((await check()).thrown)
    expect(bootFailedCode()).toBe("mismatch")
    expect(h.showReportableError).not.toHaveBeenCalled()
  })

  it("an unreachable node's transport error reaches the console", async () => {
    const cause = new TypeError("Failed to fetch")
    h.getNodeInfo.mockRejectedValue(cause)
    await report((await check()).thrown)
    expect(bootFailedCode()).toBe("unreachable")
    expect(consoleError).toHaveBeenCalledWith(expect.any(String), cause)
  })

  it("any other failure is reportable", async () => {
    const boom = new Error("boom")
    await report(boom)
    expect(bootFailedCode()).toBe("other")
    expect(h.showReportableError).toHaveBeenCalledWith(boom, "pxe:boot", {
      title: "zk.money failed to start",
      retry: { label: "Reload page", run: expect.any(Function) },
    })
  })
})
