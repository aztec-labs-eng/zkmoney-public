/**
 * The message `authorize_intents` verifies: the intents-only hash bound to the account, chain id and
 * rollup version.
 *
 * Run:
 *   pnpm test test/feePaymentMethod/intentsOnlyAuthWitHash.test.ts
 */
import { describe, expect, it } from "vitest"
import { Fr } from "@aztec/foundation/curves/bn254"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { computeOuterAuthWitHash } from "@aztec/stdlib/auth-witness"
import {
  computeIntentsOnlyAuthWitHash,
  computeIntentsOnlySignatureHash,
} from "../../src/feePaymentMethod/sponsoredCall.js"

const ACCOUNT = AztecAddress.fromBigIntUnsafe(0x1234n)
const CHAIN = { chainId: new Fr(31337), version: new Fr(1) }

async function wrapped(account: AztecAddress, chain: { chainId: Fr; version: Fr }, intents: Fr[]) {
  return computeOuterAuthWitHash(
    account,
    chain.chainId,
    chain.version,
    await computeIntentsOnlySignatureHash(intents),
  )
}

describe("computeIntentsOnlyAuthWitHash", () => {
  it("wraps the intents-only hash with the account, chain and version", async () => {
    const intents = [Fr.random(), Fr.random()]
    const expected = await wrapped(ACCOUNT, CHAIN, intents)
    expect((await computeIntentsOnlyAuthWitHash(ACCOUNT, CHAIN, intents)).equals(expected)).toBe(
      true,
    )
    // Padding is the inner helper's: a list already padded to four hashes the same.
    const padded = [...intents, Fr.ZERO, Fr.ZERO]
    expect((await computeIntentsOnlyAuthWitHash(ACCOUNT, CHAIN, padded)).equals(expected)).toBe(
      true,
    )
  })

  it("wraps the empty batch", async () => {
    const expected = await wrapped(ACCOUNT, CHAIN, [])
    expect((await computeIntentsOnlyAuthWitHash(ACCOUNT, CHAIN, [])).equals(expected)).toBe(true)
  })

  it("differs across chains, versions and accounts", async () => {
    const intents = [Fr.random()]
    const base = await computeIntentsOnlyAuthWitHash(ACCOUNT, CHAIN, intents)
    const otherChain = await computeIntentsOnlyAuthWitHash(
      ACCOUNT,
      { ...CHAIN, chainId: new Fr(31338) },
      intents,
    )
    const otherVersion = await computeIntentsOnlyAuthWitHash(
      ACCOUNT,
      { ...CHAIN, version: new Fr(2) },
      intents,
    )
    const otherAccount = await computeIntentsOnlyAuthWitHash(
      AztecAddress.fromBigIntUnsafe(0x1235n),
      CHAIN,
      intents,
    )
    expect(otherChain.equals(base)).toBe(false)
    expect(otherVersion.equals(base)).toBe(false)
    expect(otherAccount.equals(base)).toBe(false)
  })
})
