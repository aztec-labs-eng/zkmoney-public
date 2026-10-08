import type { Plugin } from "vite"
import { Network } from "@obsidion/core/constants"
import { assertL1RpcSimulates } from "@obsidion/core/oxide"
import { parseNetwork } from "./src/config/profilePolicy.js"

type Env = Record<string, string | undefined>

/**
 * Fails a mainnet build whose baked L1 RPC cannot price swaps. Testnet has no swap stack, and a
 * sandbox's anvil is not running at build time. A bundle without a baked RPC dials the config
 * profile's, which is checked where the profile is published.
 */
export async function assertBakedL1RpcSimulates(env: Env, fetchImpl?: typeof fetch): Promise<void> {
  const url = env.VITE_L1_RPC_URL
  if (!url || parseNetwork(env.VITE_NETWORK) !== Network.MAINNET) return
  await assertL1RpcSimulates(url, fetchImpl)
}

export function l1RpcCapability(): Plugin {
  let env: Env = {}
  return {
    name: "obsidion-l1-rpc-capability",
    apply: "build",
    configResolved(config) {
      env = config.env as Env
    },
    async buildStart() {
      await assertBakedL1RpcSimulates(env)
    },
  }
}
