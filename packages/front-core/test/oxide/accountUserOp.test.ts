// @vitest-environment node
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { p256 } from "@noble/curves/p256"
import { sha256 as sha256Hex, hexToBytes, concatBytes } from "viem"
import {
  backupKeyPayload,
  verifyWebAuthnUserOpSignature,
  RootKeyNotInstalledError,
} from "@obsidion/sdk"
import {
  AccountMetadataRegistryAbi,
  encodeAddAuthKey,
  encodeExecuteBatch,
  OxideAccountAbi,
  packU128LimbsToBytes32,
  userOpOfIntent,
  type AuthKeyEntry,
  type R1PublicKeyArg,
  type UserOpIntent,
  type WebAuthnAuthArg,
} from "@oxide/l1-contracts"
import { buildRotationIntent, type RotationIntent } from "@oxide/oxide-client/passkey_rotation.js"
import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  pad,
  parseAbiParameters,
  slice,
  toHex,
  type Hex,
  type PublicClient,
} from "viem"
import { beforeAll, describe, expect, it, vi } from "vitest"
import {
  checkUserOpIntent,
  RootPasskeyRequiredError,
  ROTATION_CALL_GAS,
  ROTATION_VERIFICATION_GAS,
  signAccountUserOp,
  UserOpMismatchError,
  type ExpectedUserOp,
} from "../../src/oxide/accountUserOp"

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`
const OWNER = addr(0xa1)
const REGISTRY = addr(0xa2)
const PORTAL = addr(0xa3)
const FACTORY = addr(0xa4)
const TABLE = addr(0xa5)
const IMPL = addr(0xa6)
const SIPA = addr(0xa7)
const TWO_KEY = `0x${"00".repeat(1)}${"7b".repeat(31)}` as Hex
const RECORD = {
  l2Address: `0x${"1a".repeat(32)}` as Hex,
  rollupVersion: 6n,
  publicKey: { x: 11n, y: 12n },
  resolverOperator: addr(0xa8),
}

/** A P-256 passkey that answers like an authenticator. */
class SoftwareKey {
  readonly priv = p256.utils.randomPrivateKey()
  readonly key: R1PublicKeyArg
  constructor() {
    const pub = p256.getPublicKey(this.priv, false)
    this.key = { qx: toHex(pub.subarray(1, 33)), qy: toHex(pub.subarray(33, 65)) }
  }
  sign = async (challenge: Hex, highS = false): Promise<WebAuthnAuthArg> => {
    const b64 = Buffer.from(challenge.slice(2), "hex")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    const clientDataJSON = `{"type":"webauthn.get","challenge":"${b64}","origin":"https://wallet.test"}`
    const authData = new Uint8Array(37)
    authData[32] = 0x05
    const sha256 = (bytes: Uint8Array) => hexToBytes(sha256Hex(bytes))
    const message = sha256(
      concatBytes([authData, sha256(new TextEncoder().encode(clientDataJSON))]),
    )
    const sig = p256.sign(message, this.priv, { lowS: true })
    const s = highS ? p256.CURVE.n - sig.s : sig.s
    return {
      r: toHex(sig.r, { size: 32 }),
      s: toHex(s, { size: 32 }),
      challengeIndex: BigInt(clientDataJSON.indexOf('"challenge"')),
      typeIndex: BigInt(clientDataJSON.indexOf('"type"')),
      authenticatorData: toHex(authData),
      clientDataJSON,
    }
  }
}

const A = new SoftwareKey()
const B = new SoftwareKey()
const ADD = {
  pubkey: B.key,
  credentialId: `0x${"0102".repeat(8)}` as Hex,
  envelope: `0x${"33".repeat(62)}` as Hex,
}

const USER_OP = parseAbiParameters(
  "address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData",
)

/** An EntryPoint, account, registry and factory that answer from this state. */
function fakeClient(state: { nonce: bigint; keys: AuthKeyEntry[] }): PublicClient {
  const readContract = vi.fn(async (params: { functionName: string; args?: unknown[] }) => {
    switch (params.functionName) {
      case "getNonce":
        return state.nonce
      case "getAuthKeys":
        return state.keys
      case "predictSIPA":
        return SIPA
      case "getUserOpHash": {
        const op = params.args![0] as ReturnType<typeof userOpOfIntent>
        return keccak256(
          encodeAbiParameters(USER_OP, [
            op.sender,
            op.nonce,
            op.initCode,
            op.callData,
            op.accountGasLimits,
            op.preVerificationGas,
            op.gasFees,
            op.paymasterAndData,
          ]),
        )
      }
      default:
        throw new Error(`unexpected read ${params.functionName}`)
    }
  })
  const call = vi.fn(async () => ({
    data: encodeFunctionResult({
      abi: AccountMetadataRegistryAbi,
      functionName: "getUserRecord",
      result: RECORD,
    }),
  }))
  return { readContract, call } as unknown as PublicClient
}

const expected: ExpectedUserOp = {
  owner: OWNER,
  metadataRegistry: REGISTRY,
  namePortal: PORTAL,
  rollupVersion: 6n,
  add: ADD,
  record: RECORD,
  recipient: TWO_KEY,
}

let rotation: RotationIntent

/** Oxide's rotation installing `ADD` with `encryptedWalletKey` behind its prefix. */
const build = (encryptedWalletKey: Hex) =>
  buildRotationIntent(fakeClient({ nonce: 7n, keys: [] }), {
    sipaFactory: FACTORY,
    implementation: IMPL,
    forwardingTable: TABLE,
    metadataRegistry: REGISTRY,
    namePortal: PORTAL,
    rollupVersion: 6n,
    owner: OWNER,
    record: RECORD,
    recipient: AztecAddress.fromStringUnsafe(TWO_KEY),
    add: [{ passkey: B.key, credentialId: ADD.credentialId, encryptedWalletKey }],
    remove: [],
  })

beforeAll(async () => {
  rotation = await build(backupKeyPayload(ADD))
})

const BATCH = parseAbiParameters("(address target,uint256 value,bytes data)[]")
const calls = (intent: UserOpIntent) => {
  const data = slice(intent.callData, 4)
  const [, executionData] = decodeAbiParameters(parseAbiParameters("bytes32, bytes"), data)
  return [...decodeAbiParameters(BATCH, executionData)[0]]
}
const withCalls = (
  intent: UserOpIntent,
  edit: (c: ReturnType<typeof calls>) => void,
): UserOpIntent => {
  const c = calls(intent)
  edit(c)
  return { ...intent, callData: encodeExecuteBatch(c) }
}

describe("checkUserOpIntent", () => {
  it("accepts the operation oxide's builder produces, gas included", () => {
    expect(() => checkUserOpIntent(rotation.intent, expected)).not.toThrow()
    expect(rotation.intent.accountGasLimits).toBe(
      packU128LimbsToBytes32(ROTATION_VERIFICATION_GAS, ROTATION_CALL_GAS),
    )
  })

  it.each<[string, (i: UserOpIntent) => UserOpIntent]>([
    ["a fourth call", (i) => withCalls(i, (c) => c.push({ ...c[0]! }))],
    [
      "another key",
      (i) => withCalls(i, (c) => (c[0] = { ...c[0]!, data: c[0]!.data.replace(/a/g, "b") as Hex })),
    ],
    ["another order", (i) => withCalls(i, (c) => c.reverse())],
    ["a nonzero value", (i) => withCalls(i, (c) => (c[1] = { ...c[1]!, value: 1n }))],
    ["another target", (i) => withCalls(i, (c) => (c[2] = { ...c[2]!, target: addr(0xff) }))],
    ["another sender", (i) => ({ ...i, owner: addr(0xff) })],
    ["other gas", (i) => ({ ...i, accountGasLimits: packU128LimbsToBytes32(400_000n, 400_001n) })],
    ["call data that is not a batch", (i) => ({ ...i, callData: "0x12345678" })],
    ["another entry function", (i) => ({ ...i, callData: encodeAddAuthKey(B.key, "0x") })],
    [
      "another execution mode",
      (i) => ({
        ...i,
        callData: encodeFunctionData({
          abi: OxideAccountAbi,
          functionName: "execute",
          args: [pad("0x00", { size: 32 }), encodeAbiParameters(BATCH, [calls(i)])],
        }),
      }),
    ],
  ])("refuses %s", (_, edit) => {
    expect(() => checkUserOpIntent(edit(rotation.intent), expected)).toThrow(UserOpMismatchError)
  })

  it("refuses an install that carries the envelope without the credential id behind it", async () => {
    const bare = await build(ADD.envelope)
    expect(() => checkUserOpIntent(bare.intent, expected)).toThrow(UserOpMismatchError)
  })

  it("refuses another recipient or record field", () => {
    expect(() =>
      checkUserOpIntent(rotation.intent, { ...expected, recipient: `0x00${"7c".repeat(31)}` }),
    ).toThrow("the record update")
    expect(() =>
      checkUserOpIntent(rotation.intent, { ...expected, record: { ...RECORD, rollupVersion: 5n } }),
    ).toThrow("the record update")
  })
})

describe("signAccountUserOp", () => {
  const deps = (state: { nonce: bigint; keys: AuthKeyEntry[] }, passkey = A, highS = false) => ({
    client: fakeClient(state),
    passkey: { key: passkey.key, sign: (c: Hex) => passkey.sign(c, highS) },
  })
  const installed = (...keys: SoftwareKey[]): AuthKeyEntry[] =>
    keys.map((k) => ({ key: k.key, metadata: "0x" }))

  it("signs the recomputed hash with the root key at index 0, low-s", async () => {
    for (const highS of [false, true]) {
      const signature = await signAccountUserOp(
        deps({ nonce: 7n, keys: installed(A, B) }, A, highS),
        rotation,
        expected,
      )
      expect(BigInt(slice(signature, 0, 32))).toBe(0n)
      const check = verifyWebAuthnUserOpSignature(signature, A.key, rotation.userOpHash)
      expect(check).toEqual({ keyIndex: 0n, valid: true })
    }
  })

  it("refuses before any prompt when the nonce moved", async () => {
    const d = deps({ nonce: 8n, keys: installed(A) })
    const sign = vi.spyOn(d.passkey, "sign")
    await expect(signAccountUserOp(d, rotation, expected)).rejects.toThrow("the nonce")
    expect(sign).not.toHaveBeenCalled()
  })

  it("refuses before any prompt when the operation is not the expected change", async () => {
    const d = deps({ nonce: 7n, keys: installed(A) })
    const sign = vi.spyOn(d.passkey, "sign")
    await expect(
      signAccountUserOp(d, rotation, { ...expected, namePortal: addr(0xff) }),
    ).rejects.toThrow(UserOpMismatchError)
    expect(sign).not.toHaveBeenCalled()
  })

  it("refuses a stored hash that is not the operation's", async () => {
    await expect(
      signAccountUserOp(
        deps({ nonce: 7n, keys: installed(A) }),
        { ...rotation, userOpHash: `0x${"00".repeat(32)}` },
        expected,
      ),
    ).rejects.toThrow("the operation hash")
  })

  it("refuses an account with no key installed", async () => {
    await expect(
      signAccountUserOp(deps({ nonce: 7n, keys: [] }), rotation, expected),
    ).rejects.toThrow(RootKeyNotInstalledError)
  })

  it("tells a session on the backup passkey to use its first one", async () => {
    await expect(
      signAccountUserOp(deps({ nonce: 7n, keys: installed(A, B) }, B), rotation, expected),
    ).rejects.toThrow(RootPasskeyRequiredError)
    await expect(
      signAccountUserOp(deps({ nonce: 7n, keys: installed(B) }, A), rotation, expected),
    ).rejects.toThrow(RootPasskeyRequiredError)
  })

  it("never returns an assertion the account would reject", async () => {
    const d = deps({ nonce: 7n, keys: installed(A) })
    d.passkey.sign = async (c) => ({ ...(await A.sign(c)), clientDataJSON: "{}" })
    await expect(signAccountUserOp(d, rotation, expected)).rejects.toThrow("did not verify")
  })
})
