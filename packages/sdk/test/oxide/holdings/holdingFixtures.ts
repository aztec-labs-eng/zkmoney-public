import type { ExecutorHolding, MultiStepExecutor, OxideBridge } from "@obsidion/core/oxide"
import { getAddress } from "viem"
import type { Address } from "viem"
import type { HoldingDeployment } from "../../../src/oxide/holdings/holdingDeployment.js"

const address = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`)

export const DAI = address(0xda1)
export const USDS = address(0x05d5)
/** Six decimals. */
export const USDC = address(0x05dc)
export const VAULT = address(0x7a01)
export const EXECUTOR = address(0xe1)
export const ERC4626_ADAPTER = address(0xad1)
export const PORTAL_DEPOSIT_ADAPTER = address(0xad2)
export const SKY_CONVERTER_ADAPTER = address(0xad3)
export const MAKER_PSM_ADAPTER = address(0xad4)
export const UNISWAP_V3_ADAPTER = address(0xad5)
export const MAIN_PORTAL = address(0x9001)
export const HELD_PORTAL = address(0x9002)

export const MULTI_STEP: MultiStepExecutor = {
  id: "fea-multistep-v6",
  address: EXECUTOR,
  adapters: {
    erc4626: ERC4626_ADAPTER,
    portalDeposit: PORTAL_DEPOSIT_ADAPTER,
    skyConverter: SKY_CONVERTER_ADAPTER,
    makerPsm: MAKER_PSM_ADAPTER,
    uniswapV3: UNISWAP_V3_ADAPTER,
  },
}

const bridge = (underlying: Address, portal: Address) =>
  ({ underlying, token: underlying, portal, l2Token: "0x01" } as unknown as OxideBridge)

/** A vault of `conversion`'s asset, as the core catalog reads it, its addresses in lower case. */
export const vaultHolding = (conversion: ExecutorHolding["conversion"]): ExecutorHolding => ({
  id: "fea-vault-test-v6",
  kind: "yield",
  l2Token: "0x01",
  base: bridge(DAI.toLowerCase() as Address, MAIN_PORTAL),
  held: bridge(VAULT.toLowerCase() as Address, HELD_PORTAL),
  terms: "erc4626",
  conversion,
  rail: "executor",
  executor: MULTI_STEP,
})

const base = {
  chainId: 1n,
  executor: EXECUTOR,
  portalDepositAdapter: PORTAL_DEPOSIT_ADAPTER,
  base: { portal: MAIN_PORTAL, token: DAI },
}

const held = (asset: Address) => ({ portal: HELD_PORTAL, token: VAULT, asset })

/** A vault of DAI, with no conversion. */
export const DAI_VAULT: HoldingDeployment = { ...base, held: held(DAI) }

/** A vault of USDS, reached through Sky's converter. */
export const USDS_VAULT: HoldingDeployment = { ...base, held: held(USDS) }

/** A vault of USDC, reached through the PSM. */
export const USDC_VAULT: HoldingDeployment = { ...base, held: held(USDC) }

/** A chain that answers the reads a vault's route binds with: its vault's asset and the converter's tokens. */
export const fakeChain = (asset: Address = USDS, converter = { dai: DAI, usds: USDS }) => ({
  getChainId: async () => 1,
  simulateBlocks: async () => {
    throw new Error("unexpected simulateBlocks")
  },
  getBlock: async () => {
    throw new Error("unexpected getBlock")
  },
  readContract: async (read: { address: Address; functionName: string }) => {
    const answers: Record<string, unknown> = {
      [`${VAULT}.asset`]: asset,
      [`${SKY_CONVERTER_ADAPTER}.DAI`]: converter.dai,
      [`${SKY_CONVERTER_ADAPTER}.USDS`]: converter.usds,
    }
    const answer = answers[`${read.address}.${read.functionName}`]
    if (answer === undefined) throw new Error(`unexpected ${read.functionName} on ${read.address}`)
    return answer
  },
})
