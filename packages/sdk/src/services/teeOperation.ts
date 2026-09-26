import { BatchCall, Contract, ContractFunctionInteraction } from "@aztec/aztec.js/contracts"
import type { AztecNode } from "@aztec/aztec.js/node"
import { FeePaymentMethod } from "@aztec/aztec.js/fee"
import { Capsule } from "@aztec/stdlib/tx"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { Fr } from "@aztec/aztec.js/fields"
import { createLogger } from "@aztec/foundation/log"
import { EthAddress } from "@aztec/foundation/eth-address"
import { type ViemClient } from "@aztec/ethereum/types"
import type { Hex } from "viem"
import {
  buildNoteSignatureCapsule,
  buildPlainExecutorUserPayloadCapsules,
  buildSeedCapsule,
  buildStrictModeCapsule,
  buildTeeMetadataCapsule,
  buildTeeNotesCapsule,
  buildTeeRequiredNullifiersCapsule,
  buildTeeWithdrawalMessageHashesCapsule,
  buildWithdrawalSignatureCapsule,
} from "@oxide/oxide-client/capsules.js"
import type { Timeouts } from "@oxide/oxide-client/enclave_transport.js"
import { FleetSigner } from "@oxide/oxide-client/fleet_signer.js"
import { OxidePortalContract } from "@oxide/l1-contracts/oxide_portal.js"
import { assertPlainWithdrawals } from "@oxide/oxide-client/l2_operations.js"
import { declaredWithdrawals, type PlainWithdrawalContext } from "../oxide/plainWithdrawal.js"
import { computePublishDaLogEmittedLengths } from "../oxide/publishDaLogs.js"
import {
  type SpendMetadataResolver,
  type DepositSpendMetadataResolver,
  buildTokenOperation,
  collectAccountingEffects,
  type L2SubmitContext,
  type Operation,
} from "../oxide/index.js"
import { TEEMetadata, type SpentDeposit, type TeeSigner } from "@oxide/oxide-lib/types.js"
import {
  priceDeclaredEffectDeltas,
  type FinalizedPayload,
  type PayloadFinalizer,
} from "../obsidion/stagedExecution.js"
import { benchmarkRegistry } from "../obsidion/benchmark/benchmarkRegistry.js"
import { assertSigningKeyApproved, assertTeeSignerApproved } from "./teeSignerApproval.js"
import { benchNow } from "../obsidion/benchmark/proveTimingExtract.js"
import { readTimingBenchFlag } from "../obsidion/proving-progress-helpers.js"

// Re-export `TeeSigner` from the SDK barrel so front-core callers can consume
// it without depending on `@oxide/oxide-lib` directly.
export type { TeeSigner }

/**
 * Default network timeout for `RemoteTeeSigner.connect()` and subsequent
 * RPCs when callers don't override. The signer holds a single timeout for
 * both the background connect and every signing round-trip, so this must
 * leave headroom for the heavyweight sign RPC on a flaky network —
 * 10s was observed timing out real claims mid-dispatch. The oxide vendor
 * default is 60s; backend / script callers that want that ceiling can pass
 * `opts.timeoutMs` explicitly.
 */
const DEFAULT_TEE_SIGNER_TIMEOUT_MS = 20_000

/** Mirrors `ACCOUNT_MAX_CALLS` in `contracts/alpha/lib/src/payloads.nr` — the entrypoint AppPayload
 *  holds this many FunctionCalls. */
export const ACCOUNT_MAX_CALLS = 5

/**
 * Logger for the oxide-token / oxide TEE dispatch path. Surfaces enough
 * shape information (operation kinds, contract / signer addresses, anchor
 * hash, signature counts, batch-call selectors) to confirm at a glance that
 * a tx routed through the oxide pipeline (TEE-signed OxideToken op with
 * `publish_da` capsule fan-out) and not, say, a naive aztec.js path. NEVER
 * log raw signature bytes / nullifiers / TEE notes — the JSDoc on
 * `buildTeeOperation` documents those as nullifier-material-bearing and
 * must not leave the function.
 */
const teeOpLogger = createLogger("sdk:tee-op")

export interface LoadTeeSignerOptions {
  /** Override the attestation-fetch and/or sealed-operation timeouts. Defaults to oxide's
   *  30s / 180s — the operation budget has to cover tens of seconds of enclave CPU on a
   *  worst-case `signTokenOperation`. */
  timeouts?: Partial<Timeouts>
  /** Attempts (obtain a pin, then send) per operation before giving up. Defaults to 3. */
  maxAttempts?: number
  /**
   * Refuse the pinned enclave unless the token approved its key, read at the `latest` block. The
   * connect otherwise verifies the L1 binding only, and a wallet handed an unapproved pin would only
   * learn at sign time. Retrying the connect re-pins and can land on an approved enclave.
   */
  l2Approval?: { node: AztecNode; tokenAddress: AztecAddress }
}

/**
 * Connect a {@link FleetSigner} over the enclave fleet at `url`, pinning one enclave whose
 * boot attestation matches the on-chain TEE binding registered in the L1 `OxidePortal` at
 * `portalAddress`. Every registered enclave is an equal peer: the signer re-pins and retries
 * when the fleet reports its pin is gone, so the identity behind the returned signer can move.
 *
 * Throws when:
 *   - the binding does not exist (TEE never registered)
 *   - the binding's PCR0 is not in the portal's approved set
 *   - the attestation's `(secp256k1 pubkey, P-256 encryption pubkey)` do not match
 *     the binding's keys
 *   - the underlying HTTP `getAttestation` call times out or rejects
 *   - `opts.l2Approval` is set and the pinned key is not in the token's `approved_signers`
 *     (`TeeSignerNotApprovedError`); no signer is returned
 *
 * NOTE: the full Nitro COSE_Sign1 attestation is NOT re-verified client-side
 * by `connect()`. That verification was done L1-side at register-enclave
 * time; the client trusts the on-chain binding as the integrity root and
 * cross-checks the live attestation's keys against it. This is the intended
 * threat model — see the testnet TEE wiring plan for the trade-offs.
 *
 * @param url           Fleet router / enclave HTTP proxy endpoint (e.g.
 *                      `http://127.0.0.1:8080/rpc` for local dev or the EC2
 *                      proxy URL for testnet).
 * @param portalAddress L1 `OxidePortal` contract address (typically sourced
 *                      from `ContractService.getL1Addresses().portal`).
 * @param viemClient    Read-capable viem client targeting the L1 chain.
 * @param opts          Optional timeout / retry overrides.
 */
export async function loadTeeSigner(
  url: string,
  portalAddress: Hex | EthAddress,
  viemClient: ViemClient,
  opts?: LoadTeeSignerOptions,
): Promise<TeeSigner> {
  const portal = new OxidePortalContract(viemClient, portalAddress)
  const signer = await FleetSigner.connect(url, portal, {
    ...(opts?.timeouts ? { timeouts: opts.timeouts } : {}),
    ...(opts?.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
  })
  if (opts?.l2Approval) {
    const { node, tokenAddress } = opts.l2Approval
    const latest = await node.getBlockData("latest")
    if (!latest) throw new Error("loadTeeSigner: no latest block to read the enclave approval at")
    await assertTeeSignerApproved({
      node,
      tokenAddress,
      publicKey: signer.publicKey,
      blockHash: await latest.header.hash(),
    })
  }
  return signer
}

/**
 * Dedupe `AztecAddress[]` by stringified hex. Object-identity dedupe would
 * miss two `AztecAddress` instances built from the same hex (each call to
 * `AztecAddress.fromStringUnsafe(...)` returns a fresh object), so callers (this
 * module and `sendAndWait` in `ServiceBase.ts`) canonicalize via
 * `.toString()` before keying.
 */
export function dedupeByAddressString(addrs: AztecAddress[]): AztecAddress[] {
  return Array.from(new Map(addrs.map((a) => [a.toString(), a])).values())
}

/**
 * Sidecar options returned alongside the simulation-shape {@link BatchCall}
 * from {@link buildTeeOperation}. `BatchCall` has no `.with()` method, so the
 * caller receives these here and is responsible for merging them into the
 * final `.send(...)` options (`sendAndWait` does this for service callers;
 * `L2Claimer` spreads them directly).
 *
 * INVARIANT: `fee` must NOT include `gasSettings` — only `paymentMethod`. The
 * shallow-merge contract in `sendAndWait` relies on this: caller-provided
 * `gasSettings` survives a `{ ...callerFee, ...initFee }` merge precisely
 * because the helper does not overwrite that sub-key. If a future revision
 * needs to set `gasSettings` here, switch `sendAndWait`'s merge to an explicit
 * per-sub-key deep merge.
 */
export interface BuildTeeOperationSendOpts {
  fee?: { paymentMethod: FeePaymentMethod }
  additionalScopes?: AztecAddress[]
  /**
   * Staged-execution finalizer (see `obsidion/stagedExecution.ts`):
   * `ObsidionWallet.sendTx` invokes it with the result of its single
   * kernelless pre-simulation of the simulation-shape batch. The finalizer
   * collects the TEE-attested token effects from that result, runs the TEE
   * signing pipeline, assembles the production batch (signature + strict-mode
   * capsules on every op call, plus the closing `publish_da`), and returns
   * its `ExecutionPayload` together with the `Gas` delta of the `publish_da`
   * emissions (priced here via `priceDeclaredEffectDeltas`, which mirrors
   * the protocol's metering constants).
   *
   * MUST reach `wallet.sendTx` — dropping it silently would prove and submit
   * the simulation-shape batch (seed capsule only, no `publish_da`), whose
   * freshly-minted notes PXE drops during discovery.
   */
  finalize: PayloadFinalizer
}

/**
 * Result returned by {@link buildTeeOperation}. The function assembles the
 * simulation-shape `BatchCall` and a {@link PayloadFinalizer} — it performs
 * no simulation, no TEE signing, and does NOT dispatch. Callers route the
 * returned `batchCall` through `sendAndWait` (which goes through
 * `wallet.sendTx`); the wallet runs ONE kernelless simulation (authwit
 * capture + gas estimation + the TEE-attestation source, all in the same
 * pass) and invokes `sendOpts.finalize` with the result, then proves and
 * submits the finalized payload. The full pipeline (proving-progress emits,
 * withProvingScope, pendingTxStore) fires as for any other send.
 */
export interface BuildTeeOperationResult {
  batchCall: BatchCall
  sendOpts: BuildTeeOperationSendOpts
}

/**
 * Validate that the caller supplied a `resolveSpendMetadata` resolver on the
 * options bag. Throws a uniform error referencing the call-site label and the
 * two production-grade resolver factories.
 *
 * Used by every public method that ultimately dispatches through
 * {@link buildTeeOperation} with nullifying operations (transfer, withdraw,
 * paylink deposit). The TEE pipeline needs a resolver to hydrate nullified
 * notes into the spend metadata the signer attests over — calling
 * `buildTeeOperation` without one would throw deep inside the helper at a
 * less actionable point.
 */
export function requireSpendMetadataResolver(
  options: { resolveSpendMetadata?: SpendMetadataResolver },
  callerLabel: string,
): SpendMetadataResolver {
  const resolver = options.resolveSpendMetadata
  if (!resolver) {
    throw new Error(
      `[${callerLabel}] \`resolveSpendMetadata\` is required: the TEE dispatch helper needs a resolver to hydrate nullified notes for signing. Pass \`accountManager.makeSpendMetadataResolver()\` (ObsidionAccount) or \`buildSpendMetadata\`-backed resolver (Schnorr fixtures).`,
    )
  }
  return resolver
}

/**
 * Assemble a batched operation against one token as a *staged* send: the
 * simulation-shape `BatchCall` plus a {@link PayloadFinalizer} that maps the
 * wallet's pre-simulation result to the production (TEE-signed) payload. The
 * caller owns dispatch (so `wallet.sendTx` runs and the full
 * proving-progress / persist pipeline fires); the wallet owns the
 * single simulation that feeds BOTH the TEE attestation and its own
 * authwit-capture / gas-estimation pass, plus the PXE sync point and the
 * gas pricing of the finalize delta (see `obsidion/stagedExecution.ts`).
 *
 * For the `Operation` variants this helper batches (`transfer` / `withdraw` /
 * `outerCall`), see the canonical type definition at
 * `src/oxide/l2_operations.ts` — in particular the `outerCall` JSDoc, which
 * documents the cross-contract dispatch contract (no `from` field,
 * `additionalScopes` for outer-contract-owned notes, etc.).
 *
 * **Forked from** oxide-client's
 * `submit()` at `oxide/yarn-project/oxide-client/src/l2_operations.ts:115-272`.
 * Eventually upstreaming planned (deferred follow-up); until then this fork is
 * the authoritative dispatch path inside `@obsidion/sdk` for oxide-token
 * operations.
 *
 * Surgical edits applied vs. upstream `submit()`:
 *
 *   1. Renamed `submit` → `buildTeeOperation`; renamed second-positional
 *      param `from` → `batchSender` to make explicit that it's the
 *      tx originator, not necessarily the note-owning address.
 *   2. Dropped the `op.from === batchSender` assertion (upstream line 134).
 *      TEE-side `validateOwnerPreimage` provides the replacement guard for
 *      spend-bearing operations. THIS RELAXATION IS LOAD-BEARING for the
 *      paylink flavour: paylink claim/refund use `op.from = paylink.address`
 *      while `batchSender = claimer.account` / `depositor.account`. Do NOT
 *      restore the assertion — it would re-break paylink dispatch.
 *   3. Removed the final `BatchCall(...).send({ from, fee })` dispatch
 *      (upstream line 269). Returns the unsent simulation-shape `BatchCall`
 *      + a `sendOpts` sidecar (`fee`, `additionalScopes`, `finalize`)
 *      because `BatchCall` has no `.with()` method (verified at
 *      `aztec.js/src/contract/batch_call.ts`). The caller merges `sendOpts`
 *      into its final `.send()` call.
 *   4. `buildOperationCall` is now a required arg (closure). The local helper
 *      at upstream lines 86-97 is intentionally NOT carried over — callers
 *      pass their own (token side returns
 *      `tokenContract.methods.<transfer|withdraw>(...)`; paylink side returns
 *      `paylinkContract.methods.claim/refund_X(...)`).
 *   5. Added `additionalScopes?: AztecAddress[]` to `args`. Threaded into the
 *      returned `sendOpts` (and from there into the wallet's simulation and
 *      proving scopes). Token callers pass `undefined`; paylink callers pass
 *      `[paylinkContract.address]` so PXE can discover paylink-owned private
 *      notes during sim when `batchSender = claimer.account`.
 *   6. Renamed `args.contract` → `args.tokenContract` throughout the function
 *      signature, body destructure, and every internal reference. Clarifies
 *      that this is always the oxide-token contract (which owns
 *      `publish_da`), even when the per-op call goes
 *      through a different contract (paylink) supplied by the
 *      `buildOperationCall` closure.
 *   7. The upstream pre-simulation (`wallet.simulateTx` on the
 *      simulation-shape batch) is NOT performed here. The wallet already
 *      runs an equivalent kernelless simulation inside `sendTx` for authwit
 *      capture and gas estimation; duplicating it cost a full PXE pass
 *      (block sync + private execution + public simulation) per TEE
 *      dispatch. The TEE pipeline instead lives in `sendOpts.finalize`,
 *      which consumes the wallet's simulation result. Determinism makes
 *      this sound: the seed capsule derives note
 *      randomness from the seed, not the tx nonce, so the finalized batch
 *      reproduces exactly the notes the wallet's simulation produced and
 *      the TEE attested.
 *
 * INVARIANTS:
 *   - `sendOpts.fee` carries `paymentMethod` only — no `gasSettings`. The
 *     shallow-merge contract in `sendAndWait` relies on this.
 *   - `tokenOperation` and `signOutput` are nullifier-material-bearing
 *     objects: kept local to the finalizer closure and never returned.
 *     Callers must not log, persist, or propagate them beyond the immediate
 *     dispatch site.
 *   - The finalizer rejects with `TeeSignerNotApprovedError` when the key that
 *     signed is not in the token's `approved_signers` at the anchor block; no
 *     capsule or batch is built and nothing reaches `send`.
 */
export async function buildTeeOperation(
  ctx: L2SubmitContext,
  batchSender: AztecAddress,
  args: {
    tokenContract: Contract
    signer: TeeSigner
    operations: Operation[]
    /** Per-operation call builder. Callers supply a closure mapping
     *  `(op, capsules)` to the contract method invocation to insert into the
     *  batch (e.g. `tokenContract.methods.transfer(...)`
     *  or `paylinkContract.methods.claim(...)`), with `.with({ capsules })`
     *  attached. The closure replaces oxide's internal switch helper. */
    buildOperationCall: (op: Operation, capsules: Capsule[]) => ContractFunctionInteraction
    /** Resolves a nullification effect into the spend metadata the TEE needs.
     *  Optional — only required when the simulated batch produces at least
     *  one nullification (e.g. transfer or withdraw spends an existing note).
     *  A batch that only consumes a lazily-spent deposit (no note spend) can
     *  omit it; `buildTeeOperation` throws a clear error if a nullification
     *  shows up without a resolver. */
    resolveSpendMetadata?: SpendMetadataResolver
    /** Resolves a spent deposit's recipient into the metadata (address preimage
     *  + master nullifier hiding key) the TEE needs to key the deposit-message
     *  nullifier. Optional — only required when the simulated batch consumes at
     *  least one unspent deposit. */
    resolveDepositSpendMetadata?: DepositSpendMetadataResolver
    /** Extra addresses whose private state PXE should expose during the
     *  simulation. Required for paylink flavour where `batchSender =
     *  claimer.account` but the spent notes are owned by `paylink.address`. */
    additionalScopes?: AztecAddress[]
    teeUnsignedInteractions?: ContractFunctionInteraction[]
    /** The deployment's plain withdrawal executor and portal state. Required when the batch withdraws. */
    plainWithdrawal?: PlainWithdrawalContext
  },
): Promise<BuildTeeOperationResult> {
  const {
    tokenContract,
    signer,
    operations,
    buildOperationCall,
    resolveSpendMetadata,
    resolveDepositSpendMetadata,
    additionalScopes: argsAdditionalScopes,
  } = args
  if (operations.length === 0) {
    throw new Error("buildTeeOperation called with no operations")
  }
  const declared = declaredWithdrawals(operations)
  if (declared.length > 0 && !args.plainWithdrawal) {
    throw new Error(
      "buildTeeOperation: a withdrawal needs the deployment's plain withdrawal executor",
    )
  }
  assertPlainWithdrawals(declared, {
    plainWithdrawalExecutor: args.plainWithdrawal?.executor,
    fpcFundingCut: args.plainWithdrawal?.fpcFundingCut,
    portalFrozen: args.plainWithdrawal?.frozen,
  })

  const batchCallCount = operations.length + (args.teeUnsignedInteractions?.length ?? 0) + 1
  if (batchCallCount + 1 > ACCOUNT_MAX_CALLS) {
    throw new Error(
      `TEE batch of ${operations.length} operation(s) needs ${batchCallCount} entrypoint calls ` +
        `(operations + broadcasts + publish_da) plus the fee call, exceeding ACCOUNT_MAX_CALLS = ` +
        `${ACCOUNT_MAX_CALLS}. Split the operations across transactions.`,
    )
  }

  const { wallet, node, paymentMethod } = ctx
  const fee = paymentMethod ? { paymentMethod } : undefined

  // Time-perf benchmark TEE-leg span (docs/plans/2026-06-03-001, U3). Active
  // only when the flag is on AND the caller threaded a benchmark operationId
  // onto the ctx. The TEE pipeline lives in the finalizer now, so the span is
  // captured (and contributed) inside the closure below — never throws into
  // the flow.
  const timingBench = readTimingBenchFlag() && ctx.operationId !== undefined

  // Union `args.additionalScopes` with the per-op `additionalScopes` carried
  // by `outerCall` operations. Both feed the sim's key-validation oracle and
  // the returned `sendOpts.additionalScopes` (so the caller's `.send()` sees
  // the same scope set the sim was attested against). Dedupe by address
  // string so the same scope passed via both paths doesn't double-list.
  const additionalScopes = dedupeByAddressString([
    ...(argsAdditionalScopes ?? []),
    ...operations.flatMap((op) =>
      op.kind === "outerCall" && op.additionalScopes ? op.additionalScopes : [],
    ),
  ])

  const seedCapsule = buildSeedCapsule(tokenContract.address)

  // 1. Simulation-shape batch: [...ops] with only the deterministic-randomness
  // seed capsule. The wallet simulates this shape exactly once inside `sendTx`;
  // that single pass is its authwit/gas source AND the offchain-effects feed
  // the TEE attests over. The seed capsule derives note randomness from the
  // seed (not the tx nonce) — the token's randomness index lives in transient
  // storage, so no reset call opens the batch — and the finalized batch below
  // reproduces these notes bit-exactly.
  const simBatchCalls: ContractFunctionInteraction[] = []
  for (const op of operations) {
    simBatchCalls.push(buildOperationCall(op, [seedCapsule]))
  }

  simBatchCalls.push(...(args.teeUnsignedInteractions ?? []))

  // 2. Finalizer: consumes the wallet's simulation result and produces the
  // production payload. Everything TEE-related (effects collection, spend
  // metadata, signing, capsule assembly, publish_da) happens in here, on the
  // send path, exactly once. The simulation itself runs with the `from` of
  // the merged send options — every caller sets that to `batchSender`, which
  // this helper otherwise only uses for logging.
  const finalize: PayloadFinalizer = async (simResult): Promise<FinalizedPayload> => {
    const anchorBlockHeader = simResult.publicInputs.constants.anchorBlockHeader
    const anchorBlockHash = await anchorBlockHeader.hash()

    // 2a. Effects collection (filters offchain effects by contract address).
    const collected = collectAccountingEffects(tokenContract.address, simResult.offchainEffects)

    // Bridge assertions: spent deposits need an inbox membership witness fetched from the node.
    // Withdrawals flow through the offchain `WithdrawalEffect` the collector already parsed
    // (carrying the contract-derived per-withdrawal randomness + tips), so there is no
    // hand-rolled withdrawals accumulator here — `buildTokenOperation` sources them from
    // `collected.withdrawals`.
    const deposits: SpentDeposit[] = []
    if (collected.deposits.length > 0 && !resolveDepositSpendMetadata) {
      throw new Error(
        `buildTeeOperation: produced ${collected.deposits.length} spent deposit(s) but no resolveDepositSpendMetadata was supplied`,
      )
    }
    for (const spent of collected.deposits) {
      const witness = await node.getL1ToL2MessageMembershipWitness(
        anchorBlockHash,
        spent.messageHash,
      )
      if (!witness) {
        throw new Error(`No L1->L2 membership witness for deposit message ${spent.messageHash}`)
      }
      const [witnessLeafIndex, siblingPath] = witness
      if (witnessLeafIndex !== spent.inboxIndex) {
        throw new Error(
          `Deposit witness leaf index ${witnessLeafIndex} does not match deposit effect leaf index ${spent.inboxIndex}`,
        )
      }
      const metadata = await resolveDepositSpendMetadata!(spent.recipient)
      deposits.push({
        recipient: spent.recipient,
        recipientAddressPreimage: metadata.ownerAddressPreimage,
        masterNullifierHidingKey: metadata.masterNullifierHidingKey,
        amount: spent.amount,
        sharedSecretSalt: spent.sharedSecretSalt,
        messageLeafIndex: spent.inboxIndex,
        siblingPath: siblingPath.toTuple(),
      })
    }

    // Spend metadata for nullified notes.
    let spendMetadata: Awaited<ReturnType<SpendMetadataResolver>>[] = []
    if (collected.nullifiedNotes.length > 0) {
      if (!resolveSpendMetadata) {
        throw new Error(
          `buildTeeOperation: produced ${collected.nullifiedNotes.length} nullified note(s) but no resolveSpendMetadata was supplied`,
        )
      }
      spendMetadata = await Promise.all(collected.nullifiedNotes.map(resolveSpendMetadata))
    }

    // 2b. TokenOperation + TEE sign.
    // Destructure scalar fields immediately so the closures below capture
    // small locals instead of the full secret-bearing objects. Defense-in-depth
    // against accidental serialization in error-reporting paths — the load-
    // bearing security improvement is the API-boundary narrowing (these objects
    // never leave the finalizer).
    const tokenOperation = await buildTokenOperation(
      node,
      tokenContract.address,
      anchorBlockHeader,
      collected,
      spendMetadata,
      {
        deposits,
      },
    )
    // Pre-sign: confidence log that we routed through the oxide pipeline
    // before handing material to the TEE signer.
    teeOpLogger.info("requesting TEE signature", {
      tokenContract: tokenContract.address.toString(),
      batchSender: batchSender.toString(),
      operationKinds: operations.map((op) => op.kind),
      createdNotes: tokenOperation.createdNotes.length,
      nullifiedNotes: collected.nullifiedNotes.length,
      deposits: deposits.length,
      withdrawals: tokenOperation.withdrawals.length,
      anchorBlockHash: (await tokenOperation.anchorBlockHeader.hash()).toString(),
    })
    const t_enclave = timingBench ? benchNow() : 0
    const signOutput = await signer.signTokenOperation(tokenOperation)
    const enclaveMs = timingBench ? benchNow() - t_enclave : 0
    // Post-sign: shape only. Signature bytes / requiredNullifiers / teeNotes
    // are nullifier-material-bearing (per this function's INVARIANT) and must
    // not be logged.
    teeOpLogger.info("TEE signature received", {
      noteSignatures: signOutput.signatures.length,
      withdrawalSignatures: signOutput.withdrawalSignatures.length,
      requiredNullifiers: signOutput.requiredNullifiers.length,
      teeNotes: signOutput.teeNotes.length,
      withdrawalMessageHashes: signOutput.withdrawalMessageHashes.length,
      signerEthAddress: signer.ethAddress.toString(),
    })
    const {
      signatures,
      requiredNullifiers,
      teeNotes,
      withdrawalMessageHashes,
      withdrawalSignatures,
    } = signOutput
    const { createdNotes, withdrawals } = tokenOperation
    const opAnchorBlockHeader = tokenOperation.anchorBlockHeader

    // The key that signed, checked before any capsule or batch exists; the recipient's PXE would
    // drop every note signed by an unapproved key. The TEE metadata capsule carries this same key.
    const signerPublicKey = await assertSigningKeyApproved({
      signer,
      node,
      tokenAddress: tokenContract.address,
      blockHash: anchorBlockHash,
    })

    // 2c. Assemble the production batch.
    // Real signature capsules cover post-squash insertions; dummies cover transient pairs.
    const sigCapsules = await Promise.all(
      createdNotes.map((note, j) =>
        buildNoteSignatureCapsule(tokenContract.address, note.randomness, signatures[j]!),
      ),
    )
    const dummyCapsules = await Promise.all(
      collected.squashedTransientNotes.map((note) =>
        buildNoteSignatureCapsule(tokenContract.address, note.randomness, {
          sLo: Fr.zero(),
          sHi: Fr.zero(),
          rLo: Fr.zero(),
          rHi: Fr.zero(),
        }),
      ),
    )

    // `publish_withdrawal` (called from `withdraw`) reads the withdrawal signature from a
    // capsule keyed by the withdraw content hash and emits it in the published withdrawal log,
    // so a third party can finalize on L1 from just the burn tx hash. The withdrawals come from
    // `tokenOperation.withdrawals` (contract-walk order, carrying the contract-derived
    // randomness + tips), so `buildWithdrawalSignatureCapsule` recomputes the same content hash
    // the contract's submit-pass lands on. NOTE for the gas delta: `publish_withdrawal` emits
    // its private log in BOTH the simulation shape (zeroed signature) and this production shape
    // (real signature) — same emittedLength — so it does not contribute to `gasDelta`.
    const withdrawalSigCapsules = await Promise.all(
      withdrawals.map((withdrawal, k) =>
        buildWithdrawalSignatureCapsule(
          tokenContract.address,
          withdrawal,
          withdrawalSignatures[k]!,
        ),
      ),
    )

    // The relayer rebuilds each withdrawal's user payload from the recipient and relayer tip these
    // capsules publish (TEMPORARY upstream, OX-1700).
    if (declared.length === 0 && withdrawals.length > 0) {
      throw new Error("buildTeeOperation: the batch withdraws without declaring its user payloads")
    }
    const userPayloadCapsules = await buildPlainExecutorUserPayloadCapsules(
      tokenContract.address,
      withdrawals,
      declared.map((withdrawal) => withdrawal.userPayload),
      args.plainWithdrawal?.executor,
    )

    const realCallCapsules = [
      seedCapsule,
      buildStrictModeCapsule(tokenContract.address),
      ...sigCapsules,
      ...dummyCapsules,
      ...withdrawalSigCapsules,
      ...userPayloadCapsules,
    ]

    const teeMetadata = TEEMetadata.fromPublicKey(signerPublicKey, await opAnchorBlockHeader.hash())
    const realBatchCalls: ContractFunctionInteraction[] = []
    for (const op of operations) {
      realBatchCalls.push(buildOperationCall(op, realCallCapsules))
    }
    realBatchCalls.push(...(args.teeUnsignedInteractions ?? []))
    realBatchCalls.push(
      tokenContract.methods.publish_da!().with({
        capsules: [
          buildTeeNotesCapsule(tokenContract.address, teeNotes),
          buildTeeRequiredNullifiersCapsule(tokenContract.address, requiredNullifiers),
          buildTeeMetadataCapsule(tokenContract.address, teeMetadata),
          buildTeeWithdrawalMessageHashesCapsule(tokenContract.address, withdrawalMessageHashes),
        ],
      }),
    )

    // Declared gas delta: `publish_da` is the ONLY emission difference
    // between the simulated shape and this production shape — a purely
    // private function whose side effects are the DA-component private logs
    // mirrored by `computePublishDaLogEmittedLengths`. The finalize contract
    // takes the delta as `Gas` (public-call additions couldn't be expressed
    // as effect counts), so this finalizer prices its private-log emissions
    // itself with the protocol-constants helper. Strict mode and the
    // signature capsules change only oracle reads / in-circuit checks, never
    // emissions. The kernel tail (in-circuit) and the wallet's
    // pre-submission guard verify the proven tx against the summed limits.
    const publishDaLogLengths = computePublishDaLogEmittedLengths({
      teeNotes: teeNotes.length,
      requiredNullifiers: requiredNullifiers.length,
      withdrawalMessageHashes: withdrawalMessageHashes.length,
      metadataFields: teeMetadata.toFields().length,
    })
    const gasDelta = priceDeclaredEffectDeltas({
      privateLogEmittedLengths: publishDaLogLengths,
    })

    // Pre-return: confirms the assembled exec payload includes
    // the per-op call(s) and the closing `publish_da` (which fans out the four
    // DA capsules — TEE notes, required nullifiers, TEE metadata, withdrawal
    // message hashes). If `publish_da` is missing from the layout below, the tx is NOT
    // going through the oxide pipeline and PXE will drop the freshly-minted
    // note during discovery. Layout is deterministic from how this function
    // builds `realBatchCalls`, so it's logged structurally (the underlying
    // `ContractFunctionInteraction.request()` is async and would force this
    // confidence log to be lazy).
    teeOpLogger.info("assembled exec payload", {
      tokenContract: tokenContract.address.toString(),
      callLayout: [...operations.map((op) => `op:${op.kind}`), "publish_da"],
      totalCalls: realBatchCalls.length,
      perCallCapsulesOnOps: realCallCapsules.length,
      publishDaCapsules: 4, // teeNotes, requiredNullifiers, teeMetadata, withdrawalMessageHashes
      sigCapsules: sigCapsules.length,
      dummyCapsules: dummyCapsules.length,
      withdrawalSigCapsules: withdrawalSigCapsules.length,
      declaredPrivateLogLengths: publishDaLogLengths,
      gasDelta: { daGas: gasDelta.daGas, l2Gas: gasDelta.l2Gas },
    })

    // Bake the fee leg with the same `fee` the simulation-shape batch was
    // sent with — `sendTx` computed its fee options from the simulated
    // payload's feePayer and asserts the finalized payload matches.
    const payload = await new BatchCall(wallet, realBatchCalls).request({ fee })

    // Benchmark TEE-leg contribution, at the END of the finalizer so a throw
    // anywhere above leaves no partial in the registry. The registry
    // auto-finalizes once the prove leg (sendTx, post-submit) reports for the
    // same operationId. `contributeTee` is internally defensive — it never
    // throws into this flow.
    if (timingBench && ctx.operationId) {
      benchmarkRegistry.contributeTee(ctx.operationId, {
        flow: ctx.benchmarkFlow ?? "send",
        enclave: enclaveMs,
        notesUsed: collected.nullifiedNotes.length,
      })
    }

    return { payload, gasDelta }
  }

  return {
    batchCall: new BatchCall(wallet, simBatchCalls),
    sendOpts: { fee, additionalScopes, finalize },
  }
}
