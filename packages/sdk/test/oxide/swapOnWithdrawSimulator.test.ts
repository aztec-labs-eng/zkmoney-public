/**
 * The tip a swap withdrawal commits to is whatever this simulation says the relayer's break-even is, times
 * the margin. What is pinned: the relayer's exact arithmetic (its buffers, rounding and feed rules — drifting
 * from them under-tips every swap), the storage-slot discovery that funds the counterfactual escrow, and that
 * the simulated transaction is the one the relayer sends.
 */
import { describe, expect, it, vi } from "vitest"
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  multicall3Abi,
  parseGwei,
  type Address,
  type Hex,
  type PublicClient,
  type StateOverride,
} from "viem"
import { defaultL1TxUtilsConfig } from "@aztec/ethereum/l1-tx-utils/config"
import {
  OperationExecutorAbi,
  SwapEscrowFactoryAbi,
  SwapRoute,
  predictSwapEscrowAddressLocally,
} from "@oxide/l1-contracts"
import { SWAP_ON_WITHDRAW_TIP_MARGIN_BPS } from "@obsidion/core/constants"
import { MULTICALL3_ADDRESS } from "../../src/services/sipaClaim.js"
import {
  ETH_USD_FEED_DECIMALS,
  EXECUTOR_MIN_PAYOUT_CALLDATA_GAS,
  MAX_ETH_USD_AGE_SECONDS,
  SwapOnWithdrawSimulator,
  SwapTipExceedsInputError,
  findBalanceOfSlot,
  mappingSlot,
  relayerTipFromGas,
} from "../../src/oxide/swapOnWithdrawSimulator.js"

const FEED_SCALE = 10n ** ETH_USD_FEED_DECIMALS
const NOW = 1_800_000_000n
const fresh = (answer: bigint) => ({ answer, updatedAt: NOW })
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b

describe("relayerTipFromGas", () => {
  it("applies the relayer's gas buffer, calldata gas, fee bumps and margin", () => {
    const tip = relayerTipFromGas({
      gasEstimate: 100_000n,
      baseFee: parseGwei("10"),
      priorityFee: parseGwei("1"),
      ethUsd: fresh(3000n * FEED_SCALE),
      blockTimestamp: NOW,
    })
    // L1TxUtils: estimate + 20%, then the relayer adds the non-zero minPayout calldata gas.
    expect(tip.gasLimit).toBe(120_000n + EXECUTOR_MIN_PAYOUT_CALLDATA_GAS)
    // base fee bumped 12.5% for the one block it tolerates stalling, priority fee bumped 20%.
    expect(tip.maxFeePerGas).toBe(parseGwei("11.25") + parseGwei("1.2"))
    expect(tip.ethUsd).toBe(3000n * FEED_SCALE)
    expect(tip.breakEven).toBe(tip.gasLimit * tip.maxFeePerGas * 3000n)
    expect(tip.relayerTip).toBe((tip.breakEven * SWAP_ON_WITHDRAW_TIP_MARGIN_BPS) / 10_000n)
  })

  it("rounds every division up, so the tip never lands below the relayer's own figure", () => {
    const tip = relayerTipFromGas({
      gasEstimate: 1n,
      baseFee: 1n,
      priorityFee: 0n,
      ethUsd: fresh(1n),
      blockTimestamp: NOW,
    })
    expect(tip.gasLimit).toBe(1n + EXECUTOR_MIN_PAYOUT_CALLDATA_GAS)
    // ceil(1 * 1.125) = 2
    expect(tip.maxFeePerGas).toBe(2n)
    expect(tip.breakEven).toBe(ceilDiv(tip.gasLimit * 2n * 1n, FEED_SCALE))
    expect(tip.breakEven).toBe(1n)
    expect(tip.relayerTip).toBe(ceilDiv(1n * SWAP_ON_WITHDRAW_TIP_MARGIN_BPS, 10_000n))
    expect(tip.relayerTip).toBe(2n)
  })

  it("caps the max fee where L1TxUtils caps it", () => {
    const tip = relayerTipFromGas({
      gasEstimate: 100_000n,
      baseFee: parseGwei("3000"),
      priorityFee: parseGwei("100"),
      ethUsd: fresh(FEED_SCALE),
      blockTimestamp: NOW,
    })
    expect(tip.maxFeePerGas).toBe(parseGwei(String(defaultL1TxUtilsConfig.maxGwei)))
  })

  it("refuses a stale or non-positive feed, like the relayer's oracle", () => {
    const inputs = { gasEstimate: 100_000n, baseFee: 1n, priorityFee: 1n, blockTimestamp: NOW }
    expect(() =>
      relayerTipFromGas({
        ...inputs,
        ethUsd: { answer: FEED_SCALE, updatedAt: NOW - MAX_ETH_USD_AGE_SECONDS - 1n },
      }),
    ).toThrow(/stale/)
    expect(() =>
      relayerTipFromGas({
        ...inputs,
        ethUsd: { answer: FEED_SCALE, updatedAt: NOW - MAX_ETH_USD_AGE_SECONDS },
      }),
    ).not.toThrow()
    expect(() => relayerTipFromGas({ ...inputs, ethUsd: fresh(0n) })).toThrow(/answered 0/)
    expect(() => relayerTipFromGas({ ...inputs, ethUsd: fresh(-1n) })).toThrow(/answered -1/)
  })
})

/** A token whose `balanceOf` mapping lives at `slot`, answering only through the state override. */
function tokenWithBalanceSlot(slot: bigint | undefined) {
  return {
    readContract: vi.fn(
      async ({
        args,
        stateOverride,
      }: {
        args: readonly [Address]
        stateOverride?: StateOverride
      }) => {
        if (slot === undefined) return 0n
        const wanted = mappingSlot(args[0], slot)
        const hit = stateOverride?.[0]?.stateDiff?.find((entry) => entry.slot === wanted)
        return hit ? BigInt(hit.value) : 0n
      },
    ),
  } as unknown as Pick<PublicClient, "readContract">
}

describe("findBalanceOfSlot", () => {
  it("finds OpenZeppelin's slot 0 (the sandbox TestERC20) in one call", async () => {
    const client = tokenWithBalanceSlot(0n)
    await expect(
      findBalanceOfSlot(client, "0x000000000000000000000000000000000000da1a"),
    ).resolves.toBe(0n)
    expect(client.readContract).toHaveBeenCalledTimes(1)
  })

  it("finds mainnet DAI's slot 2", async () => {
    await expect(
      findBalanceOfSlot(tokenWithBalanceSlot(2n), "0x6b175474e89094c44da98b954eedeac495271d0f"),
    ).resolves.toBe(2n)
  })

  it("refuses a token whose balance is not a mapping in the probed slots", async () => {
    await expect(
      findBalanceOfSlot(
        tokenWithBalanceSlot(undefined),
        "0x000000000000000000000000000000000000da1a",
      ),
    ).rejects.toThrow(/state override/)
  })

  it("derives the slot the way Solidity does: keccak256(abi.encode(key, slot))", () => {
    expect(mappingSlot("0x000000000000000000000000000000000000b0b0", 2n)).toBe(
      "0x979613238220eb169bce36f2bc75edd95d03fb71f401bf9f649ef4e1a31403a1",
    )
  })
})

describe("SwapOnWithdrawSimulator", () => {
  const FACTORY = "0x00000000000000000000000000000000000fac70" as Address
  const EXECUTOR = "0x0000000000000000000000000000000000e0e0e0" as Address
  const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f" as Address
  const IMPL = "0x0000000000000000000000000000000000001111" as Address
  const FEED = "0x000000000000000000000000000000000000feed" as Address
  const USDC = "0x000000000000000000000000000000000000c0c0" as Address
  const USDT = "0x000000000000000000000000000000000000c0c1" as Address
  const RECIPIENT = "0x0000000000000000000000000000000000000b0b" as Address
  const DAI_BALANCE_SLOT = 2n
  const BASE_FEE = parseGwei("10")
  const PRIORITY_FEE = parseGwei("1")
  const GAS_ESTIMATE = 250_000n
  const ETH_USD = 3000n * FEED_SCALE

  const uint = (value: bigint) => encodeAbiParameters([{ type: "uint256" }], [value])

  function fakeClient(opts: { payout?: bigint; feedUpdatedAt?: bigint } = {}) {
    const payout = opts.payout ?? 99_000_000n
    const readContract = vi.fn(
      async ({
        address,
        functionName,
        args,
        stateOverride,
      }: {
        address: Address
        functionName: string
        args?: readonly unknown[]
        stateOverride?: StateOverride
      }) => {
        switch (functionName) {
          case "IMPLEMENTATION":
            return IMPL
          case "ETH_USD_FEED":
            return FEED
          case "USDC":
            return USDC
          case "USDT":
            return USDT
          case "decimals":
            return address === USDC || address === USDT ? 6 : 18
          case "latestRoundData":
            return [0n, ETH_USD, 0n, opts.feedUpdatedAt ?? NOW, 0n]
          case "balanceOf": {
            const wanted = mappingSlot(args![0] as Address, DAI_BALANCE_SLOT)
            const hit = stateOverride?.[0]?.stateDiff?.find((entry) => entry.slot === wanted)
            return hit ? BigInt(hit.value) : 0n
          }
          default:
            throw new Error(`unexpected read ${functionName}`)
        }
      },
    )
    const client = {
      readContract,
      getBlock: vi.fn(async () => ({ baseFeePerGas: BASE_FEE, timestamp: NOW })),
      estimateMaxPriorityFeePerGas: vi.fn(async () => PRIORITY_FEE),
      estimateGas: vi.fn(async () => GAS_ESTIMATE),
      call: vi.fn(async () => ({
        data: encodeFunctionResult({
          abi: multicall3Abi,
          functionName: "aggregate3",
          result: [
            { success: true, returnData: uint(1_000n) },
            { success: true, returnData: "0x" },
            { success: true, returnData: uint(1_000n + payout) },
          ],
        }),
      })),
    }
    return client
  }

  /** The `aggregate3` calls inside a Multicall3 `eth_call`. */
  const multicallCalls = (data: Hex) => {
    const decoded = decodeFunctionData({ abi: multicall3Abi, data })
    expect(decoded.functionName).toBe("aggregate3")
    return decoded.args[0]
  }

  const simulator = (client: ReturnType<typeof fakeClient>) =>
    new SwapOnWithdrawSimulator(client as unknown as PublicClient, {
      swapEscrowFactory: FACTORY,
      operationExecutor: EXECUTOR,
      token: DAI,
    })

  const deductions = {
    withdrawalRelayerTip: 10n ** 17n,
    proverTip: 0n,
    fpcFundingCut: 25n * 10n ** 16n,
  }
  const AMOUNT = 100n * 10n ** 18n
  const FUNDING = AMOUNT - deductions.withdrawalRelayerTip - deductions.fpcFundingCut

  const expectedTip = () =>
    relayerTipFromGas({
      gasEstimate: GAS_ESTIMATE,
      baseFee: BASE_FEE,
      priorityFee: PRIORITY_FEE,
      ethUsd: fresh(ETH_USD),
      blockTimestamp: NOW,
    })

  /** The escrow args inside an `OperationExecutor.execute` calldata. */
  const executedEscrowArgs = (data: Hex) => {
    const execute = decodeFunctionData({ abi: OperationExecutorAbi, data })
    expect(execute.functionName).toBe("execute")
    const [target, deployCalldata, payoutToken, minPayout] = execute.args
    // Decoded addresses come back checksummed.
    expect(target.toLowerCase()).toBe(FACTORY)
    expect(payoutToken.toLowerCase()).toBe(DAI)
    expect(minPayout).toBe(0n)
    const deploy = decodeFunctionData({ abi: SwapEscrowFactoryAbi, data: deployCalldata })
    expect(deploy.functionName).toBe("deployAndExecute")
    return deploy.args[0]
  }

  it("prices the relayer's exact execute call and pays out the executed swap", async () => {
    const client = fakeClient()
    const simulation = await simulator(client).simulate({
      output: "USDC",
      amount: AMOUNT,
      deductions,
      recipient: RECIPIENT,
    })

    const tip = expectedTip()
    expect(simulation).toEqual({ ...tip, amountOut: 99_000_000n, decimals: 6 })

    // The gas estimate is the relayer's transaction: from the recipient, to the executor, paying DAI.
    const estimate = client.estimateGas.mock.calls[0]![0] as {
      account: Address
      to: Address
      data: Hex
      stateOverride: StateOverride
    }
    expect(estimate.account).toBe(RECIPIENT)
    expect(estimate.to).toBe(EXECUTOR)
    const seedArgs = executedEscrowArgs(estimate.data)
    expect(seedArgs.route).toBe(SwapRoute.USDC)
    expect(seedArgs.recipient.toLowerCase()).toBe(RECIPIENT)
    // The factory refuses a zero commitment; the execute path never opens it.
    expect(seedArgs.recoveryCommitment).toMatch(/^0x[0-9a-f]{64}$/)
    expect(BigInt(seedArgs.recoveryCommitment)).not.toBe(0n)
    expect(seedArgs.relayerTip).toBe(0n)
    // The counterfactual escrow holds exactly what the portal will release to it.
    const escrow = predictSwapEscrowAddressLocally(FACTORY, seedArgs)
    expect(estimate.stateOverride).toEqual([
      {
        address: DAI,
        stateDiff: [
          {
            slot: mappingSlot(escrow, DAI_BALANCE_SLOT),
            value: `0x${FUNDING.toString(16).padStart(64, "0")}`,
          },
        ],
      },
    ])

    // The payout runs the final args — the committed tip — through Multicall3 as the recipient.
    const payout = client.call.mock.calls[0]![0] as {
      to: Address
      account: Address
      data: Hex
      stateOverride: StateOverride
    }
    expect(payout.to).toBe(MULTICALL3_ADDRESS)
    expect(payout.account).toBe(RECIPIENT)
    const [before, deploy, after] = multicallCalls(payout.data)
    expect(before).toEqual(after)
    expect(before!.target.toLowerCase()).toBe(USDC)
    expect(before!.allowFailure).toBe(false)
    const finalArgs = decodeFunctionData({ abi: SwapEscrowFactoryAbi, data: deploy!.callData })
      .args[0]
    expect(finalArgs.relayerTip).toBe(tip.relayerTip)
    expect(deploy!.target.toLowerCase()).toBe(FACTORY)
    expect(payout.stateOverride[0]!.stateDiff![0]!.slot).toBe(
      mappingSlot(predictSwapEscrowAddressLocally(FACTORY, finalArgs), DAI_BALANCE_SLOT),
    )
  })

  it("measures the ETH route on the recipient's ETH balance through Multicall3", async () => {
    const client = fakeClient({ payout: 31_350_000_000_000_000n })
    const simulation = await simulator(client).simulate({
      output: "ETH",
      amount: AMOUNT,
      deductions,
      recipient: RECIPIENT,
    })
    expect(simulation.amountOut).toBe(31_350_000_000_000_000n)
    expect(simulation.decimals).toBe(18)
    const [balanceCall] = multicallCalls((client.call.mock.calls[0]![0] as { data: Hex }).data)
    expect(balanceCall!.target.toLowerCase()).toBe(MULTICALL3_ADDRESS.toLowerCase())
    expect(balanceCall!.callData.startsWith("0x4d2301cc")).toBe(true) // getEthBalance(address)
  })

  it("estimates with the previous tip committed, so the estimate converges on the real send", async () => {
    const client = fakeClient()
    const previousTip = 3n * 10n ** 18n
    await simulator(client).simulate({
      output: "USDT",
      amount: AMOUNT,
      deductions,
      recipient: RECIPIENT,
      previousTip,
    })
    const estimate = client.estimateGas.mock.calls[0]![0] as { data: Hex }
    expect(executedEscrowArgs(estimate.data).relayerTip).toBe(previousTip)
  })

  it("ignores a previous tip the amount cannot cover — the factory would estimate a no-op", async () => {
    const client = fakeClient()
    await simulator(client).simulate({
      output: "USDT",
      amount: AMOUNT,
      deductions,
      recipient: RECIPIENT,
      previousTip: FUNDING,
    })
    const estimate = client.estimateGas.mock.calls[0]![0] as { data: Hex }
    expect(executedEscrowArgs(estimate.data).relayerTip).toBe(0n)
  })

  it("reports the tip when the amount leaves nothing to swap after paying it", async () => {
    const client = fakeClient()
    const tip = expectedTip()
    const amount = deductions.withdrawalRelayerTip + deductions.fpcFundingCut + tip.relayerTip
    const attempt = simulator(client).simulate({
      output: "USDC",
      amount,
      deductions,
      recipient: RECIPIENT,
    })
    await expect(attempt).rejects.toBeInstanceOf(SwapTipExceedsInputError)
    await expect(attempt).rejects.toMatchObject({ tip, escrowFunding: tip.relayerTip })
    expect(client.call).not.toHaveBeenCalled()
  })

  it("refuses an amount the portal's deductions already consume", async () => {
    const client = fakeClient()
    await expect(
      simulator(client).simulate({
        output: "USDC",
        amount: deductions.withdrawalRelayerTip + deductions.fpcFundingCut,
        deductions,
        recipient: RECIPIENT,
      }),
    ).rejects.toThrow(/does not cover/)
    expect(client.estimateGas).not.toHaveBeenCalled()
  })

  it("refuses to price off a stale feed", async () => {
    const client = fakeClient({ feedUpdatedAt: NOW - MAX_ETH_USD_AGE_SECONDS - 1n })
    await expect(
      simulator(client).simulate({
        output: "USDC",
        amount: AMOUNT,
        deductions,
        recipient: RECIPIENT,
      }),
    ).rejects.toThrow(/stale/)
  })

  it("reads the deployment and the balance slot once per simulator", async () => {
    const client = fakeClient()
    const sim = simulator(client)
    await sim.simulate({ output: "USDC", amount: AMOUNT, deductions, recipient: RECIPIENT })
    await sim.simulate({ output: "ETH", amount: AMOUNT, deductions, recipient: RECIPIENT })
    const reads = client.readContract.mock.calls.map(
      (call) => (call[0] as { functionName: string }).functionName,
    )
    expect(reads.filter((name) => name === "IMPLEMENTATION")).toHaveLength(1)
    expect(reads.filter((name) => name === "balanceOf")).toHaveLength(1)
    expect(reads.filter((name) => name === "latestRoundData")).toHaveLength(2)
  })
})
