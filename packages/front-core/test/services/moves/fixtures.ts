// In-memory fakes of the moves' ports over one fake L1. Addresses, commitments, hashes and ids are
// stubs, never derived.
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { bridgeOfTuple, type ExecutorHolding, type OxideBridge } from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { MULTICALL3_ADDRESS, readVaultMove, type WithdrawArgs } from "@obsidion/sdk"
import { SkyEscrowFactoryAbi, SkyRoute } from "@oxide/experiments/sky/sky_savings.js"
import {
  EscrowBaseAbi,
  MultiStepExecutorAbi,
  PlainWithdrawalSubsidyAbi,
} from "@oxide/l1-contracts/artifacts.js"
import { escrowERC20RecoveryDigest } from "@oxide/l1-contracts/escrow.js"
import { multiStepRecoveryDigest } from "@oxide/l1-contracts/multi_step/index.js"
import { L1OperationCondition } from "@oxide/oxide-lib/l1_operation_calldata.js"
import {
  decodeFunctionData,
  encodeFunctionResult,
  isAddressEqual,
  multicall3Abi,
  parseGwei,
  zeroAddress,
  zeroHash,
} from "viem"
import type { Address, Hash, Hex, PublicClient, StateOverride } from "viem"
import type {
  MoveDeposit,
  MoveDirection,
  MoveLimits,
  MoveQuote,
} from "../../../src/engine/moveTransition"
import type {
  BlockRange,
  BuiltBurn,
  FoundDeposit,
  L1Call,
  MoveBurn,
  MoveOutcome,
  MoveRoute,
  MoveRoutes,
  MovesAccount,
  RecoveryKeys,
  RouteHolding,
} from "../../../src/core/services/moves/types"
import { sides, type L1Tx, type MoveL1 } from "./moveRoutesContract"
import { WalletError } from "../../../src/engine/errors"
import type { Withdrawals } from "../../../src/engine/withdrawals"

export const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address
const SUSDS = "0x00000000000000000000000000000000000000d2" as Address
/** sUSDS's asset. */
const USDS = "0x00000000000000000000000000000000000000d3" as Address
export const DAI_PORTAL = "0x1E6142c98D83c8D14b09668d90583E940A646458" as Address
export const SUSDS_PORTAL = "0x2E6142c98D83c8D14b09668d90583E940A646458" as Address
export const SKY_FACTORY = "0x00000000000000000000000000000000000000fa" as Address
/** Main's plain withdrawal executor, which a move in's burn pays. */
export const MAIN_EXECUTOR = "0x00000000000000000000000000000000000000e1" as Address
/** The Sky withdrawal executor, which a move out's burn pays. */
export const SKY_EXECUTOR = "0x00000000000000000000000000000000000000e2" as Address
/** A Sky withdrawal executor the holding no longer names, whose burns still replay. */
export const RETIRED_SKY_EXECUTOR = "0x00000000000000000000000000000000000000e4" as Address
/** A plain executor of the sUSDS portal, which no Sky route pays. */
export const STRAY_EXECUTOR = "0x00000000000000000000000000000000000000e5" as Address
export const MAIN_SUBSIDY = "0x00000000000000000000000000000000000005b1" as Address
export const SKY_SUBSIDY = "0x00000000000000000000000000000000000005b2" as Address
export const FEED = "0x000000000000000000000000000000000000feed" as Address
const OPERATION_EXECUTOR = "0x00000000000000000000000000000000000000e3" as Address
export const L2_BROADCASTER = `0x${"0b".repeat(32)}`
const CHAIN_ID = 31337
export const RECOVERY_ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address
/** What every escrow's recovery commits to. */
export const COMMITMENT = `0x00${"0c".repeat(31)}` as Hex
export const RELEASE_TIP = 2n
/** A vault of DAI, its share token, and the portal of its bridge. */
export const VAULT = "0x00000000000000000000000000000000000007a1" as Address
export const VAULT_PORTAL = "0x3E6142c98D83c8D14b09668d90583E940A646458" as Address
export const MULTI_STEP_EXECUTOR = "0x00000000000000000000000000000000000000e6" as Address
/** The escrow tip the fake prices each way. */
export const ESCROW_TIPS: Record<MoveDirection, bigint> = { in: 1n, out: 3n }
const WAD = 10n ** 18n
/** The vault's limits every fake L1 starts with. */
export const LIMITS: MoveLimits = { maxDeposit: 10n ** 24n, maxRedeem: 10n ** 24n }
const BLOCK_MS = 12_000

/** A stub of `bytes` bytes, distinct per `tag` and `n`. */
const stub = (tag: number, n: number, bytes: number): Hex =>
  `0x${tag.toString(16).padStart(2, "0")}${n.toString(16).padStart(bytes * 2 - 2, "0")}`

const bridge = (
  token: Address,
  portal: Address,
  l2Byte: string,
  fields: Partial<OxideEnvTuple> = {},
): OxideBridge =>
  bridgeOfTuple({
    ...fields,
    version: "dep-sandbox",
    gitSha: "",
    timestamp: "2026-10-14T20:24:20.754Z",
    deployedAt: "2026-10-14T20:24:20.754Z",
    portal,
    token,
    l2Token: `0x${l2Byte.repeat(32)}`,
    enclaveUrl: "https://enclave.example/rpc",
    pcr0: "",
    rollupVersion: "1",
  })

export type FakeEscrowHolding = RouteHolding & {
  rail: "skyEscrow"
  escrow: { factory: Address; withdrawalExecutor: Address }
}

/** Sky savings on the sUSDS bridge, moved to and from DAI through escrows of `SKY_FACTORY`. */
export const SKY_HOLDING: FakeEscrowHolding = {
  id: "fea-sky-sandbox",
  rail: "skyEscrow",
  base: bridge(DAI, DAI_PORTAL, "a1", {
    plainWithdrawalExecutor: MAIN_EXECUTOR,
    operationExecutor: OPERATION_EXECUTOR,
    l2Broadcaster: L2_BROADCASTER,
  }),
  held: bridge(SUSDS, SUSDS_PORTAL, "b2"),
  escrow: { factory: SKY_FACTORY, withdrawalExecutor: SKY_EXECUTOR },
}

/** A vault of DAI on the DAI bridge, moved to and from it through `MULTI_STEP_EXECUTOR`. */
export const VAULT_HOLDING: ExecutorHolding = {
  id: "fea-vault-sandbox",
  kind: "yield",
  l2Token: `0x${"c3".repeat(32)}`,
  base: SKY_HOLDING.base,
  held: bridge(VAULT, VAULT_PORTAL, "c3"),
  terms: "erc4626",
  conversion: "None",
  rail: "executor",
  executor: {
    id: "fea-multistep-sandbox",
    address: MULTI_STEP_EXECUTOR,
    adapters: {
      erc4626: "0x0000000000000000000000000000000000000ad1",
      portalDeposit: "0x0000000000000000000000000000000000000ad2",
    },
  },
}

const signature = (digest: Hex): Hex =>
  `0x${"5e".repeat(65 - (digest.length - 2) / 2)}${digest.slice(2)}`

export const RECOVERY_KEYS: RecoveryKeys = {
  salt: new Fr(4n),
  account: RECOVERY_ACCOUNT,
  sign: async (digest) => signature(digest),
}

interface Recovery {
  escrow: Address
  to: Address
  token: Address
}

/**
 * An L1 a test drives through `MoveL1`, which the fake ports read: blocks, portal deposits, spent
 * withdrawals, escrows' DAI, escrow runs and recoveries, plus the L2 node's index of tx effects. A
 * run or a recovery empties its escrow. `send` carries out a recovery (one a fake port built, or a
 * Sky escrow's `recoverERC20`, alone or after its deploy) or the factory's `deployAndExecute` of a
 * funded escrow. `client` answers a real port's reads of the same state, from contracts at the
 * fixtures' addresses.
 */
export function fakeL1(start = { number: 7n, timeMs: 1_700_000_000_000 }) {
  const blocks = [start]
  let txs = 0
  const deposits: (FoundDeposit & {
    portal: Address
    recipientCommitment: Hex
    logIndex?: number
  })[] = []
  const vaultEvents: VaultEvent[] = []
  const commitments = new Map<string, Hex>()
  const commitmentKey = (secret: Fr, recipient: AztecAddress) =>
    `${secret.toString()}:${recipient.toString()}`
  const spent: (L1Tx & { portal: Address; withdrawalId: Hex })[] = []
  const runs: (L1Tx & { escrow: Address; assets: bigint })[] = []
  const recoveries: (Recovery & L1Tx)[] = []
  const executorRecoveries: (ExecutorRecovery & L1Tx)[] = []
  /** What a release paid each escrow, by lowercase address. */
  const funds = new Map<string, bigint>()
  const built = new Map<Hex, Recovery>()
  /** The escrow each run call a fake port built empties. */
  const builtRuns = new Map<Hex, Address>()
  const escrows = new Map<Hex, Address>()
  const head = () => blocks[blocks.length - 1] ?? start
  /** A block mined, or one before the fake's first at the same pace. */
  const blockOf = (number: bigint) => {
    const found = blocks.find((b) => b.number === number)
    if (found) return found
    if (number > start.number) throw new Error(`the fake L1 has not mined block ${number}`)
    return { number, timeMs: start.timeMs - Number(start.number - number) * BLOCK_MS }
  }
  const mined = () => {
    const last = head()
    blocks.push({ number: last.number + 1n, timeMs: last.timeMs + BLOCK_MS })
    return { txHash: stub(0xee, ++txs, 32) as Hash, blockNumber: head().number }
  }
  const within = (block: bigint, range: BlockRange) => block >= range.from && block <= range.to
  const deployed = (escrow: Address) =>
    runs.some((r) => isAddressEqual(r.escrow, escrow)) ||
    recoveries.some((r) => isAddressEqual(r.escrow, escrow))
  /**
   * A Sky escrow's `recoverERC20`: direct to a deployed escrow, or after the factory's deploy in a
   * Multicall3 batch. The escrow takes only a signature over its digest, before the deadline.
   */
  function escrowRecovery(call: L1Call): Recovery {
    const direct = !isAddressEqual(call.to, MULTICALL3_ADDRESS)
    const calls = direct ? [{ target: call.to, callData: call.data }] : batch(call.data)
    const recover = calls[calls.length - 1]
    if (!recover) throw new Error("the batch makes no call")
    if (direct && !deployed(recover.target)) throw new Error("the escrow has no code")
    if (!direct) {
      const [deploy] = calls
      const deploys =
        calls.length === 2 &&
        deploy !== undefined &&
        isAddressEqual(deploy.target, SKY_FACTORY) &&
        decodeFunctionData({ abi: SkyEscrowFactoryAbi, data: deploy.callData }).functionName ===
          "deploy"
      if (!deploys) throw new Error("the batch does not deploy the escrow first")
    }
    const { functionName, args } = decodeFunctionData({
      abi: EscrowBaseAbi,
      data: recover.callData,
    })
    if (functionName !== "recoverERC20") throw new Error(`the fake L1 does not run ${functionName}`)
    const [, , signed, to, token, nonce, deadline] = args
    const chainId = BigInt(CHAIN_ID)
    const digest = escrowERC20RecoveryDigest(recover.target, chainId, to, token, nonce, deadline)
    if (signed !== signature(digest)) throw new Error("the escrow refuses the signature")
    if (deadline * 1000n < BigInt(head().timeMs)) throw new Error("the signature has expired")
    return { escrow: recover.target, to, token }
  }
  const spentOn = (portal: Address, withdrawalId: Hex) =>
    spent.some((s) => isAddressEqual(s.portal, portal) && s.withdrawalId === withdrawalId)
  /** A portal release; it reverts once the withdrawal is spent. */
  const releaseTx = (portal: Address, withdrawalId: Hex) => {
    if (spentOn(portal, withdrawalId)) throw new Error("WithdrawalAlreadyClaimed")
    const tx = mined()
    spent.push({ ...tx, portal, withdrawalId })
    return tx
  }
  /**
   * `MultiStepExecutor.recover`: it takes the recovery account's signature over its digest, before
   * the deadline, releases the withdrawal and pays all of it but the prover tip to the recipient.
   */
  function executorRecovery(call: L1Call) {
    const { functionName, args } = decodeFunctionData({
      abi: MultiStepExecutorAbi,
      data: call.data,
    })
    if (functionName !== "recover") throw new Error(`the fake L1 does not run ${functionName}`)
    const [portal, release, , account, signed, recipient, deadline] = args
    const { withdrawalId, content } = release
    const digest = multiStepRecoveryDigest({
      executor: call.to,
      chainId: BigInt(CHAIN_ID),
      withdrawalId,
      recipient,
      deadline,
    })
    if (!isAddressEqual(account, RECOVERY_ACCOUNT)) throw new Error("not the recovery account")
    if (signed !== signature(digest)) throw new Error("the executor refuses the signature")
    if (deadline * 1000n < BigInt(head().timeMs)) throw new Error("the signature has expired")
    const tx = releaseTx(portal, withdrawalId)
    const amount = content.amount - content.proverTip
    executorRecoveries.push({ ...tx, withdrawalId, recipient, amount })
    return tx
  }

  const l1 = {
    limits: { ...LIMITS },
    /** What `shares` of the held token redeem for. */
    price: { shares: WAD, assets: (WAD * 105n) / 100n },
    /** What Main's plain executor takes from each burn. */
    withdrawalFee: 1n,
    /** Who Main's plain executor pays its fee to; zero names nobody. */
    beneficiary: zeroAddress as Address,
    /** What each executor's withdrawal subsidy pays a release, by subsidy. */
    subsidies: new Map<string, bigint>([
      [MAIN_SUBSIDY.toLowerCase(), 0n],
      [SKY_SUBSIDY.toLowerCase(), 0n],
    ]),
    /** The portals `SKY_FACTORY`'s escrows deposit into. */
    factoryPortals: { dai: DAI_PORTAL, sUsds: SUSDS_PORTAL },
    /** Gas a simulated escrow run uses. */
    runGas: 300_000n,
    /** Gas a simulated executor route uses, its tx's intrinsic gas included. */
    routeGas: 400_000n,
    tokens: new Map<string, { symbol: string; decimals: number }>([
      [DAI.toLowerCase(), { symbol: "DAI", decimals: 18 }],
      [SUSDS.toLowerCase(), { symbol: "sUSDS", decimals: 18 }],
      [USDS.toLowerCase(), { symbol: "USDS", decimals: 18 }],
      [VAULT.toLowerCase(), { symbol: "vDAI", decimals: 18 }],
    ]),

    mine: async () => {
      mined()
      return head()
    },
    deposit: async (portal: Address, recipientCommitment: Hex, amount: bigint) => {
      const tx = mined()
      const deposit = {
        inboxIndex: BigInt(deposits.length),
        amount,
        messageKey: stub(0x4d, deposits.length, 32),
        at: head().timeMs,
      } satisfies MoveDeposit
      deposits.push({ ...tx, deposit, portal, recipientCommitment })
      return { ...tx, deposit }
    },
    release: async (portal: Address, withdrawalId: Hex) => releaseTx(portal, withdrawalId),
    /** `assets` stands in for the vault's figure on the run's receipt. */
    run: async (burn: BuiltBurn<"skyEscrow">, assets = 1n) => {
      const tx = mined()
      runs.push({ escrow: burn.escrow.address, ...tx, assets })
      funds.delete(burn.escrow.address.toLowerCase())
      return { ...tx, assets }
    },
    /**
     * The executor runs a vault move's route in one tx: the release of `release`'s withdrawal when
     * given, the vault's events, each of `assets`, then the destination portal's deposit of
     * `deposited`, then the vault events `trailing` names.
     */
    executorRun: async (
      direction: MoveDirection,
      recipientCommitment: Hex,
      {
        assets,
        deposited,
        trailing = [],
        release,
      }: {
        assets: bigint[]
        deposited: bigint
        trailing?: bigint[]
        release?: { portal: Address; withdrawalId: Hex }
      },
    ) => {
      const tx = release ? releaseTx(release.portal, release.withdrawalId) : mined()
      const eventName = direction === "in" ? "Deposit" : "Withdraw"
      const vaultEvent = (amount: bigint, logIndex: number) =>
        vaultEvents.push({ ...tx, eventName, assets: amount, logIndex })
      assets.forEach((amount, i) => vaultEvent(amount, i))
      const deposit = {
        inboxIndex: BigInt(deposits.length),
        amount: deposited,
        messageKey: stub(0x4d, deposits.length, 32),
        at: head().timeMs,
      } satisfies MoveDeposit
      const portal = direction === "in" ? VAULT_PORTAL : DAI_PORTAL
      deposits.push({ ...tx, deposit, portal, recipientCommitment, logIndex: assets.length })
      trailing.forEach((amount, i) => vaultEvent(amount, assets.length + 1 + i))
      return { ...tx, deposit }
    },
    fund: async (escrow: Address, amount: bigint) => {
      funds.set(escrow.toLowerCase(), amount)
      return mined()
    },
    /** Sends `call`; a run names the escrow it empties, which the fake cannot derive. */
    send: async (call: L1Call, named?: Address) => {
      if (isAddressEqual(call.to, MULTI_STEP_EXECUTOR)) return executorRecovery(call)
      const portRun = builtRuns.get(call.data)
      if (portRun || isAddressEqual(call.to, SKY_FACTORY)) {
        const escrow = portRun ?? named
        const run = portRun
          ? undefined
          : decodeFunctionData({ abi: SkyEscrowFactoryAbi, data: call.data })
        if (run && run.functionName !== "deployAndExecute")
          throw new Error(`the fake L1 does not run ${run.functionName}`)
        if (!escrow) throw new Error("the run names no escrow")
        const assets = funds.get(escrow.toLowerCase()) ?? 0n
        if (assets === 0n) throw new Error("the escrow holds no DAI")
        funds.delete(escrow.toLowerCase())
        const tx = mined()
        runs.push({ escrow, ...tx, assets })
        return tx
      }
      const recovery = built.get(call.data) ?? escrowRecovery(call)
      if (!isAddressEqual(call.to, recovery.escrow) && !isAddressEqual(call.to, MULTICALL3_ADDRESS))
        throw new Error("the call goes to neither the escrow nor Multicall3")
      const tx = mined()
      recoveries.push({ ...recovery, ...tx })
      funds.delete(recovery.escrow.toLowerCase())
      return tx
    },
    sharePrice: async () => l1.price,

    head: () => head().number,
    blockAt: (timeMs: number) => (blocks.find((b) => b.timeMs >= timeMs) ?? head()).number,
    depositIn: (portal: Address, recipientCommitment: Hex, range: BlockRange) => {
      const found = deposits.find(
        (d) =>
          isAddressEqual(d.portal, portal) &&
          d.recipientCommitment === recipientCommitment &&
          within(d.blockNumber, range),
      )
      return (
        found && { deposit: found.deposit, txHash: found.txHash, blockNumber: found.blockNumber }
      )
    },
    /** The deposit `portal` made at `inboxIndex`, and what it commits to. */
    depositAt: (portal: Address, inboxIndex: bigint) =>
      deposits.find((d) => isAddressEqual(d.portal, portal) && d.deposit.inboxIndex === inboxIndex),
    /** Tx hashes whose effects the L2 node has not indexed. */
    unread: new Set<string>(),
    /** Tx hashes of burns whose epoch is not proven on L1, so they have no release arguments. */
    unproven: new Set<string>(),
    /** Message keys of deposits whose L1→L2 message is not on L2 yet. */
    inTransit: new Set<string>(),
    /** The stub `commitment` gave for a secret and recipient, if it gave one. */
    knownCommitment: (secret: Fr, recipient: AztecAddress) =>
      commitments.get(commitmentKey(secret, recipient)),
    /** One stub per secret and recipient. */
    commitment: (secret: Fr, recipient: AztecAddress) => {
      const key = commitmentKey(secret, recipient)
      const known = commitments.get(key)
      if (known) return known
      const commitment = stub(0x0c, commitments.size + 1, 32)
      commitments.set(key, commitment)
      return commitment
    },
    spentOn,
    /** What the multi-step executor's recoveries paid, in the order they were made. */
    executorRecoveries: executorRecoveries as readonly (ExecutorRecovery & L1Tx)[],
    releaseIn: (portal: Address, withdrawalId: Hex, range: BlockRange) => {
      const found = spent.find(
        (s) =>
          isAddressEqual(s.portal, portal) &&
          s.withdrawalId === withdrawalId &&
          within(s.blockNumber, range),
      )
      return found && { txHash: found.txHash, at: blockOf(found.blockNumber).timeMs }
    },
    escrowOutcome: (
      escrow: Address,
      token: Address,
      range: BlockRange,
    ): MoveOutcome | undefined => {
      const ran = runs.find((r) => isAddressEqual(r.escrow, escrow) && within(r.blockNumber, range))
      if (ran) return { kind: "ran", assets: ran.assets }
      const back = recoveries.find(
        (r) =>
          isAddressEqual(r.escrow, escrow) &&
          isAddressEqual(r.token, token) &&
          within(r.blockNumber, range),
      )
      return back && { kind: "recovered", ...back }
    },
    fundsOf: (escrow: Address) => funds.get(escrow.toLowerCase()) ?? 0n,
    /** The escrow a move of `nonce` pays, one stub per nonce. */
    escrowFor: (nonce: Hex) => {
      const known = escrows.get(nonce)
      if (known) return known
      const escrow = stub(0xec, escrows.size + 1, 20) as Address
      escrows.set(nonce, escrow)
      return escrow
    },
    /** A call that, sent, runs `escrow`. */
    runCall: (escrow: Address): L1Call => {
      const data = stub(0x52, builtRuns.size + 1, 36)
      builtRuns.set(data, escrow)
      return { to: escrow, data }
    },
    /** A call that, sent, recovers `recovery.escrow`'s token to `recovery.to`. */
    recoveryCall: (recovery: Recovery): L1Call => {
      const data = stub(0x7e, built.size + 1, 36)
      built.set(data, recovery)
      return { to: recovery.escrow, data }
    },
  }
  l1 satisfies MoveL1
  return Object.assign(l1, {
    client: fakeClient(l1, {
      head,
      blockOf,
      deposits,
      vaultEvents,
      spent,
      runs,
      recoveries,
      executorRecoveries,
      funds,
    }),
  })
}

function batch(data: Hex): readonly { target: Address; callData: Hex }[] {
  const decoded = decodeFunctionData({ abi: multicall3Abi, data })
  if (decoded.functionName !== "aggregate3") throw new Error("the batch is not an aggregate3")
  return decoded.args[0]
}

/** What the multi-step executor's `recover` paid. */
interface ExecutorRecovery {
  withdrawalId: Hex
  recipient: Address
  amount: bigint
}

/** An ERC-4626 event of `VAULT`'s. */
interface VaultEvent extends L1Tx {
  eventName: "Deposit" | "Withdraw"
  assets: bigint
  logIndex: number
}

interface FakeChain {
  head(): { number: bigint; timeMs: number }
  blockOf(number: bigint): { number: bigint; timeMs: number }
  deposits: readonly (FoundDeposit & {
    portal: Address
    recipientCommitment: Hex
    logIndex?: number
  })[]
  vaultEvents: readonly VaultEvent[]
  spent: readonly (L1Tx & { portal: Address; withdrawalId: Hex })[]
  runs: readonly (L1Tx & { escrow: Address; assets: bigint })[]
  recoveries: readonly (Recovery & L1Tx)[]
  executorRecoveries: readonly (ExecutorRecovery & L1Tx)[]
  funds: ReadonlyMap<string, bigint>
}

/** What a test sets on the fake L1's contracts. */
interface FakeContracts {
  limits: MoveLimits
  price: { shares: bigint; assets: bigint }
  withdrawalFee: bigint
  beneficiary: Address
  subsidies: Map<string, bigint>
  factoryPortals: { dai: Address; sUsds: Address }
  runGas: bigint
  routeGas: bigint
  tokens: Map<string, { symbol: string; decimals: number }>
  spentOn(portal: Address, withdrawalId: Hex): boolean
}

interface Read {
  address: Address
  functionName: string
  args?: readonly unknown[]
  stateOverride?: StateOverride
}

interface EventQuery {
  address: Address | Address[]
  eventName: string
  args?: Record<string, unknown>
  fromBlock: bigint
  toBlock: bigint
}

type FakeClientMethod =
  | "getChainId"
  | "getBlockNumber"
  | "getBlock"
  | "estimateMaxPriorityFeePerGas"
  | "getCode"
  | "readContract"
  | "getContractEvents"
  | "call"
  | "simulateBlocks"

/**
 * `l1` as a viem client answers it: the reads and logs a real port sends, by contract.
 *
 * `fakeVault.l1.test.ts` holds its vault reads to a real ERC-4626. No contract test holds the rest to
 * a real EVM: a test of those reads on an L1 sim (or a client rebuilt over an ABI round-trip, as
 * `test/oxide/pipeline/fakeL1.ts` is) closes that gap. What the client
 * emulates rather than reads:
 * - a token's `balanceOf` under a state override: the first entry of the override on that token;
 *   without one, what `fund` paid an escrow in DAI;
 * - the tip simulation: success only for the operation executor's six-argument `execute`, with the
 *   escrow's DAI funded by an override, or for any call to the multi-step executor with a funding
 *   override;
 * - the ETH/USD feed: a fixed answer timed at the head.
 */
function fakeClient(l1: FakeContracts, chain: FakeChain): Pick<PublicClient, FakeClientMethod> {
  // A Sky executor charges nothing: it has neither `FEE` nor `BENEFICIARY`.
  const executors = new Map([
    [MAIN_EXECUTOR.toLowerCase(), { portal: DAI_PORTAL, subsidy: MAIN_SUBSIDY, plain: true }],
    [SKY_EXECUTOR.toLowerCase(), { portal: SUSDS_PORTAL, subsidy: SKY_SUBSIDY, plain: false }],
    [
      RETIRED_SKY_EXECUTOR.toLowerCase(),
      { portal: SUSDS_PORTAL, subsidy: SKY_SUBSIDY, plain: false },
    ],
    [STRAY_EXECUTOR.toLowerCase(), { portal: SUSDS_PORTAL, subsidy: MAIN_SUBSIDY, plain: true }],
  ])
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const block = ({ number, timeMs }: { number: bigint; timeMs: number }) => ({
    number,
    hash: stub(0xb1, Number(number), 32),
    timestamp: BigInt(timeMs / 1000),
    baseFeePerGas: parseGwei("10"),
  })
  const log = (tx: L1Tx, address: Address, args: Record<string, unknown>, logIndex = 0) => ({
    address,
    args,
    blockNumber: tx.blockNumber,
    blockHash: stub(0xb1, Number(tx.blockNumber), 32),
    transactionHash: tx.txHash,
    logIndex,
  })
  const read = ({ address, functionName, args = [], stateOverride }: Read): unknown => {
    const executor = executors.get(address.toLowerCase())
    switch (functionName) {
      case "DAI_PORTAL":
        return l1.factoryPortals.dai
      case "SUSDS_PORTAL":
        return l1.factoryPortals.sUsds
      case "PORTAL":
      case "SUBSIDY":
        if (!executor) break
        return functionName === "PORTAL" ? executor.portal : executor.subsidy
      case "FEE":
        if (executor?.plain) return l1.withdrawalFee
        break
      case "BENEFICIARY":
        if (executor?.plain) return l1.beneficiary
        break
      case "PRICE_FEED":
        if (l1.subsidies.has(address.toLowerCase())) return FEED
        break
      case "latestRoundData":
        if (same(address, FEED))
          return [1n, 3000n * 10n ** 8n, 0n, block(chain.head()).timestamp, 1n]
        break
      case "asset":
        if (same(address, VAULT)) return DAI
        if (same(address, SUSDS)) return USDS
        break
      case "maxDeposit":
      case "maxRedeem":
        if (same(address, VAULT)) return l1.limits[functionName]
        break
      // The vault takes no fee, so a preview is its conversion.
      case "convertToAssets":
      case "previewRedeem":
        return ((args[0] as bigint) * l1.price.assets) / l1.price.shares
      case "convertToShares":
      case "previewDeposit":
        return ((args[0] as bigint) * l1.price.shares) / l1.price.assets
      case "$isWithdrawalSpent":
        return l1.spentOn(address, args[0] as Hex)
      case "symbol":
      case "decimals":
        return l1.tokens.get(address.toLowerCase())?.[functionName]
      case "balanceOf": {
        const funded = stateOverride?.find((o) => same(o.address, address))?.stateDiff?.[0]
        if (funded) return BigInt(funded.value)
        return same(address, DAI) ? chain.funds.get(String(args[0]).toLowerCase()) ?? 0n : 0n
      }
    }
    throw new Error(`the fake L1 reverts ${functionName} at ${address}`)
  }
  const events = ({ address, eventName, args = {}, fromBlock, toBlock }: EventQuery) => {
    const at = [address].flat()
    const within = (tx: L1Tx) => tx.blockNumber >= fromBlock && tx.blockNumber <= toBlock
    const listed = (value: string) => at.some((a) => same(a, value))
    const vaultLogs = (name: VaultEvent["eventName"]) =>
      listed(VAULT)
        ? chain.vaultEvents
            .filter((e) => e.eventName === name && within(e))
            .map((e) => log(e, VAULT, { assets: e.assets, shares: 0n }, e.logIndex))
        : []
    switch (eventName) {
      case "Deposit": {
        if (args.recipientCommitment === undefined) return vaultLogs("Deposit")
        const wanted = [args.recipientCommitment as Hex | Hex[]].flat().map((c) => c.toLowerCase())
        return chain.deposits
          .filter((d) => listed(d.portal) && wanted.includes(d.recipientCommitment) && within(d))
          .map((d) =>
            log(
              d,
              d.portal,
              {
                recipientCommitment: d.recipientCommitment,
                amount: d.deposit.amount,
                key: d.deposit.messageKey,
                index: d.deposit.inboxIndex,
              },
              d.logIndex,
            ),
          )
      }
      case "Withdraw":
        return vaultLogs("Withdraw")
      case "WithdrawalOrRefund":
        return chain.spent
          .filter((s) => listed(s.portal) && s.withdrawalId === args.nullifier && within(s))
          .map((s) =>
            log(s, s.portal, {
              flow: 0,
              nullifier: s.withdrawalId,
              executor: zeroAddress,
              executionAmount: 0n,
            }),
          )
      case "SkyEscrowExecuted":
        return chain.runs
          .filter((r) => listed(r.escrow) && within(r))
          .map((r) =>
            log(r, r.escrow, {
              route: 0,
              tipRecipient: zeroAddress,
              daiAmount: r.assets,
              deposited: r.assets,
            }),
          )
      case "Recovered":
        return chain.executorRecoveries
          .filter((r) => listed(MULTI_STEP_EXECUTOR) && r.withdrawalId === args.withdrawalId)
          .filter(within)
          .map(({ withdrawalId, recipient, amount, ...tx }) =>
            log(tx, MULTI_STEP_EXECUTOR, { withdrawalId, recipient, amount }),
          )
      case "EscrowRecovered":
        return chain.recoveries
          .filter((r) => listed(r.escrow) && within(r))
          .map((r) => log(r, r.escrow, { token: r.token, target: r.to, amount: 0n }))
    }
    throw new Error(`the fake L1 emits no ${eventName}`)
  }
  interface Simulated {
    blocks: {
      stateOverrides?: { address: Address; stateDiff?: unknown[] }[]
      calls: { to: Address; args: unknown[] }[]
    }[]
  }
  const simulate = ({ blocks: [simulated] }: Simulated) => {
    const [run] = simulated?.calls ?? []
    if (run && same(run.to, MULTI_STEP_EXECUTOR)) {
      if (!simulated?.stateOverrides?.[0]?.stateDiff?.[0])
        throw new Error("the simulation funds no executor")
      return [{ calls: [{ status: "success", gasUsed: l1.routeGas, data: "0x", logs: [] }] }]
    }
    if (!run || !same(run.to, OPERATION_EXECUTOR)) throw new Error("not the operation executor")
    const funded = simulated?.stateOverrides?.some((o) => same(o.address, DAI) && o.stateDiff?.[0])
    if (!funded) throw new Error("the simulation funds no DAI")
    const result =
      run.args.length === 6
        ? { status: "success", result: 0n, gasUsed: l1.runGas, data: "0x", logs: [] }
        : { status: "failure", error: new Error("no four-argument execute"), gasUsed: 0n }
    return [{ calls: [result] }]
  }
  const subsidyQuote = (to: Address) => {
    const subsidy = l1.subsidies.get(to.toLowerCase())
    if (subsidy === undefined) throw new Error(`the fake L1 has no subsidy at ${to}`)
    return encodeFunctionResult({
      abi: PlainWithdrawalSubsidyAbi,
      functionName: "quoteSubsidy",
      result: subsidy,
    })
  }
  // viem types each method for every call shape; the fake answers only those the port makes.
  return {
    getChainId: async () => CHAIN_ID,
    getBlockNumber: async () => chain.head().number,
    getBlock: (async ({ blockNumber }: { blockNumber?: bigint } = {}) =>
      block(
        blockNumber === undefined ? chain.head() : chain.blockOf(blockNumber),
      )) as PublicClient["getBlock"],
    estimateMaxPriorityFeePerGas: async () => parseGwei("1"),
    getCode: async ({ address }) =>
      chain.runs.some((r) => same(r.escrow, address)) ||
      chain.recoveries.some((r) => same(r.escrow, address))
        ? "0x60"
        : undefined,
    readContract: (async (request: Read) => read(request)) as PublicClient["readContract"],
    getContractEvents: (async (query: EventQuery) =>
      events(query)) as unknown as PublicClient["getContractEvents"],
    call: (async ({ to }: { to: Address }) => ({ data: subsidyQuote(to) })) as PublicClient["call"],
    simulateBlocks: (async (request: Simulated) =>
      simulate(request)) as unknown as PublicClient["simulateBlocks"],
  }
}

export type FakeL1 = ReturnType<typeof fakeL1>

type VaultMoveRead = Parameters<typeof readVaultMove>[0]

export interface FakeEscrowRoute extends MoveRoute {
  factory: Address
}

export interface FakeEscrowQuote extends MoveQuote {
  escrowTip: bigint
}

/** The Sky escrow rail's fake over `l1`. */
export function fakeEscrowRoutes(
  l1: FakeL1,
): MoveRoutes<FakeEscrowHolding, FakeEscrowRoute, FakeEscrowQuote> {
  return {
    rail: "skyEscrow",
    read: async ({ base, held, escrow }) => ({
      base: { portal: base.portal as Address, token: base.underlying as Address },
      held: { portal: held.portal as Address, token: held.underlying as Address },
      factory: escrow.factory,
    }),
    quote: async (_route, direction, amount) => {
      const withdrawalFee = direction === "in" ? l1.withdrawalFee : 0n
      const relayerTip = RELEASE_TIP + ESCROW_TIPS[direction]
      const routed = amount - withdrawalFee - relayerTip
      return {
        routed,
        relayerTip,
        withdrawalFee,
        conversionOut: routed,
        conversionMinOut: routed,
        expectedOut: routed,
        minOut: routed - routed / 100n,
        escrowTip: ESCROW_TIPS[direction],
      }
    },
    build: (route, args, quote) => {
      const address = l1.escrowFor(args.nonce)
      return {
        rail: "skyEscrow",
        escrow: { factory: route.factory, address, tip: quote.escrowTip },
        target: address,
        releaseTip: RELEASE_TIP,
        withdrawal: {
          escrow: {
            escrow: EthAddress.fromString(address),
            userPayload: Buffer.alloc(0),
            l1Operation: {
              target: EthAddress.fromString(route.factory),
              payoutToken: EthAddress.fromString(route.base.token),
              calldata: Buffer.alloc(0),
              condition: L1OperationCondition.immediate(),
            },
            memo: {
              sky: {
                route: args.direction === "in" ? SkyRoute.Stake : SkyRoute.Unstake,
                recipientCommitment: args.recipientCommitment,
                recoveryCommitment: COMMITMENT,
                relayerTip: quote.escrowTip,
                nonce: args.nonce,
                factory: route.factory,
              },
            },
            executor: args.direction === "in" ? MAIN_EXECUTOR : SKY_EXECUTOR,
            withdrawalFee: 0n,
          },
        },
      }
    },
    commitment: async (secret, recipient) => l1.commitment(secret, recipient),
    findDeposit: async (route, direction, recipientCommitment, range, signal) => {
      signal?.throwIfAborted()
      return l1.depositIn(sides(route, direction).destination.portal, recipientCommitment, range)
    },
    withdrawalSpent: async (route, direction, withdrawalId) =>
      l1.spentOn(sides(route, direction).source.portal, withdrawalId),
    release: async (route, direction, withdrawalId, range) =>
      l1.releaseIn(sides(route, direction).source.portal, withdrawalId, range),
    outcome: async (route, move, range, signal) => {
      signal?.throwIfAborted()
      return l1.escrowOutcome(move.escrow.address, sides(route, move.direction).source.token, range)
    },
    owns: (route, burn): burn is MoveBurn<"skyEscrow"> =>
      burn.rail === "skyEscrow" && isAddressEqual(burn.escrow.factory, route.factory),
    recover: async (route, move, _keys, to) => {
      const escrow = l1.escrowFor(move.nonce)
      if (l1.fundsOf(escrow) === 0n) throw new WalletError("move.escrowEmpty", move.id)
      return l1.recoveryCall({ escrow, to, token: sides(route, move.direction).source.token })
    },
    run: async (_route, move) => {
      if (l1.fundsOf(move.escrow.address) === 0n) throw new WalletError("move.escrowRan", move.id)
      return l1.runCall(move.escrow.address)
    },
    limits: async () => l1.limits,
    assetsOf: async (_route, amount) => (amount * l1.price.assets) / l1.price.shares,
    token: async (address) => {
      const facts = l1.tokens.get(address.toLowerCase())
      if (!facts) throw new Error(`the fake L1 has no token ${address}`)
      return facts
    },
    head: async () => l1.head(),
    blockAt: async (timeMs) => l1.blockAt(timeMs),
  }
}

/** A burn's release arguments; the witness and the enclave's signature are stubs no fake checks. */
export const releaseArgsOf = (burn: {
  executor: Address
  amount: bigint
  withdrawalId: Hex
  tipRecipient: Address
}): WithdrawArgs => ({
  content: {
    executor: burn.executor,
    userPayloadHash: zeroHash,
    amount: burn.amount,
    proverTip: 0n,
    randomness: 0n,
  },
  userPayload: "0x",
  relayerPayload: burn.tipRecipient,
  epochNumber: 1n,
  numCheckpointsInEpoch: 1n,
  leafIndex: 0n,
  path: [],
  checkpointNumber: 1n,
  withdrawalId: burn.withdrawalId,
  teeSignature: "0x",
})

/**
 * An account whose bridges hold `balances`, by portal, and whose claims of `l1`'s deposits credit
 * them once. A burn into an escrow, or to the multi-step executor, is read back as its move once its
 * hash leaves `l1.unread`, and has release arguments once it leaves `l1.unproven`.
 */
export function fakeAccount(
  l1: FakeL1,
  balances: Record<Address, bigint> = { [DAI_PORTAL]: 1_000n },
  now: () => number = () => 1_000,
): MovesAccount {
  const held = new Map(Object.entries(balances).map(([portal, n]) => [portal.toLowerCase(), n]))
  const claimed = new Set<string>()
  /** `executor`: the L1 executor the burn's withdrawal pays. */
  const burns: { portal: string; executor: Address; burn: MoveBurn }[] = []
  let sent = 0
  const salts = new Map<string, { recipient: Fr; recovery: Fr }>()
  const address = AztecAddress.fromBigIntUnsafe(0xacn)
  const key = (b: OxideBridge) => b.portal.toLowerCase()
  const credit = (b: OxideBridge, amount: bigint) =>
    void held.set(key(b), (held.get(key(b)) ?? 0n) + amount)
  return {
    address,
    recoveryAccount: RECOVERY_ACCOUNT,
    recovery: {
      sign: async (digest) => signature(digest),
      send: async (call) => (await l1.send(call)).txHash,
    },
    runRoute: async (call, escrow) => (await l1.send(call, escrow)).txHash,
    salts: (nonce, rail) => {
      const saltKey = `${nonce}:${rail}`
      const known = salts.get(saltKey)
      if (known) return known
      const n = BigInt(2 * salts.size + 1)
      const stubbed = { recipient: new Fr(n), recovery: new Fr(n + 1n) }
      salts.set(saltKey, stubbed)
      return stubbed
    },
    balance: async (b) => held.get(key(b)) ?? 0n,
    burn: async (request, signal) => {
      signal?.throwIfAborted()
      const n = ++sent
      const txHash = stub(0xbb, n, 32)
      credit(request.source, -request.amount)
      const memo = request.withdrawal.escrow?.memo
      const multiStep = request.withdrawal.multiStep?.operation
      const vaultMove =
        multiStep &&
        readVaultMove(
          {
            // The executor, amount and payload are all it reads.
            finalizationData: multiStep as unknown as VaultMoveRead["finalizationData"],
            memo: multiStep.recoveryMemo ?? Buffer.alloc(0),
          },
          [request.target],
        )
      if (vaultMove) {
        burns.push({
          portal: key(request.source),
          executor: request.target,
          burn: {
            ...vaultMove,
            rail: "executor",
            txHash,
            timestampMs: now(),
            withdrawalId: stub(0x1d, n, 32),
          },
        })
      }
      if (memo && "sky" in memo) {
        const { sky } = memo
        const escrow = { factory: sky.factory, address: request.target, tip: sky.relayerTip }
        const executor = request.withdrawal.escrow?.executor
        if (!executor) throw new Error("the fake reads a Sky burn's executor from its options")
        burns.push({
          portal: key(request.source),
          executor,
          burn: {
            rail: "skyEscrow",
            escrow,
            txHash,
            timestampMs: now(),
            withdrawalId: stub(0x1d, n, 32),
            amount: request.amount,
            nonce: sky.nonce,
            recipientCommitment: sky.recipientCommitment,
          },
        })
      }
      return { txHash, blockNumber: n }
    },
    messageReady: async (messageKey) => !l1.inTransit.has(messageKey),
    claim: async (b, deposit, signal) => {
      signal?.throwIfAborted()
      const made = l1.depositAt(b.portal as Address, deposit.inboxIndex)
      const matches =
        made?.deposit.amount === deposit.amount &&
        made.recipientCommitment === l1.knownCommitment(deposit.secret, address)
      if (!matches) throw new Error("the fake L1 holds no such deposit to this account")
      if (made.deposit.messageKey && l1.inTransit.has(made.deposit.messageKey))
        throw new Error("the fake L2 holds no such L1 to L2 message")
      const id = `${key(b)}:${deposit.inboxIndex}`
      if (claimed.has(id)) return
      claimed.add(id)
      credit(b, deposit.amount)
    },
    moveBurns: async (b, rail) => {
      const ours = burns.filter((r) => r.portal === key(b) && r.burn.rail === rail)
      const indexed = ours.filter((r) => !l1.unread.has(r.burn.txHash))
      return { burns: indexed.map((r) => r.burn), unread: indexed.length < ours.length }
    },
    releaseArgs: async ({ txHash, source, executor }, tipRecipient): Promise<WithdrawArgs> => {
      const made = burns.find((r) => r.burn.txHash === txHash && r.portal === key(source))
      if (!made) throw new Error(`the fake L2 holds no burn ${txHash}`)
      if (!isAddressEqual(made.executor, executor))
        throw new Error(`${txHash} does not withdraw through executor ${executor}`)
      if (l1.unproven.has(txHash)) throw new WalletError("move.noRecovery", `${txHash}: unproven`)
      const { amount, withdrawalId } = made.burn
      return releaseArgsOf({ executor, amount, withdrawalId, tipRecipient })
    },
  }
}

/**
 * `account` as a front composes it: its burn seeds the withdrawal record under the move's key, saves
 * the hash on it, and marks it mined with the withdrawal id the burn reads back, as the burn
 * sequence and the tracker do. A `refused` burn throws before the seed; a `failed` one keeps its
 * seed as failed.
 */
export function frontAccount(
  account: MovesAccount,
  withdrawals: Pick<Withdrawals, "create" | "apply">,
  now: () => number,
  burns: "sent" | "refused" | "failed" = "sent",
): MovesAccount {
  return {
    ...account,
    burn: async (request, signal) => {
      if (burns === "refused") throw new Error("the node refused the burn")
      // A cancel leaves no seed.
      signal?.throwIfAborted()
      const { withdrawalLocalId: localId, source } = request
      await withdrawals.create({
        localId,
        operationId: request.operationId,
        networkId: "sandbox",
        recipient: request.target,
        recipientProvenance: "saved-recipient",
        amount: String(request.amount),
        tokenSymbol: "DAI",
        tokenDecimals: 18,
        phase: "submitting",
        startTime: now(),
      })
      if (burns === "failed") {
        const fields = { phase: "failed" as const, failure: { code: "withdrawal.failed" as const } }
        await withdrawals.apply(localId, { type: "patch", fields })
        throw new Error("the burn failed")
      }
      const result = await account.burn(request, signal)
      const mined = { l2TxHash: result.txHash, blockNumber: result.blockNumber }
      await withdrawals.apply(localId, { type: "mined", ...mined })
      const rail = request.withdrawal.multiStep ? "executor" : "skyEscrow"
      const read = (await account.moveBurns(source, rail)).burns.find(
        (b) => b.txHash === result.txHash,
      )
      const fields = { phase: "finalizing_l1" as const, withdrawalId: read?.withdrawalId }
      await withdrawals.apply(localId, { type: "patch", fields })
      return result
    },
  }
}
