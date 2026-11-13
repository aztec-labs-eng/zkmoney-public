// What `planPayout` plans for each burn the wallet made before vault moves is pinned as a digest
// of everything it returns, captured before the vault move option existed.
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { SkyRoute } from "@oxide/experiments/sky/sky_savings.js"
import { BroadcasterContract, getBroadcasterArtifact } from "@obsidion/contracts"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { getAddress, type Address, type Hex } from "viem"
import { buildAcrossBridgeOut } from "../../../src/oxide/escrow/acrossBridgeOnWithdraw.js"
import { buildSkyEscrowMove } from "../../../src/oxide/escrow/skySavings.js"
import { planSwapOnWithdraw } from "../../../src/oxide/escrow/swapOnWithdraw.js"
import { HOLDING_ADAPTERS } from "../../../src/oxide/holdings/adapters.js"
import { readHoldingRoute } from "../../../src/oxide/holdings/holdingDeployment.js"
import { buildMove } from "../../../src/oxide/holdings/moveRoute.js"
import {
  planPayout,
  planWithdrawal,
  type PlannedPayout,
  type WithdrawalOptions,
} from "../../../src/services/withdrawal/plainWithdrawal.js"
import { encodeWithdrawalMemo } from "../../../src/services/withdrawal/withdrawalMemo.js"
import {
  EXECUTOR,
  MULTI_STEP,
  fakeChain,
  vaultHolding,
} from "../../oxide/holdings/holdingFixtures.js"

const token = AztecAddress.fromBigIntUnsafe(10n)
const from = AztecAddress.fromBigIntUnsafe(20n)
const BROADCASTER = AztecAddress.fromBigIntUnsafe(11n)
const FEE = 7n
const tuple = {
  l2Token: token.toString(),
  portal: getAddress(`0x${"11".repeat(20)}`),
  token: getAddress(`0x${"33".repeat(20)}`),
  plainWithdrawalExecutor: getAddress(`0x${"44".repeat(20)}`),
  l2Broadcaster: BROADCASTER.toString(),
  swapEscrowFactoryV2: getAddress(`0x${"55".repeat(20)}`),
} as OxideEnvTuple
const recovery = { account: getAddress(`0x${"5a".repeat(20)}`), salt: new Fr(9n) }
const amount = 1_000n * 10n ** 18n
const nonce = `0x${"77".repeat(32)}` as Hex

/** A PXE that already holds the broadcaster, so registering it reads nothing. */
const wallet = {
  pxe: {
    getContractInstance: async () => ({ originalContractClassId: new Fr(1n) }),
    getContractArtifact: async () => ({}),
  },
  node: {},
} as never
const service = { getArtifactForInstance: () => getBroadcasterArtifact() } as never
const broadcaster = async () =>
  BroadcasterContract.at(BROADCASTER, await getBroadcasterArtifact(), wallet)

/** An L1 whose executor takes `FEE` and whose swap factory predicts `escrow`. */
const l1 = (escrow?: Address) =>
  ({
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "FEE" ? FEE : escrow,
  } as never)

async function digest(payout: PlannedPayout): Promise<string> {
  const broadcasts = await Promise.all(
    payout.broadcasts.map(async (interaction) =>
      (
        await interaction.request()
      ).calls.map((call) => ({
        to: call.to.toString(),
        selector: call.selector.toString(),
        args: call.args.map((arg) => arg.toString()),
      })),
    ),
  )
  const { finalizationRequest: request } = payout
  const plain = {
    executor: payout.plainWithdrawal.executor.toString(),
    fee: payout.plainWithdrawal.fee.toString(),
    userPayload: payout.userPayload.toString("hex"),
    finalizationRequest: {
      broadcaster: request.broadcaster.address.toString(),
      portal: request.portal.toString(),
      payoutToken: request.payoutToken.toString(),
    },
    memo: payout.memo.toString("hex"),
    broadcasts,
  }
  return createHash("sha256").update(JSON.stringify(plain)).digest("hex")
}

async function plan(recipient: EthAddress, options: WithdrawalOptions): Promise<string> {
  const payout = await planPayout(wallet, service, token, { from, recipient, amount }, options)
  expect(payout.executor).toEqual(payout.plainWithdrawal.executor)
  return digest(payout)
}

async function plainPlan() {
  return plan(EthAddress.fromString(`0x${"66".repeat(20)}`), { tuple, l1: l1() })
}

async function swapPlan() {
  const swap = planSwapOnWithdraw({
    swapEscrowFactoryV2: tuple.swapEscrowFactoryV2 as Address,
    output: "USDC",
    l1Recipient: getAddress(`0x${"b0".repeat(20)}`),
    recovery,
    amount,
    withdrawalFee: FEE,
    withdrawalRelayerTip: 0n,
    proverTip: 0n,
    relayerTip: 5n * 10n ** 18n,
    nonce,
  })
  return plan(EthAddress.fromString(swap.escrow), { tuple, l1: l1(swap.escrow), swap })
}

async function skyPlan() {
  const move = buildSkyEscrowMove({
    broadcaster: await broadcaster(),
    factory: getAddress(`0x${"fb".repeat(20)}`),
    dai: tuple.token as Address,
    from,
    portal: tuple.portal as Address,
    executor: { address: getAddress(`0x${"e5".repeat(20)}`), fee: 0n },
    amount,
    route: SkyRoute.Stake,
    recipientCommitment: `0x${"2c".repeat(32)}`,
    recovery,
    nonce,
    escrowTip: 3n * 10n ** 18n,
    releaseTip: 10n ** 18n,
  })
  return plan(EthAddress.fromString(move.escrow), { tuple, l1: l1(), escrow: move.options })
}

async function bridgePlan() {
  const out = buildAcrossBridgeOut({
    broadcaster: await broadcaster(),
    l2Broadcaster: AztecAddress.fromBigIntUnsafe(12n).toString(),
    factory: getAddress(`0x${"fc".repeat(20)}`),
    dai: tuple.token as Address,
    portal: tuple.portal as Address,
    executor: { address: tuple.plainWithdrawalExecutor as Address, fee: FEE },
    from,
    amount,
    withdrawalRelayerTip: 10n ** 18n,
    proverTip: 0n,
    token: "USDT",
    chainId: 8453,
    recipient: getAddress(`0x${"b1".repeat(20)}`),
    acrossFee: 250_000n,
    minReceived: 98_000_000n,
    relayerTip: 2n * 10n ** 18n,
    recovery,
    nonce,
  })
  return plan(EthAddress.fromString(out.escrow), { tuple, l1: l1(), escrow: out.escrowOptions })
}

describe("planPayout", () => {
  it.each([
    [
      "plain withdrawal",
      plainPlan,
      "339481d2cd89dfed4cbf8bdb07a18852c9e34581229955700149641ffb244340",
    ],
    ["swap", swapPlan, "29265b3e1eaf7e5a3a395c0d27f818fd8aec224389c67922861bfb1d81693e89"],
    ["Sky move", skyPlan, "4d9677ab9be3ae514bf57a77f6cd0f11d840daf7e711b83bb3dd2dac93efdc13"],
    ["bridge-out", bridgePlan, "b4bcfc51970d410bdb057f5d3623139aca8a6e14b7855353690cfffd1ac9fae5"],
  ])("plans a %s exactly as before vault moves", async (_, planned, pinned) => {
    expect(await planned()).toBe(pinned)
  })
})

describe("planPayout of a vault move", () => {
  const MEMO = encodeWithdrawalMemo({ vaultMove: { nonce } })
  const recipient = EthAddress.fromString(EXECUTOR)

  async function vaultMove(over: { amount?: bigint } = {}) {
    const route = await readHoldingRoute(fakeChain(), HOLDING_ADAPTERS, vaultHolding("DaiUsds"))
    const { operation } = buildMove(route, {
      direction: "in",
      minOut: 7n,
      conversionMinOut: 9n,
      recipientCommitment: `0x${"01".repeat(32)}`,
      from,
      amount: over.amount ?? amount,
      proverTip: 0n,
      relayerTip: 2n,
      recovery,
      recoveryMemo: MEMO,
    })
    return { operation, executor: MULTI_STEP }
  }

  it("burns to the executor under the move's own route and memo, with nothing riding the tx", async () => {
    const multiStep = await vaultMove()
    const options = { tuple, l1: l1(), multiStep }
    const payout = await planPayout(wallet, service, token, { from, recipient, amount }, options)
    expect(payout.executor).toEqual(recipient)
    expect(payout.plainWithdrawal).toEqual({
      executor: EthAddress.fromString(tuple.plainWithdrawalExecutor!),
      fee: FEE,
    })
    expect(payout.userPayload).toEqual(multiStep.operation.userPayload)
    expect(payout.memo).toEqual(MEMO)
    expect(payout.broadcasts).toEqual([])
    expect(payout.finalizationRequest.broadcaster.address).toEqual(BROADCASTER)

    const { operation } = await planWithdrawal(
      wallet,
      service,
      token,
      { from, recipient, amount },
      options,
    )
    expect(operation.executor).toEqual(recipient)
    expect(operation.recoveryMemo).toEqual(MEMO)
  })

  it("refuses a vault move beside an escrow or a swap, or built for another burn", async () => {
    const multiStep = await vaultMove()
    const burn = { from, recipient, amount }
    const refused = (options: Partial<WithdrawalOptions>, code: string) =>
      expect(
        planPayout(wallet, service, token, burn, { tuple, l1: l1(), multiStep, ...options }),
      ).rejects.toMatchObject({ code })
    const skyMove = buildSkyEscrowMove({
      broadcaster: await broadcaster(),
      factory: getAddress(`0x${"fb".repeat(20)}`),
      dai: tuple.token as Address,
      from,
      portal: tuple.portal as Address,
      executor: { address: getAddress(`0x${"e5".repeat(20)}`), fee: 0n },
      amount,
      route: SkyRoute.Stake,
      recipientCommitment: `0x${"2c".repeat(32)}`,
      recovery,
      nonce,
      escrowTip: 3n * 10n ** 18n,
      releaseTip: 10n ** 18n,
    })
    await refused({ escrow: skyMove.options }, "invariant")
    const swap = { escrowArgs: {}, recovery } as unknown as WithdrawalOptions["swap"]
    await refused({ swap }, "invariant")
    await refused({ multiStep: await vaultMove({ amount: amount - 1n }) }, "invariant")
    const elsewhere = { ...MULTI_STEP, adapters: {} }
    await refused({ multiStep: { ...multiStep, executor: elsewhere } }, "move.routeMismatch")
  })
})
