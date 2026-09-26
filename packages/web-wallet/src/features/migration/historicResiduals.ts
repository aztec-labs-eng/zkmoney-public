/**
 * Residual-funds probe over the retired oxide deployments (the other same-rollup entries of
 * `deployments[]`). A historic
 * portal may still hold user value as a private balance on its l2Token, a SIPA deposit still in
 * transit or swept-but-unclaimed, or a paylink escrow that was never claimed/refunded. A paylink
 * still inside its claim window is reported separately: nothing can refund it until the window
 * closes, so the modal only announces it and the pending-migration store waits it out. The
 * migration-detected modal shows iff any historic deployment reports residuals — re-checked every
 * boot until drained, so there is no persisted "seen" state to go stale.
 *
 * Each probe runs in its own try/catch: one failing deployment or probe must not hide residuals
 * the other probes found. A failed SIPA scan is reported as `incomplete`; it never opens the modal
 * on its own (a retired broadcaster class this build cannot simulate would nag every boot), but
 * when the modal is open for another reason it shows the failure and offers a retry.
 */
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { TokenService, type ObsidionWallet } from "@obsidion/sdk"
import type { Account } from "@aztec/aztec.js/account"
import {
  createDepositExitL1Reads,
  scanRefundableDeposits,
  paylinkRefundEligibility,
  type RefundableDeposit,
  type RefundableSipaSource,
  type PaylinkTransaction,
  type Transaction,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import type { Address, PublicClient } from "viem"

/** In-flight withdrawals. Informational: their burns are already done, migration leaves them alone. */
export function countPendingWithdrawals(records: readonly WithdrawalRecord[]): number {
  return records.filter((r) => r.phase !== "done" && r.phase !== "failed").length
}

export interface HistoricResidualSummary {
  tuple: OxideEnvTuple
  /** Private balance on the historic l2Token (raw units). */
  balance: bigint
  /** Swept-but-unclaimed SIPA deposits attributable to the historic portal. */
  sweptDeposits: number
  /** Broadcast SIPAs on the historic deployment that still hold L1 funds awaiting a sweep. */
  inTransitDeposits: number
  /** Creator paylink escrows on the historic token the creator can refund now. */
  paylinkEscrows: number
  /** Creator paylinks on the historic token still inside their claim window — not refundable yet. */
  lockedPaylinks: PaylinkTransaction[]
  /** Every still-escrowed creator paylink on the historic token, window state aside — the pending lane's input. */
  paylinkCandidates: PaylinkTransaction[]
  incomplete: boolean
  hasResiduals: boolean
}

export interface HistoricResidualDeps {
  wallet: ObsidionWallet
  account: Account
  publicClient: PublicClient
  current: OxideEnvTuple
  historic: OxideEnvTuple[]
  rows: Transaction[]
  /**
   * Chain/PXE-only SIPA discovery for one historic deployment. The caller binds note sync, the
   * retiring token balance, and the L2 nullifier check because those need the unlocked wallet/node.
   */
  sipaDiscovery?: {
    sources(tuple: OxideEnvTuple): Promise<readonly RefundableSipaSource[]>
    scanRange(tuple: OxideEnvTuple): Promise<{ fromBlock: bigint; toBlock: bigint }>
    balance(tuple: OxideEnvTuple, sipaAddress: string): Promise<bigint>
    claimed(
      tuple: OxideEnvTuple,
      deposit: RefundableDeposit<{ toString(): string }>,
    ): Promise<boolean>
  }
  /**
   * Chain-tip seconds for the claim window, or null when the tip was unreadable: paylinks are then
   * left unclassified (still recorded as candidates) rather than judged by the wall clock.
   */
  nowSec: number | null
}

/** Rows attributable to a historic deployment: tokenAddress match, or (legacy rows without one)
 *  created before the current deployment existed. */
function isHistoricPaylinkRow(
  row: PaylinkTransaction,
  tuple: OxideEnvTuple,
  currentTimestampMs: number,
): boolean {
  if (row.tokenAddress) return row.tokenAddress.toLowerCase() === tuple.l2Token.toLowerCase()
  return row.timestamp < currentTimestampMs
}

export async function probeHistoricResiduals(
  deps: HistoricResidualDeps,
): Promise<HistoricResidualSummary[]> {
  const nowSec = deps.nowSec
  const currentTimestampMs = Date.parse(deps.current.timestamp)

  return Promise.all(
    deps.historic.map(async (tuple) => {
      let balance = 0n
      try {
        // Explicit-address pin — a service created without one captures the live registry slot.
        const tokenService = await TokenService.create(
          deps.wallet,
          deps.account,
          AztecAddress.fromStringUnsafe(tuple.l2Token),
        )
        balance = await tokenService.getBalance(deps.account)
      } catch (error) {
        // Under-report; next boot retries.
        console.warn(`[migration] balance probe failed for historic token ${tuple.l2Token}:`, error)
      }

      let sweptDeposits = 0
      let inTransitDeposits = 0
      let incomplete = false
      if (deps.sipaDiscovery) {
        try {
          const sources = await deps.sipaDiscovery.sources(tuple)
          if (sources.length > 0) {
            const scan = await scanRefundableDeposits({
              sources,
              l1Reads: createDepositExitL1Reads(
                deps.publicClient,
                tuple.portal as Address,
                await deps.sipaDiscovery.scanRange(tuple),
              ),
              readErrorsThrow: true,
              readSipaBalance: (address: string) => deps.sipaDiscovery!.balance(tuple, address),
              isClaimed: (deposit: RefundableDeposit<{ toString(): string }>) =>
                deps.sipaDiscovery!.claimed(tuple, deposit),
            })
            sweptDeposits = scan.refundable.length
            inTransitDeposits = scan.inTransit.length
          }
        } catch (error) {
          incomplete = true
          console.warn(`[migration] SIPA scan failed for historic portal ${tuple.portal}:`, error)
        }
      }

      let paylinkEscrows = 0
      const lockedPaylinks: PaylinkTransaction[] = []
      const paylinkCandidates: PaylinkTransaction[] = []
      try {
        for (const row of deps.rows) {
          const p = row as PaylinkTransaction
          if (!isHistoricPaylinkRow(p, tuple, currentTimestampMs)) continue
          // Still escrowed: every rejection except the window itself means the escrow is gone.
          const atZero = paylinkRefundEligibility(p, 0)
          if (!atZero.eligible && atZero.reason !== "within-window") continue
          paylinkCandidates.push(p)
          if (nowSec === null) continue
          const { eligible, reason } = paylinkRefundEligibility(p, nowSec)
          if (eligible) paylinkEscrows++
          else if (reason === "within-window") lockedPaylinks.push(p)
        }
      } catch {
        // Under-report; next boot retries.
      }

      console.info(
        `[migration] probe ${tuple.l2Token.slice(
          0,
          10,
        )}: balance=${balance} swept=${sweptDeposits} inTransit=${inTransitDeposits} escrows=${paylinkEscrows} locked=${
          lockedPaylinks.length
        }`,
      )
      return {
        tuple,
        balance,
        sweptDeposits,
        inTransitDeposits,
        paylinkEscrows,
        lockedPaylinks,
        paylinkCandidates,
        incomplete,
        hasResiduals:
          balance > 0n ||
          sweptDeposits > 0 ||
          inTransitDeposits > 0 ||
          paylinkEscrows > 0 ||
          paylinkCandidates.length > 0,
      }
    }),
  )
}
