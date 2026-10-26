import { describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
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
    forwardingTable: address("99"),
  },
  intentData: `0x${"55".repeat(32)}` as Hex,
  proofs: "0x" as Hex,
  operationExecutor: address("66"),
  chainId: 1n,
  deployed: false,
}

const subsidy = address("77")
const portal = address("aa")
const route = (token: string, depositSubsidy = subsidy, rowPortal = portal) => ({
  token: token as Address,
  portal: rowPortal,
  depositSubsidy,
})

/**
 * Token and Broadcaster stubs that record every call and return a tagged interaction. `broadcasts` holds one entry per
 * operation, a pair call's two operations each under the pair's method.
 */
function stubs() {
  const notify = vi.fn((...args: unknown[]) => ({ call: "notify", args }))
  const broadcasts: { method: string; args: any[] }[] = []
  const methods = Object.fromEntries(
    [
      ...L1_OPERATION_BROADCAST_TIERS.map(({ method }) => method),
      "broadcast_l1_operation_pair_2k",
    ].map((method) => [
      method,
      (...args: any[]) => {
        if (method === "broadcast_l1_operation_pair_2k") {
          for (const i of [0, 1]) broadcasts.push({ method, args: args.map((arg) => arg[i]) })
        } else broadcasts.push({ method, args })
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
        routes: [...tokens, tokens[0]!].map((token) => route(token)),
      })

      // One tx: the SIPA event first, then one deduped operation per funding token, two per pair call.
      expect(calls.map((call: any) => call.call)).toEqual([
        "notify",
        "broadcast_l1_operation_pair_2k",
        "broadcast_l1_operation_2k",
      ])
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
      for (const [index, { args }] of broadcasts.entries()) {
        const [target, payoutToken, bytesLen, fields, condition] = args
        expect(args).toHaveLength(5)
        expect(target.toString().toLowerCase()).toBe(subsidy)
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
          params.deployArgs.forwardingTable,
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

    buildSipaSweepBroadcasts(token, broadcaster, {
      ...params,
      deployed: true,
      routes: tokens.map((token) => route(token)),
    })

    expect(broadcasts).toHaveLength(3)
    for (const [index, { args }] of broadcasts.entries()) {
      const [target, , bytesLen, fields] = args
      expect(target.toString().toLowerCase()).toBe(subsidy)
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
    buildSipaSweepBroadcasts(token, broadcaster, {
      ...params,
      chainId: 31337n,
      routes: [route(sent)],
    })
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]!.args[1].toString()).toBe(sent)
  })

  it("sweeps each row's token through that row's subsidy, two operations per call", () => {
    const { token, broadcaster, notify, broadcasts } = stubs()
    const rows = [
      route(address("81"), address("71"), address("a1")),
      route(address("82"), address("72"), address("a2")),
      route(address("83"), address("73"), address("a3")),
      route(address("84"), address("74"), address("a4")),
    ]

    const calls = buildSipaSweepBroadcasts(token, broadcaster, {
      ...params,
      chainId: 31337n,
      routes: rows,
    })

    // Four rows fit one sponsored tx: one event and two pair calls.
    expect(calls.map((call: any) => call.call)).toEqual([
      "notify",
      "broadcast_l1_operation_pair_2k",
      "broadcast_l1_operation_pair_2k",
    ])
    expect(notify).toHaveBeenCalledOnce()
    expect(broadcasts).toHaveLength(rows.length)
    for (const [index, { args }] of broadcasts.entries()) {
      const [target, payoutToken, bytesLen, fields, condition] = args
      expect(target.toString().toLowerCase()).toBe(rows[index]!.depositSubsidy)
      expect(payoutToken.toString()).toBe(rows[index]!.token)
      expect(condition.token.toString()).toBe(rows[index]!.token)
      const decoded = decodeFunctionData({
        abi: DepositSubsidyAbi,
        data: calldata(bytesLen, fields),
      })
      expect(String(decoded.args?.[4]).toLowerCase()).toBe(rows[index]!.token)
    }
  })

  it("refuses one token routed through two rows", () => {
    const { token, broadcaster } = stubs()
    const sent = address("81")
    expect(() =>
      buildSipaSweepBroadcasts(token, broadcaster, {
        ...params,
        routes: [route(sent), route(sent, address("72"))],
      }),
    ).toThrow("routed through two rows")
  })

  it("does not build a broadcast without a route", () => {
    const { token, broadcaster, notify, broadcasts } = stubs()
    expect(() => buildSipaSweepBroadcasts(token, broadcaster, { ...params, routes: [] })).toThrow(
      "sweep route",
    )
    expect(notify).not.toHaveBeenCalled()
    expect(broadcasts).toHaveLength(0)
  })

  it("deploys a legacy SIPA through the legacy factory selector", () => {
    const { token, broadcaster, broadcasts } = stubs()
    const {
      recoveryCommitment: _commitment,
      forwardingTable: _table,
      ...common
    } = params.deployArgs
    buildSipaSweepBroadcasts(token, broadcaster, {
      ...params,
      routes: [route(params.sipa)],
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
    routes: [{ depositSubsidy: subsidy, portal }],
    sipaFactory: address("33"),
    intent: SipaIntent.Deposit,
    deployArgs: { ...params.deployArgs, intentHash: keccak256(intentData) },
    intentData,
    sipa: params.sipa,
  }

  /** An L1 whose subsidy, factory and predictor answer `chain`; `predictSIPA` records its args. */
  function l1(chain: Partial<Record<string, unknown>> = {}) {
    const answers: Record<string, unknown> = {
      PORTAL: portal,
      SIPA_FACTORY: target.sipaFactory,
      ROLLUP_VERSION: target.deployArgs.rollupVersion,
      implementationFor: target.deployArgs.implementation,
      predictSIPA: target.sipa,
      ...chain,
    }
    const readContract = vi.fn(
      async ({ functionName }: { functionName: string; args?: unknown[] }) => answers[functionName],
    )
    return { client: { readContract } as unknown as PublicClient, readContract }
  }

  it("passes when the subsidy deploys the predicted SIPA", async () => {
    const { client, readContract } = l1()
    await expect(assertSubsidySweepsSipa(client, target)).resolves.toBeUndefined()
    const predict = readContract.mock.calls.find(([call]) => call.functionName === "predictSIPA")
    expect(predict![0].args).toEqual([
      target.deployArgs.implementation,
      keccak256(intentData),
      target.deployArgs.recoveryCommitment,
      target.deployArgs.rollupVersion,
      target.deployArgs.resweepable,
      target.deployArgs.forwardingTable,
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

  it("checks every row's subsidy against that row's portal", async () => {
    const other = { depositSubsidy: address("78"), portal: address("ab") }
    const readContract = vi.fn(
      async ({ address: at, functionName }: { address: Address; functionName: string }) =>
        ({
          PORTAL: at === other.depositSubsidy ? other.portal : portal,
          SIPA_FACTORY: target.sipaFactory,
          ROLLUP_VERSION: target.deployArgs.rollupVersion,
          implementationFor: target.deployArgs.implementation,
          predictSIPA: target.sipa,
        }[functionName]),
    )
    const client = { readContract } as unknown as PublicClient
    const routes = [...target.routes, other, other]
    await expect(assertSubsidySweepsSipa(client, { ...target, routes })).resolves.toBeUndefined()
    const portalReads = readContract.mock.calls.filter(([call]) => call.functionName === "PORTAL")
    expect(portalReads.map(([call]) => call.address)).toEqual([subsidy, other.depositSubsidy])

    await expect(
      assertSubsidySweepsSipa(client, {
        ...target,
        routes: [...target.routes, { ...other, portal }],
      }),
    ).rejects.toThrow(`it serves portal ${other.portal}`)
  })

  it("refuses a subsidy routed for two portals, and no route at all", async () => {
    await expect(
      assertSubsidySweepsSipa(l1().client, {
        ...target,
        routes: [...target.routes, { depositSubsidy: subsidy, portal: address("ab") }],
      }),
    ).rejects.toThrow("routed for portals")
    await expect(assertSubsidySweepsSipa(l1().client, { ...target, routes: [] })).rejects.toThrow(
      "sweep route",
    )
  })

  it("refuses intent data that does not hash to the committed intent hash", async () => {
    await expect(
      assertSubsidySweepsSipa(l1().client, { ...target, intentData: "0x1234" }),
    ).rejects.toThrow("hashes to")
  })
})
