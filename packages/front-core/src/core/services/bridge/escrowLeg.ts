/**
 * The escrow leg after a withdrawal's release, whatever its kind: a swap, a bridge-out or a Sky
 * move. Every escrow extends oxide's `EscrowBase`, so runs and recoveries share one shape; only
 * each factory's `Args` differ, and each kind's module owns them.
 */
import type { SkyEscrowArgs } from "@oxide/experiments/sky/sky_savings.js"
import {
  buildEscrowRecoverCall,
  type AcrossBridgeEscrowArgs,
  type BridgeOutProviderId,
  type BridgeOutToken,
  type SwapEscrowCall,
  type SwapEscrowCommitment,
} from "@obsidion/sdk"
import { isAddressEqual, type Address, type Hex } from "viem"
import { acrossEscrow } from "./acrossEscrowLeg"
import { skyEscrow } from "./skyEscrowLeg"
import { swapEscrow } from "./swapEscrowLeg"
import type { WithdrawalRecord } from "./types"

interface EscrowLegBase {
  factory: Address
  escrow: Address
  nonce: Hex
  recoveryCommitment: Hex
  relayerTip: bigint
}

export type SwapLeg = EscrowLegBase & { kind: "swap"; args: SwapEscrowCommitment }

export type BridgeLeg = EscrowLegBase & {
  kind: "bridge"
  provider: BridgeOutProviderId
  args: AcrossBridgeEscrowArgs
  destination: { chainId: number; token: BridgeOutToken; recipient: Address; minReceived: bigint }
}

export type SkyLeg = EscrowLegBase & { kind: "sky"; args: SkyEscrowArgs }

export type EscrowLeg = SwapLeg | BridgeLeg | SkyLeg

/** One kind of escrow: what a record commits it to, and its factory's calls. */
export interface EscrowKind<L extends EscrowLeg> {
  /** The leg `record` names, its address unchecked; undefined when a value is missing. */
  leg(record: WithdrawalRecord): L | undefined
  predict(factory: Address, args: L["args"]): Address
  /** `factory.deployAndExecute(args)`. */
  execute(args: L["args"]): Hex
  /** `factory.deploy(args)`: the clone without the run. */
  deploy(args: L["args"]): Hex
  /** Who a simulated run pays its tip: an address the escrow commits to, never zero. */
  payee(leg: L): Address
}

const KINDS: {
  swap: EscrowKind<SwapLeg>
  sky: EscrowKind<SkyLeg>
  bridge: Record<BridgeOutProviderId, EscrowKind<BridgeLeg>>
} = { swap: swapEscrow, sky: skyEscrow, bridge: { across: acrossEscrow } }

function recordKind(record: WithdrawalRecord): EscrowKind<EscrowLeg> | undefined {
  const kind = record.skyMove
    ? KINDS.sky
    : record.bridgeOut
    ? KINDS.bridge[record.bridgeOut.provider]
    : record.swapOutput
    ? KINDS.swap
    : undefined
  return kind as EscrowKind<EscrowLeg> | undefined
}

function legKind<L extends EscrowLeg>(leg: L): EscrowKind<L> {
  const kind = leg.kind === "bridge" ? KINDS.bridge[leg.provider] : KINDS[leg.kind]
  return kind as unknown as EscrowKind<L>
}

/**
 * The escrow leg `record`'s burn pays. Undefined for a direct withdrawal, for a record missing a
 * committed value, and for one whose values derive another address than the escrow it names, so a
 * corrupt record never signs anything.
 */
export function escrowLeg(record: WithdrawalRecord): EscrowLeg | undefined {
  const kind = recordKind(record)
  const leg = kind?.leg(record)
  return leg && isAddressEqual(kind!.predict(leg.factory, leg.args), leg.escrow) ? leg : undefined
}

/** `factory.deployAndExecute(args)`: run the escrow and keep the tip. Any EOA can send it. */
export function escrowRunCall(leg: EscrowLeg): SwapEscrowCall {
  return { to: leg.factory, data: legKind(leg).execute(leg.args) }
}

/** Who {@link escrowRunCall} is simulated from. */
export function escrowRunPayee(leg: EscrowLeg): Address {
  return legKind(leg).payee(leg)
}

/** A bridge-out whose escrow ran: what the escrow holds is its bridge's refund. */
export const isBridgeRefund = (record: Pick<WithdrawalRecord, "bridgeOut" | "swapExecuteTxHash">) =>
  !!record.bridgeOut && !!record.swapExecuteTxHash

/** The token a stuck escrow holds: the released DAI, or a bridge's refund in its input token. */
export function escrowHeldToken(
  leg: EscrowLeg,
  record: Pick<WithdrawalRecord, "bridgeOut" | "swapExecuteTxHash">,
  dai: Address,
): Address {
  return leg.kind === "bridge" && isBridgeRefund(record) ? leg.args.acrossInputToken : dai
}

/** `recoverERC20` of the leg's escrow, deploying the clone first when it has no code. */
export function escrowRecoverCall(
  leg: EscrowLeg,
  params: Omit<Parameters<typeof buildEscrowRecoverCall>[0], "escrow" | "deploy">,
): SwapEscrowCall {
  return buildEscrowRecoverCall({
    ...params,
    escrow: leg.escrow,
    deploy: { to: leg.factory, data: legKind(leg).deploy(leg.args) },
  })
}
