/**
 * SIPA claim-input reads + sweep-call builder — the contract-touching
 * primitives of the deposit claim path. The broadcast note carries the
 * `shared_secret_salt` + `resweepable` flag; the claim inputs (inbox leaf
 * index + the amount credited on L2) exist solely in the SIPA's L1 `Sweep`
 * event, and the
 * L1→L2 message key needed for the settlement check lives in the portal's
 * `Deposit` event inside the same sweep transaction. Everything here is a
 * read or a calldata builder; the one L2 write-shaped call
 * (`store_deposit`) is a TokenService method because the token
 * contract lives there.
 */

import type { Address, Hex, PublicClient } from "viem"
import { decodeEventLog, encodeFunctionData, erc20Abi, multicall3Abi, zeroAddress } from "viem"
import { Fr } from "@aztec/aztec.js/fields"
import { EthAddress, type AztecAddress } from "@aztec/aztec.js/addresses"
import type { AztecNode } from "@aztec/aztec.js/node"
import type { GrumpkinScalar } from "@aztec/foundation/curves/grumpkin"
import {
  computeDepositMessageHash,
  computeSiloedDepositMessageNullifier,
} from "@oxide/oxide-lib/deposit_message_hashing.js"
import {
  SIPAAbi,
  OxidePortalEventsAbi,
  encodeDeploySIPA,
  encodeRegistrationProofs,
  encodeLegacyRegistrationProofs,
  encodeSweep,
  type DomainAuthArg,
  type R1InstallArg,
  type SignedTermsArg,
  type SipaDeployArgs,
  type SweepArgs,
} from "@oxide/l1-contracts"
import {
  encodeLegacySipaDeploy,
  encodeLegacySipaRecoverERC20,
  type LegacySipaDeployArgs,
} from "@oxide/l1-contracts/legacy_sipa.js"
import {
  encodeSipaRecoverERC20,
  encodeSipaRecoverETH,
  type SipaRecoveryArgs,
} from "@oxide/l1-contracts/sipa_recovery.js"
import { TX_AMOUNT_CAP } from "@oxide/oxide-lib/oxide_constants.gen.js"
import { chunkedContractEvents } from "./l1Logs.js"
import { readSipaEvents, type SipaEvent } from "@oxide/oxide-client/sipa_event_calls.js"
import type { PrivateEventFilter, Wallet } from "@aztec/aztec.js/wallet"
import { OxideTokenContract } from "@obsidion/contracts"

export type { SipaEvent }

/** The canonical cross-chain Multicall3 deployment. */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address

/** Inner calls per Multicall3 `eth_call`: at ~8k gas each a batch stays far under node gas caps. */
const BALANCE_CALLS_PER_MULTICALL = 1_000

/**
 * Chain-authoritative consumed check for one same-rollup SIPA sweep. The nullifier is derived from
 * the deposit message and the recipient's NHK, then looked up at the live rollup tip; no wallet
 * deposit record or local claimed-index list participates.
 */
export async function isSipaDepositClaimed(
  node: Pick<AztecNode, "getNullifierMembershipWitness">,
  params: {
    l1Portal: Address
    l1ChainId: bigint
    l2Token: AztecAddress
    rollupVersion: bigint
    recipient: AztecAddress
    messageSecret: Fr
    amount: bigint
    inboxIndex: bigint
    masterNullifierHidingKey: GrumpkinScalar
  },
): Promise<boolean> {
  // oxide-lib currently resolves its Aztec value classes through a second workspace pin. The
  // values are wire-identical; keep the nominal-version bridge at this package boundary.
  const messageHash = await computeDepositMessageHash(
    {
      l1Portal: EthAddress.fromString(params.l1Portal),
      l1ChainId: params.l1ChainId,
      l2Portal: params.l2Token,
      rollupVersion: params.rollupVersion,
    } as never,
    {
      sharedSecretSalt: params.messageSecret,
      recipient: params.recipient,
      amount: params.amount,
      messageLeafIndex: new Fr(params.inboxIndex),
    } as never,
  )
  const nullifier = await computeSiloedDepositMessageNullifier(
    params.l2Token as never,
    messageHash,
    params.masterNullifierHidingKey as never,
  )
  return (await node.getNullifierMembershipWitness("latest", nullifier as never)) !== undefined
}

/** Cap on the backward sweep scan when no explicit `fromBlock` is given. ~7 days of Sepolia blocks. */
const SWEEP_MAX_LOOKBACK_BLOCKS = 50_000n

/** The sweep and funding readers' window: the caller's range, else the finite look-back. */
async function sweepScanWindow(
  publicClient: PublicClient,
  fromBlock?: bigint,
  toBlock?: bigint,
): Promise<{ from: bigint; to: bigint }> {
  // `cacheTime: 0` because viem caches `getBlockNumber` for a polling interval by default, which
  // makes the head lag a block or two. This value is an upper BOUND on the scan, so a lagging one
  // silently excludes the newest logs — a caller that sweeps and then reads sees nothing at all.
  const to = toBlock ?? (await publicClient.getBlockNumber({ cacheTime: 0 }))
  const from = fromBlock ?? (to > SWEEP_MAX_LOOKBACK_BLOCKS ? to - SWEEP_MAX_LOOKBACK_BLOCKS : 0n)
  return { from, to }
}

/** A SIPA `Sweep(index, amount)` event plus the tx that emitted it. */
export interface SipaSweepEvent {
  /** L1→L2 inbox leaf index — the claim's `inbox_index`. */
  index: bigint
  /** The amount credited on L2: gross minus the sweep fee and the portal's cut — the claim's
   *  `amount`. */
  amount: bigint
  blockNumber: bigint
  /** The deploy-and-sweep tx; its receipt carries the portal `Deposit` event. */
  txHash: Hex
}

/**
 * Read a SIPA's `Sweep` events — the ONLY source of the claim inputs.
 *
 * Bounded and chunked rather than one `earliest → latest` sweep: an unbounded range is rejected by
 * every rate-limited RPC and is slow even where it is allowed. A SIPA can be topped up and re-swept,
 * so this returns EVERY sweep in the window, not just the newest — each inbox index claims
 * independently, and stopping at the first hit would strand the earlier ones.
 *
 * Pass `fromBlock` when the caller knows when the deposit was funded; the default look-back is
 * finite, so a sweep older than it is invisible here. Pass `toBlock` to pin the upper bound —
 * one head shared across many SIPAs, and the value a caller persists as scanned-through.
 */
export async function readSweepEvents(
  publicClient: PublicClient,
  sipa: Address,
  fromBlock?: bigint,
  toBlock?: bigint,
): Promise<SipaSweepEvent[]> {
  const window = await sweepScanWindow(publicClient, fromBlock, toBlock)
  const logs = await chunkedContractEvents(
    publicClient,
    { address: sipa, abi: SIPAAbi, eventName: "Sweep" },
    window.from,
    window.to,
  )
  return logs.map(toSweepEvent)
}

function toSweepEvent(log: unknown): SipaSweepEvent {
  const { args, blockNumber, transactionHash } = log as {
    args: { index: bigint; amount: bigint }
    blockNumber: bigint
    transactionHash: Hex
  }
  return { index: args.index, amount: args.amount, blockNumber, txHash: transactionHash }
}

/** One SIPA's scan start; without `fromBlock` it takes the finite look-back. */
export interface SipaScanWindow {
  sipa: Address
  fromBlock?: bigint
}

/**
 * Logs for many SIPAs from one chunked `getLogs` over the union of their windows, grouped by the
 * SIPA `ownerOf` names. Each SIPA keeps only the logs inside its own window, so the result matches
 * one per-SIPA read each. Every window gets an entry, empty when nothing matched.
 */
async function readLogsByWindow(
  publicClient: PublicClient,
  windows: readonly SipaScanWindow[],
  toBlock: bigint,
  request: (sipas: Address[]) => {
    address: Address | Address[]
    abi: unknown
    eventName: string
    args?: unknown
  },
  ownerOf: (log: { address: Address; args: Record<string, unknown> }) => unknown,
): Promise<Map<string, unknown[]>> {
  const out = new Map<string, unknown[]>()
  const starts = new Map<string, bigint>()
  for (const w of windows) {
    const key = w.sipa.toLowerCase()
    const { from } = await sweepScanWindow(publicClient, w.fromBlock, toBlock)
    const known = starts.get(key)
    starts.set(key, known === undefined || from < known ? from : known)
    out.set(key, [])
  }
  if (starts.size === 0) return out
  const from = [...starts.values()].reduce((min, b) => (b < min ? b : min))
  // One address list per call: an RPC that caps filter lists fails the batch, and the caller
  // reads per SIPA.
  const logs = await chunkedContractEvents(
    publicClient,
    request(windows.map((w) => w.sipa)),
    from,
    toBlock,
  )
  for (const log of logs) {
    const key = String(ownerOf(log as never)).toLowerCase()
    const start = starts.get(key)
    if (start !== undefined && (log as { blockNumber: bigint }).blockNumber >= start) {
      out.get(key)!.push(log)
    }
  }
  return out
}

/** `readSweepEvents` for many SIPAs in one scan, keyed by lowercased SIPA address. */
export async function readSweepEventsMany(
  publicClient: PublicClient,
  windows: readonly SipaScanWindow[],
  toBlock: bigint,
): Promise<Map<string, SipaSweepEvent[]>> {
  const logs = await readLogsByWindow(
    publicClient,
    windows,
    toBlock,
    (sipas) => ({ address: sipas, abi: SIPAAbi, eventName: "Sweep" }),
    (log) => log.address,
  )
  return new Map([...logs].map(([sipa, l]) => [sipa, l.map(toSweepEvent)]))
}

export interface SipaRecoveredEvent {
  /** The recovered token; `0x0` for the ETH path. */
  token: Address
  /** Where the funds went — the address the signature named, not the submitter. */
  target: Address
  amount: bigint
  blockNumber: bigint
  txHash: Hex
}

export async function readRecoveredEvents(
  publicClient: PublicClient,
  sipa: Address,
  fromBlock?: bigint,
  toBlock?: bigint,
): Promise<SipaRecoveredEvent[]> {
  const window = await sweepScanWindow(publicClient, fromBlock, toBlock)
  const logs = await chunkedContractEvents(
    publicClient,
    { address: sipa, abi: SIPAAbi, eventName: "Recovered" },
    window.from,
    window.to,
  )
  return logs.map(toRecoveredEvent)
}

function toRecoveredEvent(log: unknown): SipaRecoveredEvent {
  const { args, blockNumber, transactionHash } = log as {
    args: { token: Address; target: Address; amount: bigint }
    blockNumber: bigint
    transactionHash: Hex
  }
  return {
    token: args.token,
    target: args.target,
    amount: args.amount,
    blockNumber,
    txHash: transactionHash,
  }
}

/** `readRecoveredEvents` for many SIPAs in one scan, keyed by lowercased SIPA address. */
export async function readRecoveredEventsMany(
  publicClient: PublicClient,
  windows: readonly SipaScanWindow[],
  toBlock: bigint,
): Promise<Map<string, SipaRecoveredEvent[]>> {
  const logs = await readLogsByWindow(
    publicClient,
    windows,
    toBlock,
    (sipas) => ({ address: sipas, abi: SIPAAbi, eventName: "Recovered" }),
    (log) => log.address,
  )
  return new Map([...logs].map(([sipa, l]) => [sipa, l.map(toRecoveredEvent)]))
}

/** An ERC-20 `Transfer` into a SIPA — the funding-attribution source. */
export interface SipaFundingTransfer {
  /** Token-level sender. A contract-mediated transfer attributes the intermediary, not the wallet. */
  from: Address
  amount: bigint
  blockNumber: bigint
  txHash: Hex
}

/** L1 block time in ms; undefined when the read fails so a wall-clock stamp can stand in. */
export async function readBlockTimeMs(
  publicClient: PublicClient,
  blockNumber: bigint,
): Promise<number | undefined> {
  try {
    return Number((await publicClient.getBlock({ blockNumber })).timestamp) * 1000
  } catch {
    return undefined
  }
}

/**
 * Read the token `Transfer(to = sipa)` logs — who funded a SIPA, and with which
 * tx. Client-side replacement for the data the retired ens-gateway's on-chain
 * Transfer scan used to report. Same window semantics as `readSweepEvents`.
 */
export async function readFundingTransfers(
  publicClient: PublicClient,
  token: Address,
  sipa: Address,
  fromBlock?: bigint,
  toBlock?: bigint,
): Promise<SipaFundingTransfer[]> {
  const window = await sweepScanWindow(publicClient, fromBlock, toBlock)
  const logs = await chunkedContractEvents(
    publicClient,
    { address: token, abi: erc20Abi, eventName: "Transfer", args: { to: sipa } },
    window.from,
    window.to,
  )
  return logs.map(toFundingTransfer)
}

function toFundingTransfer(log: unknown): SipaFundingTransfer {
  const { args, blockNumber, transactionHash } = log as {
    args: { from: Address; value: bigint }
    blockNumber: bigint
    transactionHash: Hex
  }
  return { from: args.from, amount: args.value, blockNumber, txHash: transactionHash }
}

/** `readFundingTransfers` for many SIPAs in one scan (`to` is an OR filter), keyed by lowercased SIPA. */
export async function readFundingTransfersMany(
  publicClient: PublicClient,
  token: Address,
  windows: readonly SipaScanWindow[],
  toBlock: bigint,
): Promise<Map<string, SipaFundingTransfer[]>> {
  const logs = await readLogsByWindow(
    publicClient,
    windows,
    toBlock,
    (sipas) => ({ address: token, abi: erc20Abi, eventName: "Transfer", args: { to: sipas } }),
    (log) => log.args.to,
  )
  return new Map([...logs].map(([sipa, l]) => [sipa, l.map(toFundingTransfer)]))
}

/**
 * Every SIPA's balance of each token, plus its ETH under `zeroAddress`, through Multicall3. Keyed by
 * lowercased SIPA, then lowercased token. A failed read is absent, so the caller can retry it alone.
 */
export async function readSipaBalancesMany(
  publicClient: PublicClient,
  sipas: readonly Address[],
  tokens: readonly Address[],
  multicall3: Address = MULTICALL3_ADDRESS,
): Promise<Map<string, Map<string, bigint>>> {
  const reads = sipas.flatMap((sipa) => [
    ...tokens.map((token) => ({
      sipa,
      token,
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [sipa],
    })),
    {
      sipa,
      token: zeroAddress,
      address: multicall3,
      abi: multicall3Abi,
      functionName: "getEthBalance",
      args: [sipa],
    },
  ])
  const out = new Map(sipas.map((sipa) => [sipa.toLowerCase(), new Map<string, bigint>()]))
  if (reads.length === 0) return out
  const results = await publicClient.multicall({
    contracts: reads,
    multicallAddress: multicall3,
    allowFailure: true,
    // viem chunks by inner calldata bytes; a balanceOf/getEthBalance call is 36.
    batchSize: BALANCE_CALLS_PER_MULTICALL * 36,
  } as never)
  const answers = results as { status: string; result?: unknown }[]
  reads.forEach(({ sipa, token }, i) => {
    const answer = answers[i]
    if (answer?.status === "success")
      out.get(sipa.toLowerCase())!.set(token.toLowerCase(), answer.result as bigint)
  })
  return out
}

/**
 * Extract the L1→L2 message key for one swept deposit from the sweep tx's
 * receipt: the portal's `Deposit` event whose inbox `index` matches the
 * `Sweep`'s. A relayer batch can carry several sweeps in one Multicall3 tx,
 * so matching on the leaf index (not "first event") is load-bearing.
 * Returns null when no matching event exists (wrong tx / wrong portal).
 */
export async function readDepositMessageKey(
  publicClient: PublicClient,
  portal: Address,
  txHash: Hex,
  inboxIndex: bigint,
): Promise<Fr | null> {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash })
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== portal.toLowerCase()) continue
    let decoded: { args: { key: Hex; index: bigint } }
    try {
      decoded = decodeEventLog({
        abi: OxidePortalEventsAbi,
        eventName: "Deposit",
        topics: log.topics,
        data: log.data,
      }) as never as { args: { key: Hex; index: bigint } }
    } catch {
      // Not a Deposit event — skip. (Only the decode is guarded: a matching
      // event with a key outside the field must throw, not vanish.)
      continue
    }
    if (decoded.args.index === inboxIndex) {
      return Fr.fromHexString(decoded.args.key)
    }
  }
  return null
}

/** Where a SIPA's current funding sits between the deposit floor and the per-transaction cap. */
export interface SipaFundingStatus {
  /** The SIPA's current `token` balance, in the sent token's own units. */
  balance: bigint
  /** `balance` in the fee's denomination: the figure to compare with `fee` and the cap. */
  scaledBalance: bigint
  /** The implementation's `depositFee()` — the relayer's half of the floor. */
  fee: bigint
  /** The portal's `FPC_FUNDING_CUT` — the other half, skimmed off what the sweep forwards. */
  fpcFundingCut: bigint
  sweepable: boolean
}

/**
 * Classify a funded-but-unswept SIPA against the two-sided sweep window:
 * `fee + cut < balance ≤ TX_AMOUNT_CAP + fee + cut`. A sweep pays the deposit fee out of the WHOLE
 * balance and deposits the rest into the portal, which requires the deposited amount to exceed its
 * funding cut and credits `balance − fee − cut`. The
 * per-transaction cap measures that credited amount. `recoverERC20` is the only exit outside the
 * window. `balance = 0` after a sweep is normal.
 *
 * `implementation` is the SIPA's intent implementation — the one the address commits to, whose
 * `depositFee()` the sweep charges. It is read only without `params.fee`, which supplies the floor
 * when the caller already holds it, so one read serves every SIPA of that implementation; the cut is
 * a per-deployment immutable the caller reads once with `readFpcFundingCut`.
 *
 * `params.balanceScale` normalizes the balance into the fee's denomination when the sent token's
 * decimals differ (mainnet: the sweep swaps USDC/USDT ~1:1 into 18-dec DAI, which the fee and the
 * cap are measured in — pass `10^(18 - sentDecimals)`). The returned `balance` stays raw.
 */
export async function readSipaFundingStatus(
  publicClient: PublicClient,
  params: {
    sipa: Address
    token: Address
    fpcFundingCut: bigint
    balanceScale?: bigint
    /** The balance when the caller already read it; skips the `balanceOf` read. */
    balance?: bigint
  } & ({ fee: bigint; implementation?: Address } | { fee?: undefined; implementation: Address }),
): Promise<SipaFundingStatus> {
  const [balance, fee] = await Promise.all([
    params.balance ??
      (publicClient.readContract({
        address: params.token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [params.sipa],
      } as never) as Promise<bigint>),
    params.fee !== undefined ? params.fee : readDepositFee(publicClient, params.implementation),
  ])
  const scaledBalance = balance * (params.balanceScale ?? 1n)
  const floor = fee + params.fpcFundingCut
  return {
    balance,
    scaledBalance,
    fee,
    fpcFundingCut: params.fpcFundingCut,
    sweepable: scaledBalance > floor && scaledBalance - floor <= TX_AMOUNT_CAP,
  }
}

/**
 * The deposit fee an intent implementation charges — a `SIPABase` immutable, so each intent family
 * prices its own sweep and a registration (which registers a name on the way through) costs more
 * than a plain deposit. It is one half of the deposit floor; the portal's `FPC_FUNDING_CUT` is the
 * other. The receive UX pre-checks the send against their sum: a sweep at or below it hard-reverts,
 * and a third-party sender has no client guard, which is why the recovery affordance exists.
 *
 * Read off the IMPLEMENTATION, never a clone: the quote a payer is shown exists before any SIPA is
 * deployed, and a clone only delegatecalls back to this same immutable.
 */
export async function readDepositFee(
  publicClient: PublicClient,
  implementation: Address,
): Promise<bigint> {
  return (await publicClient.readContract({
    address: implementation,
    abi: SIPAAbi,
    functionName: "depositFee",
  } as never)) as bigint
}

/** The L1 transaction target + calldata for a recipient-self-sweep. */
export interface SipaSweepCall {
  to: Address
  data: Hex
}

/** `token` is the ERC-20 to recover, or `zeroAddress` for the SIPA's ETH balance. */
type RecoveryCall = { sipa: Address; token: Address } & (
  | { protocol: "legacy-eoa"; signature: Hex; target: Address; nonce: Hex }
  | ({ protocol: "account" } & SipaRecoveryArgs)
)

export function encodeRecoverCall(params: RecoveryCall): SipaSweepCall {
  if (params.token === zeroAddress) {
    // oxide ships no legacy recoverETH encoder; legacy SIPAs exist only on retired deployments.
    if (params.protocol === "legacy-eoa")
      throw new Error("ETH recovery needs an account-protocol SIPA")
    return { to: params.sipa, data: encodeSipaRecoverETH(params) }
  }
  return {
    to: params.sipa,
    data:
      params.protocol === "legacy-eoa"
        ? encodeLegacySipaRecoverERC20(params)
        : encodeSipaRecoverERC20(params),
  }
}

/** @deprecated Use `encodeRecoverCall`, which also encodes `recoverETH`. */
export const encodeRecoverErc20Call = encodeRecoverCall

type RecoveryDeployment =
  | { protocol: "legacy-eoa"; sipaFactory: Address; args: LegacySipaDeployArgs }
  | { protocol: "account"; sipaFactory: Address; args: SipaDeployArgs }

/** One transaction that recovers each of `recoveries`, one token each, from the same SIPA. */
export function buildSipaRecoverCall(params: {
  deployed: boolean
  deployment?: RecoveryDeployment
  recoveries: readonly [RecoveryCall, ...RecoveryCall[]]
  accountInitCode?: Hex
  multicall3?: Address
}): SipaSweepCall {
  const protocol = params.recoveries[0].protocol
  if (params.recoveries.some((r) => r.protocol !== protocol)) {
    throw new Error("All SIPA recoveries in one transaction must use one protocol")
  }
  const calls: { target: Address; allowFailure: boolean; callData: Hex }[] = []
  if (params.accountInitCode) {
    if (protocol !== "account" || !/^0x[0-9a-fA-F]{48,}$/.test(params.accountInitCode)) {
      throw new Error("Account initialization is only valid for account recovery")
    }
    calls.push({
      target: params.accountInitCode.slice(0, 42) as Address,
      allowFailure: false,
      callData: `0x${params.accountInitCode.slice(42)}`,
    })
  }
  if (!params.deployed) {
    const deployment = params.deployment
    if (!deployment || deployment.protocol !== protocol) {
      throw new Error("Matching SIPA recovery and deployment protocols are required")
    }
    calls.push({
      target: deployment.sipaFactory,
      allowFailure: false,
      callData:
        deployment.protocol === "legacy-eoa"
          ? encodeLegacySipaDeploy(deployment.args)
          : encodeDeploySIPA(deployment.args),
    })
  }
  if (!calls.length && params.recoveries.length === 1)
    return encodeRecoverCall(params.recoveries[0])
  for (const recovery of params.recoveries) {
    const call = encodeRecoverCall(recovery)
    calls.push({ target: call.to, allowFailure: false, callData: call.data })
  }
  return {
    to: params.multicall3 ?? MULTICALL3_ADDRESS,
    data: encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] }),
  }
}

/**
 * Build the permissionless deploy-and-sweep transaction (the recipient-side
 * fallback for when no relayer picks a discovered deposit up). It claims no
 * subsidy: an undeployed SIPA is deployed and swept atomically through
 * Multicall3 `aggregate3` (both sub-calls all-or-nothing); a deployed SIPA is
 * swept directly — a second `deploySIPA` would revert on the CREATE2
 * collision. Pass the recipient's own L1 address as `sweepArgs.relayer` so the
 * deposit fee returns to them. Submission is the caller's channel (external
 * wallet pays gas).
 */
export type SipaSweepDeployArgs = SipaDeployArgs | LegacySipaDeployArgs

export function buildSipaSweepCall(params: {
  /** Whether the SIPA already has code (`getCode` non-empty). */
  deployed: boolean
  /** The CREATE2 deployer the deploy leg targets. */
  sipaFactory: Address
  sipa: Address
  deployArgs: SipaSweepDeployArgs
  sweepArgs: SweepArgs
  multicall3?: Address
}): SipaSweepCall {
  const sweepData = encodeSweep(params.sweepArgs)
  if (params.deployed) {
    return { to: params.sipa, data: sweepData }
  }
  const calls = [
    {
      target: params.sipaFactory,
      allowFailure: false,
      callData:
        "recoveryAddress" in params.deployArgs
          ? encodeLegacySipaDeploy(params.deployArgs)
          : encodeDeploySIPA(params.deployArgs),
    },
    { target: params.sipa, allowFailure: false, callData: sweepData },
  ]
  return {
    to: params.multicall3 ?? MULTICALL3_ADDRESS,
    data: encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] }),
  }
}

/**
 * The registration self-sweep call: the SAME deploy-and-sweep a relayer runs for a RegistrationSIPA
 * (the register-deploy-and-sweep inside `RegistrationSIPA._execute`), submitted by the user as their
 * own relayer. Mirrors {@link buildSipaSweepCall} for a plain deposit, but reveals the registration
 * record as `intentData` and packs the consent/domain/terms as `proofs`. Naming the user's own L1
 * address as `relayer` returns the deposit fee to them; the on-chain registration fee still comes out
 * of the deposit — bypassing the relayer changes who submits, not what is charged.
 */
export function buildRegistrationSweepCall(params: {
  /** Whether the SIPA already has code (`getCode` non-empty). */
  deployed: boolean
  /** The CREATE2 deployer the deploy leg targets. */
  sipaFactory: Address
  sipa: Address
  /** The registration SIPA's create2 deploy args; its `intentHash` is `keccak256(registrationData)`. */
  deployArgs: SipaSweepDeployArgs
  /** ABI-encoded registration intent — the sweep's revealed `intentData`. */
  registrationData: Hex
  consentSig: Hex
  bootstrap: Address
  domainAuth: DomainAuthArg
  /** {@link EMPTY_SIGNED_TERMS} to register on the contract's immutable schedule. */
  signedTerms: SignedTermsArg
  /** The passkey install the sweep bundles through the EntryPoint. */
  r1Install: R1InstallArg
  token: Address
  /** Credited the deposit fee — the user's own L1 address for a self-sweep. */
  relayer: Address
  multicall3?: Address
}): SipaSweepCall {
  return buildSipaSweepCall({
    deployed: params.deployed,
    sipaFactory: params.sipaFactory,
    sipa: params.sipa,
    deployArgs: params.deployArgs,
    sweepArgs: {
      token: params.token,
      relayer: params.relayer,
      intentData: params.registrationData,
      proofs: ("recoveryAddress" in params.deployArgs
        ? encodeLegacyRegistrationProofs
        : encodeRegistrationProofs)({
        consentSig: params.consentSig,
        bootstrap: params.bootstrap,
        domainAuth: params.domainAuth,
        signedTerms: params.signedTerms,
        r1Install: params.r1Install,
      }),
    },
    multicall3: params.multicall3,
  })
}

/**
 * The sweep encoder and the two argument shapes `buildSipaSweepCall` takes,
 * re-exported so callers outside this workspace (the web wallet) name the
 * vendored types directly instead of re-deriving them from the builder's
 * signature.
 */
export { encodeSweep } from "@oxide/l1-contracts"
export type { SipaDeployArgs, SweepArgs } from "@oxide/l1-contracts"

/** The registration sweep's domain-auth struct (oxide `DomainAuthArg`). */
export type SweepSigStruct = DomainAuthArg
/** The operator-signed terms struct and its "no terms" marker (the immutable schedule applies). */
export { EMPTY_SIGNED_TERMS } from "@oxide/l1-contracts"
export type { SignedTermsArg } from "@oxide/l1-contracts"

/** The per-transaction deposit ceiling `sweepable` measures against, for callers that name it in UI. */
export { TX_AMOUNT_CAP } from "@oxide/oxide-lib/oxide_constants.gen.js"

/** Read the `SIPA` events sent to `recipient` on `token`. Register the sender with the wallet first. */
export function fetchSipaEvents(
  wallet: Pick<Wallet, "getPrivateEvents">,
  token: AztecAddress,
  recipient: AztecAddress,
  filter?: Pick<PrivateEventFilter, "fromBlock" | "toBlock" | "txHash">,
): Promise<SipaEvent[]> {
  return readSipaEvents(wallet, OxideTokenContract.events.SIPA, token, recipient, filter)
}
