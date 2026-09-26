/**
 * What moving funds to a new version costs, and what the new balance receives. The exit pays the
 * relayer tip and the old portal's funding cut on release; the arrival pays the new deployment's
 * deposit fee and funding cut as the relayer sweeps it in. A deposit subsidy may credit part of it
 * back, so the net is an estimate.
 */
import { formatUnits, type Address } from "viem"
import {
  DEFAULT_DECIMALS,
  quotedDepositFee,
  WITHDRAW_RELAYER_TIP,
} from "@obsidion/core/constants"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  depositSipaImplementation,
  withdrawalAmounts,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { readDepositFee } from "@obsidion/sdk"
import { getConfig } from "../../config/env"
import { l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { fpcFundingCut } from "../fees/fpcFundingCut"

/** The fee fields a migration's withdrawal record carries, base units as strings. */
export type MigrationFeeFields = Required<
  Pick<WithdrawalRecord, "relayerTip" | "fpcFundingCut" | "arrivalFee">
>

/** Read off both deployments: the old portal's cut, and the new one's deposit fee and cut. */
export async function loadMigrationFee(
  historic: OxideEnvTuple,
  current: OxideEnvTuple,
): Promise<MigrationFeeFields> {
  const publicClient = l1PublicClient(getConfig())
  const [exitCut, depositFee, arrivalCut] = await Promise.all([
    fpcFundingCut(publicClient, requireTupleField(historic, "portal") as Address),
    depositSipaImplementation(
      publicClient,
      requireTupleField(current, "sipaFactory") as Address,
      requireTupleField(current, "portal") as Address,
    ).then((implementation) => readDepositFee(publicClient, implementation)),
    fpcFundingCut(publicClient, requireTupleField(current, "portal") as Address),
  ])
  return {
    relayerTip: WITHDRAW_RELAYER_TIP.toString(),
    fpcFundingCut: exitCut.toString(),
    arrivalFee: quotedDepositFee(depositFee, arrivalCut).toString(),
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
  record: Pick<WithdrawalRecord, "amount" | "rawAmount" | "proverTip"> &
    Partial<MigrationFeeFields>,
): MigrationAmounts | undefined {
  if (record.arrivalFee == null) return undefined
  const exit = withdrawalAmounts(record)
  if (!exit.feeKnown) return undefined
  const arrivalFee = BigInt(record.arrivalFee)
  const netAtomic = exit.netAtomic > arrivalFee ? exit.netAtomic - arrivalFee : 0n
  return {
    exitFeeDisplay: exit.feeDisplay,
    arrivalFeeDisplay: formatUnits(arrivalFee, DEFAULT_DECIMALS),
    netAtomic,
    netDisplay: formatUnits(netAtomic, DEFAULT_DECIMALS),
  }
}
