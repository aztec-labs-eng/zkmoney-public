import { beforeEach, describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { getAddress } from "viem"
import {
  SwapRoute,
  encodeSwapEscrowDeploy,
  predictSwapEscrowAddressLocally,
  type SwapEscrowArgs,
} from "@oxide/l1-contracts"
import { SkyRoute, predictSkyEscrowAddressLocally } from "@oxide/experiments/sky/sky_savings.js"
import {
  L1OperationCondition,
  L1OperationConditionKind,
  decodeL1OperationCalldata,
  encodeL1OperationCalldata,
} from "@oxide/oxide-lib/l1_operation_calldata.js"
import {
  decodePlainWithdrawalPayload,
  encodePlainWithdrawalPayload,
} from "@oxide/oxide-lib/plain_withdrawal_executor.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { OxideEnvTuple } from "@obsidion/core/types"

// The broadcaster records each method call and returns it as the interaction, so a returned
// broadcast is the exact call the burn tx carries.
type Call = { method: string; args: any[]; broadcaster: string }
const f = vi.hoisted(() => ({
  calls: [] as Call[],
  register: vi.fn(),
  broadcasters: new Map<string, object>(),
}))
vi.mock("@obsidion/contracts", async () => ({
  ...(await vi.importActual<typeof import("@obsidion/contracts")>("@obsidion/contracts")),
  getBroadcasterArtifact: async () => ({}),
  ensureContractRegisteredInPXE: (...args: unknown[]) => f.register(...args),
  BroadcasterContract: {
    at: (address: AztecAddress) => {
      const key = address.toString()
      if (!f.broadcasters.has(key)) {
        const methods = new Proxy(
          {},
          {
            get:
              (_target, method: string) =>
              (...args: any[]) => {
                const call = { method, args, broadcaster: key }
                f.calls.push(call)
                return call
              },
          },
        )
        f.broadcasters.set(key, { address, methods })
      }
      return f.broadcasters.get(key)
    },
  },
}))
import {
  nestedWithdrawal,
  planPayout,
  planWithdrawal,
  plainUserPayload,
  type WithdrawalOptions,
} from "../../src/services/plainWithdrawal.js"
import { decodeWithdrawalMemo } from "../../src/services/withdrawalMemo.js"

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
/** The executor's `FEE()`. */
const FEE = 7n
// Answers the executor's fee, and the swap factory's prediction of the escrow.
const l1 = {
  readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
    functionName === "FEE" ? FEE : escrow.toString(),
  ),
}
const options: WithdrawalOptions = { tuple, l1: l1 as never }
const swap = { escrowArgs, recovery }
const burn = { from, recipient, amount: 1_000n * 10n ** 18n }

const hex = (buf: Buffer) => `0x${buf.toString("hex")}`
const broadcasterAt = (address: string) => f.broadcasters.get(address)

function escrowRun(target: EthAddress, to: EthAddress) {
  return {
    target,
    payoutToken: EthAddress.fromString(tuple.token),
    calldata: Buffer.from("c0ffee", "hex"),
    condition: L1OperationCondition.balance(EthAddress.fromString(tuple.token), to),
  }
}

beforeEach(() => {
  f.calls.length = 0
  f.register.mockClear()
  l1.readContract.mockClear()
})

describe("plainUserPayload", () => {
  it("pays the recipient and offers the wallet's relayer tip", () => {
    const payload = decodePlainWithdrawalPayload(plainUserPayload(recipient))
    expect(payload.recipient.equals(recipient)).toBe(true)
    expect(payload.relayerTip).toBe(WITHDRAW_RELAYER_TIP)
  })
})

describe("planPayout", () => {
  it("settles into the executor, requests finalization at the portal, and broadcasts nothing", async () => {
    const planned = await planPayout(wallet, service, token, burn, options)

    expect(planned.plainWithdrawal).toEqual({
      executor: EthAddress.fromString(tuple.plainWithdrawalExecutor!),
      fee: FEE,
    })
    expect(l1.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: tuple.plainWithdrawalExecutor, functionName: "FEE" }),
    )
    expect(planned.userPayload).toEqual(plainUserPayload(recipient))
    expect(f.register.mock.calls.map((call) => call[2].toString())).toEqual([tuple.l2Broadcaster])
    expect(planned.finalizationRequest.broadcaster).toBe(broadcasterAt(tuple.l2Broadcaster!))
    expect(planned.finalizationRequest.portal.toString()).toBe(tuple.portal)
    expect(planned.finalizationRequest.payoutToken.toString()).toBe(tuple.token)
    expect(planned.broadcasts).toEqual([])
    expect(planned.memo).toEqual(Buffer.alloc(0))
    expect(f.calls).toEqual([])
  })

  it("pays the swap escrow and broadcasts only the escrow's swap", async () => {
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
    expect(planned.finalizationRequest.portal.toString()).toBe(tuple.portal)

    expect(planned.broadcasts).toHaveLength(1)
    const run = planned.broadcasts[0] as unknown as Call
    const deploy = Buffer.from(encodeSwapEscrowDeploy(escrowArgs).slice(2), "hex")
    expect(run.method).toBe(encodeL1OperationCalldata(deploy).tier.method)
    expect(run.broadcaster).toBe(tuple.l2Broadcaster)
    const [target, payoutToken, bytesLen, fields, condition] = run.args
    expect(target.toString()).toBe(tuple.swapEscrowFactoryV2)
    expect(payoutToken.toString()).toBe(tuple.token)
    expect(hex(decodeL1OperationCalldata(bytesLen, fields))).toBe(hex(deploy))
    expect(condition.kind).toBe(L1OperationConditionKind.Balance)
    expect(condition.token.toString()).toBe(tuple.token)
    expect(condition.recipient.equals(escrow)).toBe(true)

    // The memo keeps what the escrow commits to, so a rescan rebuilds the swap.
    const { route: _, ...args } = escrowArgs
    expect(decodeWithdrawalMemo(planned.memo)).toEqual({
      swap: { ...args, output: "USDT", factory: getAddress(tuple.swapEscrowFactoryV2!) },
    })
  })

  it("pays an escrow oxide-client built and broadcasts only the escrow's own run", async () => {
    const factory = EthAddress.fromString(`0x${"aa".repeat(20)}`)
    const userPayload = encodePlainWithdrawalPayload({ recipient: escrow, relayerTip: 3n })
    const run = { escrow, userPayload, l1Operation: escrowRun(factory, escrow), withdrawalFee: 0n }

    const planned = await planPayout(
      wallet,
      service,
      token,
      { ...burn, recipient: escrow },
      { ...options, escrow: run },
    )

    expect(planned.userPayload).toBe(userPayload)
    // The escrow was priced with its executor's fee, so the executor is not read again.
    expect(planned.plainWithdrawal.fee).toBe(0n)
    expect(planned.plainWithdrawal.executor.toString()).toBe(
      EthAddress.fromString(tuple.plainWithdrawalExecutor!).toString(),
    )
    expect(l1.readContract).not.toHaveBeenCalled()
    expect(planned.broadcasts).toHaveLength(1)
    const call = planned.broadcasts[0] as unknown as Call
    expect(call).toMatchObject({
      method: "broadcast_l1_operation_2k",
      broadcaster: tuple.l2Broadcaster,
    })
    const [target, , bytesLen, fields, condition] = call.args
    expect(target.toString()).toBe(factory.toString())
    expect(hex(decodeL1OperationCalldata(bytesLen, fields))).toBe("0xc0ffee")
    expect(condition.kind).toBe(L1OperationConditionKind.Balance)

    await expect(
      planPayout(wallet, service, token, burn, { ...options, escrow: run }),
    ).rejects.toThrow("escrow differs from the withdrawal destination")
  })

  it("pays the executor an escrow names instead of the deployment's plain one", async () => {
    const executor = `0x${"5e".repeat(20)}` as const
    const run = {
      escrow,
      userPayload: encodePlainWithdrawalPayload({ recipient: escrow, relayerTip: 3n }),
      l1Operation: escrowRun(EthAddress.fromString(`0x${"aa".repeat(20)}`), escrow),
      executor,
      withdrawalFee: 0n,
    }

    const planned = await planPayout(
      wallet,
      service,
      token,
      { ...burn, recipient: escrow },
      { ...options, escrow: run },
    )

    expect(planned.plainWithdrawal.executor.toString()).toBe(
      EthAddress.fromString(executor).toString(),
    )
    expect(l1.readContract).not.toHaveBeenCalled()
  })

  it("accepts Sky args that derive the escrow, and refuses args for another escrow", async () => {
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
      escrow: skyEscrow,
      userPayload: Buffer.alloc(0),
      l1Operation: escrowRun(EthAddress.fromString(sky.factory), skyEscrow),
      sky,
      withdrawalFee: 0n,
    }

    const planned = await planPayout(
      wallet,
      service,
      token,
      { ...burn, recipient: skyEscrow },
      { ...options, escrow: run },
    )
    expect(planned.broadcasts).toHaveLength(1)
    expect(decodeWithdrawalMemo(planned.memo)).toEqual({ sky })

    await expect(
      planPayout(
        wallet,
        service,
        token,
        { ...burn, recipient: skyEscrow },
        { ...options, escrow: { ...run, sky: { ...sky, relayerTip: 3n } } },
      ),
    ).rejects.toThrow("Sky escrow args do not derive the withdrawal destination")
  })

  it("broadcasts an escrow's run through the broadcaster it names", async () => {
    const factory = EthAddress.fromString(`0x${"aa".repeat(20)}`)
    const runner = AztecAddress.fromBigIntUnsafe(12n).toString()
    const run = {
      escrow,
      userPayload: Buffer.alloc(0),
      l1Operation: escrowRun(factory, escrow),
      broadcaster: runner,
      withdrawalFee: 0n,
    }

    const planned = await planPayout(
      wallet,
      service,
      token,
      { ...burn, recipient: escrow },
      { ...options, escrow: run },
    )

    expect(planned.broadcasts).toHaveLength(1)
    expect(planned.broadcasts[0]).toMatchObject({
      method: "broadcast_l1_operation_2k",
      broadcaster: runner,
    })
    expect(planned.finalizationRequest.broadcaster).toBe(broadcasterAt(tuple.l2Broadcaster!))
    expect(f.register.mock.calls.map((call) => call[2].toString())).toEqual([
      tuple.l2Broadcaster,
      runner,
    ])

    f.register.mockClear()
    const sameDeployment = await planPayout(
      wallet,
      service,
      token,
      { ...burn, recipient: escrow },
      { ...options, escrow: { ...run, broadcaster: tuple.l2Broadcaster } },
    )
    expect(sameDeployment.broadcasts[0]).toMatchObject({ broadcaster: tuple.l2Broadcaster })
    expect(f.register).toHaveBeenCalledOnce()
  })

  it("reads the contract service's current deployment when no tuple is given", async () => {
    const client = { initialize: vi.fn(async () => {}), getCurrentTuple: () => tuple }
    const current = { ...(service as object), getOxideClient: () => client } as never

    const planned = await planPayout(wallet, current, token, burn, { l1: l1 as never })

    expect(client.initialize).toHaveBeenCalledOnce()
    expect(planned.plainWithdrawal.executor.toString()).toBe(tuple.plainWithdrawalExecutor)
  })

  it("refuses an unknown or incomplete source deployment before registering anything", async () => {
    await expect(planPayout(wallet, service, token, burn, { l1: l1 as never })).rejects.toThrow(
      "source deployment tuple",
    )
    const unavailable = {
      ...(service as object),
      getOxideClient: () => ({ initialize: async () => {}, getCurrentTuple: () => null }),
    } as never
    await expect(planPayout(wallet, unavailable, token, burn, { l1: l1 as never })).rejects.toThrow(
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

    expect(l1.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: tuple.swapEscrowFactoryV2,
        functionName: "predictEscrowAddress",
        args: [escrowArgs],
      }),
    )
  })

  it("refuses a factory that cannot deploy the escrow, as one with the legacy layout", async () => {
    const factory = (answer: () => Promise<string>) => ({
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === "FEE" ? FEE : answer(),
      ),
    })
    const reverts = factory(() => Promise.reject(new Error("execution reverted")))
    const other = factory(async () => `0x${"ab".repeat(20)}`)
    for (const [factoryL1, error] of [
      [reverts, /did not confirm/],
      [other, /predicts/],
    ] as const) {
      await expect(
        planPayout(
          wallet,
          service,
          token,
          { ...burn, recipient: escrow },
          { ...options, l1: factoryL1 as never, swap },
        ),
      ).rejects.toThrow(error)
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
      finalizationRequestBroadcastParams: payout.finalizationRequest,
      recoveryMemo: payout.memo,
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

describe("nestedWithdrawal", () => {
  it("declares a contract's nested burn of the payout", async () => {
    const payout = await planPayout(wallet, service, token, burn, options)
    const escrowAccount = AztecAddress.fromBigIntUnsafe(30n)

    expect(nestedWithdrawal(payout, { from: escrowAccount, amount: 7n, proverTip: 2n })).toEqual({
      kind: "withdraw",
      from: escrowAccount,
      executor: payout.plainWithdrawal.executor,
      userPayload: payout.userPayload,
      amount: 7n,
      proverTip: 2n,
      finalizationRequestBroadcastParams: payout.finalizationRequest,
      recoveryMemo: payout.memo,
    })
  })
})
