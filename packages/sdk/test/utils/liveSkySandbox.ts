/** The sandbox's DAI and Sky savings deployments, from the manifest it serves, with read-only L1 checks. */
import { createPublicClient, erc20Abi, http, type Address } from "viem"
import { foundry } from "viem/chains"
import { SkyEscrowFactoryAbi } from "@oxide/experiments/sky/sky_savings.js"
import { extractPinnedOxideEnvTuple } from "@obsidion/core/oxide"

export async function liveSkySandbox() {
  const url = process.env.OXIDE_MANIFEST_URL ?? "http://localhost:8083/oxide/sandbox.json"
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Sandbox manifest ${url}: HTTP ${response.status}`)
  const manifest = await response.json()
  const deployments: { label?: string; portal: string }[] = manifest.deployments ?? []
  const skyPortal = deployments.find((d) => d.label === "sky")?.portal
  if (!skyPortal)
    throw new Error(
      "The sandbox manifest has no Sky savings deployment; bring the sandbox up from this branch",
    )
  const dai = extractPinnedOxideEnvTuple(manifest, {
    portal: process.env.OXIDE_PORTAL ?? deployments.at(-1)!.portal,
  }).tuple
  const sky = extractPinnedOxideEnvTuple(manifest, { portal: skyPortal }).tuple
  if (!dai.skyEscrowFactory)
    throw new Error("The sandbox's DAI deployment names no Sky escrow factory")
  if (!dai.l2Broadcaster || !sky.l2Broadcaster)
    throw new Error("Sandbox manifest has no L2 broadcaster")
  const factory = dai.skyEscrowFactory as Address
  const client = createPublicClient({
    chain: foundry,
    transport: http(process.env.L1_RPC_URL ?? "http://localhost:8545"),
  })
  const sUsds = (await client.readContract({
    address: factory,
    abi: SkyEscrowFactoryAbi,
    functionName: "SUSDS",
  })) as Address
  const balance = (token: Address, holder: Address) =>
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [holder],
    })
  return { dai, sky, factory, sUsds, client, balance }
}
