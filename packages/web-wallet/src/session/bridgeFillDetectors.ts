import type { Address } from "viem"
import { acrossFills, type BridgeFillDetector } from "@obsidion/front-core"
import type { WebWalletConfig } from "../config/env"
import { acrossBridge } from "./walletChains"

/** The profile's bridges whose fills a funding receipt is read for. */
export function bridgeFillDetectors(
  config: Pick<WebWalletConfig, "features">,
): BridgeFillDetector[] {
  const spokePool = acrossBridge(config)?.spokePool
  return spokePool ? [acrossFills([spokePool as Address])] : []
}

/** Whether the profile names a bridge whose fills a funding receipt is read for. */
export const readsBridgeFills = (config: Pick<WebWalletConfig, "features">) =>
  bridgeFillDetectors(config).length > 0
