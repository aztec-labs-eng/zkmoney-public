import { adapters } from "@oxide/l1-contracts/multi_step/index.js"
import { BaseError, ContractFunctionRevertedError, erc4626Abi, maxUint256 } from "viem"
import type { Address, PublicClient } from "viem"
import { executorAdapter } from "../holdingDeployment.js"
import type { TermsAdapter, TermsReader } from "../terms.js"

/** A revert with no data: what a contract without the function gives. */
function isMissingFunction(error: unknown): boolean {
  const reverted =
    error instanceof BaseError &&
    error.walk((cause) => cause instanceof ContractFunctionRevertedError)
  return (
    reverted instanceof ContractFunctionRevertedError &&
    (reverted.raw === undefined || reverted.raw === "0x")
  )
}

/** The reads a move needs from an ERC-4626 vault. */
export function erc4626Reader(
  client: Pick<PublicClient, "readContract">,
  vault: Address,
): TermsReader {
  const at = { address: vault, abi: erc4626Abi } as const
  // The sandbox's stand-in for sUSDS has no `maxDeposit` or `maxRedeem`: no limit.
  const limit = (read: Promise<bigint>) =>
    read.catch((error: unknown) => {
      if (isMissingFunction(error)) return maxUint256
      throw error
    })
  return {
    maxDeposit: (receiver) =>
      limit(client.readContract({ ...at, functionName: "maxDeposit", args: [receiver] })),
    maxRedeem: (owner) =>
      limit(client.readContract({ ...at, functionName: "maxRedeem", args: [owner] })),
    previewDeposit: (assets) =>
      client.readContract({ ...at, functionName: "previewDeposit", args: [assets] }),
    previewRedeem: (shares) =>
      client.readContract({ ...at, functionName: "previewRedeem", args: [shares] }),
    convertToAssets: (shares) =>
      client.readContract({ ...at, functionName: "convertToAssets", args: [shares] }),
  }
}

/** An ERC-4626 vault's shares: the vault step deposits its asset and redeems the shares. */
export const erc4626Terms: TermsAdapter = {
  kind: "erc4626",
  bind(client, deployment, executor) {
    const vault = { share: deployment.held.token, asset: deployment.held.asset }
    const { erc4626 } = adapters({
      chainId: deployment.chainId,
      configs: { erc4626: { address: executorAdapter(executor, "erc4626") } },
    })
    const steps = {
      in: (minOut: bigint) => [erc4626.deposit({ vault, minOut })],
      out: (minOut: bigint) => [erc4626.redeem({ vault, minOut })],
    }
    return {
      reader: erc4626Reader(client, vault.share),
      steps: (direction, minOut) => steps[direction](minOut),
    }
  },
}
