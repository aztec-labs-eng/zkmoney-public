/**
 * What moving funds to a new version costs, and what the new balance receives. The exit pays the
 * source executor's fee and the relayer tip on release; the arrival pays the new deployment's
 * deposit fee as the relayer sweeps it in. A deposit subsidy may credit part of it back, so the net is an estimate.
 */
import { formatUnits } from "viem"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { deploymentSipaRoute, withdrawalAmounts, type WithdrawalRecord } from "@obsidion/front-core"
import { readDepositFee } from "@obsidion/sdk"
import { getConfig } from "../../config/env"
import { withdrawalExecutorFee } from "../withdraw/withdrawalFee"
import { l1PublicClient } from "../../config/oxideTuple"

/** The fee fields a migration's withdrawal record carries, base units as strings. */
export type MigrationFeeFields = Required<
  Pick<WithdrawalRecord, "relayerTip" | "arrivalFee" | "withdrawalFee">
>

/** Read off both deployments: the source executor's fee and the new deployment's deposit fee. */
export async function loadMigrationFee(
  current: OxideEnvTuple,
  source: OxideEnvTuple,
): Promise<MigrationFeeFields> {
  const publicClient = l1PublicClient(getConfig())
  const [arrivalFee, withdrawalFee] = await Promise.all([
    readDepositFee(publicClient, deploymentSipaRoute(current)),
    withdrawalExecutorFee(source),
  ])
  return {
    relayerTip: WITHDRAW_RELAYER_TIP.toString(),
    withdrawalFee: withdrawalFee.toString(),
    arrivalFee: arrivalFee.toString(),
  }
}

export interface MigrationAmounts {
  /** What leaves before it reaches the new balance: the exit's fee, then the arrival's. */
  exitFeeDisplay: string
  arrivalFeeDisplay: string
  /** What the new balance receives, before any subsidy. */
  netAtomic: bigint
  netDisplay: string
}

/** Undefined while any fee is unknown: no figure beats a wrong one. */
export function migrationAmounts(
  record: Pick<WithdrawalRecord, "amount" | "rawAmount" | "proverTip" | "tokenDecimals"> &
    Partial<MigrationFeeFields>,
): MigrationAmounts | undefined {
  if (record.arrivalFee == null) return undefined
  const exit = withdrawalAmounts(record)
  if (!exit.feeKnown) return undefined
  const arrivalFee = BigInt(record.arrivalFee)
  const netAtomic = exit.netAtomic > arrivalFee ? exit.netAtomic - arrivalFee : 0n
  return {
    exitFeeDisplay: exit.feeDisplay,
    arrivalFeeDisplay: formatUnits(arrivalFee, record.tokenDecimals),
    netAtomic,
    netDisplay: formatUnits(netAtomic, record.tokenDecimals),
  }
}
