/**
 * The user's two exits from a Savings move's Sky escrow that was funded but nobody ran, over the
 * same injected L1 channel and recovery signing as the swap escrow's (`swapEscrowRecovery`):
 *
 *   - run it themselves: `SkyEscrowFactory.deployAndExecute(args)` deposits into the destination
 *     portal and pays them the tip; the settle pass then claims the deposit;
 *   - recover the DAI to an address they name, signed by the move's recovery account.
 */
import type { Address, Hex } from "viem"
import {
  escrowLeg,
  escrowRecoverCall,
  escrowRunCall,
  type SkyLeg,
} from "../core/services/bridge/escrowLeg"
import { SWAP_STUCK_THRESHOLD_MS } from "../core/services/bridge/withdrawalPhases"
import type { WithdrawalRecord } from "../core/services/bridge/types"
import { isSavingsMovePending, type SavingsMove } from "./savingsMoves"
import {
  requireFunded,
  signEscrowRecovery,
  type EscrowRecoverySigning,
  type SwapEscrowExitDeps,
} from "./swapEscrowRecovery"

const RAN = "This move's escrow has already run. Savings will update shortly."

/** The Sky escrow a move's burn paid, as the burn committed to it; undefined for any other burn. */
export function skyEscrowLeg(burn: WithdrawalRecord): SkyLeg | undefined {
  const leg = escrowLeg(burn)
  return leg?.kind === "sky" ? leg : undefined
}

/**
 * Whether the move's release has paid its escrow and nobody has run it since: the burn is released,
 * no deposit has been found, and it has waited longer than a relayer takes.
 */
export function canSelfRunSkyEscrow(
  move: SavingsMove,
  burn: WithdrawalRecord,
  now: number = Date.now(),
): boolean {
  return (
    burn.phase === "done" &&
    isSavingsMovePending(move) &&
    !move.deposit &&
    skyEscrowLeg(burn) !== undefined &&
    now - (burn.endTime ?? burn.phaseEnteredAt ?? burn.startTime) >= SWAP_STUCK_THRESHOLD_MS
  )
}

export interface SkyEscrowExitDeps {
  leg: SkyLeg
  dai: Address
  channel: SwapEscrowExitDeps["channel"]
  reader: SwapEscrowExitDeps["reader"]
}

async function send(deps: SkyEscrowExitDeps, call: { to: Address; data: Hex }, what: string) {
  const hash = await deps.channel.sendTransaction(call.to, call.data)
  if (!(await deps.channel.waitForReceipt(hash)))
    throw new Error(`${what} transaction ${hash} reverted`)
  return hash
}

/** Run the escrow as the relayer would: its deposit lands and the tip comes back to the sender. */
export async function runSkyEscrow(deps: SkyEscrowExitDeps): Promise<Hex> {
  await requireFunded(deps, deps.leg.escrow, deps.dai, RAN)
  return send(deps, escrowRunCall(deps.leg), "escrow run")
}

/** Send the escrow's DAI to `to`, signed by the move's recovery account. */
export async function runSkyEscrowRecovery(
  deps: SkyEscrowExitDeps & Omit<EscrowRecoverySigning, "reader" | "channel" | "target">,
  to: Address,
): Promise<Hex> {
  const { leg } = deps
  const signed = await signEscrowRecovery(
    { ...deps, target: to },
    leg.escrow,
    leg.recoveryCommitment,
    deps.dai,
    { owner: "move", ran: RAN },
  )
  const call = escrowRecoverCall(leg, {
    deployed: await deps.reader.isDeployed(leg.escrow),
    recovery: deps.recovery,
    target: to,
    token: deps.dai,
    ...signed,
  })
  return send(deps, call, "recovery")
}
