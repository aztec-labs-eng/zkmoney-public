/**
 * A deposit address's broadcast sweeps every row of the table the address commits to: one operation per row's token,
 * each through that row's subsidy, and the `SIPA` event on the pinned bridge's L2 token. Relayers never rewrite an
 * operation, so a row the broadcast leaves out is never swept.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"
import { deploymentOfTuples, type OxideDeploymentTable } from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { Fr } from "@aztec-labs/aztec.js/fields"

const TABLE = `0x${"fb".repeat(20)}`
const EARLIER_TABLE = `0x${"fa".repeat(20)}`

const bridgeTuple = (byte: string, feeToken: string): OxideEnvTuple => ({
  version: "sandbox",
  gitSha: "",
  timestamp: "2026-10-14T00:00:00.000Z",
  deployedAt: "2026-10-14T00:00:00.000Z",
  portal: `0x${`a${byte}`.repeat(20)}`,
  token: `0x${`7${byte}`.repeat(20)}`,
  underlying: `0x${`7${byte}`.repeat(20)}`,
  l2Token: `0x${`0${byte}`.repeat(32)}`,
  enclaveUrl: "https://enclave.example/rpc",
  pcr0: "",
  rollupVersion: "1",
  chainId: "31337",
  forwardingTable: TABLE,
  feeToken,
  depositSubsidy: `0x${`5${byte}`.repeat(20)}`,
  sipaFactory: `0x${"f0".repeat(20)}`,
  operationExecutor: `0x${"e0".repeat(20)}`,
  l2Broadcaster: `0x${"0b".repeat(32)}`,
})

const FEE_TOKEN = `0x${"71".repeat(20)}`
const TUPLES = [bridgeTuple("1", FEE_TOKEN), bridgeTuple("2", FEE_TOKEN)] as const
const deployment = deploymentOfTuples(TUPLES)
const terms = { sweepTip: 1n, beneficiaryFee: 0n }
const TWO_ROWS: OxideDeploymentTable = {
  deployment,
  rows: [
    {
      bridge: deployment.bridges[0]!,
      intents: { deposit: terms, registration: terms },
      txAmountCap: 10n,
    },
    { bridge: deployment.bridges[1]!, intents: { deposit: terms }, txAmountCap: 10n },
  ],
}

const m = vi.hoisted(() => ({
  assertSubsidySweepsSipa: vi.fn(),
  buildSipaSweepBroadcasts: vi.fn(),
  getSipaDeploymentTable: vi.fn(),
  readSipaDeployed: vi.fn(),
}))

vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  getOxideTuple: async () => TUPLES[0],
  getSipaDeploymentTable: m.getSipaDeploymentTable,
  l1PublicClient: () => ({}),
}))
vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({ network: "sandbox", l1ChainId: 31337 }),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  assertSubsidySweepsSipa: m.assertSubsidySweepsSipa,
  buildSipaSweepBroadcasts: m.buildSipaSweepBroadcasts,
  buildClaimSponsorPayload: async () => ({}),
  claimFpcSponsoredFee: () => ({}),
}))
vi.mock("../src/config/classArtifacts", () => ({
  getWebBroadcasterArtifact: async () => ({}),
  getWebOxideToken: async (_wallet: unknown, _contracts: unknown, l2Token: string) => ({ l2Token }),
}))
vi.mock("../src/features/deposit/sipaSweep", () => ({ readSipaDeployed: m.readSipaDeployed }))
vi.mock("../src/features/fees/fpcRefuel", () => ({ maybeRefuelFpc: () => {} }))
vi.mock("../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorContext: async () => ({}),
  noteSubscribed: () => {},
}))

const { getSipaDepositGateway, resetSipaDepositGatewayForTests } = await import(
  "../src/features/deposit/sipaGateway"
)

const SIPA = `0x${"9f".repeat(20)}` as Address
const sipaArgs = (forwardingTable: string) => ({
  implementation: `0x${"44".repeat(20)}` as Address,
  intentHash: `0x${"33".repeat(32)}` as Hex,
  recoveryCommitment: `0x${"00".repeat(32)}` as Hex,
  rollupVersion: 1n,
  resweepable: true,
  forwardingTable: forwardingTable as Address,
})

/** Broadcast `SIPA`, whose derivation commits to `forwardingTable`, through the real gateway path. */
async function broadcast(forwardingTable: string) {
  resetSipaDepositGatewayForTests()
  const gw = getSipaDepositGateway() as never as Record<string, (...args: unknown[]) => unknown>
  vi.spyOn(gw, "deriveSipa").mockResolvedValue({
    address: SIPA,
    user: AztecAddress.fromBigIntUnsafe(7n),
    resolution: { messageSecret: new Fr(9n) },
    intent: { intentData: "0x55", intentHash: sipaArgs(forwardingTable).intentHash, proofs: "0x" },
    sipaArgs: sipaArgs(forwardingTable),
  })
  vi.spyOn(gw, "broadcasterFor").mockResolvedValue({})
  const wallet = {
    sendTx: async () => ({ receipt: { txHash: { toString: () => "0x01" } } }),
  }
  const sponsor = { fpcAddress: AztecAddress.ZERO, fpcArtifact: {}, railId: 0, policy: {} }
  await gw.broadcastSipa(
    wallet,
    {},
    TUPLES[0],
    { account: {}, msk: {} },
    { address: SIPA, day: 1, nonce: 0 },
    {
      sponsor,
    },
  )
  expect(m.buildSipaSweepBroadcasts).toHaveBeenCalledOnce()
  const [notifier, , params] = m.buildSipaSweepBroadcasts.mock.calls[0]!
  return { notifier, params }
}

describe("a deposit address's broadcast", () => {
  beforeEach(() => {
    localStorage.clear()
    m.assertSubsidySweepsSipa.mockReset().mockResolvedValue(undefined)
    m.buildSipaSweepBroadcasts.mockReset().mockReturnValue([])
    m.getSipaDeploymentTable.mockReset().mockResolvedValue(TWO_ROWS)
    m.readSipaDeployed.mockReset().mockResolvedValue(false)
  })

  it("sweeps each row's token through that row's subsidy, notified on the pinned bridge's L2 token", async () => {
    const { notifier, params } = await broadcast(TABLE)
    const routes = TUPLES.map((tuple) => ({
      token: tuple.underlying,
      portal: tuple.portal,
      depositSubsidy: tuple.depositSubsidy,
    }))
    expect(params.routes).toEqual(routes)
    expect(notifier).toEqual({ l2Token: TUPLES[0].l2Token })
    expect(m.assertSubsidySweepsSipa).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ routes, sipa: SIPA }),
    )
  })

  it("reads the rows of the table the address commits to, after a repoint too", async () => {
    await broadcast(EARLIER_TABLE)
    expect(m.getSipaDeploymentTable).toHaveBeenCalledWith(expect.anything(), EARLIER_TABLE)
  })

  it("does not publish when a row's subsidy would not sweep the address", async () => {
    m.assertSubsidySweepsSipa.mockRejectedValue(new Error("serves portal"))
    resetSipaDepositGatewayForTests()
    await expect(broadcast(TABLE)).rejects.toThrow("serves portal")
    expect(m.buildSipaSweepBroadcasts).not.toHaveBeenCalled()
  })

  it("skips the subsidy check for an address that has code", async () => {
    m.readSipaDeployed.mockResolvedValue(true)
    const { params } = await broadcast(TABLE)
    expect(params.deployed).toBe(true)
    expect(params.routes).toHaveLength(2)
    expect(m.assertSubsidySweepsSipa).not.toHaveBeenCalled()
  })
})
