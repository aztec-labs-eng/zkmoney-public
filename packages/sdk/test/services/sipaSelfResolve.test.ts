import { expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { secp256k1 } from "@noble/curves/secp256k1"
import { privateKeyToAccount } from "viem/accounts"
import type { Address, Hex, PublicClient } from "viem"
import { SipaSelfResolver } from "../../src/services/sipaSelfResolve.js"
import { deriveRecoveryPrivateKey } from "../../src/services/sipaStealth.js"

it("predicts a legacy SIPA with the recovery key the recipient can derive", async () => {
  const key = 123n
  const point = secp256k1.ProjectivePoint.BASE.multiply(456n).toAffine()
  const resolver = new SipaSelfResolver(key, point)
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
    portal: `0x${"55".repeat(20)}`,
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
  expect(implementationRead.args[0]).toBe(`0x${"55".repeat(20)}`)
})
