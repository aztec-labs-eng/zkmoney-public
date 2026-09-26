/**
 * Shared L1 bring-up for the portal-migration specs. Differs from the sandbox helpers it mirrors
 * in that the L1 relayer/deployer key is a parameter (anvil acct0 is the harness sequencers'
 * publisher; sharing its nonce space silently drops txs).
 */
import type { AztecNode } from "@aztec/aztec.js/node"
import { L1_RPC_URL } from "@obsidion/core/constants"
import { LocalTeeSigner } from "@oxide/tee-enclave/signer.js"
import { P256PublicKey } from "@oxide/oxide-lib/encryption.js"
import { createPublicClient, createWalletClient, http } from "viem"
import type { Address, Hex, PublicClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"

import type { SandboxTeePortalStack } from "../utils/oxideTokenSandbox.js"
import { deploySandboxOxidePortalStack, aztecL1WiringFromNodeInfo } from "../utils/tee/oxidePortalHarness.js"

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const

/**
 * `tryDeploySandboxTeePortalStack` with the relayer key parameterized and an existing
 * underlying ERC20 optionally reused instead of a fresh test-token deploy. `encryptionPublicKey` overrides the signer's
 * placeholder P-256 key in the attestation fixture (LocalTeeSigner publishes zeros, which a
 * `RemoteTeeSigner` cannot seal to).
 */
export async function deployHarnessTeePortalStack(
  node: AztecNode,
  teeSigner: LocalTeeSigner,
  relayerPrivateKey: Hex,
  existingTestToken?: Address,
  encryptionPublicKey?: P256PublicKey,
): Promise<SandboxTeePortalStack> {
  const httpUrl = L1_RPC_URL.LOCAL
  const l1Wiring = aztecL1WiringFromNodeInfo(await node.getNodeInfo())

  const publicClient = createPublicClient({ chain: foundry, transport: http(httpUrl) })
  const relayerWallet = createWalletClient({
    account: privateKeyToAccount(relayerPrivateKey),
    chain: foundry,
    transport: http(httpUrl),
  })

  const l1Block = await publicClient.getBlock()
  const l1Deployment = await deploySandboxOxidePortalStack(
    relayerWallet,
    publicClient,
    l1Wiring,
    {
      pubKeyX: teeSigner.publicKey.x,
      pubKeyY: teeSigner.publicKey.y,
      ethAddress: teeSigner.ethAddress,
      encryptionPublicKey: encryptionPublicKey ?? teeSigner.encryptionPublicKey,
    },
    {
      relayerPrivateKey,
      l1Chain: foundry,
      l1RpcUrl: httpUrl,
      // registerTeeSigner warps a lagging sandbox chain forward to wall clock; stamp against the
      // later of the two so the attestation is fresh under either clock.
      l1ChainTimestampMillis: Math.max(Number(l1Block.timestamp) * 1000, Date.now()),
      existingTestToken,
    },
  )

  return { l1Deployment, publicClient, relayerWallet }
}

/** ERC20 balance via the stack's public client. */
export async function erc20BalanceOf(
  publicClient: PublicClient,
  token: Address,
  owner: Address,
): Promise<bigint> {
  return (await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint
}
