import type { Fr } from "@aztec/foundation/curves/bn254"
import { EthAddress } from "@aztec/foundation/eth-address"
import {
  OxidePortalAbi,
  SwapEscrowFactoryAbi,
  SwapRoute,
  encodeEscrowRecoverERC20,
  encodeSwapEscrowDeploy,
  predictSwapEscrowAddressLocally,
  type SwapEscrowArgs,
} from "@oxide/l1-contracts"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import { encodeFunctionData, multicall3Abi } from "viem"
import type { Address, Hex, PublicClient } from "viem"
import type { SwapOnWithdrawOutput } from "@obsidion/core/types"
import { MULTICALL3_ADDRESS } from "../services/sipaClaim.js"

/** The escrow's committed values, re-exported so consumers name the vendored type directly. */
export type { SwapEscrowArgs } from "@oxide/l1-contracts"
export { SWAP_ON_WITHDRAW_OUTPUTS } from "@obsidion/core/constants"
export type { SwapOnWithdrawOutput } from "@obsidion/core/types"

/**
 * A swap-on-withdraw, planned before the burn: the withdrawal pays a counterfactual `SwapEscrow`
 * whose CREATE2 address commits to `(route, recipient, recoveryCommitment, relayerTip, nonce)`. The
 * burn and the broadcast that tells relayers to run the swap are built from `escrowArgs` by
 * `planWithdrawal`, through oxide-client's `buildSwapOnWithdraw`, and ride one L2 tx.
 */
export interface SwapOnWithdrawPlan {
  /** The counterfactual escrow the withdrawal must burn to. */
  escrow: Address
  /** The values the escrow address commits to. Persist them with the withdrawal record: they
   *  rebuild the factory `deployAndExecute` call if the broadcast ever has to be re-sent by hand
   *  (relayers only retain its calldata for the submitted→finalized window). */
  escrowArgs: SwapEscrowArgs
  /** `SwapEscrowFactory.deployAndExecute(escrowArgs)` calldata — the broadcast payload. */
  deployCalldata: Hex
  recovery: SwapRecovery
}

/**
 * Who can take back DAI the swap route cannot deliver: `account` signs `recoverERC20` through
 * ERC-1271, and `salt` hides it in the escrow's `recoveryCommitment`.
 */
export interface SwapRecovery {
  account: Address
  salt: Fr
}

const ROUTE_BY_OUTPUT: Record<SwapOnWithdrawOutput, SwapRoute> = {
  USDC: SwapRoute.USDC,
  USDT: SwapRoute.USDT,
  ETH: SwapRoute.ETH,
}

export function swapRouteForOutput(output: SwapOnWithdrawOutput): SwapRoute {
  return ROUTE_BY_OUTPUT[output]
}

/** Inverse of `swapRouteForOutput`; undefined for a route id no output maps to. */
export function swapOutputForRoute(route: number): SwapOnWithdrawOutput | undefined {
  return (Object.keys(ROUTE_BY_OUTPUT) as SwapOnWithdrawOutput[]).find(
    (output) => ROUTE_BY_OUTPUT[output] === route,
  )
}

/** Everything the portal, the executor and the escrow take out of a burn before the swap runs. */
export interface SwapDeductions {
  /** The relayer tip the plain withdrawal executor pays out of the burn. */
  withdrawalRelayerTip: bigint
  proverTip: bigint
  /**
   * `OxidePortal.FPC_FUNDING_CUT` — skimmed to `FPC_FUNDER` on release, so the escrow never sees
   * it. Read it off the portal (`readFpcFundingCut`); the value is capped at the net amount and
   * zeroed once the portal is frozen, so using it uncapped only ever understates the output.
   */
  fpcFundingCut: bigint
  /** DAI the escrow pays whoever completes the swap. */
  relayerTip: bigint
}

/**
 * What the escrow actually swaps: the burn minus every deduction ahead of it. The portal takes the
 * prover tip and the FPC cut, the executor pays the withdrawal relayer tip, then the escrow holds
 * back its own relayer tip, so this — not the typed amount — is the quote's exact input and the
 * amount the route must be able to fill.
 */
export function swapInputAmount(amount: bigint, deductions: SwapDeductions): bigint {
  return (
    amount -
    deductions.withdrawalRelayerTip -
    deductions.proverTip -
    deductions.fpcFundingCut -
    deductions.relayerTip
  )
}

export function planSwapOnWithdraw(args: {
  swapEscrowFactory: Address
  output: SwapOnWithdrawOutput
  /** Final L1 recipient of the swap output (must accept ETH on the ETH route). */
  l1Recipient: Address
  recovery: SwapRecovery
  /** The gross burn amount, raw token units. */
  amount: bigint
  withdrawalRelayerTip: bigint
  proverTip: bigint
  fpcFundingCut: bigint
  /** DAI the escrow pays whoever completes the swap. */
  relayerTip: bigint
  /**
   * Per-withdrawal value the escrow address commits to; the caller allocates it because the
   * recovery salt may be derived from it before the plan exists.
   */
  nonce: Hex
}): SwapOnWithdrawPlan {
  // The factory executes only once the escrow balance EXCEEDS the tip, so a swap input at or below
  // zero leaves the operation deferring forever.
  const swapInput = swapInputAmount(args.amount, args)
  if (swapInput <= 0n) {
    throw new Error(
      `planSwapOnWithdraw: nothing left to swap — amount ${args.amount} minus withdrawalRelayerTip ` +
        `${args.withdrawalRelayerTip}, proverTip ${args.proverTip}, fpcFundingCut ${args.fpcFundingCut} ` +
        `and relayerTip ${args.relayerTip} leaves ${swapInput}`,
    )
  }
  // No key signs for the zero address, so the escrow could never be recovered.
  if (BigInt(args.recovery.account) === 0n) {
    throw new Error("planSwapOnWithdraw: the recovery account must be nonzero")
  }
  const escrowArgs: SwapEscrowArgs = {
    route: swapRouteForOutput(args.output),
    recipient: args.l1Recipient,
    recoveryCommitment: deriveRecoveryCommitment(
      args.recovery.salt,
      EthAddress.fromString(args.recovery.account),
    ).toString() as Hex,
    relayerTip: args.relayerTip,
    nonce: args.nonce,
  }
  return {
    escrow: predictSwapEscrowAddressLocally(args.swapEscrowFactory, escrowArgs),
    escrowArgs,
    deployCalldata: encodeSwapEscrowDeploy(escrowArgs),
    recovery: args.recovery,
  }
}

/** An L1 transaction target + calldata for the user's own channel to submit. */
export interface SwapEscrowCall {
  to: Address
  data: Hex
}

/** `SwapEscrowFactory.deployAndExecute(args)`: run the swap and keep the tip — the permissionless self-execution path. */
export function buildSwapEscrowExecuteCall(factory: Address, args: SwapEscrowArgs): SwapEscrowCall {
  return { to: factory, data: encodeSwapEscrowDeploy(args) }
}

/**
 * `SwapEscrow.recoverERC20`, the escape hatch for DAI the committed route cannot deliver: the
 * recovery account's ERC-1271 signature over `escrowERC20RecoveryDigest`, plus the salt and
 * account that open the escrow's `recoveryCommitment`. A reverting `deployAndExecute` unwinds the
 * clone, so an escrow whose swap never ran has no code: the deploy-only `deploy` leg and the
 * recovery then ride one Multicall3 `aggregate3`, all-or-nothing, the way {@link buildSipaSweepCall}
 * deploys and sweeps a SIPA. Any EOA can submit.
 */
export function buildSwapEscrowRecoverCall(params: {
  /** Whether the escrow already has code (`getCode` non-empty). */
  deployed: boolean
  factory: Address
  escrow: Address
  args: SwapEscrowArgs
  recovery: SwapRecovery
  signature: Hex
  target: Address
  token: Address
  nonce: Hex
  /** Unix seconds after which the escrow refuses the signature. */
  deadline: bigint
  multicall3?: Address
}): SwapEscrowCall {
  const recoverData = encodeEscrowRecoverERC20({
    recoverySalt: params.recovery.salt.toString() as Hex,
    account: params.recovery.account,
    signature: params.signature,
    target: params.target,
    token: params.token,
    nonce: params.nonce,
    deadline: params.deadline,
  })
  if (params.deployed) {
    return { to: params.escrow, data: recoverData }
  }
  const calls = [
    {
      target: params.factory,
      allowFailure: false,
      callData: encodeFunctionData({
        abi: SwapEscrowFactoryAbi,
        functionName: "deploy",
        args: [params.args],
      }),
    },
    { target: params.escrow, allowFailure: false, callData: recoverData },
  ]
  return {
    to: params.multicall3 ?? MULTICALL3_ADDRESS,
    data: encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] }),
  }
}

/**
 * The portal's FPC funding cut, one of the deductions a swap quote has to net out. An immutable, so
 * this is a one-time read per deployment.
 */
export async function readFpcFundingCut(
  publicClient: PublicClient,
  portal: Address,
): Promise<bigint> {
  return (await publicClient.readContract({
    address: portal,
    abi: OxidePortalAbi,
    functionName: "FPC_FUNDING_CUT",
  })) as bigint
}
