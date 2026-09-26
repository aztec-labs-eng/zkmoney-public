/**
 * Shared types for the on-device bridge-flow stores.
 *
 * Withdrawal records model an L2→L1 exit the client only *observes*: the burn
 * happens on L2, finalization happens on L1 via oxide's relayer, and the client
 * watches chain state to advance the record. This module hosts the withdrawal
 * record shape plus the small types the activity aggregator uses to unify
 * withdrawals with SIPA deposits at read time.
 */

import type { WithdrawalPhase } from "@obsidion/core/types"
import type { QueueStatus, SwapOnWithdrawOutput } from "@obsidion/sdk"
import type { Address, Hash, Hex } from "viem"

/**
 * Why a withdrawal terminalized in `failed` phase, on records written by an
 * earlier version of the wallet. Nothing writes this any more — a user could
 * once stop a withdrawal before its burn was signed, and the rows that captured
 * it are still in people's browsers. Readers keep honouring it so those
 * withdrawals stay distinguishable from an ordinary pre-mine failure.
 */
export type WithdrawalCancelReason = "before-signing"

// Defined in the DTO leaf so sdk services share the vocabulary.
export type { WithdrawalPhase }

/**
 * Whether the destination is a wallet the user previously proved control of by
 * depositing from it, or an L1 address they pasted manually. Drives the
 * activity-thread label precedence and the group provenance.
 */
export type WithdrawalProvenance =
  | "deposit-attested" // Recipient is a linked wallet the user proved control of by depositing from it.
  | "saved-recipient" // Recipient is an L1 address the user entered manually.

/** The oxide deployment a burn targeted. Finalization lives on THIS portal even after the live
 *  deployment rolls, so the tracker reads `$isWithdrawalSpent` here, not on the current tuple. */
export interface WithdrawalDeployment {
  portal: Hex
  l2Token: string
}

export interface WithdrawalRecord {
  /**
   * Locally-generated stable ID, assigned when the user taps Confirm, and this
   * store's persistence key. The `wdraw_*` prefix is a debug-readable
   * breadcrumb only — never consulted for routing.
   */
  localId: string

  /**
   * Op-id minted at submit so proving-progress stage events can correlate to
   * this row before the L2 tx hash is known.
   */
  operationId?: string

  /**
   * Pre-mine in-flight status mirrored from proving-progress: SIMULATING →
   * PROVING → MINING. Drives the activity-row in-flight bubble copy. Cleared
   * once the row reaches a terminal phase.
   */
  detailedStatus?: QueueStatus

  /**
   * Why a `phase === "failed"` row terminalized, on rows an earlier version
   * wrote. Nothing sets it now; a pre-mine burn throw leaves it undefined with
   * a descriptive `error`.
   */
  cancelReason?: WithdrawalCancelReason

  /** L2 burn hash, persisted at broadcast when available; receipt recovery may still be pending. */
  l2TxHash?: Hash

  /** L2 block number containing the burn tx. */
  blockNumber?: number

  /** Hash of the L2 block containing the burn tx (reorg anchor, re-writable). */
  blockHash?: string

  /** Network the record was created on (rollup L1 address). Unset only pre-boot. */
  networkId?: string

  /** Incremented on each reorg demote; stale forward writes carry an older epoch. */
  reorgEpoch?: number

  /**
   * The burn was broadcast but the pool definitively evicted it after a reorg — its effect is
   * not on chain and cannot return, so a fresh re-burn is safe (worst case one of the two
   * reverts on the shared nullifier). Gates the retry flow's re-burn path.
   */
  droppedBurn?: boolean

  /**
   * Destination L1 address (checksummed). For a swap-on-withdraw this is where the SWAP OUTPUT
   * lands; the burn itself pays `swapEscrow`.
   */
  recipient: Address

  /** Swap-on-withdraw output asset. Absent on direct withdrawals, where all `swap*` fields are unset. */
  swapOutput?: SwapOnWithdrawOutput

  /** The counterfactual SwapEscrow the burn pays into — the on-chain release recipient. */
  swapEscrow?: Address

  /**
   * Wallet randomness the escrow address commits to and the recovery salt derives from. Written
   * BEFORE the burn signs, and carried in the burn's `Withdraw` event so a rescan rebuilds it.
   */
  swapNonce?: Hex

  /**
   * `deriveRecoveryCommitment(salt, account)`: the account that may recover the escrow, hidden by a
   * salt. The recovery re-derives both and refuses to sign unless they open this commitment.
   */
  swapRecoveryCommitment?: Hex

  /**
   * The `SwapEscrowFactory` the escrow address was derived from. A redeployed factory moves every
   * CREATE2 address, so a self-run swap or recovery must target this one, not the live tuple's.
   */
  swapEscrowFactory?: Address

  /** DAI tip the escrow pays the relayer that runs the swap (bigint serialized as string). */
  swapRelayerTip?: string

  /** L1 tx of the `SwapEscrowExecuted` that paid the recipient (set at `done` on a swap). */
  swapExecuteTxHash?: Hex

  /** L1 tx of the `recoverERC20` that moved the escrow's DAI to `recoveryTarget`. */
  recoveryTxHash?: Hex

  /** Where a recovery sent the DAI. */
  recoveryTarget?: Address

  /** `OxidePortal.FPC_FUNDING_CUT` at record creation (DAI base units as string) — the portal
   *  skims it on release beside the tips. */
  fpcFundingCut?: string

  /** The prover tip the burn offered (DAI base units as string); the portal deducts it first.
   *  Absent on burns that offered none. */
  proverTip?: string

  /** Submit-time quote for the swap output, atomic units of `swapOutput` (bigint as string). An
   *  estimate, not a fill. Absent when no quote was available. */
  swapEstimatedOut?: string

  /** Decimal exponent for `swapEstimatedOut`. */
  swapOutputDecimals?: number

  /** Optional user-provided label; becomes the linked-wallet display name when set. */
  recipientAlias?: string

  /** The burn spent a paylink escrow (`claim_to_l1`), not the account balance. */
  source?: "paylink"

  /**
   * The burn funded one of this wallet's own SIPAs, not a cash-out: its registration (a ticket
   * signup), or its balance on a new deployment (a migration).
   */
  intent?: "registration" | "migration"

  /**
   * A migration's arrival fee (DAI base units as string): the new deployment's deposit fee plus its
   * funding cut, taken as the relayer sweeps the release in. With the tip and `fpcFundingCut` it
   * prices what the new balance receives.
   */
  arrivalFee?: string

  /**
   * Recreated from the burn's `Withdraw` event by a rescan (`rebuildWithdrawals`), not written at
   * Confirm: no submit-time quote, no relayer tip and no funding cut, and `startTime` is the
   * burn's block time.
   */
  rebuilt?: boolean

  /** Whether this recipient is a previously-deposited-from wallet or a user-pasted one. */
  recipientProvenance: WithdrawalProvenance

  /** Hash of the link's secret, used to match a reopened link without storing it. */
  paylinkId?: string

  /** Decimal token-unit amount string (e.g. "12.5"). */
  amount: string

  /**
   * Raw on-chain amount (bigint serialized as string) emitted by the L2 burn —
   * the gross, before the portal deducts the tips and `fpcFundingCut`. Set at
   * `l2_mined` alongside `l2TxHash`/`blockNumber`.
   */
  rawAmount?: string

  /**
   * Relayer tip the burn's user payload offered, raw token units. The plain withdrawal executor
   * pays it out of what the portal releases after the prover tip and `fpcFundingCut`. Stamped with
   * the rest of the mined burn data. Absent where the writer did not record it, which leaves the
   * amount breakdown unrenderable rather than guessed.
   */
  relayerTip?: string

  /** Token ticker for display. */
  tokenSymbol: string

  /**
   * Finalization key: `sha256(burnTxHash ‖ withdrawMessageHash)` (a 0x-hex
   * bytes32). Binds the authoritative `$isWithdrawalSpent(withdrawalId)` poll
   * to this exact record. Derived lazily by the tracker once the burn's tx
   * effect is indexed on L2 — absent on a freshly-mined record.
   */
  withdrawalId?: Hex

  /** L1 tx hash of the release (set best-effort at `done`; omitted when ambiguous). */
  l1TxHash?: Hex

  /**
   * L1 tx hash of a self-finalize the user submitted themselves. The "already submitted" marker
   * that withdraws the manual-finalize affordance; the tracker's own `isSpent` pass is still what
   * moves the record to `done`.
   */
  finalizeTxHash?: Hex

  /** Stamped at create. Unset only on records written before deployments could roll. */
  deployment?: WithdrawalDeployment

  /** Current phase (see WithdrawalPhase). */
  phase: WithdrawalPhase

  /** Error message when phase === "failed". */
  error?: string

  /** ms epoch when the user tapped Confirm. */
  startTime: number

  /** ms epoch when the record reached a terminal phase (`done`, `recovered` or `failed`). */
  endTime?: number

  /**
   * ms epoch when the record last entered its current post-mine phase
   * (`l2_mined`/`awaiting_proven`/`finalizing_l1`/`swapping`). The non-terminal `delayed`
   * presentation is DERIVED from this + a threshold, so a stall in any
   * post-mine phase surfaces as "taking longer than usual" rather than a false
   * failure. Unset pre-mine.
   */
  phaseEnteredAt?: number

  /**
   * Provider slug for the destination linked wallet (e.g. "rainbow",
   * "metamask"). Scopes counterparty identity as
   * `wallet:<provider>:<addressLower>`. Withdrawals to user-pasted addresses
   * write "unknown"; read sites default to "unknown" for legacy records.
   */
  walletProvider?: string
}

/** Phases that stop watching and stamp `endTime`. */
export const WITHDRAWAL_TERMINAL_PHASES: ReadonlySet<WithdrawalPhase> = new Set<WithdrawalPhase>([
  "done",
  "recovered",
  "failed",
])
