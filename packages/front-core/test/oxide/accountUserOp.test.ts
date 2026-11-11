// @vitest-environment node
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { p256 } from "@noble/curves/p256"
import { sha256 as sha256Hex, hexToBytes, concatBytes } from "viem"
import {
  backupKeyPayload,
  rotationUserOpHash,
  verifyWebAuthnUserOpSignature,
  RootKeyNotInstalledError,
} from "@obsidion/sdk"
import {
  packU128LimbsToBytes32,
  type AddPasskeyIntent,
  type AuthKeyEntry,
  type R1PublicKeyArg,
  type WebAuthnAuthArg,
} from "@oxide/l1-contracts"
import {
  MAX_ADD_PASSKEY_CALL_GAS,
  buildAddPasskeySipa,
  type AddPasskeySipa,
} from "@oxide/oxide-client/add_passkey.js"
import { USER_OP_VERIFICATION_GAS } from "@oxide/oxide-client/record_update.js"
import { computeSIPAAddress } from "@oxide/oxide-lib/sipa_address.js"
import { slice, toHex, type Address, type Hex, type PublicClient } from "viem"
import { beforeAll, describe, expect, it, vi } from "vitest"
import {
  checkAddPasskeyIntent,
  RootPasskeyRequiredError,
  signAccountUserOp,
  type ExpectedUserOp,
} from "../../src/oxide/accountUserOp"

const MISMATCH = expect.objectContaining({ code: "backupPasskey.changeMismatch" })

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`
const OWNER = addr(0xa1)
const REGISTRY = addr(0xa2)
const PORTAL = addr(0xa3)
const FACTORY = addr(0xa4)
const TABLE = addr(0xa5)
const IMPL = addr(0xa6)
const NAME_REGISTRY = addr(0xa9)
const CHAIN_ID = 11_155_111
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

/** An EntryPoint, account, factory and SIPA implementation that answer from this state. */
function fakeClient(state: { nonce: bigint; keys: AuthKeyEntry[] }): PublicClient {
  const readContract = vi.fn(async (params: { functionName: string; args?: unknown[] }) => {
    switch (params.functionName) {
      case "getNonce":
        return state.nonce
      case "getAuthKeys":
        return state.keys
      case "NAME_REGISTRY":
        return NAME_REGISTRY
      case "NAME_PORTAL":
        return PORTAL
      case "accountMetadataRegistry":
        return REGISTRY
      case "predictSIPA": {
        const [implementation, intentHash, recoveryCommitment, rollupVersion, resweepable, table] =
          params.args as [Address, Hex, Hex, bigint, boolean, Address]
        return computeSIPAAddress({
          sipaFactory: EthAddress.fromString(FACTORY),
          implementation: EthAddress.fromString(implementation),
          intentHash: Buffer.from(hexToBytes(intentHash)),
          recoveryCommitment: Fr.fromHexString(recoveryCommitment),
          rollupVersion,
          resweepable,
          forwardingTable: EthAddress.fromString(table),
        }).toString()
      }
      default:
        throw new Error(`unexpected read ${params.functionName}`)
    }
  })
  const estimateGas = vi.fn(async () => 1_200_000n)
  return { chain: { id: CHAIN_ID }, readContract, estimateGas } as unknown as PublicClient
}

const gasLimits = (callGas: bigint) => packU128LimbsToBytes32(USER_OP_VERIFICATION_GAS, callGas)

const expected: ExpectedUserOp = {
  owner: OWNER,
  metadataRegistry: REGISTRY,
  namePortal: PORTAL,
  rollupVersion: 6n,
  add: ADD,
  record: RECORD,
  recipient: TWO_KEY,
}

let rotation: AddPasskeySipa

/** Oxide's addition of `ADD` with `encryptedWalletKey` behind its metadata prefix. */
const build = (encryptedWalletKey: Hex) =>
  buildAddPasskeySipa(fakeClient({ nonce: 7n, keys: [] }), {
    sipaFactory: FACTORY,
    implementation: IMPL,
    forwardingTable: TABLE,
    metadataRegistry: REGISTRY,
    namePortal: PORTAL,
    rollupVersion: 6n,
    owner: OWNER,
    record: RECORD,
    recipient: AztecAddress.fromStringUnsafe(TWO_KEY),
    add: { passkey: B.key, credentialId: ADD.credentialId, encryptedWalletKey },
  })

beforeAll(async () => {
  rotation = await build(backupKeyPayload(ADD))
})

describe("checkAddPasskeyIntent", () => {
  it("accepts the intent oxide's builder produces", () => {
    expect(() => checkAddPasskeyIntent(rotation.intent, expected)).not.toThrow()
  })

  it.each([
    ["the old fixed call gas", 400_000n],
    ["call gas at oxide's cap", MAX_ADD_PASSKEY_CALL_GAS],
  ])("accepts %s", (_, callGas) => {
    const intent = { ...rotation.intent, accountGasLimits: gasLimits(callGas) }
    expect(() => checkAddPasskeyIntent(intent, expected)).not.toThrow()
  })

  it("hashes the intent over the expected targets as oxide's builder did", () => {
    expect(rotationUserOpHash(fakeClient({ nonce: 7n, keys: [] }), rotation.intent, expected)).toBe(
      rotation.userOpHash,
    )
  })

  it.each<[string, (i: AddPasskeyIntent) => AddPasskeyIntent]>([
    ["another sender", (i) => ({ ...i, owner: addr(0xff) })],
    ["another rollup version", (i) => ({ ...i, rollupVersion: 5n })],
    [
      "call gas above oxide's cap",
      (i) => ({ ...i, accountGasLimits: gasLimits(MAX_ADD_PASSKEY_CALL_GAS + 1n) }),
    ],
    ["no call gas", (i) => ({ ...i, accountGasLimits: gasLimits(0n) })],
    [
      "other verification gas",
      (i) => ({
        ...i,
        accountGasLimits: packU128LimbsToBytes32(USER_OP_VERIFICATION_GAS + 1n, 400_000n),
      }),
    ],
    [
      "another record address",
      (i) => ({ ...i, record: { ...i.record, l2Address: RECORD.l2Address } }),
    ],
    ["another record version", (i) => ({ ...i, record: { ...i.record, rollupVersion: 5n } })],
    [
      "another record key x",
      (i) => ({ ...i, record: { ...i.record, publicKey: { x: 12n, y: 12n } } }),
    ],
    [
      "another record key y",
      (i) => ({ ...i, record: { ...i.record, publicKey: { x: 11n, y: 13n } } }),
    ],
    ["another operator", (i) => ({ ...i, record: { ...i.record, resolverOperator: addr(0xff) } })],
    ["another notification", (i) => ({ ...i, namePortalRecipient: `0x00${"7c".repeat(31)}` })],
    ["another key", (i) => ({ ...i, key: A.key })],
    ["other metadata", (i) => ({ ...i, metadata: i.metadata.replace(/3/g, "4") as Hex })],
  ])("refuses %s", (_, edit) => {
    expect(() => checkAddPasskeyIntent(edit(rotation.intent), expected)).toThrow(MISMATCH)
  })

  it("refuses an install that carries the envelope without the credential id behind it", async () => {
    const bare = await build(ADD.envelope)
    expect(() => checkAddPasskeyIntent(bare.intent, expected)).toThrow(MISMATCH)
  })

  it("refuses another recipient or record field", () => {
    expect(() =>
      checkAddPasskeyIntent(rotation.intent, { ...expected, recipient: `0x00${"7c".repeat(31)}` }),
    ).toThrow(MISMATCH)
    expect(() =>
      checkAddPasskeyIntent(rotation.intent, {
        ...expected,
        record: { ...RECORD, rollupVersion: 5n },
      }),
    ).toThrow(MISMATCH)
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
    await expect(signAccountUserOp(d, rotation, expected)).rejects.toThrow(MISMATCH)
    expect(sign).not.toHaveBeenCalled()
  })

  it("refuses before any prompt when the intent is not the expected change", async () => {
    const d = deps({ nonce: 7n, keys: installed(A) })
    const sign = vi.spyOn(d.passkey, "sign")
    await expect(
      signAccountUserOp(d, rotation, { ...expected, add: { ...ADD, pubkey: A.key } }),
    ).rejects.toThrow(MISMATCH)
    expect(sign).not.toHaveBeenCalled()
  })

  it.each<[string, Partial<ExpectedUserOp>]>([
    ["another registry", { metadataRegistry: addr(0xff) }],
    ["another name portal", { namePortal: addr(0xff) }],
  ])("refuses before any prompt when the hash is not over %s", async (_, other) => {
    const d = deps({ nonce: 7n, keys: installed(A) })
    const sign = vi.spyOn(d.passkey, "sign")
    await expect(signAccountUserOp(d, rotation, { ...expected, ...other })).rejects.toThrow(
      MISMATCH,
    )
    expect(sign).not.toHaveBeenCalled()
  })

  it("refuses a stored hash that is not the operation's", async () => {
    await expect(
      signAccountUserOp(
        deps({ nonce: 7n, keys: installed(A) }),
        { ...rotation, userOpHash: `0x${"00".repeat(32)}` },
        expected,
      ),
    ).rejects.toThrow(MISMATCH)
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
