// A vault move's way back when its route cannot run: `MultiStepExecutor.recover` releases the
// withdrawal itself and pays all of it but the prover tip to the recipient the recovery account
// signs for.
import { MultiStepExecutorAbi } from "@oxide/l1-contracts/artifacts.js"
import {
  encodeMultiStepRecover,
  multiStepRecoveryDigest,
} from "@oxide/l1-contracts/multi_step/index.js"
import type { WithdrawArgs } from "@oxide/l1-contracts/oxide_portal.js"
import type { Address, Hash, Hex, PublicClient } from "viem"

export type { WithdrawArgs }

export async function buildMultiStepRecoverCall(args: {
  executor: Address
  /** The portal the burn withdraws from. */
  portal: Address
  chainId: bigint
  /** The burn's release arguments, as the portal's `withdraw` takes them. */
  release: WithdrawArgs
  recoverySalt: Hex
  account: Address
  /** Signs a digest as `account`. */
  sign: (digest: Hex) => Promise<Hex>
  recipient: Address
  /** Unix seconds. */
  deadline: bigint
}): Promise<{ to: Address; data: Hex }> {
  const { executor, release, recipient, deadline } = args
  const digest = multiStepRecoveryDigest({
    executor,
    chainId: args.chainId,
    withdrawalId: release.withdrawalId,
    recipient,
    deadline,
  })
  const data = encodeMultiStepRecover({
    portal: args.portal,
    args: release,
    recoverySalt: args.recoverySalt,
    account: args.account,
    signature: await args.sign(digest),
    recipient,
    deadline,
  })
  return { to: executor, data }
}

/** The executor's recovery of `withdrawalId` in L1 blocks `[from, to]`, if one was made there. */
export async function readMultiStepRecovery(
  client: Pick<PublicClient, "getContractEvents">,
  args: { executor: Address; withdrawalId: Hex; from: bigint; to: bigint },
): Promise<{ txHash: Hash; recipient: Address; amount: bigint; blockNumber: bigint } | undefined> {
  const [log] = await client.getContractEvents({
    address: args.executor,
    abi: MultiStepExecutorAbi,
    eventName: "Recovered",
    args: { withdrawalId: args.withdrawalId },
    fromBlock: args.from,
    toBlock: args.to,
  })
  const { recipient, amount } = log?.args ?? {}
  if (!log || recipient === undefined || amount === undefined) return undefined
  return { txHash: log.transactionHash, recipient, amount, blockNumber: log.blockNumber }
}
