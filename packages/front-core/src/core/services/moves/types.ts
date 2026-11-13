import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { OxideBridge } from "@obsidion/core/oxide"
import type { SwapRecovery, WithdrawalOptions, WithdrawArgs } from "@obsidion/sdk"
import type { Address, Hash, Hex } from "viem"
import type { ReadonlyStore } from "../../../engine/store"
import type {
  MoveDeposit,
  MoveDirection,
  MoveLimits,
  MoveQuote,
  MoveRail,
  MoveRailFields,
  MoveRecord,
} from "../../../engine/moveTransition"

/** What a port reads a holding's route from. */
export interface RouteHolding {
  id: string
  rail: MoveRail
  /** The bridge moves go to and from. */
  base: OxideBridge
  /** The bridge of the token the holding holds. */
  held: OxideBridge
}

/** What `Rail`'s moves carry for their rail: a Sky escrow move's escrow. */
export type RailFields<Rail extends MoveRail> = Extract<MoveRailFields, { rail: Rail }>

/** A move of `Rail`. */
export type RailMove<Rail extends MoveRail> = RailFields<Rail> & Omit<MoveRecord, "rail" | "escrow">

/** What every route carries: the L1 portal and token of the two bridges a move runs between. */
export interface MoveRoute {
  base: { portal: Address; token: Address }
  held: { portal: Address; token: Address }
}

/** What a move's burn is built with, besides its quote. */
export interface MoveArgs {
  direction: MoveDirection
  /** What leaves the source. */
  amount: bigint
  /** The account that burns. */
  from: AztecAddress
  nonce: Hex
  /** What the route's portal deposit commits to. */
  recipientCommitment: Hex
  /** What the move's recovery opens to. */
  recovery: SwapRecovery
}

/** A move's burn as its port built it: where it pays and what rides it. */
export type BuiltBurn<Rail extends MoveRail = MoveRail> = RailFields<Rail> & {
  /** The L1 address the burn pays: a Sky escrow move's escrow, or a vault move's executor. */
  target: Address
  withdrawal: Pick<WithdrawalOptions, "escrow" | "multiStep">
  /** What the burn pays its release's relayer: the tip its withdrawal record shows. */
  releaseTip: bigint
}

/** L1 blocks `from` to `to`, both included. */
export interface BlockRange {
  from: bigint
  to: bigint
}

/** The route's portal deposit, where L1 shows it. */
export interface FoundDeposit {
  deposit: MoveDeposit
  txHash: Hash
  blockNumber: bigint
}

/**
 * `ran`: the route paid the destination portal, and the vault took in, moving in, or paid out,
 * moving out, `assets` of its asset. `recovered`: `token` went back to `to`.
 */
export type MoveOutcome =
  | { kind: "ran"; assets: bigint }
  | { kind: "recovered"; txHash: Hash; to: Address; token: Address; blockNumber: bigint }

export interface L1Call {
  to: Address
  data: Hex
}

/** What a move's recovery opens to, and the recovery account's signature over a digest. */
export interface RecoveryKeys extends SwapRecovery {
  sign: (digest: Hex) => Promise<Hex>
}

/** One of the account's burns, read back from its recovery events: what a replay rebuilds. */
export type MoveBurn<Rail extends MoveRail = MoveRail> = RailFields<Rail> & {
  /** The burn's L2 tx. */
  txHash: string
  timestampMs: number
  withdrawalId: Hex
  amount: bigint
  nonce: Hex
  recipientCommitment: Hex
}

/**
 * The L1 side of one rail's moves, for holdings of type `H`. A port's route and quote types are its
 * own; the engine reads only what `MoveRoute` and `MoveQuote` declare. A `signal` aborts a read in
 * flight.
 */
export interface MoveRoutes<
  H extends RouteHolding = RouteHolding,
  R extends MoveRoute = MoveRoute,
  Q extends MoveQuote = MoveQuote,
> {
  readonly rail: H["rail"]
  read: (holding: H) => Promise<R>
  quote: (route: R, direction: MoveDirection, amount: bigint) => Promise<Q>
  /** The burn `quote` priced. */
  build: (route: R, args: MoveArgs, quote: Q) => BuiltBurn<H["rail"]>
  /** What the route's portal deposit commits to: it opens to `secret` and `recipient`. */
  commitment: (secret: Fr, recipient: AztecAddress) => Promise<Hex>
  /** The deposit to `recipientCommitment` on `direction`'s destination portal in `range`. */
  findDeposit: (
    route: R,
    direction: MoveDirection,
    recipientCommitment: Hex,
    range: BlockRange,
    signal?: AbortSignal,
  ) => Promise<FoundDeposit | undefined>
  /**
   * Whether `direction`'s source portal spent the withdrawal. The record's `released` phase follows
   * `outcome`, not this read.
   */
  withdrawalSpent: (route: R, direction: MoveDirection, withdrawalId: Hex) => Promise<boolean>
  /** `direction`'s source portal's release of the withdrawal in `range`, and its block's time. */
  release: (
    route: R,
    direction: MoveDirection,
    withdrawalId: Hex,
    range: BlockRange,
  ) => Promise<{ txHash: Hash; at: number } | undefined>
  /**
   * What became of the released funds, from `range`'s chain events; undefined while they wait. A
   * run wins over a recovery in the same range, and a recovery counts only in the token the rail
   * returns for the move's direction. The caller keeps the move's cursor, one bounded range a pass.
   */
  outcome: (
    route: R,
    move: RailFields<H["rail"]> &
      Pick<MoveRecord, "direction" | "recipientCommitment"> & { withdrawalId: Hex },
    range: BlockRange,
    signal?: AbortSignal,
  ) => Promise<MoveOutcome | undefined>
  /** Whether `burn` is one of `route`'s moves. */
  owns: (route: R, burn: MoveBurn) => burn is MoveBurn<H["rail"]>
  /**
   * The call that sends a move's funds back to `to` before its route runs, on rails that can.
   * `release` reads the burn's release arguments from L2, for a rail whose recovery releases it.
   */
  recover?: (
    route: R,
    move: RailMove<H["rail"]>,
    keys: RecoveryKeys,
    to: Address,
    release: (executor: Address, tipRecipient: Address) => Promise<WithdrawArgs>,
  ) => Promise<L1Call>
  /**
   * The call that runs a move's route as its relayer would, once its funds wait at the route's L1
   * target, on rails whose route anyone can run. Refuses with `move.escrowRan` once nothing waits.
   */
  run?: (route: R, move: RailMove<H["rail"]>, keys: SwapRecovery) => Promise<L1Call>
  limits: (route: R) => Promise<MoveLimits>
  /** What `amount` of the held token redeems for now. */
  assetsOf: (route: R, amount: bigint) => Promise<bigint>
  token: (address: Address) => Promise<{ symbol: string; decimals: number }>
  /** The L1 head, where a move's deposit search starts. */
  head: () => Promise<bigint>
  /** The first L1 block at or after `timeMs`; the head when L1 has not reached it. */
  blockAt: (timeMs: number) => Promise<bigint>
}

export interface BurnRequest
  extends Pick<BuiltBurn, "target" | "withdrawal" | "releaseTip">,
    Pick<MoveRecord, "holdingId" | "nonce"> {
  direction: MoveDirection
  /** Tags the sdk's progress events, so the submission tracker sees the hash. */
  operationId: string
  /** The key the burn's withdrawal record is saved under: the move's `withdrawalLocalId`. */
  withdrawalLocalId: string
  source: OxideBridge
  amount: bigint
}

/** The burn's L2 receipt. */
export interface BurnResult {
  txHash: string
  blockNumber: number
}

export interface DepositClaim extends MoveDeposit {
  secret: Fr
}

/**
 * The account's L2 side, which each front supplies. `Watch` is what the front's caller follows an
 * L1 send by, such as its progress: the front's own, which the engine hands over unread.
 */
export interface MovesAccount<Watch = never> {
  address: AztecAddress
  /** The L1 account a move's recovery opens to. */
  recoveryAccount: Address
  /** Signs as `recoveryAccount` and sends a recovery's call. */
  recovery: {
    sign: (digest: Hex) => Promise<Hex>
    /**
     * Sends a recovery of funds to `to`, which the signer is shown; resolves to the tx hash once
     * mined; throws on a revert.
     */
    send: (call: L1Call, to: Address, watch?: Watch) => Promise<Hash>
  }
  /** Sends the call that runs a move's route at `target`; resolves once mined, throws on a revert. */
  runRoute: (call: L1Call, target: Address, watch?: Watch) => Promise<Hash>
  /**
   * A move's deposit secret and recovery salt from the master secret and nonce, as the rail's
   * derivation defines them.
   */
  salts: (nonce: Hex, rail: MoveRail) => { recipient: Fr; recovery: Fr }
  /** The account's private balance on `bridge`. */
  balance: (bridge: OxideBridge) => Promise<bigint>
  /**
   * Signs, proves and sends the burn, writing its withdrawal record before the node takes it;
   * resolves on its L2 receipt. An abort of `signal` stops a burn that is not yet proving, and
   * leaves no record of it.
   */
  burn: (request: BurnRequest, signal?: AbortSignal) => Promise<BurnResult>
  /** Whether the L1→L2 message `messageKey` is on L2, where a claim of its deposit reads it. */
  messageReady: (messageKey: Hex) => Promise<boolean>
  /**
   * Claims the deposit; resolves too when it was claimed, and throws while its L1→L2 message is
   * not on L2. An abort of `signal` stops it before it claims.
   */
  claim: (bridge: OxideBridge, deposit: DepositClaim, signal?: AbortSignal) => Promise<void>
  /**
   * The account's burns from `bridge` that are `rail`'s moves. Omits a burn it could not read yet,
   * and says so in `unread`; the next replay pass reads it.
   */
  moveBurns: (
    bridge: OxideBridge,
    rail: MoveRail,
  ) => Promise<{ burns: MoveBurn[]; unread: boolean }>
  /**
   * The release arguments of the burn `txHash` from `source` through `executor`, its relayer tip
   * paid to `tipRecipient`. Refuses with `move.noRecovery` until the burn's epoch is proven on L1.
   */
  releaseArgs: (
    burn: { txHash: string; source: OxideBridge; executor: Address },
    tipRecipient: Address,
  ) => Promise<WithdrawArgs>
}

/** One rail's port and the holdings it serves, in the port's own types. */
export interface RailPorts<
  H extends RouteHolding = RouteHolding,
  R extends MoveRoute = MoveRoute,
  Q extends MoveQuote = MoveQuote,
> {
  routes: MoveRoutes<H, R, Q>
  holdings: readonly H[]
  /** The ids of the holdings the wallet lists: only they take a move in. */
  listed: ReadonlySet<string>
}

/**
 * A rail's port bound to its holdings. A port's types are its own, so ports of different rails
 * share no type: `use` receives each as it declares them.
 */
export type BoundRail = <T>(
  use: <H extends RouteHolding, R extends MoveRoute, Q extends MoveQuote>(
    rail: RailPorts<H, R, Q>,
  ) => T,
) => T

export function bindRail<H extends RouteHolding, R extends MoveRoute, Q extends MoveQuote>(
  rail: RailPorts<H, R, Q>,
): BoundRail {
  return (use) => use(rail)
}

/** What moves run through: each bound rail, and the account. */
export interface MovePorts<Watch = never> {
  /** The rails bound now; a pass reads them as it starts. */
  rails: ReadonlyStore<readonly BoundRail[]>
  account: MovesAccount<Watch>
}
