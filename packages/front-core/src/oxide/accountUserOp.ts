/**
 * Signs a backup rotation's user operation with the session's root passkey, once the operation is
 * exactly the account change the wallet expects. The signature covers the owner, the nonce, the
 * calls and the gas, so each is compared with what the composition built from its own reads; the
 * operation hash is recomputed from the checked operation and never taken from a record.
 */
import { p256 } from "@noble/curves/p256"
import {
  backupKeyEntry,
  RootKeyNotInstalledError,
  verifyWebAuthnUserOpSignature,
  type BackupPasskeyAdd,
  type RotationIntent,
} from "@obsidion/sdk"
import {
  AccountMetadataRegistryAbi,
  CANONICAL_ENTRY_POINT_V08,
  encodeAddAuthKey,
  encodeR1UserOpSignature,
  getAccountNonce,
  getAuthKeys,
  getUserOpHash,
  NamePortalAbi,
  OxideAccountAbi,
  packU128LimbsToBytes32,
  userOpOfIntent,
  type R1PublicKeyArg,
  type UserOpIntent,
  type UserRecordArg,
  type WebAuthnAuthArg,
} from "@oxide/l1-contracts"
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  pad,
  parseAbiParameters,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import type { AccountPasskey } from "./accountSignature"

/**
 * The gas oxide's rotation builder declares for a one-key add: the only limits the wallet signs.
 * Copied from the builder's private table; the exception is recorded in docs/account/secret-key.md.
 */
export const ROTATION_VERIFICATION_GAS = 400_000n
const ROTATION_EXECUTE_GAS = 185_000n
const ROTATION_ADD_KEY_GAS = 215_000n
export const ROTATION_CALL_GAS = ROTATION_EXECUTE_GAS + ROTATION_ADD_KEY_GAS

const EXECUTE_BATCH_MODE = pad("0x01", { size: 32, dir: "right" })
const BATCH_CALLS = parseAbiParameters("(address target,uint256 value,bytes data)[]")
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

/** The operation is not the expected change; nothing was signed. */
export class UserOpMismatchError extends Error {
  constructor(readonly field: string) {
    super(`The account change is not the one expected: ${field}`)
    this.name = "UserOpMismatchError"
  }
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
const mismatch = (field: string) => new UserOpMismatchError(field)

/** Refuses an intent unless its operation is exactly the expected change. Reads nothing. */
export function checkUserOpIntent(intent: UserOpIntent, expected: ExpectedUserOp): void {
  const userOp = userOpOfIntent(intent)
  if (!same(userOp.sender, expected.owner)) throw mismatch("the sender")
  if (userOp.initCode !== "0x") throw mismatch("the init code")
  if (userOp.paymasterAndData !== "0x") throw mismatch("the paymaster")
  const gas = packU128LimbsToBytes32(ROTATION_VERIFICATION_GAS, ROTATION_CALL_GAS)
  if (BigInt(userOp.accountGasLimits) !== BigInt(gas)) throw mismatch("the gas limits")
  if (userOp.preVerificationGas !== 0n || BigInt(userOp.gasFees) !== 0n) {
    throw mismatch("the gas fees")
  }
  const calls = decodeBatch(userOp.callData)
  const newRecord = { ...expected.record, l2Address: expected.recipient }
  const wanted = [
    {
      name: "the key add",
      target: expected.owner,
      data: encodeAddAuthKey(expected.add.pubkey, backupKeyEntry(expected.add).metadata),
    },
    {
      name: "the record update",
      target: expected.metadataRegistry,
      data: encodeFunctionData({
        abi: AccountMetadataRegistryAbi,
        functionName: "setUserRecord",
        args: [expected.owner, newRecord],
      }),
    },
    {
      name: "the notification",
      target: expected.namePortal,
      data: encodeFunctionData({
        abi: NamePortalAbi,
        functionName: "notify",
        args: [expected.owner, expected.recipient, expected.rollupVersion],
      }),
    },
  ]
  if (calls.length !== wanted.length) throw mismatch(`${calls.length} calls`)
  wanted.forEach((want, i) => {
    const call = calls[i]!
    if (!same(call.target, want.target)) throw mismatch(`${want.name}'s target`)
    if (call.value !== 0n) throw mismatch(`${want.name}'s value`)
    if (!same(call.data, want.data)) throw mismatch(want.name)
  })
}

function decodeBatch(callData: Hex): readonly { target: Address; value: bigint; data: Hex }[] {
  let decoded: ReturnType<typeof decodeFunctionData<typeof OxideAccountAbi>>
  try {
    decoded = decodeFunctionData({ abi: OxideAccountAbi, data: callData })
  } catch {
    throw mismatch("the call data")
  }
  if (decoded.functionName !== "execute") throw mismatch("the entry function")
  const [mode, executionData] = decoded.args as readonly [Hex, Hex]
  if (!same(mode, EXECUTE_BATCH_MODE)) throw mismatch("the execution mode")
  try {
    return decodeAbiParameters(BATCH_CALLS, executionData)[0]
  } catch {
    throw mismatch("the batch")
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
 * before any prompt when the operation, its nonce or its hash is not the expected one, when the
 * account has no key, or when the session's key is not the first one installed.
 */
export async function signAccountUserOp(
  deps: AccountUserOpDeps,
  rotation: Pick<RotationIntent, "intent" | "userOpHash">,
  expected: ExpectedUserOp,
): Promise<Hex> {
  checkUserOpIntent(rotation.intent, expected)
  const nonce = await getAccountNonce(deps.client, CANONICAL_ENTRY_POINT_V08, expected.owner)
  if (nonce !== rotation.intent.nonce) throw mismatch("the nonce")
  const keys = await getAuthKeys(deps.client, expected.owner)
  if (keys.length === 0) throw new RootKeyNotInstalledError(expected.owner)
  const index = keys.findIndex(({ key }) => sameKey(key, deps.passkey.key))
  if (index !== 0) throw new RootPasskeyRequiredError()
  const userOpHash = await getUserOpHash(
    deps.client,
    CANONICAL_ENTRY_POINT_V08,
    userOpOfIntent(rotation.intent),
  )
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
