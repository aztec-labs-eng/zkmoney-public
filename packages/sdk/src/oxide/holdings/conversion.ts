// How a vault's asset is reached from its base's token and back. Each conversion is one module under
// `conversions/`, and the caller's map is the one registry.
import type { ConversionKind, ExecutorHolding, MultiStepExecutor } from "@obsidion/core/oxide"
import { WalletError } from "@obsidion/core/errors"
import type { Step } from "@oxide/l1-contracts/multi_step/index.js"
import { BaseError, erc20Abi, keccak256, numberToHex, slice } from "viem"
import type { PublicClient } from "viem"
import { findBalanceOfSlot, mappingSlot } from "../escrow/swapOnWithdrawSimulator.js"
import type { HoldingDeployment } from "./holdingDeployment.js"

/** Into the vault, or out of it. */
export type MoveDirection = "in" | "out"

export type ConversionClient = Pick<PublicClient, "readContract" | "getBlock" | "simulateBlocks">

/** What a conversion of an amount returns now, and the least its steps are built to accept. */
export interface ConversionQuote {
  out: bigint
  /** What the conversion takes, in the token it converts. */
  fee: bigint
  minOut: bigint
}

/** A conversion on one deployment's adapters. */
export interface BoundConversion {
  /** The steps before the terms step moving in and after it moving out; they return `minOut` or more. */
  steps(direction: MoveDirection, minOut: bigint): Step[]
  quote(direction: MoveDirection, amount: bigint): Promise<ConversionQuote>
}

/** A conversion that returns what it takes. */
export const atPar = async (
  _direction: MoveDirection,
  amount: bigint,
): Promise<ConversionQuote> => ({
  out: amount,
  fee: 0n,
  minOut: amount,
})

export interface ConversionAdapter {
  readonly kind: ConversionKind
  bind(
    client: ConversionClient,
    deployment: HoldingDeployment,
    executor: MultiStepExecutor,
  ): Promise<BoundConversion>
}

export type ConversionAdapters = Partial<Record<ConversionKind, ConversionAdapter>>

/** The map a caller resolves holdings' conversions through. */
export const conversionAdapters = (...adapters: ConversionAdapter[]): ConversionAdapters =>
  Object.fromEntries(adapters.map((adapter) => [adapter.kind, adapter]))

/** `holding`'s conversion, bound to its executor's adapters. Throws `holding.unsupported` when none. */
export async function bindConversion(
  conversions: ConversionAdapters,
  client: ConversionClient,
  holding: ExecutorHolding,
  deployment: HoldingDeployment,
): Promise<BoundConversion> {
  const adapter = conversions[holding.conversion]
  if (!adapter) {
    throw new WalletError(
      "holding.unsupported",
      `${holding.id}: conversion ${holding.conversion} has no route`,
    )
  }
  return adapter.bind(client, deployment, holding.executor)
}

/**
 * The account the simulated step pays. Anyone can fund it, so a quote reads what its balance gains.
 */
const QUOTE_RECIPIENT = slice(
  keccak256(new TextEncoder().encode("obsidion.vault-move.step-quote-recipient")),
  12,
)

/**
 * What `step` pays now for `amount` of its input, read from a simulation of its adapter holding
 * `amount`. Throws `move.routeUnread` when the step reverts.
 */
export async function quoteStep(
  client: Pick<PublicClient, "readContract" | "simulateBlocks">,
  step: Step,
  amount: bigint,
): Promise<bigint> {
  const balanceOfSlot = await findBalanceOfSlot(client, step.in)
  const held = {
    to: step.out,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [QUOTE_RECIPIENT],
  } as const
  const [block] = await client.simulateBlocks({
    blocks: [
      {
        stateOverrides: [
          {
            address: step.in,
            stateDiff: [
              {
                slot: mappingSlot(step.adapter, balanceOfSlot),
                value: numberToHex(amount, { size: 32 }),
              },
            ],
          },
        ],
        calls: [
          held,
          { to: step.adapter, data: step.encode({ amount, recipient: QUOTE_RECIPIENT }) },
          held,
        ],
      },
    ],
  })
  const [before, run, after] = block?.calls ?? []
  const failed = [before, run, after].find((call) => call?.status !== "success")
  if (failed || before?.status !== "success" || after?.status !== "success") {
    const error = failed?.status === "failure" ? failed.error : undefined
    const reason = error instanceof BaseError ? error.shortMessage : error?.message ?? "no call"
    throw new WalletError("move.routeUnread", `${step.fn} reverts: ${reason}`, { cause: error })
  }
  return (after.result as bigint) - (before.result as bigint)
}
