/**
 * TEE signer registration on the L1 `TeeRegistry`:
 *
 *   1. `decodeAttestationTbs(fixture.attestationCose)` splits the COSE_Sign1 doc into the
 *      (Sig_structure bytes, keccak, signature) triple the registry takes.
 *   2. Stage the Nitro CA intermediates, the leaf cert and the COSE-Sign1 verify on the registry's
 *      cert manager and validator. Under EIP-7883 per-tx gas limits the attestation cannot be
 *      verified inline in `registerTee`, which then checks it against the staged state.
 *   3. `registerTee(tbs, signature, pubX, pubY, encX, encY)` records the keys and sends the
 *      registration message to L2. The registry derives the eth address from the secp256k1 key.
 *
 * The registry accepts only the PCR0 it was deployed with. A signer is usable once its registration
 * message is in the L1->L2 message tree: {@link awaitTeeRegistrationMessage}.
 */

import type { Fr } from "@aztec-labs/aztec.js/fields"
import { isL1ToL2MessageReady } from "@aztec-labs/aztec.js/messaging"
import type { ExtendedViemWalletClient } from "@aztec-labs/ethereum/types"
import { createLogger, type Logger } from "@aztec-labs/foundation/log"
import type { Hex } from "viem"

import { TeeRegistryAbi, type TeeRegistryContract } from "@oxide/l1-contracts"
import { decodeAttestationTbs } from "@oxide/oxide-lib/attestation/attestation_tbs.js"
import { getCertStagingEntries } from "@oxide/oxide-lib/attestation/cabundle.js"
import type { EnclaveIdentity } from "@oxide/oxide-lib/types.js"

import { Network, type NetworkType } from "../../../src/index.js"
import { waitForSandboxL1ToL2Message } from "../../../src/utils/helper.js"
import type { ObsidionWallet } from "../../../src/obsidion/ObsidionWallet.js"
import { SANDBOX_URL } from "../constants.js"
import type { TestAttestationFixture } from "./gen_test_attestation.js"

export interface RegisterTeeSignerParams {
  signer: EnclaveIdentity
  teeRegistry: TeeRegistryContract
  /** Nitro attestation fixture bound to the signer's keys. */
  fixture: TestAttestationFixture
  l1Client: ExtendedViemWalletClient
  /** Drives the sandbox time warp. */
  network: NetworkType
  logger?: Logger
}

/** The registration message the registry sent to L2 for a signer, and its leaf in the L1->L2 tree. */
export interface TeeRegistration {
  messageKey: Fr
  leafIndex: bigint
}

/**
 * Register `signer` on the `TeeRegistry`. Re-staging a chain the cert manager already verified is a
 * no-op, so a second enclave under the same root only adds its own leaf.
 */
export async function registerTeeSigner(params: RegisterTeeSignerParams): Promise<TeeRegistration> {
  const logger = params.logger ?? createLogger("registerTeeSigner")
  const { signer, teeRegistry, fixture } = params

  // The fixture's certs and COSE timestamp are minted against the wall clock, but the cert manager
  // and staleness checks read L1 block.timestamp, and an idle sandbox chain lags wall time. The
  // node's warp goes through the automine sequencer, which owns L1 time, so it cannot race the
  // sequencer's own timestamps; "at least" makes it a no-op on a chain already past wall time.
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

  const { attestationTbs, attestationTbsKeccak, signature } = decodeAttestationTbs(
    fixture.attestationCose,
  )

  logger.info(`Staging the attestation cert chain on TeeRegistry ${teeRegistry.address}`)
  const { ca, client, leafCertHash } = getCertStagingEntries(fixture.attestationCose)
  for (const { cert, parentCertHash } of ca) {
    await teeRegistry.verifyTeeCACert(cert, parentCertHash, { waitForReceipt: true })
  }
  await teeRegistry.verifyTeeClientCert(client.cert, client.parentCertHash, {
    waitForReceipt: true,
  })
  await teeRegistry.verifyTeeAttestationHash(attestationTbs, { waitForReceipt: true })
  await teeRegistry.verifyTeeAttestationSig(attestationTbsKeccak, signature, leafCertHash, {
    waitForReceipt: true,
  })

  logger.info(`Registering TEE ${signer.ethAddress}`)
  // registerTee sends an Inbox message. A tx mined in a later second than its estimate opens a new
  // Inbox bucket and needs about 40k more gas, so pad the estimate. This vendored
  // TeeRegistryContract drops `gas`, so send the call here.
  const call = {
    address: teeRegistry.address.toString() as Hex,
    abi: TeeRegistryAbi,
    functionName: "registerTee",
    args: [
      `0x${attestationTbs.toString("hex")}`,
      `0x${signature.toString("hex")}`,
      signer.publicKey.x.toString() as Hex,
      signer.publicKey.y.toString() as Hex,
      signer.encryptionPublicKey.x.toString() as Hex,
      signer.encryptionPublicKey.y.toString() as Hex,
    ],
  } as const
  const l1 = params.l1Client
  const gas = (await l1.estimateContractGas({ ...call, account: l1.account })) + 100_000n
  const hash = await l1.writeContract({ ...call, gas })
  const receipt = await l1.waitForTransactionReceipt({ hash })
  if (receipt.status !== "success")
    throw new Error(`registerTee ${hash} reverted (gasUsed ${receipt.gasUsed}/${gas})`)
  const registration = await teeRegistry.getRegistrationMessage(signer.ethAddress)
  logger.info(`TEE registered at leaf ${registration.leafIndex}`)
  return registration
}

/**
 * Wait until a registration message is in the L1->L2 message tree. On the sandbox, the node's debug
 * RPC mines the blocks; elsewhere this polls. Pass `nodeUrl` when the wallet's node is not the
 * default sandbox node.
 */
export async function awaitTeeRegistrationMessage(args: {
  wallet: ObsidionWallet
  registration: TeeRegistration
  network: NetworkType
  timeoutSeconds?: number
  nodeUrl?: string
}): Promise<void> {
  const { wallet, registration } = args
  const timeoutSeconds = args.timeoutSeconds ?? 300
  if (args.network === Network.SANDBOX) {
    await waitForSandboxL1ToL2Message(wallet.node, registration.messageKey, {
      timeoutSeconds,
      nodeUrl: args.nodeUrl,
    })
    return
  }
  const deadline = Date.now() + timeoutSeconds * 1000
  while (Date.now() < deadline) {
    if (await isL1ToL2MessageReady(wallet.node, registration.messageKey)) return
    await new Promise((r) => setTimeout(r, 10_000))
  }
  throw new Error(
    `TEE registration message ${registration.messageKey} not in the L1->L2 tree after ${timeoutSeconds}s`,
  )
}
