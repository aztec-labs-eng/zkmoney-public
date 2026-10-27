import { expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { secp256k1 } from "@noble/curves/secp256k1"
import { privateKeyToAccount } from "viem/accounts"
import type { Address, Hex, PublicClient } from "viem"
import { SipaIntent } from "@oxide/l1-contracts"
import { SipaSelfResolver } from "../../src/services/sipaSelfResolve.js"
import {
  deriveRecoveryPrivateKey,
  deriveSelfSipaSecret,
  deriveSharedSecret,
} from "../../src/services/sipaStealth.js"

it("predicts a legacy SIPA with the recovery key the recipient can derive", async () => {
  const key = 123n
  const resolver = new SipaSelfResolver({ stealthScalar: key, selfSipaKey: new Fr(789n) })
  const implementation = `0x${"11".repeat(20)}` as Address
  const predicted = `0x${"22".repeat(20)}` as Address
  const readContract = vi.fn(async (request: { functionName: string }) =>
    request.functionName === "predictSIPA" ? predicted : implementation,
  )
  const result = await resolver.resolveAddress({
    protocol: "legacy-eoa",
    user: AztecAddress.fromBigIntUnsafe(10n),
    recoveryAccount: `0x${"33".repeat(20)}`,
    day: 123,
    nonce: 4,
    publicClient: { readContract } as unknown as PublicClient,
    sipaFactory: `0x${"44".repeat(20)}`,
    forwardingTable: `0x${"55".repeat(20)}`,
    rollupVersion: 7n,
  })
  expect(result.sipaAddress).toBe(predicted)
  const recoveryKey = deriveRecoveryPrivateKey(key, result.resolution.messageSecret)
  const account = privateKeyToAccount(`0x${recoveryKey.toString(16).padStart(64, "0")}` as Hex)
  expect("recoveryAddress" in result.sipaArgs && result.sipaArgs.recoveryAddress).toBe(
    account.address.toLowerCase(),
  )
  const call = readContract.mock.calls.find(
    ([request]) => request.functionName === "predictSIPA",
  )![0] as any
  expect(call.args[2]).toBe(account.address.toLowerCase())
  expect(call.abi[1].inputs[2].type).toBe("address")
  const implementationRead = readContract.mock.calls.find(
    ([request]) => request.functionName === "implementationFor",
  )![0] as any
  expect(implementationRead.args).toEqual([SipaIntent.Deposit])
})

it("commits an account SIPA to the deployment's forwarding table", async () => {
  const resolver = new SipaSelfResolver({ stealthScalar: 123n, selfSipaKey: new Fr(789n) })
  const forwardingTable = `0x${"55".repeat(20)}` as Address
  const predicted = `0x${"22".repeat(20)}` as Address
  const readContract = vi.fn(async (request: { functionName: string }) =>
    request.functionName === "predictSIPA" ? predicted : `0x${"11".repeat(20)}`,
  )
  const result = await resolver.resolveAddress({
    protocol: "account",
    user: AztecAddress.fromBigIntUnsafe(10n),
    recoveryAccount: `0x${"33".repeat(20)}`,
    day: 123,
    nonce: 4,
    publicClient: { readContract } as unknown as PublicClient,
    sipaFactory: `0x${"44".repeat(20)}`,
    forwardingTable,
    rollupVersion: 7n,
  })
  expect(result.sipaAddress).toBe(predicted)
  expect("forwardingTable" in result.sipaArgs && result.sipaArgs.forwardingTable).toBe(
    forwardingTable,
  )
  const call = readContract.mock.calls.find(
    ([request]) => request.functionName === "predictSIPA",
  )![0] as any
  expect(call.args[5]).toBe(forwardingTable)
})

it("salts from the self key, which the resolver's ECDH against the stealth key cannot reproduce", async () => {
  const stealthScalar = 123n
  const resolverScalar = 456n
  const selfSipaKey = new Fr(789n)
  const resolver = new SipaSelfResolver({ stealthScalar, selfSipaKey })
  const user = AztecAddress.fromBigIntUnsafe(10n)
  const recovery = EthAddress.fromString(`0x${"33".repeat(20)}`)
  const resolution = await resolver.resolve(user, 123, 4, recovery)
  expect(resolution.messageSecret.equals(deriveSelfSipaSecret(selfSipaKey, 123, 4))).toBe(true)
  // What the resolver would derive for the same coordinates from the registry's stealth key.
  const asResolver = deriveSharedSecret(resolver.userPublicKey, resolverScalar, 123, 4)
  expect(resolution.messageSecret.equals(asResolver)).toBe(false)
  const point = secp256k1.ProjectivePoint.BASE.multiply(resolverScalar).toAffine()
  expect(resolution.messageSecret.equals(deriveSharedSecret(point, stealthScalar, 123, 4))).toBe(
    false,
  )
})

it("replays the salt an address was derived with before the self key, in place of the key's", async () => {
  const resolver = new SipaSelfResolver({ stealthScalar: 123n, selfSipaKey: new Fr(789n) })
  const user = AztecAddress.fromBigIntUnsafe(10n)
  const recovery = EthAddress.fromString(`0x${"33".repeat(20)}`)
  // The ECDH salt the wallet derived against the resolver's registry key.
  const earlier = deriveSharedSecret(resolver.userPublicKey, 456n, 123, 4)
  const replayed = await resolver.resolve(user, 123, 4, recovery, earlier)
  expect(replayed.messageSecret.equals(earlier)).toBe(true)
  const own = await resolver.resolve(user, 123, 4, recovery)
  expect(replayed.recipientHash.equals(own.recipientHash)).toBe(false)
})
