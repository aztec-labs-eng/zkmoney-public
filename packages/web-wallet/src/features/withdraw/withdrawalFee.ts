import { UNREAD, useStore } from "@obsidion/front-core"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  assertExecutorServesPortal,
  type WithdrawalExecutor,
  type WithdrawalExecutorKind,
} from "@obsidion/sdk"
import type { Address } from "viem"
import { requireTupleField } from "../../config/oxideTuple"
import type { PageChain } from "../../session/pageChain"
import { useSession } from "../../session/session"

type ExecutorReads = Pick<PageChain, "withdrawalExecutorAt">

/** The executor a deployment's burns pay, checked to serve the deployment's portal. */
export async function withdrawalExecutor(
  reads: ExecutorReads,
  tuple: OxideEnvTuple,
  kind: WithdrawalExecutorKind = "plain",
): Promise<WithdrawalExecutor> {
  const executor = await reads
    .withdrawalExecutorAt(requireTupleField(tuple, "plainWithdrawalExecutor") as Address, kind)
    .read()
  assertExecutorServesPortal(executor, requireTupleField(tuple, "portal") as Address)
  return executor
}

/** The `FEE()` a deployment's plain withdrawal executor takes from each withdrawal. */
export async function withdrawalExecutorFee(
  reads: ExecutorReads,
  tuple: OxideEnvTuple,
): Promise<bigint> {
  return (await withdrawalExecutor(reads, tuple)).fee
}

/** The active deployment's executor fee. */
export async function activeWithdrawalFee(
  reads: Pick<PageChain, "activeWithdrawalExecutor">,
): Promise<bigint> {
  return (await reads.activeWithdrawalExecutor.read()).fee
}

/** {@link activeWithdrawalFee} for a render; undefined until it lands, or while `enabled` is false. */
export function useActiveWithdrawalFee(enabled = true): bigint | undefined {
  const { chain } = useSession().page
  const state = useStore(enabled ? chain.activeWithdrawalExecutor : UNREAD)
  return state.status === "ready" ? state.value.fee : undefined
}
