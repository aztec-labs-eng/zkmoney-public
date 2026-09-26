import { type Address, type Hex, decodeAbiParameters, encodeAbiParameters } from 'viem';

import type { UserRecordArg } from './account_metadata_registry.js';
import type { DomainAuthArg } from './name_registry.js';

/**
 * The intent codec a SIPA sweep reveals. Each SIPA commits to `intentHash = keccak256(intentData)`; the data plus any
 * `proofs` are fed to `SIPA.sweep(token, relayer, intentData, proofs)` inside the L1 operation a broadcaster
 * publishes (`buildSipaSweepOperation`), so a relayer never inspects them. Only the per-intent encoders below
 * understand a specific record.
 */

/** The deposit intent's `intentData`: `abi.encode(bytes32 recipientCommitment)`. Proofs are empty. */
export function encodeDepositIntentData(recipientCommitment: Hex): Hex {
  return encodeAbiParameters([{ type: 'bytes32' }], [recipientCommitment]);
}

/** The `recordData` codec: `abi.encode(address owner, bytes32 nameHash, AccountMetadataRegistry.UserRecord record)` — the
 *  slice the controller decodes to claim the name and write the record, and the record half of the owner's consent
 *  digest, `keccak256(recordData, chainId, accountMetadataRegistry, sipa)`. `sipa` is the registration SIPA the
 *  payer funds: the digest authorizes one settling address, because a permissionless factory puts an unbounded
 *  family of clones behind a single intent hash. */
const REGISTRATION_RECORD_ABI = [
  { name: 'owner', type: 'address' },
  { name: 'nameHash', type: 'bytes32' },
  {
    name: 'record',
    type: 'tuple',
    components: [
      { name: 'l2Address', type: 'bytes32' },
      { name: 'rollupVersion', type: 'uint256' },
      {
        name: 'publicKey',
        type: 'tuple',
        components: [
          { name: 'x', type: 'uint256' },
          { name: 'y', type: 'uint256' },
        ],
      },
      { name: 'resolverOperator', type: 'address' },
    ],
  },
] as const;

export function encodeRegistrationRecord(owner: Address, nameHash: Hex, record: UserRecordArg): Hex {
  return encodeAbiParameters(REGISTRATION_RECORD_ABI, [owner, nameHash, record]);
}

export function decodeRegistrationRecord(recordData: Hex): { owner: Address; nameHash: Hex; record: UserRecordArg } {
  const [owner, nameHash, record] = decodeAbiParameters(REGISTRATION_RECORD_ABI, recordData);
  return { owner, nameHash, record: record as UserRecordArg };
}

/** The full registration intent a registration SIPA commits to: the registration record plus the payment the SIPA
 *  base performs. `fee` and `beneficiary` are the exact fee and funder the payer was quoted; `recipientCommitment` is
 *  the L2 recipient the deposit remainder bridges to; `namePortalRecipient` is the L2 address the name portal
 *  notifies of the claimed name — zero for none. All of it is committed in the SIPA address, the base pays exactly
 *  those values, and the controller only checks them against its schedule, so a swapped controller can refuse the
 *  sweep but cannot re-price or redirect it. */
export interface RegistrationIntent {
  owner: Address;
  nameHash: Hex;
  record: UserRecordArg;
  /** The fee the sweep pays, in the pool's deposit token. Must equal the controller's schedule (or the signed terms' fee). */
  fee: bigint;
  /** The allowlisted funder the fee goes to. Irrelevant when `fee` is zero. */
  beneficiary: Address;
  recipientCommitment: Hex;
  namePortalRecipient: Hex;
}

const REGISTRATION_INTENT_ABI = [
  { type: 'bytes' },
  { type: 'uint256' },
  { type: 'address' },
  { type: 'bytes32' },
  { type: 'bytes32' },
] as const;

/** The registration intent's `intentData`: `abi.encode(bytes recordData, uint256 fee, address beneficiary, bytes32
 *  recipientCommitment, bytes32 namePortalRecipient)`. */
export function encodeRegistrationIntentData(intent: RegistrationIntent): Hex {
  return encodeAbiParameters(REGISTRATION_INTENT_ABI, [
    encodeRegistrationRecord(intent.owner, intent.nameHash, intent.record),
    intent.fee,
    intent.beneficiary,
    intent.recipientCommitment,
    intent.namePortalRecipient,
  ]);
}

export function decodeRegistrationIntentData(intentData: Hex): RegistrationIntent {
  const [recordData, fee, beneficiary, recipientCommitment, namePortalRecipient] = decodeAbiParameters(
    REGISTRATION_INTENT_ABI,
    intentData,
  );
  return { ...decodeRegistrationRecord(recordData), fee, beneficiary, recipientCommitment, namePortalRecipient };
}

/** Mirrors `IRegistrationController.SignedTerms`: operator-signed values that DEFINE the registration
 *  fee and minimum deposit for one name. */
export interface SignedTermsArg {
  fee: bigint;
  minDeposit: bigint;
  nonce: bigint;
  deadline: bigint;
  signature: Hex;
}

/** Mirrors `IRegistrationController.R1Install`: the P-256 key the sweep installs on the owner's account, and the
 *  bootstrap-key signature over the install UserOp (see `buildR1InstallUserOp`). */
export interface R1InstallArg {
  qx: Hex;
  qy: Hex;
  metadata: Hex;
  signature: Hex;
}

/** The registration intent's `proofs`: the authorizations the controller and registries verify but the intent hash does not commit. */
export interface RegistrationProofs {
  /** The owner account's ERC-1271 signature over the consent digest, wrapped as an ERC-7739 PersonalSign
   *  (see `accountPersonalSignHash`). The bootstrap key signs while the account holds no r1 key; an r1 key signs after. */
  consentSig: Hex;
  /** The bootstrap key of the account contract. */
  bootstrap: Address;
  /** The NameClaim the domain owner signed. */
  domainAuth: DomainAuthArg;
  /** Operator-signed terms; an empty `signature` reads as "no terms" and the immutable schedule applies. */
  signedTerms: SignedTermsArg;
  /** The r1 key install the sweep bundles through the EntryPoint; skipped when the account already holds a key. */
  r1Install: R1InstallArg;
}

/** The empty `SignedTerms` the terms contract reads as "no signed terms". */
export const EMPTY_SIGNED_TERMS: SignedTermsArg = {
  fee: 0n,
  minDeposit: 0n,
  nonce: 0n,
  deadline: 0n,
  signature: '0x',
};

const SWEEP_SIG_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'signature', type: 'bytes' },
  ],
} as const;

const SIGNED_TERMS_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'fee', type: 'uint256' },
    { name: 'minDeposit', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'signature', type: 'bytes' },
  ],
} as const;

const R1_INSTALL_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'qx', type: 'bytes32' },
    { name: 'qy', type: 'bytes32' },
    { name: 'metadata', type: 'bytes' },
    { name: 'signature', type: 'bytes' },
  ],
} as const;

const REGISTRATION_PROOFS_ABI = [
  { type: 'bytes' },
  { type: 'address' },
  SWEEP_SIG_TUPLE,
  SIGNED_TERMS_TUPLE,
  R1_INSTALL_TUPLE,
] as const;

export function encodeRegistrationProofs(proofs: RegistrationProofs): Hex {
  return encodeAbiParameters(REGISTRATION_PROOFS_ABI, [
    proofs.consentSig,
    proofs.bootstrap,
    proofs.domainAuth,
    proofs.signedTerms ?? EMPTY_SIGNED_TERMS,
    proofs.r1Install,
  ]);
}

export function encodeLegacyRegistrationProofs(proofs: Omit<RegistrationProofs, 'bootstrap'>): Hex {
  return encodeAbiParameters(
    [{ type: 'bytes' }, SWEEP_SIG_TUPLE, SIGNED_TERMS_TUPLE, R1_INSTALL_TUPLE],
    [proofs.consentSig, proofs.domainAuth, proofs.signedTerms ?? EMPTY_SIGNED_TERMS, proofs.r1Install],
  );
}

export function decodeRegistrationProofs(proofs: Hex): RegistrationProofs {
  const [consentSig, bootstrap, domainAuth, signedTerms, r1Install] = decodeAbiParameters(
    REGISTRATION_PROOFS_ABI,
    proofs,
  );
  return { consentSig, bootstrap, domainAuth, signedTerms, r1Install } as RegistrationProofs;
}
