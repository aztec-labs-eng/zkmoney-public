import { describe, expect, it } from "vitest"
import type { Step } from "@oxide/l1-contracts/multi_step/index.js"
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  erc4626Abi,
  maxUint256,
} from "viem"
import type { PublicClient } from "viem"
import { erc4626Reader, erc4626Terms } from "../../../src/oxide/holdings/terms/erc4626.js"
import { ERC4626_ADAPTER, MULTI_STEP, USDS, USDS_VAULT, VAULT } from "./holdingFixtures.js"

const HOLDER = `0x${"42".repeat(20)}` as const

/** A revert of `functionName` with `data`; no data is what a contract without the function gives. */
const reverted = (functionName: "maxDeposit" | "maxRedeem", data?: `0x${string}`) =>
  new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: erc4626Abi, functionName, data }),
    { abi: erc4626Abi, functionName, args: [HOLDER], contractAddress: VAULT },
  )

const client = (read: (functionName: string) => unknown) =>
  ({
    readContract: async ({ functionName }: { functionName: string }) => read(functionName),
  } as unknown as PublicClient)

const shape = (steps: Step[]) =>
  steps.map((step) => [step.adapter, step.fn, step.in, step.out, step.minOut])

describe("erc4626Terms", () => {
  it("deposits the vault's asset moving in and redeems its shares moving out", () => {
    const terms = erc4626Terms.bind(
      client(() => undefined),
      USDS_VAULT,
      MULTI_STEP,
    )
    expect({ in: shape(terms.steps("in", 7n)), out: shape(terms.steps("out", 8n)) }).toEqual({
      in: [[ERC4626_ADAPTER, "erc4626Deposit", USDS, VAULT, 7n]],
      out: [[ERC4626_ADAPTER, "erc4626Redeem", VAULT, USDS, 8n]],
    })
  })
})

describe("erc4626Reader", () => {
  it("reads a vault's limits, previews and rate", async () => {
    const answers: Record<string, bigint> = {
      maxDeposit: 1n,
      maxRedeem: 2n,
      previewDeposit: 3n,
      previewRedeem: 4n,
      convertToAssets: 5n,
    }
    const vault = erc4626Reader(
      client((fn) => answers[fn]),
      VAULT,
    )
    expect([
      await vault.maxDeposit(HOLDER),
      await vault.maxRedeem(HOLDER),
      await vault.previewDeposit(10n),
      await vault.previewRedeem(10n),
      await vault.convertToAssets(10n),
    ]).toEqual([1n, 2n, 3n, 4n, 5n])
  })

  it("reads a limit the vault does not have as unbounded, and fails on any other revert", async () => {
    const missing = erc4626Reader(
      client((fn) => {
        throw reverted(fn as "maxDeposit")
      }),
      VAULT,
    )
    expect([await missing.maxDeposit(HOLDER), await missing.maxRedeem(HOLDER)]).toEqual([
      maxUint256,
      maxUint256,
    ])

    const failing = erc4626Reader(
      client(() => {
        throw reverted("maxRedeem", "0xdeadbeef")
      }),
      VAULT,
    )
    await expect(failing.maxRedeem(HOLDER)).rejects.toThrow(ContractFunctionExecutionError)
  })
})
