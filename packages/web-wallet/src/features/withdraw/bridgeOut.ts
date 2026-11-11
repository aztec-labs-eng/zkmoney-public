import { Fr } from "@aztec-labs/aztec.js/fields"
import type { ConfigBridgeChain } from "@obsidion/config-client"
import { DEFAULT_DECIMALS, WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  WalletError,
  deriveSwapEscrowRecoverySalt,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import {
  acrossBridgeRoute,
  buildAcrossBridgeOut,
  nextOperationId,
  registerBroadcaster,
  type BridgeOutQuote,
  type BridgeOutToken,
  type WithdrawalOptions,
} from "@obsidion/sdk"
import { formatUnits, type Address, type Hex } from "viem"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { requireTupleField } from "../../config/oxideTuple"
import { usdBalance } from "../../ui/format"
import type { PageFacts } from "../../session/pageChain"
import { assertWithinWithdrawalLimit } from "../limits/withdrawalLimit"
import { runOperation } from "../operations/operations"
import {
  burnContext,
  runSponsoredBurn,
  sessionSwapRecoverer,
  type SwapRecoverer,
  type WithdrawDeps,
  type WithdrawStage,
} from "./withdrawGateway"
import { withdrawalExecutor } from "./withdrawalFee"
import { requireAcrossEscrowFactory } from "./bridgeOutQuote"
import { accountKitOf, type Chain } from "../../session/session"

/** What a bridge-out pays and lands, chosen and priced before the burn. */
export interface BridgeOutChoice {
  chain: ConfigBridgeChain
  token: BridgeOutToken
  quote: BridgeOutQuote
}

/**
 * The bridge leg of a burn from `tuple`: the escrow the burn pays, what its record keeps, and the
 * sdk options that broadcast the escrow's run. `recoverer` takes back what Across refunds.
 */
export async function planBridgeLeg(
  { config, chain }: PageFacts,
  deps: Pick<Chain, "wallet" | "contractService">,
  tuple: OxideEnvTuple,
  args: BridgeOutChoice & {
    from: AztecAddress
    amount: bigint
    recipient: Address
    proverTip?: bigint
    recoverer: SwapRecoverer
  },
): Promise<{
  record: Partial<WithdrawalRecord>
  escrow: NonNullable<WithdrawalOptions["escrow"]>
}> {
  const route = acrossBridgeRoute(args.token, args.chain.chainId)
  if (!route) throw new WalletError("invariant", "Across has no route there")
  const factory = requireAcrossEscrowFactory(config, tuple)
  const l2Broadcaster = requireTupleField(tuple, "l2Broadcaster")
  const [executor, broadcaster] = await Promise.all([
    withdrawalExecutor(chain, tuple),
    registerBroadcaster(deps.wallet, deps.contractService, l2Broadcaster),
  ])
  const nonce = Fr.random().toString() as Hex
  const built = buildAcrossBridgeOut({
    broadcaster,
    l2Broadcaster,
    factory,
    dai: requireTupleField(tuple, "token") as Address,
    portal: requireTupleField(tuple, "portal") as Address,
    executor: { address: executor.address, fee: executor.fee },
    from: args.from,
    amount: args.amount,
    withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
    proverTip: args.proverTip ?? 0n,
    token: args.token,
    chainId: args.chain.chainId,
    recipient: args.recipient,
    acrossFee: args.quote.acrossFee,
    minReceived: args.quote.minReceived,
    relayerTip: args.quote.tip.relayerTip,
    recovery: {
      account: args.recoverer.account,
      salt: deriveSwapEscrowRecoverySalt(args.recoverer.secret, nonce),
    },
    nonce,
  })
  return {
    escrow: built.escrowOptions,
    record: {
      swapOutput: args.token,
      swapOutputDecimals: route.acrossOutputTokenDecimals,
      swapEscrow: built.escrow,
      swapEscrowFactory: factory,
      bridgeOut: {
        provider: "across",
        chainId: args.chain.chainId,
        chainName: args.chain.name,
        minReceived: args.quote.minReceived.toString(),
        acrossFee: args.quote.acrossFee.toString(),
        nonce,
        recoveryCommitment: built.escrowArgs.recoveryCommitment as Hex,
        relayerTip: args.quote.tip.relayerTip.toString(),
      },
    },
  }
}

/**
 * A withdrawal that lands on another chain: the burn pays a counterfactual Across escrow, which
 * swaps the DAI on Curve and deposits it to Across for `recipient`. The escrow's recovery salt
 * comes from this wallet's secret, so a refund can be recovered from a restored wallet.
 */
export function submitBridgeOut(
  deps: WithdrawDeps,
  args: BridgeOutChoice & {
    recipient: Address
    recipientAlias?: string
    /** The burn, in DAI base units. */
    amountAtomic: bigint
    proverTip?: bigint
  },
  onStage: (stage: WithdrawStage) => void,
): Promise<WithdrawalRecord> {
  const amount = args.amountAtomic
  const summary = `${usdBalance(formatUnits(amount, DEFAULT_DECIMALS))} to ${args.chain.name}`
  return runOperation(
    deps.session,
    { operationId: nextOperationId("withdraw"), flow: "withdraw", summary },
    async (op) => {
      onStage("building")
      const kit = { ...deps, ...(await accountKitOf(deps.session)) }
      const { page } = deps.session
      assertWithinWithdrawalLimit(amount, await page.chain.currentTxAmountCap.read())
      const ctx = await burnContext(kit, args.recipient)
      const leg = await planBridgeLeg(page, kit, ctx.tuple, {
        ...args,
        from: kit.account.getAddress(),
        amount,
        recoverer: await sessionSwapRecoverer(deps.session, ctx.tuple),
      })
      const { record } = await runSponsoredBurn(
        op,
        kit,
        ctx,
        {
          recipient: args.recipient,
          recipientAlias: args.recipientAlias,
          amount,
          record: leg.record,
          options: { escrow: leg.escrow },
          proverTip: args.proverTip,
        },
        onStage,
      )
      return record
    },
  )
}
