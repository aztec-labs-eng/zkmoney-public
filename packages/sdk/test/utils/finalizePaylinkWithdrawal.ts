import { expect } from "vitest"
import { createExtendedL1Client } from "@aztec/ethereum/client"
import { foundry } from "viem/chains"
import { type Address, type Hex } from "viem"
import { TestERC20Abi } from "@oxide/l1-contracts"
import { L1_RPC_URL } from "@obsidion/core/constants"
import {
  buildWithdrawFinalizationCall,
  WithdrawFinalizationError,
} from "../../src/oxide/withdrawFinalizationCall.js"
import { sendEmptyTx } from "../../src/utils/helper.js"
import { type OxideTokenSandbox } from "./oxideTokenSandbox.js"

/** Exercise the production finalization builder against the real portal; assert actual ERC20 delivery. */
export async function finalizePaylinkWithdrawal(
  sandbox: OxideTokenSandbox,
  burnTxHash: Hex,
  recipient: Address,
  expectedNet: bigint,
) {
  const { l1Deployment: deployment, publicClient } = sandbox.oxideStack
  const client = createExtendedL1Client(
    [process.env.SANDBOX_L1_RPC_URL || L1_RPC_URL.LOCAL],
    sandbox.oxideStack.relayerPrivateKey,
    foundry,
  )
  const executor = sandbox.withdrawal.tuple?.plainWithdrawalExecutor
  if (!executor)
    throw new Error("The sandbox withdrawal deployment has no plain withdrawal executor")
  const balance = () =>
    publicClient.readContract({
      address: deployment.testToken,
      abi: TestERC20Abi,
      functionName: "balanceOf",
      args: [recipient],
    })
  const before = await balance()
  for (let attempt = 0; attempt < 24; attempt++) {
    try {
      const call = await buildWithdrawFinalizationCall(
        {
          node: sandbox.node,
          signer: sandbox.teeSigner,
          portalContext: {
            l1Portal: deployment.tokenPortal,
            l2Portal: sandbox.tokenContract.address.toString(),
            rollupVersion: sandbox.rollupVersion,
            l1ChainId: 31337n,
          },
          plainWithdrawalExecutor: executor as Hex,
          l1: publicClient,
        },
        { burnTxHash, tipRecipient: client.account.address },
      )
      const hash = await client.sendTransaction({ to: call.to, data: call.data })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      expect(receipt.status).toBe("success")
      expect((await balance()) - before).toBe(expectedNet)
      console.log(`Email withdrawal finalized: l2=${burnTxHash} l1=${hash} net=${expectedNet}`)
      return
    } catch (error) {
      if (!(error instanceof WithdrawFinalizationError) || error.reason !== "not-yet-finalizable")
        throw error
      await sendEmptyTx(sandbox.wallet, sandbox.accounts[0]!, sandbox.sponsoredFeePaymentMethod)
    }
  }
  throw new Error("Email withdrawal did not become finalizable after 24 blocks")
}
