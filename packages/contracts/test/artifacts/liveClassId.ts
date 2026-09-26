/**
 * The contract class a live oxide deployment runs for one manifest field.
 *
 * The instance address comes from the manifest rather than a pin: oxide moves every instance on
 * each deploy while the class only moves when their contract source does, so resolving the address
 * leaves the sentinels asserting the one thing that must not drift. `OXIDE_MANIFEST_URL` names
 * the v4 document and `OXIDE_PORTAL` the entry, the same pair every deploy pins.
 */
import { extractPinnedOxideEnvTuple } from "@obsidion/core/oxide"
import { AZTEC_API_KEY_HEADER, AZTEC_NODE_API_KEY } from "@obsidion/core/constants"

const TESTNET_NODE_URL = "https://v5.testnet.rpc.aztec-labs.com"

type OxideField = "l2Token" | "l2Broadcaster"

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required to resolve the live instance`)
  return value
}

export async function liveInstanceClassId(
  field: OxideField,
): Promise<{ address: string; classId: string }> {
  const manifestUrl = requireEnv("OXIDE_MANIFEST_URL")
  const portal = requireEnv("OXIDE_PORTAL")
  const manifest = await (await fetch(manifestUrl)).json()
  const address = extractPinnedOxideEnvTuple(manifest, { portal }).tuple[field]
  if (!address) throw new Error(`deployment ${portal} in ${manifestUrl} carries no ${field}`)

  const response = await fetch(TESTNET_NODE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(AZTEC_NODE_API_KEY ? { [AZTEC_API_KEY_HEADER]: AZTEC_NODE_API_KEY } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "node_getContract",
      params: [address],
      id: 1,
    }),
  })
  const body = (await response.json()) as {
    result?: { currentContractClassId?: string }
    error?: { message?: string }
  }
  if (!body.result?.currentContractClassId) {
    throw new Error(
      `node_getContract(${address}) returned no class id: ${JSON.stringify(body.error ?? body)}`,
    )
  }
  return { address, classId: body.result.currentContractClassId }
}
