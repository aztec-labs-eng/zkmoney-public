import { describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { DepositSubsidyAbi, MULTICALL3_ADDRESS, SipaIntent } from "@oxide/l1-contracts"
import {
  decodeL1OperationCalldata,
  L1_OPERATION_BROADCAST_TIERS,
  L1OperationConditionKind,
} from "@oxide/oxide-lib/l1_operation_calldata.js"
import { MAINNET_DAI, MAINNET_USDC, MAINNET_USDT } from "@oxide/l1-contracts/deposit_tokens.js"
import {
  decodeFunctionData,
  keccak256,
  multicall3Abi,
  toFunctionSelector,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import {
  assertSubsidySweepsSipa,
  buildSipaSweepBroadcasts,
  splitIntentHash,
} from "../../src/services/sipaIntents.js"

const address = (byte: string) => `0x${byte.repeat(20)}` as Address
const params = {
  recipient: AztecAddress.fromBigIntUnsafe(0xbee0n),
  sharedSecretSalt: new Fr(9n),
  resweepable: true,
  intentHash: `0x${"11".repeat(16)}${"99".repeat(16)}` as Hex,
  sipa: address("22"),
  sipaFactory: address("33"),
  intent: SipaIntent.Deposit,
  deployArgs: {
    implementation: address("44"),
    intentHash: `0x${"11".repeat(16)}${"99".repeat(16)}` as Hex,
    recoveryCommitment: `0x${"00".repeat(32)}` as Hex,
    rollupVersion: 7n,
    resweepable: true,
  },
  intentData: `0x${"55".repeat(32)}` as Hex,
  proofs: "0x" as Hex,
  operationExecutor: address("66"),
  depositSubsidy: address("77"),
  chainId: 1n,
  deployed: false,
}

/** Token and Broadcaster stubs that record every call and return a tagged interaction. */
function stubs() {
  const notify = vi.fn((...args: unknown[]) => ({ call: "notify", args }))
  const broadcasts: { method: string; args: any[] }[] = []
  const methods = Object.fromEntries(
    L1_OPERATION_BROADCAST_TIERS.map(({ method }) => [
      method,
      (...args: any[]) => {
        broadcasts.push({ method, args })
        return { call: method, args }
      },
    ]),
  )
  return {
    token: { methods: { notify_sipa_recipient: notify } } as never,
    broadcaster: { methods } as never,
    notify,
    broadcasts,
  }
}

const calldata = (bytesLen: number, fields: Fr[]) =>
  `0x${decodeL1OperationCalldata(bytesLen, fields).toString("hex")}` as Hex

function aggregate3Calls(bytesLen: number, fields: Fr[]) {
  const batch = decodeFunctionData({ abi: multicall3Abi, data: calldata(bytesLen, fields) })
  expect(batch.functionName).toBe("aggregate3")
  return batch.args![0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[]
}

describe("SIPA sweep broadcasts", () => {
  it.each([SipaIntent.Deposit, SipaIntent.Registration])(
    "notifies the recipient, then binds each funding token to its balance condition and subsidized deploy-and-sweep (intent %s)",
    (intent) => {
      const { token, broadcaster, notify, broadcasts } = stubs()
      const tokens = [MAINNET_DAI, MAINNET_USDC, MAINNET_USDT].map(
        (token) => token.toString() as Address,
      )

      const calls = buildSipaSweepBroadcasts(token, broadcaster, {
        ...params,
        intent,
        tokens: [...tokens, tokens[0]!],
      })

      // One tx: the SIPA event first, then one deduped operation per funding token.
      expect(calls).toHaveLength(4)
      expect((calls[0] as any).call).toBe("notify")
      const { hi, lo } = splitIntentHash(params.intentHash)
      expect(notify).toHaveBeenCalledOnce()
      expect(notify).toHaveBeenCalledWith(
        params.recipient,
        params.sharedSecretSalt,
        params.resweepable,
        hi,
        lo,
      )

      expect(broadcasts).toHaveLength(3)
      for (const [index, { method, args }] of broadcasts.entries()) {
        expect(method).toBe("broadcast_l1_operation_2k")
        const [target, payoutToken, bytesLen, fields, condition] = args
        expect(args).toHaveLength(5)
        expect(target.toString().toLowerCase()).toBe(params.depositSubsidy)
        // Mainnet stablecoins are swept into DAI, so every sweep pays out in DAI.
        expect(payoutToken.toString()).toBe(MAINNET_DAI.toString())
        expect(condition.kind).toBe(L1OperationConditionKind.Balance)
        expect(condition.token.toString()).toBe(tokens[index])
        expect(condition.recipient.toString()).toBe(params.sipa)

        const decoded = decodeFunctionData({
          abi: DepositSubsidyAbi,
          data: calldata(bytesLen, fields),
        })
        expect(decoded.functionName).toBe("deployAndSweepForSubsidy")
        expect(
          decoded.args?.map((value) => (typeof value === "string" ? value.toLowerCase() : value)),
        ).toEqual([
          intent,
          params.deployArgs.recoveryCommitment,
          params.deployArgs.resweepable,
          tokens[index],
          params.operationExecutor,
          params.intentData,
          params.proofs,
        ])
      }
    },
  )

  it("sweeps a SIPA that has code without the factory call", () => {
    const { token, broadcaster, broadcasts } = stubs()
    const tokens = [MAINNET_DAI, MAINNET_USDC, MAINNET_USDT].map(
      (token) => token.toString() as Address,
    )

    buildSipaSweepBroadcasts(token, broadcaster, { ...params, deployed: true, tokens })

    expect(broadcasts).toHaveLength(3)
    for (const [index, { args }] of broadcasts.entries()) {
      const [target, , bytesLen, fields] = args
      expect(target.toString().toLowerCase()).toBe(params.depositSubsidy)
      const data = `0x${decodeL1OperationCalldata(bytesLen, fields).toString("hex")}` as Hex
      expect(data).not.toContain(params.sipaFactory.slice(2))
      const decoded = decodeFunctionData({ abi: DepositSubsidyAbi, data })
      expect(decoded.functionName).toBe("sweepForSubsidy")
      expect(decoded.args?.[0]).toBe(params.sipa)
      expect(String(decoded.args?.[1]).toLowerCase()).toBe(tokens[index]!.toLowerCase())
    }
  })

  it("pays out in the sent token off mainnet", () => {
    const { token, broadcaster, broadcasts } = stubs()
    const sent = address("88")
    buildSipaSweepBroadcasts(token, broadcaster, { ...params, chainId: 31337n, tokens: [sent] })
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]!.args[1].toString()).toBe(sent)
  })

  it("does not build a broadcast without a funding token", () => {
    const { token, broadcaster, notify, broadcasts } = stubs()
    expect(() => buildSipaSweepBroadcasts(token, broadcaster, { ...params, tokens: [] })).toThrow(
      "funding token",
    )
    expect(notify).not.toHaveBeenCalled()
    expect(broadcasts).toHaveLength(0)
  })

  it("deploys a legacy SIPA through the legacy factory selector", () => {
    const { token, broadcaster, broadcasts } = stubs()
    const { recoveryCommitment: _commitment, ...common } = params.deployArgs
    buildSipaSweepBroadcasts(token, broadcaster, {
      ...params,
      tokens: [params.sipa],
      deployArgs: { ...common, recoveryAddress: address("88") },
    })
    const [target, , bytesLen, fields] = broadcasts[0]!.args
    // The subsidy only deploys current SIPAs, so a legacy one keeps the Multicall3 batch.
    expect(target.toString().toLowerCase()).toBe(MULTICALL3_ADDRESS.toLowerCase())
    const [deploy] = aggregate3Calls(bytesLen, fields)
    expect(deploy!.callData.slice(0, 10)).toBe(
      toFunctionSelector("deploySIPA(address,bytes32,address,uint256,bool)"),
    )
  })
})

describe("assertSubsidySweepsSipa", () => {
  const intentData = `0x${"55".repeat(32)}` as Hex
  const target = {
    depositSubsidy: address("77"),
    portal: address("aa"),
    sipaFactory: address("33"),
    intent: SipaIntent.Deposit,
    deployArgs: { ...params.deployArgs, intentHash: keccak256(intentData) },
    intentData,
    sipa: params.sipa,
  }

  /** An L1 whose subsidy, factory and predictor answer `chain`; `predictSIPA` records its args. */
  function l1(chain: Partial<Record<string, unknown>> = {}) {
    const answers: Record<string, unknown> = {
      PORTAL: target.portal,
      SIPA_FACTORY: target.sipaFactory,
      ROLLUP_VERSION: target.deployArgs.rollupVersion,
      implementationFor: target.deployArgs.implementation,
      predictSIPA: target.sipa,
      ...chain,
    }
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => answers[functionName])
    return { client: { readContract } as unknown as PublicClient, readContract }
  }

  it("passes when the subsidy deploys the predicted SIPA", async () => {
    const { client, readContract } = l1()
    await expect(assertSubsidySweepsSipa(client, target)).resolves.toBeUndefined()
    const predict = readContract.mock.calls.find(([call]) => call.functionName === "predictSIPA")
    expect((predict![0] as { args: unknown[] }).args).toEqual([
      target.deployArgs.implementation,
      keccak256(intentData),
      target.deployArgs.recoveryCommitment,
      target.deployArgs.rollupVersion,
      target.deployArgs.resweepable,
    ])
  })

  it.each([
    ["another portal", { PORTAL: address("bb") }, "serves portal"],
    ["another factory", { SIPA_FACTORY: address("cc") }, "deploys through"],
    ["another implementation", { implementationFor: address("dd") }, "implementation is"],
    ["another address", { predictSIPA: address("ee") }, "would deploy"],
  ])("refuses a subsidy with %s", async (_, chain, reason) => {
    await expect(assertSubsidySweepsSipa(l1(chain).client, target)).rejects.toThrow(reason)
  })

  it("refuses intent data that does not hash to the committed intent hash", async () => {
    await expect(
      assertSubsidySweepsSipa(l1().client, { ...target, intentData: "0x1234" }),
    ).rejects.toThrow("hashes to")
  })
})
