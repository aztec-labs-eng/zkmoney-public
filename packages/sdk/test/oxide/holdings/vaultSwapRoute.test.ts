import { describe, expect, it } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ConversionKind, ExecutorHolding } from "@obsidion/core/oxide"
import { getAddress } from "viem"
import type { Address, Hex } from "viem"
import {
  KIND_BY_ANY,
  buildClaimFpcPolicy,
} from "../../../src/feePaymentMethod/claimFpc/claimSponsoredCall.js"
import {
  CLAIM_FPC_BATCH_CAPS,
  claimFpcBatchGas,
  claimFpcSponsoredFee,
} from "../../../src/feePaymentMethod/claimFpc/gas/claimFpcBatchGas.js"
import { HOLDING_ADAPTERS } from "../../../src/oxide/holdings/adapters.js"
import { PSM_MAINNET } from "../../../src/oxide/holdings/conversions/psm.js"
import {
  assertRouteOnExecutor,
  readHoldingRoute,
} from "../../../src/oxide/holdings/holdingDeployment.js"
import { readVaultMove } from "../../../src/oxide/holdings/moveBurns.js"
import { buildVaultSwap, compileVaultSwap } from "../../../src/oxide/holdings/vaultSwapRoute.js"
import type { VaultSwapArgs } from "../../../src/oxide/holdings/vaultSwapRoute.js"
import { buildSponsoredTeeOperation } from "../../../src/services/tee/sponsoredTeeOperation.js"
import { encodeWithdrawalMemo } from "../../../src/services/withdrawal/withdrawalMemo.js"
import {
  DAI,
  ERC4626_ADAPTER,
  EXECUTOR,
  MAKER_PSM_ADAPTER,
  MULTI_STEP,
  PORTAL_DEPOSIT_ADAPTER,
  SKY_CONVERTER_ADAPTER,
  UNISWAP_V3_ADAPTER,
  USDC,
  USDS,
  vaultHolding,
} from "./holdingFixtures.js"

const address = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`)
const VAULT_A = address(0x7a0a)
const VAULT_B = address(0x7a0b)
const PORTAL_A = address(0x900a)
const PORTAL_B = address(0x900b)
const PSM = getAddress(PSM_MAINNET.litePsm)
const ASSET: Record<string, Address> = { None: DAI, DaiUsds: USDS, Psm: USDC }
const COMMITMENT = `0x${"01".repeat(32)}` as Hex
const NONCE = `0x${"02".repeat(32)}` as Hex
/** The memo every vault move's burn carries. */
const MEMO = encodeWithdrawalMemo({ vaultMove: { nonce: NONCE } })

const holding = (kind: ConversionKind, vault: Address, portal: Address): ExecutorHolding => {
  const base = vaultHolding(kind)
  return { ...base, held: { ...base.held, underlying: vault, token: vault, portal } }
}

/** A chain with both vaults, Sky's converter and the PSM. */
const chain = (a: ConversionKind, b: ConversionKind) => ({
  getChainId: async () => 1,
  simulateBlocks: async () => {
    throw new Error("unexpected simulateBlocks")
  },
  getBlock: async () => {
    throw new Error("unexpected getBlock")
  },
  readContract: async (read: { address: Address; functionName: string }) => {
    const answers: Record<string, unknown> = {
      [`${VAULT_A}.asset`]: ASSET[a],
      [`${VAULT_B}.asset`]: ASSET[b],
      [`${SKY_CONVERTER_ADAPTER}.DAI`]: DAI,
      [`${SKY_CONVERTER_ADAPTER}.USDS`]: USDS,
      [`${PSM}.dai`]: DAI,
      [`${PSM}.gem`]: USDC,
      [`${PSM}.to18ConversionFactor`]: 10n ** 12n,
    }
    const answer = answers[`${read.address}.${read.functionName}`]
    if (answer === undefined) throw new Error(`unexpected ${read.functionName} on ${read.address}`)
    return answer
  },
})

const vaultSwapRoutes = async (a: ConversionKind, b: ConversionKind) => {
  const client = chain(a, b) as never
  return {
    from: await readHoldingRoute(client, HOLDING_ADAPTERS, holding(a, VAULT_A, PORTAL_A)),
    to: await readHoldingRoute(client, HOLDING_ADAPTERS, holding(b, VAULT_B, PORTAL_B)),
  }
}

const vaultSwapArgs = (over: Partial<VaultSwapArgs> = {}): VaultSwapArgs => ({
  redeemMinOut: 5n,
  baseMinOut: 6n,
  assetMinOut: 7n,
  minOut: 8n,
  recipientCommitment: COMMITMENT,
  from: AztecAddress.fromNumberUnsafe(2),
  amount: 10n ** 21n,
  proverTip: 0n,
  relayerTip: 10n ** 18n,
  recovery: { salt: new Fr(3n), account: `0x${"0a".repeat(20)}` as Address },
  recoveryMemo: MEMO,
  ...over,
})

describe("compileVaultSwap", () => {
  it("runs the source's steps out, then the destination's steps in, into its held portal", async () => {
    const { from, to } = await vaultSwapRoutes("DaiUsds", "Psm")
    expect(compileVaultSwap(from, to, vaultSwapArgs()).calls).toEqual([
      { target: ERC4626_ADAPTER, call: "erc4626Redeem" },
      { target: SKY_CONVERTER_ADAPTER, call: "usdsToDai" },
      { target: MAKER_PSM_ADAPTER, call: "psmBuyGem" },
      { target: ERC4626_ADAPTER, call: "erc4626Deposit" },
      { target: PORTAL_DEPOSIT_ADAPTER, call: "portalDeposit" },
    ])
    const back = await vaultSwapRoutes("Psm", "DaiUsds")
    expect(compileVaultSwap(back.from, back.to, vaultSwapArgs()).calls).toEqual([
      { target: ERC4626_ADAPTER, call: "erc4626Redeem" },
      { target: UNISWAP_V3_ADAPTER, call: "uniswapV3ExactIn" },
      { target: SKY_CONVERTER_ADAPTER, call: "daiToUsds" },
      { target: ERC4626_ADAPTER, call: "erc4626Deposit" },
      { target: PORTAL_DEPOSIT_ADAPTER, call: "portalDeposit" },
    ])
  })

  it("refuses a swap into the same vault, or onto another executor", async () => {
    const { from, to } = await vaultSwapRoutes("None", "None")
    expect(() => compileVaultSwap(from, from, vaultSwapArgs())).toThrow(
      expect.objectContaining({ code: "move.routeMismatch" }),
    )
    const elsewhere = { ...to, deployment: { ...to.deployment, executor: address(0xe2) } }
    expect(() => compileVaultSwap(from, elsewhere, vaultSwapArgs())).toThrow(
      expect.objectContaining({ code: "move.routeMismatch" }),
    )
  })
})

describe("buildVaultSwap", () => {
  it("burns the source's shares to the executor, on its adapters, and reads back as a move into the destination", async () => {
    const { from, to } = await vaultSwapRoutes("None", "Psm")
    const built = buildVaultSwap(from, to, vaultSwapArgs())
    expect(built.operation.executor.toString()).toBe(EXECUTOR.toLowerCase())
    expect(() =>
      assertRouteOnExecutor({ executor: EXECUTOR, payload: built.payload }, MULTI_STEP),
    ).not.toThrow()
    const read = readVaultMove(
      {
        finalizationData: {
          executor: built.operation.executor,
          amount: built.operation.amount,
          userPayload: built.operation.userPayload,
        },
        memo: built.operation.recoveryMemo,
      } as never,
      [EXECUTOR],
    )
    expect(read).toEqual({
      amount: 10n ** 21n,
      nonce: NONCE,
      destination: PORTAL_B,
      recipientCommitment: COMMITMENT,
    })
  })
})

const interaction = (name: string) => ({ request: async () => ({ calls: [{ name }] }) } as never)
/** Names each broadcast by its size tier, as the real Broadcaster does. */
const tiered = { methods: new Proxy({}, { get: (_, method) => () => interaction(String(method)) }) }

/** The calls of the sponsored batch that carries `operation`, the account call and publish_da. */
async function batchCalls(
  operation: unknown,
): Promise<{ name: string; recoveryChunks?: number }[]> {
  let inner: { name: string }[] = []
  const policy = await buildClaimFpcPolicy([
    { kind: KIND_BY_ANY, target: Fr.ZERO, selector: Fr.ZERO, max_fee: 1n },
  ])
  await buildSponsoredTeeOperation(
    { wallet: {}, node: {} } as never,
    {
      fpcAddress: AztecAddress.fromNumberUnsafe(1),
      fpcArtifact: {},
      railId: 0,
      policy,
      user: AztecAddress.fromNumberUnsafe(2),
      tokenContract: { address: AztecAddress.fromNumberUnsafe(3) },
      signer: {},
      operations: [
        {
          ...(operation as object),
          finalizationRequestBroadcastParams: {
            broadcaster: tiered,
            portal: EthAddress.fromString(PORTAL_A),
            payoutToken: EthAddress.fromString(VAULT_A),
          },
        },
      ],
      buildOperationCall: () => interaction("withdraw"),
      operationClassWitnesses: [undefined],
      accountCall: { call: { name: "authorize_intents" }, classWitness: { leaf: 0 } },
      plainWithdrawal: { executor: EthAddress.fromNumber(0xe0), fee: 0n },
    } as never,
    {
      buildClaimSponsorPayload: async (opts: { innerCalls: { name: string }[] }) => {
        inner = opts.innerCalls
        return {}
      },
      buildClaimSubscribePayload: async () => ({}),
      claimFpcSponsoredFee,
    } as never,
  )
  return [...inner, { name: "publish_da" }]
}

describe("a swap's burn, pair by pair", () => {
  const KINDS = ["None", "DaiUsds", "Psm"] as const satisfies readonly ConversionKind[]

  it("takes at most the cap's recovery chunks, and its sponsored batch fits the flat caps", async () => {
    const rows: Record<string, [calls: number, chunks: number]> = {}
    for (const a of KINDS) {
      for (const b of KINDS) {
        const { from, to } = await vaultSwapRoutes(a, b)
        const built = buildVaultSwap(from, to, vaultSwapArgs())
        rows[`${a} -> ${b}`] = [built.calls.length, built.recoveryChunks]
        const calls = (await batchCalls(built.operation)).map((call) =>
          call.name === "withdraw" ? { ...call, recoveryChunks: built.recoveryChunks } : call,
        )
        const batch = claimFpcBatchGas(calls)
        expect(batch.daGas, `${a} -> ${b}`).toBeLessThanOrEqual(CLAIM_FPC_BATCH_CAPS.daGas)
        expect(batch.l2Gas, `${a} -> ${b}`).toBeLessThanOrEqual(CLAIM_FPC_BATCH_CAPS.l2Gas)
      }
    }
    expect(rows).toEqual({
      "None -> None": [3, 5],
      "None -> DaiUsds": [4, 5],
      "None -> Psm": [4, 6],
      "DaiUsds -> None": [4, 5],
      "DaiUsds -> DaiUsds": [3, 5],
      "DaiUsds -> Psm": [5, 6],
      "Psm -> None": [4, 6],
      "Psm -> DaiUsds": [5, 7],
      "Psm -> Psm": [3, 5],
    })
  })
})
