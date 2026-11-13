import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AcrossChain } from "@obsidion/config-client"
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
  type BridgeOutBroadcaster,
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
import {
  readAcrossExit,
  requireAcrossEscrowFactory,
  type BridgeOutPriced,
} from "./bridgeOutQuote"
import { accountKitOf, type Chain } from "../../session/session"

/** What a bridge-out pays and lands, chosen and priced before the burn. */
export interface BridgeOutChoice {
  chain: AcrossChain
  token: BridgeOutToken
  quote: BridgeOutPriced
}

type BridgeLegArgs = BridgeOutChoice & {
  from: AztecAddress
  amount: bigint
  recipient: Address
  proverTip?: bigint
  recoverer: SwapRecoverer
}

interface BridgeLeg {
  record: Partial<WithdrawalRecord>
  escrow: NonNullable<WithdrawalOptions["escrow"]>
}

/**
 * The bridge leg of a burn from `tuple`: the escrow the burn pays, what its record keeps, and the
 * sdk options that broadcast the escrow's run. `recoverer` takes back what Across refunds.
 */
export async function planBridgeLeg(
  { config, chain }: PageFacts,
  deps: Pick<Chain, "wallet" | "contractService">,
  tuple: OxideEnvTuple,
  args: BridgeLegArgs,
): Promise<BridgeLeg> {
  const l2Broadcaster = requireTupleField(tuple, "l2Broadcaster")
  const [executor, broadcaster, exit] = await Promise.all([
    withdrawalExecutor(chain, tuple),
    registerBroadcaster(deps.wallet, deps.contractService, l2Broadcaster),
    readAcrossExit({ config, chain }),
  ])
  return bridgeLeg(tuple, {
    ...args,
    broadcaster,
    factory: requireAcrossEscrowFactory(exit, tuple),
    executor: executor.address,
  })
}

/**
 * {@link planBridgeLeg} once its reads are in. The escrow and the record take the executor fee the
 * quote was priced on, so the escrow's inputs agree with the recorded `minReceived`.
 */
export function bridgeLeg(
  tuple: OxideEnvTuple,
  args: BridgeLegArgs & { broadcaster: BridgeOutBroadcaster; factory: Address; executor: Address },
): BridgeLeg {
  const route = acrossBridgeRoute(args.token, args.chain.chainId)
  if (!route) throw new WalletError("invariant", "Across has no route there")
  const { quote } = args
  const nonce = Fr.random().toString() as Hex
  const built = buildAcrossBridgeOut({
    broadcaster: args.broadcaster,
    l2Broadcaster: requireTupleField(tuple, "l2Broadcaster"),
    factory: args.factory,
    dai: requireTupleField(tuple, "token") as Address,
    portal: requireTupleField(tuple, "portal") as Address,
    executor: { address: args.executor, fee: quote.withdrawalFee },
    from: args.from,
    amount: args.amount,
    withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
    proverTip: args.proverTip ?? 0n,
    token: args.token,
    chainId: args.chain.chainId,
    recipient: args.recipient,
    acrossFee: quote.acrossFee,
    minReceived: quote.minReceived,
    relayerTip: quote.tip.relayerTip,
    recovery: {
      account: args.recoverer.account,
      salt: deriveSwapEscrowRecoverySalt(args.recoverer.secret, nonce),
    },
    nonce,
  })
  return {
    escrow: built.escrowOptions,
    record: {
      withdrawalFee: quote.withdrawalFee.toString(),
      swapOutput: args.token,
      swapOutputDecimals: route.acrossOutputTokenDecimals,
      swapEscrow: built.escrow,
      swapEscrowFactory: args.factory,
      bridgeOut: {
        provider: "across",
        chainId: args.chain.chainId,
        chainName: args.chain.name,
        minReceived: quote.minReceived.toString(),
        acrossFee: quote.acrossFee.toString(),
        nonce,
        recoveryCommitment: built.escrowArgs.recoveryCommitment as Hex,
        relayerTip: quote.tip.relayerTip.toString(),
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
      const ctx = await burnContext(kit, args.recipient, args.chain.chainId)
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
