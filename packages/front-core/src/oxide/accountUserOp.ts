/**
 * Signs a backup rotation's user operation with the session's root passkey, once the intent is
 * exactly the account change the wallet expects. The SIPA builds the operation from the intent and
 * its own registry and portal, so each intent field is compared with what the composition built
 * from its own reads, and the operation hash is recomputed over the composition's targets and never
 * taken from a record.
 */
import { p256 } from "@noble/curves/p256"
import {
  backupKeyEntry,
  isAddPasskeyGasLimits,
  RootKeyNotInstalledError,
  rotationUserOpHash,
  sameUserRecord,
  verifyWebAuthnUserOpSignature,
  type BackupPasskeyAdd,
  type RotationIntent,
} from "@obsidion/sdk"
import {
  CANONICAL_ENTRY_POINT_V08,
  encodeR1UserOpSignature,
  getAccountNonce,
  getAuthKeys,
  type AddPasskeyIntent,
  type R1PublicKeyArg,
  type UserRecordArg,
  type WebAuthnAuthArg,
} from "@oxide/l1-contracts"
import { toHex, type Address, type Hex, type PublicClient } from "viem"
import { WalletError } from "../engine/errors"
import type { AccountPasskey } from "./accountSignature"

const P256_HALF_N = p256.CURVE.n / 2n

/** The change the composition expects, from the master key, the ceremony and a fresh L1 read. */
export interface ExpectedUserOp {
  owner: Address
  metadataRegistry: Address
  namePortal: Address
  rollupVersion: bigint
  add: BackupPasskeyAdd
  /** The record read at prepare; the operation rewrites only its address. */
  record: UserRecordArg
  /** The two-key account the record will name. */
  recipient: Hex
}

/** The session's passkey is installed on the account but is not its first one. */
export class RootPasskeyRequiredError extends Error {
  constructor() {
    super("Use your first passkey to approve this change")
    this.name = "RootPasskeyRequiredError"
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const sameKey = (a: R1PublicKeyArg, b: R1PublicKeyArg) =>
  BigInt(a.qx) === BigInt(b.qx) && BigInt(a.qy) === BigInt(b.qy)
const mismatch = (field: string) => new WalletError("backupPasskey.changeMismatch", field)

/** Refuses an intent unless it is exactly the expected change. Reads nothing. */
export function checkAddPasskeyIntent(intent: AddPasskeyIntent, expected: ExpectedUserOp): void {
  if (!same(intent.owner, expected.owner)) throw mismatch("the owner")
  if (intent.rollupVersion !== expected.rollupVersion) throw mismatch("the rollup version")
  if (!isAddPasskeyGasLimits(intent.accountGasLimits)) throw mismatch("the gas limits")
  const newRecord: UserRecordArg = { ...expected.record, l2Address: expected.recipient }
  if (!sameUserRecord(intent.record, newRecord)) throw mismatch("the record update")
  if (BigInt(intent.namePortalRecipient) !== BigInt(expected.recipient)) {
    throw mismatch("the notification")
  }
  if (!sameKey(intent.key, expected.add.pubkey)) throw mismatch("the key add")
  if (!same(intent.metadata, backupKeyEntry(expected.add).metadata)) {
    throw mismatch("the key's metadata")
  }
}

/** The assertion with its `s` folded below half the curve order, as the account requires. */
function lowS(auth: WebAuthnAuthArg): WebAuthnAuthArg {
  const s = BigInt(auth.s)
  return s > P256_HALF_N ? { ...auth, s: toHex(p256.CURVE.n - s, { size: 32 }) } : auth
}

export interface AccountUserOpDeps {
  client: PublicClient
  /** The session's passkey; only the account's first key may sign. */
  passkey: AccountPasskey
}

/**
 * The root key's signature over the rotation's operation, as `OxideAccount` decodes it. Refuses
 * before any prompt when the intent, its nonce or its hash over the expected targets is not the
 * expected one, when the account has no key, or when the session's key is not the first one
 * installed.
 */
export async function signAccountUserOp(
  deps: AccountUserOpDeps,
  rotation: Pick<RotationIntent, "intent" | "userOpHash">,
  expected: ExpectedUserOp,
): Promise<Hex> {
  checkAddPasskeyIntent(rotation.intent, expected)
  const nonce = await getAccountNonce(deps.client, CANONICAL_ENTRY_POINT_V08, expected.owner)
  if (nonce !== rotation.intent.nonce) throw mismatch("the nonce")
  const keys = await getAuthKeys(deps.client, expected.owner)
  if (keys.length === 0) throw new RootKeyNotInstalledError(expected.owner)
  const index = keys.findIndex(({ key }) => sameKey(key, deps.passkey.key))
  if (index !== 0) throw new RootPasskeyRequiredError()
  const userOpHash = rotationUserOpHash(deps.client, rotation.intent, expected)
  if (!same(userOpHash, rotation.userOpHash)) throw mismatch("the operation hash")
  const signature = encodeR1UserOpSignature(
    BigInt(index),
    lowS(await deps.passkey.sign(userOpHash)),
  )
  if (!verifyWebAuthnUserOpSignature(signature, keys[index]!.key, userOpHash).valid) {
    throw new Error("The passkey's assertion did not verify")
  }
  return signature
}
