/**
 * verify-live-decimals — the flat-18 cutover gate. Runs OFF-DEVICE on the dev
 * machine / CI.
 *
 * Reads the LIVE staging L1 `token.decimals()` and L2 `l2Token` decimals and
 * EXITS NON-ZERO unless BOTH report 18. Flipping `TOKEN_DECIMALS_BY_NETWORK`'s
 * TESTNET/MAINNET to 18 is only safe once the live deployment the wallet's
 * `Network.TESTNET` talks to is actually 18-dec — a still-live 6-dec deployment
 * would make `parseAmount`/`formatAmount` compute AND display every testnet
 * amount 10^12 off (on-chain amounts, not just display). Gate merge on this;
 * never infer it from the published manifest alone.
 *
 * L1: plain ERC20 `decimals()` via a live Sepolia RPC, passed as
 *     `SEPOLIA_RPC_URL` — the repo's keyless default is rate-limited and a
 *     throttled read aborts the gate spuriously.
 * L2: the `l2Token` is `OxideToken`, whose `decimals` is a `PublicImmutable<u8>`
 *     stored at the artifact's `decimals` slot (the value sits at the base slot;
 *     the WithHash digest is at slot+1). Read it straight from public storage via
 *     `node.getPublicStorageAt` — NOT `TokenService.fetchTokenInformation`, which
 *     returns `tokenDecimalsForNetwork()`, the very constant being flipped
 *     (circular, non-verifying). The slot is taken from the bundled artifact, so
 *     the read stays artifact-backed.
 *
 * Run:
 *   SEPOLIA_RPC_URL=<live-rpc> AZTEC_NODE_URL=<testnet-node> OXIDE_PORTAL=<portal> \
 *   pnpm --filter @obsidion/sdk verify-live-decimals
 */
import { AztecAddress } from "@aztec/aztec.js/addresses"
import { createAztecNodeClient } from "@aztec/aztec.js/node"
import { extractPinnedOxideEnvTuple, getHardcodedArtifact } from "@obsidion/contracts"
import { DEFAULT_CONTRACTS } from "@obsidion/core/constants"
import { createPublicClient, http } from "viem"
import type { Address } from "viem"
import { sepolia } from "viem/chains"

const MANIFEST_URL =
  process.env.OXIDE_MANIFEST_URL ?? "https://d1g9k2awa2mp7i.cloudfront.net/staging.v4.json"
const PORTAL = process.env.OXIDE_PORTAL
// Staging's L2 lives on the testnet Aztec node (same node the class-id sentinel reads).
const DEFAULT_AZTEC_NODE_URL = "https://v4.testnet.rpc.aztec-labs.com"

const EXPECTED_DECIMALS = 18

const DECIMALS_ABI = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const

async function readL1Decimals(token: Address): Promise<number> {
  const rpcUrl = process.env.SEPOLIA_RPC_URL
  if (!rpcUrl) {
    throw new Error(
      "missing SEPOLIA_RPC_URL — pass a keyed endpoint, not the repo's rate-limited default",
    )
  }
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) })
  const decimals = await client.readContract({
    address: token,
    abi: DECIMALS_ABI,
    functionName: "decimals",
  })
  return Number(decimals)
}

async function readL2Decimals(l2Token: string): Promise<number> {
  const nodeUrl = process.env.AZTEC_NODE_URL ?? DEFAULT_AZTEC_NODE_URL
  const artifact = await getHardcodedArtifact(DEFAULT_CONTRACTS.oxideToken)
  const slot = artifact.storageLayout.decimals?.slot
  if (!slot) {
    throw new Error("oxideToken artifact exposes no `decimals` storage slot — layout drift")
  }
  const node = createAztecNodeClient(nodeUrl)
  const raw = await node.getPublicStorageAt("latest", AztecAddress.fromStringUnsafe(l2Token), slot)
  return Number(raw.toBigInt())
}

async function main(): Promise<void> {
  if (!PORTAL) throw new Error("missing OXIDE_PORTAL — the manifest is pinned by portal")
  const res = await fetch(MANIFEST_URL)
  if (!res.ok) {
    throw new Error(`manifest fetch failed: HTTP ${res.status} (${MANIFEST_URL})`)
  }
  const { tuple } = extractPinnedOxideEnvTuple(await res.json(), { portal: PORTAL })
  console.log(`[verify-live-decimals] manifest=${MANIFEST_URL} portal=${PORTAL}`)
  console.log(`[verify-live-decimals] L1 token=${tuple.token} L2 l2Token=${tuple.l2Token}`)

  const [l1Decimals, l2Decimals] = await Promise.all([
    readL1Decimals(tuple.token as Address),
    readL2Decimals(tuple.l2Token),
  ])
  console.log(
    `[verify-live-decimals] L1 decimals=${l1Decimals} L2 decimals=${l2Decimals} ` +
      `(expected ${EXPECTED_DECIMALS})`,
  )

  const failures: string[] = []
  if (l1Decimals !== EXPECTED_DECIMALS) {
    failures.push(`L1 token ${tuple.token} reports ${l1Decimals}, not ${EXPECTED_DECIMALS}`)
  }
  if (l2Decimals !== EXPECTED_DECIMALS) {
    failures.push(`L2 token ${tuple.l2Token} reports ${l2Decimals}, not ${EXPECTED_DECIMALS}`)
  }
  if (failures.length > 0) {
    console.error("[verify-live-decimals] GATE FAILED — the flat-18 flip is UNSAFE to merge:")
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log(
    "[verify-live-decimals] GATE PASSED — live staging L1 and L2 both report 18-dec; " +
      "the flat-18 flip is safe to merge.",
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
