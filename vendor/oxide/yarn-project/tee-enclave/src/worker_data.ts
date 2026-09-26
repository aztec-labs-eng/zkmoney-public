import { Buffer32 } from '@aztec/foundation/buffer';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { EthAddress } from '@aztec/stdlib/block';

import type { AttestationData } from '@oxide/oxide-lib/attestation/attestation_data.js';
import { computeAttestationUserData } from '@oxide/oxide-lib/attestation/user_data.js';
import type { AttestationProvider } from '@oxide/oxide-lib/attestation_provider.js';
import {
  type EnclaveEncryptionKeypair,
  P256PublicKey,
  generateEncryptionKeypair,
} from '@oxide/oxide-lib/encryption.js';
import type { PortalContext } from '@oxide/oxide-lib/types.js';

import { secpPublicKeyFromPrivateKey } from './libsecp256k1_signer.js';
import { SignatureBudget, type SignatureBudgetWorkerData } from './signature_budget.js';

/**
 * The enclave's long-lived secrets plus the boot attestation binding them. Generated once at boot
 * on the main thread and shared with every request worker, so all workers sign as the same
 * enclave identity.
 */
export interface EnclaveKeyMaterial {
  signingKey: Buffer32;
  encryptionKeypair: EnclaveEncryptionKeypair;
  attestation: AttestationData;
}

/** Generate fresh enclave keys and fetch the attestation committing to them. */
export async function createEnclaveKeyMaterial(attestationProvider: AttestationProvider): Promise<EnclaveKeyMaterial> {
  const signingKey = Buffer32.random();
  const publicKey = secpPublicKeyFromPrivateKey(signingKey);
  const encryptionKeypair = await generateEncryptionKeypair();
  const userData = {
    publicKeyX: publicKey.x,
    publicKeyY: publicKey.y,
    encPubKeyX: encryptionKeypair.publicKey.x,
    encPubKeyY: encryptionKeypair.publicKey.y,
  };
  const attestation = await attestationProvider.attest(computeAttestationUserData(userData));
  return { signingKey, encryptionKeypair, attestation: { attestation, userData } };
}

/**
 * Structured-clone-safe form of the enclave key material + portal context passed to each worker
 * via `workerData`. Class instances don't survive the clone, so everything is raw bytes/strings
 * except the P-256 private key, whose `CryptoKey` handle is cloneable as-is.
 */
export interface EnclaveWorkerData {
  signingKey: Uint8Array;
  encPrivateKey: CryptoKey;
  encPubKeyX: Uint8Array;
  encPubKeyY: Uint8Array;
  signerPubKeyX: Uint8Array;
  signerPubKeyY: Uint8Array;
  attestationDoc: Uint8Array;
  portal: { l1Portal: string; l1ChainId: string; l2Portal: string; rollupVersion: string };
  signatureBudget: SignatureBudgetWorkerData;
}

export function toWorkerData(
  material: EnclaveKeyMaterial,
  portalContext: PortalContext,
  budget: SignatureBudget,
): EnclaveWorkerData {
  const { userData } = material.attestation;
  return {
    signatureBudget: budget.toWorkerData(),
    signingKey: material.signingKey.toBuffer(),
    encPrivateKey: material.encryptionKeypair.privateKey,
    encPubKeyX: userData.encPubKeyX.toBuffer(),
    encPubKeyY: userData.encPubKeyY.toBuffer(),
    signerPubKeyX: userData.publicKeyX.toBuffer(),
    signerPubKeyY: userData.publicKeyY.toBuffer(),
    attestationDoc: material.attestation.attestation,
    portal: {
      l1Portal: portalContext.l1Portal.toString(),
      l1ChainId: portalContext.l1ChainId.toString(),
      l2Portal: portalContext.l2Portal.toString(),
      rollupVersion: portalContext.rollupVersion.toString(),
    },
  };
}

export function fromWorkerData(
  data: EnclaveWorkerData,
  onSignatureBudgetExhausted?: () => void,
): {
  material: EnclaveKeyMaterial;
  portalContext: PortalContext;
  budget: SignatureBudget;
} {
  const userData = {
    publicKeyX: Buffer32.fromBuffer(Buffer.from(data.signerPubKeyX)),
    publicKeyY: Buffer32.fromBuffer(Buffer.from(data.signerPubKeyY)),
    encPubKeyX: Buffer32.fromBuffer(Buffer.from(data.encPubKeyX)),
    encPubKeyY: Buffer32.fromBuffer(Buffer.from(data.encPubKeyY)),
  };
  return {
    material: {
      signingKey: Buffer32.fromBuffer(Buffer.from(data.signingKey)),
      encryptionKeypair: {
        publicKey: P256PublicKey.fromCoordinates({ x: userData.encPubKeyX, y: userData.encPubKeyY }),
        privateKey: data.encPrivateKey,
      },
      attestation: { attestation: Buffer.from(data.attestationDoc), userData },
    },
    portalContext: {
      l1Portal: EthAddress.fromString(data.portal.l1Portal),
      l1ChainId: BigInt(data.portal.l1ChainId),
      l2Portal: AztecAddress.fromStringUnsafe(data.portal.l2Portal),
      rollupVersion: BigInt(data.portal.rollupVersion),
    },
    budget: SignatureBudget.fromWorkerData(data.signatureBudget, onSignatureBudgetExhausted),
  };
}
