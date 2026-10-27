import { beforeEach, describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { escrowERC20RecoveryDigest } from "@oxide/l1-contracts/escrow.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"

const mocks = vi.hoisted(() => ({
  buildSkyEscrowRunCall: vi.fn(),
  buildSkyEscrowRecoverCall: vi.fn(),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  buildSkyEscrowRunCall: mocks.buildSkyEscrowRunCall,
  buildSkyEscrowRecoverCall: mocks.buildSkyEscrowRecoverCall,
}))

import {
  canSelfRunSkyEscrow,
  runSkyEscrow,
  runSkyEscrowRecovery,
  skyEscrowTarget,
} from "../../src/oxide/skyEscrowExit"

const ESCROW = "0xe5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5" as const
const FACTORY = "0xfafafafafafafafafafafafafafafafafafafafa" as const
const RECOVERY = {
  account: "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a",
  salt: new Fr(0x5a17n),
} as const
const COMMITMENT = deriveRecoveryCommitment(
  RECOVERY.salt,
  EthAddress.fromString(RECOVERY.account),
).toString()
const RECIPIENT_COMMITMENT = `0x${"02".repeat(32)}` as const
const NONCE = `0x${"77".repeat(32)}` as const
const TO = "0x2e45a4e5d9100a4e8cb94f81257b5a1eba05a29b" as const
const DAI = "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b" as const
const HASH = `0x${"ab".repeat(32)}` as const
const SIGNATURE = `0x${"cd".repeat(65)}` as const
const CHAIN_NOW = 1_800_000_000n

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
  const reader = { daiBalance: vi.fn(async () => 95n), isDeployed: vi.fn(async () => false) }
  const channel = {
    sendTransaction: vi.fn(async () => HASH),
    waitForReceipt: vi.fn(async () => true),
  }
  const signAccount = vi.fn(async () => SIGNATURE)
  const target = skyEscrowTarget(move(), burn())!
  return {
    reader,
    channel,
    signAccount,
    target,
    run: { target, reader, channel },
    recovery: {
      target,
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

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.buildSkyEscrowRunCall.mockReturnValue({ to: FACTORY, data: "0xdeadbeef" })
  mocks.buildSkyEscrowRecoverCall.mockReturnValue({ to: ESCROW, data: "0xfeedface" })
})

describe("skyEscrowTarget", () => {
  it("rebuilds the escrow's args from the burn's Sky meta, on the route the move's direction takes", () => {
    expect(skyEscrowTarget(move(), burn())).toEqual({
      escrow: ESCROW,
      factory: FACTORY,
      args: {
        route: 1,
        recipientCommitment: RECIPIENT_COMMITMENT,
        recoveryCommitment: COMMITMENT,
        relayerTip: 5n,
        nonce: NONCE,
      },
    })
    expect(skyEscrowTarget(move(), burn({ skyMove: undefined }))).toBeUndefined()
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
    expect(mocks.buildSkyEscrowRunCall).toHaveBeenCalledWith(FACTORY, d.target.args)
    expect(d.channel.sendTransaction).toHaveBeenCalledWith(FACTORY, "0xdeadbeef")
  })

  it("refuses an escrow that already ran, before any wallet prompt", async () => {
    const d = deps()
    d.reader.daiBalance.mockResolvedValue(0n)
    await expect(runSkyEscrow(d.run)).rejects.toThrow(/already run/)
    expect(d.channel.sendTransaction).not.toHaveBeenCalled()
  })
})

describe("runSkyEscrowRecovery", () => {
  it("signs the escrow's DAI out to the named address and deploys the escrow with the recovery", async () => {
    const d = deps()
    await expect(runSkyEscrowRecovery(d.recovery, TO)).resolves.toBe(HASH)
    const nonce = `0x${"07".repeat(32)}`
    expect(d.signAccount).toHaveBeenCalledWith(
      RECOVERY.account,
      escrowERC20RecoveryDigest(ESCROW, 1n, TO, DAI, nonce as never, CHAIN_NOW + 3600n),
    )
    expect(mocks.buildSkyEscrowRecoverCall).toHaveBeenCalledWith(
      expect.objectContaining({
        deployed: false,
        escrow: ESCROW,
        target: TO,
        token: DAI,
        signature: SIGNATURE,
      }),
    )
    expect(d.channel.sendTransaction).toHaveBeenCalledWith(ESCROW, "0xfeedface")
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
