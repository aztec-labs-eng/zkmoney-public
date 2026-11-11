import { describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { escrowERC20RecoveryDigest } from "@oxide/l1-contracts/escrow.js"
import { SwapEscrowAbi } from "@oxide/l1-contracts"
import {
  encodeSkyEscrowDeploy,
  predictSkyEscrowAddressLocally,
  SkyEscrowFactoryAbi,
  SkyRoute,
} from "@oxide/experiments/sky/sky_savings.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import { decodeFunctionData, multicall3Abi, type Address, type Hex } from "viem"
import {
  canSelfRunSkyEscrow,
  runSkyEscrow,
  runSkyEscrowRecovery,
  skyEscrowLeg,
} from "../../src/oxide/skyEscrowExit"

const FACTORY = "0xfafafafafafafafafafafafafafafafafafafafa" as const
const RECOVERY = {
  account: "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a",
  salt: new Fr(0x5a17n),
} as const
const COMMITMENT = deriveRecoveryCommitment(
  RECOVERY.salt,
  EthAddress.fromString(RECOVERY.account),
).toString() as Hex
const RECIPIENT_COMMITMENT = `0x${"02".repeat(32)}` as const
const NONCE = `0x${"77".repeat(32)}` as const
const TO = "0x2e45a4e5d9100a4e8cb94f81257b5a1eba05a29b" as const
const DAI = "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b" as const
const HASH = `0x${"ab".repeat(32)}` as const
const SIGNATURE = `0x${"cd".repeat(65)}` as const
const CHAIN_NOW = 1_800_000_000n
const ARGS = {
  route: SkyRoute.Unstake,
  recipientCommitment: RECIPIENT_COMMITMENT,
  recoveryCommitment: COMMITMENT,
  relayerTip: 5n,
  nonce: NONCE,
}
const ESCROW = predictSkyEscrowAddressLocally(FACTORY, ARGS)

const move = (extra: object = {}) =>
  ({
    direction: "out",
    withdrawalLocalId: "w1",
    escrow: ESCROW,
    nonce: NONCE,
    recipientCommitment: RECIPIENT_COMMITMENT,
    amount: "10",
    ...extra,
  } as never)
const burn = (extra: object = {}) =>
  ({
    localId: "w1",
    phase: "done",
    recipient: ESCROW,
    startTime: 0,
    phaseEnteredAt: 0,
    skyMove: {
      direction: "out",
      factory: FACTORY,
      recipientCommitment: RECIPIENT_COMMITMENT,
      recoveryCommitment: COMMITMENT,
      relayerTip: "5",
      nonce: NONCE,
    },
    ...extra,
  } as never)

function deps() {
  const reader = { tokenBalance: vi.fn(async () => 95n), isDeployed: vi.fn(async () => false) }
  const channel = {
    sendTransaction: vi.fn(async () => HASH),
    waitForReceipt: vi.fn(async () => true),
  }
  const signAccount = vi.fn(async () => SIGNATURE)
  const leg = skyEscrowLeg(burn())!
  return {
    reader,
    channel,
    signAccount,
    run: { leg, dai: DAI, reader, channel },
    recovery: {
      leg,
      reader,
      channel,
      recovery: RECOVERY,
      signAccount,
      dai: DAI,
      chainId: 1,
      makeNonce: () => new Uint8Array(32).fill(7),
      chainNow: async () => CHAIN_NOW,
    },
  }
}

describe("skyEscrowLeg", () => {
  it("rebuilds the escrow from the burn's Sky meta, on the route the move's direction takes", () => {
    expect(skyEscrowLeg(burn())).toMatchObject({ kind: "sky", escrow: ESCROW, args: ARGS })
    expect(skyEscrowLeg(burn({ skyMove: undefined }))).toBeUndefined()
  })
})

describe("canSelfRunSkyEscrow", () => {
  it("offers the run once the release has paid the escrow and nothing has landed for a while", () => {
    const later = Date.now() + 60 * 60 * 1000
    expect(canSelfRunSkyEscrow(move(), burn(), later)).toBe(true)
    expect(canSelfRunSkyEscrow(move(), burn({ phase: "finalizing_l1" }), later)).toBe(false)
    expect(
      canSelfRunSkyEscrow(
        move({ deposit: { inboxIndex: "1", amount: "1", claimed: false } }),
        burn(),
        later,
      ),
    ).toBe(false)
    expect(canSelfRunSkyEscrow(move({ recovered: { to: TO, txHashes: [] } }), burn(), later)).toBe(
      false,
    )
  })
})

describe("runSkyEscrow", () => {
  it("submits the factory's run for the move's args", async () => {
    const d = deps()
    await expect(runSkyEscrow(d.run)).resolves.toBe(HASH)
    expect(d.channel.sendTransaction).toHaveBeenCalledWith(FACTORY, encodeSkyEscrowDeploy(ARGS))
  })

  it("refuses an escrow that already ran, before any wallet prompt", async () => {
    const d = deps()
    d.reader.tokenBalance.mockResolvedValue(0n)
    await expect(runSkyEscrow(d.run)).rejects.toThrow(/already run/)
    expect(d.channel.sendTransaction).not.toHaveBeenCalled()
  })
})

describe("runSkyEscrowRecovery", () => {
  it("signs the escrow's DAI out to the named address and deploys the escrow with the recovery", async () => {
    const d = deps()
    await expect(runSkyEscrowRecovery(d.recovery, TO)).resolves.toBe(HASH)
    const nonce = `0x${"07".repeat(32)}` as Hex
    expect(d.signAccount).toHaveBeenCalledWith(
      RECOVERY.account,
      escrowERC20RecoveryDigest(ESCROW, 1n, TO, DAI, nonce, CHAIN_NOW + 3600n),
    )
    const [, data] = d.channel.sendTransaction.mock.calls[0] as unknown as [string, Hex]
    const [calls] = decodeFunctionData({ abi: multicall3Abi, data }).args as readonly [
      readonly { target: Address; callData: Hex }[],
    ]
    const deploy = decodeFunctionData({ abi: SkyEscrowFactoryAbi, data: calls[0]!.callData })
    expect(deploy.functionName).toBe("deploy")
    expect(calls[1]!.target).toBe(ESCROW)
    const recover = decodeFunctionData({ abi: SwapEscrowAbi, data: calls[1]!.callData })
    expect(recover.args.slice(2).map((v) => (typeof v === "string" ? v.toLowerCase() : v))).toEqual([
      SIGNATURE,
      TO,
      DAI,
      nonce,
      CHAIN_NOW + 3600n,
    ])
  })

  it("fails closed for an account that is not the move's recovery account", async () => {
    const d = deps()
    const other = { ...d.recovery, recovery: { ...RECOVERY, salt: new Fr(1n) } }
    await expect(runSkyEscrowRecovery(other, TO)).rejects.toThrow(
      /not the recovery account of this move's escrow/,
    )
    expect(d.signAccount).not.toHaveBeenCalled()
  })
})
