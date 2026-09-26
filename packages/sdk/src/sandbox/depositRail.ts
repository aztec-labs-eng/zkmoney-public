import type { AztecAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { isL1ToL2MessageReady } from "@aztec/aztec.js/messaging"
import type { AztecNode } from "@aztec/aztec.js/node"
import { createExtendedL1Client } from "@aztec/ethereum/client"
import { OxidePortalContract } from "@oxide/l1-contracts/oxide_portal.js"
import { computeRecipientCommitment } from "@oxide/oxide-lib/recipient_commitment.js"
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"

/** Store params for a portal deposit: the recipient's PXE redeems them in a free utility sim. */
export type SandboxDepositParams = {
  leafIndex: string
  amount: string
  recipient: string
  messageSecret: string
}

export type DepositThroughPortalOptions = {
  l1RpcUrl: string
  node: AztecNode
  token: Address
  portal: Address
  /** Already holds `amount` of the token and the ETH to spend it. */
  depositorKey: Hex
  recipient: AztecAddress
  amount: bigint
  /** Produces at least one L2 block; called between readiness polls. */
  advance: () => Promise<unknown>
  timeoutMs?: number
  log?: (entry: Record<string, string>) => void
}

const erc20Abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"])

/**
 * Sandbox-only. Bridges a token balance the depositor already holds to an L2 recipient over the
 * oxide portal and returns once the L1→L2 message is consumable. How the depositor got the tokens
 * and how L2 blocks get produced are the caller's, because those differ between drivers.
 */
export async function depositThroughPortal(
  options: DepositThroughPortalOptions,
): Promise<SandboxDepositParams> {
  const { l1RpcUrl, node, token, portal, depositorKey, recipient, amount, advance } = options
  const timeoutMs = options.timeoutMs ?? 180_000
  const account = privateKeyToAccount(depositorKey)
  const publicClient = createPublicClient({ chain: foundry, transport: http(l1RpcUrl) })
  const walletClient = createWalletClient({ account, chain: foundry, transport: http(l1RpcUrl) })
  const approval = await walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [portal, amount],
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: approval, timeout: 120_000 })
  options.log?.({ operation: "approve", transaction: approval, status: receipt.status })
  if (receipt.status !== "success") throw new Error(`approve reverted: ${approval}`)

  const secret = Fr.random()
  const commitment = await computeRecipientCommitment(secret, recipient as never)
  const portalContract = new OxidePortalContract(
    createExtendedL1Client([l1RpcUrl], depositorKey, foundry),
    portal,
  )
  const { event } = await portalContract.deposit(
    Fr.fromHexString(commitment.toString() as Hex),
    amount,
    { waitForReceipt: true },
  )
  if (!event) throw new Error("Deposit receipt has no deposit event")
  const leafIndex = event.leafIndex.toString()
  options.log?.({ operation: "deposit", leafIndex, messageKey: event.messageKey.toString() })

  const deadline = Date.now() + timeoutMs
  while (!(await isL1ToL2MessageReady(node as never, event.messageKey))) {
    if (Date.now() > deadline)
      throw new Error(`Deposit message not consumable after ${timeoutMs / 1000}s`)
    await advance()
  }
  return {
    leafIndex,
    amount: amount.toString(),
    recipient: recipient.toString(),
    messageSecret: secret.toString(),
  }
}
