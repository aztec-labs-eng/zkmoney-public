/**
 * A registration SIPA accepts every token the registration screen offers, but the broadcast sweeps only the manifest
 * token. The relayer copies that sweep for each other token it accepts.
 */
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import { Network } from "@obsidion/core/constants"
import { AztecAddress } from "@aztec/stdlib/aztec-address"

const MANIFEST_TOKEN = `0x${"d4".repeat(20)}` as Address

const TUPLE = {
  ensDomain: "zk.money",
  l2Broadcaster: `0x${"0b".repeat(32)}`,
  l2Token: `0x${"0c".repeat(32)}`,
  portal: `0x${"a0".repeat(20)}`,
  sipaFactory: `0x${"f0".repeat(20)}`,
  operationExecutor: `0x${"e0".repeat(20)}`,
  depositSubsidy: `0x${"5b".repeat(20)}`,
  token: MANIFEST_TOKEN,
}

const { assertSubsidySweepsSipa, buildSipaSweepBroadcasts, sendTx, readSipaDeployed } = vi.hoisted(() => ({
  assertSubsidySweepsSipa: vi.fn(),
  buildSipaSweepBroadcasts: vi.fn(),
  sendTx: vi.fn(),
  readSipaDeployed: vi.fn(),
}))

vi.mock("../src/features/deposit/sipaSweep", () => ({ readSipaDeployed }))

vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  assertSubsidySweepsSipa,
  buildSipaSweepBroadcasts,
  buildClaimSponsorPayload: async () => ({}),
  claimFpcSponsoredFee: () => ({}),
  encodeRegistrationProofs: () => "0x",
  BroadcasterContract: { at: () => ({}) },
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  canonicalGenerationStack: () => "v5",
  composeWireNameHash: () => `0x${"aa".repeat(32)}`,
  NameClaimStore: { get: () => ({ put: async () => {} }) },
}))
vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  getOxideTuple: async () => TUPLE,
  l1PublicClient: () => ({}),
}))
vi.mock("../src/config/classArtifacts", () => ({
  getWebBroadcasterArtifact: async () => ({}),
  getWebOxideToken: async () => ({}),
}))
vi.mock("../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorContext: async () => ({
    fpcAddress: AztecAddress.ZERO,
    fpcArtifact: {},
    railId: 0,
    policy: {},
    subscribe: undefined,
  }),
}))

import { OxideSipaIntent } from "@obsidion/sdk"
import { createWebRegistrationBroadcaster } from "../src/features/onboarding/webRegistrationBroadcast"

const PAYLOAD = {
  sipaAddress: `0x${"9f".repeat(20)}`,
  recipient: `0x${"01".repeat(32)}`,
  sharedSecretSalt: "0x02",
  sipaArgs: { resweepable: false, intentHash: `0x${"33".repeat(32)}` },
  registrationData: "0x",
  consentSig: "0x",
  bootstrap: `0x${"44".repeat(20)}`,
  domainAuth: { nonce: 1n, deadline: 2n, signature: "0x" },
  signedTerms: { fee: 0n, minDeposit: 0n, nonce: 0n, deadline: 0n, signature: "0x" },
  r1Install: {},
}

async function broadcastTokens(network: Network): Promise<string[]> {
  const broadcast = createWebRegistrationBroadcaster({
    wallet: {
      pxe: { registerContractClass: async () => {}, registerContract: async () => {} },
      node: { getContract: async () => ({}) },
      sendTx,
    } as never,
    account: { getAddress: () => AztecAddress.fromStringUnsafe(`0x${"07".repeat(32)}`) } as never,
    contractService: {} as never,
    config: { network, l1ChainId: network === Network.MAINNET ? 1 : 31337 } as never,
    handle: "alice",
  })
  await broadcast(PAYLOAD as never)
  expect(buildSipaSweepBroadcasts).toHaveBeenCalledTimes(1)
  const [, , params] = buildSipaSweepBroadcasts.mock.calls[0]
  return (params.tokens as string[]).map((token) => token.toLowerCase())
}

describe("createWebRegistrationBroadcaster funding tokens", () => {
  beforeEach(() => {
    assertSubsidySweepsSipa.mockReset().mockResolvedValue(undefined)
    buildSipaSweepBroadcasts.mockReset().mockReturnValue([])
    sendTx.mockReset().mockResolvedValue({ receipt: { txHash: { toString: () => "0x01" } } })
    readSipaDeployed.mockReset().mockResolvedValue(false)
  })

  it("omits the deploy call for a SIPA that already has code", async () => {
    readSipaDeployed.mockResolvedValue(true)
    await broadcastTokens(Network.SANDBOX)
    expect(readSipaDeployed).toHaveBeenCalledWith(expect.anything(), PAYLOAD.sipaAddress)
    expect(buildSipaSweepBroadcasts.mock.calls[0][2].deployed).toBe(true)
    expect(assertSubsidySweepsSipa).not.toHaveBeenCalled()
  })

  it("publishes the registration intent once the subsidy is known to deploy the payload's SIPA", async () => {
    await broadcastTokens(Network.SANDBOX)
    expect(assertSubsidySweepsSipa).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        depositSubsidy: TUPLE.depositSubsidy,
        portal: TUPLE.portal,
        sipaFactory: TUPLE.sipaFactory,
        intent: OxideSipaIntent.Registration,
        deployArgs: PAYLOAD.sipaArgs,
        intentData: PAYLOAD.registrationData,
        sipa: PAYLOAD.sipaAddress,
      }),
    )
    const [, , params] = buildSipaSweepBroadcasts.mock.calls[0]
    expect(params.intent).toBe(OxideSipaIntent.Registration)
  })

  it("does not publish when the subsidy would deploy another SIPA", async () => {
    assertSubsidySweepsSipa.mockRejectedValue(new Error("would deploy"))
    const broadcast = createWebRegistrationBroadcaster({
      wallet: {} as never,
      account: { getAddress: () => AztecAddress.fromStringUnsafe(`0x${"07".repeat(32)}`) } as never,
      contractService: {} as never,
      config: { network: Network.SANDBOX, l1ChainId: 31337 } as never,
      handle: "alice",
    })
    await expect(broadcast(PAYLOAD as never)).rejects.toThrow("would deploy")
    expect(buildSipaSweepBroadcasts).not.toHaveBeenCalled()
    expect(sendTx).not.toHaveBeenCalled()
  })

  it.each([Network.MAINNET, Network.SANDBOX])(
    "broadcasts a sweep for the manifest token only on %s",
    async (network) => {
      expect(await broadcastTokens(network)).toEqual([MANIFEST_TOKEN.toLowerCase()])
      expect(sendTx).toHaveBeenCalledTimes(1)
    },
  )
})
