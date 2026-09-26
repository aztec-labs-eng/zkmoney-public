import type { LegacySipaDeployArgs } from "@oxide/l1-contracts/legacy_sipa.js"
import type { Account } from "@aztec/aztec.js/account"
import { EthAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging"
import type { AztecNode } from "@aztec/aztec.js/node"
import type { ViemClient } from "@aztec/ethereum/types"
import { retryUntil } from "@aztec/foundation/retry"
import { OxidePortalContract, type SipaDeployArgs, getSipaSweeps } from "@oxide/l1-contracts"
import { computeDepositMessageHash } from "@oxide/oxide-lib/deposit_message_hashing.js"
import type { SpendMetadataResolver } from "@oxide/oxide-client/token_operations_collector.js"
import type { Network } from "@obsidion/core/constants"
import {
  extractPinnedOxideEnvTuple,
  migrationSources,
  pinnedEntryPolicy,
} from "@obsidion/core/oxide"
import type { OxideEnvTuple, SIPADepositPhase, WithdrawalPhase } from "@obsidion/core/types"
import { erc20Abi, type Address, type Hex, type PublicClient } from "viem"

import type { DepositSpendMetadataResolver } from "../oxide/index.js"
import { epochDay } from "../utils/helper.js"
import type { ObsidionAccount } from "../obsidion/alpha/account/ObsidionAccount.js"
import type { ClaimSponsorContext } from "./claimSponsor.js"
import { readDepositFee } from "./sipaClaim.js"
import { readDepositSIPAImplementation } from "./sipaIntents.js"
import { SipaSelfResolver, type SelfResolvedSipa } from "./sipaSelfResolve.js"
import type { TokenService } from "./TokenService.js"
import type { WithdrawalDeployment } from "./plainWithdrawal.js"
import { readPortalWithdrawalState } from "../oxide/plainWithdrawal.js"

const DEFAULT_TIMEOUT_MS = 1_800_000

export interface IntraRollupMigrationDeps {
  node: AztecNode
  /** Pinned (by explicit address) to the retiring deployment's token. */
  fromTokenService: TokenService
  /** Pinned to the new deployment's token. */
  toTokenService: TokenService
  /** Retiring deployment for the withdrawal and value-continuity checks. */
  from: WithdrawalDeployment
  /**
   * Self-resolution for the deployment-B SIPA: the account's stealth key × deployment B's
   * resolver public key (same construction as the receive flow's deposit-address derivation).
   * `(day, nonce)` regenerate everything, and the derived address is broadcastable for the
   * standard deposit-tracking rail.
   */
  selfResolver: SipaSelfResolver
  recoveryAccount: Address
  /** New deployment's SIPA wiring (the sweep itself is the relayer's job, so no subsidy manager). */
  to: {
    /** Also the key the factory serves this deployment's implementations under. */
    portal: Hex
    sipaFactory: Hex
    recoveryProtocol?: "legacy-eoa" | "account"
  }
  /** Read-only L1 client — the service never signs an L1 transaction. */
  publicClient: PublicClient
}

export interface IntraRollupMigrationResult {
  sipaAddress: Address
  /** CREATE2 preimage. Recoverable from `(day, nonce)` + the self-resolver's keys. */
  sipaArgs: SipaDeployArgs | LegacySipaDeployArgs
  /** Self-resolution coordinates — regenerate the message secret and recovery key. */
  day: number
  nonce: number
  /** The ECDH shared secret (the claim's `sharedSecretSalt`). Re-derivable from `(day, nonce)`. */
  messageSecret: Fr
  burnTxHash: string
  grossAmount: bigint
  /** Net of the deposit fee, read from the portal `Deposit` event (or the SIPA `Sweep` log on resume). */
  forwardedAmount: bigint
  inboxIndex: bigint
}

type ExitState = Pick<
  IntraRollupMigrationResult,
  "sipaAddress" | "sipaArgs" | "day" | "nonce" | "messageSecret" | "burnTxHash" | "grossAmount"
>

/**
 * Where the migration stands, in the app's existing bridge vocabulary: the exit half is a
 * withdrawal, the enter half is a SIPA deposit, and the flow is their concatenation —
 * `finalizing_l1` hands off to `funded` when portal A's escrow lands at the SIPA.
 */
export type IntraRollupMigrationPhase = WithdrawalPhase | SIPADepositPhase

/**
 * A failure after the burn landed. `phase` is where the flow died; `exitState` carries the
 * self-resolution coordinates and the SIPA's CREATE2 preimage — everything re-derivable from
 * `(day, nonce)` plus the self-resolver's keys, so surface it for diagnostics and retry.
 */
export class IntraRollupMigrationError extends Error {
  constructor(
    readonly phase: IntraRollupMigrationPhase,
    readonly exitState: ExitState,
    options?: { cause?: unknown },
  ) {
    super(`intra-rollup migration failed at "${phase}" after the burn (funds recoverable)`, options)
    this.name = "IntraRollupMigrationError"
  }
}

/** Minimal persistence seam for {@link IntraRollupMigrationService.detectMigration} — the sdk owns
 *  no storage, so the app injects its adapter (localStorage, a Map in tests). */
export interface MigrationDetectionCache {
  get(key: string): Promise<string | null | undefined> | string | null | undefined
  set(key: string, value: string): Promise<void> | void
}

export interface MigrationDetection {
  changed: boolean
  current: OxideEnvTuple
  /** The retiring deployment's coordinates — exactly what the drain needs. Set only when changed. */
  previous?: OxideEnvTuple
  /** Persist `current` as the new baseline. Call AFTER acting on a change — until then, re-detects
   *  keep reporting the roll with the old coordinates intact. */
  acknowledge: () => Promise<void>
}

export interface IntraRollupMigrationArgs {
  account: Account
  /** Raw amount to migrate. Default: the account's full balance on the retiring token. */
  amount?: bigint
  /** The self-resolution nonce for the L2 day the migration lands on (see `selfSipaNonce`). */
  nonceForDay: (day: number) => number | Promise<number>
  /**
   * Publish the derived SIPA so the relayer learns it exists — in production the receive
   * flow's ClaimFPC-sponsored SIPA notification and L1-operation broadcast.
   * Runs before the burn; the service then WAITS for the relayer's sweep rather than sweeping
   * itself. Required because a self-derived SIPA is invisible to the relayer by construction —
   * an unbroadcast one leaves the withdrawal stranded at the SIPA (tests inject their relayer
   * stand-in here).
   */
  broadcastSipa: (sipa: SelfResolvedSipa) => Promise<void>
  /**
   * ClaimFPC sponsorship for the burn — fronts with no fee service (web) pass a thunk selecting
   * the RETIRED generation's FPC (the one whose policy pins the burning token). A thunk, built
   * immediately before the burn: `broadcastSipa` may have just initialized the account in its
   * own sponsored tx, and an eagerly built context would still carry the setup leg and revert
   * the batch. Omitted: the self-paid `exitToL1Private` path (sdk harness).
   */
  sponsor?: () => Promise<ClaimSponsorContext>
  /**
   * Test-only finalization stand-in, invoked once after the burn settles. Production OMITS
   * this: withdrawal finalization is oxide's relayer's job, and the service only detects the
   * escrow release. A sandbox vitest has no relayer, so its stand-in runs `withdrawPublished`
   * itself (retrying internally until the burn's checkpoint proves).
   */
  finalizeWithdrawal?: (exit: { burnTxHash: string; sipaAddress: Address }) => Promise<void>
  resolveSpendMetadata: SpendMetadataResolver
  resolveDepositSpendMetadata?: DepositSpendMetadataResolver
  /**
   * How to wait for the sweep's L1→L2 message. Default: `waitForL1ToL2MessageReady` (the chain
   * advances itself). Sandbox callers pass `waitForSandboxL1ToL2Message`.
   */
  waitForL1ToL2Message?: (messageHash: Fr, timeoutSeconds: number) => Promise<void>
  /**
   * One deadline for the whole `migrate` run, or for `settle`'s finalization, sweep, and readiness
   * waits when called alone. Default 30 min.
   */
  timeoutMs?: number
  /** Correlates the burn's proving events, so a caller can stamp its own record at submit. */
  operationId?: string
}

/** Output of {@link IntraRollupMigrationService.prepareExit}: priced and resolved. */
export interface PreparedMigrationExit {
  amount: bigint
  /** The ERC20 both portals escrow. */
  underlying: Address
  day: number
  resolved: SelfResolvedSipa
}

/** The burn's outcome: everything the arrival half needs, plus the burn's block. */
export type MigrationExit = ExitState & { burnBlockNumber?: number }

/** The pinned entry's pointer plus the network, so the canonical entry passes the boot-time mainnet gate. */
export interface PinnedManifestArgs {
  manifestUrl: string
  portal: string
  network: Network
  expectedGitSha?: string
  fetchImpl?: typeof fetch
}

/**
 * Same-rollup oxide deployment roll: moves an account's balance from a retiring portal/token pair
 * to the new one. The L2 token's portal binding is immutable in both directions, so migration is
 * exit-then-enter — but aimed at a NEW-DEPLOYMENT SIPA, the withdrawal re-enters in one L1 leg
 * with no custody stop at a user EOA:
 *
 *   self-resolve + broadcast the SIPA (injected seam) → burn on token A naming it as recipient →
 *   WAIT for oxide's relayer to finalize the withdrawal (escrow lands at the SIPA) and then to
 *   deploy+sweep it into portal B (Sweep-log detection, the clients' signal) → private claim on
 *   token B. The service never signs an L1 transaction.
 *
 * Distinct from `MigrationService` (rollup cutover: frozen portal, refund circuits). Here the
 * rollup never changes and the exit is the live withdraw path.
 *
 * The enter steps are detect-or-skip (SIPA balance check, Sweep-log read, store_deposit's
 * inbox-index dedup), so a run that dies mid-enter can be retried and converges on the same
 * claim. The burn itself is never retried.
 *
 * `migrate` runs all three steps in-process. A front that tracks the exit as a withdrawal record
 * and the arrival on its deposit rail calls `prepareExit` and `burn` and stops there.
 */
export class IntraRollupMigrationService {
  constructor(private readonly deps: IntraRollupMigrationDeps) {}

  /**
   * Fetch the oxide env manifest and return the pinned deployment alongside the other deployments
   * on its rollup. Every historic portal may still hold user funds — the historic tuples are the
   * residual probe's inputs, and `historic.length === 0` is the steady state that costs nothing.
   * No cache: unlike {@link detectMigration}, presence of other deployments is a manifest fact,
   * not a diff.
   */
  static async detectHistoricDeployments(
    args: PinnedManifestArgs,
  ): Promise<{ current: OxideEnvTuple; historic: OxideEnvTuple[] }> {
    const fetchImpl = args.fetchImpl ?? fetch
    const res = await fetchImpl(args.manifestUrl)
    if (!res.ok) {
      throw new Error(
        `detectHistoricDeployments: manifest fetch failed (${res.status}) at ${args.manifestUrl}`,
      )
    }
    const manifest = await res.json()
    const current = extractPinnedOxideEnvTuple(manifest, args, pinnedEntryPolicy(args)).tuple
    return { current, historic: migrationSources(manifest, current) }
  }

  /**
   * Fetch the oxide env manifest and report whether the pinned deployment rolled since the last
   * acknowledged look. A roll is a changed `portal` or `l2Token`. First run baselines
   * silently; a manifest older than the baseline (stale CDN read) is ignored rather than treated
   * as a rollback-roll.
   */
  static async detectMigration(
    args: PinnedManifestArgs & { cache: MigrationDetectionCache },
  ): Promise<MigrationDetection> {
    const fetchImpl = args.fetchImpl ?? fetch
    const res = await fetchImpl(args.manifestUrl)
    if (!res.ok) {
      throw new Error(
        `detectMigration: manifest fetch failed (${res.status}) at ${args.manifestUrl}`,
      )
    }
    const { tuple: current, timestampMs } = extractPinnedOxideEnvTuple(
      await res.json(),
      args,
      pinnedEntryPolicy(args),
    )

    const key = `intra-rollup-migration/last-tuple/${args.portal}@${args.manifestUrl}`
    const acknowledge = async () => {
      await args.cache.set(key, JSON.stringify(current))
    }

    const cachedRaw = await args.cache.get(key)
    if (!cachedRaw) {
      await acknowledge()
      return { changed: false, current, acknowledge }
    }
    const previous = JSON.parse(cachedRaw) as OxideEnvTuple

    // Stale read: never roll the baseline backwards or report a phantom migration.
    if (timestampMs < Date.parse(previous.timestamp)) {
      return { changed: false, current: previous, acknowledge: async () => {} }
    }

    const changed =
      previous.portal.toLowerCase() !== current.portal.toLowerCase() ||
      previous.l2Token.toLowerCase() !== current.l2Token.toLowerCase()
    if (!changed) {
      // Same deployment, possibly newer metadata — keep the baseline fresh.
      await acknowledge()
      return { changed: false, current, acknowledge }
    }
    return { changed: true, current, previous, acknowledge }
  }

  async migrate(args: IntraRollupMigrationArgs): Promise<IntraRollupMigrationResult> {
    const deadline = new Date(Date.now() + (args.timeoutMs ?? DEFAULT_TIMEOUT_MS))
    const prepared = await this.prepareExit(args)
    const exit = await this.burn(prepared, args)
    return this.settle(prepared, exit, { ...args, deadline })
  }

  /**
   * Everything before the burn: value continuity, the fee floor, and the deployment-B SIPA
   * resolved, and broadcast when `broadcastSipa` is given. A caller that omits it publishes the
   * address itself before the relayer can sweep it. Nothing moves.
   */
  async prepareExit(
    args: Pick<IntraRollupMigrationArgs, "account" | "amount" | "nonceForDay"> &
      Partial<Pick<IntraRollupMigrationArgs, "broadcastSipa">>,
  ): Promise<PreparedMigrationExit> {
    const { node, fromTokenService, to, publicClient, selfResolver } = this.deps

    const amount = args.amount ?? (await fromTokenService.getBalance(args.account))
    // The fee floor and the address must price off the same implementation, so resolve it once
    // here and hand it to both — the factory read is keyed by the destination portal.
    const rollupVersion = BigInt((await node.getNodeInfo()).rollupVersion)
    const implementation = await readDepositSIPAImplementation(
      publicClient as unknown as PublicClient,
      to.sipaFactory as Address,
      to.portal as Address,
    )
    const underlying = await this.assertMigratable(amount, implementation)

    // Self-resolve the deployment-B SIPA — the same helper as the receive flow's deposit
    // addresses, so the address is standard-shaped: derived message secret, derived recovery
    // key, and the resweepable flag self-broadcast commits to. It delegates to B's own deposit
    // implementation, which bakes in B's portal, so funds arriving there can only enter portal B.
    const block = await node.getBlock("latest" as never)
    if (!block) throw new Error("IntraRollupMigrationService: no L2 block — is the node running?")
    const day = epochDay(block.header.globalVariables.timestamp)
    const resolved = await selfResolver.resolveAddress({
      protocol: to.recoveryProtocol,
      user: args.account.getAddress(),
      recoveryAccount: this.deps.recoveryAccount,
      day,
      nonce: await args.nonceForDay(day),
      publicClient,
      sipaFactory: to.sipaFactory as Address,
      portal: to.portal as Address,
      rollupVersion,
    })

    // Publish the address so the relayer will sweep it once funded.
    await args.broadcastSipa?.(resolved)
    return { amount, underlying, day, resolved }
  }

  /**
   * Burn on the retiring token, naming the prepared SIPA. The token reads its own immutable
   * portal binding, so the burn can only message portal A. NOT idempotent — never retried.
   */
  async burn(
    prepared: PreparedMigrationExit,
    args: Pick<
      IntraRollupMigrationArgs,
      "account" | "sponsor" | "resolveSpendMetadata" | "resolveDepositSpendMetadata" | "operationId"
    >,
  ): Promise<MigrationExit> {
    const { fromTokenService, publicClient } = this.deps
    const { amount, day, resolved } = prepared
    const { sipaAddress, sipaArgs, resolution } = resolved
    const exitOptions = {
      userAccount: args.account,
      withdrawal: {
        tuple: this.deps.from,
        portal: await readPortalWithdrawalState(
          publicClient as unknown as PublicClient,
          this.deps.from.portal as Address,
        ),
      },
      useRawAmount: true,
      resolveSpendMetadata: args.resolveSpendMetadata,
      resolveDepositSpendMetadata: args.resolveDepositSpendMetadata,
      ...(args.operationId ? { operationId: args.operationId } : {}),
    }
    const settled = args.sponsor
      ? await fromTokenService.exitToL1PrivateSponsored(
          EthAddress.fromString(sipaAddress),
          amount.toString(),
          await args.sponsor(),
          { ...exitOptions, userAccount: args.account as ObsidionAccount },
        )
      : await (
          await fromTokenService.exitToL1Private(
            EthAddress.fromString(sipaAddress),
            amount.toString(),
            exitOptions,
          )
        ).txPromise
    if (settled.l1Recipient.toLowerCase() !== sipaAddress.toLowerCase()) {
      throw new Error(
        `IntraRollupMigrationService: burn recipient ${settled.l1Recipient} != predicted SIPA ${sipaAddress}`,
      )
    }
    return {
      sipaAddress,
      sipaArgs,
      day,
      nonce: resolution.nonce,
      messageSecret: resolution.messageSecret,
      burnTxHash: settled.txHash,
      grossAmount: amount,
      burnBlockNumber: settled.blockNumber === undefined ? undefined : Number(settled.blockNumber),
    }
  }

  /**
   * Everything after the burn, waited on in-process: the relayer's finalization, its sweep into
   * portal B, and the private claim on token B. Detect-or-skip throughout, so a retry converges.
   * A front that tracks the exit as a withdrawal and the arrival as a deposit stops after `burn`.
   */
  async settle(
    prepared: PreparedMigrationExit,
    exitState: MigrationExit,
    args: Pick<
      IntraRollupMigrationArgs,
      "account" | "finalizeWithdrawal" | "waitForL1ToL2Message" | "timeoutMs"
    > & { deadline?: Date },
  ): Promise<IntraRollupMigrationResult> {
    const { node, toTokenService, to, publicClient } = this.deps
    // `migrate` passes the deadline it set at its start, so its budget covers the burn too.
    const deadline = args.deadline ?? new Date(Date.now() + (args.timeoutMs ?? DEFAULT_TIMEOUT_MS))
    const { underlying } = prepared
    const { sipaAddress, sipaArgs, messageSecret } = exitState
    // Exit half done up to the L2 burn; every step below advances this marker, and a throw is
    // reported at whichever phase held it last.
    let phase: IntraRollupMigrationPhase = "finalizing_l1"
    try {
      // A self-broadcast-shaped SIPA is resweepable, so the contract's `swept` flag never sets —
      // Sweep-log presence is the "already swept" signal throughout.
      const alreadySwept = async () => (await getSipaSweeps(publicClient, sipaAddress)).length > 0

      // Finalization on portal A is oxide's relayer's job; the test seam stands in for it.
      await args.finalizeWithdrawal?.({ burnTxHash: exitState.burnTxHash, sipaAddress })

      // Detect the escrow release: the SIPA holds the withdrawn funds (or was already swept on
      // a resume). The withdrawal is "done" and the deposit is "funded" at the same instant.
      await retryUntil(
        async () => {
          const funded =
            (await publicClient.readContract({
              address: underlying,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [sipaAddress],
            })) > 0n
          return funded || (await alreadySwept()) || undefined
        },
        "awaitFinalization",
        { deadline },
      )

      // Escrow released — the withdrawal is "done" and the deposit is "funded". Deploying and
      // sweeping the funded SIPA is the RELAYER's job (it learned the address from the
      // broadcast); this service only detects that it happened, off the SIPA's Sweep log —
      // the same signal the clients' deposit tracking watches.
      phase = "sweeping"
      const sweep = await retryUntil(
        async () => (await getSipaSweeps(publicClient, sipaAddress)).at(-1),
        "awaitRelayerSweep",
        { deadline },
      )
      const forwardedAmount = sweep.amount
      const inboxIndex = sweep.index

      // Wait for the sweep's L1→L2 message to settle. The message hash is recomputed from the
      // Sweep log — no receipt needed, so a resume detects and claims identically.
      phase = "pendingClaim"
      const portalB = new OxidePortalContract(publicClient as unknown as ViemClient, to.portal)
      const messageHash = await computeDepositMessageHash(
        {
          l1Portal: portalB.address,
          l1ChainId: portalB.getChainId(),
          l2Portal: toTokenService.tokenAddress,
          rollupVersion: sipaArgs.rollupVersion,
        },
        {
          sharedSecretSalt: messageSecret,
          recipient: args.account.getAddress(),
          amount: forwardedAmount,
          messageLeafIndex: new Fr(inboxIndex),
        },
      )
      const remainingSeconds = (deadline.getTime() - Date.now()) / 1000
      if (remainingSeconds <= 0) {
        throw new Error("IntraRollupMigrationService.l1ToL2Message: timed out")
      }
      if (args.waitForL1ToL2Message) {
        await args.waitForL1ToL2Message(messageHash, remainingSeconds)
      } else {
        await waitForL1ToL2MessageReady(node, messageHash, { timeoutSeconds: remainingSeconds })
      }

      // Claim privately on token B — PXE-side capsule write, consumed on the next spend.
      await toTokenService.claimSweptDeposit({
        inboxIndex,
        amount: forwardedAmount,
        recipient: args.account.getAddress(),
        sharedSecretSalt: messageSecret,
      })

      return { ...exitState, forwardedAmount, inboxIndex }
    } catch (error) {
      throw new IntraRollupMigrationError(phase, exitState, { cause: error })
    }
  }

  /** Value continuity + fee floor, checked before anything moves. */
  private async assertMigratable(amount: bigint, implementation: Address): Promise<Address> {
    const { from, to, publicClient } = this.deps
    if (amount <= 0n) throw new Error("IntraRollupMigrationService: nothing to migrate")

    const client = publicClient as unknown as ViemClient
    const [underlyingA, underlyingB] = await Promise.all([
      new OxidePortalContract(client, from.portal as Hex).getUnderlying(),
      new OxidePortalContract(client, to.portal).getUnderlying(),
    ])
    // Both portals escrowing one ERC20 is deployment convention, not contract law — a mismatch
    // would strand the withdrawal at a SIPA whose portal expects a different asset.
    if (!underlyingA.equals(underlyingB)) {
      throw new Error(
        `IntraRollupMigrationService: portal underlyings differ (${underlyingA} vs ${underlyingB})`,
      )
    }
    const underlying = underlyingA.toString() as Address

    const fee = await readDepositFee(publicClient as unknown as PublicClient, implementation)
    // A sweep at or below the fee hard-reverts and strands the funds at the SIPA.
    if (amount <= fee) {
      throw new Error(
        `IntraRollupMigrationService: amount ${amount} does not clear the deposit fee ${fee}`,
      )
    }
    return underlying
  }
}
