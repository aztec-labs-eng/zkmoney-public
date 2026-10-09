import { beforeEach, describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { EthAddress } from "@aztec/foundation/eth-address"
import { getAddress } from "viem"
import {
  SwapRoute,
  encodeSwapEscrowDeploy,
  encodeWithdrawalBroadcast,
  predictSwapEscrowAddressLocally,
  type SwapEscrowArgs,
} from "@oxide/l1-contracts"
import { SkyRoute, predictSkyEscrowAddressLocally } from "@oxide/experiments/sky/sky_savings.js"
import { unpackFieldsToBytes } from "@oxide/oxide-lib/field_bytes.js"
import {
  L1OperationCondition,
  L1OperationConditionKind,
} from "@oxide/oxide-lib/l1_operation_calldata.js"
import {
  decodePlainWithdrawalPayload,
  encodePlainWithdrawalPayload,
} from "@oxide/oxide-lib/plain_withdrawal.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { OxideEnvTuple } from "@obsidion/core/types"

// The broadcaster records each method call and returns it as the interaction, so a returned
// broadcast is the exact call the burn tx carries.
type Call = { method: string; args: any[]; broadcaster: string }
const f = vi.hoisted(() => ({ calls: [] as Call[], register: vi.fn() }))
vi.mock("@obsidion/contracts", async () => ({
  ...(await vi.importActual<typeof import("@obsidion/contracts")>("@obsidion/contracts")),
  getBroadcasterArtifact: async () => ({}),
  ensureContractRegisteredInPXE: (...args: unknown[]) => f.register(...args),
  BroadcasterContract: {
    at: (address: AztecAddress) => ({
      methods: new Proxy(
        {},
        {
          get:
            (_target, method: string) =>
            (...args: any[]) => {
              const call = { method, args, broadcaster: address.toString() }
              f.calls.push(call)
              return call
            },
        },
      ),
    }),
  },
}))
import { decodeWithdrawMeta } from "../../src/services/withdrawMeta.js"
import {
  planPayout,
  planWithdrawal,
  plainUserPayload,
  type WithdrawalOptions,
} from "../../src/services/plainWithdrawal.js"

const token = AztecAddress.fromBigIntUnsafe(10n)
const from = AztecAddress.fromBigIntUnsafe(20n)
const recipient = EthAddress.fromString(`0x${"66".repeat(20)}`)
const tuple = {
  l2Token: token.toString(),
  portal: `0x${"11".repeat(20)}`,
  token: `0x${"33".repeat(20)}`,
  plainWithdrawalExecutor: `0x${"44".repeat(20)}`,
  l2Broadcaster: AztecAddress.fromBigIntUnsafe(11n).toString(),
  swapEscrowFactoryV2: `0x${"55".repeat(20)}`,
} as OxideEnvTuple
const portal = { fpcFundingCut: 7n, frozen: false }
const options: WithdrawalOptions = { tuple, portal }
const wallet = { pxe: {}, node: {} } as never
const service = { getOxideClient: () => null, getArtifactForInstance: async () => ({}) } as never
const recovery = { account: `0x${"88".repeat(20)}` as const, salt: new Fr(42n) }
const escrowArgs: SwapEscrowArgs = {
  route: SwapRoute.USDT,
  recipient: `0x${"77".repeat(20)}`,
  daiForGas: 0n,
  minEthForGas: 0n,
  recoveryCommitment: deriveRecoveryCommitment(
    recovery.salt,
    EthAddress.fromString(recovery.account),
  ).toString(),
  relayerTip: 1n,
  nonce: `0x${"99".repeat(32)}`,
}
const escrow = EthAddress.fromString(
  predictSwapEscrowAddressLocally(tuple.swapEscrowFactoryV2 as `0x${string}`, escrowArgs),
)
const swap = {
  escrowArgs,
  recovery,
  l1: { readContract: vi.fn(async () => escrow.toString()) } as never,
}
const burn = { from, recipient, amount: 1_000n * 10n ** 18n }

const hex = (buf: Buffer) => `0x${buf.toString("hex")}`

beforeEach(() => {
  f.calls.length = 0
  f.register.mockClear()
})

describe("plainUserPayload", () => {
  it("pays the recipient and offers the wallet's relayer tip", () => {
    const payload = decodePlainWithdrawalPayload(plainUserPayload(recipient))
    expect(payload.recipient.equals(recipient)).toBe(true)
    expect(payload.relayerTip).toBe(WITHDRAW_RELAYER_TIP)
  })
})

describe("planPayout", () => {
  it("settles into the executor and broadcasts the portal release in the burn tx", async () => {
    const planned = await planPayout(wallet, service, token, burn, options)

    expect(planned.plainWithdrawal).toEqual({
      executor: EthAddress.fromString(tuple.plainWithdrawalExecutor!),
      ...portal,
    })
    expect(planned.userPayload).toEqual(plainUserPayload(recipient))
    expect(decodeWithdrawMeta(planned.meta)).toEqual({
      recipient: getAddress(recipient.toString()),
    })
    expect(f.register.mock.calls[0]![2].toString()).toBe(tuple.l2Broadcaster)

    expect(planned.broadcasts).toEqual([f.calls[0]])
    const [target, payoutToken, bytesLen, fields, condition] = f.calls[0]!.args
    expect(f.calls[0]!.method).toBe("broadcast_l1_operation_2k")
    expect(target.toString()).toBe(tuple.portal)
    expect(payoutToken.toString()).toBe(tuple.token)
    expect(hex(unpackFieldsToBytes(bytesLen, fields))).toBe(encodeWithdrawalBroadcast())
    expect(condition.kind).toBe(L1OperationConditionKind.MessageInOutbox)
  })

  it("pays the swap escrow and pairs the release with the escrow's swap", async () => {
    const planned = await planPayout(
      wallet,
      service,
      token,
      { ...burn, recipient: escrow },
      { ...options, swap },
    )

    expect(decodePlainWithdrawalPayload(planned.userPayload)).toEqual({
      recipient: escrow,
      relayerTip: WITHDRAW_RELAYER_TIP,
    })
    expect(decodeWithdrawMeta(planned.meta)).toEqual({
      recipient: getAddress(escrow.toString()),
      swap: {
        output: "USDT",
        recipient: getAddress(escrowArgs.recipient),
        factory: getAddress(tuple.swapEscrowFactoryV2!),
        recoveryCommitment: escrowArgs.recoveryCommitment,
        relayerTip: escrowArgs.relayerTip,
        nonce: escrowArgs.nonce,
        daiForGas: 0n,
        minEthForGas: 0n,
      },
    })

    expect(planned.broadcasts).toHaveLength(1)
    const pair = planned.broadcasts[0] as unknown as { method: string; args: any[] }
    expect(pair.method).toBe("broadcast_l1_operation_pair_2k")
    const [targets, payoutTokens, bytesLens, fields, conditions] = pair.args
    expect(targets.map(String)).toEqual([tuple.portal, tuple.swapEscrowFactoryV2])
    expect(payoutTokens.map(String)).toEqual([tuple.token, tuple.token])
    expect(hex(unpackFieldsToBytes(bytesLens[0], fields[0]))).toBe(encodeWithdrawalBroadcast())
    expect(hex(unpackFieldsToBytes(bytesLens[1], fields[1]))).toBe(
      encodeSwapEscrowDeploy(escrowArgs),
    )
    expect(conditions.map((c: { kind: number }) => c.kind)).toEqual([
      L1OperationConditionKind.MessageInOutbox,
      L1OperationConditionKind.Balance,
    ])
    expect(conditions[1].token.toString()).toBe(tuple.token)
    expect(conditions[1].recipient.equals(escrow)).toBe(true)
  })

  it("pays an escrow oxide-client built and pairs the release with the escrow's own run", async () => {
    const factory = EthAddress.fromString(`0x${"aa".repeat(20)}`)
    const userPayload = encodePlainWithdrawalPayload({ recipient: escrow, relayerTip: 3n })
    const run = {
      target: factory,
      payoutToken: EthAddress.fromString(tuple.token),
      calldata: Buffer.from("c0ffee", "hex"),
      condition: L1OperationCondition.balance(EthAddress.fromString(tuple.token), escrow),
    }
    const escrowRun = { escrow, userPayload, l1Operation: run }

    const planned = await planPayout(
      wallet,
      service,
      token,
      { ...burn, recipient: escrow },
      { ...options, escrow: escrowRun },
    )

    expect(planned.userPayload).toBe(userPayload)
    expect(decodeWithdrawMeta(planned.meta)).toEqual({ recipient: getAddress(escrow.toString()) })
    const pair = planned.broadcasts[0] as unknown as { method: string; args: any[] }
    expect(pair.method).toBe("broadcast_l1_operation_pair_2k")
    const [targets, , bytesLens, fields, conditions] = pair.args
    expect(targets.map(String)).toEqual([tuple.portal, factory.toString()])
    expect(hex(unpackFieldsToBytes(bytesLens[1], fields[1]))).toBe("0xc0ffee")
    expect(conditions[1].kind).toBe(L1OperationConditionKind.Balance)

    await expect(
      planPayout(wallet, service, token, burn, { ...options, escrow: escrowRun }),
    ).rejects.toThrow("escrow differs from the withdrawal destination")
  })

  it("keeps a Sky escrow's args in the burn's meta, and refuses args for another escrow", async () => {
    const sky = {
      route: SkyRoute.Stake,
      factory: getAddress(`0x${"fb".repeat(20)}`),
      recipientCommitment: `0x${"2c".repeat(32)}` as const,
      recoveryCommitment: escrowArgs.recoveryCommitment as `0x${string}`,
      relayerTip: 2n,
      nonce: `0x${"88".repeat(32)}` as const,
    }
    const skyEscrow = EthAddress.fromString(predictSkyEscrowAddressLocally(sky.factory, sky))
    const run = {
      target: EthAddress.fromString(sky.factory),
      payoutToken: EthAddress.fromString(tuple.token),
      calldata: Buffer.from("c0ffee", "hex"),
      condition: L1OperationCondition.balance(EthAddress.fromString(tuple.token), skyEscrow),
    }
    const escrowRun = { escrow: skyEscrow, userPayload: Buffer.alloc(0), l1Operation: run, sky }

    const planned = await planPayout(
      wallet,
      service,
      token,
      { ...burn, recipient: skyEscrow },
      { ...options, escrow: escrowRun },
    )
    expect(decodeWithdrawMeta(planned.meta)).toEqual({
      recipient: getAddress(skyEscrow.toString()),
      sky,
    })

    await expect(
      planPayout(
        wallet,
        service,
        token,
        { ...burn, recipient: skyEscrow },
        { ...options, escrow: { ...escrowRun, sky: { ...sky, relayerTip: 3n } } },
      ),
    ).rejects.toThrow("Sky escrow args do not derive the withdrawal destination")
  })

  it("broadcasts an escrow's run through the broadcaster it names", async () => {
    const factory = EthAddress.fromString(`0x${"aa".repeat(20)}`)
    const run = {
      target: factory,
      payoutToken: EthAddress.fromString(tuple.token),
      calldata: Buffer.from("c0ffee", "hex"),
      condition: L1OperationCondition.balance(EthAddress.fromString(tuple.token), escrow),
    }
    const runner = AztecAddress.fromBigIntUnsafe(12n).toString()
    const escrowRun = {
      escrow,
      userPayload: Buffer.alloc(0),
      l1Operation: run,
      broadcaster: runner,
    }

    const planned = await planPayout(
      wallet,
      service,
      token,
      { ...burn, recipient: escrow },
      { ...options, escrow: escrowRun },
    )

    const [release, escrowCall] = planned.broadcasts as unknown as Call[]
    expect(planned.broadcasts).toHaveLength(2)
    expect(release).toMatchObject({
      method: "broadcast_l1_operation_2k",
      broadcaster: tuple.l2Broadcaster,
    })
    expect(release!.args[0].toString()).toBe(tuple.portal)
    expect(escrowCall).toMatchObject({ method: "broadcast_l1_operation_2k", broadcaster: runner })
    expect(escrowCall!.args[0].toString()).toBe(factory.toString())
    expect(f.register.mock.calls.map((call) => call[2].toString())).toEqual([
      tuple.l2Broadcaster,
      runner,
    ])

    const sameDeployment = await planPayout(
      wallet,
      service,
      token,
      { ...burn, recipient: escrow },
      { ...options, escrow: { ...escrowRun, broadcaster: tuple.l2Broadcaster } },
    )
    expect(sameDeployment.broadcasts).toHaveLength(1)
    expect((sameDeployment.broadcasts[0] as unknown as Call).method).toBe(
      "broadcast_l1_operation_pair_2k",
    )
  })

  it("reads the contract service's current deployment when no tuple is given", async () => {
    const client = { initialize: vi.fn(async () => {}), getCurrentTuple: () => tuple }
    const current = { ...(service as object), getOxideClient: () => client } as never

    const planned = await planPayout(wallet, current, token, burn, { portal })

    expect(client.initialize).toHaveBeenCalledOnce()
    expect(planned.plainWithdrawal.executor.toString()).toBe(tuple.plainWithdrawalExecutor)
  })

  it("refuses an unknown or incomplete source deployment before registering anything", async () => {
    await expect(planPayout(wallet, service, token, burn, { portal })).rejects.toThrow(
      "source deployment tuple",
    )
    const unavailable = {
      ...(service as object),
      getOxideClient: () => ({ initialize: async () => {}, getCurrentTuple: () => null }),
    } as never
    await expect(planPayout(wallet, unavailable, token, burn, { portal })).rejects.toThrow(
      "deployment is unavailable",
    )
    await expect(
      planPayout(wallet, service, AztecAddress.fromBigIntUnsafe(12n), burn, options),
    ).rejects.toThrow("differs from its source deployment")
    for (const missing of ["plainWithdrawalExecutor", "l2Broadcaster"] as const) {
      await expect(
        planPayout(wallet, service, token, burn, {
          ...options,
          tuple: { ...tuple, [missing]: undefined },
        }),
      ).rejects.toThrow("no plain withdrawal executor or broadcaster")
    }
    expect(f.register).not.toHaveBeenCalled()
  })

  it("refuses a swap the deployment or the destination does not match", async () => {
    await expect(planPayout(wallet, service, token, burn, { ...options, swap })).rejects.toThrow(
      "swap escrow differs from the withdrawal destination",
    )
    // A recovery that does not open the args' commitment builds a different escrow.
    for (const other of [
      { ...recovery, salt: new Fr(43n) },
      { ...recovery, account: `0x${"89".repeat(20)}` as const },
    ]) {
      await expect(
        planPayout(
          wallet,
          service,
          token,
          { ...burn, recipient: escrow },
          { ...options, swap: { ...swap, recovery: other } },
        ),
      ).rejects.toThrow("swap escrow differs from the withdrawal destination")
    }
    await expect(
      planPayout(
        wallet,
        service,
        token,
        { ...burn, recipient: escrow },
        { ...options, swap, tuple: { ...tuple, swapEscrowFactoryV2: undefined } },
      ),
    ).rejects.toThrow("no swap factory")
  })

  it("asks the factory to confirm the escrow before the burn is planned", async () => {
    await planPayout(wallet, service, token, { ...burn, recipient: escrow }, { ...options, swap })

    expect((swap.l1 as { readContract: unknown }).readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: tuple.swapEscrowFactoryV2,
        functionName: "predictEscrowAddress",
        args: [escrowArgs],
      }),
    )
  })

  it("refuses a factory that cannot deploy the escrow, as one with the legacy layout", async () => {
    const reverts = {
      readContract: vi.fn(async () => Promise.reject(new Error("execution reverted"))),
    }
    const other = { readContract: vi.fn(async () => `0x${"ab".repeat(20)}`) }
    for (const [l1, error] of [
      [reverts, /did not confirm/],
      [other, /predicts/],
    ] as const) {
      f.calls.length = 0
      await expect(
        planPayout(
          wallet,
          service,
          token,
          { ...burn, recipient: escrow },
          {
            ...options,
            swap: { ...swap, l1: l1 as never },
          },
        ),
      ).rejects.toThrow(error)
      expect(f.calls.map((c) => c.method)).not.toContain("broadcast_l1_operation_pair_2k")
    }
  })
})

describe("planWithdrawal", () => {
  it("wraps the payout as a direct withdraw from the burner", async () => {
    const authwitNonce = new Fr(5n)
    const planned = await planWithdrawal(
      wallet,
      service,
      token,
      { ...burn, proverTip: 3n, authwitNonce },
      options,
    )
    const payout = await planPayout(wallet, service, token, burn, options)

    expect(planned.operation).toEqual({
      kind: "withdraw",
      from,
      executor: payout.plainWithdrawal.executor,
      userPayload: payout.userPayload,
      amount: burn.amount,
      proverTip: 3n,
      meta: payout.meta,
      authwitNonce,
    })
    expect(planned.plainWithdrawal).toEqual(payout.plainWithdrawal)
    expect(planned.broadcasts).toEqual(payout.broadcasts)
  })

  it("defaults the prover tip to zero", async () => {
    const planned = await planWithdrawal(wallet, service, token, burn, options)
    expect(planned.operation.proverTip).toBe(0n)
    expect(planned.operation.authwitNonce).toBeUndefined()
  })
})
