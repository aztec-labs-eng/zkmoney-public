// @vitest-environment node
/** The page's manifest reads: one fetch serves the tuple and the table, each kept as long as it holds. */
import { afterEach, describe, expect, it, vi } from "vitest"
import { Network } from "@obsidion/core/constants"
import type { QueryEntry } from "@obsidion/front-core"
import {
  createPageChain,
  DEPLOYMENT_TABLE_TTL_MS,
  depositTokenReads,
  RESOLVER_OPERATOR_REUSE_MS,
  slotGrids,
} from "../../src/app/pageChain"
import { ASSET_TUPLE_TIMEOUT_MS } from "../../src/config/oxideTuple"
import { DEMO_OXIDE_DEPLOYMENT, DEMO_OXIDE_TUPLE } from "../../src/dev/demoFixtures"
import { createPageWallet } from "../../src/platform/wallet"
import type { WebWalletConfig } from "../../src/config/env"
import type { PageChain } from "../../src/session/pageChain"
import { testChain, testQuery } from "../support/query"

const address = (byte: string) => `0x${byte.repeat(20)}` as const
const PORTAL = address("a1")
const FEE_TOKEN = address("da")
const FLEET = "https://fleet.example/rpc"
const manifest = {
  schemaVersion: "5",
  deployments: [
    {
      label: "v6",
      updatedAt: "2026-10-20T00:00:00Z",
      deployedAt: "2026-10-01T00:00:00Z",
      enclaveUrl: "https://fleet.example/rpc",
      rollupVersion: "1",
      chainId: "11155111",
      forwardingTable: address("fb"),
      feeToken: FEE_TOKEN,
      bridges: [{ token: FEE_TOKEN, portal: PORTAL, l2Token: `0x${"a1".repeat(32)}` }],
    },
  ],
}

const config = {
  oxideProfile: { manifestUrl: "https://oxide.example/page-reads.json", portal: PORTAL },
  network: Network.TESTNET,
  l1RpcUrl: "http://l1.test",
} as unknown as WebWalletConfig

const served = () => new Response(JSON.stringify(manifest))
const fetchMock = vi.fn<(...args: unknown[]) => Promise<Response>>(async () => served())
vi.stubGlobal("fetch", fetchMock)
afterEach(() => {
  fetchMock.mockReset().mockImplementation(async () => served())
  vi.useRealTimers()
})

/** The L1 node: it holds every request until `release`, then reverts calls and reports no logs. */
function heldL1() {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  const node = { requests: 0, release }
  const answer = ({ id, method }: { id: number; method: string }) => ({
    jsonrpc: "2.0",
    id,
    ...(method === "eth_call"
      ? { error: { code: 3, message: "execution reverted", data: "0x" } }
      : { result: method === "eth_blockNumber" ? "0x10" : [] }),
  })
  fetchMock.mockImplementation(async (url, init) => {
    if (!String(url).startsWith(config.l1RpcUrl)) return served()
    node.requests++
    await held
    const body = JSON.parse((init as RequestInit).body as string)
    return Response.json(Array.isArray(body) ? body.map(answer) : answer(body))
  })
  return node
}

const outcome = (settled: PromiseSettledResult<unknown>) =>
  settled.status === "fulfilled" ? settled.value : settled.reason

describe("createPageChain", () => {
  it("reads the tuple, the deployment and the fee bridge off one manifest fetch", async () => {
    const reads = createPageChain(config, testChain())
    const [tuple, { pinned }, fee] = await Promise.all([
      reads.oxideTuple.read(),
      reads.oxideDeployment.read(),
      reads.feeTokenBridgeTuple.read(),
    ])
    expect(tuple).toBe(pinned.tuple)
    expect(fee).toBe(tuple)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("serves the primed reads with no fetch, and keeps the table for its TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const deployment = { ...DEMO_OXIDE_DEPLOYMENT.deployment, bridges: [] }
    const reads = createPageChain(config, testChain(), undefined, {
      tuple: DEMO_OXIDE_TUPLE,
      deployment: { ...DEMO_OXIDE_DEPLOYMENT, deployment },
    })
    expect(await reads.oxideTuple.read()).toBe(DEMO_OXIDE_TUPLE)
    const table = await reads.deploymentTable.read()
    expect(await reads.deploymentTable.read()).toBe(table)
    expect(table.deployment).toBe(deployment)
    reads.deploymentTable.refresh()
    const fresh = await reads.deploymentTable.read()
    expect(fresh).not.toBe(table)
    vi.setSystemTime(Date.now() + DEPLOYMENT_TABLE_TTL_MS + 1)
    expect(await reads.deploymentTable.read()).not.toBe(fresh)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each<[string, number, (reads: PageChain) => QueryEntry<unknown>]>([
    ["deploymentTable", DEPLOYMENT_TABLE_TTL_MS, (reads) => reads.deploymentTable],
    ["oxideEnv", RESOLVER_OPERATOR_REUSE_MS, (reads) => reads.oxideEnv],
  ])("shares a %s read that outlasts its reuse window", async (_, keepMs, read) => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const node = heldL1()
    const tuple = {
      ...DEMO_OXIDE_TUPLE,
      accountMetadataRegistry: address("ae"),
      deployedAtBlock: "1",
    }
    const reads = createPageChain(config, testChain(), undefined, {
      tuple,
      deployment: DEMO_OXIDE_DEPLOYMENT,
    })
    const first = read(reads).read()
    await vi.waitFor(() => expect(node.requests).toBe(1))
    vi.setSystemTime(Date.now() + keepMs + 1)
    const second = read(reads).read()
    // A second read would reach the node by now.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(node.requests).toBe(1)
    node.release()
    const [a, b] = await Promise.allSettled([first, second])
    expect(outcome(b)).toBe(outcome(a))
  })

  it("revalidates every manifest fetch after an invalidation, keeps no failed read, and keeps the tuple", async () => {
    const reads = createPageChain(config, testChain())
    const tuple = await reads.oxideTuple.read()
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }))
    reads.invalidateDeployment()
    await expect(reads.oxideDeployment.read()).rejects.toThrow("503")
    await reads.oxideDeployment.read()
    expect(await reads.oxideTuple.read()).toBe(tuple)
    expect(fetchMock.mock.calls.map((call) => call[1])).toEqual([
      undefined,
      { cache: "no-cache" },
      { cache: "no-cache" },
    ])
  })

  it("times out a stalled fetch, and reads it again once per portal", async () => {
    vi.useFakeTimers()
    const reads = createPageChain(config, testChain())
    fetchMock.mockReturnValueOnce(new Promise(() => {}))
    const stalled = expect(reads.portalTuple(PORTAL).read()).rejects.toMatchObject({
      code: "timeout",
    })
    await vi.advanceTimersByTimeAsync(ASSET_TUPLE_TIMEOUT_MS)
    await stalled
    const tuple = await reads.portalTuple(PORTAL.toUpperCase().replace("0X", "0x")).read()
    expect(await reads.portalTuple(PORTAL).read()).toBe(tuple)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("keeps one fleet signer per fleet and portal, and connects a failed one on its next call", async () => {
    vi.useFakeTimers()
    fetchMock.mockRejectedValue(new Error("fleet down"))
    const reads = createPageChain(config, testChain())
    const signer = reads.connectFleetSigner(FLEET, PORTAL)
    expect(reads.connectFleetSigner(FLEET, `0x${PORTAL.slice(2).toUpperCase()}`)).toBe(signer)
    expect(reads.connectFleetSigner(FLEET, FEE_TOKEN)).not.toBe(signer)
    const failed = expect(signer.ready()).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(10 * ASSET_TUPLE_TIMEOUT_MS)
    await failed
    const calls = fetchMock.mock.calls.length
    const again = expect(reads.connectFleetSigner(FLEET, PORTAL).ready()).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(10 * ASSET_TUPLE_TIMEOUT_MS)
    await again
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls)
  })

  it("reads a SIPA's failed terms again every 15 s while subscribed, and stops after", async () => {
    vi.useFakeTimers()
    heldL1().release()
    const reads = createPageChain(config, testChain())
    const terms = reads.sipaPortalTerms({ forwardingTable: address("fb"), intent: 1 }, undefined)
    const retryAt = () => (terms.get() as { retryAt?: number }).retryAt
    const off = terms.subscribe(() => {})
    await vi.waitFor(() => expect(retryAt()).toBeDefined())
    const first = retryAt()!
    await vi.advanceTimersByTimeAsync(15_000)
    await vi.waitFor(() => expect(retryAt()).toBeGreaterThan(first))
    off()
    const stopped = terms.get()
    expect(stopped).toMatchObject({ status: "failed" })
    expect(retryAt()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(terms.get()).toBe(stopped)
  })

  it("reads a failed capacity key again from 15 s, doubling, only while subscribed", async () => {
    vi.useFakeTimers()
    const reads = createPageChain(config, testChain())
    // The pinned deployment has no bridge for this row.
    const key = reads.capacityKey(address("0b"))
    const retryAt = () => (key.get() as { retryAt?: number }).retryAt
    const off = key.subscribe(() => {})
    await vi.waitFor(() => expect(retryAt()).toBeDefined())
    const first = retryAt()!
    expect(first - Date.now()).toBeLessThanOrEqual(15_000)
    await vi.advanceTimersByTimeAsync(first - Date.now())
    await vi.waitFor(() => expect(retryAt()).toBeGreaterThan(first))
    expect(retryAt()! - first).toBeGreaterThan(29_000)
    off()
    expect(key.get()).toMatchObject({ status: "failed" })
    expect(retryAt()).toBeUndefined()
  })

  it("reads the slot grid off the page's node, with no wallet up", async () => {
    const node = { getL1Constants: async () => ({ l1GenesisTime: 1_700n, slotDuration: 36 }) }
    await expect(slotGrids(testQuery(), () => node as never).read()).resolves.toEqual({
      l1GenesisTime: 1_700,
      slotDuration: 36,
    })
  })

  it("starts no wallet, whatever read a page starts", async () => {
    vi.useFakeTimers()
    const { openWallet, walletWanted } = createPageWallet({} as never)
    openWallet({} as never, {} as never, () => Promise.reject(new Error("booted")))
    const reads = createPageChain(config, testChain())
    const services = {
      withdrawalRails: reads.withdrawalRails(),
      swapSimulator: reads.swapSimulator(DEMO_OXIDE_TUPLE),
      connectFleetSigner: reads.connectFleetSigner("https://fleet.example/rpc", PORTAL),
    }
    const every = {
      oxideTuple: reads.oxideTuple,
      oxideDeployment: reads.oxideDeployment,
      feeTokenBridgeTuple: reads.feeTokenBridgeTuple,
      deploymentTable: reads.deploymentTable,
      sipaDeploymentTable: reads.sipaDeploymentTable(address("fc")),
      retiredRollupSources: reads.retiredRollupSources,
      otherManifestSources: reads.otherManifestSources,
      manifestBridges: reads.manifestBridges,
      manifestDeployments: reads.manifestDeployments,
      portalTuple: reads.portalTuple(PORTAL),
      oxideEnv: reads.oxideEnv,
      tokenImmutables: reads.tokenImmutables(PORTAL),
      tokenImmutablesOf: reads.tokenImmutablesOf(FEE_TOKEN),
      sipaPortalTerms: reads.sipaPortalTerms({ forwardingTable: PORTAL, intent: 0 }, undefined),
      tokenMetadata: reads.tokenMetadata(FEE_TOKEN),
      txAmountCap: reads.txAmountCap(PORTAL),
      currentTxAmountCap: reads.currentTxAmountCap,
      capacityKey: reads.capacityKey(FEE_TOKEN),
      portalDomain: reads.portalDomain(PORTAL),
      bridgeOfToken: reads.bridgeOfToken(FEE_TOKEN),
      withdrawalExecutorAt: reads.withdrawalExecutorAt(PORTAL),
      executorPortalAt: reads.executorPortalAt(PORTAL),
      executorSubsidyAt: reads.executorSubsidyAt(PORTAL),
      activeWithdrawalExecutor: reads.activeWithdrawalExecutor,
      paylinkExecutor: reads.paylinkExecutor(FEE_TOKEN),
      holdings: reads.holdings,
      holdingPrice: reads.holdingPrice({ held: DEMO_OXIDE_DEPLOYMENT.pinned }),
      savingsPrice: reads.savingsPrice,
      savingsPrices: reads.savingsPrices,
      tagResolution: reads.tagResolution("alice"),
      retiredRollupMajor: reads.retiredRollupMajor(PORTAL),
    } satisfies Record<
      Exclude<
        keyof PageChain,
        | "invalidateDeployment"
        | "broadcasterArtifact"
        | "ensClient"
        | "ensName"
        | "scans"
        | "bridgeChainClient"
        | "bridgeOut"
        | "originChain"
        | keyof typeof services
        | "teeSignerOfToken"
      >,
      QueryEntry<unknown>
    >
    // The page's reads beside its chain's.
    const page = [
      slotGrids(testQuery(), () => ({ getL1Constants: () => Promise.reject(new Error("down")) })),
      depositTokenReads(testQuery(), { config, chain: reads })("deposit"),
    ]
    const settled = Promise.allSettled([
      ...[...Object.values(every), ...page].map((entry: QueryEntry<unknown>) => entry.read()),
      ...Object.values(services).map((built) => built.ready()),
      reads.teeSignerOfToken(FEE_TOKEN),
    ])
    await vi.advanceTimersByTimeAsync(10 * ASSET_TUPLE_TIMEOUT_MS)
    await settled
    expect(walletWanted.get()).toBe(false)
  })
})
