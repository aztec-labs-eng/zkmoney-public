/**
 * TEE signer-registration choreography.
 *
 * Drives the L1 → L2 round trip that takes a `LocalTeeSigner` from
 * "key material exists in process" to "approved on L2 and ready to attest
 * notes / withdrawals":
 *
 *   1. `decodeAttestationTbs(fixture.attestationCose)` — pure-TS split of the
 *      COSE_Sign1 doc into the (Sig_structure bytes, keccak, signature) triple
 *      that `registerTee` + the attestation-staging entry points expect.
 *   2. `portal.approveTeePcr0(hashPcr0(pcr0))` — owner-only; allowlists the
 *      fixture's PCR0 so the validator accepts.
 *   3. Stage the Nitro CA intermediates + leaf cert + COSE-Sign1 verify
 *      (SHA-384, then ECDSA-P384) on the portal's cert manager / validator via
 *      `verifyTeeCACert` / `verifyTeeClientCert` / `verifyTeeAttestationHash` /
 *      `verifyTeeAttestationSig`. Under EIP-7883 (osaka) per-tx gas limits the
 *      attestation can't be verified inline in `registerTee`, so the verify is
 *      split across these staging calls first; `registerTee` then only does
 *      CBOR parsing + storage writes (it still validates the attestation, but
 *      against the pre-staged cert + COSE state).
 *   4. `portal.registerTee(tbs, signature, pubX, pubY, encX, encY)`
 *      — permissionless; validates attestation, emits `TEEAdded`, enqueues
 *      an L1→L2 `register_signer` message in the inbox. The portal derives
 *      the eth address from the secp256k1 pubkey on-chain — callers no
 *      longer pass it explicitly. The encryption key is a P-256 `(X, Y)` pair
 *      sourced from the signer's `encryptionPublicKey`.
 *   5. Wait for the L1→L2 message to be consumable (sandbox: advance blocks
 *      by submitting empty txs; testnet: poll readiness).
 *   6. `bridge.consume_signer_registration(xHi, xLo, yHi, yLo, leafIndex)` from
 *      the admin L2 account — writes `approved_signers[poseidon2(x,y)] = true`
 *      at storage slot 4. The secp256k1 coordinates are split into (hi, lo)
 *      128-bit-bounded field halves via `splitSecpCoord`.
 *
 * Steps 1-4 are {@link registerTeeSignerOnL1}, steps 5-6 are
 * {@link consumeTeeSignerRegistrationOnL2}; {@link registerTeeSigner} runs both. Stopping after
 * the L1 half reproduces an enclave the portal knows but the token has not approved, the state the
 * wallet-side approval gate refuses.
 *
 * Mirrors the staging sequence in
 * `vendor/oxide/yarn-project/end-to-end-oxide/src/test_utils/portal_factory.ts`.
 * Differs in two places: (a) we use `waitForL1ToL2MessageConsumable` rather than
 * oxide's rollup-aware `makeInboxMessageConsumable` because obsidion's
 * sandbox infra is RollupSetup-free; (b) the caller-supplied admin account,
 * not a test-fixture deployer, sends the L2 consume tx.
 */

import { AztecAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { createLogger, type Logger } from "@aztec/foundation/log"
import { Gas, GasSettings } from "@aztec/stdlib/gas"
import type { BaseAccount } from "@aztec/aztec.js/account"
import type { FeePaymentMethod } from "@aztec/aztec.js/fee"
import type { Hex } from "viem"
import { isL1ToL2MessageReady } from "@aztec/aztec.js/messaging"

import type { OxidePortalContract, TEEAddedEvent } from "@oxide/l1-contracts"
import { splitSecpCoord } from "@oxide/oxide-lib/types.js"
import { decodeAttestationTbs } from "@oxide/oxide-lib/attestation/attestation_tbs.js"
import { getCertStagingEntries } from "@oxide/oxide-lib/attestation/cabundle.js"
import { hashPcr0 } from "@oxide/oxide-lib/attestation/pcr0.js"
import type { TestAttestationFixture } from "./gen_test_attestation.js"

import { OxideTokenContract } from "@obsidion/contracts"
import { Network, type NetworkType } from "../../../src/index.js"
import { getBlockBaseMaxFees, waitForSandboxL1ToL2Message } from "../../../src/utils/helper.js"
import type { ObsidionWalletBackend } from "../../../src/obsidion/ObsidionWalletBackend.js"
import type { ContractArtifact } from "@aztec/stdlib/abi"
import type { ExtendedViemWalletClient } from "@aztec/ethereum/types"

import type { ITEESigner } from "./ITEESigner.js"
import { SANDBOX_URL } from "../constants.js"

export interface RegisterTeeSignerOnL1Params {
  /** The signer whose keys get registered. Must already have its portal context
   *  pointing at the deployed (portal, l2Portal, rollupVersion) tuple. */
  signer: ITEESigner
  /** Typed portal wrapper returned by `deployBridgeContractsWithRealNitro`. */
  portal: OxidePortalContract
  /** Nitro attestation fixture bound to the signer's keys (also from the deploy step). */
  fixture: TestAttestationFixture
  /** Extended viem client retained for caller compatibility; the L1 portal
   *  reads + writes now go through the typed `portal` wrapper's own client. */
  l1Client: ExtendedViemWalletClient
  /** Network kind — drives the sandbox time warp. */
  network: NetworkType
  /** Optional logger override; defaults to `createLogger("registerTeeSigner")`. */
  logger?: Logger
}

export interface ConsumeTeeSignerRegistrationParams {
  signer: ITEESigner
  /** Inbox leaf of the `register_signer` message, from the `TEEAdded` event. */
  registration: Pick<TEEAddedEvent, "messageKey" | "leafIndex">
  /** Deployed L2 bridge address — `consume_signer_registration` runs on this contract. */
  l2BridgeAddress: AztecAddress
  /** L2 bridge artifact for instantiating `OxideTokenContract.at(...)`. */
  bridgeArtifact: ContractArtifact
  /** Aztec wallet backend that owns the `relayerAccount` PXE / sim infra. */
  wallet: ObsidionWalletBackend
  /** L2 account that submits the `consume_signer_registration` tx. */
  relayerAccount: BaseAccount
  /** Network kind — drives the sandbox-mode block advancement loop. */
  network: NetworkType
  /** Fee method for the L2 consume tx. */
  feePaymentMethod?: FeePaymentMethod
  /** Max seconds to wait for the L1→L2 message to become consumable. Default 300. */
  timeoutSeconds?: number
  logger?: Logger
}

export interface RegisterTeeSignerParams
  extends RegisterTeeSignerOnL1Params,
    Omit<ConsumeTeeSignerRegistrationParams, "registration"> {
  /** Address of the deployed `NitroValidator`. */
  nitroValidatorAddress: Hex
}

/**
 * Run the full L1+L2 registration sequence for `signer`. Idempotent on the
 * L1 side: re-running against an already-approved PCR0 / already-registered
 * TEE will revert at the `registerTee` step with `TeeAlreadyRegistered`.
 * Callers that need resumability should check `portal.read.$bindings(...)` first.
 */
export async function registerTeeSigner(params: RegisterTeeSignerParams): Promise<void> {
  const logger = params.logger ?? createLogger("registerTeeSigner")
  const registration = await registerTeeSignerOnL1({ ...params, logger })
  await consumeTeeSignerRegistrationOnL2({ ...params, registration, logger })
}

/**
 * L1 half: allowlist the PCR0, stage the cert chain, `registerTee`. Returns the inbox leaf the L2
 * consume needs. Re-staging a chain the cert manager already verified is a no-op, so a second
 * enclave under the same root only adds its own leaf.
 */
export async function registerTeeSignerOnL1(
  params: RegisterTeeSignerOnL1Params,
): Promise<TEEAddedEvent> {
  const logger = params.logger ?? createLogger("registerTeeSigner")
  const { signer, portal, fixture } = params
  const pcr0 = fixture.summary.pcr0

  // The fixture's certs and COSE timestamp are minted against the wall clock, but the cert
  // manager and staleness checks read L1 block.timestamp — and an idle sandbox chain lags wall
  // time (slot-aligned timestamps advance only when blocks are mined), so fresh certs revert
  // "certificate not valid yet". The node's warp goes through the automine sequencer, which owns
  // L1 time, so it cannot race the sequencer's own timestamps or another file's warp, and
  // "at least" makes it a no-op on a chain already past wall time.
  if (params.network === Network.SANDBOX) {
    const nowTs = Math.ceil(Date.now() / 1000)
    if (Number((await params.l1Client.getBlock()).timestamp) < nowTs) {
      logger.info(`Warping sandbox time to at least ${nowTs}`)
      const res = await fetch(SANDBOX_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "nodeDebug_warpL2TimeAtLeastTo",
          params: [nowTs],
        }),
      })
      const body = (await res.json()) as { error?: { message?: string } }
      if (body.error) throw new Error(`nodeDebug_warpL2TimeAtLeastTo: ${body.error.message}`)
    }
  }

  // Step 1: split COSE_Sign1 into (Sig_structure bytes, keccak, signature) in
  // pure TS — mirrors `NitroValidator.decodeAttestationTbs` byte-for-byte, so
  // the staging-map key the portal recomputes agrees. No L1 round trip.
  const { attestationTbs, attestationTbsKeccak, signature } = decodeAttestationTbs(
    fixture.attestationCose,
  )

  // Step 2: PCR0 allowlist entry. `hashPcr0` is keccak256 of the 48-byte PCR0;
  // matches what `TEERegistrationLib._verifyAttestationTbs` recomputes.
  const pcr0Hash = hashPcr0(pcr0)
  logger.info(`Allowlisting PCR0 ${pcr0Hash.toString()} on portal ${portal.address.toString()}`)
  await portal.approveTeePcr0(pcr0Hash, { waitForReceipt: true })

  // Step 3: stage the Nitro CA intermediates + leaf cert + COSE-Sign1 verify
  // (SHA-384, then ECDSA-P384) before `registerTee`. Under EIP-7883 (osaka)
  // per-tx gas limits the leaf P-384 verify (~9M gas) + COSE verify don't fit
  // inline in `registerTee`, so they're pre-staged in the cert manager /
  // validator here; `registerTee` then only does CBOR parsing + storage writes
  // (it still validates the attestation, against this staged state).
  logger.info(`Staging attestation cert chain + COSE verify on portal ${portal.address.toString()}`)
  const { ca, client, leafCertHash } = getCertStagingEntries(fixture.attestationCose)
  for (const { cert, parentCertHash } of ca) {
    await portal.verifyTeeCACert(cert, parentCertHash, { waitForReceipt: true })
  }
  await portal.verifyTeeClientCert(client.cert, client.parentCertHash, { waitForReceipt: true })
  await portal.verifyTeeAttestationHash(attestationTbs, { waitForReceipt: true })
  await portal.verifyTeeAttestationSig(attestationTbsKeccak, signature, leafCertHash, {
    waitForReceipt: true,
  })

  // Step 4: register on L1. Decoded TEEAdded event carries the inbox key+leaf
  // we need to consume on L2. The portal derives the eth address on-chain
  // from the secp256k1 pubkey, and binds the enclave's P-256 encryption key
  // as an `(X, Y)` coordinate pair.
  logger.info(
    `Registering TEE: eth=${signer.ethAddress.toString()}, pubKeyX=${signer.publicKey.x.toString()}`,
  )
  const { event: teeAdded } = await portal.registerTee(
    attestationTbs,
    signature,
    signer.publicKey.x,
    signer.publicKey.y,
    signer.encryptionPublicKey.x,
    signer.encryptionPublicKey.y,
    { waitForReceipt: true },
  )
  if (!teeAdded) {
    throw new Error("registerTeeSigner: TEEAdded event missing from L1 receipt")
  }
  logger.info(
    `TEEAdded: messageKey=${teeAdded.messageKey.toString()}, leafIndex=${teeAdded.leafIndex}`,
  )
  return teeAdded
}

/** L2 half: wait for the inbox message, then `consume_signer_registration` from the relayer account. */
export async function consumeTeeSignerRegistrationOnL2(
  params: ConsumeTeeSignerRegistrationParams,
): Promise<void> {
  const logger = params.logger ?? createLogger("registerTeeSigner")
  const timeoutSeconds = params.timeoutSeconds ?? 300
  const { signer, l2BridgeAddress } = params
  const { messageKey, leafIndex } = params.registration

  // Step 5: wait for the L1→L2 register_signer message to be consumable.
  // `messageKey` from the TEEAdded event is what `Inbox.sendL2Message`
  // returned — i.e. the inbox leaf hash (the "message hash" in
  // `isL1ToL2MessageReady` terminology). Pass it directly; do NOT rebuild
  // a new L1ToL2Message from it (it is not a contentHash — that's the
  // inner field of the message, and double-hashing it produces a value
  // the node never sees).
  await waitForL1ToL2MessageConsumable({
    wallet: params.wallet,
    adminAccount: params.relayerAccount,
    messageHash: messageKey,
    network: params.network,
    feePaymentMethod: params.feePaymentMethod,
    timeoutSeconds,
    logger,
  })

  // Step 6: consume on L2 — flips `approved_signers[poseidon2(x,y)]` to true.
  logger.info("Consuming registration message on L2")
  const bridge = OxideTokenContract.at(l2BridgeAddress, params.bridgeArtifact, params.wallet)

  // Price against the block base fee, not just the min-fee floor, or the sequencer drops the
  // L2 consume tx as underpriced; see getBlockBaseMaxFees. v5 GasSettings.fallback requires
  // explicit gasLimits — source them from the network's per-tx gas ceiling.
  const maxFeesPerGas = await getBlockBaseMaxFees(params.wallet.node)
  const { txsLimits } = await params.wallet.node.getNodeInfo()
  const gasSettings = GasSettings.fallback({
    maxFeesPerGas,
    gasLimits: Gas.from(txsLimits.gas),
  })
  const sendOptions = {
    from: params.relayerAccount.getAddress(),
    fee: params.feePaymentMethod
      ? { paymentMethod: params.feePaymentMethod, gasSettings }
      : { gasSettings },
  }

  // Split secp256k1 coords into (hi, lo) 128-bit-bounded field halves.
  // L2 verifier expects the 4-field representation; `splitSecpCoord` is the
  // canonical helper.
  const { hi: pubKeyXHi, lo: pubKeyXLo } = splitSecpCoord(signer.publicKey.x)
  const { hi: pubKeyYHi, lo: pubKeyYLo } = splitSecpCoord(signer.publicKey.y)

  const { receipt } = await bridge.methods
    .consume_signer_registration(pubKeyXHi, pubKeyXLo, pubKeyYHi, pubKeyYLo, new Fr(leafIndex))
    .send(sendOptions)

  logger.info(`consume_signer_registration landed in tx ${receipt.txHash.toString()}`)
}

/**
 * Wait until the L1→L2 register_signer message can be consumed on L2.
 * Sandbox mode advances blocks via `waitForSandboxL1ToL2Message`; production polls readiness.
 *
 * The `messageHash` is the inbox leaf hash returned by
 * `Inbox.sendL2Message` (and re-emitted in the `TEEAdded` event's
 * `messageKey` field). Aztec's `isL1ToL2MessageReady(node, leafHash)`
 * checks the tree membership against that leaf directly.
 */
async function waitForL1ToL2MessageConsumable(args: {
  wallet: ObsidionWalletBackend
  adminAccount: BaseAccount
  messageHash: Fr
  network: NetworkType
  feePaymentMethod?: FeePaymentMethod
  timeoutSeconds: number
  logger: Logger
}): Promise<void> {
  const { wallet, adminAccount, messageHash, network, logger } = args

  logger.info(`Waiting for L1→L2 message ${messageHash.toString()} to be consumable...`)

  if (network === Network.SANDBOX) {
    await waitForSandboxL1ToL2Message(wallet as never, adminAccount, messageHash, {
      timeoutSeconds: args.timeoutSeconds,
      feePaymentMethod: args.feePaymentMethod,
    })
    logger.info("L1→L2 message is consumable")
    return
  }

  const deadline = Date.now() + args.timeoutSeconds * 1000
  while (Date.now() < deadline) {
    const ready = await isL1ToL2MessageReady(wallet.node, messageHash)
    if (ready) {
      logger.info("L1→L2 message is consumable")
      return
    }
    await new Promise((r) => setTimeout(r, 10000))
  }
  throw new Error(
    `registerTeeSigner: timed out waiting for L1→L2 register_signer message ${messageHash.toString()} after ${
      args.timeoutSeconds
    }s`,
  )
}
