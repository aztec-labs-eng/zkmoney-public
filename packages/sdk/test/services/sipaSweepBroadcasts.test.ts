import { describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { DepositSubsidyAbi, encodeDeploySIPA, MULTICALL3_ADDRESS } from "@oxide/l1-contracts"
import {
  decodeL1OperationCalldata,
  L1_OPERATION_BROADCAST_TIERS,
  L1OperationConditionKind,
} from "@oxide/oxide-lib/l1_operation_calldata.js"
import { MAINNET_DAI, MAINNET_USDC, MAINNET_USDT } from "@oxide/l1-contracts/deposit_tokens.js"
import { decodeFunctionData, multicall3Abi, toFunctionSelector, type Address, type Hex } from "viem"
import { buildSipaSweepBroadcasts, splitIntentHash } from "../../src/services/sipaIntents.js"

const address = (byte: string) => `0x${byte.repeat(20)}` as Address
const params = {
  recipient: AztecAddress.fromBigIntUnsafe(0xbee0n),
  sharedSecretSalt: new Fr(9n),
  resweepable: true,
  intentHash: `0x${"11".repeat(16)}${"99".repeat(16)}` as Hex,
  sipa: address("22"),
  sipaFactory: address("33"),
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

function aggregate3Calls(bytesLen: number, fields: Fr[]) {
  const data = `0x${decodeL1OperationCalldata(bytesLen, fields).toString("hex")}` as Hex
  const batch = decodeFunctionData({ abi: multicall3Abi, data })
  expect(batch.functionName).toBe("aggregate3")
  return batch.args![0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[]
}

describe("SIPA sweep broadcasts", () => {
  it("notifies the recipient, then binds each funding token to its balance condition and subsidised sweep", () => {
    const { token, broadcaster, notify, broadcasts } = stubs()
    const tokens = [MAINNET_DAI, MAINNET_USDC, MAINNET_USDT].map(
      (token) => token.toString() as Address,
    )

    const calls = buildSipaSweepBroadcasts(token, broadcaster, {
      ...params,
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
      expect(target.toString().toLowerCase()).toBe(MULTICALL3_ADDRESS.toLowerCase())
      // Mainnet stablecoins are swept into DAI, so every sweep pays out in DAI.
      expect(payoutToken.toString()).toBe(MAINNET_DAI.toString())
      expect(condition.kind).toBe(L1OperationConditionKind.Balance)
      expect(condition.token.toString()).toBe(tokens[index])
      expect(condition.recipient.toString()).toBe(params.sipa)

      const [deploy, sweep] = aggregate3Calls(bytesLen, fields)
      expect(deploy!.target.toLowerCase()).toBe(params.sipaFactory)
      expect(deploy!.allowFailure).toBe(true)
      expect(deploy!.callData).toBe(encodeDeploySIPA(params.deployArgs))
      expect(sweep!.target.toLowerCase()).toBe(params.depositSubsidy)
      expect(sweep!.allowFailure).toBe(false)
      const decoded = decodeFunctionData({ abi: DepositSubsidyAbi, data: sweep!.callData })
      expect(decoded.functionName).toBe("sweepForSubsidy")
      expect(
        decoded.args?.map((value) => (typeof value === "string" ? value.toLowerCase() : value)),
      ).toEqual([
        params.sipa,
        tokens[index],
        params.operationExecutor,
        params.intentData,
        params.proofs,
      ])
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
    const [, , bytesLen, fields] = broadcasts[0]!.args
    const [deploy] = aggregate3Calls(bytesLen, fields)
    expect(deploy!.callData.slice(0, 10)).toBe(
      toFunctionSelector("deploySIPA(address,bytes32,address,uint256,bool)"),
    )
  })
})
