import { WalletError } from "@obsidion/core/errors"
import { SkyConverterAdapterAbi } from "@oxide/l1-contracts/artifacts.js"
import { adapters } from "@oxide/l1-contracts/multi_step/index.js"
import { isAddressEqual } from "viem"
import { atPar } from "../conversion.js"
import type { ConversionAdapter } from "../conversion.js"
import { executorAdapter } from "../holdingDeployment.js"

/** A USDS vault from a DAI base, through Sky's converter, which swaps them 1:1 without a fee. */
export const daiUsdsConversion: ConversionAdapter = {
  kind: "DaiUsds",
  async bind(client, deployment, executor) {
    const address = executorAdapter(executor, "skyConverter")
    const read = (functionName: "DAI" | "USDS") =>
      client.readContract({ address, abi: SkyConverterAdapterAbi, functionName })
    const [dai, usds] = await Promise.all([read("DAI"), read("USDS")])
    if (
      !isAddressEqual(dai, deployment.base.token) ||
      !isAddressEqual(usds, deployment.held.asset)
    ) {
      throw new WalletError(
        "move.routeMismatch",
        `${address} converts ${dai} and ${usds}, not the holding's tokens`,
      )
    }
    const { skyConverter } = adapters({
      chainId: deployment.chainId,
      configs: { skyConverter: { address, dai, usds } },
    })
    const steps = { in: () => [skyConverter.daiToUsds()], out: () => [skyConverter.usdsToDai()] }
    return { steps: (direction) => steps[direction](), quote: atPar }
  },
}
